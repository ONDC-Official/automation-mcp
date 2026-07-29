import type { MockAgent } from "undici";
import type { Session } from "@/modules/session/session.schema.js";

/**
 * A scripted network participant, built on undici's mock dispatcher.
 *
 * Everything up to the socket is real — the sender serialises, sets headers and
 * POSTs exactly as it would in production — so these helpers only intercept the
 * transport. That is the whole point: the failures worth catching (a wrong URL,
 * a re-serialised body, an identity that never got overridden) all live above
 * the socket.
 */

/**
 * The request body an intercept saw, as text.
 *
 * undici types `options.body` as a union that includes objects and streams, but
 * our sender always writes a string. Narrowing here keeps every call site free
 * of the same cast.
 */
export function requestBody(options: { body?: unknown }): string {
  const { body } = options;
  return typeof body === "string" ? body : "";
}

/** Parse what an intercept saw. */
export function requestJson<T = Record<string, unknown>>(options: {
  body?: unknown;
}): T {
  return JSON.parse(requestBody(options)) as T;
}

export interface ScriptedCall {
  /** Every payload the participant was sent on this action, in order. */
  readonly seen: Record<string, unknown>[];
}

/**
 * The path a counterparty POSTs to for this session.
 *
 * `{prefix}/{domain}/{version}/{buyer|seller}/{action}` — derived from the
 * session's own `callback_url` so a test cannot drift from what we advertised.
 */
export function receiverPath(session: Session, action: string): string {
  return `${new URL(session.callback_url).pathname.replace(
    /\/+$/,
    "",
  )}/${action}`;
}

/**
 * A context with the counterparty's URI on the side the receiver reads.
 *
 * `bpp_uri` when the mock is a BAP, `bap_uri` when it is a BPP — the endpoint's
 * role is ours, so the *other* side identifies the caller. Getting it wrong is
 * a 400, which is exactly why no test should hand-build one.
 */
export function counterpartyContext(
  session: Session,
  npUrl: string,
  args: {
    transactionId: string;
    action: string;
    messageId: string;
    timestampOffsetMs?: number;
  },
): Record<string, unknown> {
  const npId = new URL(npUrl).host;
  const theirs =
    session.mock_role === "BAP"
      ? { bpp_id: npId, bpp_uri: npUrl }
      : { bap_id: npId, bap_uri: npUrl };

  return {
    domain: session.build.domain,
    version: session.build.version,
    action: args.action,
    transaction_id: args.transactionId,
    message_id: args.messageId,
    timestamp: new Date(
      Date.now() + (args.timestampOffsetMs ?? 0),
    ).toISOString(),
    ...theirs,
  };
}

/** Accept every call to `{base}/{action}` with a clean ACK. */
export function acceptsAction(
  agent: MockAgent,
  base: string,
  action: string,
): ScriptedCall {
  const seen: Record<string, unknown>[] = [];
  agent
    .get(base)
    .intercept({ path: `/${action}`, method: "POST" })
    .reply(200, (options) => {
      seen.push(requestJson(options));
      return { message: { ack: { status: "ACK" } } };
    })
    .persist();
  return { seen };
}

/**
 * A participant that fires its **next** request before answering this one.
 *
 * `receive → process → send the next call → return the ACK`, which is what a
 * great many real implementations do and what produced the `OUT_OF_SEQUENCE`
 * false positive the two-phase outbound append exists to fix. It is not
 * misbehaviour: nothing in beckn makes an ACK's return leg a happens-before edge
 * for the sender's next request, and the two legs are independent connections,
 * so no amount of care on the participant's side can guarantee the ordering.
 *
 * `onReceive` is **awaited before the ACK is produced** — undici does await an
 * async reply callback, which makes the inversion exact rather than probabilistic.
 * Do not reach for `.delay()` here: it postpones the callback itself, so the ACK
 * follows about a millisecond later and the follow-up call loses the race it was
 * supposed to win.
 */
export function acceptsActionAndCallsBack(
  agent: MockAgent,
  base: string,
  action: string,
  onReceive: (payload: Record<string, unknown>) => Promise<unknown>,
): ScriptedCall {
  const seen: Record<string, unknown>[] = [];
  agent
    .get(base)
    .intercept({ path: `/${action}`, method: "POST" })
    .reply(200, async (options) => {
      const payload = requestJson(options);
      seen.push(payload);
      await onReceive(payload);
      return { message: { ack: { status: "ACK" } } };
    })
    .persist();
  return { seen };
}
