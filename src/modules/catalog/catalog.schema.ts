import { z } from "zod";

/**
 * Two families of schema live here, and mixing them up causes real bugs.
 *
 * 1. **Upstream shapes** (`Upstream*`) mirror what the config-service actually
 *    returns, field-for-field — including its own casing (`extraSequence`,
 *    `payloadField`) and its quirks. They are deliberately *loose*: the service
 *    is developed elsewhere and may add fields, and a strict parse would turn a
 *    harmless addition into an outage. Never rename anything here.
 * 2. **Our shapes** are what tools return. They use `snake_case` throughout,
 *    matching the ONDC/workbench vocabulary the model already sees in payloads
 *    (`transaction_id`, `bap_uri`), so the model-facing surface reads as one
 *    language rather than two.
 *
 * Output schemas stay plain (object/array/string/number/boolean/enum/optional)
 * because they are converted to JSON Schema for the wire.
 */

/** Which side of the network a participant sits on. */
export const NpType = z.enum(["BAP", "BPP"]);
export type NpType = z.infer<typeof NpType>;

/**
 * How an `NpType` is spelled in a subscriber URI's path.
 *
 * `buyer` is the URI of a BAP, `seller` the URI of a BPP — so the segment names
 * the role of whoever *owns* the endpoint, not of whoever is calling it. The
 * network's own spelling: the workbench publishes
 * `bap_uri = {base}/{domain}/{version}/buyer` and `bpp_uri = .../seller`.
 */
export const ReceiverRole = z.enum(["buyer", "seller"]);
export type ReceiverRole = z.infer<typeof ReceiverRole>;

/**
 * Who is responsible for a step, once the mock's role is known.
 *
 * `mock` — we must produce it. `np` — we wait for the NP under test to send it.
 * `unknown` — upstream declared no owner; treat as unclassified rather than
 * guessing, because guessing wrong makes the model wait forever or talk over
 * the counterparty.
 */
export const StepActor = z.enum(["mock", "np", "unknown"]);
export type StepActor = z.infer<typeof StepActor>;

/* -------------------------------------------------------------------------- */
/* Upstream shapes — config-service responses, verbatim                        */
/* -------------------------------------------------------------------------- */

