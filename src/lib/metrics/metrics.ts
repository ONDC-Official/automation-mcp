import { createRequire } from "node:module";
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

/**
 * Prometheus instruments for this process.
 *
 * ## This registry is ours, and prom-client's global one is never touched
 *
 * `prom-client` ships a process-wide default `register` and every constructor
 * signs up to it unless told otherwise. Using it here would break two things at
 * once:
 *
 * - **§5's rule against module-level mutable state.** A global registry is
 *   exactly that, wearing a library's name.
 * - **`createHarness`.** Vitest builds many containers in one process, and the
 *   second registration of a metric name against a shared registry throws
 *   `A metric with the name … has already been registered`. The suite would
 *   fail on the *second* test to build a container, with an error naming a
 *   metric rather than the container.
 *
 * So `createMetrics()` news its own `Registry` and passes it explicitly to
 * every instrument and to `collectDefaultMetrics`. **When you add a metric, add
 * it here, inside this function, with `registers: [registry]`** — a `new
 * Counter(...)` written anywhere else silently lands on the global.
 *
 * ## Passing this into a service is not a layering violation
 *
 * `metrics` is a `lib`, in the same category as `logger`: a cross-cutting
 * capability with no business rule in it, injected through the container and
 * held by whoever emits. A service taking a `Metrics` is doing what a service
 * taking a `Logger` does. What would be a violation is a *tool* holding one, or
 * a metric whose value encodes a decision the service should have made.
 *
 * ## Two instruments that deliberately do not exist
 *
 * - **No `ondc_sessions_active` gauge.** Answering it means enumerating live
 *   sessions, which `CacheStore` cannot do — and a per-process counter lies in
 *   the two cases that matter: after a restart (it resets while the sessions
 *   survive in Redis) and across replicas (each would report its own share as
 *   the total).
 * - **No worker-pool gauge.** The pool is `MockRunner.initSharedRunner()`,
 *   which hands back a handle with a `terminate()` and nothing else — its size
 *   is not observable from here. `ondc_mock_engine_runners` reports the number
 *   of *cached runner instances* (`MockEngine.size()`) instead, which is a
 *   number we actually own. Reporting a guessed pool size would be worse than
 *   reporting none.
 */

/**
 * Sources a gauge reads at scrape time.
 *
 * Gauges whose value lives on something built *after* the metrics registry —
 * the mock engine, the mirror sink — cannot close over it at construction.
 * Rather than let those components hold a `Metrics` and push, the container
 * hands their readers over with `observe()` once they exist, and `collect()`
 * pulls. A source that is never registered simply leaves its gauge unset,
 * which is the honest exposition for "nothing is reporting this".
 */
export interface MetricSources {
  /** Cached mock-runner instances. `MockEngine.size()`. */
  runners?: () => number;
  /** Records queued in the mirror sink, waiting for a batch. */
  mirrorQueueDepth?: () => number;
}

export interface Metrics {
  readonly registry: Registry;

  /* -- sessions and runs -- */
  readonly sessionsCreated: Counter<"domain" | "version" | "mock_role">;
  readonly flowRuns: Counter<"flow_id" | "status">;

  /* -- the wire -- */
  readonly inboundCalls: Counter<"action" | "ack" | "nack_code">;
  readonly inboundDuration: Histogram<"action" | "ack">;
  readonly outboundSends: Counter<"action" | "outcome">;
  readonly outboundDuration: Histogram<"action" | "outcome">;

  /* -- validation -- */
  readonly validationVerdicts: Counter<"verdict" | "direction">;
  readonly validationFindings: Counter<"layer" | "code">;
  readonly validationDuration: Histogram<"outcome">;

  /* -- upstreams -- */
  readonly configServiceRequests: Counter<"operation" | "outcome">;
  readonly configServiceDuration: Histogram<"operation">;

  /* -- the incident corpus -- */
  readonly incidents: Counter<"trigger" | "code">;
  readonly incidentsResolved: Counter<"trigger" | "state">;
  readonly feedbackReports: Counter<"outcome">;

