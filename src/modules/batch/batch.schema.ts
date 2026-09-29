import { z } from "zod";
import { JourneyStep, OrderSummary } from "@/modules/batch/batch.journey.js";

/**
 * A concurrent, background-run batch of independent TRV11-shaped (or any
 * domain's) order journeys, each driven end to end against a live counterparty
 * by `FlowService`/`SessionService` — the same services `flow_start` /
 * `flow_proceed` / `flow_await` call, invoked in-process rather than over the
 * wire, so there is no MCP protocol overhead per virtual transaction.
 *
 * One `batch_run_start` call kicks off up to `transaction_count` independent
 * runs, each with its own `session_id` (per role) and its own generated,
 * unique inputs — see `batch.input-generator.ts`. It returns immediately;
 * `batch_run_status` polls progress.
 *
 * Field naming is `snake_case`, matching every other tool in this server.
 */

export const BatchTransactionStatus = z.enum([
  "queued",
  "in_flight",
  "completed",
  "blocked",
  "nacked",
  "timed_out",
  "errored",
]);
export type BatchTransactionStatus = z.infer<typeof BatchTransactionStatus>;

export const BatchRunState = z.enum(["running", "completed", "cancelled"]);
export type BatchRunState = z.infer<typeof BatchRunState>;

/**
 * Per-transaction inputs, generated fresh for every virtual order — never one
 * static template reused across the batch. `origin`/`destination` are unique
 * per transaction within one run (the generator re-rolls on collision); the
 * station codes are the *nearest* station to each, resolved from
 * `batch.station-reference.ts`.
 */
export const OrderInputs = z.object({
  city_code: z.string(),
  origin_gps: z.string().describe("lat,lon — the buyer's generated origin."),
  destination_gps: z
    .string()
    .describe("lat,lon — the buyer's generated destination."),
  start_code: z.string().describe("Nearest station to origin_gps."),
  end_code: z.string().describe("Nearest station to destination_gps."),
  vehicle_category: z.literal("METRO"),
  item_quantity: z.number().int().min(1),
});
export type OrderInputs = z.infer<typeof OrderInputs>;

export const BatchTransactionResult = z.object({
  index: z.number().int().describe("Position in the batch, 0-based."),
  status: BatchTransactionStatus,
  transaction_id: z.string().nullable(),
  session_id: z.string().optional(),
  inputs: OrderInputs.optional().describe(
    "The unique inputs generated for this order. Present once the run has " +
      "started driving — absent while still queued.",
  ),
  item_id: z
    .string()
    .optional()
    .describe(
      "The real item id read back from the counterparty's on_search2 " +
        "response and used for select — never a hardcoded guess.",
    ),
  message: z.string().describe("Human-facing summary of the outcome."),
  reason: z
    .string()
    .optional()
    .describe("Machine-readable cause, for blocked/nacked/errored/timed_out."),
  started_at: z.string().optional(),
  finished_at: z.string().optional(),
  duration_ms: z.number().int().optional(),
});
export type BatchTransactionResult = z.infer<typeof BatchTransactionResult>;

export const BatchProgress = z.object({
  queued: z.number().int(),
  in_flight: z.number().int(),
  completed: z.number().int(),
  blocked: z.number().int(),
  nacked: z.number().int(),
  timed_out: z.number().int(),
  errored: z.number().int(),
});
export type BatchProgress = z.infer<typeof BatchProgress>;

/* -------------------------------------------------------------------------- */
/* batch_run_start                                                            */
/* -------------------------------------------------------------------------- */

export const RetryPolicy = z.object({
  max_retries: z.number().int().min(0).default(0),
  retry_on: z
    .array(BatchTransactionStatus)
    .default(["timed_out"])
    .describe("Which terminal statuses are eligible for a retry."),
});
export type RetryPolicy = z.infer<typeof RetryPolicy>;

export const GpsBoundingBox = z.object({
  min_lat: z.number(),
  max_lat: z.number(),
  min_lon: z.number(),
  max_lon: z.number(),
});
export type GpsBoundingBox = z.infer<typeof GpsBoundingBox>;

