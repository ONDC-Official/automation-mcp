import { randomUUID } from "node:crypto";
import jsonpath from "jsonpath";
import type { Logger } from "pino";
import type {
  TransactionEvent,
  TransactionEventKind,
  TransactionEvents,
} from "@/lib/events/transaction-events.js";
import { NotFoundError } from "@/lib/errors.js";
import type { MockEngine } from "@/lib/mock-engine/mock-engine.js";
import type { NpType } from "@/modules/catalog/catalog.schema.js";
import type { FlowStatusCode } from "@/modules/flow/engine/engine-types.js";
import {
  expectationKey,
  flowRunKey,
  journalKey,
  normaliseSubscriberUrl,
  transactionKey,
  type RecordRepository,
} from "@/modules/record/record.repository.js";
import {
  EVENTS_DELTA_LIMIT,
  type Abandoned,
  type ApiEntry,
  type Attention,
  type Direction,
  type EventsDelta,
  type Expectation,
  type ExpectationScope,
  type FormEntry,
  type PayloadRecord,
  type SessionEvent,
  type TransactionLocation,
  type TransactionRecord,
} from "@/modules/record/record.schema.js";

/**
 * The transaction ledger: what was exchanged, and what was learned from it.
 *
 * Imports nothing from the MCP SDK. Two responsibilities, and they are
 * genuinely different:
 *
 * 1. **Append an exchange.** Assign it a `seq`, store its body out of line,
 *    keep the slim entry on the record, then wake anyone waiting. Ordering
 *    matters: the record must be durable *before* the notification fires, or a
 *    waiter can be told about work it then fails to find.
 * 2. **Merge business data.** Run the step's `saveData` config against the
 *    payload and fold the results into the transaction's accumulated data —
 *    this is what carries a provider id from `on_search` into `select`.
 */

/**
 * Something that watches every journal line as it is written.
 *
 * Exactly one implementation today — `FeedbackService`, which opens an incident
 * from the lines that describe a failure. It is a tap rather than a set of
 * calls scattered through the receiver and the flow service, because the
 * journal is *already* the place every noteworthy thing goes: the guarantee
 * "if the model is told, the corpus is told" holds by construction instead of
 * by remembering.
 *
 * Two obligations on the implementer, neither of which this service enforces:
 *
 * 1. **Return promptly and never throw.** This is called on the receiver's
 *    path, after the ACK is decided. Do the work off the hot path.
 * 2. **Ignore your own kinds.** An observer that journals in response to a
 *    journal line will recurse until the process dies.
 */
export interface SessionEventObserver {
  onSessionEvent(
    sessionId: string,
    event: SessionEvent,
    diagnostics?: SessionEventDiagnostics,
  ): void;
}

/**
 * Detail that goes to the observer and is **never stored on the event**.
 *
 * The journal is model-facing: its entries are one-sentence summaries, and
 * `record_get_events` hands them straight to a context window. Findings,
 * sandbox stacks and sequence maps belong in a report, not in a summary — so
 * they travel beside the entry rather than on it, and die if nobody is
 * listening.
 *
 * Deliberately typed as loose data here. `record` must not import `feedback`;
 * the shape that matters is `IncidentEvidence`, and the observer is the thing
 * that knows it.
 */
export interface SessionEventDiagnostics {
  readonly stepKey?: string;
  readonly evidence?: Record<string, unknown>;
}

export interface RecordServiceOptions {
  repository: RecordRepository;
  events: TransactionEvents;
  /** Needed only for `EVAL#` save expressions, which run in the sandbox. */
  mockEngine: MockEngine;
  /** Lifetime of an armed expectation; this service owns `expireAt`. */
  expectationTtlMs: number;
  logger: Logger;
  /** Optional; absent in most tests and when feedback reporting is disabled. */
  observer?: SessionEventObserver;
}

export interface CreateTransactionInput {
  transactionId: string;
  sessionId: string;
  flowId: string;
  /** The **participant under test's** side. */
  subscriberType: NpType;
  /**
   * **Always `session.np.subscriber_url`** — the URL registered at
   * `session_create`, never the one an arriving payload advertises.
   *
   * Every other key in this module is derived from it, as is the
   * `TransactionEvents` key `flow_await` blocks on. Keying a record on a
   * payload's URI instead would split the transaction in two: the receiver
   * writing to one half, every read tool looking at the other.
   */
  subscriberUrl: string;
  /** The endpoint this transaction belongs to, for the id index. */
  scope: ExpectationScope;
  autoAdvance?: boolean;
}

export interface ArmExpectationInput {
  sessionId: string;
  flowId: string;
  transactionId?: string;
  expectedAction: string;
  subscriberUrl: string;
  autoAdvance: boolean;
}

export interface ConsumeExpectationCriteria {
  action: string;
  transactionId: string;
  /** The URI the arriving payload advertised — a hint, not a key. */
  subscriberUrl: string;
}