  /* -- the sandbox -- */
  readonly mockEngineExecutions: Counter<"fn" | "outcome">;
  readonly mockEngineDuration: Histogram<"fn">;
  readonly mockEngineRunners: Gauge<string>;

  /* -- the live mirror -- */
  readonly mirrorQueueDepth: Gauge<string>;
  readonly mirrorRecords: Counter<"outcome">;

  /**
   * Bound a `ValidationFinding.code`, or an incident code derived from one.
   *
   * Those values come out of upstream's compiled `x-validations` and we do not
   * own the space they live in — see `boundedLabel`. One shared cap across the
   * whole process, because the hazard is the total number of series, not the
   * number per instrument.
   */
  findingCode(code: string): string;

  /**
   * Bound a protocol action.
   *
   * The beckn vocabulary is about twenty strings, which is why `action` is a
   * label at all — but **the value does not come from that vocabulary.** The
   * receiver mounts `/:domain/:version/:role/:action` as a free path segment,
   * and `context.action` is whatever the caller put in the body; both are
   * reachable by anyone who can POST to an endpoint we deliberately leave
   * unauthenticated. A stranger looping on random paths would otherwise mint a
   * series per request.
   */
  action(action: string): string;

  /** Register a gauge's data source once the thing that owns it exists. */
  observe(sources: MetricSources): void;

  /**
   * Release everything `collectDefaultMetrics` installed on the process, then
   * empty the registry. Called from `container.dispose()`.
   */
  dispose(): void;
}

/**
 * Values a label may take before the rest collapse into `other`.
 *
 * A hundred distinct rule codes is a readable dashboard; the tail beyond it is
 * a cardinality incident waiting for a participant with a novel defect.
 */
const FINDING_CODE_CAP = 100;

/**
 * Distinct action labels kept.
 *
 * Generous next to beckn's ~20 actions, so a legitimate build with extras and
 * form steps never folds; small enough that a stranger POSTing random paths at
 * the open receiver cannot turn a scrape into a cardinality incident.
 */
const ACTION_CAP = 50;

/** Latency buckets, in **seconds**. Prometheus convention, never milliseconds. */
const LATENCY_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/**
 * Bound a label whose value space we do not own.
 *
 * First `max` distinct values are kept; everything after becomes "other".
 * Deliberately first-seen-wins rather than most-frequent: the alternative needs
 * a frequency table, which is the cardinality problem again with extra steps.
 */
export function boundedLabel(
  seen: Set<string>,
  value: string,
  max: number,
): string {
  if (seen.has(value)) return value;
  if (seen.size >= max) return "other";
  seen.add(value);
  return value;
}

