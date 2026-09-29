import { z } from "zod";

/**
 * One order's complete journey — every exchange in order, both directions —
 * assembled from what the buyer's own record already holds. The seller's
 * replies are in the buyer's record too (inbound), so nothing has to be
 * fetched from the other instance.
 *
 * Kept pure: it takes the flow's step list, the record's exchange list and the
 * payload bodies as data, so the shape can be tested without a server.
 */

export const JourneyStep = z.object({
  n: z.number().int().describe("1-based position in the journey."),
  step_key: z.string(),
  action: z.string(),
  from: z.enum(["BAP", "BPP"]),
  to: z.enum(["BAP", "BPP"]),
  direction: z
    .enum(["sent", "received"])
    .describe("Relative to the instance that holds this record."),
  timestamp: z
    .string()
    .optional()
    .describe("The payload's own context.timestamp."),
  message_id: z.string().optional(),
  ack: z
    .string()
    .optional()
    .describe("How the receiving side answered: ACK or NACK."),
  status: z.string().describe("The flow's own status for this step."),
  payload_id: z.string().optional(),
  patched_paths: z
    .array(z.string())
    .optional()
    .describe("JSONPaths a payload_override repaired before this went out."),
  payload: z
    .unknown()
    .optional()
    .describe("The full body, only when include_payloads is set."),
  payload_truncated: z.boolean().optional(),
});
export type JourneyStep = z.infer<typeof JourneyStep>;

export const OrderSummary = z.object({
  order_id: z.string().optional(),
  order_status: z.string().optional(),
  payment_status: z.string().optional(),
  total: z.string().optional(),
  currency: z.string().optional(),
  items: z
    .array(z.object({ id: z.string(), count: z.number().optional() }))
    .optional(),
  fulfillment_state: z.string().optional(),
  from_step: z
    .string()
    .optional()
    .describe("The step whose payload this was read from."),
});
export type OrderSummary = z.infer<typeof OrderSummary>;

export interface ExchangeRow {
  payloadId: string;
  direction: "outbound" | "inbound";
  messageId: string;
  timestamp: string;
  seq: number;
  response?: unknown;
  overrides?: string[] | undefined;
}

export interface StepRow {
  key: string;
  action: string;
  owner: "BAP" | "BPP";
  status: string;
  ack?: string | undefined;
  payload_ids: string[];
}

export function assembleJourney(args: {
  steps: StepRow[];
  exchanges: ExchangeRow[];
  bodies?: Map<string, unknown>;
  maxPayloadBytes?: number;
}): JourneyStep[] {
  const byPayload = new Map(args.exchanges.map((e) => [e.payloadId, e]));
  const journey: JourneyStep[] = [];

  for (const step of args.steps) {
    // A step with no payload has not happened; the journey is what happened.
    const payloadId = step.payload_ids[0];
    if (payloadId === undefined) continue;
    const exchange = byPayload.get(payloadId);
    const sent = exchange?.direction === "outbound";
    const from = step.owner;
    const to = from === "BAP" ? "BPP" : "BAP";

    let payload: unknown;
    let truncated: boolean | undefined;
    if (args.bodies?.has(payloadId)) {
      const body = args.bodies.get(payloadId);
      const text = JSON.stringify(body);
      if (
        args.maxPayloadBytes !== undefined &&
        Buffer.byteLength(text) > args.maxPayloadBytes
      ) {
        payload = text.slice(0, args.maxPayloadBytes);
        truncated = true;
      } else {
        payload = body;
      }
    }

    journey.push({
      n: journey.length + 1,
      step_key: step.key,
      action: step.action,
      from,
      to,
      direction: sent ? "sent" : "received",
      ...(exchange
        ? { timestamp: exchange.timestamp, message_id: exchange.messageId }
        : {}),
      ...(step.ack !== undefined ? { ack: step.ack } : {}),
      status: step.status,
      payload_id: payloadId,
      ...(exchange?.overrides?.length
        ? { patched_paths: exchange.overrides }
        : {}),
      ...(payload !== undefined ? { payload } : {}),
      ...(truncated ? { payload_truncated: true } : {}),
    });
  }
  return journey;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Json)
    : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/**
 * The order as the seller last described it: read from the newest payload that
 * carries `message.order`. Tolerant — a missing field is simply absent.
 */
export function summariseOrder(
  latest: { stepKey: string; body: unknown } | undefined,
): OrderSummary | undefined {
  const order = obj(obj(obj(latest?.body)?.["message"])?.["order"]);
  if (!order || !latest) return undefined;

  const payments = Array.isArray(order["payments"]) ? order["payments"] : [];
  const fulfillments = Array.isArray(order["fulfillments"])
    ? order["fulfillments"]
    : [];
  const items = Array.isArray(order["items"]) ? order["items"] : [];
  const price = obj(obj(order["quote"])?.["price"]);
  const state = obj(obj(obj(fulfillments[0])?.["state"])?.["descriptor"]);

  const summarisedItems = items.flatMap((item) => {
    const i = obj(item);
    const id = str(i?.["id"]);
    if (id === undefined) return [];
    const count = obj(obj(i?.["quantity"])?.["selected"])?.["count"];
    return [{ id, ...(typeof count === "number" ? { count } : {}) }];
  });

  const orderId = str(order["id"]);
  const orderStatus = str(order["status"]);
  const paymentStatus = str(obj(payments[0])?.["status"]);
  const total = str(price?.["value"]);
  const currency = str(price?.["currency"]);
  const fulfillmentState = str(state?.["code"]);

  const summary: OrderSummary = {
    ...(orderId !== undefined ? { order_id: orderId } : {}),
    ...(orderStatus !== undefined ? { order_status: orderStatus } : {}),
    ...(paymentStatus !== undefined ? { payment_status: paymentStatus } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(summarisedItems.length > 0 ? { items: summarisedItems } : {}),
    ...(fulfillmentState !== undefined
      ? { fulfillment_state: fulfillmentState }
      : {}),
    from_step: latest.stepKey,
  };
  return summary;
}
