/**
 * Which modules this process runs.
 *
 * Before this file there were **three** hand-written lists that had to agree —
 * `mcp/capabilities.ts`, `app.ts`, and `transport/receiver.lifecycle.ts` — and
 * nothing at boot could turn a module off. The four notionally-optional
 * modules were all constructed unconditionally and merely made *inert* one
 * layer down, so `FEEDBACK_DISABLED=1` still left `feedback_submit_report` in
 * the model's tool list.
 *
 * ## The gate can only remove, never add
 *
 * Every existing switch is **ANDed** with the profile, never replaced by it.
 * That is what keeps `MIRROR_ENDPOINT_URL`'s rule intact — *"unset is the only
 * off switch, because a flag you can turn on with nowhere to send reads as
 * configured and does nothing"*. Listing `mirror` in a profile means *may
 * run*; the endpoint still decides whether it does.
 *
 * It also means the default changes nothing: `PROFILE` defaults to `full`, and
 * every flag that worked yesterday works identically today.
 */

/**
 * Declaration order is registration order.
 *
 * `mcp/capabilities.ts` iterates this array, so the sequence tools are
 * registered in lives here rather than in the shape of a literal.
 */
export const MODULE_NAMES = [
  "health",
  "catalog",
  "protocol",
  "session",
  "record",
  "validate",
  "transport",
  "flow",
  "forms",
  "batch",
  "feedback",
  "metrics",
  "mirror",
  "ui",
] as const;

export type ModuleName = (typeof MODULE_NAMES)[number];

/**
 * What each module needs switched on to be *usable*.
 *
 * Deliberately **not** the import graph. Every service is still constructed
 * whatever the profile says — the gate governs the surface (which tools,
 * resources and routes exist), not the object graph, and the
 * `record`/`session`/`catalog`/`flow` core has genuine import cycles that
 * could not be pulled apart at boot even if this wanted to.
 *
 * So the question each entry answers is narrow: *if this module's tools are
 * present, which other module's tools must also be present for a model to get
 * anywhere?* `flow` without `session` leaves nothing able to open a session;
 * `session` without `catalog` leaves no way to name a build. `validate`
 * without anything is fine — its gates fail open by design, and
 * `VALIDATION_MODE=off` was always a supported configuration.
 *
 * `record` is a requirement of `flow` for a reason worth keeping: every
 * session-scoped result carries the event journal delta, and that is
 * *"deliberately not something a tool can opt out of"* — it is the only
 * channel guaranteed to put what happened on the wire in front of the model.
 */
const REQUIRES: Record<ModuleName, readonly ModuleName[]> = {
  health: [],
  catalog: [],
  record: [],
  // Builds are validated against the catalog before a spec is fetched: the
  // config-service answers an unknown build with an empty-ish document rather
  // than a 404, so without that check a typo reads as "this build publishes
  // nothing". Same trap `assertBuild` closes for flows.
  protocol: ["catalog"],
  validate: [],
  transport: [],
  metrics: [],
  mirror: [],
  ui: [],
  feedback: [],
  session: ["catalog"],
  flow: ["session", "catalog", "record"],
  forms: ["flow"],
  // Orchestrates many independent flow runs; needs everything a single run
  // needs, since it is that same loop run many times concurrently.
  batch: ["session", "catalog", "record", "flow"],
};

/**
 * The modules that make this a mock network participant at all.
 *
 * Everything outside this set is an observer — a corpus, a scrape endpoint, a
 * viewer — and can be switched off without changing what goes on the wire.
 * Everything inside it is one unit: the `record`/`session`/`catalog`/`flow`
 * core has genuine import cycles and cannot be pulled apart at boot.
 */
const CORE: readonly ModuleName[] = [
  "health",
  "catalog",
  "session",
  "record",
  "validate",
  "transport",
  "flow",
  "forms",
];

