import type {
  EngineFlow,
  EngineSequenceStep,
  EngineSessionData,
  EngineTransaction,
  FlowMap,
  FlowStatusCode,
  Owner,
} from "@/modules/flow/engine/engine-types.js";
import { buildPendingStep } from "@/modules/flow/engine/pending-step.js";
import { getReferenceData } from "@/modules/flow/engine/reference-data.js";
import {
  reduceApiDataList,
  sortForReplay,
} from "@/modules/flow/engine/reduce-history.js";
import {
  createEmptyExtrasState,
  createExtrasIndex,
  createExtrasResolver,
  type ExtrasIndex,
} from "@/modules/flow/engine/resolvers/extras-resolver.js";
import { missedResolver } from "@/modules/flow/engine/resolvers/missed-resolver.js";
import type {
  Resolver,
  ResolverContext,
  ResolverState,
} from "@/modules/flow/engine/resolvers/resolver-types.js";
import { sequenceResolver } from "@/modules/flow/engine/resolvers/sequence-resolver.js";

/**
 * Where a flow has got to, derived from scratch on every read.
 *
 * ## No step pointer, ever
 *
 * There is no stored "current step". The map is rebuilt by replaying the
 * recorded exchanges in timestamp order and walking a cursor forward; every
 * status falls out of that replay. This is the property that makes the whole
 * design safe: two concurrent reads agree, a crashed dispatch leaves nothing
 * stale behind, and a transaction that is restored from cache is instantly
 * consistent with whatever actually happened on the wire.
 *
 * A stored pointer would have to be updated in the same breath as the record,
 * and every place that failed to would silently desynchronise the loop.
 */
export class FlowMapBuilder {
  readonly #transactionData: EngineTransaction;
  readonly #flowSequence: EngineSequenceStep[];
  readonly #extrasIndex: ExtrasIndex;
  readonly #subscriberType: Owner;
  readonly #flowStatus: FlowStatusCode;
  readonly #extraFlowStatuses: ReadonlyMap<string, FlowStatusCode> | undefined;
  readonly #mappedFlow: FlowMap;
  readonly #cursor = { value: 0 };
  readonly #resolvers: Resolver[];

  constructor(
    transactionData: EngineTransaction,
    flow: EngineFlow,
    flowStatus: FlowStatusCode,
    mockSessionData: EngineSessionData,
    extraFlowStatuses?: ReadonlyMap<string, FlowStatusCode>,
  ) {
    this.#transactionData = transactionData;
    this.#subscriberType = transactionData.subscriberType;
    this.#flowStatus = flowStatus;
    this.#extraFlowStatuses = extraFlowStatuses;

    // A flow can grow at runtime: `MORE_SEQUENCE` is how a config appends steps
    // it only learns about mid-transaction (an extra installment, a repeat).
    const addedSequence = mockSessionData.MORE_SEQUENCE ?? [];
    this.#flowSequence = [...flow.sequence, ...addedSequence];

    this.#extrasIndex = createExtrasIndex(flow.extraSequence ?? []);

    this.#mappedFlow = {
      sequence: [],
      missedSteps: [],
      extraSteps: [],
      reference_data: getReferenceData(mockSessionData, flow),
    };

    const extrasState = createEmptyExtrasState();
    this.#resolvers = [
      sequenceResolver,
      createExtrasResolver(this.#extrasIndex, extrasState),
      missedResolver,
    ];
  }

  build(): FlowMap {
    const apiList = sortForReplay(
      reduceApiDataList(this.#transactionData.apiList),
    );

    for (const apiData of apiList) {
      const ctx: ResolverContext = {
        apiData,
        flowSequence: this.#flowSequence,
        subscriberType: this.#subscriberType,
        flowStatus: this.#flowStatus,
        extraFlowStatuses: this.#extraFlowStatuses,
      };
      const state: ResolverState = {
        mappedFlow: this.#mappedFlow,
        cursor: this.#cursor,
      };
      for (const resolver of this.#resolvers) {
        if (resolver(ctx, state).consumed) break;
      }
    }

    // Everything from the cursor on is still pending. Only the first of them
    // is actionable; the rest are simply not reached yet.
    for (let i = this.#cursor.value; i < this.#flowSequence.length; i++) {
      const step = this.#flowSequence[i];
      if (!step) continue;
      const pendings = buildPendingStep({
        step,
        index: i,
        isImmediateNext: i === this.#cursor.value,
        subscriberType: this.#subscriberType,
        flowStatus: this.#flowStatus,
      });
      for (const pending of pendings) {
        this.#mappedFlow.sequence.push(pending);
      }
    }

    return this.#mappedFlow;
  }
}
