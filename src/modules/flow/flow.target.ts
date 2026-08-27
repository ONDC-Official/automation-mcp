import type {
  EngineSequenceStep,
  FlowStatusCode,
  MappedStep,
} from "@/modules/flow/engine/engine-types.js";
import { getNextActions } from "@/modules/flow/engine/flow-mapper.js";
import { blocked, inputRequired } from "@/modules/flow/flow.outcomes.js";
import type {
  FlowDeps,
  FlowRuntime,
  ProceedArgs,
  Target,
} from "@/modules/flow/flow.types.js";

const FORM_TYPES = new Set(["HTML_FORM", "DYNAMIC_FORM", "HTML_FORM_MULTI"]);

/**
 * Which step this turn is about.
 *
 * `selectTarget` is the question every entry point asks first — advance,
 * describe, or wake from a wait — and the answer has to be the same for all
 * of them, or the loop tells the caller one thing and does another.
 * `inputGate` decides whether the chosen step can actually go; its three
 * shapes are not interchangeable, and the comment on it says why.
 */

export async function extraStatuses(
  deps: FlowDeps,
  runtime: FlowRuntime,
): Promise<Map<string, FlowStatusCode>> {
  return deps.records.getExtraFlowStatuses(
    runtime.record.transactionId,
    runtime.session.np.subscriber_url,
    (runtime.flow.extraSequence ?? []).map((step) => step.key),
  );
}

/**
 * Decide what this turn is about.
 *
 * Returns a *description* of the target, never an action, so the same
 * decision drives both `proceed` (which acts on it) and `describeNext`
 * (which reports it).
 */
export async function selectTarget(
  deps: FlowDeps,
  runtime: FlowRuntime,
  flowStatus: FlowStatusCode,
  args: Pick<ProceedArgs, "inputs" | "triggerExtra">,
): Promise<Target> {
  const { session, record, flow } = runtime;
  const businessData = await deps.records.getBusinessData(
    record.transactionId,
    session.np.subscriber_url,
  );
  const extraStatusByKey = await extraStatuses(deps, runtime);

  const { sequenceNext, extrasNext } = getNextActions(
    record,
    flow,
    flowStatus,
    businessData,
    extraStatusByKey,
  );

  // 1. An explicit extras trigger outranks everything.
  if (args.triggerExtra !== undefined) {
    return selectExtra(
      runtime,
      args.triggerExtra,
      extrasNext ?? [],
      extraStatusByKey,
    );
  }

  // 2. The strict sequence.
  if (sequenceNext) {
    if (flowStatus === "WORKING") {
      return {
        kind: "outcome",
        outcome: blocked(
          "already_processing",
          `Step "${sequenceNext.actionId}" is already being dispatched. Wait for it to finish.`,
          { step_key: sequenceNext.actionId },
        ),
      };
    }

    if (FORM_TYPES.has(sequenceNext.actionType)) {
      return { kind: "form", step: sequenceNext };
    }

    switch (sequenceNext.status) {
      case "LISTENING":
        return { kind: "listen", step: sequenceNext };

      case "RESPONDING":
        return { kind: "dispatch", step: sequenceNext };

      case "INPUT-REQUIRED": {
        const gate = inputGate(sequenceNext, args.inputs);
        return gate.ready
          ? { kind: "dispatch", step: sequenceNext }
          : {
              kind: "outcome",
              outcome: inputRequired(
                runtime,
                sequenceNext,
                gate.message,
              ),
            };
      }

      default:
        return {
          kind: "outcome",
          outcome: blocked(
            "not_actionable",
            `Step "${sequenceNext.actionId}" is ${sequenceNext.status} and cannot be advanced from here.`,
            { step_key: sequenceNext.actionId, status: sequenceNext.status },
          ),
        };
    }
  }

  // 3. A ready side-channel step this mock owns dispatches on its own — that
  //    is what makes a paired unsolicited exchange complete without the
  //    caller having to name it.
  const ready = (extrasNext ?? []).find(
    (step) =>
      step.status === "RESPONDING" &&
      (extraStatusByKey.get(step.actionId) ?? "AVAILABLE") === "AVAILABLE",
  );
  if (ready) return { kind: "dispatch", step: ready };

  const pendingExtras = (extrasNext ?? []).filter(
    (step) => step.status !== "RESPONDING",
  );
  if (pendingExtras.length > 0) {
    const [first] = pendingExtras;
    return {
      kind: "outcome",
      outcome: {
        outcome: "WAITING",
        message:
          `The main sequence is finished. ${String(pendingExtras.length)} side-channel step(s) remain — ` +
          "wait for the participant, or fire one with trigger_extra.",
        ...(first
          ? { step_key: first.actionId, action: first.actionType }
          : {}),
      },
    };
  }

  return {
    kind: "outcome",
    outcome: {
      outcome: "COMPLETE",
      message:
        "Every step of this flow is done. Call report_generate for the compliance summary.",
    },
  };
}

