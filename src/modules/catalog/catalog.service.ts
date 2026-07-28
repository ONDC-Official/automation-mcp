import type { Logger } from "pino";
import { cacheKey, type CacheStore } from "@/lib/cache/cache-store.js";
import { NotFoundError, ValidationError } from "@/lib/errors.js";
import type { ConfigServiceGateway } from "@/modules/catalog/catalog.gateway.js";
import type {
  Build,
  BuildRef,
  FlowDetail,
  FlowStep,
  FlowSummary,
  MockConfigStep,
  MockConfigSummary,
  NpType,
  StepActor,
  StepInput,
  UpstreamFlow,
  UpstreamMockConfig,
} from "@/modules/catalog/catalog.schema.js";

/**
 * Business logic for the flow catalog. Imports nothing from the MCP SDK.
 *
 * Its central job is turning the config-service's answers into something a
 * model can act on:
 *
 * - **Validate the build before asking for flows.** The config-service returns
 *   `200 {"data":{"flows":[]}}` for an unknown domain or usecase, so without
 *   this check a typo reads as "this build has no flows" and the model has no
 *   way to tell. `assertBuild` turns that into a `ValidationError` naming the
 *   valid values.
 * - **Annotate every step with an actor.** Once the mock's role is known, each
 *   step is either ours to produce or the NP's to send. That single derived
 *   field is what lets a model drive a flow without re-deriving ownership on
 *   every turn.
 * - **Keep the mock-runner config out of the model's context.** A config is
 *   ~330KB of base64 JavaScript. It is cached whole, server-side, because a
 *   later step executes it through `@ondc/automation-mock-runner`; tools only
 *   ever see the summary.
 */

const FORM_STEP_MARKER = "FORM";

export interface CatalogServiceOptions {
  gateway: ConfigServiceGateway;
  cache: CacheStore;
  logger: Logger;
  /** TTL for everything fetched from the config-service. */
  cacheTtlMs: number;
}

export class CatalogService {
  readonly #gateway: ConfigServiceGateway;
  readonly #cache: CacheStore;
  readonly #logger: Logger;
  readonly #ttl: number;

  constructor(options: CatalogServiceOptions) {
    this.#gateway = options.gateway;
    this.#cache = options.cache;
    this.#logger = options.logger;
    this.#ttl = options.cacheTtlMs;
  }

  /** The full catalog, optionally narrowed to one domain. */
  async listBuilds(domain?: string): Promise<Build[]> {
    const builds = await this.#builds();
    if (domain === undefined) return builds;

    const needle = domain.trim().toLowerCase();
    return builds.filter((build) => build.domain.toLowerCase() === needle);
  }

  /**
   * Verify that (domain, version, usecase) is actually published.
   *
   * @throws {ValidationError} naming the valid values at whichever level failed.
   */
  async assertBuild(build: BuildRef): Promise<void> {
    const builds = await this.#builds();

    const domain = builds.find((entry) => entry.domain === build.domain);
    if (!domain) {
      throw new ValidationError(
        `Unknown domain "${build.domain}". Call catalog_list_builds to see what is published.`,
        { domain: build.domain, valid_domains: builds.map((e) => e.domain) },
      );
    }

    const version = domain.versions.find(
      (entry) => entry.version === build.version,
    );
    if (!version) {
      throw new ValidationError(
        `Domain "${build.domain}" has no version "${build.version}".`,
        {
          domain: build.domain,
          version: build.version,
          valid_versions: domain.versions.map((e) => e.version),
        },
      );
    }

    if (!version.usecases.includes(build.usecase)) {
      throw new ValidationError(
        `Version "${build.version}" of "${build.domain}" has no use-case "${build.usecase}". Use-case names are case- and space-sensitive.`,
        {
          domain: build.domain,
          version: build.version,
          usecase: build.usecase,
          valid_usecases: version.usecases,
        },
      );
    }
  }

  /** Flow summaries for a validated build, annotated for `mockRole`. */
  async listFlows(build: BuildRef, mockRole: NpType): Promise<FlowSummary[]> {
    const flows = await this.#flows(build);
    return flows.map((flow) => summarizeFlow(flow, mockRole));
  }