export function createMetrics(): Metrics {
  // Ours alone. See the header: prom-client's default `register` is process
  // state, and reusing it makes the second container in a process throw.
  const registry = new Registry();
  const releaseDefaults = collectDefaults(registry);

  const sources: MetricSources = {};
  const findingCodes = new Set<string>();
  const actions = new Set<string>();

  const registers = [registry];

  const sessionsCreated = new Counter({
    name: "ondc_sessions_created_total",
    help: "Mock-NP sessions created, by build and the role this server plays.",
    labelNames: ["domain", "version", "mock_role"] as const,
    registers,
  });

  const flowRuns = new Counter({
    name: "ondc_flow_runs_total",
    help:
      "Flow-run lifecycle transitions. `started` is a run opening, `bound` is " +
      "it acquiring a transaction id, `complete` is every step done, " +
      "`restarted` is an attempt abandoned.",
    labelNames: ["flow_id", "status"] as const,
    registers,
  });

  const inboundCalls = new Counter({
    name: "ondc_inbound_calls_total",
    help: "Protocol calls the participant made to this mock, by verdict.",
    labelNames: ["action", "ack", "nack_code"] as const,
    registers,
  });

  const inboundDuration = new Histogram({
    name: "ondc_inbound_duration_seconds",
    help:
      "The ACK window: how long the participant's connection was held open " +
      "while this mock decided ACK or NACK.",
    labelNames: ["action", "ack"] as const,
    buckets: LATENCY_BUCKETS,
    registers,
  });

  const outboundSends = new Counter({
    name: "ondc_outbound_sends_total",
    help:
      "Protocol calls this mock made, by outcome: the ACK/NACK it got back, " +
      "or the delivery classification of a send that never completed.",
    labelNames: ["action", "outcome"] as const,
    registers,
  });

  const outboundDuration = new Histogram({
    name: "ondc_outbound_duration_seconds",
    help: "Round trip for one outbound protocol call.",
    labelNames: ["action", "outcome"] as const,
    buckets: LATENCY_BUCKETS,
    registers,
  });

  const validationVerdicts = new Counter({
    name: "ondc_validation_verdicts_total",
    help:
      "L0/L1 verdicts. `unavailable` is a third verdict and never a synonym " +
      "for `valid` — both gates fail open on it, so this is how an operator " +
      "sees payloads going unjudged.",
    labelNames: ["verdict", "direction"] as const,
    registers,
  });

  const validationFindings = new Counter({
    name: "ondc_validation_findings_total",
    help: "Individual validation findings, by layer and rule code.",
    labelNames: ["layer", "code"] as const,
    registers,
  });

  const validationDuration = new Histogram({
    name: "ondc_validation_duration_seconds",
    help:
      "One call to the validation oracle. Paid inside the inbound ACK window, " +
      "so its tail is the participant's tail.",
    labelNames: ["outcome"] as const,
    buckets: LATENCY_BUCKETS,
    registers,
  });

  const configServiceRequests = new Counter({
    name: "ondc_config_service_requests_total",
    help: "Requests to the config-service, by operation and outcome.",
    labelNames: ["operation", "outcome"] as const,
    registers,
  });

  const configServiceDuration = new Histogram({
    name: "ondc_config_service_duration_seconds",
    help: "One config-service request.",
    labelNames: ["operation"] as const,
    buckets: LATENCY_BUCKETS,
    registers,
  });

  const incidents = new Counter({
    name: "ondc_incidents_total",
    help: "Incidents opened in the corpus, by trigger family and code.",
    labelNames: ["trigger", "code"] as const,
    registers,
  });

  const incidentsResolved = new Counter({
    name: "ondc_incidents_resolved_total",
    help:
      "Incidents leaving OPEN, by the **derived** state — never by what the " +
      "model claimed about itself.",
    labelNames: ["trigger", "state"] as const,
    registers,
  });

  const feedbackReports = new Counter({
    name: "ondc_feedback_reports_total",
    help: "Issue reports by delivery outcome: spooled, uploaded, or refused.",
    labelNames: ["outcome"] as const,
    registers,
  });

  const mockEngineExecutions = new Counter({
    name: "ondc_mock_engine_executions_total",
    help: "Sandboxed config functions run, by function and outcome.",
    labelNames: ["fn", "outcome"] as const,
    registers,
  });

  const mockEngineDuration = new Histogram({
    name: "ondc_mock_engine_duration_seconds",
    help: "One sandboxed config function, worker round trip included.",
    labelNames: ["fn"] as const,
    buckets: LATENCY_BUCKETS,
    registers,
  });

  const mockEngineRunners = new Gauge({
    name: "ondc_mock_engine_runners",
    help:
      "Cached mock-runner instances. Not the worker-pool size, which the " +
      "library does not expose — see this file's header.",
    registers,
    collect() {
      const read = sources.runners;
      if (read !== undefined) this.set(read());
    },
  });

  const mirrorQueueDepth = new Gauge({
    name: "ondc_mirror_queue_depth",
    help:
      "Mirror records waiting for a batch. Approaching MIRROR_QUEUE_MAX means " +
      "records are about to be dropped oldest-first.",
    registers,
    collect() {
      const read = sources.mirrorQueueDepth;
      if (read !== undefined) this.set(read());
    },
  });

  const mirrorRecords = new Counter({
    name: "ondc_mirror_records_total",
    help: "Mirror records by fate: emitted, sent, dropped, or refused.",
    labelNames: ["outcome"] as const,
    registers,
  });

  return {
    registry,
    sessionsCreated,
    flowRuns,
    inboundCalls,
    inboundDuration,
    outboundSends,
    outboundDuration,
    validationVerdicts,
    validationFindings,
    validationDuration,
    configServiceRequests,
    configServiceDuration,
    incidents,
    incidentsResolved,
    feedbackReports,
    mockEngineExecutions,
    mockEngineDuration,
    mockEngineRunners,
    mirrorQueueDepth,
    mirrorRecords,
    findingCode: (code) => boundedLabel(findingCodes, code, FINDING_CODE_CAP),
    action: (action) => boundedLabel(actions, action, ACTION_CAP),
    observe(next: MetricSources): void {
      Object.assign(sources, next);
    },
    dispose(): void {
      releaseDefaults();
      registry.clear();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Default metrics, and the process resources they quietly install             */
/* -------------------------------------------------------------------------- */

/**
 * Call `collectDefaultMetrics` and hand back a disposer that undoes it.
 *
 * `collectDefaultMetrics` returns `undefined` and keeps nothing you can close.
 * Two of the collectors it installs are **process resources, not registry
 * entries**, so `registry.clear()` does not touch them:
 *
 * - `metrics/gc.js` constructs a `PerformanceObserver` on `gc` entries and
 *   never disconnects it;
 * - `metrics/eventLoopLag.js` calls `monitorEventLoopDelay().enable()` and
 *   never disables it.
 *
 * One of each per container. In production that is one of each, forever, and
 * harmless. In the test suite it is one per `createHarness`, and every previous
 * container's observer keeps firing into a registry nobody will ever scrape —
 * which is a real cost paid on every GC for the rest of the run.
 *
 * There is no API for this, so the two factories are wrapped for the length of
 * the call and restored immediately after. Narrow, synchronous, and reversed in
 * a `finally`, which is the most containable version of a distasteful thing.
 * `createRequire` rather than an `import`: prom-client reaches these off the
 * **CommonJS** `perf_hooks` object, and an ESM namespace import is frozen.
 */
function collectDefaults(registry: Registry): () => void {
  interface Disconnectable {
    disconnect(): void;
  }
  interface Disableable {
    disable(): void;
  }
  interface PerfHooks {
    PerformanceObserver: new (callback: unknown) => Disconnectable;
    monitorEventLoopDelay?: (options?: unknown) => Disableable;
  }

  let perfHooks: PerfHooks | undefined;
  try {
    perfHooks = createRequire(import.meta.url)("node:perf_hooks") as PerfHooks;
  } catch {
    // No `perf_hooks` means prom-client skips both collectors anyway, and
    // there is nothing to release.
    perfHooks = undefined;
  }

  if (perfHooks === undefined) {
    collectDefaultMetrics({ register: registry });
    return () => undefined;
  }

  const observers: Disconnectable[] = [];
  const histograms: Disableable[] = [];

  const RealObserver = perfHooks.PerformanceObserver;
  const realMonitor = perfHooks.monitorEventLoopDelay;

  perfHooks.PerformanceObserver = class extends RealObserver {
    constructor(callback: unknown) {
      super(callback);
      observers.push(this);
    }
  };
  if (realMonitor !== undefined) {
    perfHooks.monitorEventLoopDelay = (options?: unknown): Disableable => {
      const histogram = realMonitor(options);
      histograms.push(histogram);
      return histogram;
    };
  }

  try {
    collectDefaultMetrics({ register: registry });
  } finally {
    perfHooks.PerformanceObserver = RealObserver;
    if (realMonitor !== undefined) {
      perfHooks.monitorEventLoopDelay = realMonitor;
    }
  }

  return () => {
    for (const observer of observers) {
      try {
        observer.disconnect();
      } catch {
        // Already gone. Disposal is best-effort by construction.
      }
    }
    for (const histogram of histograms) {
      try {
        histogram.disable();
      } catch {
        // As above.
      }
    }
  };
}
