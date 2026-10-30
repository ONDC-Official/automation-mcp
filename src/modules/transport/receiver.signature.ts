import {
  REGISTRY_ERROR_MESSAGE,
  SIGNATURE_ERROR_CODE,
  signatureErrorMessage,
  SIGNATURE_GUIDE_URL,
  SIGNING_TOPICS,
  type InboundVerdict,
} from "@/modules/signing/signing.service.js";
import { settingsOf, type Session } from "@/modules/session/session.schema.js";
import {
  journalInbound,
  record,
} from "@/modules/transport/receiver.persist.js";
import { nack } from "@/modules/transport/receiver.refuse.js";
import type {
  BecknContext,
  InboundRequest,
  InboundResult,
  ReceiverDeps,
} from "@/modules/transport/receiver.types.js";

/**
 * Is the call signed by who it says it is from — the receiver's one signature
 * check.
 *
 * It needs the session (whose `header_validation` setting decides whether to
 * check at all) and a transaction to record a refusal on, so `resolve` calls it
 * once both are known — after adopting the participant's `transaction_id` on a
 * first call, as the workbench does — and nowhere else does.
 */

export type SignatureVerdict = InboundVerdict | { status: "skipped" };

/** A verdict the call may not pass: checking is on and it was not shown valid. */
export type RefusedVerdict = Extract<
  SignatureVerdict,
  { status: "rejected" | "unavailable" }
>;

/**
 * With `header_validation` on, a call we could not verify is refused like one
 * that failed: the participant asked to be tested on its signature, and an
 * ACK would say it passed. Off, nothing is checked and nothing is refused.
 */
export function isRefused(
  verdict: SignatureVerdict,
): verdict is RefusedVerdict {
  return verdict.status === "rejected" || verdict.status === "unavailable";
}

export interface SignedCall {
  headers: Record<string, unknown>;
  rawBody: string | undefined;
  context: BecknContext;
}

export async function checkSignature(
  deps: ReceiverDeps,
  session: Session,
  request: InboundRequest,
  call: SignedCall,
): Promise<SignatureVerdict> {
  if (!settingsOf(session).header_validation) return { status: "skipped" };

  // The caller is on the other side of the context from us.
  const claimed =
    request.role === "seller" ? call.context.bap_id : call.context.bpp_id;
  const header = call.headers["authorization"];

  return deps.signing.verifyInbound({
    header: typeof header === "string" ? header : undefined,
    rawBody: call.rawBody,
    claimedSubscriberId: typeof claimed === "string" ? claimed : undefined,
  });
}

/**
 * Refuse an unsigned or badly signed call: 401, a NACK carrying ONDC's
 * `10001`, and the guide.
 *
 * Or one we could not verify, because the registry gave us no key. Same 401
 * and `10001`, but neither the participant nor the model is told the signature
 * is wrong: it may be fine, and the lookup that failed was ours.
 *
 * **Recorded on the transaction**, like every other NACK and like the
 * workbench, which records the call before it checks the signature. The step
 * shows as taken and refused, and the flow moves past it: a signed retry no
 * longer matches, and the way to try again is `flow_restart`.
 */
export async function refuseSignature(
  deps: ReceiverDeps,
  session: Session,
  target: { flowId: string; transactionId: string },
  action: string,
  call: { body: unknown; messageId: string; timestamp: string },
  verdict: RefusedVerdict,
): Promise<InboundResult> {
  const unverified = verdict.status === "unavailable";
  const ackBody = nack(
    SIGNATURE_ERROR_CODE,
    unverified ? REGISTRY_ERROR_MESSAGE : signatureErrorMessage(verdict.reason),
  );
  const { payloadId } = await record(
    deps,
    session,
    target.transactionId,
    action,
    call.messageId,
    call.timestamp,
    call.body,
    ackBody,
  );

  const summary =
    (unverified
      ? `Refused ${action} with 401: we could not get the participant's key from the registry (${verdict.reason}). ` +
        "Their signature may be fine — the lookup that failed is ours: check IN_HOUSE_REGISTRY and our ONDC identity, " +
        "or turn header_validation off with session_update_settings to carry on unverified. "
      : `Refused ${action} with 401: ${verdict.reason}. ` +
        "Tell the person you are testing for what failed, " +
        `and write ONDC's signing guide to them as the full URL, plain text on its own line: ${SIGNATURE_GUIDE_URL} . ` +
        `To help them fix it, read ${SIGNING_TOPICS.join(" and ")} with protocol_search_knowledge. `) +
    `Recorded as a NACK on this step${payloadId !== undefined ? ` (${payloadId})` : ""}; ` +
    "the flow has moved past it, so to try again, call flow_restart.";

  await deps.records.setAttention(
    target.transactionId,
    session.np.subscriber_url,
    {
      kind: "SIGNATURE_INVALID",
      message: summary,
      at: new Date().toISOString(),
    },
  );

  await journalInbound(deps, session, {
    flowId: target.flowId,
    transactionId: target.transactionId,
    action,
    nackCode: SIGNATURE_ERROR_CODE,
    ...(payloadId !== undefined ? { payloadId } : {}),
    attention: true,
    summary,
  });

  return {
    status: 401,
    body: ackBody,
    headers: { "www-authenticate": deps.signing.challenge },
    transactionId: target.transactionId,
  };
}
