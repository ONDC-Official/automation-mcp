import type { Owner } from "@/modules/flow/engine/engine-types.js";

/**
 * Guess which side sent an action, for exchanges that matched no step.
 *
 * Only ever used to label a *missed* step, where there is no flow entry to read
 * an owner from. The `on_` convention holds across every ONDC domain, so the
 * guess is reliable enough for a diagnostic and is never used to decide who
 * acts next.
 */
export function deriveOwnerFromAction(action: string): Owner {
  return action.startsWith("on_") ? "BPP" : "BAP";
}
