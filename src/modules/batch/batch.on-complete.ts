import { randomUUID } from "node:crypto";
import { UpstreamError } from "@/lib/errors.js";
import type { OrderSummary } from "@/modules/batch/batch.journey.js";

/**
 * What a completed batch order sends to `BATCH_ON_COMPLETE_URL`: an `on_confirm`
 * body in the shape of the Postman template the operator supplied, filled from
 * this order's own data.
 *
 * Only fields the batch actually knows are filled. The template's provider and
 * settlement-term values are not carried here, so they are left out rather than
 * invented; add them to {@link buildOnConfirm} if the receiving end needs them.
 */
export interface OnConfirmInput {
  domain: string;
  version: string;
  transactionId: string;
  bapId?: string;
  bapUri?: string;
  bppId?: string;
  bppUri?: string;
  order: OrderSummary;
  now?: Date;
}

export function buildOnConfirm(input: OnConfirmInput): Record<string, unknown> {
  const { order } = input;
  const orderId = order.order_id ?? "";
  const amount = order.total;
  const currency = order.currency ?? "INR";

  return {
    context: {
      domain: input.domain,
      country: "IND",
      city: "std:080",
      action: "on_confirm",
      core_version: "1.0.0",
      ...(input.bapId !== undefined ? { bap_id: input.bapId } : {}),
      ...(input.bapUri !== undefined ? { bap_uri: input.bapUri } : {}),
      ...(input.bppId !== undefined ? { bpp_id: input.bppId } : {}),
      ...(input.bppUri !== undefined ? { bpp_uri: input.bppUri } : {}),
      transaction_id: input.transactionId,
      message_id: randomUUID(),
      timestamp: (input.now ?? new Date()).toISOString(),
      ttl: "P2D",
    },
    message: {
      order: {
        id: orderId,
        state: "Completed",
        ...(amount !== undefined
          ? { quote: { price: { value: amount, currency } } }
          : {}),
        payments: [
          {
            id: `PAYMENT-${orderId}`,
            collected_by: "BAP",
            status: order.payment_status ?? "PAID",
            type: "PRE-ORDER",
            params: {
              ...(amount !== undefined ? { amount } : {}),
              currency,
              transaction_id: input.transactionId,
            },
            // The receiving end requires these; the values are the template's.
            tags: [
              {
                descriptor: { code: "SETTLEMENT_TERMS" },
                list: [
                  {
                    descriptor: { code: "SETTLEMENT_AMOUNT" },
                    value: SETTLEMENT_AMOUNT,
                  },
                  {
                    descriptor: { code: "SETTLEMENT_TYPE" },
                    value: SETTLEMENT_TYPE,
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  };
}

export interface Parties {
  bap_id: string;
  bap_uri: string;
  bpp_id: string;
  bpp_uri: string;
}

/**
 * The four party fields as the order's own on_confirm carries them. All four
 * or nothing: a partly-known party is not one we should be telling anyone about,
 * so `undefined` means the order has no usable on_confirm and nothing is sent.
 */
export function partiesFromOnConfirm(
  rows: { key: string; payload_ids: string[] }[],
  bodies: Map<string, unknown>,
): Parties | undefined {
  for (const row of [...rows].reverse()) {
    if (!row.key.startsWith("on_confirm")) continue;
    const id = row.payload_ids[0];
    const body = id !== undefined ? bodies.get(id) : undefined;
    const context = (body as { context?: Record<string, unknown> } | undefined)
      ?.context;
    if (typeof context !== "object" || context === null) continue;
    const bap_id = context["bap_id"];
    const bap_uri = context["bap_uri"];
    const bpp_id = context["bpp_id"];
    const bpp_uri = context["bpp_uri"];
    if (
      typeof bap_id === "string" &&
      typeof bap_uri === "string" &&
      typeof bpp_id === "string" &&
      typeof bpp_uri === "string"
    ) {
      return { bap_id, bap_uri, bpp_id, bpp_uri };
    }
    return undefined;
  }
  return undefined;
}

/** The route a completed order is posted to, under the configured base. */
export const ON_COMPLETE_PATH = "/rsf-api/api/inbound/on_confirm";

const SETTLEMENT_AMOUNT = "100.00";
const SETTLEMENT_TYPE = "NEFT";

/** The full completion URL for a configured base, e.g. `https://host`. */
export function completionUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}${ON_COMPLETE_PATH}`;
}

const POST_TIMEOUT_MS = 10_000;

/**
 * POST one body to the completion URL. Throws on a non-2xx answer or a network
 * failure, so the caller can log it. Nothing here touches the transaction's own
 * result: notifying someone else is not part of whether the order succeeded.
 */
export async function postOnComplete(
  url: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new UpstreamError(
      "batch-on-complete",
      `could not POST to ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new UpstreamError(
      "batch-on-complete",
      `${url} answered HTTP ${String(response.status)} to the completed order`,
    );
  }
}