export interface AppendApiEntryInput {
  transactionId: string;
  subscriberUrl: string;
  action: string;
  messageId: string;
  direction: Direction;
  /** `context.timestamp` from the payload — replay orders on this. */
  timestamp: string;
  body: unknown;
  /** The ACK/NACK exchanged for this call. */
  ackBody?: unknown;
  httpStatus?: number;
  /** Event kind to publish. Defaults from `direction`. */
  eventKind?: TransactionEventKind;
  /**
   * Mark the entry as still in flight, to be completed by `settleApiEntry`.
   *
   * The outbound path only. See `ApiEntry.sendState` for why an outbound call is
   * recorded before it is answered rather than after.
   */
  sendState?: "in_flight";
  /**
   * Paths patched by `payload_overrides` before this payload went out.
   *
   * See `ApiEntry.overrides`: a patched step is not a clean step, and the
   * record is the only place a compliance report can learn that.
   */
  overrides?: string[];
  /**
   * Skip the `TransactionEvent` notification.
   *
   * Phase one of a two-phase outbound append sets this so `settleApiEntry`
   * publishes exactly once, when the ACK is actually known. Without it a
   * `flow_await` parked during auto-advance would wake on our own unanswered
   * call and report an exchange that had not happened yet.
   */
  silent?: boolean;
}

/** Completing an entry appended with `sendState: "in_flight"`. */
export interface SettleApiEntryInput {
  transactionId: string;
  subscriberUrl: string;
  /** The `seq` `appendApiEntry` handed back. */
  seq: number;
  /** The `payloadId` `appendApiEntry` handed back. */
  payloadId: string;
  ackBody?: unknown;
  httpStatus?: number;
  /** Set when the send threw after the request had already crossed. */
  sendState?: "failed";
  sendError?: string;
  eventKind?: TransactionEventKind;
}

export interface AppendFormEntryInput {
  transactionId: string;
  subscriberUrl: string;
  formId: string;
  formType: FormEntry["formType"];
  submissionId?: string;
  error?: string;
}

export interface AppendResult {
  record: TransactionRecord;
  seq: number;
  payloadId?: string;
}

/** One journal entry, before the service stamps its `seq` and `at`. */
export type JournalEntry = Omit<SessionEvent, "seq" | "at"> & {
  at?: string;
};

export class RecordService {
  readonly #repository: RecordRepository;
  readonly #events: TransactionEvents;
  readonly #mockEngine: MockEngine;
  readonly #expectationTtl: number;
  readonly #logger: Logger;
  /**
   * Serialises read-modify-write on one expectation bucket.
   *
   * `arm` runs on the MCP tool path and `consume` on the HTTP receiver path, so
   * they are genuinely concurrent in one process; the `await` between load and
   * save is enough for a callback landing mid-arm to resurrect an entry that was
   * just consumed. An instance field, not module state — this service is a
   * container singleton.
   *
   * Single-process only. Against a shared Redis this has to become `WATCH`/
   * `MULTI` or a Lua script.
   */
  readonly #expectationLocks = new Map<string, Promise<unknown>>();

  /**
   * Serialises read-modify-write on one transaction record.
   *
   * Same shape and same caveat as `#expectationLocks`, for the same reason on a
   * different key. `saveTransaction` is a load-modify-save over the whole
   * record, and the two paths that do it are genuinely concurrent: the HTTP
   * receiver appends an inbound call while `FlowService#dispatch` is appending
   * or settling an outbound one. The `await` between load and save is enough for
   * either to overwrite an `apiList` the other had just extended — which loses
   * an exchange outright, and an exchange this server never saw is a compliance
   * finding it cannot make.
   *
   * The two-phase outbound append made that window materially likelier: there
   * are now two writes on the outbound path, and the second lands exactly when
   * the participant's callback is most likely to arrive.
   *
   * Single-process only. Two servers sharing a Redis still race, and closing
   * that needs a compare-and-set on `CacheStore` — or `apiList` moved out of the
   * record onto its own atomic `listAppend` key, which is the better answer and
   * a bigger change than this one.
   */
  readonly #recordLocks = new Map<string, Promise<unknown>>();

  readonly #observer: SessionEventObserver | undefined;

  constructor(options: RecordServiceOptions) {
    this.#repository = options.repository;
    this.#events = options.events;
    this.#mockEngine = options.mockEngine;
    this.#expectationTtl = options.expectationTtlMs;
    this.#logger = options.logger;
    this.#observer = options.observer;
  }

  /* ----------------------------- transactions ----------------------------- */

