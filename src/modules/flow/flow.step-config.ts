import {
  type InputSpec,
  mockStepInputs,
  resolveInputSpec,
} from "@/modules/catalog/catalog.inputs.js";
import type { UpstreamMockConfig } from "@/modules/catalog/catalog.schema.js";
import type {
  EngineFlow,
  MappedStep,
} from "@/modules/flow/engine/engine-types.js";
import { ValidationError } from "@/lib/errors.js";

/**
 * What a flow's published mock config says about one of its steps.
 *
 * These read the config and nothing else — no session, no record, no runtime —
 * which is why they can be shared. `saveDataFor` in particular is called from
 * **both** directions: by the outbound dispatch after a payload is generated,
 * and by the receiver after an inbound call is accepted. Those two calls must
 * stay identical, and having one home for the function is what makes that
 * structural rather than a thing somebody has to remember.
 */

/** Step key → owner, read off the mock config for `toEngineFlow`'s fallback. */
export function ownerByActionId(
  config: UpstreamMockConfig,
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const step of config.steps) {
    if (step.owner !== undefined) owners.set(step.action_id, step.owner);
  }
  return owners;
}

/**
 * Every flow step must resolve to a config step, or generation fails mid-loop.
 *
 * Checked at `flow_start`, when the caller can still choose another flow.
 */
export function assertStepsAreRunnable(
  flow: EngineFlow,
  config: UpstreamMockConfig,
): void {
  const known = new Set(config.steps.map((step) => step.action_id));
  const missing = [...flow.sequence, ...(flow.extraSequence ?? [])]
    .map((step) => step.key)
    .filter((key) => !known.has(key));

  if (missing.length > 0) {
    throw new ValidationError(
      `Flow "${flow.id}" declares step(s) its mock config does not implement: ${missing.join(", ")}. ` +
        "This flow cannot be driven; pick another one.",
      { flow_id: flow.id, missing_steps: missing },
    );
  }
}

/** The `saveData` map for one step, across main and extra steps. */
export function saveDataFor(
  config: UpstreamMockConfig,
  actionId: string,
): Record<string, string> {
  const step = config.steps.find((entry) => entry.action_id === actionId);
  const saveData = step?.mock?.saveData;
  return isStringMap(saveData) ? saveData : {};
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

/**
 * What a step declares it needs, from both places it can be declared.
 *
 * The mock config's declaration is passed second — it wins, being the one the
 * step's `generate` was authored against.
 */
export function specFor(step: MappedStep, config: UpstreamMockConfig): InputSpec {
  return resolveInputSpec(step.input, mockStepInputs(config, step.actionId));
}
