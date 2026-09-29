import { cacheKey, type CacheStore } from "@/lib/cache/cache-store.js";
import type {
  BatchProgress,
  BatchRunState,
  BatchTransactionResult,
  BatchTransactionStatus,
  StartBatchRunInput,
} from "@/modules/batch/batch.schema.js";

/**
 * Data access only — no business rules, no MCP types. Follows the workbench's
 * own key convention (`::`-joined, via `cacheKey`) and, per `CLAUDE.md`'s
 * explicit rule, never a read-modify-write on anything that accumulates:
 * progress counters go through `CacheStore#increment`, results through
 * `#listAppend`. "Do not add a fourth [read-modify-write site]."
 */

export interface BatchMeta {
  batch_id: string;
  state: BatchRunState;
  input: StartBatchRunInput;
  accepted_at: string;
  finished_at?: string;
  /** The seller instance's batch, for a `both` run. */
  peer?: { batch_id: string };
}

const PROGRESS_STATUSES: readonly BatchTransactionStatus[] = [
  "queued",
  "in_flight",
  "completed",
  "blocked",
  "nacked",
  "timed_out",
  "errored",
];

/** How long a batch's meta/progress/results are kept after it finishes. */
export const BATCH_RESULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Cap on the stored results list. Set well above any single batch's
 * `transaction_count` ceiling (`StartBatchRunInput.transaction_count` maxes at
 * 50,000) so nothing is silently dropped; `listAppend` still requires a bound.
 */
const RESULTS_LIST_LIMIT = 60_000;

export class BatchRepository {
  readonly #cache: CacheStore;

  constructor(cache: CacheStore) {
    this.#cache = cache;
  }

  async saveMeta(meta: BatchMeta, ttlMs: number): Promise<void> {
    await this.#cache.set(this.#metaKey(meta.batch_id), meta, ttlMs);
  }

  getMeta(batchId: string): Promise<BatchMeta | undefined> {
    return this.#cache.get<BatchMeta>(this.#metaKey(batchId));
  }

  /** Re-reads, patches and writes back — meta is small and updated rarely. */
  async updateMeta(
    batchId: string,
    ttlMs: number,
    patch: Partial<BatchMeta>,
  ): Promise<void> {
    const current = await this.getMeta(batchId);
    if (!current) return;
    await this.saveMeta({ ...current, ...patch }, ttlMs);
  }

  /** Atomic per-status counter bump — never read-modify-write. */
  async bumpProgress(
    batchId: string,
    status: BatchTransactionStatus,
    ttlMs: number,
    by = 1,
  ): Promise<void> {
    await this.#cache.increment(this.#progressKey(batchId, status), ttlMs, by);
  }

  async getProgress(batchId: string): Promise<BatchProgress> {
    const entries = await Promise.all(
      PROGRESS_STATUSES.map(async (status) => {
        const value = await this.#cache.get<number>(
          this.#progressKey(batchId, status),
        );
        return [status, value ?? 0] as const;
      }),
    );
    return Object.fromEntries(entries) as unknown as BatchProgress;
  }

  /** Atomic append — never read-modify-write. */
  async appendResult(
    batchId: string,
    result: BatchTransactionResult,
    ttlMs: number,
  ): Promise<void> {
    await this.#cache.listAppend(this.#resultsKey(batchId), result, {
      ttlMs,
      maxLength: RESULTS_LIST_LIMIT,
    });
  }

  listResults(
    batchId: string,
    start: number,
    end: number,
  ): Promise<BatchTransactionResult[]> {
    return this.#cache.listRange<BatchTransactionResult>(
      this.#resultsKey(batchId),
      start,
      end,
    );
  }

  async countResults(batchId: string): Promise<number> {
    return (await this.listResults(batchId, 0, -1)).length;
  }

  ping(): Promise<boolean> {
    return this.#cache.ping();
  }

  #metaKey(batchId: string): string {
    return cacheKey("batch", batchId, "meta");
  }

  #progressKey(batchId: string, status: BatchTransactionStatus): string {
    return cacheKey("batch", batchId, "progress", status);
  }

  #resultsKey(batchId: string): string {
    return cacheKey("batch", batchId, "results");
  }
}
