import { randomUUID } from "node:crypto";
import { UpstreamError } from "@/lib/errors.js";

/**
 * What a completed batch order sends to the completion URL: the order's own
 * on_confirm, as the seller wrote it, with only what has to change for this
 * notice — a fresh message id, the time of sending, this transaction's id, and
 * the state `Completed`. Every other value (provider, quote, payments, settlement
 * terms, city, country, versions, ttl) comes from the seller's on_confirm, so
 * nothing in the body is a constant of ours.
 */
export function buildCompletedOnConfirm(
  sellerOnConfirm: Record<string, unknown>,
  input: { transactionId: string; now?: Date },
): Record<string, unknown> | undefined {
  const context = sellerOnConfirm["context"];
  const message = sellerOnConfirm["message"] as
    { order?: Record<string, unknown> } | undefined;
  const order = message?.order;
  if (typeof context !== "object" || context === null || order === undefined) {
    return undefined;
  }
  return {
    context: {
      ...(context as Record<string, unknown>),
      action: "on_confirm",
      transaction_id: input.transactionId,
      message_id: randomUUID(),
      timestamp: (input.now ?? new Date()).toISOString(),
    },
    message: {
      ...message,
      order: { ...order, state: "Completed" },
    },
  };
}

/** The newest on_confirm body recorded for an order, as the seller sent it. */
export function onConfirmBody(
  rows: { key: string; payload_ids: string[] }[],
  bodies: Map<string, unknown>,
): Record<string, unknown> | undefined {
  for (const row of [...rows].reverse()) {
    if (!row.key.startsWith("on_confirm")) continue;
    const id = row.payload_ids[0];
    const body = id !== undefined ? bodies.get(id) : undefined;
    if (typeof body === "object" && body !== null) {
      return body as Record<string, unknown>;
    }
  }
  return undefined;
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
