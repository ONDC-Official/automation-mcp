import { cacheKey, type CacheStore } from "@/lib/cache/cache-store.js";
import type { FlowStatusCode } from "@/modules/flow/engine/engine-types.js";
import type {
  Expectation,
  PayloadRecord,
  TransactionRecord,
} from "@/modules/record/record.schema.js";

/**
 * Every `CacheStore` key the flow loop touches, in one file.
 *
 * ## The key shapes are the workbench's, kept literally
 *
 * `{txn}::{sub}`, `MOCK_DATA::{txn}::{sub}`, `FLOW_STATUS_{txn}::{sub}` — these
 * are not our conventions, they are the workbench's Redis layout reproduced
 * exactly. Keeping them means the day this server shares a Redis with the real
 * workbench (to inspect a transaction, or to hand one over mid-flight) it is a
 * configuration change rather than a migration.
 *
 * ## Why a transaction is keyed by counterparty as well
 *
 * The same `transaction_id` run against two different participants is two
 * different tests with two different sets of exchanges. Keying on the pair is
 * what keeps them from overwriting each other — and it is why every method here
 * takes both.
 *
 * TTLs are the caller's to choose, per entry; nothing here invents a default.
 */

export interface RecordRepositoryOptions {
  cache: CacheStore;
  /** Lifetime of transactions, payloads and business data. */
  transactionTtlMs: number;
  /** Lifetime of a per-step WORKING/AVAILABLE marker. */
  flowStatusTtlMs: number;
  /** Lifetime of an armed expectation. */
  expectationTtlMs: number;
}

export class RecordRepository {
  readonly #cache: CacheStore;
  readonly #txnTtl: number;
  readonly #statusTtl: number;
  readonly #expectationTtl: number;

  constructor(options: RecordRepositoryOptions) {
    this.#cache = options.cache;
    this.#txnTtl = options.transactionTtlMs;
    this.#statusTtl = options.flowStatusTtlMs;
    this.#expectationTtl = options.expectationTtlMs;
  }

  /* ------------------------------ transaction ----------------------------- */

  findTransaction(
    transactionId: string,
    subscriberUrl: string,
  ): Promise<TransactionRecord | undefined> {
    return this.#cache.get<TransactionRecord>(
      transactionKey(transactionId, subscriberUrl),
    );
  }

  saveTransaction(record: TransactionRecord): Promise<void> {
    return this.#cache.set(
      transactionKey(record.transactionId, record.subscriberUrl),
      record,
      this.#txnTtl,
    );
  }

  /* --------------------------- business data ------------------------------ */

  async getBusinessData(
    transactionId: string,
    subscriberUrl: string,
  ): Promise<Record<string, unknown>> {
    return (
      (await this.#cache.get<Record<string, unknown>>(
        businessDataKey(transactionId, subscriberUrl),
      )) ?? {}
    );
  }

  saveBusinessData(
    transactionId: string,
    subscriberUrl: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    return this.#cache.set(
      businessDataKey(transactionId, subscriberUrl),
      data,
      this.#txnTtl,
    );
  }

  /* ------------------------------- payloads ------------------------------- */

  findPayload(payloadId: string): Promise<PayloadRecord | undefined> {
    return this.#cache.get<PayloadRecord>(payloadKey(payloadId));
  }

  savePayload(payload: PayloadRecord): Promise<void> {
    return this.#cache.set(
      payloadKey(payload.payloadId),
      payload,
      this.#txnTtl,
    );
  }

  /* ----------------------------- flow status ------------------------------ */

  /**
   * The per-step concurrency guard.
   *
   * An absent marker reads as `AVAILABLE` — and so, deliberately, does an
   * expired one. A dispatch that crashed without writing `AVAILABLE` back would
   * otherwise wedge its step until the TTL, and "wedged until tomorrow" is a
   * far worse failure than "retried once too often". The workbench makes the
   * same trade.
   */
  async getFlowStatus(
    transactionId: string,
    subscriberUrl: string,
    stepKey?: string,
  ): Promise<FlowStatusCode> {
    const stored = await this.#cache.get<{ status: FlowStatusCode }>(
      flowStatusKey(transactionId, subscriberUrl, stepKey),
    );
    return stored?.status ?? "AVAILABLE";
  }

  setFlowStatus(
    transactionId: string,
    subscriberUrl: string,
    status: FlowStatusCode,
    stepKey?: string,
  ): Promise<void> {
    return this.#cache.set(
      flowStatusKey(transactionId, subscriberUrl, stepKey),
      { status },
      this.#statusTtl,
    );
  }

  /** Statuses for every declared extras step, for one `getNextActions` call. */
  async getExtraFlowStatuses(
    transactionId: string,
    subscriberUrl: string,
    stepKeys: readonly string[],
  ): Promise<Map<string, FlowStatusCode>> {
    const statuses = new Map<string, FlowStatusCode>();
    for (const key of stepKeys) {
      statuses.set(
        key,
        await this.getFlowStatus(transactionId, subscriberUrl, key),
      );
    }
    return statuses;
  }

  /* ----------------------------- expectations ----------------------------- */

  findExpectation(sessionId: string): Promise<Expectation | undefined> {
    return this.#cache.get<Expectation>(expectationKey(sessionId));
  }

  saveExpectation(expectation: Expectation): Promise<void> {
    return this.#cache.set(
      expectationKey(expectation.sessionId),
      expectation,
      this.#expectationTtl,
    );
  }

  clearExpectation(sessionId: string): Promise<void> {
    return this.#cache.delete(expectationKey(sessionId));
  }

  /* -------------------------- transaction index --------------------------- */

  /**
   * The session's transactions, newest last.
   *
   * Without it a session can only report the transaction the caller happens to
   * be holding an id for, which makes `session_state` and the compliance report
   * impossible to build.
   */
  async listTransactionIds(sessionId: string): Promise<string[]> {
    return (await this.#cache.get<string[]>(sessionIndexKey(sessionId))) ?? [];
  }

  async indexTransaction(
    sessionId: string,
    transactionId: string,
  ): Promise<void> {
    const existing = await this.listTransactionIds(sessionId);
    if (existing.includes(transactionId)) return;
    await this.#cache.set(
      sessionIndexKey(sessionId),
      [...existing, transactionId],
      this.#txnTtl,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Key builders — exported so tests can assert the workbench layout holds      */
/* -------------------------------------------------------------------------- */

export function transactionKey(
  transactionId: string,
  subscriberUrl: string,
): string {
  return `${transactionId.trim()}::${subscriberUrl.trim()}`;
}

export function businessDataKey(
  transactionId: string,
  subscriberUrl: string,
): string {
  return `MOCK_DATA::${transactionId.trim()}::${subscriberUrl.trim()}`;
}

export function flowStatusKey(
  transactionId: string,
  subscriberUrl: string,
  stepKey?: string,
): string {
  return stepKey === undefined
    ? `FLOW_STATUS_${transactionId}::${subscriberUrl}`
    : `EXTRA_FLOW_STATUS_${transactionId}::${subscriberUrl}::${stepKey}`;
}

export function payloadKey(payloadId: string): string {
  return cacheKey("payload", payloadId);
}

export function expectationKey(sessionId: string): string {
  return cacheKey("expect", sessionId);
}

export function sessionIndexKey(sessionId: string): string {
  return cacheKey("session_txns", sessionId);
}