/**
 * Which side of the pair this call drives. `batch` runs in-process against
 * the services of *whichever instance handles the call* — it has no way to
 * reach a peer process — so a two-instance run is started **once per
 * instance**, each naming its own role:
 *
 * - `listener` (the mock BPP instance): creates every session + arms every
 *   `search1` expectation up front, then watches each run to completion and
 *   fires the one call auto-advance can never make —
 *   `trigger_extra: "unsoliciated_on_status_complete_*"`.
 * - `initiator` (the mock BAP instance): creates every session, sends
 *   `search1` with this order's generated inputs, and drives `select` with
 *   the item id read back from the real `on_search2` response.
 *
 * Call `listener` first — "arm before send" (see the module's design notes):
 * every session on one instance shares one endpoint, and the *first*
 * exchange of each run is matched FIFO against whatever is currently armed.
 */
export const BatchRole = z.enum(["initiator", "listener"]);
export type BatchRole = z.infer<typeof BatchRole>;

/** Hard ceiling on orders in one batch, and on how many run at once. */
export const MAX_BATCH_ORDERS = 1000;

/**
 * `both` (the default) is the single-call form: this instance plays the buyer
 * and drives the configured peer instance as the seller, so one call places
 * the orders. `initiator` / `listener` drive only one side of a pair and are
 * what `both` uses underneath, each on its own instance.
 */
export const BatchStartRole = z.enum(["both", "initiator", "listener"]);
export type BatchStartRole = z.infer<typeof BatchStartRole>;

export const StartBatchRunInput = z.object({
  role: BatchStartRole.default("both").describe(
    "`both` (default): one call drives buyer and seller. Needs BATCH_PEER_URL " +
      "set on this instance. `initiator`/`listener`: drive one side only.",
  ),
  domain: z.string().min(1).default("ONDC:TRV11"),
  version: z.string().min(1).default("2.0.0"),
  usecase: z.string().min(1).default("Metro"),
  flow_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The flow to run, by its id on the config-service (see " +
        "catalog_list_flows for the chosen version). Omit it and the version's " +
        "default order journey runs (TRV11 Metro 2.0.0 and 2.0.1 have one).",
    ),
  counterparty_subscriber_url: z
    .url()
    .optional()
    .describe(
      "Required for `initiator`/`listener`; derived for `both`. " +
        "The *other* instance's receiver base URL for the role this call is " +
        "NOT playing — e.g. on the initiator (BAP) call, the listener " +
        "instance's URL, which becomes every session's subscriber_url so " +
        "this mock's outbound calls reach it.",
    ),
  bap_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The buyer's subscriber id (context.bap_id). Default: this instance's " +
        "MOCK_SUBSCRIBER_ID.",
    ),
  bap_uri: z
    .url()
    .optional()
    .describe(
      "The buyer's callback URI (context.bap_uri) — where the seller sends " +
        "its replies. Must end `/{domain}/{version}/buyer`, the path this " +
        "server mounts. Default: this instance's advertised URI.",
    ),
  bpp_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The seller's subscriber id (context.bpp_id). Default: the seller " +
        "instance's own.",
    ),
  bpp_uri: z
    .url()
    .optional()
    .describe(
      "The seller's URI (context.bpp_uri). Set it to run the buyer against " +
        "ANOTHER seller app: the order then happens between this buyer and " +
        "that seller, no seller instance is started, and the seller must " +
        "call back on bap_uri. Default: the configured seller instance.",
    ),
  transaction_count: z
    .number()
    .int()
    .min(1)
    .max(MAX_BATCH_ORDERS)
    .describe(`Orders to place, 1 to ${String(MAX_BATCH_ORDERS)}.`),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(MAX_BATCH_ORDERS)
    .default(50)
    .describe("Maximum virtual transactions in flight at once."),
  per_transaction_timeout_ms: z
    .number()
    .int()
    .positive()
    .default(120_000)
    .describe(
      "Wall-clock budget for one virtual transaction, start to COMPLETE. " +
        "Kept comfortably inside EXPECTATION_TTL_MS/AWAIT_MAX_WAIT_MS's " +
        "defaults (300s) so a slow transaction fails on its own budget " +
        "before those.",
    ),
  retry_policy: RetryPolicy.optional(),
  gps_bounding_box: GpsBoundingBox.optional().describe(
    "Where generated origin/destination GPS points are drawn from. Defaults " +
      "to a sane Indian metro-service area.",
  ),
  city_codes: z
    .array(z.string())
    .min(1)
    .optional()
    .describe("Pool of city_code values to draw from. Defaults built in."),
});
export type StartBatchRunInput = z.infer<typeof StartBatchRunInput>;

