import { randomUUID } from "node:crypto";
import { Agent } from "undici";
import type { Logger } from "pino";
import type { Config } from "@/config/env.js";
import type { CacheStore } from "@/lib/cache/cache-store.js";
import { InMemoryCacheStore } from "@/lib/cache/in-memory-cache-store.js";
import { RedisCacheStore } from "@/lib/cache/redis-cache-store.js";
import { TransactionEvents } from "@/lib/events/transaction-events.js";
import { logger as rootLogger } from "@/lib/logger.js";
import { createMetrics, type Metrics } from "@/lib/metrics/metrics.js";
import { MockEngine } from "@/lib/mock-engine/mock-engine.js";
import type { ConfigServiceGateway } from "@/modules/catalog/catalog.gateway.js";
import { HttpConfigServiceGateway } from "@/modules/catalog/catalog.gateway.js";
import { CatalogService } from "@/modules/catalog/catalog.service.js";
import { FeedbackRepository } from "@/modules/feedback/feedback.repository.js";
import { FeedbackService } from "@/modules/feedback/feedback.service.js";
import {
  HttpSink,
  NoopSink,
  SpoolAndUploadSink,
  SpoolSink,
  defaultSpoolDirectory,
  type FeedbackSink,
} from "@/modules/feedback/feedback.sink.js";
import { FlowRepository } from "@/modules/flow/flow.repository.js";
import { FlowService } from "@/modules/flow/flow.service.js";
import { FormsService } from "@/modules/forms/forms.service.js";
import { RecordRepository } from "@/modules/record/record.repository.js";
import { RecordService } from "@/modules/record/record.service.js";
import { MetricsObserver } from "@/modules/metrics/metrics.observer.js";
import { MirrorService } from "@/modules/mirror/mirror.service.js";
import {
  BufferedHttpMirrorSink,
  NoopMirrorSink,
  type MirrorSink,
} from "@/modules/mirror/mirror.sink.js";
import { CacheSessionRepository } from "@/modules/session/session.repository.js";
import { SessionService } from "@/modules/session/session.service.js";
import { UiService } from "@/modules/ui/ui.service.js";
import { createViewerToken, type ViewerToken } from "@/modules/ui/ui.token.js";
import { ReceiverLifecycle } from "@/modules/transport/receiver.lifecycle.js";
import { ReceiverService } from "@/modules/transport/receiver.service.js";
import {
  SenderService,
  type RequestSigner,
} from "@/modules/transport/sender.service.js";
import {
  HttpValidationGateway,
  type ValidationGateway,
} from "@/modules/validate/validate.gateway.js";
import { ValidateService } from "@/modules/validate/validate.service.js";

/**
 * Boot-once singletons.
 *
 * ## Why this exists
 *
 * Under the HTTP transport the MCP server factory is invoked **once per
 * request** (that is what makes the 2026-07-28 transport stateless and
 * horizontally scalable). Anything expensive built inside the factory would
 * therefore be rebuilt on every single call — a new connection pool, a new
 * HTTP agent, a cold cache, per request.
 *
 * So: expensive, long-lived things are constructed **here**, once, at boot.
 * The factory closes over the result and stays cheap. `src/mcp/server.test.ts`
 * asserts this property so it cannot silently regress.
 *
 * It is also where cross-request *state* lives. A mock network participant is
 * inherently stateful — sessions and transactions outlive requests — and a
 * module-scope `Map` would make the factory's statelessness a lie. State goes
 * in the `CacheStore` built here and reached through a repository.
 *
 * There are **two** `CacheStore` instances, and the split is deliberate rather
 * than accidental: `stateStore` holds what must survive a restart (and is Redis
 * when `REDIS_URL` is set), while `catalogCache` holds large derived data that
 * is always cheaper to re-fetch than to ship over a socket. The comments at
 * each construction site say why; that is the decision a future reader is most
 * likely to try to "simplify" back into one.
 *
 * Two things here hold **live resources rather than data** and so legitimately
 * sit outside `CacheStore`: the mock engine's worker pool, and the waiters
 * parked on `TransactionEvents`. Both are released in `dispose`.
 */

