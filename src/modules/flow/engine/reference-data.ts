import type {
  EngineFlow,
  EngineSessionData,
} from "@/modules/flow/engine/engine-types.js";

/**
 * The resolved artefacts a form step needs, keyed by step.
 *
 * For a form step the interesting value is whatever was saved under the step's
 * own key — the form's URL when the counterparty hosts it, or the resolved HTML
 * once the receiver has fetched it. Arrays are unwrapped to their first element
 * because JSONPath saves always produce a list, and a form is a single thing.
 */
export function getReferenceData(
  sessionData: EngineSessionData,
  flow: EngineFlow,
): Record<string, unknown> {
  const referenceData: Record<string, unknown> = {};

  const formSteps = flow.sequence.filter(
    (step) => step.type === "DYNAMIC_FORM" || step.type === "HTML_FORM",
  );

  for (const step of formSteps) {
    const value = sessionData[step.key];
    referenceData[step.key] = Array.isArray(value) ? value[0] : value;
  }

  return referenceData;
}