export const PROFILES = {
  /** Everything. The default, and byte-identical to the old behaviour. */
  full: MODULE_NAMES,
  /** Drive flows and keep metrics; no viewer, no corpus, no mirror. */
  driver: [...CORE, "metrics", "protocol", "batch"] as readonly ModuleName[],
  /** The loop and nothing else. */
  minimal: CORE,
} satisfies Record<string, readonly ModuleName[]>;

export type ProfileName = keyof typeof PROFILES;

/**
 * The slice of configuration this module reads.
 *
 * Structural rather than `Config` on purpose: `env.ts` imports this file for
 * its boot-time refusal, so importing `Config` back would make the two types
 * circular and TypeScript would infer `any` for the whole environment schema.
 */
export interface FeatureConfig {
  readonly PROFILE: ProfileName;
  readonly MODULES_DISABLED: readonly string[];
  readonly MODULES_ENABLED: readonly string[];
  readonly UI_ENABLED: boolean;
  readonly METRICS_ENABLED: boolean;
  readonly FEEDBACK_DISABLED: boolean;
  readonly MIRROR_ENDPOINT_URL?: string | undefined;
}

export interface Features {
  /** Whether this module runs in this process. */
  enabled(name: ModuleName): boolean;
  /** Every enabled module, in registration order. */
  readonly names: readonly ModuleName[];
  readonly profile: ProfileName;
}

/** Names a profile grants, minus `MODULES_DISABLED`, plus `MODULES_ENABLED`. */
export function selectedModules(
  config: Pick<
    FeatureConfig,
    "PROFILE" | "MODULES_DISABLED" | "MODULES_ENABLED"
  >,
): Set<ModuleName> {
  const selected = new Set<ModuleName>(PROFILES[config.PROFILE]);
  for (const name of config.MODULES_DISABLED) {
    selected.delete(name as ModuleName);
  }
  for (const name of config.MODULES_ENABLED) {
    selected.add(name as ModuleName);
  }
  return selected;
}

/**
 * The per-module switches that already existed, ANDed with the profile.
 *
 * Kept as data rather than scattered `if`s so there is one place to read the
 * answer to "why is this module off?".
 */
function switchedOn(name: ModuleName, config: FeatureConfig): boolean {
  switch (name) {
    case "ui":
      return config.UI_ENABLED;
    case "metrics":
      return config.METRICS_ENABLED;
    case "feedback":
      return !config.FEEDBACK_DISABLED;
    // Presence of the endpoint *is* the switch, and deliberately the only one.
    case "mirror":
      return config.MIRROR_ENDPOINT_URL !== undefined;
    default:
      return true;
  }
}

export function resolveFeatures(config: FeatureConfig): Features {
  const selected = selectedModules(config);
  const names = MODULE_NAMES.filter(
    (name) => selected.has(name) && switchedOn(name, config),
  );
  const on = new Set(names);
  return {
    enabled: (name: ModuleName): boolean => on.has(name),
    names,
    profile: config.PROFILE,
  };
}

/**
 * Why a configuration cannot be run, or `undefined` if it can.
 *
 * Read by `env.ts` as a `.refine`, so a contradictory profile **refuses to
 * boot** rather than starting into a half-wired process — the same posture as
 * the existing `AUTH_MODE=none`-in-production and `METRICS_TOKEN` refusals.
 *
 * Note this checks the *profile*, not the switches: turning `ui` off with
 * `UI_ENABLED=0` is a normal thing to do and nothing depends on `ui`. Removing
 * `record` from the profile while `flow` is still in it is a contradiction.
 */
export function describeConflict(
  selected: ReadonlySet<ModuleName>,
): string | undefined {
  for (const name of selected) {
    for (const need of REQUIRES[name]) {
      if (!selected.has(need)) {
        return `module "${name}" requires "${need}", which this profile does not include`;
      }
    }
  }
  return undefined;
}

/** Names that are not modules, for a clear error instead of a silent no-op. */
export function unknownModules(names: readonly string[]): string[] {
  const known = new Set<string>(MODULE_NAMES);
  return names.filter((name) => !known.has(name));
}
