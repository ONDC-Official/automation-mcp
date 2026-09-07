import { z } from "zod";

/**
 * Shapes for the published protocol spec — the *reference* half of this server.
 *
 * Same two families as `catalog.schema.ts`, and the same rule: `Upstream*`
 * mirrors what the config-service returns, ours is `snake_case` and plain
 * enough to become JSON Schema on the wire.
 *
 * ## The one deliberate deviation
 *
 * Upstream shapes here are `z.object`, not `z.looseObject`, wherever the
 * upstream node carries something enormous we must not retain — specifically
 * `flows[].config`, which is the mock-runner config and is **9.1 MB of the
 * 10.5 MB response**. `z.object` *strips* unknown keys (it does not reject
 * them, which is `z.strictObject`), so a harmless upstream addition still
 * cannot cause an outage; it simply does not survive into the cache. That is
 * exactly the property we want, and it is why the ingest never has to walk the
 * config to delete it.
 *
 * Everything else stays loose, for the reason `catalog.schema.ts` gives.
 */

/* -------------------------------------------------------------------------- */
/* Upstream shapes — `GET /protocol/spec/{domain}/{version}`, verbatim         */
/* -------------------------------------------------------------------------- */

/** One row of `meta.errorCodes`. Upstream capitalises three of these four. */
export const UpstreamErrorCode = z.looseObject({
  code: z.union([z.string(), z.number()]).optional(),
  Event: z.string().optional(),
  Description: z.string().optional(),
  From: z.string().optional(),
});

/**
 * One entry of `meta.apiProperties`.
 *
 * `transaction_partner` is the echo contract: the earlier actions whose data
 * this action's payload must stay consistent with. `confirm` names
 * `["init","on_init"]` — every identifier in a confirm has to trace back to
 * something the counterparty actually offered. It is the published answer to
 * "did I just make this value up?".
 */
export const UpstreamApiProperty = z.looseObject({
  async_predecessor: z.string().nullish(),
  transaction_partner: z.array(z.string()).default([]),
});

export const UpstreamUsecaseStatus = z.looseObject({
  usecase: z.string(),
  status: z.string().optional(),
});

export const UpstreamSpecMeta = z.looseObject({
  domain: z.string().optional(),
  version: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  usecases: z.array(z.string()).default([]),
  usecaseStatus: z.array(UpstreamUsecaseStatus).default([]),
  /**
   * The legal action-transition graph, keyed by the preceding action. The key
   * `"null"` (the literal four-character string, as upstream serialises it)
   * lists the actions that may *open* a transaction.
   */
  supportedActions: z.record(z.string(), z.array(z.string())).default({}),
  apiProperties: z.record(z.string(), UpstreamApiProperty).default({}),
  errorCodes: z.array(UpstreamErrorCode).default([]),
  /**
   * OpenAPI paths, keyed `/{action}`. Kept because every published build has
   * `components: null` and no `$ref` anywhere in here, so each action's schema
   * is fully inlined and can be served without a resolver.
   */
  paths: z.unknown().optional(),
  buildHash: z.string().optional(),
  ingestedAt: z.string().optional(),
});

export const UpstreamSpecDoc = z.looseObject({
  slug: z.string().optional(),
  content: z.string().default(""),
  order: z.number().optional(),
});

/**
 * A flow, **without** its config.
 *
 * `z.object` on purpose — see the header. `config` is the same artefact
 * `catalog_load_flow_config` already fetches and caches; a second copy would
 * be 9 MB of duplicate.
 */
