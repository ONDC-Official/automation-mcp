import type {
  Expectation,
  ExpectationScope,
} from "@/modules/record/record.schema.js";
import {
  SIGNATURE_ERROR_CODE,
  SIGNATURE_ERROR_MESSAGE,
  SIGNATURE_GUIDE_URL,
  type InboundVerdict,
} from "@/modules/signing/signing.service.js";
import { settingsOf, type Session } from "@/modules/session/session.schema.js";
import { journalInbound } from "@/modules/transport/receiver.persist.js";
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
 * check at all), and it must run **before** anything is bound: `resolve` opens
 * a transaction from an armed expectation by adopting the participant's
 * `transaction_id`, and binding a run to the id of a call we then refuse would
 * leave the participant's signed retry — often under a fresh id — answered
 * `TRANSACTION_MISMATCH`. So `resolve` calls this at the moment the session is
 * known, and nowhere else does.
 */

export type SignatureVerdict = InboundVerdict | { status: "skipped" };

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
 * Kept **out of line**, like `refuseMismatch`: appending it would match the
 * pending step and advance the flow on a call we refused, when the participant
 * still has to send it — signed. An expectation this call consumed is put
 * back, for the same reason.
 */
export async function refuseSignature(
  deps: ReceiverDeps,
  session: Session,
  target: {
    flowId: string;
    transactionId: string;
    /** Whether a transaction record exists to flag. */
    recorded: boolean;
    /** The expectation this call consumed, to put back. */
    expectation?: { scope: ExpectationScope; entry: Expectation };
  },
  action: string,
  call: { body: unknown; messageId: string; timestamp: string },
): Promise<InboundResult> {
  if (target.expectation !== undefined) {
    const { scope, entry } = target.expectation;
    await deps.records.armExpectation(scope, {
      sessionId: entry.sessionId,
      flowId: entry.flowId,
      ...(entry.transactionId !== undefined
        ? { transactionId: entry.transactionId }
        : {}),
      expectedAction: entry.expectedAction,
      subscriberUrl: entry.subscriberUrl,
      autoAdvance: entry.autoAdvance,
    });
  }

  const ackBody = nack(SIGNATURE_ERROR_CODE, SIGNATURE_ERROR_MESSAGE);
  const payloadId = await deps.records.storePayload({
    transactionId: target.transactionId,
    subscriberUrl: session.np.subscriber_url,
    direction: "inbound",
    action,
    messageId: call.messageId,
    timestamp: call.timestamp,
    body: call.body,
    ackBody,
  });

  const summary =
    `Refused ${action} with 401: its Authorization header is missing or does not verify. ` +
    `The participant must sign the exact request bytes — guide: ${SIGNATURE_GUIDE_URL}. ` +
    `Body kept out of line (${payloadId}); the flow did not advance.`;

  if (target.recorded) {
    await deps.records.setAttention(
      target.transactionId,
      session.np.subscriber_url,
      {
        kind: "SIGNATURE_INVALID",
        message: summary,
        at: new Date().toISOString(),
      },
    );
  }

  await journalInbound(deps, session, {
    flowId: target.flowId,
    transactionId: target.transactionId,
    action,
    nackCode: SIGNATURE_ERROR_CODE,
    payloadId,
    attention: true,
    summary,
  });

  return {
    status: 401,
    body: ackBody,
    headers: { "www-authenticate": deps.signing.challenge },
    ...(target.recorded ? { transactionId: target.transactionId } : {}),
  };
}
