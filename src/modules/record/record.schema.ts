import { z } from "zod";
import { NpType, ReceiverRole } from "@/modules/catalog/catalog.schema.js";

/**
 * What actually happened on the wire, and what the flow learned from it.
 *
 * ## Two stores, on purpose
 *
 * A transaction record holds the **sequence of exchanges** — slim entries, one
 * per call, enough for the engine to replay a flow's state. Business data holds
 * the **values carried between steps** — the provider id from `on_search` that
 * `select` has to quote back.
 *
 * They are separate because they are read at different times by different
 * things: the record is replayed on every status read, the business data is fed
 * to the config's `generate` function. Merging them would mean loading a
 * payload's worth of catalog every time the model asks "where am I".
 *
 * ## Bodies live out of line
 *
 * An entry carries a `payload_id`, not a payload. A real `on_search` catalog
 * runs to hundreds of kilobytes; a flow accumulates a dozen of them; and every
 * status read would otherwise deserialise the lot. The bodies are stored under
 * their own keys and fetched only when something actually wants one — which is
 * also what lets `record_get_payload` slice and cap what reaches the model.
 *
 * Key shapes are the workbench's, kept literally (`{txn}::{sub}`,
 * `MOCK_DATA::…`, `FLOW_STATUS_…`) so a shared Redis remains a possibility.
 */

/** Which way a payload crossed the wire. */
export const Direction = z.enum(["outbound", "inbound"]);
export type Direction = z.infer<typeof Direction>;

/** ACK/NACK as the counterparty answered it — or that we could not tell. */
export const AckStatus = z.enum(["ACK", "NACK", "UNPARSEABLE"]);
export type AckStatus = z.infer<typeof AckStatus>;

/* -------------------------------------------------------------------------- */
/* History entries                                                             */
/* -------------------------------------------------------------------------- */

export const ApiEntry = z.object({
  entryType: z.literal("API"),
  action: z.string(),
  payloadId: z.string(),
  messageId: z.string(),
  /** The synchronous ACK/NACK body, verbatim. */
  response: z.unknown(),
  /** `context.timestamp` of the payload — the engine orders replay by this. */
  timestamp: z.string(),
  /**
   * Append order within this transaction, strictly increasing.
   *
   * Two things need it: `flow_await` uses it as a cursor so a caller can ask
   * "anything after 4?", and replay uses it to break timestamp ties, which do
   * happen — a request and its callback can share a millisecond.
   */
  seq: z.number().int(),
  direction: Direction,
  /**
   * Where an **outbound** call has got to. Absent means settled — which is what
   * every inbound entry and every record written before this field existed is.
   *
   * An outbound entry is appended *before* the socket write, not after the
   * counterparty's ACK comes back, because the counterparty is entitled to send
   * its next request before answering ours: the two legs are independent
   * connections and neither ordering is guaranteed. Recording late meant our own
   * sent step was invisible to the receiver for a whole round trip, so a
   * perfectly legal follow-up call matched no pending step and was NACKed
   * `OUT_OF_SEQUENCE`.
   *
   * - `in_flight` — appended, not yet answered. Counts as taken (the flow has to
   *   move on), but carries no `response` yet.
   * - `failed`  — the send threw after the request had crossed, so we cannot
   *   know whether it arrived. Kept rather than deleted so nothing re-sends it
   *   onto a real participant's wire. A send that provably never left
   *   (connection refused, DNS) is discarded instead and leaves no entry.
   */
  sendState: z.enum(["in_flight", "failed"]).optional(),
  /** Why an outbound send failed, when `sendState` is `failed`. */
  sendError: z.string().optional(),
});
export type ApiEntry = z.infer<typeof ApiEntry>;

export const FormEntry = z.object({
  entryType: z.literal("FORM"),
  formType: z.enum(["HTML_FORM", "RES_FORM", "DYNAMIC_FORM"]),
  formId: z.string(),
  submissionId: z.string().optional(),
  timestamp: z.string(),
  error: z.string().optional(),
  seq: z.number().int(),
});
export type FormEntry = z.infer<typeof FormEntry>;

export const HistoryEntry = z.discriminatedUnion("entryType", [
  ApiEntry,
  FormEntry,
]);
export type HistoryEntry = z.infer<typeof HistoryEntry>;

/* -------------------------------------------------------------------------- */
/* The transaction record                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Something the loop paused on and the caller has to resolve.
 *
 * Written when auto-advance stops, so the reason survives between tool calls
 * rather than only existing in the reply that nobody was waiting for.
 */
export const Attention = z.object({
  kind: z.string(),
  message: z.string(),
  step_key: z.string().optional(),
  at: z.string(),
});
export type Attention = z.infer<typeof Attention>;

