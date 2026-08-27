import type { MappedStep } from "@/modules/flow/engine/engine-types.js";
import { lockId } from "@/modules/flow/flow.load.js";
import {
  abandonedOutcome,
  blocked,
  listening,
  stamp,
} from "@/modules/flow/flow.outcomes.js";
import type { StepOutcome } from "@/modules/flow/flow.schema.js";
import { selectTarget } from "@/modules/flow/flow.target.js";
import type { FlowDeps, FlowRuntime } from "@/modules/flow/flow.types.js";
import { receiverScope } from "@/modules/session/session.service.js";

/**
 * One turn of the loop, as a *description* of what should happen.
 *
 * `describe` and the dispatch path switch on the same `Target` union, and
 * they must never disagree — `flow_get_status` promising a step that
 * `flow_proceed` would refuse is the exact contradiction the loop tools
 * exist to prevent. Keeping the describing half in one file is what makes
 * that agreement checkable by reading rather than by remembering.
 */

/**
 * What the loop needs next, without doing any of it.
 *
 * Shared by `flow_get_status` and `flow_await` so the two can never disagree
 * with each other — or with what `flow_proceed` would actually do.
 */
export async function describeNext(
  deps: FlowDeps,
  runtime: FlowRuntime,
): Promise<StepOutcome> {
  return describe(deps, runtime, { arm: false });
}

/**
 * `describeNext`, but it arms the expectation it describes.
 *
 * Only `flow_start` uses it. Everywhere else describing must stay free of
 * side effects, because `flow_get_status` and `flow_await` both call
 * `describeNext` to report what the loop needs without doing any of it — and
 * `proceed` arms on its own path.
 */
export function describeAndArm(
  deps: FlowDeps,
  runtime: FlowRuntime,
): Promise<StepOutcome> {
  return describe(deps, runtime, { arm: true });
}

async function describe(
  deps: FlowDeps,
  runtime: FlowRuntime,
  options: { arm: boolean },
): Promise<StepOutcome> {
  if (runtime.record.abandoned) return abandonedOutcome(runtime);

  const flowStatus = await deps.records.getFlowStatus(
    lockId(runtime),
    runtime.session.np.subscriber_url,
  );
  if (flowStatus === "SUSPENDED") {
    return stamp(
      runtime,
      blocked("flow_suspended", "This flow has been suspended."),
    );
  }

  // No inputs and no trigger: describe what would happen to a bare call.
  const target = await selectTarget(deps, runtime, flowStatus, {});

  switch (target.kind) {
    case "outcome":
      return stamp(runtime, target.outcome);
    case "listen":
      if (options.arm) await armExpectation(deps, runtime, target.step);
      return stamp(runtime, listening(target.step));
    case "form":
      return stamp(
        runtime,
        await formOutcome(deps, runtime, target.step, undefined),
      );
    case "dispatch":
      return stamp(runtime, {
        outcome: "READY",
        message: `Step "${target.step.actionId}" (${target.step.actionType}) is this mock's to send. Call flow_proceed.`,
        step_key: target.step.actionId,
        action: target.step.actionType,
      });
  }
}

/**
 * A form step: either complete it with a submission id, or say who owes what.
 */
export async function formOutcome(
  deps: FlowDeps,
  runtime: FlowRuntime,
  step: MappedStep,
  inputs: Record<string, unknown> | undefined,
): Promise<StepOutcome> {
  const { session, record } = runtime;
  const subscriberUrl = session.np.subscriber_url;
  const submissionId = inputs?.["submission_id"];

  if (typeof submissionId === "string" && submissionId.length > 0) {
    // The submission id lands in business data under the step's own key
    // because that is where the next step's generator looks for it.
    const data = await deps.records.getBusinessData(
      record.transactionId,
      subscriberUrl,
    );
    data[step.actionId] = submissionId;
    await deps.records.overwriteBusinessData(
      record.transactionId,
      subscriberUrl,
      data,
    );

    await deps.records.appendFormEntry({
      transactionId: record.transactionId,
      subscriberUrl,
      formId: step.actionId,
      formType:
        step.actionType === "DYNAMIC_FORM" ? "DYNAMIC_FORM" : "HTML_FORM",
      submissionId,
    });

    // Both directions land here — `form_submit` after we filled theirs, and
    // the hosted-form route after they filled ours — which is why one hook
    // covers what the plan lists as two. The second is the interesting one:
    // nobody is waiting on it, so without this it happens in silence.
    await deps.records.journal(session.session_id, {
      kind: "FORM_SUBMITTED",
      flow_id: record.flowId,
      transaction_id: record.transactionId,
      action: step.actionId,
      summary: `Form "${step.actionId}" was submitted (${submissionId}); the flow has moved on.`,
    });

    return {
      outcome: "SENT",
      message: `Recorded submission ${submissionId} for form "${step.actionId}". The flow has moved on.`,
      step_key: step.actionId,
      action: step.actionType,
    };
  }

  // `WAITING-SUBMISSION` means this mock hosts the form; anything else at a
  // form step means the participant hosts it and we have to fill it in.
  const hosting = step.status === "WAITING-SUBMISSION";
  const businessData = await deps.records.getBusinessData(
    record.transactionId,
    subscriberUrl,
  );
  const resolved = businessData[step.actionId];

  return {
    outcome: "FORM_PENDING",
    message: hosting
      ? `Form "${step.actionId}" is served by this mock; the participant has to submit it. Its URL is in the payload already sent.`
      : `Form "${step.actionId}" is hosted by the participant. Call form_fetch to read it, then form_submit.`,
    step_key: step.actionId,
    action: step.actionType,
    form_role: hosting ? "host" : "fill",
    ...(typeof resolved === "string" && /^https?:\/\//i.test(resolved)
      ? { form_url: resolved }
      : {}),
  };
}

/**
 * Stand up the note that lets the receiver file the participant's next call.
 *
 * `transactionId` is carried **only when the run is bound**. It is the
 * strongest tie-break the receiver has for telling two sessions armed on the
 * same endpoint apart, but an unbound run has no id to offer: the call being
 * waited for is the flow's first, and its `transaction_id` is the
 * participant's to choose. Putting the placeholder's candidate here would
 * assert we know something we do not, and the id would never match anyway.
 */
export async function armExpectation(
  deps: FlowDeps,
  runtime: FlowRuntime,
  step: MappedStep,
): Promise<void> {
  await deps.records.armExpectation(receiverScope(runtime.session), {
    sessionId: runtime.session.session_id,
    flowId: runtime.binding.flowId,
    ...(runtime.bound ? { transactionId: runtime.record.transactionId } : {}),
    expectedAction: step.actionType,
    subscriberUrl: runtime.session.np.subscriber_url,
    autoAdvance: runtime.binding.autoAdvance,
  });
}
