import type {
  EngineSequenceStep,
  FlowStatusCode,
  MappedStep,
  Owner,
  StepInputConfig,
} from "@/modules/flow/engine/engine-types.js";

/**
 * The status truth table — the single most load-bearing function in the engine.
 *
 * Everything the loop does follows from what this returns for the step at the
 * cursor. Read `subscriberType === step.owner` throughout as **"the participant
 * under test owns this"**, because the transaction belongs to the NP being
 * exercised, not to us.
 *
 * | Step at the cursor                         | Status              | Meaning |
 * |--------------------------------------------|---------------------|---------|
 * | not at the cursor                          | `WAITING`           | not reached yet |
 * | form, NP owns it                           | `INPUT-REQUIRED`    | NP hosts it; we submit |
 * | form, we own it                            | `WAITING-SUBMISSION`| we host it; NP submits |
 * | NP owns it                                 | `LISTENING`         | arm an expectation, wait |
 * | ours, declares inputs                      | `INPUT-REQUIRED`    | blocked on a value |
 * | ours, `manual`                             | `INPUT-REQUIRED`    | blocked on an explicit trigger |
 * | ours, `unsolicited`                        | `INPUT-REQUIRED`    | fire-and-forget, auto-triggered |
 * | ours, plain                                | `RESPONDING`        | send it now |
 *
 * The `flowStatus === 'AVAILABLE'` guard on each of those turns the step into
 * `PROCESSING`/`RESPONDING` while a dispatch is already in flight, which is
 * what stops a second dispatch of the same step.
 */

/**
 * The synthetic input a `manual` step grows once it becomes actionable.
 *
 * A manual step must not fire on its own — the whole point is that a human (or
 * the model, deliberately) decides when it goes. Giving it a single `id` field
 * pre-filled with its own action id turns "send this now" into an explicit act
 * that cannot happen by accident.
 */
export function buildManualInput(actionId: string): StepInputConfig {
  return [
    {
      name: "manual_id",
      type: "manual_id",
      schema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          id: {
            type: "string",
            default: actionId,
            enum: [actionId],
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  ];
}

export interface BuildPendingStepArgs {
  step: EngineSequenceStep;
  index: number;
  isImmediateNext: boolean;
  /** The **participant under test's** side. */
  subscriberType: Owner;
  flowStatus: FlowStatusCode;
}

export function buildPendingStep(args: BuildPendingStepArgs): MappedStep[] {
  const { step, index, isImmediateNext, subscriberType, flowStatus } = args;

  const base: MappedStep = {
    status: isImmediateNext ? "LISTENING" : "WAITING",
    actionId: step.key,
    owner: step.owner,
    actionType: step.type,
    input: step.input,
    index,
    unsolicited: step.unsolicited,
    pairActionId: step.pair,
    description: step.description,
    expect: step.expect,
    label: step.label,
    force_proceed: step.force_proceed,
    repeat: step.repeat ?? 1,
    manual: step.manual,
  };

  if (!isImmediateNext) {
    return [{ ...base, status: "WAITING" }];
  }

  if (step.type === "HTML_FORM" || step.type === "DYNAMIC_FORM") {
    if (subscriberType === step.owner) {
      return [
        {
          ...base,
          status: flowStatus === "AVAILABLE" ? "INPUT-REQUIRED" : "PROCESSING",
        },
      ];
    }
    return [
      {
        ...base,
        status:
          flowStatus === "AVAILABLE" ? "WAITING-SUBMISSION" : "RESPONDING",
      },
    ];
  }

  if (subscriberType === step.owner) {
    return [base];
  }

  if (step.input) {
    return [
      {
        ...base,
        status: flowStatus === "AVAILABLE" ? "INPUT-REQUIRED" : "RESPONDING",
      },
    ];
  }

  // Manual takes precedence over unsolicited: a manual step must wait for an
  // explicit trigger, so it must NOT also emit the unsolicited auto-submit
  // (empty-input) placeholder — that placeholder gets auto-proceeded, which
  // would bypass the gate and loop on every read.
  const manualGate = step.manual === true && flowStatus === "AVAILABLE";
  if (manualGate) {
    return [
      {
        ...base,
        status: "INPUT-REQUIRED",
        input: buildManualInput(step.key),
      },
    ];
  }

  // Unsolicited (AVAILABLE): a single auto-submit INPUT-REQUIRED placeholder
  // with empty input — the placeholder alone drives the send, and the
  // stateless re-derivation replaces it with COMPLETE once the action lands.
  if (step.unsolicited) {
    return [
      {
        ...base,
        status: flowStatus === "AVAILABLE" ? "INPUT-REQUIRED" : "RESPONDING",
        input: [],
      },
    ];
  }

  return [{ ...base, status: "RESPONDING" }];
}