/**
 * The mark `flow_restart` leaves on the attempt it wrote off.
 *
 * A sealed record is **read-only, not deleted**. This is a compliance server:
 * the payloads a failed attempt exchanged are exactly what the report is made
 * of, so a retry archives them rather than erasing them.
 *
 * The seal is load-bearing, not decorative. `txn_index` still resolves the old
 * `transaction_id` — deliberately, so a late callback is recorded rather than
 * refused at the transport — which leaves the abandoned attempt reachable by id.
 * Without the seal, `flow_proceed` on that id (or auto-advance chaining, which
 * calls it by id) would generate and **send** new payloads for a run that was
 * written off.
 */
export const Abandoned = z.object({
  at: z.string(),
  /** Which attempt of the run this record was. */
  attempt: z.number().int(),
  reason: z.string().optional(),
});
export type Abandoned = z.infer<typeof Abandoned>;

export const TransactionRecord = z.object({
  transactionId: z.string(),
  sessionId: z.string(),
  flowId: z.string(),
  /**
   * The **participant under test's** side — never ours.
   *
   * Named and valued exactly as the workbench does, because the flow engine
   * reads it verbatim: `subscriberType === step.owner` means "the NP owns this
   * step", which is what makes us wait rather than send.
   */
  subscriberType: NpType,
  /** The counterparty's base URL. Half of this record's identity. */
  subscriberUrl: z.string(),
  latestAction: z.string(),
  latestTimestamp: z.string(),
  messageIds: z.array(z.string()),
  apiList: z.array(HistoryEntry),
  /** Highest `seq` handed out so far. */
  seq: z.number().int(),
  createdAt: z.string(),
  attention: Attention.optional(),
  /** Set once `flow_restart` wrote this attempt off. Read-only from then on. */
  abandoned: Abandoned.optional(),
  /** Whether the receiver chains mock-owned steps for this transaction. */
  autoAdvance: z.boolean().default(false),
});
export type TransactionRecord = z.infer<typeof TransactionRecord>;

/** A stored payload body, addressed by `payload_id`. */
export const PayloadRecord = z.object({
  payloadId: z.string(),
  transactionId: z.string(),
  subscriberUrl: z.string(),
  direction: Direction,
  action: z.string(),
  messageId: z.string(),
  timestamp: z.string(),
  body: z.unknown(),
  /** The ACK/NACK exchanged for this call, whichever side produced it. */
  ackBody: z.unknown().optional(),
  httpStatus: z.number().int().optional(),
});
export type PayloadRecord = z.infer<typeof PayloadRecord>;

/**
 * What the receiver is waiting for, before a transaction record exists.
 *
 * A flow whose first step is the participant's (a mock BPP waiting for
 * `search`) has nowhere to file that first inbound call — there is no
 * transaction yet, and its `transaction_id` is the participant's to choose.
 * This is the note that lets the receiver create the record on arrival instead
 * of answering 412.
 */
export const Expectation = z.object({
  sessionId: z.string(),
  flowId: z.string(),
  /**
   * Our transaction, when one already exists. The strongest signal available
   * for telling two sessions armed for the same action apart.
   */
  transactionId: z.string().optional(),
  /** Required: an entry with no action could never be matched against a call. */
  expectedAction: z.string().min(1),
  /**
   * The counterparty URL this session registered.
   *
   * A **tie-break, never a key** — see `expectationKey`. The arriving call
   * advertises its own URI, which is supposed to be this one and often is not.
   */
  subscriberUrl: z.string(),
  autoAdvance: z.boolean().default(false),
  expireAt: z.string(),
  /** Deterministic oldest-first ordering, and a diagnostic when one goes stale. */
  armedAt: z.string(),
});
export type Expectation = z.infer<typeof Expectation>;

/**
 * The endpoint an expectation is bucketed under: `{domain}/{version}/{role}`,
 * which is precisely what the receiver can read off the URL a call arrived on.
 */
export const ExpectationScope = z.object({
  domain: z.string(),
  version: z.string(),
  role: ReceiverRole,
});
export type ExpectationScope = z.infer<typeof ExpectationScope>;

/**
 * Where a transaction lives, addressable by `transaction_id` alone.
 *
 * Records are keyed `{transaction_id}::{subscriber_url}`, but an arriving call
 * only tells us the URI *it* advertises — which is supposed to equal the
 * registered `subscriber_url` and, in the field, frequently does not. Looking
 * the record up under the advertised URI would miss, fall through to the
 * expectation branch, and open a **second** record under a second key: the
 * receiver would then write to one while `flow_get_status`, `flow_await` and
 * `record_get_payload` all read the other, and the flow would stall with
 * nothing in the trace pointing at why.
 *
 * So the id is indexed on its own, and `subscriberUrl` here is always the
 * canonical `session.np.subscriber_url` the record is actually stored under.
 *
 * A list, because the same `transaction_id` against two participants is two
 * different tests; `domain`/`version`/`role` are carried so the receiver can
 * filter by the path a call arrived on without loading a session first.
 */