  async createTransaction(
    input: CreateTransactionInput,
    now: Date = new Date(),
  ): Promise<TransactionRecord> {
    const record = emptyTransactionRecord(input, now);

    await this.#repository.saveTransaction(record);
    await this.#repository.indexTransaction(
      input.sessionId,
      input.transactionId,
    );
    await this.#repository.addTransactionLocation({
      transactionId: input.transactionId,
      sessionId: input.sessionId,
      subscriberUrl: input.subscriberUrl,
      domain: input.scope.domain,
      version: input.scope.version,
      role: input.scope.role,
      createdAt: now.toISOString(),
    });
    return record;
  }

  /** Where a transaction lives, by id alone. Newest last. */
  findTransactionLocations(
    transactionId: string,
  ): Promise<TransactionLocation[]> {
    return this.#repository.findTransactionLocations(transactionId);
  }

  findTransaction(
    transactionId: string,
    subscriberUrl: string,
  ): Promise<TransactionRecord | undefined> {
    return this.#repository.findTransaction(transactionId, subscriberUrl);
  }

  /**
   * @throws {NotFoundError} on the tool channel — the model can start a new
   * flow rather than being told the transport failed.
   */
  async requireTransaction(
    transactionId: string,
    subscriberUrl: string,
  ): Promise<TransactionRecord> {
    const record = await this.#repository.findTransaction(
      transactionId,
      subscriberUrl,
    );
    if (!record) {
      throw new NotFoundError("transaction", transactionId, {
        subscriber_url: subscriberUrl,
        hint: "Transactions expire after 48h. Call flow_start to begin a new one.",
      });
    }
    return record;
  }

  listTransactionIds(sessionId: string): Promise<string[]> {
    return this.#repository.listTransactionIds(sessionId);
  }

  /* ------------------------------- appending ------------------------------ */

  /**
   * Record one protocol call, in both directions.
   *
   * The body goes to its own key and only its handle stays on the record. A
   * flow accumulates a dozen exchanges and an `on_search` catalog alone can run
   * to hundreds of kilobytes — inlining them would make every status read
   * deserialise the whole transaction.
   */
  appendApiEntry(
    input: AppendApiEntryInput,
  ): Promise<AppendResult & { payloadId: string }> {
    return this.#withRecordLock(
      input.transactionId,
      input.subscriberUrl,
      async () => {
        const record = await this.requireTransaction(
          input.transactionId,
          input.subscriberUrl,
        );

        const seq = record.seq + 1;
        const payloadId = randomUUID();

        const payload: PayloadRecord = {
          payloadId,
          transactionId: input.transactionId,
          subscriberUrl: input.subscriberUrl,
          direction: input.direction,
          action: input.action,
          messageId: input.messageId,
          timestamp: input.timestamp,
          body: input.body,
          ...(input.ackBody !== undefined ? { ackBody: input.ackBody } : {}),
          ...(input.httpStatus !== undefined
            ? { httpStatus: input.httpStatus }
            : {}),
        };
        await this.#repository.savePayload(payload);

        const entry: ApiEntry = {
          entryType: "API",
          action: input.action,
          payloadId,
          messageId: input.messageId,
          response: input.ackBody,
          timestamp: input.timestamp,
          seq,
          direction: input.direction,
          ...(input.sendState !== undefined
            ? { sendState: input.sendState }
            : {}),
          ...(input.overrides !== undefined && input.overrides.length > 0
            ? { overrides: input.overrides }
            : {}),
        };

        const updated: TransactionRecord = {
          ...record,
          apiList: [...record.apiList, entry],
          latestAction: input.action,
          latestTimestamp: input.timestamp,
          messageIds: record.messageIds.includes(input.messageId)
            ? record.messageIds
            : [...record.messageIds, input.messageId],
          seq,
        };
        await this.#repository.saveTransaction(updated);

        if (input.silent !== true) {
          this.#publish(updated, {
            seq,
            kind:
              input.eventKind ??
              (input.direction === "inbound" ? "INBOUND" : "OUTBOUND"),
            action: input.action,
            payload_id: payloadId,
          });
        }

        return { record: updated, seq, payloadId };
      },
    );
  }

  /**
   * Complete an entry that was appended before its answer was known.
   *
   * Phase two of the outbound append: fold the ACK/NACK onto both the slim entry
   * and the stored payload, then publish the notification phase one suppressed.
   *
   * The record is **re-loaded inside the lock**, never patched from a copy the
   * caller captured before the send. A callback can, and routinely does, land
   * mid-flight; writing back a record read before it arrived would erase it.
   *
   * A `seq` that no longer resolves is logged and ignored rather than thrown:
   * the only ways to get here are a transaction that expired mid-send or an
   * entry `flow_restart` swept, and failing the send afterwards would report a
   * delivered call as a transport error.
   */
  settleApiEntry(
    input: SettleApiEntryInput,
  ): Promise<TransactionRecord | undefined> {
    return this.#withRecordLock(
      input.transactionId,
      input.subscriberUrl,
      async () => {
        const record = await this.#repository.findTransaction(
          input.transactionId,
          input.subscriberUrl,
        );
        const entry = record?.apiList.find(
          (candidate) =>
            candidate.seq === input.seq && candidate.entryType === "API",
        );

        if (!record || entry?.entryType !== "API") {
          this.#logger.warn(
            {
              transactionId: input.transactionId,
              seq: input.seq,
            },
            "could not settle an in-flight entry; it is no longer on the record",
          );
          return undefined;
        }

        const settled: ApiEntry = {
          ...entry,
          response: input.ackBody,
          ...(input.sendState !== undefined
            ? { sendState: input.sendState }
            : { sendState: undefined }),
          ...(input.sendError !== undefined
            ? { sendError: input.sendError }
            : {}),
        };

        const updated: TransactionRecord = {
          ...record,
          apiList: record.apiList.map((candidate) =>
            candidate.seq === input.seq ? settled : candidate,
          ),
        };
        await this.#repository.saveTransaction(updated);

        // The body was stored in phase one; only its answer is new.
        const payload = await this.#repository.findPayload(input.payloadId);
        if (payload) {
          await this.#repository.savePayload({
            ...payload,
            ...(input.ackBody !== undefined ? { ackBody: input.ackBody } : {}),
            ...(input.httpStatus !== undefined
              ? { httpStatus: input.httpStatus }
              : {}),
          });
        }

        this.#publish(updated, {
          seq: input.seq,
          kind: input.eventKind ?? "OUTBOUND",
          action: entry.action,
          payload_id: input.payloadId,
        });

        return updated;
      },
    );
  }

  /**
   * Undo an in-flight entry for a call that provably never left.
   *
   * Only for a send that failed at the connection — refused, DNS, TLS — where
   * nothing crossed the wire and the step is genuinely still owed. Anything that
   * failed *after* the request was written is settled as `failed` instead, so a
   * call that may have been delivered is never silently re-sent.
   *
   * **`record.seq` is deliberately left where it is.** It is a high-water mark,
   * not a count: `flow_await` hands it back as a cursor, so reissuing a number
   * would rewind waiters onto entries they had already been shown. The gap costs
   * nothing.
   */
  discardApiEntry(input: {
    transactionId: string;
    subscriberUrl: string;
    seq: number;
    payloadId: string;
  }): Promise<void> {
    return this.#withRecordLock(
      input.transactionId,
      input.subscriberUrl,
      async () => {
        const record = await this.#repository.findTransaction(
          input.transactionId,
          input.subscriberUrl,
        );
        if (!record) return;

        const apiList = record.apiList.filter(
          (entry) => entry.seq !== input.seq,
        );
        if (apiList.length === record.apiList.length) return;

        // Rebuilt from what survives rather than remembered from before the
        // append: another exchange may have landed in between, and it is that
        // one — not the pre-append state — that is now the latest.
        const tail = apiList[apiList.length - 1];
        const messageIds = apiList.flatMap((entry) =>
          entry.entryType === "API" ? [entry.messageId] : [],
        );

        await this.#repository.saveTransaction({
          ...record,
          apiList,
          latestAction:
            tail === undefined
              ? ""
              : tail.entryType === "API"
                ? tail.action
                : tail.formType,
          latestTimestamp: tail?.timestamp ?? record.createdAt,
          messageIds: record.messageIds.filter(
            (id) => messageIds.includes(id) || id === record.transactionId,
          ),
        });

        await this.#repository.deletePayload(input.payloadId);
      },
    );
  }

  /** Record a form submission. Forms carry no protocol payload. */
  appendFormEntry(input: AppendFormEntryInput): Promise<AppendResult> {
    return this.#withRecordLock(
      input.transactionId,
      input.subscriberUrl,
      async () => {
        const record = await this.requireTransaction(
          input.transactionId,
          input.subscriberUrl,
        );

        const seq = record.seq + 1;
        const timestamp = new Date().toISOString();

        const entry: FormEntry = {
          entryType: "FORM",
          formType: input.formType,
          formId: input.formId,
          ...(input.submissionId !== undefined
            ? { submissionId: input.submissionId }
            : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
          timestamp,
          seq,
        };

        const updated: TransactionRecord = {
          ...record,
          apiList: [...record.apiList, entry],
          latestAction: input.formType,
          latestTimestamp: timestamp,
          seq,
        };
        await this.#repository.saveTransaction(updated);

        this.#publish(updated, {
          seq,
          kind: "FORM_SUBMITTED",
          action: input.formId,
          ...(input.error !== undefined ? { detail: input.error } : {}),
        });

        return { record: updated, seq };
      },
    );
  }

  /**
   * Note why the loop stopped, so the reason outlives the call that produced it.
   *
   * Auto-advance runs after the ACK has already gone out — there is nobody left
   * to return to. Without this the model's next `flow_get_status` would show a
   * stalled flow and no explanation.
   */
  setAttention(
    transactionId: string,
    subscriberUrl: string,
    attention: Attention | undefined,
  ): Promise<void> {
    return this.#withRecordLock(transactionId, subscriberUrl, async () => {
      const record = await this.requireTransaction(
        transactionId,
        subscriberUrl,
      );
      const updated: TransactionRecord =
        attention === undefined
          ? { ...record, attention: undefined }
          : { ...record, attention };
      await this.#repository.saveTransaction(updated);
    });
  }

  /**
   * Write an attempt off, without deleting any of it.
   *
   * Called by `flow_restart`. Everything the attempt recorded — its entries,
   * its payloads, its business data — stays exactly where it was and stays
   * readable; only the record's status changes. Erasing a failed attempt would
   * erase the findings this server exists to produce.
   *
   * The seal is what stops the abandoned attempt being *advanced*: its id
   * remains resolvable through `txn_index` so late traffic can still be filed
   * against it, and without a mark on the record, `flow_proceed` on that id
   * would happily put new payloads on a third party's wire.
   */
  abandonTransaction(
    transactionId: string,
    subscriberUrl: string,
    seal: Abandoned,
  ): Promise<TransactionRecord> {
    return this.#withRecordLock(transactionId, subscriberUrl, async () => {
      const record = await this.requireTransaction(
        transactionId,
        subscriberUrl,
      );
      const updated: TransactionRecord = { ...record, abandoned: seal };
      await this.#repository.saveTransaction(updated);
      return updated;
    });
  }

  /** Publish an event that carries no new entry — a chain pause, say. */
  publishEvent(
    record: TransactionRecord,
    event: Omit<TransactionEvent, "seq">,
  ): void {
    this.#publish(record, { ...event, seq: record.seq });
  }

  /**
   * Wake both audiences: waiters on this transaction, and waiters on the flow
   * run that owns it.
   *
   * The second key is not redundant. A run whose first action is the
   * participant's has no `transaction_id` until their call lands, so a
   * `flow_await` issued before that can only have parked on
   * `flow_run::{session}::{flow}`. The very event that binds the run — the
   * inbound call — is published from a record that already knows both, so
   * notifying both keys is what lets that waiter wake at all. Notifying only
   * the transaction key would leave it parked until its timeout on an id that
   * did not exist when it parked.
   */
  #publish(record: TransactionRecord, event: TransactionEvent): void {
    this.#events.notify(
      transactionKey(record.transactionId, record.subscriberUrl),
      event,
    );
    this.#events.notify(flowRunKey(record.sessionId, record.flowId), event);
  }

  /* ------------------------------- journal -------------------------------- */

  /**
   * Write one line to the session's journal, and wake anyone watching it.
   *
   * ## This never throws, and that is load-bearing
   *
   * Every caller is on a path where failing is worse than forgetting. The
   * receiver journals *after* the ACK has been decided — a store blip there
   * would turn our outage into a 500 the participant records as our
   * non-compliance. `chainNext` journals with nobody left to return to. So a
   * failure is logged and swallowed, in the same spirit as
   * `TransactionEvents.notify`, which also cannot be allowed to fail a
   * response.
   *
   * The trade is honest and worth stating: an entry can be lost. Nothing is
   * *derived* from the journal — the transaction record remains the truth, and
   * `flow_get_status` recomputes state from it — so a lost line costs the model
   * a notification, never a correct answer.
   *
   * ## Two notifications, two seq spaces
   *
   * The wake-up goes to `journalKey(sessionId)`, carrying the **journal's**
   * seq. Per-transaction and per-run notifications are untouched and keep
   * carrying the transaction's. They are different counters on different keys
   * and must never be compared; a session waiter tests its delivery cursor, a
   * run waiter tests `after_seq`.
   */
  async journal(
    sessionId: string,
    entry: JournalEntry,
    diagnostics?: SessionEventDiagnostics,
  ): Promise<void> {
    let event: SessionEvent | undefined;

    try {
      const seq = await this.#repository.nextJournalSeq(sessionId);
      event = {
        ...entry,
        seq,
        at: entry.at ?? new Date().toISOString(),
      };

      // Durable before the wake-up, exactly as `appendApiEntry` orders it: a
      // waiter told about work it then fails to find would drain an empty delta
      // and park again, missing the very thing it was woken for.
      await this.#repository.appendJournal(sessionId, event);
      this.#events.notify(journalKey(sessionId), { seq, kind: "JOURNAL" });
    } catch (error) {
      this.#logger.warn(
        { err: error, sessionId, kind: entry.kind },
        "could not journal a session event; the record itself is unaffected",
      );
    }

    // Outside the try, and after it, on purpose. A failed append still happened
    // as far as the *corpus* is concerned — the thing it describes went wrong
    // whether or not we managed to write a line about it — and an observer that
    // only ever hears about successful writes would go quietest exactly when
    // the store is in trouble.
    this.#notifyObserver(
      sessionId,
      event ?? { ...entry, seq: 0, at: entry.at ?? new Date().toISOString() },
      diagnostics,
    );
  }

  /**
   * Hand the line to the observer, absorbing anything it does wrong.
   *
   * Same contract as `journal` itself, one level down: this runs after the ACK
   * is decided, so an observer that throws must not become a 500 the
   * participant records as our non-compliance.
   */
  #notifyObserver(
    sessionId: string,
    event: SessionEvent,
    diagnostics: SessionEventDiagnostics | undefined,
  ): void {
    if (this.#observer === undefined) return;
    try {
      this.#observer.onSessionEvent(sessionId, event, diagnostics);
    } catch (error) {
      this.#logger.warn(
        { err: error, sessionId, kind: event.kind },
        "a session event observer threw; the journal itself is unaffected",
      );
    }
  }

  /**
   * Everything the model has not been told yet, and mark it told.
   *
   * The cursor advances past exactly what is returned — never past what is
   * withheld for the cap — so a burst is throttled across several tool calls
   * rather than silently discarded. `more` is what tells the model there is a
   * rest to ask for.
   *
   * Returns `undefined` when there is nothing, so an idle drain adds no key to
   * the tool result at all rather than an empty object the model has to read
   * past on every single call.
   */
  async drainEvents(sessionId: string): Promise<EventsDelta | undefined> {
    try {
      const cursor = await this.#repository.getEventCursor(sessionId);
      const pending = await this.#repository.journalSince(sessionId, cursor);
      if (pending.length === 0) return undefined;

      const events = pending.slice(0, EVENTS_DELTA_LIMIT);
      const last = events[events.length - 1];
      // `pending` is non-empty and the cap is positive, so this cannot be
      // undefined; the guard is for the compiler, not for a real case.
      if (last === undefined) return undefined;

      await this.#repository.setEventCursor(sessionId, last.seq);

      return {
        events,
        more: pending.length - events.length,
        cursor: last.seq,
      };
    } catch (error) {
      // A drain rides on someone else's tool call. Failing it would turn a
      // journal problem into a failed `flow_proceed`, which is precisely the
      // inversion this whole mechanism exists to avoid.
      this.#logger.warn(
        { err: error, sessionId },
        "could not drain session events; the tool result carries none",
      );
      return undefined;
    }
  }

  /**
   * Read the journal **without** consuming it.
   *
   * The escape hatch behind `record_get_events`: a drained delta lost to a
   * client-side error is otherwise unrecoverable, because the cursor has
   * already moved past it. Deliberately cursor-neutral — a tool that both
   * re-reads and consumes could not be used to recover from itself.
   */
  readEvents(sessionId: string, afterSeq = 0): Promise<SessionEvent[]> {
    return this.#repository.journalSince(sessionId, afterSeq);
  }

  /** How much of the journal has already been delivered. */
  eventCursor(sessionId: string): Promise<number> {
    return this.#repository.getEventCursor(sessionId);
  }

  /**
   * True for exactly one caller. Used to journal a transition once, from
   * whichever path happens to observe it first.
   */
  claimFirst(name: string): Promise<boolean> {
    return this.#repository.claimFirst(name);
  }

  /* ---------------------------- business data ----------------------------- */

  getBusinessData(
    transactionId: string,
    subscriberUrl: string,
  ): Promise<Record<string, unknown>> {
    return this.#repository.getBusinessData(transactionId, subscriberUrl);
  }

  /** Replace business data wholesale. Used when the receiver resolves a form. */
  overwriteBusinessData(
    transactionId: string,
    subscriberUrl: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    return this.#repository.saveBusinessData(
      transactionId,
      subscriberUrl,
      data,
    );
  }

  /**
   * Fold a payload into the transaction's business data, per the step's
   * `saveData` config.
   *
   * Ported from the workbench (`workbench-cache.ts:getUpdatedData`) including
   * its quirks, because the config JavaScript is written against exactly these:
   *
   * - **Five context paths are injected on every save.** `latestMessage_id`,
   *   `bapUri`, `bppUri`, `bppId`, `bapId` are how a response step learns which
   *   message it is answering and whom to address. Configs assume they are
   *   there; a config that also declares one simply overrides it.
   * - **`APPEND#key` concatenates** instead of replacing — for the steps that
   *   repeat, where each occurrence adds to a list.
   * - **`EVAL#<base64>` runs code** in the sandbox instead of a JSONPath, for
   *   the saves a path cannot express.
   * - **Values are arrays.** `jsonpath.query` always returns a list, so
   *   `providerId` is `["p1"]`, not `"p1"`. Every config unwraps accordingly.
   * - **A failing key is skipped, not fatal.** One unsatisfiable path must not
   *   cost the whole step its saved data.
   */
  async saveBusinessData(
    transactionId: string,
    subscriberUrl: string,
    payload: unknown,
    saveDataConfig: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const data = await this.#repository.getBusinessData(
      transactionId,
      subscriberUrl,
    );

    const config: Record<string, string> = {
      ...saveDataConfig,
      latestMessage_id: "$.context.message_id",
      bapUri: "$.context.bap_uri",
      bppUri: "$.context.bpp_uri",
      bppId: "$.context.bpp_id",
      bapId: "$.context.bap_id",
    };

    for (const [key, path] of Object.entries(config)) {
      try {
        if (typeof path !== "string" || path.length === 0) continue;

        const appendMode = key.startsWith("APPEND#");
        const evalMode = path.startsWith("EVAL#");
        // `APPEND#providerId` saves under `providerId`.
        const actualKey = key.split("#").pop() ?? key;
        const actualPath = evalMode ? (path.split("#")[1] ?? "") : path;

        // `jsonpath.query` is typed `any[]`; keep it at arm's length.
        const result: unknown = evalMode
          ? (await this.#mockEngine.runGetSave(payload, actualPath)).result
          : (jsonpath.query(payload, actualPath) as unknown[]);

        if (appendMode) {
          const current = Array.isArray(data[actualKey])
            ? (data[actualKey] as unknown[])
            : [];
          const incoming: unknown[] = Array.isArray(result)
            ? (result as unknown[])
            : [result];
          data[actualKey] = [...current, ...incoming];
        } else {
          data[actualKey] = result;
        }
      } catch (error) {
        this.#logger.warn(
          { transactionId, key, path, err: error },
          "skipped a save-data key",
        );
      }
    }

    await this.#repository.saveBusinessData(transactionId, subscriberUrl, data);
    return data;
  }

  /* ---------------------------- step lifecycle ---------------------------- */

  /**
   * The per-step concurrency guard. An absent or expired marker reads as
   * `AVAILABLE`, so a dispatch that died mid-flight unblocks itself.
   */
  getFlowStatus(
    transactionId: string,
    subscriberUrl: string,
    stepKey?: string,
  ): Promise<FlowStatusCode> {
    return this.#repository.getFlowStatus(
      transactionId,
      subscriberUrl,
      stepKey,
    );
  }

  setFlowStatus(
    transactionId: string,
    subscriberUrl: string,
    status: FlowStatusCode,
    stepKey?: string,
  ): Promise<void> {
    return this.#repository.setFlowStatus(
      transactionId,
      subscriberUrl,
      status,
      stepKey,
    );
  }

  getExtraFlowStatuses(
    transactionId: string,
    subscriberUrl: string,
    stepKeys: readonly string[],
  ): Promise<Map<string, FlowStatusCode>> {
    return this.#repository.getExtraFlowStatuses(
      transactionId,
      subscriberUrl,
      stepKeys,
    );
  }

  /* ----------------------------- expectations ----------------------------- */

  /**
   * Stand up a promise that a call is imminent on this endpoint.
   *
   * **Upserts** on `(sessionId, expectedAction)` rather than appending: this
   * fires from the `listen` branch of every `proceed`, and auto-advance chaining
   * calls `proceed` up to twenty times in a row. Appending would grow the bucket
   * without bound and leave stale entries to catch unrelated calls.
   */
  armExpectation(
    scope: ExpectationScope,
    input: ArmExpectationInput,
    now: Date = new Date(),
  ): Promise<void> {
    return this.#withExpectationLock(scope, async () => {
      const live = pruneExpired(
        await this.#repository.loadExpectations(scope),
        now,
      );
      const entry: Expectation = {
        sessionId: input.sessionId,
        flowId: input.flowId,
        ...(input.transactionId !== undefined
          ? { transactionId: input.transactionId }
          : {}),
        expectedAction: input.expectedAction,
        subscriberUrl: input.subscriberUrl,
        autoAdvance: input.autoAdvance,
        expireAt: new Date(now.getTime() + this.#expectationTtl).toISOString(),
        armedAt: now.toISOString(),
      };
      const others = live.filter(
        (candidate) =>
          !(
            candidate.sessionId === entry.sessionId &&
            candidate.expectedAction === entry.expectedAction
          ),
      );

      const clash = others.filter(
        (candidate) => candidate.expectedAction === entry.expectedAction,
      );
      if (clash.length > 0) {
        this.#logger.warn(
          {
            scope,
            action: entry.expectedAction,
            sessionId: entry.sessionId,
            alsoArmed: clash.map((candidate) => candidate.sessionId),
          },
          "another session is already armed for this action on this endpoint",
        );
      }

      await this.#repository.saveExpectations(scope, [...others, entry]);
    });
  }

  /**
   * Take the expectation this call satisfies, if any, and remove it.
   *
   * The wire cannot always separate two sessions armed on the same endpoint for
   * the same action — same advertised URI, same `bap_id`. So candidates are
   * ranked rather than taken first-come, strongest signal first:
   *
   * 1. the call quotes a `transaction_id` we already opened;
   * 2. it advertises the URL the session registered;
   * 3. it at least shares that URL's host;
   * 4. nothing to go on — oldest armed wins, as the workbench does.
   *
   * Expired entries are dropped in the same pass, which is also the workbench's
   * behaviour and keeps the bucket from accumulating dead promises.
   */
  consumeExpectation(
    scope: ExpectationScope,
    criteria: ConsumeExpectationCriteria,
    now: Date = new Date(),
  ): Promise<Expectation | undefined> {
    return this.#withExpectationLock(scope, async () => {
      const stored = await this.#repository.loadExpectations(scope);
      const live = pruneExpired(stored, now);
      const candidates = live.filter(
        (entry) => entry.expectedAction === criteria.action,
      );

      const winner = rankExpectations(candidates, criteria)[0];
      const remaining = winner
        ? live.filter((entry) => entry !== winner)
        : live;

      // A no-match pass still writes back when the prune dropped something.
      if (remaining.length !== stored.length) {
        await this.#repository.saveExpectations(scope, remaining);
      }
      return winner;
    });
  }

  /** Everything armed for one session on this endpoint. */
  async expectationsForSession(
    scope: ExpectationScope,
    sessionId: string,
    now: Date = new Date(),
  ): Promise<Expectation[]> {
    const live = pruneExpired(
      await this.#repository.loadExpectations(scope),
      now,
    );
    return live.filter((entry) => entry.sessionId === sessionId);
  }

  clearExpectationsForSession(
    scope: ExpectationScope,
    sessionId: string,
    now: Date = new Date(),
  ): Promise<void> {
    return this.#withExpectationLock(scope, async () => {
      const live = pruneExpired(
        await this.#repository.loadExpectations(scope),
        now,
      );
      await this.#repository.saveExpectations(
        scope,
        live.filter((entry) => entry.sessionId !== sessionId),
      );
    });
  }

  /**
   * Disarm one **run**, leaving the session's other flows listening.
   *
   * `flow_restart` needs this granularity and the session-wide version cannot
   * provide it: a session may have several flows in flight, and taking down a
   * sibling's expectation would leave it waiting for a callback this endpoint
   * has quietly stopped accepting — a 412 the model has no way to explain.
   *
   * Restart needs it for a second reason too. An entry armed for the abandoned
   * attempt carries that attempt's `transactionId`, so leaving it would meet
   * the *new* attempt's first legitimate callback with `TRANSACTION_MISMATCH`.
   */
  clearExpectationsForFlow(
    scope: ExpectationScope,
    sessionId: string,
    flowId: string,
    now: Date = new Date(),
  ): Promise<void> {
    return this.#withExpectationLock(scope, async () => {
      const live = pruneExpired(
        await this.#repository.loadExpectations(scope),
        now,
      );
      await this.#repository.saveExpectations(
        scope,
        live.filter(
          (entry) =>
            !(entry.sessionId === sessionId && entry.flowId === flowId),
        ),
      );
    });
  }

  /** Chain onto whatever is already touching this bucket. */
  #withExpectationLock<T>(
    scope: ExpectationScope,
    work: () => Promise<T>,
  ): Promise<T> {
    return withKeyLock(this.#expectationLocks, expectationKey(scope), work);
  }

  /** Chain onto whatever is already writing this transaction record. */
  #withRecordLock<T>(
    transactionId: string,
    subscriberUrl: string,
    work: () => Promise<T>,
  ): Promise<T> {
    return withKeyLock(
      this.#recordLocks,
      transactionKey(transactionId, subscriberUrl),
      work,
    );
  }

  /* ------------------------------- payloads ------------------------------- */

  /**
   * Store a payload without appending it to the transaction.
   *
   * The dry-run path: the model gets a handle it can inspect, and the flow does
   * not move — a drafted payload was never on the wire and must not read as if
   * it had been.
   */
  async storePayload(
    payload: Omit<PayloadRecord, "payloadId">,
  ): Promise<string> {
    const payloadId = randomUUID();
    await this.#repository.savePayload({ ...payload, payloadId });
    return payloadId;
  }

  async requirePayload(payloadId: string): Promise<PayloadRecord> {
    const payload = await this.#repository.findPayload(payloadId);
    if (!payload) {
      throw new NotFoundError("payload", payloadId, {
        hint: "Payload handles come from flow_get_status and flow_await, and expire with the transaction.",
      });
    }
    return payload;
  }
}