/** A named liveness/readiness probe for one dependency. */
export interface HealthCheck {
  readonly name: string;
  /** Resolve for healthy; throw or resolve `false` for unhealthy. */
  check(): Promise<boolean | void>;
  /**
   * Whether this dependency being down should stop traffic reaching us.
   *
   * `true` means it should not: the probe still runs and still reports `down`,
   * because knowing is the point, but `/ready` stays 200. For a dependency the
   * server degrades gracefully without — validation, which fails open — pulling
   * the instance out of rotation would turn a partial loss of function into a
   * total outage.
   */
  readonly optional?: boolean;
}

export interface Container {
  readonly config: Config;
  readonly logger: Logger;
  readonly services: {
    readonly catalog: CatalogService;
    readonly session: SessionService;
    readonly record: RecordService;
    readonly flow: FlowService;
    readonly forms: FormsService;
    readonly validate: ValidateService;
    readonly feedback: FeedbackService;
  };
  /** Where a participant reaches this server's inbound receiver. */
  readonly receiverPublicUrl: string;
  /**
   * Path the receiver and form routes mount under — `""` unless the public URL
   * carries one. Both hosts register with it, so what we advertise resolves.
   */
  readonly receiverRoutePrefix: string;
  /** The pipeline the participant's callbacks run through. */
  readonly inbound: ReceiverService;
  /** Where that pipeline listens, and how to bring it up. */
  readonly receiver: ReceiverLifecycle;
  /** Sandbox for the config-service's per-step JavaScript. */
  readonly mockEngine: MockEngine;
  /**
   * Prometheus instruments, and the registry `GET /metrics` renders.
   *
   * A `lib` in the same category as `logger` — held here so one registry serves
   * the whole process and every emitter is handed the same one.
   */
  readonly metrics: Metrics;
  /** Wake-ups for `flow_await`. */
  readonly events: TransactionEvents;
  /**
   * The read model behind the hosted viewer page.
   *
   * Beside `services` rather than in it, and that is the same statement the
   * mirror makes by not appearing here at all: the viewer is **not part of the
   * transaction**. It registers no tool, no resource and no line in
   * `capabilities.ts`, so a model driving a flow cannot see it and cannot start
   * reasoning about it.
   */
  readonly ui: UiService;
  /** The viewer's credential, minted at boot when none was configured. */
  readonly uiToken: ViewerToken;
  /**
   * The link `session_create` hands the human, or `undefined` when the viewer
   * is switched off. Built here because it needs `receiverPublicUrl`, which is
   * itself derived at boot.
   */
  viewerUrl(sessionId: string): string | undefined;
  /** Probes run by `/ready`. Register one per external dependency. */
  readonly healthChecks: readonly HealthCheck[];
  /** Release every resource acquired at boot. Must be idempotent. */
  dispose(): Promise<void>;
}

export interface CreateContainerOptions {
  /**
   * Override the config-service client. **Tests must always pass one** — the
   * default reaches the real service over the network.
   */
  configServiceGateway?: ConfigServiceGateway;
  /**
   * Override the **state** store — sessions, transactions, payloads — e.g. to
   * control TTL expiry in tests. Takes precedence over `REDIS_URL`.
   */
  cacheStore?: CacheStore;
  /**
   * Override the catalog's derived-data cache. Rarely needed: it is always
   * in-process, so tests get a fresh one for free.
   */
  catalogCacheStore?: CacheStore;
  logger?: Logger;
  /**
   * Which entrypoint is booting.
   *
   * It decides where the inbound receiver lives, and therefore what URL we
   * advertise for callbacks: mounted on the main HTTP app, or a listener of its
   * own that `receiver_start` brings up. Advertising the wrong one means the
   * participant's callbacks never arrive.
   */
  transport?: "http" | "stdio";
  /**
   * Override the L0/L1 validation oracle. **Tests must always pass one** — the
   * default reaches the real api-service over the network.
   */
  validationGateway?: ValidationGateway;
  /** Override the outbound HTTP dispatcher, e.g. undici's `MockAgent`. */
  senderDispatcher?: ConstructorParameters<
    typeof SenderService
  >[0]["dispatcher"];
  /** Signs outbound payloads. Defaults to the no-op signer. */
  signer?: RequestSigner;
  /**
   * Where issue reports go. Tests must pass one — the default writes to the
   * operator's home directory, which no test may touch.
   */
  feedbackSink?: FeedbackSink;
  /**
   * Override the Prometheus registry, e.g. to assert on it without going
   * through the HTTP route. Rarely needed: each container builds its own.
   */
  metrics?: Metrics;
  /**
   * Where mirror records go. Tests must pass one — and `createContainer`
   * refuses to build a real one under `NODE_ENV=test` regardless, the same two
   * guards the feedback sink has and for the same reason.
   */
  mirrorSink?: MirrorSink;
}