export const TransactionLocation = z.object({
  transactionId: z.string(),
  sessionId: z.string(),
  subscriberUrl: z.string(),
  domain: z.string(),
  version: z.string(),
  role: ReceiverRole,
  createdAt: z.string(),
});
export type TransactionLocation = z.infer<typeof TransactionLocation>;

/* -------------------------------------------------------------------------- */
/* The session event journal                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a session event can be about.
 *
 * Deliberately **not** the same vocabulary as `TransactionEventKind`. That one
 * answers "did this run move?" for a waiter parked on one transaction; this one
 * answers "what has happened in this session that I have not been told about?"
 * — which includes things no transaction owns: an expectation quietly re-armed,
 * a refusal we could not attribute, a run restarted.
 *
 * Where the two overlap the journal is the more specific of the pair: an
 * inbound call is `INBOUND_ACK` or `INBOUND_NACK`, never a bare `INBOUND`,
 * because the difference is the entire reason the model wants to know.
 */
export const SessionEventKind = z.enum([
  /** An inbound call was accepted and recorded. */
  "INBOUND_ACK",
  /** An inbound call was refused. `nack_code` says why. */
  "INBOUND_NACK",
  /** This mock sent a payload from an explicit `flow_proceed`. */
  "OUTBOUND_SENT",
  /** Auto-advance sent a step with nobody waiting on the answer. */
  "CHAIN_SENT",
  /** Auto-advance stopped, and the summary says what it is waiting for. */
  "CHAIN_PAUSED",
  /** A form was submitted, in either direction. */
  "FORM_SUBMITTED",
  /** A run acquired its transaction id — minted by us, or adopted from them. */
  "TRANSACTION_BOUND",
  /** Every step of a flow is done. */
  "FLOW_COMPLETE",
  /** `flow_restart` sealed an attempt and returned the run to unbound. */
  "FLOW_RESTARTED",
  /** A lapsed expectation was re-armed before a long wait. */
  "EXPECTATION_REARMED",
  /** Something needs the model: a refused body, a chain pause worth reading. */
  "ATTENTION",
  /**
   * A call this endpoint refused without being able to name a session. It may
   * belong to this session and it may not — hence the name. Journaled to every
   * session armed on the endpoint, because the wire genuinely cannot say.
   */
  "POSSIBLY_RELATED",
]);
export type SessionEventKind = z.infer<typeof SessionEventKind>;

/**
 * One line of the session's journal.
 *
 * Sized for a tool result, not for an archive: a one-sentence `summary` and a
 * `payload_id` handle, never a body. A model reading ten of these on the back
 * of an unrelated call must not lose the context it was using to drive the flow
 * — which is the same rule `record_get_payload` exists to enforce, applied to a
 * channel the model cannot opt out of.
 */
export const SessionEvent = z.object({
  seq: z
    .number()
    .int()
    .describe(
      "Session-wide and monotonic. A different counter from a transaction's " +
        "`seq` — this one orders everything in the session, that one orders " +
        "one transaction's exchanges.",
    ),
  at: z.string().describe("ISO 8601."),
  kind: SessionEventKind,
  flow_id: z.string().optional(),
  transaction_id: z.string().optional(),
  action: z
    .string()
    .optional()
    .describe("Protocol action, or the step key for a form."),
  ack: AckStatus.optional(),
  nack_code: z
    .string()
    .optional()
    .describe("OUT_OF_SEQUENCE, TRANSACTION_MISMATCH, VALIDATION_ERROR, …"),
  payload_id: z
    .string()
    .optional()
    .describe("Handle for the body, if one was stored. Read it with record_get_payload."),
  summary: z.string().describe("One sentence, written to be read at a glance."),
});
export type SessionEvent = z.infer<typeof SessionEvent>;

/**
 * The events that happened since the model's last call, delivered on the back
 * of whatever it called next.
 *
 * This is the delivery mechanism the whole journal exists for. MCP's
 * server→client notifications terminate at the client and most hosts never put
 * them in front of the model, so the only channel guaranteed to reach it is a
 * tool result — and a model cannot drive a flow without calling *some* tool.
 * Attaching the backlog to every one of them makes "push" out of a pull.
 */
export const EventsDelta = z.object({
  events: z
    .array(SessionEvent)
    .describe("Oldest first. Capped; `more` says what was left."),
  more: z
    .number()
    .int()
    .describe(
      "Undelivered entries beyond the cap. Non-zero means call " +
        "record_get_events to read the rest.",
    ),
  cursor: z
    .number()
    .int()
    .describe("Journal seq of the last entry included. Already delivered."),
});
export type EventsDelta = z.infer<typeof EventsDelta>;