/**
 * Serialise `work` against everything else queued on `key`.
 *
 * The in-process mutual exclusion behind both `#expectationLocks` and
 * `#recordLocks`. A rejected predecessor must not cancel its successors, hence
 * `then(work, work)` — the queue is about ordering, not about outcomes.
 *
 * Not a distributed lock. Two processes against one Redis still race; this only
 * closes the window inside a single server, which is where the MCP tool path and
 * the HTTP receiver path genuinely run concurrently.
 */
async function withKeyLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.then(work, work);
  locks.set(
    key,
    current.catch(() => undefined),
  );
  try {
    return await current;
  } finally {
    // Only the tail clears the slot, or a queued caller loses its predecessor.
    if (locks.get(key) === current) locks.delete(key);
  }
}

/**
 * Read a business-data value that may or may not have come from a JSONPath.
 *
 * `jsonpath.query` always returns a list, so a save of `$.context.bap_uri`
 * stores `["https://…"]`, while a value written directly — a form submission
 * id, a page resolved by the receiver — is a bare string. Every reader has to
 * cope with both, and naming it once beats three subtly different inline
 * versions of the same unwrapping.
 */
export function unwrapSaved(value: unknown): unknown {
  return Array.isArray(value) ? (value as unknown[])[0] : value;
}

