import { ValidationError } from "@/lib/errors.js";
import type { UpstreamFlow } from "@/modules/catalog/catalog.schema.js";
import type {
  EngineFlow,
  EngineSequenceStep,
  Owner,
  StepInputConfig,
} from "@/modules/flow/engine/engine-types.js";

/**
 * Turn a published flow definition into what the engine can replay.
 *
 * The catalog's `Upstream*` schemas are deliberately loose — the config-service
 * is developed elsewhere and a strict parse would turn a harmless new field
 * into an outage. The engine is the opposite: every step must have a
 * definite owner, or the loop cannot know whether to send or to wait. This
 * function is where the one becomes the other, and it is called **once, at
 * `flow_start`**, so a flow that cannot be driven fails immediately with a
 * legible reason instead of halfway through a transaction.
 *
 * `ownerByKey` is the fallback: the flow definition and the mock-runner config
 * describe the same steps, and where the flow omits an owner the config
 * usually has one.
 */
export interface ToEngineFlowOptions {
  /** Step key → owner, from the flow's mock-runner config. */
  ownerByKey?: ReadonlyMap<string, string>;
}

export function toEngineFlow(
  flow: UpstreamFlow,
  options: ToEngineFlowOptions = {},
): EngineFlow {
  const sequence = flow.sequence.map((step) =>
    toEngineStep(step, flow.id, options.ownerByKey),
  );
  const extraSequence = flow.extraSequence.map((step) =>
    toEngineStep(step, flow.id, options.ownerByKey),
  );

  return {
    id: flow.id,
    ...(flow.description !== undefined ? { description: flow.description } : {}),
    sequence,
    extraSequence,
  };
}

function toEngineStep(
  step: UpstreamFlow["sequence"][number],
  flowId: string,
  ownerByKey: ReadonlyMap<string, string> | undefined,
): EngineSequenceStep {
  const owner = resolveOwner(step, flowId, ownerByKey);

  return {
    key: step.key,
    type: step.type,
    owner,
    // Upstream leaves both off routinely; the engine reads them on every step.
    unsolicited: step.unsolicited ?? false,
    pair: step.pair ?? null,
    ...(step.description !== undefined ? { description: step.description } : {}),
    ...(step.input !== undefined
      ? { input: step.input as unknown as StepInputConfig }
      : {}),
    ...(step.expect !== undefined ? { expect: step.expect } : {}),
    ...(step.label !== undefined ? { label: step.label } : {}),
    ...(step.force_proceed !== undefined
      ? { force_proceed: step.force_proceed }
      : {}),
    ...(step.repeat !== undefined ? { repeat: step.repeat } : {}),
    ...(typeof step["manual"] === "boolean"
      ? { manual: step["manual"] }
      : {}),
    ...(typeof step["stackable"] === "boolean"
      ? { stackable: step["stackable"] }
      : {}),
  };
}

function resolveOwner(
  step: UpstreamFlow["sequence"][number],
  flowId: string,
  ownerByKey: ReadonlyMap<string, string> | undefined,
): Owner {
  const candidate = step.owner ?? ownerByKey?.get(step.key);
  const normalised = candidate?.trim().toUpperCase();

  if (normalised === "BAP" || normalised === "BPP") return normalised;

  throw new ValidationError(
    `Flow "${flowId}" step "${step.key}" declares no owner, and its mock config has none either. ` +
      "Without an owner there is no way to tell whether this mock should send the step or wait for it. " +
      "Pick a different flow.",
    { flow_id: flowId, step_key: step.key, step_type: step.type },
  );
}