function selectExtra(
  runtime: FlowRuntime,
  triggerExtra: string,
  extrasNext: MappedStep[],
  extraStatuses: ReadonlyMap<string, FlowStatusCode>,
): Target {
  const declared = (runtime.flow.extraSequence ?? []).find(
    (step) => step.key === triggerExtra,
  );
  if (!declared) {
    return {
      kind: "outcome",
      outcome: blocked(
        "unknown_extra",
        `"${triggerExtra}" is not a step in this flow's extra sequence.`,
        {
          available: (runtime.flow.extraSequence ?? []).map(
            (step) => step.key,
          ),
        },
      ),
    };
  }

  // Only steps this mock owns can be fired. Triggering one the participant
  // owns would mean sending its half of the conversation for it.
  if (declared.owner === runtime.record.subscriberType) {
    return {
      kind: "outcome",
      outcome: blocked(
        "not_ours_to_send",
        `Step "${declared.key}" is owned by the participant under test (${declared.owner}); wait for it instead.`,
        { step_key: declared.key, owner: declared.owner },
      ),
    };
  }

  const status = extraStatuses.get(declared.key) ?? "AVAILABLE";
  if (status !== "AVAILABLE") {
    return {
      kind: "outcome",
      outcome: blocked(
        "already_processing",
        `Step "${declared.key}" is ${status} and cannot be dispatched.`,
        { step_key: declared.key },
      ),
    };
  }

  // Prefer a live placeholder: it carries the `awaitingMessageId` that ties
  // the reply back to the exchange that prompted it.
  const placeholder = extrasNext.find(
    (step) => step.actionId === declared.key && step.status !== "COMPLETE",
  );
  return {
    kind: "dispatch",
    step: placeholder ?? synthesiseExtra(declared),
  };
}

/**
 * Whether an `INPUT-REQUIRED` step has what it needs.
 *
 * Three shapes, and they are not interchangeable:
 *
 * - **manual** — the caller must name the step (`{id: "<key>"}`). Naming it
 *   *is* the trigger, and the value is never fed to the generator.
 * - **unsolicited** — the engine gives it an empty input list precisely so it
 *   fires on its own; asking for input would deadlock it.
 * - **declared inputs** — any inputs at all release it; the generator decides
 *   what it can use.
 */
export function inputGate(
  step: MappedStep,
  inputs: Record<string, unknown> | undefined,
): { ready: boolean; message: string } {
  if (step.manual === true) {
    const named = inputs?.["id"] === step.actionId;
    return {
      ready: named,
      message: `Step "${step.actionId}" is manual — it only fires when you name it. Call flow_proceed with inputs {"id": "${step.actionId}"}.`,
    };
  }

  if (step.input !== undefined && step.input.length === 0) {
    // Unsolicited: the empty input list is the auto-fire marker.
    return { ready: true, message: "" };
  }

  return {
    ready: inputs !== undefined && Object.keys(inputs).length > 0,
    message: `Step "${step.actionId}" needs input before it can be sent. Call flow_proceed again with the values under \`inputs\`.`,
  };
}

function synthesiseExtra(step: EngineSequenceStep): MappedStep {
  return {
    status: "RESPONDING",
    actionId: step.key,
    owner: step.owner,
    actionType: step.type,
    input: step.input,
    index: -1,
    unsolicited: step.unsolicited,
    pairActionId: step.pair,
    description: step.description,
    label: step.label,
    isExtraStep: true,
  };
}
