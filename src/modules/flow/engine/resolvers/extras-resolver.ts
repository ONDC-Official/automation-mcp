import type {
  EngineSequenceStep,
  MappedStep,
} from "@/modules/flow/engine/engine-types.js";
import { buildPendingStep } from "@/modules/flow/engine/pending-step.js";
import type { Resolver } from "@/modules/flow/engine/resolvers/resolver-types.js";

/**
 * Steps that can happen **beside** the strict sequence rather than in it — an
 * unsolicited `on_status`, a cancellation, a side-channel update. They have no
 * position, can repeat, and must not move the sequence cursor.
 *
 * The one piece of real machinery here is **pair placeholders**. When a
 * declared extras step lands and it names a `pair`, the response we owe (or
 * await) is materialised immediately as a placeholder tagged with the incoming
 * `message_id`. That tag is what lets the reply be matched to *this* exchange
 * rather than to some other instance of the same action — extras repeat, so
 * matching on action type alone would attach the reply to the wrong one.
 */

const FORM_TYPES = new Set(["HTML_FORM", "DYNAMIC_FORM", "HTML_FORM_MULTI"]);

export interface ExtrasIndex {
  byType: Map<string, EngineSequenceStep>;
  byKey: Map<string, EngineSequenceStep>;
}

export interface ExtrasState {
  /** `${stepKey}::${messageId}` → indices into `mappedFlow.extraSteps`. */
  pendingPlaceholders: Map<string, number[]>;
}

/**
 * Index the extras by type and key.
 *
 * Both rejections are structural, not stylistic: extras are matched by action
 * type, so a duplicate type has no unambiguous answer; and a form has to sit at
 * a position in the sequence to mean anything, so a form in extras is a
 * mis-authored flow. Failing here — at flow start — beats failing mid-loop.
 */
export function createExtrasIndex(
  extraSequence: EngineSequenceStep[],
): ExtrasIndex {
  const byType = new Map<string, EngineSequenceStep>();
  const byKey = new Map<string, EngineSequenceStep>();

  for (const step of extraSequence) {
    if (FORM_TYPES.has(step.type)) {
      throw new Error(
        `extraSequence entry "${step.key}" has form-type "${step.type}"; forms must live only in strict sequence`,
      );
    }
    const existing = byType.get(step.type);
    if (existing) {
      throw new Error(
        `extraSequence has duplicate type "${step.type}" (keys: "${existing.key}" and "${step.key}")`,
      );
    }
    byType.set(step.type, step);
    byKey.set(step.key, step);
  }

  return { byType, byKey };
}

export function createEmptyExtrasState(): ExtrasState {
  return { pendingPlaceholders: new Map() };
}

export function createExtrasResolver(
  index: ExtrasIndex,
  extrasState: ExtrasState,
): Resolver {
  return (ctx, state) => {
    const { apiData } = ctx;

    if (apiData.entryType !== "API") {
      return { consumed: false };
    }

    const extraStep = index.byType.get(apiData.action);
    if (!extraStep) {
      return { consumed: false };
    }

    state.mappedFlow.extraSteps ??= [];
    const extraSteps = state.mappedFlow.extraSteps;

    // Resolve an existing placeholder for this (step, messageId) if there is one.
    const placeholderKey = `${extraStep.key}::${apiData.messageId}`;
    const matchingIndices = extrasState.pendingPlaceholders.get(placeholderKey);
    if (matchingIndices && matchingIndices.length > 0) {
      for (const idx of matchingIndices) {
        const placeholder = extraSteps[idx];
        if (!placeholder) continue;
        placeholder.status = "COMPLETE";
        placeholder.payloads = apiData;
      }
      extrasState.pendingPlaceholders.delete(placeholderKey);
      return { consumed: true };
    }

    // ADD path: record the matched extras step as complete.
    extraSteps.push({
      status: "COMPLETE",
      actionId: extraStep.key,
      owner: extraStep.owner,
      actionType: extraStep.type,
      input: extraStep.input,
      payloads: apiData,
      index: -1,
      unsolicited: extraStep.unsolicited,
      pairActionId: extraStep.pair,
      description: extraStep.description,
      label: extraStep.label,
      isExtraStep: true,
    });

    if (!extraStep.pair) {
      return { consumed: true };
    }

    const pairStep = index.byKey.get(extraStep.pair);
    if (!pairStep) {
      // Asymmetric / dangling pair reference — tolerated; no placeholder.
      return { consumed: true };
    }

    // The reply may already have been replayed (history is not ordered by
    // causality, only by timestamp). Don't create a placeholder for it.
    const pairAlreadyComplete = extraSteps.some(
      (candidate: MappedStep) =>
        candidate.actionId === pairStep.key &&
        candidate.status === "COMPLETE" &&
        candidate.payloads?.entryType === "API" &&
        candidate.payloads.messageId === apiData.messageId,
    );
    if (pairAlreadyComplete) {
      return { consumed: true };
    }

    const pairStatus =
      ctx.extraFlowStatuses?.get(pairStep.key) ?? ctx.flowStatus;
    const placeholders = buildPendingStep({
      step: pairStep,
      index: -1,
      isImmediateNext: true,
      subscriberType: ctx.subscriberType,
      flowStatus: pairStatus,
    });

    const pairKey = `${pairStep.key}::${apiData.messageId}`;
    for (const placeholder of placeholders) {
      placeholder.isExtraStep = true;
      placeholder.awaitingMessageId = apiData.messageId;
      placeholder.pairActionId = pairStep.pair;

      const idx = extraSteps.length;
      extraSteps.push(placeholder);

      const existing = extrasState.pendingPlaceholders.get(pairKey) ?? [];
      existing.push(idx);
      extrasState.pendingPlaceholders.set(pairKey, existing);
    }

    return { consumed: true };
  };
}
