import { cacheKey, type CacheStore } from "@/lib/cache/cache-store.js";
import type { FlowBinding } from "@/modules/flow/flow.schema.js";
import { flowRunKey } from "@/modules/record/record.repository.js";

/**
 * Where a flow run is recorded, and how it acquires a `transaction_id`.
 *
 * This is loop bookkeeping, not a wire artefact — which is why it lives here
 * rather than in `record/`, whose keys are the workbench's Redis layout
 * reproduced literally. The key shape (`flow_run::{sessionId}::{flowId}`) still
 * comes from `record.repository.ts`, because the same string is also the
 * `TransactionEvents` key `flow_await` parks on while a run is unbound. Two
 * spellings of it would mean a callback that binds the run never wakes the
 * waiter.
 *
 * Bindings share the transaction TTL: a run outlives its own transaction by
 * nothing, and a stale binding pointing at an expired transaction would resolve
 * to a `NotFoundError` the caller cannot act on.
 */

export interface FlowRepositoryOptions {
  cache: CacheStore;
  /** Lifetime of a binding — the same as the transaction it points at. */
  transactionTtlMs: number;
}

export class FlowRepository {
  readonly #cache: CacheStore;
  readonly #ttl: number;

  constructor(options: FlowRepositoryOptions) {
    this.#cache = options.cache;
    this.#ttl = options.transactionTtlMs;
  }

  /**
   * The stored binding, with the attempt fields filled in.
   *
   * Nothing parses what comes back out of the store, so a binding written
   * before attempts existed — or by an older process against a shared Redis —
   * arrives typed `attempt: number` and valued `undefined`. That reads as
   * `NaN` the moment anything increments it, and a `NaN` attempt number is a
   * binding that can never be told apart from another. Defaulting on the way
   * out is one line here and would be a conditional at every use site.
   */
  async findBinding(
    sessionId: string,
    flowId: string,
  ): Promise<FlowBinding | undefined> {
    const stored = await this.#cache.get<FlowBinding>(
      flowRunKey(sessionId, flowId),
    );
    if (!stored) return undefined;
    return {
      ...stored,
      attempt: stored.attempt ?? 1,
      previousAttempts: stored.previousAttempts ?? [],
    };
  }

  async saveBinding(binding: FlowBinding): Promise<void> {
    const key = flowRunKey(binding.sessionId, binding.flowId);
    // Checked before the write, so the index only grows when a run is genuinely
    // new. Two concurrent first-saves can both see "absent" and both append —
    // deliberately tolerated, because `listRuns` de-duplicates and the
    // alternative is a read-modify-write, which `CLAUDE.md` forbids adding.
    const known = await this.#cache.has(key);

    await this.#cache.set(key, binding, this.#ttl);

    if (!known) {
      await this.#cache.listAppend(
        sessionRunsKey(binding.sessionId),
        binding.flowId,
        { ttlMs: this.#ttl, maxLength: RUN_INDEX_LIMIT },
      );
    }
  }

  /**
   * Every run this session has opened.
   *
   * Needed because a session-scope `flow_await` has to act on runs the caller
   * did not name: re-arming their lapsed expectations before a long park, and
   * summarising where each of them stands. Derived from an index rather than
   * from the transaction list, because the runs that most need the sweep are
   * precisely the **unbound** ones — no transaction, so nothing else knows
   * they exist.
   *
   * A binding that has expired simply drops out; the index is allowed to name
   * more than it can resolve.
   */
  async listRuns(sessionId: string): Promise<FlowBinding[]> {
    const flowIds = [
      ...new Set(await this.#cache.listRange<string>(sessionRunsKey(sessionId))),
    ];

    const bindings = await Promise.all(
      flowIds.map((flowId) => this.findBinding(sessionId, flowId)),
    );
    return bindings.filter(
      (binding): binding is FlowBinding => binding !== undefined,
    );
  }

  deleteBinding(sessionId: string, flowId: string): Promise<void> {
    return this.#cache.delete(flowRunKey(sessionId, flowId));
  }
}

/**
 * How many distinct runs a session's index remembers.
 *
 * Far above any real session — a build publishes tens of flows, not hundreds —
 * and present only so a caller looping on `flow_start` cannot grow one key
 * without bound.
 */
export const RUN_INDEX_LIMIT = 200;

/** The flows a session has runs of. */
export function sessionRunsKey(sessionId: string): string {
  return cacheKey("session_runs", sessionId.trim());
}