export const UpstreamSpecFlow = z.object({
  flowId: z.string(),
  usecase: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

/** One leaf of the compiled L1 rule table. */
export const UpstreamRuleRow = z.looseObject({
  rowType: z.string().optional(),
  name: z.string().optional(),
  group: z.string().optional(),
  scope: z.string().optional(),
  description: z.string().optional(),
  skipIf: z.string().optional(),
  errorCode: z.string().optional(),
  successCode: z.string().optional(),
});

export const UpstreamValidationTable = z.looseObject({
  table: z
    .record(
      z.string(),
      z.looseObject({
        action: z.string().optional(),
        numLeafTests: z.number().optional(),
        rows: z.array(UpstreamRuleRow).default([]),
      }),
    )
    .default({}),
});

export const UpstreamAttributeEntry = z.looseObject({
  useCaseId: z.string().optional(),
  /** `attributeSet[action]` is a field tree mirroring the payload. */
  attributeSet: z.record(z.string(), z.unknown()).default({}),
});

export const UpstreamChangelogEntry = z.looseObject({
  fromVersion: z.string().optional(),
  toVersion: z.string().optional(),
  totalChanges: z.number().optional(),
  sections: z.array(z.unknown()).default([]),
});

/** The whole response. Every section optional: builds differ in what they ship. */
export const UpstreamSpec = z.looseObject({
  meta: UpstreamSpecMeta.optional(),
  docs: z.array(UpstreamSpecDoc).default([]),
  flows: z.array(UpstreamSpecFlow).default([]),
  attributes: z.array(UpstreamAttributeEntry).default([]),
  validationTable: UpstreamValidationTable.optional(),
  changelog: z.array(UpstreamChangelogEntry).default([]),
});
export type UpstreamSpec = z.infer<typeof UpstreamSpec>;

/* -------------------------------------------------------------------------- */
/* Our shapes                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How a caller names a build.
 *
 * Every catalog tool takes `session_id` and derives the build from it, which is
 * right when the job is driving a mock. It is wrong here: the audience for a
 * reference lookup is somebody *implementing* ONDC, who has no session and
 * should not have to open one to ask what a field means. So the triple is
 * primary and `session_id` is a shorthand that fills it in.
 */
export const BuildSelector = z.object({
  session_id: z
    .string()
    .optional()
    .describe(
      "Take the build from this session. Shorthand for domain+version+usecase; " +
        "omit it and name the build directly.",
    ),
  domain: z.string().optional().describe("ONDC domain code, e.g. ONDC:RET11."),
  version: z.string().optional().describe("Spec version, e.g. 1.2.5."),
  usecase: z
    .string()
    .optional()
    .describe(
      "Use-case name, exactly as published, e.g. 'F&B'. Only needed where a " +
        "build publishes per-use-case field dictionaries.",
    ),
});
export type BuildSelector = z.infer<typeof BuildSelector>;

export const ErrorCodeEntry = z.object({
  code: z.string().describe("The ONDC error code."),
  event: z.string().describe("Short name for the condition."),
  description: z.string().describe("What it means."),
  sent_by: z
    .string()
    .describe("Which side raises it: BAP, BPP, or both/unstated."),
  used_in: z
    .string()
    .optional()
    .describe(
      "Where it belongs, when upstream says so: a synchronous NACK, or the " +
        "`error` object of an async callback.",
    ),
});
export type ErrorCodeEntry = z.infer<typeof ErrorCodeEntry>;

export const UsecaseStatusEntry = z.object({
  usecase: z.string(),
  status: z.string(),
});

export const SpecFlowSummary = z.object({
  flow_id: z.string(),
  usecase: z.string().optional(),
  description: z.string().optional(),
  tags: z
    .array(z.string())
    .describe(
      "Publication tags. MANDATORY marks a flow required for certification.",
    ),
});

export const DescribeBuildOutput = z.object({
  domain: z.string(),
  version: z.string(),
  title: z.string().optional(),
  overview: z
    .string()
    .optional()
    .describe(
      "The published business context for this domain: what it is for, who " +
        "the real-world actors are, and the journeys it covers.",
    ),
  usecases: z.array(UsecaseStatusEntry),
  actions: z.array(z.string()).describe("Every action this build defines."),
  may_start_with: z
    .array(z.string())
    .describe("Actions that may legitimately open a transaction."),
  error_code_count: z.number().int(),
  rule_count: z
    .number()
    .int()
    .describe("Published L1 rules across every action."),
  flows: z.array(SpecFlowSummary),
  mandatory_flow_count: z.number().int(),
  error_codes: z.array(ErrorCodeEntry).optional(),
  recent_changes: z
    .array(
      z.object({ kind: z.string(), path: z.string(), summary: z.string() }),
    )
    .optional()
    .describe(
      "Recent changes in this build's own draft branch — NOT a migration " +
        "guide. Upstream publishes no cross-version changelog for any build.",
    ),
  build_hash: z.string().optional(),
  ingested_at: z.string().optional(),
  note: z.string(),
});
export type DescribeBuildOutput = z.infer<typeof DescribeBuildOutput>;

export const NextAction = z.object({
  action: z.string(),
  sent_by_counterparty: z
    .boolean()
    .optional()
    .describe(
      "True when this is a callback the other side sends. Only derivable when " +
        "a session fixes which role we play.",
    ),
  unsolicited: z
    .boolean()
    .describe(
      "True when nothing we send prompts it — it may arrive at any time, and a " +
        "real implementation must accept it whenever it does.",
    ),
  repeatable: z
    .boolean()
    .describe("True when this action may legitimately follow itself."),
  answers: z
    .string()
    .optional()
    .describe("The request this action is the asynchronous answer to."),
  must_echo: z
    .array(z.string())
    .describe(
      "Earlier actions whose values this payload must stay consistent with. " +
        "Every identifier here has to come from one of those exchanges — never " +
        "from a previous run, and never invented.",
    ),
});
export type NextAction = z.infer<typeof NextAction>;

export const NextActionsOutput = z.object({
  domain: z.string(),
  version: z.string(),
  after: z
    .string()
    .nullable()
    .describe(
      "The action asked about; null means 'what may open a transaction'.",
    ),
  next: z.array(NextAction),
  terminal: z
    .boolean()
    .describe("True when the graph publishes no successor at all."),
  note: z.string(),
});
export type NextActionsOutput = z.infer<typeof NextActionsOutput>;

/**
 * What a flow's sequence does *not* say.
 *
 * Attached to `catalog_describe_flow` rather than left to a tool the model has
 * to think to call, for the reason this repo has already recorded twice: a
 * prompt is opt-in in every client, and the fix is an affordance, not a
 * warning. A model reading a flow is exactly the model about to mistake it for
 * the protocol.
 */
export const FlowRealityStep = z.object({
  action: z.string(),
  repeatable: z.boolean().optional(),
  unsolicited: z.boolean().optional(),
  must_echo: z.array(z.string()).optional(),
  note: z.string().optional(),
});

export const FlowReality = z.object({
  note: z.string(),
  may_start_with: z.array(z.string()),
  steps: z.array(FlowRealityStep),
  not_in_this_flow: z
    .array(z.string())
    .describe(
      "Actions this build defines that this flow never exercises. A live " +
        "participant may still send them.",
    ),
});
export type FlowReality = z.infer<typeof FlowReality>;

/* -------------------------------------------------------------------------- */
/* Tool IO                                                                     */
/* -------------------------------------------------------------------------- */

export const DescribeBuildInput = BuildSelector.extend({
  include: z
    .array(z.enum(["overview", "flows", "error_codes", "recent_changes"]))
    .optional()
    .describe(
      "Extra sections. 'overview' is the published business context for the " +
        "domain; 'flows' lists every published flow and its tags. Both cost " +
        "several kilobytes — omit them once you have read them.",
    ),
});
export type DescribeBuildInput = z.infer<typeof DescribeBuildInput>;

export const NextActionsInput = BuildSelector.extend({
  after: z
    .string()
    .optional()
    .describe(
      "The action to look forward from. Omit it to ask what may legitimately " +
        "OPEN a transaction.",
    ),
});
export type NextActionsInput = z.infer<typeof NextActionsInput>;

/* -------------------------------------------------------------------------- */
/* Phase 2/3 shapes: fields, rules, error codes, knowledge                     */
/* -------------------------------------------------------------------------- */

export const FieldEnumEntry = z.object({
  code: z.string(),
  description: z.string().optional(),
});

export const ActionField = z.object({
  path: z.string().describe("JSONPath into this action's payload."),
  required: z.boolean(),
  type: z.string().optional(),
  owner: z
    .string()
    .optional()
    .describe(
      "Which side populates it. A field the counterparty owns is never yours " +
        "to choose — read it back from what they sent.",
    ),
  info: z.string().optional().describe("What the field is for."),
  example: z
    .string()
    .optional()
    .describe(
      "An example value published upstream. Illustrative only, and sometimes " +
        "wrong — ONDC:TRV11/2.0.1 publishes 'ONDC:FIS13' as the example for " +
        "context.domain, and ONDC:RET11/1.2.5 publishes 'ONDC:RET10'. Never a " +
        "value to hardcode.",
    ),
  enums: z.array(FieldEnumEntry).optional(),
  enum_total: z
    .number()
    .int()
    .optional()
    .describe("True count, when `enums` was truncated."),
});

export const PublishedRule = z.object({
  action: z.string(),
  name: z.string(),
  group: z.string().optional(),
  scope: z.string().optional(),
  description: z.string().optional(),
  skip_if: z.string().optional(),
  error_code: z
    .string()
    .optional()
    .describe(
      "As published. Almost always 30000, the validation compiler's default — " +
        "it is not the business error code to answer with. Use " +
        "protocol_list_error_codes for those.",
    ),
});

const Truncatable = {
  total: z.number().int(),
  returned: z.number().int(),
  truncated: z.boolean(),
};

export const DescribeActionOutput = z.object({
  domain: z.string(),
  version: z.string(),
  usecase: z.string().optional(),
  action: z.string(),
  owner: z
    .string()
    .optional()
    .describe(
      "Which side authors this action's message body, derived from who owns " +
        "its fields. Absent when they do not agree.",
    ),
  answers: z.string().optional(),
  must_echo: z.array(z.string()),
  legal_next: z.array(z.string()),
  fields: z.object({ ...Truncatable, items: z.array(ActionField) }).optional(),
  rules: z.object({ ...Truncatable, items: z.array(PublishedRule) }).optional(),
  error_codes: z.array(ErrorCodeEntry).optional(),
  schema: z
    .object({ bytes: z.number().int(), resource_uri: z.string() })
    .optional()
    .describe("The JSON Schema is served as a resource, never inlined here."),
  note: z.string(),
});
export type DescribeActionOutput = z.infer<typeof DescribeActionOutput>;

export const DescribeActionInput = BuildSelector.extend({
  action: z.string().describe("The action to describe, e.g. on_search."),
  include: z
    .array(z.enum(["fields", "rules", "error_codes", "schema"]))
    .optional()
    .describe("Defaults to ['fields']. Rules can be hundreds of rows."),
  path_prefix: z
    .string()
    .optional()
    .describe(
      "Keep only fields at or below this JSONPath, e.g. $.message.order.",
    ),
  max_depth: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Keep only fields this many segments below $. Defaults to 4."),
  required_only: z.boolean().optional(),
  owner: z
    .string()
    .optional()
    .describe("Keep only fields this side populates."),
  limit: z
    .number()
    .int()
    .positive()
    .max(150)
    .optional()
    .describe("Max fields and max rules returned. Defaults to 30."),
});
export type DescribeActionInput = z.infer<typeof DescribeActionInput>;

export const SearchFieldsInput = BuildSelector.extend({
  query: z
    .string()
    .describe("Matched against field paths, enum codes and field prose."),
  actions: z.array(z.string()).optional(),
  required_only: z.boolean().optional(),
  limit: z.number().int().positive().max(100).optional(),
});
export type SearchFieldsInput = z.infer<typeof SearchFieldsInput>;

export const FieldHit = ActionField.extend({ action: z.string() });

export const SearchFieldsOutput = z.object({
  domain: z.string(),
  version: z.string(),
  usecase: z.string().optional(),
  query: z.string(),
  ...Truncatable,
  hits: z.array(FieldHit),
});
export type SearchFieldsOutput = z.infer<typeof SearchFieldsOutput>;

export const ExplainRuleInput = BuildSelector.extend({
  query: z
    .string()
    .describe(
      "A rule name, an ONDC error code, a JSONPath, or a validation finding's " +
        "code exactly as payload_validate reported it.",
    ),
  action: z.string().optional(),
  limit: z.number().int().positive().max(50).optional(),
});
export type ExplainRuleInput = z.infer<typeof ExplainRuleInput>;

export const ExplainRuleOutput = z.object({
  domain: z.string(),
  version: z.string(),
  query: z.string(),
  query_kind: z.enum(["rule_name", "error_code", "json_path", "pseudo_code"]),
  ...Truncatable,
  matches: z.array(PublishedRule),
  per_action: z
    .record(z.string(), z.number().int())
    .describe("How many rules matched in each action, before any limit."),
  error_code: ErrorCodeEntry.optional().describe(
    "The business meaning, when the query named an error code.",
  ),
  note: z.string().optional(),
});
export type ExplainRuleOutput = z.infer<typeof ExplainRuleOutput>;

export const ListErrorCodesInput = BuildSelector.extend({
  sent_by: z
    .string()
    .optional()
    .describe("Narrow to codes one side raises: BAP or BPP."),
  used_in: z
    .enum(["nack", "error_object"])
    .optional()
    .describe(
      "Narrow to codes for a synchronous NACK, or for the error object of an " +
        "asynchronous callback. Only some builds publish this distinction.",
    ),
});
export type ListErrorCodesInput = z.infer<typeof ListErrorCodesInput>;

export const ListErrorCodesOutput = z.object({
  domain: z.string(),
  version: z.string(),
  ...Truncatable,
  codes: z.array(ErrorCodeEntry),
});
export type ListErrorCodesOutput = z.infer<typeof ListErrorCodesOutput>;

export const SearchKnowledgeInput = z.object({
  query: z
    .string()
    .describe(
      "What you want to know about the ONDC network itself — signing, the " +
        "registry, TTLs, retries, the async contract.",
    ),
  topic: z.string().optional().describe("Restrict to one topic id."),
  limit: z.number().int().positive().max(10).optional(),
});
export type SearchKnowledgeInput = z.infer<typeof SearchKnowledgeInput>;

export const KnowledgeSection = z.object({
  topic: z.string(),
  title: z.string(),
  heading: z.string(),
  body: z.string(),
});

export const SearchKnowledgeOutput = z.object({
  query: z.string(),
  ...Truncatable,
  sections: z.array(KnowledgeSection),
  topics: z.array(z.string()).describe("Every topic id available."),
  as_of: z
    .string()
    .describe(
      "When this corpus was last reviewed. It is written down here rather " +
        "than fetched, so it can go stale — say so if the answer matters.",
    ),
  note: z.string(),
});
export type SearchKnowledgeOutput = z.infer<typeof SearchKnowledgeOutput>;