export async function createContainer(
  config: Config,
  options: CreateContainerOptions = {},
): Promise<Container> {
  const logger = options.logger ?? rootLogger;

  // One registry per container, never prom-client's process-wide default —
  // `lib/metrics/metrics.ts` explains what breaks otherwise, and it breaks in
  // the test suite rather than in production, which is the worse direction.
  const metrics = options.metrics ?? createMetrics();

  // ---- Expensive singletons go here -------------------------------------
  // One HTTP agent for the process. Built per request it would open a fresh
  // connection pool on every call — the symptom is a capacity cliff under
  // load, not a failing test.
  const httpAgent = new Agent({
    connect: { timeout: 10_000 },
    headersTimeout: config.CONFIG_SERVICE_TIMEOUT_MS,
    bodyTimeout: config.CONFIG_SERVICE_TIMEOUT_MS,
  });

  // ---- State: what has to survive a restart ------------------------------
  // Sessions, transactions, payloads, business data, expectations. Redis when
  // REDIS_URL is set; otherwise the in-process map that has always been the
  // default, so the server still runs with zero infrastructure.
  const stateStore =
    options.cacheStore ??
    (config.REDIS_URL !== undefined
      ? new RedisCacheStore({
          url: config.REDIS_URL,
          keyPrefix: config.REDIS_KEY_PREFIX,
          commandTimeoutMs: config.REDIS_COMMAND_TIMEOUT_MS,
          logger,
        })
      : new InMemoryCacheStore());

  // ---- Derived: the flow catalog -----------------------------------------
  // Always in-process, deliberately. `FlowService.load()` reads a flow's
  // ~330KB mock-runner config on every `flow_proceed` *and* every inbound
  // callback; through Redis that would be a 330KB transfer plus a JSON.parse
  // per loop iteration, one of them inside the ACK window while the
  // participant's socket is open. And it would buy nothing: catalog entries
  // are derived from the config-service, TTL'd at ~15 minutes, and re-fetched
  // transparently on a miss — while the `MockRunner` built from each config
  // already lives in this process (see mock-engine.ts). Putting the source
  // config in Redis while its derived runner stays local is the worst of both.
  //
  // The cost, stated plainly: `catalog_load_flow_config` hands back a
  // `cache_key` that a *different* replica will not have. Self-healing,
  // because `requireMockConfig` re-fetches on a miss.
  const catalogCache = options.catalogCacheStore ?? new InMemoryCacheStore();

  if (config.NODE_ENV === "production" && config.REDIS_URL === undefined) {
    logger.warn(
      "no REDIS_URL: session and transaction state is in-process. It will not " +
        "survive a restart, and replicas will not agree with each other.",
    );
  }

  const configServiceGateway =
    options.configServiceGateway ??
    new HttpConfigServiceGateway({
      baseUrl: config.CONFIG_SERVICE_URL,
      timeoutMs: config.CONFIG_SERVICE_TIMEOUT_MS,
      dispatcher: httpAgent,
      logger,
      metrics,
    });

  const sessionRepository = new CacheSessionRepository(stateStore);

  const catalog = new CatalogService({
    gateway: configServiceGateway,
    cache: catalogCache,
    cacheTtlMs: config.CATALOG_CACHE_TTL_MS,
    logger,
  });

  // Worker threads for the config-service's per-step JavaScript. Nothing is
  // spawned until a flow actually runs.
  const mockEngine = new MockEngine({
    logger,
    allowedFetchBaseUrls: config.RUNNER_FETCH_ALLOWLIST,
    idleTtlMs: config.RUNNER_CACHE_TTL_MS,
    metrics,
  });

  // The runner-count gauge reads the engine at scrape time rather than the
  // engine pushing on every change: a cache size is a level, and levels are
  // sampled. See `MetricSources`.
  metrics.observe({ runners: () => mockEngine.size() });

  const events = new TransactionEvents();

  const recordRepository = new RecordRepository({
    cache: stateStore,
    transactionTtlMs: config.TRANSACTION_TTL_MS,
    flowStatusTtlMs: config.FLOW_STATUS_TTL_MS,
    expectationTtlMs: config.EXPECTATION_TTL_MS,
    // The journal is scoped to the session, so it lives and dies with one.
    sessionTtlMs: config.SESSION_TTL_MS,
  });

  const flowRepository = new FlowRepository({
    cache: stateStore,
    transactionTtlMs: config.TRANSACTION_TTL_MS,
  });

  // What we tell participants to call back on. Under HTTP the receiver is
  // mounted on the main app's port; on stdio it gets a listener of its own.
  const receiverPublicUrl =
    config.RECEIVER_PUBLIC_URL ??
    `http://${config.HOST}:${String(
      options.transport === "stdio" ? config.RECEIVER_PORT : config.PORT,
    )}`;

  // A public URL may carry a path (`https://host/api-service`) when something
  // fronts this process. The routes have to be mounted under the same path or
  // every URL we advertise — receiver and hosted forms alike — 404s.
  const receiverRoutePrefix = (
    config.RECEIVER_ROUTE_PREFIX ?? new URL(receiverPublicUrl).pathname
  ).replace(/\/+$/, "");

  const uiToken = createViewerToken(config.UI_TOKEN);
  if (config.UI_ENABLED && !uiToken.configured) {
    // Said out loud because the token is otherwise invisible: it exists only
    // inside the links `session_create` hands out, so an operator who restarts
    // this process needs to know why yesterday's link stopped working.
    logger.info(
      "viewer: no UI_TOKEN configured; minted one for this process, so links do not survive a restart",
    );
  }

  /**
   * The link a human opens.
   *
   * The page is hosted at `UI_BASE_URL`; the data is not, and never passes
   * through it — the browser fetches straight from this process at
   * `UI_ENGINE_URL`, which defaults to the address we already advertise to the
   * participant, because that is the one known to be reachable from outside.
   *
   * **The parameters go in the fragment, not the query string.** A query string
   * is sent to the page's host in the request line, so the token — a credential
   * for *this* server — would land in somebody else's access logs, for a
   * service deliberately built so their infrastructure never sees a payload. A
   * fragment is never sent. The page clears it from the address bar on load.
   */
  const uiEngineUrl = (config.UI_ENGINE_URL ?? receiverPublicUrl).replace(
    /\/+$/,
    "",
  );
  const uiBaseUrl = config.UI_BASE_URL.replace(/\/+$/, "");
  const viewerUrl = (sessionId: string): string | undefined => {
    if (!config.UI_ENABLED) return undefined;
    const params = new URLSearchParams({
      engine: uiEngineUrl,
      session: sessionId,
      k: uiToken.value,
    });
    return `${uiBaseUrl}/mcp-session#${params.toString()}`;
  };

  /*
   * One salt for every pseudonym this process emits.
   *
   * Hoisted out of `FeedbackService` because the mirror needs the *same* one:
   * `subscriber_ref` on a mirror record and the `np_…` in an issue report are
   * only joinable if they were derived from one key. Generated per process when
   * unset, so pseudonyms are unlinkable across restarts until `FEEDBACK_SALT`
   * pins one — which is what a real corpus wants.
   */
  const pseudonymSalt = config.FEEDBACK_SALT ?? randomUUID();

  /*
   * The live mirror. Built here, before the services that tap it.
   *
   * `MIRROR_ENDPOINT_URL` unset is the whole off switch — there is deliberately
   * no second flag, because a flag you can turn on with nowhere to send reads
   * as configured and does nothing. `NODE_ENV=test` is a hard refusal on top,
   * matching the feedback sink: no suite may open a socket by forgetting to
   * inject one, and `createHarness` injects a no-op as well because this guard
   * is bypassed by any test that builds a container directly.
   */
  const mirrorSink: MirrorSink =
    options.mirrorSink ??
    (config.MIRROR_ENDPOINT_URL === undefined || config.NODE_ENV === "test"
      ? new NoopMirrorSink()
      : new BufferedHttpMirrorSink({
          endpoint: config.MIRROR_ENDPOINT_URL,
          ...(config.MIRROR_API_KEY !== undefined
            ? { apiKey: config.MIRROR_API_KEY }
            : {}),
          timeoutMs: config.MIRROR_TIMEOUT_MS,
          flushIntervalMs: config.MIRROR_FLUSH_INTERVAL_MS,
          batchSize: config.MIRROR_BATCH_SIZE,
          queueMax: config.MIRROR_QUEUE_MAX,
          instanceId: randomUUID(),
          dispatcher: httpAgent,
          logger,
          metrics,
        }));

  const mirror = new MirrorService({
    sink: mirrorSink,
    salt: pseudonymSalt,
    correlation: config.TELEMETRY_CORRELATION,
    logger,
  });

  metrics.observe({
    mirrorQueueDepth: () => mirrorSink.depth?.() ?? 0,
  });

  // Said out loud at boot, beside the feedback line and for the same reason:
  // something that ships diagnostics off the machine owes the operator a
  // printed statement of where they go, not a line in a README.
  if (config.MIRROR_ENDPOINT_URL === undefined) {
    logger.info("mirror: off (no MIRROR_ENDPOINT_URL)");
  } else {
    logger.info(
      { endpoint: config.MIRROR_ENDPOINT_URL },
      "mirror: session, run and journal records are redacted and streamed there; " +
        "unset MIRROR_ENDPOINT_URL to turn this off",
    );
  }

  const session = new SessionService({
    repository: sessionRepository,
    catalog,
    sessionTtlMs: config.SESSION_TTL_MS,
    receiverPublicUrl,
    receiverRoutePrefix,
    viewerUrl,
    logger,
    metrics,
    mirror,
  });

  /*
   * The incident corpus.
   *
   * Built here, between the repositories and the services, because of a knot:
   * `RecordService` notifies it (it owns the journal tap) and it writes a
   * journal line back (`ISSUE_OPEN`). Taking only the two *repositories* — never
   * `RecordService` itself — keeps the module graph one-way, and the one call
   * going the other direction arrives as the `journal` function below, bound
   * after `record` exists.
   *
   * The `() => record` indirection is doing real work: it is evaluated on the
   * capture path, long after this function has returned, so the temporal dead
   * zone it appears to sit in is never actually entered.
   */
  const feedbackRepository = new FeedbackRepository({
    cache: stateStore,
    // An incident outlives the run it describes — that is what `UNRESOLVED`
    // means — so it takes the session's TTL, not the transaction's.
    sessionTtlMs: config.SESSION_TTL_MS,
  });

  /*
   * Capture runs even with a no-op sink installed: incidents are still opened,
   * counted and resolved, and only the *send* is dropped. That is what keeps
   * `feedback_list_reports` useful to an operator who wants to see what would
   * have been sent without anything leaving the machine.
   *
   * Note what "enabled with nothing configured" means: reports are written to a
   * local directory and **nothing leaves the machine** until
   * `FEEDBACK_ENDPOINT_URL` names somewhere for them to go. The spool is
   * deliberately the default rather than the network.
   */
  const spoolDirectory = config.FEEDBACK_SPOOL_DIR ?? defaultSpoolDirectory();
  // `NODE_ENV=test` is a hard refusal, not a default. The spool's default
  // location is the operator's home directory, and a suite that writes there is
  // a suite that quietly litters a real machine with reports about fixtures —
  // which is exactly what happened the first time this shipped without the
  // guard. `createHarness` also injects a no-op sink; this covers every test
  // that builds a container directly.
  const feedbackSink =
    options.feedbackSink ??
    (config.FEEDBACK_DISABLED || config.NODE_ENV === "test"
      ? new NoopSink()
      : new SpoolAndUploadSink({
          spool: new SpoolSink({
            directory: spoolDirectory,
            maxFiles: config.FEEDBACK_SPOOL_MAX_FILES,
            logger,
            metrics,
          }),
          ...(config.FEEDBACK_ENDPOINT_URL !== undefined
            ? {
                http: new HttpSink({
                  endpoint: config.FEEDBACK_ENDPOINT_URL,
                  ...(config.FEEDBACK_API_KEY !== undefined
                    ? { apiKey: config.FEEDBACK_API_KEY }
                    : {}),
                  timeoutMs: config.FEEDBACK_TIMEOUT_MS,
                  dispatcher: httpAgent,
                  logger,
                  metrics,
                }),
              }
            : {}),
          logger,
        }));

  // Said out loud, once, at boot. Something that ships diagnostics off the
  // machine by default owes the operator a plain statement of where they go and
  // how to stop it — buried in a README is not the same as printed on start.
  if (config.FEEDBACK_DISABLED) {
    logger.info("feedback: disabled (FEEDBACK_DISABLED)");
  } else {
    logger.info(
      {
        spool: spoolDirectory,
        endpoint: config.FEEDBACK_ENDPOINT_URL ?? "(none — spool only)",
      },
      "feedback: issue reports are captured, redacted and spooled; " +
        "set FEEDBACK_DISABLED=1 to turn this off",
    );
    if (config.TELEMETRY_CORRELATION) {
      // Said out loud on its own line, because it is the one setting that puts
      // an identifier in the clear on something that leaves the machine.
      logger.info(
        "feedback: TELEMETRY_CORRELATION is on — reports also carry session_id " +
          "and transaction_id in the clear, under `correlation`. Payload " +
          "redaction is unaffected.",
      );
    }
  }

  // Annotated, not inferred: `feedback` and `record` reference each other, and
  // TypeScript cannot resolve a type through that cycle on its own.
  const feedback: FeedbackService = new FeedbackService({
    repository: feedbackRepository,
    flows: flowRepository,
    records: recordRepository,
    sessions: sessionRepository,
    sink: feedbackSink,
    journal: (sessionId, entry): Promise<void> =>
      record.journal(sessionId, entry),
    // Shared with the mirror, so `np_…` in a report and `subscriber_ref` on a
    // mirror record name the same participant.
    salt: pseudonymSalt,
    repoRoot: process.cwd(),
    enabled: !config.FEEDBACK_DISABLED,
    // Off by default. On, a report gains exactly one key — `correlation` — and
    // nothing else changes; `feedback.redact.ts` never sees this flag.
    correlation: config.TELEMETRY_CORRELATION,
    logger,
    metrics,
  });

  const record: RecordService = new RecordService({
    repository: recordRepository,
    events,
    mockEngine,
    expectationTtlMs: config.EXPECTATION_TTL_MS,
    logger,
    // Independent consumers of one feed. The corpus opens incidents; the
    // metrics tap counts; the mirror streams. `RecordService` catches per
    // observer, so none can silence the others — which is the whole reason this
    // is a list.
    observers: [feedback, new MetricsObserver(metrics), mirror],
  });

  // Protocol validation. The gateway shares the process-wide agent because the
  // ~80ms TCP handshake it saves is paid inside the inbound ACK window.
  const validationGateway =
    options.validationGateway ??
    new HttpValidationGateway({
      baseUrl: config.VALIDATION_SERVICE_URL,
      timeoutMs: config.VALIDATION_TIMEOUT_MS,
      dispatcher: httpAgent,
      logger,
      metrics,
    });

  const validate = new ValidateService({
    gateway: validationGateway,
    // The catalog cache, for the same reason it holds flow configs: a verdict is
    // derived, re-computable, and keyed on a payload hash that a second replica
    // would simply miss and re-fetch.
    cache: catalogCache,
    cacheTtlMs: config.VALIDATION_CACHE_TTL_MS,
    mode: config.VALIDATION_MODE,
    logger,
    metrics,
  });

  const sender = new SenderService({
    logger,
    metrics,
    timeoutMs: config.SEND_TIMEOUT_MS,
    ...(options.senderDispatcher
      ? { dispatcher: options.senderDispatcher }
      : {}),
    ...(options.signer ? { signer: options.signer } : {}),
  });

  const flow = new FlowService({
    sessions: session,
    catalog,
    records: record,
    repository: flowRepository,
    sender,
    mockEngine,
    events,
    validate,
    logger,
    receiverPublicUrl,
    mockSubscriberId: config.MOCK_SUBSCRIBER_ID,
    feedback,
    metrics,
    mirror,
  });

  const forms = new FormsService({
    flows: flow,
    records: record,
    logger,
    fetchTimeoutMs: config.FORM_FETCH_TIMEOUT_MS,
    publicBaseUrl: receiverPublicUrl,
    ...(options.senderDispatcher
      ? { dispatcher: options.senderDispatcher }
      : {}),
  });

  const services = {
    catalog,
    session,
    record,
    flow,
    forms,
    validate,
    feedback,
  } as const;

  const inbound = new ReceiverService({
    sessions: session,
    records: record,
    flows: flow,
    forms,
    mockEngine,
    validate,
    logger,
    metrics,
  });

  const ui = new UiService({
    sessions: session,
    catalog,
    flows: flow,
    records: record,
    logger,
  });

  const receiver = new ReceiverLifecycle({
    // Under HTTP the receiver rides on the app that is already listening; on
    // stdio nothing is listening at all until `receiver_start` binds a port.
    mode: options.transport === "stdio" ? "standalone" : "mounted",
    baseUrl: receiverPublicUrl,
    port: options.transport === "stdio" ? config.RECEIVER_PORT : config.PORT,
    requestTimeoutMs: config.REQUEST_TIMEOUT_MS,
    logger,
  });

  const healthChecks: HealthCheck[] = [
    {
      // Every flow this server can drive comes from the config-service. If it
      // is unreachable, sessions cannot be created — so this instance is not
      // ready, and a load balancer should route elsewhere.
      name: "config-service",
      check: () => configServiceGateway.ping(),
    },
    {
      // The state store. Kept second because `app.test.ts` asserts on
      // `checks[0]` being the config-service. Only this one can be remote —
      // the catalog cache is always in-process, so probing it would assert
      // nothing.
      name: "cache-store",
      check: () => stateStore.ping(),
    },
    {
      // Optional on purpose. Validation fails open: an unreachable oracle means
      // payloads go unjudged, not that flows stop. Degrading readiness would
      // pull this instance out of rotation and turn a partial loss of function
      // into a total one — while the participant under test is mid-transaction.
      name: "validation-service",
      optional: true,
      check: () => validationGateway.ping(),
    },
  ];

  let disposed = false;

  return {
    config,
    logger,
    services,
    mockEngine,
    metrics,
    events,
    ui,
    uiToken,
    viewerUrl,
    inbound,
    receiver,
    receiverPublicUrl,
    receiverRoutePrefix,
    healthChecks,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      /*
       * The order carries two invariants, and neither is obvious from reading
       * the calls:
       *
       * 1. **Everything that can still write a journal line is quiesced before
       *    `mirror.close()`.** The mirror observes the journal, and
       *    `feedback.drain()` writes `ISSUE_OPEN` lines for incidents that
       *    never resolved — the last thing this process does is often the most
       *    interesting thing it has to say. Closing the mirror first would
       *    drop exactly those.
       * 2. **`mirror.close()` precedes `httpAgent.close()`**, because its final
       *    flush goes out through that agent. Reversed, the last batch fails on
       *    a closed dispatcher and the records are lost silently.
       */
      await receiver.dispose();
      await feedback.drain();
      await mirror.close();
      mockEngine.dispose();
      // Releases the GC observer and event-loop-delay histogram that
      // `collectDefaultMetrics` installs on the *process* — `registry.clear()`
      // alone leaves both running. See `lib/metrics/metrics.ts`.
      metrics.dispose();
      events.close();
      await stateStore.close();
      await catalogCache.close();
      await httpAgent.close();
      logger.debug("container disposed");
    },
  };
}