/**
 * A transaction with nothing in it yet.
 *
 * Pure, and exported, because it has **two** callers that must not drift.
 * `createTransaction` persists what it returns; `FlowService` builds the same
 * shape *without* persisting it, for a flow run that has been started but whose
 * `transaction_id` does not exist yet — the flow's first action has not crossed
 * the wire, so there is nothing to file and nobody has minted an id. The engine
 * maps that record exactly as it maps a real one (an empty `apiList` puts the
 * cursor at step 0), which is what lets `flow_get_status` and `flow_await`
 * answer for a run that is not yet bound.
 *
 * `transactionId` is therefore provisional in the unpersisted case: correct once
 * bound, and never written anywhere before then.
 */
export function emptyTransactionRecord(
  input: CreateTransactionInput,
  now: Date = new Date(),
): TransactionRecord {
  return {
    transactionId: input.transactionId,
    sessionId: input.sessionId,
    flowId: input.flowId,
    subscriberType: input.subscriberType,
    subscriberUrl: input.subscriberUrl,
    latestAction: "",
    latestTimestamp: now.toISOString(),
    messageIds: [],
    apiList: [],
    seq: 0,
    createdAt: now.toISOString(),
    autoAdvance: input.autoAdvance ?? false,
  };
}

/** Drop expectations whose window has closed. */
export function pruneExpired(
  expectations: readonly Expectation[],
  now: Date,
): Expectation[] {
  return expectations.filter((entry) => new Date(entry.expireAt) >= now);
}

/**
 * Candidates for one inbound call, best first.
 *
 * Ties inside a tier break on `armedAt`, oldest first — the workbench's
 * first-in-the-list rule, made explicit so the outcome does not depend on
 * insertion order surviving a JSON round trip.
 */
export function rankExpectations(
  candidates: readonly Expectation[],
  criteria: ConsumeExpectationCriteria,
): Expectation[] {
  const advertised = normaliseSubscriberUrl(criteria.subscriberUrl);
  const advertisedHost = hostOfUrl(advertised);

  const tierOf = (entry: Expectation): number => {
    if (
      entry.transactionId !== undefined &&
      entry.transactionId === criteria.transactionId
    ) {
      return 0;
    }
    const registered = normaliseSubscriberUrl(entry.subscriberUrl);
    if (registered === advertised) return 1;
    if (
      advertisedHost !== undefined &&
      hostOfUrl(registered) === advertisedHost
    )
      return 2;
    return 3;
  };

  return [...candidates].sort((a, b) => {
    const byTier = tierOf(a) - tierOf(b);
    if (byTier !== 0) return byTier;
    return a.armedAt.localeCompare(b.armedAt);
  });
}

function hostOfUrl(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}
