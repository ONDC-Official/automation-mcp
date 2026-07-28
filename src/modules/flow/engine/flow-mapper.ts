import type {
  EngineFlow,
  EngineSessionData,
  EngineTransaction,
  FlowMap,
  FlowStatusCode,
  MappedStep,
} from "@/modules/flow/engine/engine-types.js";
import { FlowMapBuilder } from "@/modules/flow/engine/flow-map-builder.js";

/**
 * The engine's public surface: two pure functions over recorded history.
 *
 * Ported from the workbench's mock-playground service
 * (`src/service/flows/flow-mapper.ts`). Kept close to the original on purpose —
 * this is the behaviour the whole workbench is calibrated against, and a
 * "cleaner" rewrite that diverges anywhere is a bug wearing better clothes.
 */

/** Statuses that mean *someone* still has to do something about this step. */
const ACTIONABLE_STATUSES: ReadonlySet<MappedStep["status"]> = new Set([
  "LISTENING",
  "RESPONDING",
  "INPUT-REQUIRED",
  "WAITING-SUBMISSION",
]);

export interface NextActionMeta {
  /** The one actionable step in the strict sequence, if any. */
  sequenceNext?: MappedStep | undefined;
  /** Actionable side-channel steps. Zero or many, never ordered. */
  extrasNext?: MappedStep[] | undefined;
}

/** The whole derived map: sequence, extras, missed steps, reference data. */
export function getFlowCompleteStatus(
  transactionData: EngineTransaction,
  flow: EngineFlow,
  flowStatus: FlowStatusCode,
  mockSessionData: EngineSessionData,
  extraFlowStatuses?: ReadonlyMap<string, FlowStatusCode>,
): FlowMap {
  return new FlowMapBuilder(
    transactionData,
    flow,
    flowStatus,
    mockSessionData,
    extraFlowStatuses,
  ).build();
}

/**
 * Just the actionable parts of the map — what the loop reads every turn.
 *
 * The sequence yields at most one: a flow is a line, and only its head can
 * move. Extras yield any number, because side-channel steps have no order
 * relative to each other.
 */
export function getNextActions(
  transactionData: EngineTransaction,
  flow: EngineFlow,
  flowStatus: FlowStatusCode,
  mockSessionData: EngineSessionData,
  extraFlowStatuses?: ReadonlyMap<string, FlowStatusCode>,
): NextActionMeta {
  const flowDetails = getFlowCompleteStatus(
    transactionData,
    flow,
    flowStatus,
    mockSessionData,
    extraFlowStatuses,
  );

  const sequenceNext = flowDetails.sequence.find((step) =>
    ACTIONABLE_STATUSES.has(step.status),
  );
  const extrasNext = (flowDetails.extraSteps ?? []).filter((step) =>
    ACTIONABLE_STATUSES.has(step.status),
  );

  return { sequenceNext, extrasNext };
}

/**
 * Back-compat alias from the upstream port. Returns only the strict sequence's
 * next actionable step; new code uses {@link getNextActions}.
 */
export function getNextActionMetaData(
  transactionData: EngineTransaction,
  flow: EngineFlow,
  flowStatus: FlowStatusCode,
  mockSessionData: EngineSessionData,
): MappedStep | undefined {
  return getNextActions(transactionData, flow, flowStatus, mockSessionData)
    .sequenceNext;
}
