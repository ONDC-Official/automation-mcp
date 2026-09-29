import type { BatchRole } from "@/modules/batch/batch.schema.js";

/**
 * What a build needs beyond what its flow definition already says.
 *
 * Which flow to run and its step ids come from the flow itself
 * (`batch.flow-shape.ts`); what cannot be read off a flow definition is kept
 * here, per published build, because each was found by running against the
 * live mock seller:
 *
 * - the flow to run when the caller names none;
 * - the stations the mock seller will actually route between (its catalog
 *   lists more than its search accepts, and a station outside its route makes
 *   it answer "not serviceable" — which later surfaces as a step blocked for
 *   "missing fulfillments");
 * - repairs for defects in the *published* config.
 */

export interface StepOverrideContext {
  role: BatchRole;
  counterpartySubscriberUrl: string;
}

export interface VersionPreset {
  /** The order journey run when no `flow_id` is given. */
  defaultFlowId: string;
  /** `saveData` key on the seller's first search reply that lists its stations. */
  stationsBusinessDataKey: string;
  /** Stations the mock seller routes between. Unset: use the catalog's own. */
  serviceableStationCodes?: string[];
  /**
   * Repairs for the *published* config, as `stepKey → JSONPath → value` for
   * `flow_proceed`'s `payload_overrides` (`OVERRIDES-PLAN.md`). The validation
   * gate still runs on the patched payload, so a repair that does not fix the
   * finding still blocks. Keyed by step key, so a repair applies to every flow
   * of the version that contains that step.
   */
  stepOverrides?: (
    ctx: StepOverrideContext,
  ) => Record<string, Record<string, unknown>>;
}

const stations = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `MOCK_STATION_${String(i + 1)}`);

const PRESETS: Record<string, VersionPreset> = {
  "ONDC:TRV11|2.0.0|Metro": {
    defaultFlowId: "ORDER_TO_CONFIRM_TO_JOURNEY_COMPLETION_SJT",
    stationsBusinessDataKey: "fulfillments",
    // The mock seller builds its answer from two routes (37 and 9 stops) and
    // throws unless *both* contain the pair, so only the shorter route's
    // stations are serviceable.
    serviceableStationCodes: [1, 2, 3, 5, 6, 12, 18, 28, 37].map(
      (n) => `MOCK_STATION_${String(n)}`,
    ),
  },
  "ONDC:TRV11|2.0.1|Metro": {
    defaultFlowId: "STATION_CODE_FLOW_ORDER",
    stationsBusinessDataKey: "fulfillments",
    // The live mock seller routes a single 22-stop line; its catalog lists more.
    serviceableStationCodes: stations(22),
    // Published `search2_METRO_201` assigns `context.bpp_uri = sessionData.bppUri`
    // without the `[0]` its neighbouring `bpp_id` line has, so a list reaches a
    // string field. The BPP's URI is the seller endpoint the buyer sends to.
    stepOverrides: ({ role, counterpartySubscriberUrl }) => {
      const overrides: Record<string, Record<string, unknown>> = {};
      if (role === "initiator") {
        overrides["search2_METRO_201"] = {
          "$.context.bpp_uri": counterpartySubscriberUrl,
        };
      }
      return overrides;
    },
  },
};

export function presetKey(
  domain: string,
  version: string,
  usecase: string,
): string {
  return `${domain}|${version}|${usecase}`;
}

export function knownPresets(): string[] {
  return Object.keys(PRESETS);
}

export function findPreset(
  domain: string,
  version: string,
  usecase: string,
): VersionPreset | undefined {
  return PRESETS[presetKey(domain, version, usecase)];
}
