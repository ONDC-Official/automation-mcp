import type {
  Expectation,
  ExpectationScope,
  TransactionRecord,
} from "@/modules/record/record.schema.js";
import type { Session } from "@/modules/session/session.schema.js";
import { journalInbound } from "@/modules/transport/receiver.persist.js";
import type {
  InboundRequest,
  InboundResult,
  ReceiverDeps,
} from "@/modules/transport/receiver.types.js";

/**
 * How many sessions one unattributable refusal is announced to.
 *
 * This path is reachable by anyone who can POST to the endpoint, and the
 * endpoint is deliberately unauthenticated — a third-party server has no MCP
 * credentials and never will. The cap is what keeps a stranger's repeated bad
 * call from being amplified across every session on a busy build.
 */
const UNATTRIBUTED_FANOUT_LIMIT = 10;

/**
 * Ceiling on a refused body kept as evidence.
 *
 * An accepted payload is stored whole, because it is part of a transaction we
 * are answering for. A *refused* one belongs to nobody we can identify, so it
 * is stored only far enough to recognise: a real `on_search` catalog runs to
 * hundreds of kilobytes, and a participant looping on a dead endpoint would
 * otherwise fill the store with them.
 */
const REFUSED_BODY_LIMIT = 32_000;
/**
 * Saying no, and saying it where somebody can hear it.
 *
 * Every branch here both answers the participant *and* leaves a trace. The
 * four 400 `MALFORMED_CONTEXT` branches used to simply `return`: no record
 * (there is no id to file one under), no journal line, no channel to the model
 * at all — so a participant calling without a `bap_uri` was completely
 * invisible. "They never called" and "we would not take their call" are
 * opposite problems that had one appearance.
 *
 * `journalUnattributable` answers a refusal nobody can attribute: it fans the
 * line out to every session armed on the endpoint, capped, because this path
 * is reachable by anyone who can POST to a deliberately unauthenticated URL.
 */

/**
 * Refuse a call that quotes the wrong transaction, and keep listening.
 *
 * Three things have to happen besides the NACK.
 *
 * The expectation is **put back** — `consumeExpectation` already took it, and
 * a stray call must not be able to stop us listening for the real one.
 *
 * The body is stored **out of line**, not appended to the transaction. This
 * call typically carries the action the flow is waiting for, so appending it
 * would match the pending step and mark it `COMPLETE` — the flow would
 * advance on a call we just refused. It is also, by its own `context`, part
 * of a different transaction: replaying it as history of this one would be a
 * lie about what this transaction contains.
 *
 * And the reason is written to `attention`, because a payload nothing points
 * at is not evidence. That is what puts it in front of the caller on the next
 * `flow_get_status`, alongside the handle to read it.
 */
export async function refuseMismatch(
  deps: ReceiverDeps,
  session: Session,
  scope: ExpectationScope,
  expectation: Expectation,
  quoted: string,
  action: string,
  call: { body: unknown; messageId: string; timestamp: string },
): Promise<InboundResult> {
  const expected = expectation.transactionId as string;

  await deps.records.armExpectation(scope, {
    sessionId: expectation.sessionId,
    flowId: expectation.flowId,
    transactionId: expected,
    expectedAction: expectation.expectedAction,
    subscriberUrl: expectation.subscriberUrl,
    autoAdvance: expectation.autoAdvance,
  });

  const message =
    `This flow is transaction "${expected}", but "${action}" quoted "${quoted}". ` +
    "Every call after a flow's first action must carry the same transaction_id.";
  const ackBody = nack("TRANSACTION_MISMATCH", message);

  const payloadId = await deps.records.storePayload({
    transactionId: expected,
    subscriberUrl: session.np.subscriber_url,
    direction: "inbound",
    action,
    messageId: call.messageId,
    timestamp: call.timestamp,
    body: call.body,
    ackBody,
  });

  await deps.records.setAttention(expected, session.np.subscriber_url, {
    kind: "TRANSACTION_MISMATCH",
    message: `${message} Refused; read the payload with record_get_payload (${payloadId}).`,
    at: new Date().toISOString(),
  });

  await journalInbound(deps, session, {
    flowId: expectation.flowId,
    transactionId: expected,
    action,
    nackCode: "TRANSACTION_MISMATCH",
    payloadId,
    // Attention rather than a plain NACK: the body is stored out of line, so
    // it appears in no transaction's history and this line is the only thing
    // that points at it.
    attention: true,
    summary: `Refused ${action}: it quoted transaction ${quoted}, but this flow is ${expected}. Body kept out of line.`,
  });

  deps.logger.warn(
    {
      session_id: session.session_id,
      transaction_id: expected,
      quoted,
      action,
      payload_id: payloadId,
    },
    "inbound call quotes a different transaction_id than the flow it belongs to",
  );

  return { status: 200, body: ackBody, transactionId: expected };
}

