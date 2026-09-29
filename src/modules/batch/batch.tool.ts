import { defineTool, type Registerable } from "@/lib/define-tool.js";
import type { BatchService } from "@/modules/batch/batch.service.js";
import {
  CancelBatchRunInput,
  CancelBatchRunOutput,
  GetBatchRunStatusInput,
  GetBatchPayloadsInput,
  GetBatchPayloadsOutput,
  GetOrderLogInput,
  GetOrderLogOutput,
  ListBatchOrdersInput,
  ListBatchOrdersOutput,
  GetBatchRunStatusOutput,
  StartBatchRunInput,
  StartBatchRunOutput,
  type BatchProgress,
  type BatchTransactionResult,
} from "@/modules/batch/batch.schema.js";

/** The protocol edge for batch runs — no data access, no business rules. */

function renderProgress(progress: BatchProgress, total: number): string {
  const settled =
    progress.completed +
    progress.blocked +
    progress.nacked +
    progress.timed_out +
    progress.errored;
  return [
    `  ${String(settled)}/${String(total)} settled`,
    `  queued: ${String(progress.queued)}  in_flight: ${String(progress.in_flight)}`,
    `  completed: ${String(progress.completed)}  blocked: ${String(progress.blocked)}  ` +
      `nacked: ${String(progress.nacked)}  timed_out: ${String(progress.timed_out)}  ` +
      `errored: ${String(progress.errored)}`,
  ].join("\n");
}

function renderResult(result: BatchTransactionResult): string {
  const txn = result.transaction_id ?? "(none)";
  return `  [${String(result.index)}] ${result.status} — txn ${txn} — ${result.message}`;
}

