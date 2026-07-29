import type { CacheStore } from "@/lib/cache/cache-store.js";
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

  findBinding(
    sessionId: string,
    flowId: string,
  ): Promise<FlowBinding | undefined> {
    return this.#cache.get<FlowBinding>(flowRunKey(sessionId, flowId));
  }

  saveBinding(binding: FlowBinding): Promise<void> {
    return this.#cache.set(
      flowRunKey(binding.sessionId, binding.flowId),
      binding,
      this.#ttl,
    );
  }

  deleteBinding(sessionId: string, flowId: string): Promise<void> {
    return this.#cache.delete(flowRunKey(sessionId, flowId));
  }
}