/**
 * Refuse a call for an attempt `flow_restart` wrote off.
 *
 * The id is still resolvable on purpose — `txn_index` outlives the restart so
 * late traffic can be filed rather than bounced at the transport — so this is
 * the branch that decides what "filed" means for a run we have abandoned.
 *
 * Recorded **out of line**, not appended, for both of `#refuseMismatch`'s
 * reasons and one more. Appending would advance the abandoned attempt's
 * derived map, marking a step complete on a run we just refused; it would
 * also publish an event on `flow_run::{session}::{flow}`, which is the key a
 * `flow_await` on the *current* attempt is parked on — waking it with a
 * callback that belongs to the previous try is precisely the confusion the
 * restart existed to clear up.
 *
 * The NACK is honest about what happened: the participant is calling about a
 * test run that has been superseded, and ACKing it would say the opposite.
 */
export async function refuseAbandoned(
  deps: ReceiverDeps,
  session: Session,
  record: TransactionRecord,
  action: string,
  call: { body: unknown; messageId: string; timestamp: string },
): Promise<InboundResult> {
  const { transactionId, flowId } = record;
  const attempt = record.abandoned?.attempt ?? 1;

  const message =
    `Transaction "${transactionId}" was attempt ${String(attempt)} of flow ` +
    `"${flowId}" and has been abandoned. That run has been restarted; a new ` +
    "attempt carries a new transaction_id.";
  const ackBody = nack("TRANSACTION_ABANDONED", message);

  const payloadId = await deps.records.storePayload({
    transactionId,
    subscriberUrl: session.np.subscriber_url,
    direction: "inbound",
    action,
    messageId: call.messageId,
    timestamp: call.timestamp,
    body: call.body,
    ackBody,
  });

  await deps.records.setAttention(
    transactionId,
    session.np.subscriber_url,
    {
      kind: "TRANSACTION_ABANDONED",
      message: `${message} Refused; read the payload with record_get_payload (${payloadId}).`,
      at: new Date().toISOString(),
    },
  );

  await journalInbound(deps, session, {
    flowId,
    transactionId,
    action,
    nackCode: "TRANSACTION_ABANDONED",
    payloadId,
    attention: true,
    summary:
      `Refused ${action}: it belongs to attempt ${String(attempt)} of "${flowId}", which was restarted away. ` +
      "The participant may still be driving the old run.",
  });

  deps.logger.warn(
    {
      session_id: session.session_id,
      transaction_id: transactionId,
      flow_id: flowId,
      attempt,
      action,
      payload_id: payloadId,
    },
    "inbound call arrived for an attempt that has been abandoned",
  );

  return { status: 200, body: ackBody, transactionId };
}

/**
 * Refuse a call whose context we cannot key on — and say so out loud.
 *
 * These four branches used to `return` a 400 and nothing else: no record (by
 * definition — there is no id to file it under), no journal line, no log the
 * model could read. A participant calling with a missing `bap_uri` was
 * therefore **completely invisible**. The operator saw a run sitting in
 * `flow_await` reporting that nothing had arrived, which is exactly what a
 * silent participant looks like, and the two are the opposite problem: one is
 * "they never called", the other is "they called and we would not take it".
 *
 * So it is journaled to every live session on the endpoint, the same audience
 * and the same reasoning as `#journalUnattributable` — a malformed call names
 * no session, and the sessions sharing this endpoint are precisely the ones it
 * might have been for. The body is kept, capped, because "what did they
 * actually send?" is the only question worth asking next.
 *
 * Best-effort throughout: a call we are already refusing must not turn into a
 * 500 because the journal was unavailable.
 */
