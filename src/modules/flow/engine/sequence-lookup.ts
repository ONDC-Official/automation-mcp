import type { EngineSequenceStep } from "@/modules/flow/engine/engine-types.js";

/** Index of the next step of this type at or after `startIndex`, else `-1`. */
export function findStepInFlow(
  actionType: string,
  flowSequence: EngineSequenceStep[],
  startIndex: number,
): number {
  for (let i = startIndex; i < flowSequence.length; i++) {
    if (flowSequence[i]?.type === actionType) {
      return i;
    }
  }
  return -1;
}