export const StartBatchRunOutput = z.object({
  batch_id: z.string(),
  role: BatchStartRole,
  parties: z
    .object({
      bap_id: z.string(),
      bap_uri: z.string(),
      bpp_id: z.string().optional(),
      bpp_uri: z.string(),
      seller: z
        .enum(["peer", "external"])
        .describe(
          "`peer`: the configured seller instance, started by this call. " +
            "`external`: the bpp_uri you named — nothing was started there.",
        ),
    })
    .optional()
    .describe("Who the orders are between, as resolved."),
  peer_batch_id: z
    .string()
    .optional()
    .describe(
      "The seller instance's own batch id, for `both`. Status and cancel on batch_id cover it.",
    ),
  flow_id: z.string().describe("The flow every order in this batch runs."),
  transaction_count: z.number().int(),
  concurrency: z.number().int(),
  accepted_at: z.string(),
});
export type StartBatchRunOutput = z.infer<typeof StartBatchRunOutput>;

/* -------------------------------------------------------------------------- */
/* batch_run_status                                                           */
/* -------------------------------------------------------------------------- */

export const GetBatchRunStatusInput = z.object({
  batch_id: z.string().min(1),
  include_results: z.boolean().optional().default(false),
  since_index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Paginate results: only entries at or after this list index."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .default(100)
    .describe("Max results returned in one call. Never the full list."),
});
export type GetBatchRunStatusInput = z.infer<typeof GetBatchRunStatusInput>;

export const PeerBatchStatus = z.object({
  batch_id: z.string(),
  state: z.union([BatchRunState, z.literal("unreachable")]),
  progress: BatchProgress.optional(),
  error: z.string().optional(),
});
export type PeerBatchStatus = z.infer<typeof PeerBatchStatus>;

export const GetBatchRunStatusOutput = z.object({
  batch_id: z.string(),
  state: BatchRunState.describe(
    "For `both`, `running` until the seller side has settled too.",
  ),
  peer: PeerBatchStatus.optional().describe(
    "The seller side's own progress, for a `both` batch.",
  ),
  transaction_count: z.number().int(),
  concurrency: z.number().int(),
  progress: BatchProgress,
  accepted_at: z.string(),
  finished_at: z.string().optional(),
  results: z
    .array(BatchTransactionResult)
    .optional()
    .describe("Present only when include_results is true. Paginated."),
  results_total: z
    .number()
    .int()
    .optional()
    .describe("Total recorded results, for paginating results."),
});
export type GetBatchRunStatusOutput = z.infer<typeof GetBatchRunStatusOutput>;

/* -------------------------------------------------------------------------- */
/* batch_run_cancel                                                           */
/* -------------------------------------------------------------------------- */

export const CancelBatchRunInput = z.object({
  batch_id: z.string().min(1),
});
export type CancelBatchRunInput = z.infer<typeof CancelBatchRunInput>;

export const CancelBatchRunOutput = z.object({
  batch_id: z.string(),
  state: BatchRunState,
  cancelled_at: z.string(),
});
export type CancelBatchRunOutput = z.infer<typeof CancelBatchRunOutput>;

/* -------------------------------------------------------------------------- */
/* batch_run_order_log                                                         */
/* -------------------------------------------------------------------------- */

export const GetOrderLogInput = z.object({
  batch_id: z.string().min(1),
  index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "The order's position in the batch (its `index` in the results).",
    ),
  transaction_id: z
    .string()
    .min(1)
    .optional()
    .describe("Or name the order by its transaction id instead."),
  include_payloads: z
    .boolean()
    .default(false)
    .describe(
      "Include every request and response body. Large: a catalog is hundreds of KB.",
    ),
  max_payload_bytes: z
    .number()
    .int()
    .min(1_000)
    .max(1_000_000)
    .default(50_000)
    .describe("Per-payload cap when include_payloads is set."),
});
export type GetOrderLogInput = z.infer<typeof GetOrderLogInput>;

