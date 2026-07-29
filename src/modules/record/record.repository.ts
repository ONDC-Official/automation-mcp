import { cacheKey, type CacheStore } from "@/lib/cache/cache-store.js";
import type { FlowStatusCode } from "@/modules/flow/engine/engine-types.js";
import {
  JOURNAL_LIMIT,
  type Expectation,
  type ExpectationScope,
  type PayloadRecord,
  type SessionEvent,
  type TransactionLocation,
  type TransactionRecord,
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
  /**
   * Lifetime of the session journal and its cursor.
   *
   * The session's own TTL, not the transaction's: the journal outlives every
   * transaction in it, and an entry the model has not read yet must not vanish
   * because the run it describes expired.
   */
  sessionTtlMs: number;
}

export class RecordRepository {
  readonly #cache: CacheStore;
  readonly #txnTtl: number;
  readonly #statusTtl: number;
  readonly #expectationTtl: number;
  readonly #sessionTtl: number;

  constructor(options: RecordRepositoryOptions) {
    this.#cache = options.cache;
    this.#txnTtl = options.transactionTtlMs;
    this.#statusTtl = options.flowStatusTtlMs;
    this.#expectationTtl = options.expectationTtlMs;
    this.#sessionTtl = options.sessionTtlMs;
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

  /**
   * Drop a stored body.
   *
   * The one caller is `RecordService#discardApiEntry`, undoing an outbound entry
   * for a call that provably never left. Nothing that *did* cross the wire is
   * ever deleted — this is a compliance server, and the payloads are the
   * evidence.
   */
  deletePayload(payloadId: string): Promise<void> {
    return this.#cache.delete(payloadKey(payloadId));
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
    // Issued together rather than in sequence. Awaited one at a time this is N
    // serial round trips against a remote store, on a path that runs inside the
    // ACK window; issued in the same tick, ioredis pipelines them into one.
    // `map` preserves order, and the in-memory store is indifferent either way.
    const resolved = await Promise.all(
      stepKeys.map(
        async (key) =>
          [
            key,
            await this.getFlowStatus(transactionId, subscriberUrl, key),
          ] as const,
      ),
    );
    return new Map(resolved);
  }

  /* ----------------------------- expectations ----------------------------- */

  /**
   * The expectations armed on one endpoint, **as copies**.
   *
   * `InMemoryCacheStore` hands back the reference it stored, so a caller that
   * edits the returned array would mutate live state before `save` ran — and
   * would then behave completely differently against a Redis store, which
   * round-trips through JSON. Copying here makes the two stores agree.
   */
  async loadExpectations(scope: ExpectationScope): Promise<Expectation[]> {
    const stored = await this.#cache.get<Expectation[]>(expectationKey(scope));
    return (stored ?? []).map((entry) => ({ ...entry }));
  }

  saveExpectations(
    scope: ExpectationScope,
    expectations: readonly Expectation[],
  ): Promise<void> {
    return expectations.length === 0
      ? this.#cache.delete(expectationKey(scope))
      : this.#cache.set(
          expectationKey(scope),
          [...expectations],
          this.#expectationTtl,
        );
  }

  /* ------------------------- transaction locations ------------------------ */

