import {
  makeApiMissedStep,
  makeFormMissedStep,
} from "@/modules/flow/engine/missed-step-factory.js";
import { findStepInFlow } from "@/modules/flow/engine/sequence-lookup.js";
import type { Resolver } from "@/modules/flow/engine/resolvers/resolver-types.js";

/**
 * The terminal resolver: whatever the sequence and the extras both declined.
 *
 * It always consumes, so replay cannot stall, and it never touches the cursor,
 * so an out-of-order exchange does not let the flow skip the step it actually
 * still owes. The classification is what ends up in the compliance report.
 */
export const missedResolver: Resolver = (ctx, state) => {
  const { apiData, flowSequence } = ctx;
  const cursor = state.cursor.value;

  if (apiData.entryType === "API") {
    if (cursor >= flowSequence.length) {
      state.mappedFlow.missedSteps.push(
        makeApiMissedStep(apiData, { kind: "BEYOND" }),
      );
      return { consumed: true };
    }

    const futureStepIndex = findStepInFlow(apiData.action, flowSequence, cursor);
    state.mappedFlow.missedSteps.push(
      futureStepIndex !== -1
        ? makeApiMissedStep(apiData, {
            kind: "OUT_OF_ORDER",
            futureStepIndex,
            cursor,
          })
        : makeApiMissedStep(apiData, { kind: "NOT_FOUND" }),
    );
    return { consumed: true };
  }

  if (cursor >= flowSequence.length) {
    state.mappedFlow.missedSteps.push(
      makeFormMissedStep(apiData, { kind: "BEYOND" }),
    );
    return { consumed: true };
  }

  const futureStepIndex = findStepInFlow(apiData.formType, flowSequence, cursor);
  state.mappedFlow.missedSteps.push(
    futureStepIndex !== -1
      ? makeFormMissedStep(apiData, {
          kind: "OUT_OF_ORDER",
          futureStepIndex,
          cursor,
        })
      : makeFormMissedStep(apiData, { kind: "NOT_FOUND" }),
  );
  return { consumed: true };
};
