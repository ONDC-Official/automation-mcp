import {
  Logger as RunnerLogger,
  LogLevel,
  MockRunner,
  type MockPlaygroundConfigType,
} from "@ondc/automation-mock-runner";
import type { Logger } from "pino";
import { UpstreamError } from "@/lib/errors.js";

/**
 * The adapter around `@ondc/automation-mock-runner`.
 *
 * ## What the runner is for
 *
 * Every step of a flow carries three base64-encoded JavaScript functions
 * authored against the workbench's contract — `generate(defaultPayload,
 * sessionData)`, `validate(target, sessionData)` and
 * `meetsRequirements(sessionData)`. They are the *same* assets the workbench
 * executes, fetched from the same config-service, and running them here is what
 * makes this server a faithful mock rather than an approximation of one.
 *
 * They are **executable assets, never reference text**: a single flow's config
 * is ~330KB, so it is fetched server-side, cached under a handle, and executed
 * here. Nothing from it reaches the model's context.
 *
 * ## Three things this file exists to get right
 *
 * 1. **Worker lifetime.** The runner executes untrusted config JavaScript in
 *    `worker_threads`. The pool is process-wide and must be torn down in
 *    `dispose()`, or a stdio process hangs on shutdown holding live workers.
 * 2. **stdout.** The runner's own logger writes with `console.log` when
 *    `NODE_ENV=development`. Its level is pinned to ERROR here, and
 *    `lib/stdout-guard.ts` moves `console` to stderr on the stdio entrypoint —
 *    two independent guards, because one stray byte breaks the protocol.
 * 3. **Instance reuse.** A `MockRunner` is expensive to build (it validates a
 *    330KB config) and holds a handle on the shared pool, so instances are
 *    cached per flow config and swept when idle. These caches hold live
 *    resources rather than data, which is why they are not in `CacheStore`.
 */

/** Normalised outcome of one sandboxed call. */
export interface RunOutcome<T = unknown> {
  ok: boolean;
  result?: T;
  error?: { name: string; message: string; stack?: string };
  /** Anything the config's own `console` calls produced. Diagnostics only. */
  logs: string[];
}

/** What `validate` and `meetsRequirements` are contracted to return. */
export interface VerdictResult {
  valid: boolean;
  code?: string | number;
  description?: string;
}

export interface MockEngineOptions {
  logger: Logger;
  /** Base URLs a sandboxed `generate` may fetch. Empty blocks fetch entirely. */
  allowedFetchBaseUrls: readonly string[];
  /** How long an unused runner instance (and its config) is kept. */
  idleTtlMs: number;
  /** Injectable clock, so tests can cross the idle boundary without waiting. */
  now?: () => number;
}

interface CachedRunner {
  readonly runner: MockRunner;
  lastUsed: number;
}

export class MockEngine {
  readonly #logger: Logger;
  readonly #idleTtlMs: number;
  readonly #now: () => number;
  readonly #allowedFetchBaseUrls: string[];
  readonly #runners = new Map<string, CachedRunner>();
  /** The shared worker pool, held so `dispose` can terminate exactly it. */
  #pool: { terminate: () => void } | undefined;
  #disposed = false;

  constructor(options: MockEngineOptions) {
    this.#logger = options.logger.child({ component: "mock-engine" });
    this.#idleTtlMs = options.idleTtlMs;
    this.#now = options.now ?? Date.now;
    this.#allowedFetchBaseUrls = [...options.allowedFetchBaseUrls];
  }