  async findTransactionLocations(
    transactionId: string,
  ): Promise<TransactionLocation[]> {
    const stored = await this.#cache.get<TransactionLocation[]>(
      transactionIndexKey(transactionId),
    );
    return (stored ?? []).map((entry) => ({ ...entry }));
  }

  async addTransactionLocation(location: TransactionLocation): Promise<void> {
    const existing = await this.findTransactionLocations(
      location.transactionId,
    );
    const duplicate = existing.some(
      (entry) =>
        entry.sessionId === location.sessionId &&
        normaliseSubscriberUrl(entry.subscriberUrl) ===
          normaliseSubscriberUrl(location.subscriberUrl),
    );
    if (duplicate) return;
    await this.#cache.set(
      transactionIndexKey(location.transactionId),
      [...existing, location],
      this.#txnTtl,
    );
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

  /* ------------------------------- journal -------------------------------- */

  /**
   * The next journal seq for a session, reserved before the entry is written.
   *
   * Atomic, and that is not a nicety: this is the one number every reader sorts
   * and compares against its delivery cursor. A read-modify-write here would
   * hand two concurrent writers the same seq, and the second entry would be
   * invisible to any cursor that had already passed the first.
   */
  nextJournalSeq(sessionId: string): Promise<number> {
    return this.#cache.increment(journalSeqKey(sessionId), this.#sessionTtl);
  }

  /**
   * Append one entry, dropping the oldest past `JOURNAL_LIMIT`.
   *
   * Deliberately **not** read-modify-write — see `CLAUDE.md` on the three
   * existing races and the standing rule against a fourth. The trim and the
   * expiry ride the same atomic append.
   */
  appendJournal(sessionId: string, entry: SessionEvent): Promise<void> {
    return this.#cache.listAppend(journalKey(sessionId), entry, {
      ttlMs: this.#sessionTtl,
      maxLength: JOURNAL_LIMIT,
    });
  }

  /**
   * Journal entries newer than `afterSeq`, oldest first.
   *
   * Filtered rather than sliced by index, because the cap means position and
   * seq stop agreeing the moment the log has been trimmed once.
   */
  async journalSince(
    sessionId: string,
    afterSeq: number,
  ): Promise<SessionEvent[]> {
    const stored = await this.#cache.listRange<SessionEvent>(
      journalKey(sessionId),
    );
    return stored
      .filter((entry) => entry.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq);
  }

  /**
   * Claim a one-shot marker, answering `true` for exactly one caller ever.
   *
   * Built on `increment` rather than a flag on the transaction record, and the
   * reason is worth stating: the record is read-modify-written by
   * `appendApiEntry` on every exchange, so a flag stored there would be
   * clobbered by an append that started before the flag was written. A counter
   * on its own key cannot lose that race, and "first" is exactly what an atomic
   * increment answers.
   */
  async claimFirst(name: string): Promise<boolean> {
    return (await this.#cache.increment(onceKey(name), this.#txnTtl)) === 1;
  }

  /** How far piggyback delivery has got. Absent reads as "nothing delivered". */
  async getEventCursor(sessionId: string): Promise<number> {
    return (
      (await this.#cache.get<number>(journalCursorKey(sessionId))) ?? 0
    );
  }

  setEventCursor(sessionId: string, seq: number): Promise<void> {
    return this.#cache.set(
      journalCursorKey(sessionId),
      seq,
      this.#sessionTtl,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Key builders — exported so tests can assert the workbench layout holds      */
/* -------------------------------------------------------------------------- */

/**
 * One spelling for a counterparty URL, so every key derived from it agrees.
 *
 * Half the URLs we key on are ours (`session.np.subscriber_url`, as registered)
 * and half are the participant's (`context.bap_uri`/`bpp_uri`, as advertised).
 * They are meant to be the same string and routinely are not — a trailing
 * slash, a capitalised host, an explicit `:443`. Left alone, that writes one
 * record and reads another.
 *
 * Deliberately conservative: **the path is preserved**, because a subscriber
 * URL of `https://np.example.com/ondc` is a different participant from
 * `https://np.example.com`. Only genuinely insignificant differences are
 * folded away.
 */
export function normaliseSubscriberUrl(subscriberUrl: string): string {
  const trimmed = subscriberUrl.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // Not absolute — the participant gave us something odd. Strip what we can
    // rather than throwing: a bad URL is the receiver's problem to report, not
    // a key builder's to crash on.
    return trimmed.replace(/\/+$/, "");
  }
  const scheme = url.protocol.toLowerCase();
  const defaultPort =
    (scheme === "https:" && url.port === "443") ||
    (scheme === "http:" && url.port === "80");
  const host = defaultPort
    ? url.hostname.toLowerCase()
    : url.host.toLowerCase();
  const path = url.pathname.replace(/\/+$/, "");
  return `${scheme}//${host}${path}`;
}

export function transactionKey(
  transactionId: string,
  subscriberUrl: string,
): string {
  return `${transactionId.trim()}::${normaliseSubscriberUrl(subscriberUrl)}`;
}

export function businessDataKey(
  transactionId: string,
  subscriberUrl: string,
): string {
  return `MOCK_DATA::${transactionId.trim()}::${normaliseSubscriberUrl(
    subscriberUrl,
  )}`;
}

export function flowStatusKey(
  transactionId: string,
  subscriberUrl: string,
  stepKey?: string,
): string {
  const pair = `${transactionId.trim()}::${normaliseSubscriberUrl(
    subscriberUrl,
  )}`;
  return stepKey === undefined
    ? `FLOW_STATUS_${pair}`
    : `EXTRA_FLOW_STATUS_${pair}::${stepKey}`;
}

export function payloadKey(payloadId: string): string {
  return cacheKey("payload", payloadId);
}

/**
 * Expectations are bucketed by **endpoint**, not by session or subscriber.
 *
 * That is the only thing both sides of the lookup can agree on. When a step is
 * armed we know the session and the URL it registered; when the call lands we
 * know the path it arrived on and whatever URI the payload chose to advertise.
 * Keying on the subscriber URL would let those two disagree and never meet —
 * so the URL is carried *on* the entry as a tie-break instead, and the key is
 * exactly what the URL can distinguish.
 *
 * Scoped by build because one process serves many; the workbench gets away
 * without it only because each of its deployments serves exactly one.
 */
export function expectationKey(scope: ExpectationScope): string {
  return cacheKey(
    "expect",
    scope.domain.trim().toUpperCase(),
    scope.version.trim(),
    scope.role,
  );
}

/**
 * Where a transaction lives, found by id alone.
 *
 * The pair key needs a subscriber URL we do not yet have when a call arrives —
 * that is the whole reason this index exists. See `TransactionLocation`.
 */
export function transactionIndexKey(transactionId: string): string {
  return cacheKey("txn_index", transactionId.trim());
}

export function sessionIndexKey(sessionId: string): string {
  return cacheKey("session_txns", sessionId);
}

/**
 * The session's event journal — and, doing double duty, the `TransactionEvents`
 * key a session-scope `flow_await` parks on.
 *
 * One string for both on purpose. The two namespaces are separate (one is
 * `CacheStore`, the other is an in-process waiter map), so there is no
 * collision to fear, and deriving them from a single helper is what guarantees
 * the append and the wake-up can never end up talking about different sessions.
 * `flowRunKey` earns its keep the same way.
 */
export function journalKey(sessionId: string): string {
  return cacheKey("journal", sessionId.trim());
}

/** The journal's own counter. Session-wide, and a different space from a
 * transaction's `seq`. */
export function journalSeqKey(sessionId: string): string {
  return cacheKey("journal_seq", sessionId.trim());
}

/**
 * How much of the journal has been handed to the model.
 *
 * Server-side rather than a token the model carries, because the model must not
 * have to do bookkeeping to be told what happened — the whole delivery scheme
 * rests on it being unavoidable rather than opt-in.
 */
export function journalCursorKey(sessionId: string): string {
  return cacheKey("journal_cursor", sessionId.trim());
}

/** A one-shot marker — see `claimFirst`. */
export function onceKey(name: string): string {
  return cacheKey("once", name);
}

/**
 * One flow run inside one session — our port of the workbench's `flowMap`.
 *
 * It exists because a flow run outlives the window in which it has no
 * `transaction_id`. The id belongs to whoever sends the flow's first action, so
 * when that is the participant we do not learn it until their call lands; until
 * then every key derived from a transaction id is unusable and the caller still
 * needs something to hold.
 *
 * Used for two things that must agree: the stored `FlowBinding`
 * (`flow.repository.ts`) and the `TransactionEvents` key `flow_await` parks on
 * while the run is unbound. Deriving both from here is what makes a callback
 * that binds the run wake the waiter that was parked before it existed.
 */
export function flowRunKey(sessionId: string, flowId: string): string {
  return cacheKey("flow_run", sessionId.trim(), flowId.trim());
}