export function createBatchTools(service: BatchService): Registerable[] {
  return [
    defineTool({
      name: "batch_run_start",
      title: "Start a concurrent batch of order journeys",
      description:
        "Place many independent orders concurrently, in the background, with " +
        "ONE call. Returns immediately with a batch_id; the run never blocks " +
        "this call however large transaction_count is (max 1000). By default " +
        "(role: both) this instance plays the buyer and drives the configured " +
        "seller instance itself — it arms the seller first, then sends — so " +
        "there is nothing to start twice. Pick the build with `version` " +
        "(TRV11 Metro 2.0.0 or 2.0.1). Each order gets its own session, " +
        "transaction id and generated inputs (GPS resolved to stations, " +
        "distinct per order); nothing is templated. Poll batch_run_status " +
        "with the returned batch_id; it covers both sides. role initiator/" +
        "listener drive one side only, for a pair you start yourself.",
      inputSchema: StartBatchRunInput,
      outputSchema: StartBatchRunOutput,
      annotations: {
        // Creates a lot of server-side state and real wire traffic; re-running
        // it starts an independent batch, never repeats or corrupts one.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      render: (output) =>
        [
          `batch ${output.batch_id} accepted — role: ${output.role}, flow ${output.flow_id}`,
          ...(output.parties !== undefined
            ? [
                `  buyer  ${output.parties.bap_id} @ ${output.parties.bap_uri}`,
                `  seller ${output.parties.bpp_id ?? "(its own id)"} @ ${output.parties.bpp_uri} [${output.parties.seller}]`,
              ]
            : []),
          ...(output.peer_batch_id !== undefined
            ? [
                `  seller side started as ${output.peer_batch_id} (covered by this batch_id)`,
              ]
            : []),
          `  ${String(output.transaction_count)} transactions, concurrency ${String(output.concurrency)}`,
          `  call batch_run_status with this batch_id to watch progress`,
        ].join("\n"),
      handler: (input) => service.startRun(input),
    }),

    defineTool({
      name: "batch_run_status",
      title: "Check a batch run's progress",
      description:
        "Poll a batch started with batch_run_start: how many transactions " +
        "are queued, in flight, or settled, and why. Set include_results to " +
        "read individual transaction outcomes — paginated with since_index/" +
        "limit, since a large batch's full result list is never returned in " +
        "one call.",
      inputSchema: GetBatchRunStatusInput,
      outputSchema: GetBatchRunStatusOutput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      render: (output) =>
        [
          `batch ${output.batch_id} — ${output.state}`,
          renderProgress(output.progress, output.transaction_count),
          ...(output.peer !== undefined
            ? [
                `seller side ${output.peer.batch_id} — ${output.peer.state}`,
                ...(output.peer.progress !== undefined
                  ? [
                      renderProgress(
                        output.peer.progress,
                        output.transaction_count,
                      ),
                    ]
                  : []),
                ...(output.peer.error !== undefined
                  ? [`  ${output.peer.error}`]
                  : []),
              ]
            : []),
          ...(output.results !== undefined && output.results.length > 0
            ? [
                "",
                `results (showing ${String(output.results.length)} of ${String(output.results_total ?? 0)}):`,
                ...output.results.map(renderResult),
              ]
            : []),
        ].join("\n"),
      handler: ({ batch_id, include_results, since_index, limit }) =>
        service.status(batch_id, {
          includeResults: include_results,
          sinceIndex: since_index ?? 0,
          limit,
        }),
    }),

    defineTool({
      name: "batch_run_cancel",
      title: "Cancel a batch run",
      description:
        "Stop issuing new transactions from a running batch. Transactions " +
        "already in flight are left to finish or hit their own " +
        "per_transaction_timeout_ms naturally — never hard-killed mid-call, " +
        "so nothing is left half-sent on a third party's wire.",
      inputSchema: CancelBatchRunInput,
      outputSchema: CancelBatchRunOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      render: (output) =>
        `batch ${output.batch_id} — ${output.state} at ${output.cancelled_at}`,
      handler: ({ batch_id }) => service.cancel(batch_id),
    }),

    defineTool({
      name: "batch_run_order_log",
      title: "Read one order's complete journey",
      description:
        "The complete log of one order from a batch: every exchange in order " +
        "(search through confirm and status), which side sent it, its " +
        "timestamp, message id and ACK, the flow's own status for each step, " +
        "the events journaled for it, and the final order (id, status, " +
        "payment, total). Name the order by its `index` or `transaction_id` " +
        "from batch_run_status results. Set include_payloads for every " +
        "request and response body (large; capped per payload).",
      inputSchema: GetOrderLogInput,
      outputSchema: GetOrderLogOutput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      render: (o) =>
        [
          `order ${o.transaction_id} — batch order #${String(o.index)} (${o.batch_status})`,
          `flow ${o.flow_id} · ${o.flow_status} · session ${o.session_id}` +
            (o.duration_ms !== undefined
              ? ` · ${String(o.duration_ms)}ms`
              : ""),
          ...(o.inputs
            ? [
                `inputs: ${o.inputs.start_code} -> ${o.inputs.end_code}, ` +
                  `qty ${String(o.inputs.item_quantity)}, ` +
                  `from ${o.inputs.origin_gps} to ${o.inputs.destination_gps}`,
              ]
            : []),
          ...(o.order
            ? [
                `order: ${o.order.order_id ?? "?"} status ${o.order.order_status ?? "?"}` +
                  `, payment ${o.order.payment_status ?? "?"}` +
                  (o.order.total !== undefined
                    ? `, total ${o.order.total} ${o.order.currency ?? ""}`
                    : ""),
              ]
            : []),
          "",
          "journey:",
          ...o.steps.map(
            (s) =>
              `  ${String(s.n).padStart(2)}. ${s.timestamp ?? "                        "}  ` +
              `${s.from}->${s.to}  ${s.action.padEnd(10)} ${s.step_key.padEnd(34)} ` +
              `${s.ack ?? "-"}${s.patched_paths ? "  [patched]" : ""}`,
          ),
          "",
          "events:",
          ...o.events.map((e) => `  ${e.at}  ${e.kind}  ${e.summary}`),
          // Bodies, when asked for: each request and response with its
          // `context` and `message`, so the text view is the complete log too.
          ...o.steps.flatMap((s) =>
            s.payload === undefined
              ? []
              : [
                  "",
                  `--- ${String(s.n)}. ${s.action} (${s.from} -> ${s.to}, ${s.direction}) ${s.step_key} ---`,
                  typeof s.payload === "string"
                    ? s.payload
                    : JSON.stringify(s.payload, null, 2),
                ],
          ),
        ].join("\n"),
      handler: (input) => service.orderLog(input),
    }),

    defineTool({
      name: "batch_run_payloads",
      title: "Read one action's payloads across a whole batch",
      description:
        "Fetch the recorded payloads of every order in a batch. Pass " +
        "`actions` to get just those calls for all orders — e.g. " +
        '["on_confirm"] returns each order\'s on_confirm (context and ' +
        "message), so 10 orders give 10 on_confirms — or omit it for every " +
        "step of every order, the complete batch. `parts` narrows to the " +
        "context or the message. Paginated over the batch's results " +
        "(since_index / limit, next_since_index in the answer) because a " +
        "full order is ~85KB. For one order's timeline use batch_run_order_log.",
      inputSchema: GetBatchPayloadsInput,
      outputSchema: GetBatchPayloadsOutput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      render: (o) =>
        [
          `batch ${o.batch_id} — ${String(o.orders_returned)} of ${String(o.results_total)} orders` +
            (o.actions ? ` — ${o.actions.join(", ")}` : " — every step") +
            ` — ${o.parts}` +
            (o.next_since_index !== undefined
              ? ` — next page: since_index ${String(o.next_since_index)}`
              : ""),
          ...o.skipped.map(
            (k) => `  skipped #${String(k.index)} (${k.status}): ${k.reason}`,
          ),
          ...o.orders.flatMap((order) => [
            "",
            `=== order #${String(order.index)} — txn ${order.transaction_id} (${order.batch_status}) ===`,
            ...order.payloads.flatMap((p) => [
              `--- ${String(p.n)}. ${p.action} (${p.from} -> ${p.to}, ${p.direction}) ${p.step_key} · ${p.timestamp ?? ""} · ${p.ack ?? "-"} ---`,
              typeof p.payload === "string"
                ? p.payload
                : JSON.stringify(p.payload, null, 2),
            ]),
          ]),
        ].join("\n"),
      handler: (input) => service.batchPayloads(input),
    }),

    defineTool({
      name: "batch_list_orders",
      title: "List every order in a batch: order id and amount",
      description:
        "For a batch_id, every order it placed — its order id " +
        "(message.order.id) and amount (the quote total) once the seller has " +
        "assigned them, alongside its transaction id, status and the flow's " +
        'own state. This is the direct answer to "what did this batch ' +
        'place": cheaper than batch_run_order_log or batch_run_payloads, ' +
        "since it reads only the last couple of payloads of each order rather " +
        "than the whole journey or every body. Paginated over the batch's " +
        "results (since_index/limit, next_since_index in the answer).",
      inputSchema: ListBatchOrdersInput,
      outputSchema: ListBatchOrdersOutput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      render: (o) =>
        [
          `batch ${o.batch_id} — ${String(o.orders_returned)} of ${String(o.results_total)} orders` +
            (o.next_since_index !== undefined
              ? ` — next page: since_index ${String(o.next_since_index)}`
              : ""),
          ...o.orders.map((order) =>
            order.order_id !== undefined
              ? `  #${String(order.index)}  txn ${order.transaction_id ?? "-"}  order ${order.order_id}  ` +
                `${order.order_status ?? "?"}  ${order.payment_status ?? "?"}  ` +
                (order.amount !== undefined
                  ? `${order.amount} ${order.currency ?? ""}`.trim()
                  : "")
              : `  #${String(order.index)}  txn ${order.transaction_id ?? "-"}  (${order.batch_status})  ${order.message ?? "no order id yet"}`,
          ),
        ].join("\n"),
      handler: (input) => service.listOrders(input),
    }),
  ];
}