export async function refuseMalformed(
  deps: ReceiverDeps,
  scope: ExpectationScope,
  request: InboundRequest,
  body: unknown,
  call: {
    messageId?: string;
    action?: string;
    timestamp?: string;
    advertisedUri?: string;
    detail: string;
  },
): Promise<InboundResult> {
  const ackBody = nack("MALFORMED_CONTEXT", call.detail);

  try {
    const audience = await deps.sessions.sessionsOnEndpoint(
      scope,
      UNATTRIBUTED_FANOUT_LIMIT,
    );
    if (audience.length > 0) {
      const payloadId = await deps.records.storePayload({
        // No transaction and possibly no caller: the endpoint is the only
        // true thing about this call, so that is what it is filed under. The
        // handle is what makes it readable, not the key.
        transactionId: `MALFORMED::${scope.domain}/${scope.version}/${scope.role}`,
        subscriberUrl: call.advertisedUri ?? "unknown",
        direction: "inbound",
        action: call.action ?? request.action,
        messageId: call.messageId ?? "unknown",
        timestamp: call.timestamp ?? new Date().toISOString(),
        body: capBody(body),
        ackBody,
      });

      for (const sessionId of audience) {
        await deps.records.journal(sessionId, {
          kind: "POSSIBLY_RELATED",
          action: call.action ?? request.action,
          ack: "NACK",
          nack_code: "MALFORMED_CONTEXT",
          payload_id: payloadId,
          summary:
            `Refused a ${request.action} call on ${scope.domain}/${scope.version}/${scope.role} ` +
            `with 400: ${call.detail} It could not be attributed to any run, so it may be yours. ` +
            `Read what arrived with record_get_payload (${payloadId}).`,
        });
      }
    }
  } catch (error) {
    deps.logger.warn(
      { err: error, ...scope, action: request.action },
      "could not journal a malformed inbound call",
    );
  }

  deps.logger.warn(
    { ...scope, action: request.action, detail: call.detail },
    "refused an inbound call whose context could not be keyed on",
  );

  return { status: 400, body: ackBody };
}

export async function journalUnattributable(
  deps: ReceiverDeps,args: {
  /** The endpoint the call arrived on; its armed sessions are the audience. */
  scope: ExpectationScope;
  /** Journal to exactly this session instead, when the call named one. */
  sessionId?: string;
  transactionId: string;
  action: string;
  advertisedUri: string;
  code: string;
  summary: string;
  call: { body: unknown; messageId: string; timestamp: string };
}): Promise<void> {
  try {
    // Every live session on the endpoint, not just the ones with an armed
    // expectation. A run that has *sent* its request and is waiting for the
    // callback arms nothing at all — the receiver files that callback by
    // `transaction_id` — and it is precisely the run whose participant is
    // most likely to be the one calling badly.
    const audience =
      args.sessionId !== undefined
        ? [args.sessionId]
        : await deps.sessions.sessionsOnEndpoint(
            args.scope,
            UNATTRIBUTED_FANOUT_LIMIT,
          );
    if (audience.length === 0) return;

    const payloadId = await deps.records.storePayload({
      transactionId: args.transactionId,
      // The URI it advertised, not one we registered — we do not know which
      // participant this is, and pretending otherwise would mis-key it.
      subscriberUrl: args.advertisedUri,
      direction: "inbound",
      action: args.action,
      messageId: args.call.messageId,
      timestamp: args.call.timestamp,
      body: capBody(args.call.body),
      ackBody: nack(args.code, args.summary),
    });

    for (const sessionId of audience) {
      await deps.records.journal(sessionId, {
        kind: "POSSIBLY_RELATED",
        transaction_id: args.transactionId,
        action: args.action,
        ack: "NACK",
        nack_code: args.code,
        payload_id: payloadId,
        summary: args.summary,
      });
    }
  } catch (error) {
    deps.logger.warn(
      { err: error, ...args.scope, action: args.action },
      "could not journal an unattributable refusal",
    );
  }
}

export function ack(): unknown {
  return { message: { ack: { status: "ACK" } } };
}

export function nack(code: string, message: string): unknown {
  return {
    message: { ack: { status: "NACK" } },
    error: { code, message },
  };
}

/**
 * A refused body, trimmed to what is worth keeping.
 *
 * Returns the body untouched when it is small enough — the common case, and the
 * one where the model wants the whole thing. Over the limit it is replaced by a
 * description plus a prefix: enough to see the context and recognise the call,
 * without storing a catalog for a transaction that is not ours.
 */
export function capBody(body: unknown): unknown {
  const serialised = JSON.stringify(body ?? null);
  if (serialised === undefined) return null;

  const bytes = Buffer.byteLength(serialised, "utf8");
  if (bytes <= REFUSED_BODY_LIMIT) return body;

  return {
    _truncated: true,
    _bytes: bytes,
    _note: `This call was refused and its body exceeded ${String(REFUSED_BODY_LIMIT)} bytes, so only a prefix was kept.`,
    _prefix: serialised.slice(0, REFUSED_BODY_LIMIT),
  };
}