  /** One flow's full sequence, every step annotated with its actor. */
  async describeFlow(
    build: BuildRef,
    flowId: string,
    mockRole: NpType,
  ): Promise<FlowDetail> {
    const flows = await this.#flows(build);
    const flow = flows.find((entry) => entry.id === flowId);

    if (!flow) {
      throw new NotFoundError("flow", flowId, {
        ...build,
        available_flows: flows.map((entry) => entry.id),
      });
    }

    return {
      flow_id: flow.id,
      description: flow.description ?? "",
      tags: flow.tags,
      mock_role: mockRole,
      step_count: flow.sequence.length,
      sequence: flow.sequence.map((step) => toFlowStep(step, mockRole)),
      extra_sequence: flow.extraSequence.map((step) =>
        toFlowStep(step, mockRole),
      ),
    };
  }

  /**
   * Fetch and cache a flow's mock-runner config; return only its summary.
   *
   * The raw config stays in the cache under the returned `cache_key` so the
   * runtime-execution tools added in a later step can load it without another
   * round trip.
   */
  async loadMockConfig(
    build: BuildRef,
    flowId: string,
    mockRole: NpType,
  ): Promise<MockConfigSummary> {
    const key = mockConfigKey(build, flowId);
    const cached = await this.#cache.get<UpstreamMockConfig>(key);

    const config = cached ?? (await this.#fetchMockConfig(build, flowId, key));
    const totalBytes = JSON.stringify(config).length;

    this.#logger.debug(
      { flowId, cached: cached !== undefined, totalBytes },
      "mock config resolved",
    );

    return {
      flow_id: flowId,
      meta: {
        ...(config.meta.domain !== undefined
          ? { domain: config.meta.domain }
          : {}),
        ...(config.meta.version !== undefined
          ? { version: config.meta.version }
          : {}),
        ...(config.meta.use_case_id !== undefined
          ? { use_case_id: config.meta.use_case_id }
          : {}),
        ...(config.meta.flowName !== undefined
          ? { flow_name: config.meta.flowName }
          : {}),
        ...(config.meta.config_version !== undefined
          ? { config_version: config.meta.config_version }
          : {}),
      },
      step_count: config.steps.length,
      steps: config.steps.map((step) => toMockConfigStep(step, mockRole)),
      helper_lib_bytes: config.helperLib?.length ?? 0,
      validation_lib_bytes: config.validationLib?.length ?? 0,
      total_bytes: totalBytes,
      cache_key: key,
    };
  }

  /**
   * The raw cached mock-runner config, for the execution tools that come later.
   * Returns `undefined` when it has not been loaded (or has expired).
   */
  getCachedMockConfig(key: string): Promise<UpstreamMockConfig | undefined> {
    return this.#cache.get<UpstreamMockConfig>(key);
  }

  async #fetchMockConfig(
    build: BuildRef,
    flowId: string,
    key: string,
  ): Promise<UpstreamMockConfig> {
    const config = await this.#gateway.fetchMockConfig(build, flowId);
    if (!config) {
      throw new NotFoundError("flow", flowId, build);
    }
    await this.#cache.set(key, config, this.#ttl);
    return config;
  }

  async #builds(): Promise<Build[]> {
    const key = cacheKey("builds");
    const cached = await this.#cache.get<Build[]>(key);
    if (cached) return cached;

    const builds = await this.#gateway.fetchBuilds();
    await this.#cache.set(key, builds, this.#ttl);
    return builds;
  }

  async #flows(build: BuildRef): Promise<UpstreamFlow[]> {
    const key = cacheKey("flows", build.domain, build.version, build.usecase);
    const cached = await this.#cache.get<UpstreamFlow[]>(key);
    if (cached) return cached;

    const flows = await this.#gateway.fetchFlows(build);
    await this.#cache.set(key, flows, this.#ttl);
    return flows;
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers — exported so they can be tested without a gateway             */
/* -------------------------------------------------------------------------- */

/** Cache handle for a flow's mock-runner config. */
export function mockConfigKey(build: BuildRef, flowId: string): string {
  return cacheKey(
    "mockcfg",
    build.domain,
    build.version,
    flowId,
    build.usecase,
  );
}

/** The role the mock plays against a participant of type `npType`. */
export function oppositeRole(npType: NpType): NpType {
  return npType === "BAP" ? "BPP" : "BAP";
}

/** Whether a step belongs to the mock, the NP under test, or neither. */
export function actorFor(
  owner: string | undefined,
  mockRole: NpType,
): StepActor {
  if (owner === undefined) return "unknown";
  const normalised = owner.trim().toUpperCase();
  if (normalised !== "BAP" && normalised !== "BPP") return "unknown";
  return normalised === mockRole ? "mock" : "np";
}

function isFormStep(type: string): boolean {
  return type.toUpperCase().includes(FORM_STEP_MARKER);
}

