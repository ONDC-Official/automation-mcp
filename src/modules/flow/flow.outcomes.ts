import { describeInputs } from "@/modules/catalog/catalog.inputs.js";
import type { MappedStep } from "@/modules/flow/engine/engine-types.js";
import type { FlowRuntime } from "@/modules/flow/flow.types.js";
import type {
  InputProblem,
  StepOutcome,
} from "@/modules/flow/flow.schema.js";
import { specFor } from "@/modules/flow/flow.step-config.js";

/**
 * The `StepOutcome` shapes, in one place.
 *
 * All pure functions of a `FlowRuntime` and a step — none of them touches a
 * collaborator, which is why none of them takes `FlowDeps`. `stamp` is the one
 * that carries a real invariant: an unbound run has **no** transaction id, not
 * a blank one and not a provisional one, and every outcome that leaves the
 * loop goes through here to have that decided in one place.
 */

export function blocked(
  reason: string,
  message: string,
  details?: Record<string, unknown>,
): StepOutcome {
  return {
    outcome: "BLOCKED",
    message,
    reason,
    ...(details !== undefined ? { details } : {}),
    ...(typeof details?.["step_key"] === "string"
      ? { step_key: details["step_key"] }
      : {}),
  };
}

/**
 * The one answer a written-off attempt gives, wherever it is asked from.
 *
 * Shared by `proceed` and `describe` so a caller holding the old id is told
 * the same thing whether they try to advance it or merely look at it —
 * `flow_get_status` reporting "call flow_proceed" for a run that would
 * immediately refuse is exactly the sort of contradiction the loop tools are
 * built to avoid.
 */
export function abandonedOutcome(runtime: FlowRuntime): StepOutcome {
  const abandoned = runtime.record.abandoned;
  return stamp(
    runtime,
    blocked(
      "attempt_abandoned",
      `Attempt ${String(abandoned?.attempt ?? 1)} of flow "${runtime.record.flowId}" was abandoned` +
        `${abandoned?.reason !== undefined ? ` (${abandoned.reason})` : ""}. ` +
        "Its payloads are kept for the report but it cannot be advanced. " +
        "Drive the current attempt by flow_id.",
      { abandoned, flow_id: runtime.record.flowId },
    ),
  );
}

/**
 * `INPUT_REQUIRED`, with the shape spelled out rather than implied.
 *
 * The raw declaration is not handed back: `{name: "ExampleInputId", schema:
 * {properties: {city_code}}}` reads as an instruction to nest, and nesting is
 * the one mistake that fails silently all the way to a validation error at an
 * unrelated JSONPath. `describeInputs` states the keys instead.
 */
export function inputRequired(
  runtime: FlowRuntime,
  step: MappedStep,
  message: string,
  problems?: InputProblem[],
): StepOutcome {
  return {
    outcome: "INPUT_REQUIRED",
    message,
    step_key: step.actionId,
    action: step.actionType,
    inputs_required: describeInputs(specFor(step, runtime.config)),
    ...(problems !== undefined && problems.length > 0
      ? { input_problems: problems }
      : {}),
  };
}

export function listening(step: MappedStep): StepOutcome {
  return {
    outcome: "WAITING",
    message: `Waiting for the participant to send ${step.actionType}. Call flow_await.`,
    step_key: step.actionId,
    action: step.actionType,
    expected_action: step.actionType,
  };
}

/**
 * Attach the run's transaction id, when there is one to attach.
 *
 * An unbound run has no id — not a blank one, not a provisional one. The
 * placeholder record carries a candidate purely so downstream reads have a
 * key to miss on, and leaking it to the caller would recreate exactly the bug
 * this change removes: a handle that looks usable and names nothing.
 */
export function stamp(runtime: FlowRuntime, outcome: StepOutcome): StepOutcome {
  return runtime.bound
    ? { ...outcome, transaction_id: runtime.record.transactionId }
    : outcome;
}