/**
 * The `events` field, spread into every session-scoped tool's output.
 *
 * Defined once so the wording the model reads is identical wherever it turns
 * up — the block is only useful if it is instantly recognisable, and eleven
 * hand-written descriptions would guarantee it was not.
 *
 * Optional, and **absent** rather than empty when nothing happened: a key the
 * model has to read past on every call to learn there is nothing to read costs
 * more than it saves.
 */
export const EventsField = {
  events: EventsDelta.optional().describe(
    "What has happened in this session since your last call — the " +
      "participant's callbacks, steps sent automatically, refusals, form " +
      "submissions. Attached to every session-scoped result and delivered " +
      "exactly once, so read it here instead of polling. Absent when nothing " +
      "happened. `more` above zero means call record_get_events for the rest.",
  ),
} as const;

/**
 * How many entries the journal keeps per session.
 *
 * A cap rather than a TTL sweep because the writers are on the hot path: the
 * trim rides the same `MULTI` as the append, so bounding the log costs nothing
 * per write. Generous enough that a full flow's events survive a model that
 * ignores them, small enough that a participant looping on a refused call
 * cannot grow it without bound.
 */
export const JOURNAL_LIMIT = 500;

/**
 * How many entries one tool result may carry.
 *
 * Ten one-line summaries is a paragraph; a hundred is an eviction. Anything
 * beyond the cap stays in the journal and is reported as `more`, so a burst is
 * throttled rather than dropped.
 */
export const EVENTS_DELTA_LIMIT = 10;

/* -------------------------------------------------------------------------- */
/* Tool input / output                                                         */
/* -------------------------------------------------------------------------- */

export const GetPayloadInput = z.object({
  session_id: z.string().min(1).describe("Session returned by session_create."),
  payload_id: z
    .string()
    .min(1)
    .describe("Payload handle, as reported by flow_get_status or flow_await."),
  jsonpath: z
    .string()
    .optional()
    .describe(
      "JSONPath to slice out instead of the whole body, e.g. " +
        "$.message.catalog.providers[*].id. Use this on large catalogs.",
    ),
  max_bytes: z
    .number()
    .int()
    .positive()
    .max(200_000)
    .optional()
    .describe(
      "Truncate the serialised result past this many bytes. Defaults to 20000.",
    ),
});
export type GetPayloadInput = z.infer<typeof GetPayloadInput>;

export const GetPayloadOutput = z.object({
  payload_id: z.string(),
  action: z.string(),
  direction: Direction.describe(
    "'outbound' if this mock sent it, 'inbound' if the participant did.",
  ),
  message_id: z.string(),
  timestamp: z.string(),
  size_bytes: z.number().int().describe("Size of the full stored body."),
  truncated: z
    .boolean()
    .describe("True when the body was cut short; narrow it with jsonpath."),
  payload: z.unknown().describe("The body, or the JSONPath slice of it."),
  ack: z
    .unknown()
    .optional()
    .describe("The ACK/NACK exchanged for this call, when one was recorded."),
  ...EventsField,
});
export type GetPayloadOutput = z.infer<typeof GetPayloadOutput>;

export const GetDataInput = z.object({
  session_id: z.string().min(1).describe("Session returned by session_create."),
  transaction_id: z.string().min(1).describe("Transaction to read."),
  keys: z
    .array(z.string())
    .optional()
    .describe("Restrict to these business-data keys. Omit for everything."),
});
export type GetDataInput = z.infer<typeof GetDataInput>;

export const GetDataOutput = z.object({
  transaction_id: z.string(),
  data: z
    .record(z.string(), z.unknown())
    .describe("Business data accumulated across the flow's steps so far."),
  omitted: z
    .array(z.object({ key: z.string(), size_bytes: z.number().int() }))
    .describe(
      "Keys held back for size — typically resolved form HTML. Ask for one by name.",
    ),
  ...EventsField,
});
export type GetDataOutput = z.infer<typeof GetDataOutput>;

/* ------------------------------ record_get_events ------------------------- */

export const GetEventsInput = z.object({
  session_id: z.string().min(1).describe("Session returned by session_create."),
  since_seq: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Only entries newer than this journal seq. Omit for everything still " +
        "held — the journal keeps the last few hundred entries.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Most entries to return, newest-biased. Defaults to 50."),
});
export type GetEventsInput = z.infer<typeof GetEventsInput>;

export const GetEventsOutput = z.object({
  events: z.array(SessionEvent).describe("Oldest first."),
  more: z
    .number()
    .int()
    .describe("Matching entries beyond `limit`. Raise since_seq to walk on."),
  delivered_through: z
    .number()
    .int()
    .describe(
      "Journal seq already delivered by piggyback. Reading here does not " +
        "move it, so anything at or below this has been seen once already.",
    ),
});
export type GetEventsOutput = z.infer<typeof GetEventsOutput>;