function toStepInput(input: {
  name: string;
  type?: string | undefined;
  label?: string | undefined;
  payloadField?: string | undefined;
  reference?: string | undefined;
  schema?: unknown;
}): StepInput {
  return {
    name: input.name,
    ...(input.type !== undefined ? { type: input.type } : {}),
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.payloadField !== undefined
      ? { payload_field: input.payloadField }
      : {}),
    ...(input.reference !== undefined ? { reference: input.reference } : {}),
    ...(input.schema !== undefined ? { schema: input.schema } : {}),
  };
}

export function toFlowStep(
  step: UpstreamFlow["sequence"][number],
  mockRole: NpType,
): FlowStep {
  return {
    key: step.key,
    type: step.type,
    ...(step.owner !== undefined ? { owner: step.owner } : {}),
    actor: actorFor(step.owner, mockRole),
    ...(step.description !== undefined
      ? { description: step.description }
      : {}),
    ...(step.label !== undefined ? { label: step.label } : {}),
    ...(step.expect !== undefined ? { expect: step.expect } : {}),
    ...(step.unsolicited !== undefined
      ? { unsolicited: step.unsolicited }
      : {}),
    ...(step.pair !== undefined && step.pair !== null ? { pair: step.pair } : {}),
    ...(step.repeat !== undefined ? { repeat: step.repeat } : {}),
    ...(step.force_proceed !== undefined
      ? { force_proceed: step.force_proceed }
      : {}),
    inputs: (step.input ?? []).map(toStepInput),
  };
}

export function summarizeFlow(
  flow: UpstreamFlow,
  mockRole: NpType,
): FlowSummary {
  let mockSteps = 0;
  let npSteps = 0;
  let formSteps = 0;

  for (const step of flow.sequence) {
    const actor = actorFor(step.owner, mockRole);
    if (actor === "mock") mockSteps += 1;
    else if (actor === "np") npSteps += 1;
    if (isFormStep(step.type)) formSteps += 1;
  }

  return {
    flow_id: flow.id,
    description: flow.description ?? "",
    tags: flow.tags,
    step_count: flow.sequence.length,
    actions: flow.sequence.map((step) => step.type),
    mock_steps: mockSteps,
    np_steps: npSteps,
    form_steps: formSteps,
    has_extra_sequence: flow.extraSequence.length > 0,
  };
}

function toMockConfigStep(
  step: UpstreamMockConfig["steps"][number],
  mockRole: NpType,
): MockConfigStep {
  const mock = step.mock;
  const inputs = mock?.inputs;

  return {
    action_id: step.action_id,
    api: step.api,
    ...(step.owner !== undefined ? { owner: step.owner } : {}),
    actor: actorFor(step.owner, mockRole),
    ...(step.responseFor !== undefined && step.responseFor !== null
      ? { response_for: step.responseFor }
      : {}),
    ...(step.unsolicited !== undefined
      ? { unsolicited: step.unsolicited }
      : {}),
    has: {
      generate: typeof mock?.generate === "string" && mock.generate.length > 0,
      validate: typeof mock?.validate === "string" && mock.validate.length > 0,
      requirements:
        typeof mock?.requirements === "string" && mock.requirements.length > 0,
      default_payload: mock?.defaultPayload !== undefined,
      save_data: mock?.saveData !== undefined,
      form_html: typeof mock?.formHtml === "string" && mock.formHtml.length > 0,
    },
    input_names: inputNames(inputs),
    examples_count: step.examples?.length ?? 0,
  };
}

/** Names out of an array of `{name}` declarations. */
function namesFromArray(entries: unknown[]): string[] {
  return entries
    .map((entry) =>
      typeof entry === "object" && entry !== null && "name" in entry
        ? String(entry.name)
        : undefined,
    )
    .filter((name): name is string => name !== undefined);
}

/**
 * Input declarations vary in shape across configs: a bare array of
 * declarations, or a descriptor object that nests them (the live FIS12 configs
 * use `{oldInputs: [{name, …}]}`). Read names defensively and prefer nested
 * declarations over the wrapper's own keys — reporting "oldInputs" as an input
 * name would be actively misleading. An unfamiliar shape degrades to "no
 * declared inputs" rather than throwing mid-summary.
 */
function inputNames(inputs: unknown): string[] {
  if (Array.isArray(inputs)) return namesFromArray(inputs);

  if (typeof inputs === "object" && inputs !== null) {
    const nested = Object.values(inputs)
      .filter((value): value is unknown[] => Array.isArray(value))
      .flatMap(namesFromArray);
    if (nested.length > 0) return nested;
    return Object.keys(inputs);
  }

  return [];
}