  /**
   * Spin up the shared worker pool.
   *
   * Deferred to first use rather than done at boot: a server that only ever
   * browses the catalog should not be holding worker threads. Safe to call
   * repeatedly.
   */
  #boot(): void {
    if (this.#pool) return;

    // ERROR only: at INFO the runner narrates every execution, and under
    // `NODE_ENV=development` it narrates onto stdout.
    RunnerLogger.getInstance().setLogLevel(LogLevel.ERROR);

    this.#pool = MockRunner.initSharedRunner({
      allowedFetchBaseUrls: this.#allowedFetchBaseUrls,
    });

    this.#logger.debug(
      { fetchAllowlist: this.#allowedFetchBaseUrls.length },
      "mock runner pool started",
    );
  }

  /**
   * A runner for one flow's config, built once and reused.
   *
   * `cacheKey` is the caller's handle for the config — in practice the
   * catalog's `mockcfg::…` key, so a re-fetched config after a TTL miss lands
   * on the same entry.
   */
  getRunner(cacheKey: string, config: MockPlaygroundConfigType): MockRunner {
    this.#assertUsable();
    this.#boot();
    this.#sweep();

    const cached = this.#runners.get(cacheKey);
    if (cached) {
      cached.lastUsed = this.#now();
      return cached.runner;
    }

    const runner = this.#build(cacheKey, config);
    this.#runners.set(cacheKey, { runner, lastUsed: this.#now() });
    return runner;
  }

  /**
   * Construct a runner, retrying without schema validation if the published
   * config does not satisfy the library's own schema.
   *
   * Published configs are authored upstream and do drift from the library's
   * expectations (an absent `saveData`, a step with no `inputs`). Refusing to
   * run such a flow at all would be worse than running it and saying so: the
   * per-step JavaScript is what actually matters and it is unaffected.
   */
  #build(cacheKey: string, config: MockPlaygroundConfigType): MockRunner {
    try {
      return new MockRunner(config);
    } catch (error) {
      this.#logger.warn(
        { cacheKey, err: error },
        "mock config failed the runner's schema; retrying with validation skipped",
      );
      try {
        return new MockRunner(config, true);
      } catch (fatal) {
        throw new UpstreamError(
          "mock-runner",
          `could not load the mock config for this flow: ${describe(fatal)}`,
          { cache_key: cacheKey },
        );
      }
    }
  }

  /** `generate(defaultPayload, sessionData)` for one step. */
  async runGenerate(
    runner: MockRunner,
    actionId: string,
    sessionData: Record<string, unknown>,
  ): Promise<RunOutcome<Record<string, unknown>>> {
    return this.#normalise(
      "generate",
      actionId,
      await runner.runGeneratePayloadWithSession(actionId, sessionData),
    );
  }

  /** `validate(targetPayload, sessionData)` for one step. */
  async runValidate(
    runner: MockRunner,
    actionId: string,
    payload: unknown,
    sessionData: Record<string, unknown>,
  ): Promise<RunOutcome<VerdictResult>> {
    return this.#normalise(
      "validate",
      actionId,
      await runner.runValidatePayloadWithSession(
        actionId,
        payload,
        sessionData,
      ),
    );
  }

  /** `meetsRequirements(sessionData)` for one step. */
  async runRequirements(
    runner: MockRunner,
    actionId: string,
    sessionData: Record<string, unknown>,
  ): Promise<RunOutcome<VerdictResult>> {
    return this.#normalise(
      "requirements",
      actionId,
      await runner.runMeetRequirementsWithSession(actionId, sessionData),
    );
  }

  /**
   * Evaluate one `EVAL#`-flavoured save expression against a payload.
   *
   * Static on the library because it needs no config — it is the escape hatch
   * a flow uses when a JSONPath cannot express what it wants to save.
   */
  async runGetSave(
    payload: unknown,
    encodedExpression: string,
  ): Promise<RunOutcome> {
    this.#assertUsable();
    this.#boot();
    return this.#normalise(
      "getSave",
      "(expression)",
      await MockRunner.runGetSave(payload, encodedExpression),
    );
  }

  /**
   * Flatten the library's `ExecutionResult` into something callers can branch
   * on without knowing the library.
   *
   * Two distinct failures arrive on the same channel: the function threw, and
   * the function returned a shape the contract forbids. Both are the config
   * author's bug and both must surface as `ok: false` — the caller decides
   * whether that becomes a NACK or a blocked step.
   */
  #normalise<T>(
    kind: string,
    actionId: string,
    execution: {
      success: boolean;
      result?: unknown;
      error?: { name: string; message: string; stack?: string };
      logs?: { message: string }[];
      validation?: { isValid: boolean; errors: string[] };
    },
  ): RunOutcome<T> {
    const logs = (execution.logs ?? []).map((entry) => entry.message);
    for (const line of logs) {
      this.#logger.debug({ kind, actionId }, `config log: ${line}`);
    }

    if (!execution.success) {
      const error = execution.error ?? {
        name: "ExecutionError",
        message:
          execution.validation?.errors.join("; ") ??
          "the config function failed without reporting a reason",
      };
      this.#logger.warn(
        { kind, actionId, err: error },
        "config function failed",
      );
      return { ok: false, error, logs };
    }

    return { ok: true, result: execution.result as T, logs };
  }

  /** Evict runners idle for longer than the TTL, freeing their pool slots. */
  #sweep(): void {
    const cutoff = this.#now() - this.#idleTtlMs;
    for (const [key, entry] of this.#runners) {
      if (entry.lastUsed <= cutoff) this.#runners.delete(key);
    }
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new UpstreamError(
        "mock-runner",
        "the mock engine has been shut down",
      );
    }
  }

  /** Cached runner instances. Tests and diagnostics. */
  size(): number {
    return this.#runners.size;
  }

  /**
   * Terminate the worker pool. **Not optional** — the workers are live threads
   * and a stdio process that skips this never exits.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#runners.clear();

    const pool = this.#pool;
    this.#pool = undefined;
    if (!pool) return;

    try {
      pool.terminate();
    } catch (error) {
      this.#logger.warn({ err: error }, "failed to terminate mock runner pool");
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