/** `GET /protocol/available-builds` → `[{key, version:[{key, usecase[]}]}]` */
export const UpstreamBuild = z.looseObject({
  key: z.string(),
  version: z
    .array(
      z.looseObject({
        key: z.string(),
        usecase: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

export const UpstreamBuilds = z.array(UpstreamBuild);

export const UpstreamStepInput = z.looseObject({
  name: z.string(),
  type: z.string().optional(),
  label: z.string().optional(),
  payloadField: z.string().optional(),
  reference: z.string().optional(),
  schema: z.unknown().optional(),
});

export const UpstreamSequenceStep = z.looseObject({
  key: z.string(),
  type: z.string(),
  owner: z.string().optional(),
  description: z.string().optional(),
  label: z.string().optional(),
  expect: z.boolean().optional(),
  unsolicited: z.boolean().optional(),
  pair: z.string().nullish(),
  repeat: z.number().optional(),
  force_proceed: z.boolean().optional(),
  input: z.array(UpstreamStepInput).optional(),
});

export const UpstreamFlow = z.looseObject({
  id: z.string(),
  description: z.string().optional(),
  sequence: z.array(UpstreamSequenceStep).default([]),
  extraSequence: z.array(UpstreamSequenceStep).default([]),
  tags: z.array(z.string()).default([]),
});
export type UpstreamFlow = z.infer<typeof UpstreamFlow>;

/** `GET /ui/flow` → `{data:{flows:[…]}}` */
export const UpstreamFlowsResponse = z.looseObject({
  data: z.looseObject({
    flows: z.array(UpstreamFlow).default([]),
  }),
});

/**
 * `GET /mock/playground` → the mock-runner config.
 *
 * Parsed only far enough to summarise it. The per-step `mock.generate` /
 * `.validate` / `.requirements` are base64-encoded JavaScript that a later step
 * will execute through `@ondc/automation-mock-runner`, so the object is stored
 * intact — this schema must never strip or normalise it.
 */
export const UpstreamMockStep = z.looseObject({
  api: z.string(),
  action_id: z.string(),
  owner: z.string().optional(),
  responseFor: z.string().nullish(),
  unsolicited: z.boolean().optional(),
  description: z.string().optional(),
  mock: z
    .looseObject({
      generate: z.string().optional(),
      validate: z.string().optional(),
      requirements: z.string().optional(),
      defaultPayload: z.unknown().optional(),
      saveData: z.unknown().optional(),
      formHtml: z.string().optional(),
      inputs: z.unknown().optional(),
    })
    .optional(),
  examples: z.array(z.unknown()).optional(),
});

export const UpstreamMockConfig = z.looseObject({
  meta: z.looseObject({
    domain: z.string().optional(),
    version: z.string().optional(),
    flowId: z.string().optional(),
    flowName: z.string().optional(),
    use_case_id: z.string().optional(),
    config_version: z.string().optional(),
    description: z.string().optional(),
  }),
  steps: z.array(UpstreamMockStep).default([]),
  transaction_data: z.unknown().optional(),
  transaction_history: z.array(z.unknown()).optional(),
  helperLib: z.string().optional(),
  validationLib: z.string().optional(),
});
export type UpstreamMockConfig = z.infer<typeof UpstreamMockConfig>;

/* -------------------------------------------------------------------------- */
/* Our shapes — what tools return                                              */
/* -------------------------------------------------------------------------- */

export const Build = z.object({
  domain: z.string().describe("ONDC domain code, e.g. ONDC:FIS12."),
  versions: z
    .array(
      z.object({
        version: z.string().describe("Spec version, e.g. 2.0.3."),
        usecases: z
          .array(z.string())
          .describe("Use-cases published for this domain and version."),
      }),
    )
    .describe("Versions available for this domain."),
});
export type Build = z.infer<typeof Build>;

/** The (domain, version, usecase) triple a session is pinned to. */
export const BuildRef = z.object({
  domain: z.string().describe("ONDC domain code, e.g. ONDC:FIS12."),
  version: z.string().describe("Spec version, e.g. 2.0.3."),
  usecase: z
    .string()
    .describe("Use-case name, exactly as published, e.g. 'PERSONAL LOAN'."),
});
export type BuildRef = z.infer<typeof BuildRef>;

export const StepInput = z.object({
  name: z.string().describe("Input identifier the flow expects."),
  type: z.string().optional().describe("Input kind, e.g. DYNAMIC_FORM."),
  label: z.string().optional().describe("Human-facing prompt for the input."),
  payload_field: z
    .string()
    .optional()
    .describe("Field in the payload this input populates."),
  reference: z
    .string()
    .optional()
    .describe("JSONPath into session reference data supplying the value."),
  schema: z
    .unknown()
    .optional()
    .describe("JSON Schema for the input value, when the flow declares one."),
});
export type StepInput = z.infer<typeof StepInput>;

export const FlowStep = z.object({
  key: z.string().describe("Unique step key within the flow."),
  type: z
    .string()
    .describe(
      "Protocol action (search, on_search, …) or form type (HTML_FORM, DYNAMIC_FORM).",
    ),
  owner: z.string().optional().describe("BAP or BPP, per the flow definition."),
  actor: StepActor.describe(
    "'mock' if this session's mock role owns the step, 'np' if the participant under test does.",
  ),
  description: z.string().optional().describe("What the step accomplishes."),
  label: z.string().optional().describe("Short human-facing label."),
  expect: z
    .boolean()
    .optional()
    .describe("True when the flow arms an expectation for this step."),
  unsolicited: z
    .boolean()
    .optional()
    .describe("True for steps sent without a preceding request."),
  pair: z
    .string()
    .nullish()
    .describe("Key of the step that responds to this one, when paired."),
  repeat: z.number().optional().describe("How many times the step repeats."),
  force_proceed: z
    .boolean()
    .optional()
    .describe("True when the flow advances without waiting for this step."),
  inputs: z
    .array(StepInput)
    .describe(
      "Input declarations, as the flow definition publishes them. A `name` " +
        "here is the declaration's own id — when it carries a `schema`, the " +
        "keys to send are that schema's properties, not this name. " +
        "flow_proceed's `inputs_required` states them directly; prefer it.",
    ),
});
export type FlowStep = z.infer<typeof FlowStep>;

export const FlowSummary = z.object({
  flow_id: z.string().describe("Identifier used to start or describe a flow."),
  description: z.string().describe("What the flow exercises."),
  tags: z
    .array(z.string())
    .describe("Flow labels, e.g. WORKBENCH, REPORTABLE."),
  step_count: z
    .number()
    .int()
    .describe("Number of steps in the main sequence."),
  actions: z
    .array(z.string())
    .describe("Ordered step types — the shape of the sequence at a glance."),
  mock_steps: z
    .number()
    .int()
    .describe("Steps this session's mock role must produce."),
  np_steps: z
    .number()
    .int()
    .describe("Steps expected from the participant under test."),
  form_steps: z
    .number()
    .int()
    .describe("HTML_FORM / DYNAMIC_FORM steps in the sequence."),
  has_extra_sequence: z
    .boolean()
    .describe("True when the flow declares parallel or unsolicited steps."),
});
export type FlowSummary = z.infer<typeof FlowSummary>;

export const FlowDetail = z.object({
  flow_id: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  mock_role: NpType.describe("The role this session's mock plays."),
  step_count: z.number().int(),
  sequence: z.array(FlowStep).describe("The ordered main sequence."),
  extra_sequence: z
    .array(FlowStep)
    .describe("Parallel or unsolicited steps, if any."),
});
export type FlowDetail = z.infer<typeof FlowDetail>;

/* ------------------------------ mock config ------------------------------- */

export const MockConfigStep = z.object({
  action_id: z.string().describe("Step identifier inside the mock config."),
  api: z.string().describe("Protocol action the step produces or validates."),
  owner: z.string().optional(),
  actor: StepActor,
  response_for: z
    .string()
    .nullish()
    .describe("action_id this step responds to, when it is a response."),
  unsolicited: z.boolean().optional(),
  has: z
    .object({
      generate: z.boolean(),
      validate: z.boolean(),
      requirements: z.boolean(),
      default_payload: z.boolean(),
      save_data: z.boolean(),
      form_html: z.boolean(),
    })
    .describe(
      "Which mock-runner functions this step carries. The code itself is held server-side.",
    ),
  input_names: z
    .array(z.string())
    .describe("Named inputs the step's generator expects."),
  examples_count: z
    .number()
    .int()
    .describe("Reference payload examples bundled with the step."),
});
export type MockConfigStep = z.infer<typeof MockConfigStep>;

export const MockConfigSummary = z.object({
  flow_id: z.string(),
  meta: z
    .object({
      domain: z.string().optional(),
      version: z.string().optional(),
      use_case_id: z.string().optional(),
      flow_name: z.string().optional(),
      config_version: z.string().optional(),
    })
    .describe("Config identity as published by the config-service."),
  step_count: z.number().int(),
  steps: z.array(MockConfigStep),
  helper_lib_bytes: z
    .number()
    .int()
    .describe("Size of the shared helper library carried by the config."),
  validation_lib_bytes: z.number().int(),
  total_bytes: z
    .number()
    .int()
    .describe("Size of the whole config held server-side."),
  cache_key: z
    .string()
    .describe("Server-side handle for the cached config, for later execution."),
});
export type MockConfigSummary = z.infer<typeof MockConfigSummary>;

/* -------------------------------------------------------------------------- */
/* Tool input / output                                                         */
/* -------------------------------------------------------------------------- */

export const ListBuildsInput = z.object({
  domain: z
    .string()
    .optional()
    .describe(
      "Restrict the catalog to one domain code, e.g. ONDC:FIS12. Omit for all.",
    ),
});
export type ListBuildsInput = z.infer<typeof ListBuildsInput>;

export const ListBuildsOutput = z.object({
  builds: z.array(Build),
  total: z.number().int().describe("Number of domains returned."),
});
export type ListBuildsOutput = z.infer<typeof ListBuildsOutput>;

export const ListFlowsInput = z.object({
  session_id: z.string().min(1).describe("Session returned by session_create."),
});
export type ListFlowsInput = z.infer<typeof ListFlowsInput>;

export const ListFlowsOutput = z.object({
  session_id: z.string(),
  build: BuildRef,
  mock_role: NpType,
  flows: z.array(FlowSummary),
  total: z.number().int(),
});
export type ListFlowsOutput = z.infer<typeof ListFlowsOutput>;

export const DescribeFlowInput = z.object({
  session_id: z.string().min(1).describe("Session returned by session_create."),
  flow_id: z
    .string()
    .min(1)
    .describe("Flow identifier, as listed by catalog_list_flows."),
});
export type DescribeFlowInput = z.infer<typeof DescribeFlowInput>;

export const DescribeFlowOutput = FlowDetail;
export type DescribeFlowOutput = z.infer<typeof DescribeFlowOutput>;

export const LoadFlowConfigInput = z.object({
  session_id: z.string().min(1).describe("Session returned by session_create."),
  flow_id: z
    .string()
    .min(1)
    .describe("Flow whose mock-runner config should be loaded."),
});
export type LoadFlowConfigInput = z.infer<typeof LoadFlowConfigInput>;

export const LoadFlowConfigOutput = MockConfigSummary;
export type LoadFlowConfigOutput = z.infer<typeof LoadFlowConfigOutput>;
