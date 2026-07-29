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
});
export type GetDataOutput = z.infer<typeof GetDataOutput>;
