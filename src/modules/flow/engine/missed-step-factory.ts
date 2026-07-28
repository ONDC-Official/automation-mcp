import type {
  MappedStep,
  ReducedApiData,
  ReducedFormData,
} from "@/modules/flow/engine/engine-types.js";
import { deriveOwnerFromAction } from "@/modules/flow/engine/owner-utils.js";

/**
 * Exchanges that happened but do not belong where the flow is.
 *
 * These are the compliance findings the report is built from, so the
 * *distinction* between the three kinds is the point:
 *
 * - `OUT_OF_ORDER` — the action does appear later in the flow, so the
 *   counterparty jumped ahead without completing the current step.
 * - `NOT_FOUND` — the action is nowhere in this flow at all.
 * - `BEYOND` — the flow had already finished when this arrived.
 *
 * Recording them never advances the cursor: a step that was skipped stays
 * pending, which is exactly how a skipped step should read.
 */

export type MissedKind =
  | { kind: "OUT_OF_ORDER"; futureStepIndex: number; cursor: number }
  | { kind: "NOT_FOUND" }
  | { kind: "BEYOND" };

export function makeApiMissedStep(
  data: ReducedApiData,
  opts: MissedKind,
): MappedStep {
  if (opts.kind === "OUT_OF_ORDER") {
    return {
      status: "COMPLETE",
      actionId: data.action,
      owner: deriveOwnerFromAction(data.action),
      actionType: data.action,
      input: undefined,
      index: opts.futureStepIndex,
      unsolicited: false,
      pairActionId: null,
      description: `action executed out of order - expected at step ${String(opts.futureStepIndex)}, but step ${String(opts.cursor)} not completed`,
      missedStep: true,
      payloads: data,
    };
  }

  return {
    status: "COMPLETE",
    actionId: data.action,
    owner: deriveOwnerFromAction(data.action),
    actionType: data.action,
    input: undefined,
    index: -1,
    unsolicited: false,
    pairActionId: null,
    description:
      opts.kind === "BEYOND"
        ? "action beyond flow sequence"
        : "action not found in flow sequence",
    missedStep: true,
    payloads: data,
  };
}

export function makeFormMissedStep(
  data: ReducedFormData,
  opts: MissedKind,
): MappedStep {
  if (opts.kind === "OUT_OF_ORDER") {
    return {
      status: "COMPLETE",
      actionId: data.formId,
      owner: "BAP",
      actionType: data.formType,
      input: undefined,
      index: opts.futureStepIndex,
      unsolicited: false,
      pairActionId: null,
      description: `form executed out of order - expected at step ${String(opts.futureStepIndex)}, but step ${String(opts.cursor)} not completed`,
      missedStep: true,
      payloads: data,
    };
  }

  return {
    status: "COMPLETE",
    actionId: data.formId,
    owner: "BAP",
    actionType: data.formType,
    input: undefined,
    index: -1,
    unsolicited: false,
    pairActionId: null,
    description:
      opts.kind === "BEYOND"
        ? "form beyond flow sequence"
        : "form not found in flow sequence",
    missedStep: true,
    payloads: data,
  };
}
