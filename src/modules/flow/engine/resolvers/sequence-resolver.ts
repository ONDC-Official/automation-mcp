import type { Resolver } from "@/modules/flow/engine/resolvers/resolver-types.js";

/**
 * Advance the strict sequence by one, if this exchange is the step we are on.
 *
 * Matching is on the **action type**, not the step key: the counterparty never
 * sees our step keys, only `on_search` and friends. That is also why the cursor
 * only ever moves forward one step at a time — two consecutive `on_status`
 * steps are distinguished by position, nothing else.
 */
export const sequenceResolver: Resolver = (ctx, state) => {
  const { apiData, flowSequence } = ctx;
  const cursor = state.cursor.value;

  if (cursor >= flowSequence.length) {
    return { consumed: false };
  }

  const expectedStep = flowSequence[cursor];
  if (!expectedStep) return { consumed: false };

  if (apiData.entryType === "API") {
    if (expectedStep.type === apiData.action) {
      state.mappedFlow.sequence.push({
        status: "COMPLETE",
        actionId: expectedStep.key,
        owner: expectedStep.owner,
        actionType: expectedStep.type,
        input: expectedStep.input,
        payloads: apiData,
        index: cursor,
        unsolicited: expectedStep.unsolicited,
        pairActionId: expectedStep.pair,
        description: expectedStep.description,
        label: expectedStep.label,
      });
      state.cursor.value = cursor + 1;
      return { consumed: true };
    }
    return { consumed: false };
  }

  if (expectedStep.type === apiData.formType) {
    state.mappedFlow.sequence.push({
      status: "COMPLETE",
      actionId: expectedStep.key,
      owner: expectedStep.owner,
      actionType: expectedStep.type,
      input: expectedStep.input,
      index: cursor,
      unsolicited: expectedStep.unsolicited,
      pairActionId: expectedStep.pair,
      description: expectedStep.description,
      label: expectedStep.label,
      payloads: apiData,
    });
    state.cursor.value = cursor + 1;
    return { consumed: true };
  }

  return { consumed: false };
};
