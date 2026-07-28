import type {
  ApiHistory,
  EngineSequenceStep,
  FlowMap,
  FlowStatusCode,
  Owner,
} from "@/modules/flow/engine/engine-types.js";

/**
 * The replay contract.
 *
 * Every recorded exchange is offered to each resolver in turn until one claims
 * it. The order — sequence, then extras, then missed — *is* the precedence
 * rule: an exchange that fits the step we are waiting for advances the flow; one
 * that matches a declared side-channel step is filed there; anything left over
 * is a compliance finding.
 */

export interface ResolverContext {
  apiData: ApiHistory;
  flowSequence: EngineSequenceStep[];
  /** The **participant under test's** side. */
  subscriberType: Owner;
  flowStatus: FlowStatusCode;
  extraFlowStatuses?: ReadonlyMap<string, FlowStatusCode> | undefined;
}

export interface ResolverState {
  mappedFlow: FlowMap;
  /** Index of the first step not yet completed. Mutated by the resolvers. */
  cursor: { value: number };
}

export interface ResolverOutcome {
  consumed: boolean;
}

export type Resolver = (
  ctx: ResolverContext,
  state: ResolverState,
) => ResolverOutcome;
