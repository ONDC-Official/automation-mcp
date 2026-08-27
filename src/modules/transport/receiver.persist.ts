import type { MappedStep } from "@/modules/flow/engine/engine-types.js";
import {
  unwrapSaved,
  type AppendResult,
} from "@/modules/record/record.service.js";
import type { Session } from "@/modules/session/session.schema.js";
import {
  summariseFindings,
  type ValidationVerdict,
} from "@/modules/validate/validate.schema.js";

const FORM_TYPES = new Set(["HTML_FORM", "DYNAMIC_FORM", "HTML_FORM_MULTI"]);
import type { ReceiverDeps } from "@/modules/transport/receiver.types.js";

/**
 * Writing down what arrived, and matching it to a step.
 *
 * An out-of-sequence call is recorded **anyway**, as evidence: an unexpected
 * call is one of the most valuable things a compliance run catches, and the
 * mapper classifies it as a missed step on the next read.
 *
 * `matchStep` pairs on action type plus a `message_id` echo where the flow
 * declared a `pair`. The workbench matches the triplet
 * action::message_id::timestamp against an already-recorded payload, which
 * only works because it records the expected call *before* it arrives —
 * matching a live call that way would mean predicting its timestamp.
 */

export function record(
  deps: ReceiverDeps,
  session: Session,
  transactionId: string,
  action: string,
  messageId: string,
  timestamp: string,
  body: unknown,
  ackBody: unknown,
): Promise<AppendResult> {
  return deps.records.appendApiEntry({
    transactionId,
    subscriberUrl: session.np.subscriber_url,
    action,
    messageId,
    direction: "inbound",
    timestamp,
    body,
    ackBody,
  });
}

/**
 * Note an inbound call in the session journal.
 *
 * Every call this endpoint takes a view on gets a line, because an inbound
 * call is the one thing that happens entirely outside the model's control:
 * unless it is parked in `flow_await` on precisely the right run at precisely
 * the right moment, this is the only way it ever learns the call happened.
 *
 * Ordinary refusals are `INBOUND_NACK`; the two that leave a body the model
 * should read are `ATTENTION`, so a busy journal still distinguishes "we
 * refused it and the flow is unaffected" from "we refused it and there is
 * something here for you". Never both for one call.
 */
export function journalInbound(
  deps: ReceiverDeps,
  session: Session,
  entry: {
    flowId?: string;
    transactionId: string;
    action: string;
    nackCode?: string;
    payloadId?: string;
    attention?: boolean;
    summary: string;
  },
): Promise<void> {
  return deps.records.journal(session.session_id, {
    kind:
      entry.attention === true
        ? "ATTENTION"
        : entry.nackCode === undefined
          ? "INBOUND_ACK"
          : "INBOUND_NACK",
    ...(entry.flowId !== undefined ? { flow_id: entry.flowId } : {}),
    transaction_id: entry.transactionId,
    action: entry.action,
    ack: entry.nackCode === undefined ? "ACK" : "NACK",
    ...(entry.nackCode !== undefined ? { nack_code: entry.nackCode } : {}),
    ...(entry.payloadId !== undefined ? { payload_id: entry.payloadId } : {}),
    summary: entry.summary,
  });
}

/**
 * Fetch and screen a form the participant is about to require, if this call
 * just supplied its URL.
 *
 * Ported from the workbench's `processHtmlFormStep`, and worth the
 * complication for one reason: the payload that carries a form URL is the
 * same payload that makes the form step current. Fetching it here means the
 * page has already been retrieved, screened and had its relative actions
 * resolved by the time anyone asks for it — so `form_fetch` answers from
 * memory and a page that turns out to be hostile is discovered before it is
 * ever offered to a human.
 *
 * Best-effort throughout: this runs after the payload has been accepted, and
 * a form we could not pre-fetch is simply fetched later on demand. Nothing
 * here may turn a good ACK into a failure.
 */
export async function resolveUpcomingForm(
  deps: ReceiverDeps,
  session: Session,
  transactionId: string,
  map: { sequence: MappedStep[] },
  completedStep: MappedStep,
): Promise<void> {
  if (completedStep.isExtraStep === true) return;

  const index = map.sequence.findIndex(
    (step) => step.actionId === completedStep.actionId,
  );
  const next = index >= 0 ? map.sequence[index + 1] : undefined;
  if (!next || !FORM_TYPES.has(next.actionType)) return;

  // A form we host has no page to fetch — the participant opens ours.
  if (next.owner !== session.np.type) return;

  try {
    const data = await deps.records.getBusinessData(
      transactionId,
      session.np.subscriber_url,
    );
    const url = unwrapSaved(data[next.actionId]);
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;

    const html = await deps.forms.prefetchForm(url);
    if (html === undefined) return;

    data[next.actionId] = html;
    await deps.records.overwriteBusinessData(
      transactionId,
      session.np.subscriber_url,
      data,
    );

    deps.logger.info(
      { transaction_id: transactionId, step_key: next.actionId },
      "pre-fetched the participant's form",
    );
  } catch (error) {
    deps.logger.warn(
      { err: error, transaction_id: transactionId, step_key: next.actionId },
      "could not pre-fetch the participant's form; it will be fetched on demand",
    );
  }
}

/**
 * Which pending step, if any, this call satisfies.
 *
 * Matching is by **action type**, plus a `message_id` echo where the flow
 * declared one. The workbench matches on the triplet
 * `action::message_id::timestamp` against an already-recorded payload, which
 * only works because it records the expected call before it arrives; matching
 * a live call that way would require us to predict its timestamp.
 *
 * The `awaitingMessageId` check is the part that matters for extras: side-channel
 * steps repeat, so without it a reply would attach to whichever instance came
 * first rather than the one that prompted it.
 */
export function matchStep(
  steps: MappedStep[],
  action: string,
  messageId: string,
): MappedStep | undefined {
  const pending = steps.filter(
    (step) =>
      step.status === "LISTENING" ||
      step.status === "WAITING-SUBMISSION" ||
      step.status === "PROCESSING",
  );

  const echoed = pending.find(
    (step) =>
      step.actionType === action && step.awaitingMessageId === messageId,
  );
  if (echoed) return echoed;

  return pending.find(
    (step) =>
      step.actionType === action && step.awaitingMessageId === undefined,
  );
}

/**
 * What to add to an ACK's journal line about protocol validation.
 *
 * Empty when the payload passed cleanly — the overwhelmingly common case, and
 * one where a sentence saying so on every callback would bury the lines that
 * matter. The two states that speak are the ones the model would otherwise
 * never learn: findings we chose not to act on (`advisory`), and a payload
 * nobody checked (`unavailable`).
 *
 * Note that an ACK carrying findings is *not* a contradiction. Under `advisory`
 * we accept the call and record what was wrong with it; the compliance report is
 * where that lands. Refusing would be the alternative, and it is exactly what
 * `enforce` does.
 */
export function describeInbound(verdict: ValidationVerdict): string {
  if (verdict.status === "valid") return "";

  if (verdict.status === "unavailable") {
    return (
      " Protocol validation did not run: " +
      (verdict.unchecked[0]?.reason ?? "no layer could be checked") +
      "."
    );
  }

  return (
    ` It has ${String(verdict.findings.length)} validation ` +
    `finding${verdict.findings.length === 1 ? "" : "s"}, recorded but not enforced: ` +
    `${summariseFindings(verdict.findings, 2)}.`
  );
}