export const GetOrderLogOutput = z.object({
  batch_id: z.string(),
  index: z.number().int(),
  transaction_id: z.string(),
  session_id: z.string(),
  flow_id: z.string(),
  flow_status: z.string(),
  batch_status: BatchTransactionStatus,
  duration_ms: z.number().int().optional(),
  inputs: OrderInputs.optional(),
  order: OrderSummary.optional(),
  steps: z.array(JourneyStep),
  events: z.array(
    z.object({
      at: z.string(),
      kind: z.string(),
      action: z.string().optional(),
      summary: z.string(),
    }),
  ),
});
export type GetOrderLogOutput = z.infer<typeof GetOrderLogOutput>;

/* -------------------------------------------------------------------------- */
/* batch_run_payloads                                                          */
/* -------------------------------------------------------------------------- */

export const GetBatchPayloadsInput = z.object({
  batch_id: z.string().min(1),
  actions: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Only these protocol actions, e.g. ["on_confirm"] or ["confirm", ' +
        '"on_confirm"]. Omit for every step of every order — the complete ' +
        "batch. `search` matches both search steps.",
    ),
  parts: z
    .enum(["both", "context", "message"])
    .default("both")
    .describe("Which part of each payload to return."),
  since_index: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      "Paginate orders: start at this position in the batch's results.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe("Orders per page. Payloads are large; keep this modest."),
  max_payload_bytes: z
    .number()
    .int()
    .min(1_000)
    .max(1_000_000)
    .default(100_000)
    .describe(
      "Per-payload cap; a longer body is cut and marked payload_truncated.",
    ),
});
export type GetBatchPayloadsInput = z.infer<typeof GetBatchPayloadsInput>;

export const BatchOrderPayloads = z.object({
  index: z.number().int(),
  transaction_id: z.string(),
  session_id: z.string(),
  batch_status: BatchTransactionStatus,
  payloads: z.array(JourneyStep),
});

export const GetBatchPayloadsOutput = z.object({
  batch_id: z.string(),
  actions: z.array(z.string()).optional(),
  parts: z.enum(["both", "context", "message"]),
  results_total: z.number().int(),
  orders_returned: z.number().int(),
  next_since_index: z
    .number()
    .int()
    .optional()
    .describe("Pass as since_index for the next page; absent on the last."),
  orders: z.array(BatchOrderPayloads),
  skipped: z
    .array(
      z.object({
        index: z.number().int(),
        status: BatchTransactionStatus,
        reason: z.string(),
      }),
    )
    .describe(
      "Orders with no journey to read (they never sent their first call).",
    ),
});
export type GetBatchPayloadsOutput = z.infer<typeof GetBatchPayloadsOutput>;

/* -------------------------------------------------------------------------- */
/* batch_list_orders                                                           */
/* -------------------------------------------------------------------------- */

export const ListBatchOrdersInput = z.object({
  batch_id: z.string().min(1),
  since_index: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Paginate: start at this position in the batch's results."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(100)
    .describe(
      "Orders per page. Max 200 — the full batch is never returned in one call.",
    ),
});
export type ListBatchOrdersInput = z.infer<typeof ListBatchOrdersInput>;

export const BatchOrderSummary = z.object({
  index: z.number().int().describe("Position in the batch, 0-based."),
  transaction_id: z.string().nullable(),
  session_id: z.string().optional(),
  batch_status: BatchTransactionStatus,
  flow_status: z
    .string()
    .optional()
    .describe(
      "The flow's own state, when the order reached one — WAITING/COMPLETE/…",
    ),
  order_id: z
    .string()
    .optional()
    .describe(
      "The order id the seller assigned (message.order.id), once known.",
    ),
  order_status: z.string().optional(),
  payment_status: z.string().optional(),
  amount: z
    .string()
    .optional()
    .describe("The order's quote total (message.order.quote.price.value)."),
  currency: z.string().optional(),
  duration_ms: z.number().int().optional(),
  message: z
    .string()
    .optional()
    .describe(
      "Why there is no order_id/amount yet, for a settled non-completed order.",
    ),
});
export type BatchOrderSummary = z.infer<typeof BatchOrderSummary>;

export const ListBatchOrdersOutput = z.object({
  batch_id: z.string(),
  results_total: z.number().int(),
  orders_returned: z.number().int(),
  next_since_index: z
    .number()
    .int()
    .optional()
    .describe("Pass as since_index for the next page; absent on the last."),
  orders: z.array(BatchOrderSummary),
});
export type ListBatchOrdersOutput = z.infer<typeof ListBatchOrdersOutput>;
