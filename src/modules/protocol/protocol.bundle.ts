/**
 * The raw spec document → `SpecBundle`. Pure, and the only place that knows
 * how upstream spells things.
 *
 * ## What is retained, and why so little
 *
 * The response is ~10.5 MB. **`flows[].config` is 8–9 MB of it** and is the
 * same mock-runner config `catalog_load_flow_config` already fetches and
 * caches — two caches of one 330 KB-per-flow artefact is a bug, not a
 * saving. `UpstreamSpecFlow` is a `z.object`, so the config is stripped by the
 * parse itself and never has to be walked and deleted.
 *
 * What is retained is reduced on the way in, not on the way out:
 *
 * - **The field dictionary is flattened at ingest and the nested tree
 *   dropped.** Nothing ever returns the tree — it is the wrong shape and too
 *   big — so keeping both would be pure waste. More importantly it moves a
 *   shape change to ingest, where it fails once and loudly, rather than to a
 *   tool call, where it would fail per caller.
 * - **Only leaf rule rows survive.** A `group` row is a heading whose
 *   description is "Sub-tests: A, B, C", which each leaf's own `group`
 *   breadcrumb already says.
 * - **Per-action request schemas are kept whole**, because they are small:
 *   `meta.components` is null and `meta.paths` contains no `$ref` on any
 *   published build, so each action's schema is fully inlined at 0.8-6.8 KB
 *   and needs no resolver.
 *
 * ## Two upstream divergences that must be normalised here
 *
 * 1. **`errorCodes[].code` is a number in some builds and a string in
 *    others** — `ONDC:TRV11/2.0.1` publishes `30001`, `ONDC:RET11/1.2.5`
 *    publishes `"60001"`. Both verified live. A lookup keyed on the raw value
 *    misses silently for half the network, so it is stringified once, here.
 * 2. **`validations` is nested one level deeper than it reads** —
 *    `spec.validations.validations._TESTS_`, not `spec.validations._TESTS_`.
 *    Recorded now because the rule tools will need it and the shape invites
 *    exactly one wrong guess.
 *
 * Nothing here throws on a malformed section. A build that ships no
 * `validationTable` gets a zero count, not an outage — the posture
 * `catalog.inputs.ts#resolveInputSpec` already takes, for the same reason: the
 * document is authored elsewhere.
 */

import {
  flattenAttributeSet,
  type FieldNode,
} from "@/modules/protocol/protocol.attributes.js";
import type { ActionGraph } from "@/modules/protocol/protocol.graph.js";
import { allActions } from "@/modules/protocol/protocol.graph.js";
import {
  extractRules,
  type RuleRow,
} from "@/modules/protocol/protocol.rules.js";
import {
  UpstreamSpec,
  type ErrorCodeEntry,
} from "@/modules/protocol/protocol.schema.js";

/** How much published overview prose a tool result will carry. */
const OVERVIEW_MAX_CHARS = 5_000;

export interface BuildChange {
  readonly kind: string;
  readonly path: string;
  readonly summary: string;
}

export interface SpecFlowRef {
  readonly flow_id: string;
  readonly usecase?: string;
  readonly description?: string;
  readonly tags: readonly string[];
}

export interface SpecBundle {
  readonly domain: string;
  readonly version: string;
  readonly title?: string;
  readonly description?: string;
  readonly build_hash?: string;
  readonly ingested_at?: string;
  readonly usecases: readonly { usecase: string; status: string }[];
  readonly graph: ActionGraph;
  readonly actions: readonly string[];
  readonly error_codes: readonly ErrorCodeEntry[];
  readonly docs: Readonly<Record<string, string>>;
  readonly flows: readonly SpecFlowRef[];
  /** Published L1 leaf rules, flat. Indexed on demand — see `extractRules`. */
  readonly rules: readonly RuleRow[];
  /** Flattened field dictionary, per use-case, per action. */
  readonly fields: Readonly<
    Record<string, Readonly<Record<string, FieldNode[]>>>
  >;
  /** The request schema per action, from `meta.paths`. */
  readonly schemas: Readonly<Record<string, unknown>>;
  /** Published L1 rules per action. */
  readonly rule_counts: Readonly<Record<string, number>>;
  /** Field-dictionary sizes per use-case. */
  readonly field_counts: Readonly<Record<string, number>>;
  /**
   * Recent changes in this build's own draft branch.
   *
   * **Not a version migration.** Verified across ten published builds: every
   * changelog upstream ships has `fromVersion === toVersion` on a `draft-*`
   * branch, and two builds ship none at all. So this answers "what moved in
   * this build recently", never "what changes if I upgrade" — and it is named
   * accordingly, because a `protocol_diff_versions` built on it would promise
   * something the data cannot keep.
   */
  readonly recent_changes: readonly BuildChange[];
  /** Approximate retained size, for the resident-bundle gauge. */
  readonly bytes: number;
}

/**
 * Where upstream says a code belongs.
 *
 * RET builds spell this out in the description — "Used in NACK" against
 * "Used in error object" — and it is the difference between refusing a call
 * synchronously and accepting it then reporting a business failure in the
 * callback. Builds that do not say get `undefined`; guessing would be worse
 * than silence, because a model cannot tell a guess from a fact.
 */
function usedIn(description: string): string | undefined {
  if (/used\s+in\s+nack/i.test(description)) return "nack";
  if (/used\s+in\s+error\s+object/i.test(description)) return "error_object";
  return undefined;
}

function toErrorCode(raw: {
  code?: string | number;
  Event?: string;
  Description?: string;
  From?: string;
}): ErrorCodeEntry | undefined {
  if (raw.code === undefined) return undefined;
  const description = raw.Description ?? "";
  const where = usedIn(description);
  return {
    // Normalised — see the header. Both types are live on the network today.
    code: String(raw.code),
    event: raw.Event ?? "",
    description,
    sent_by: raw.From ?? "unstated",
    ...(where !== undefined ? { used_in: where } : {}),
  };
}

/**
 * The request body schema an action publishes.
 *
 * `meta.paths` is an OpenAPI fragment keyed by `/{action}`. Undefined rather
 * than thrown for an action with no path entry — several builds define actions
 * in `supportedActions` that `paths` does not describe.
 */
function schemaFor(paths: unknown, action: string): unknown {
  if (typeof paths !== "object" || paths === null) return undefined;
  const entry = (paths as Record<string, unknown>)[`/${action}`];
  const post = (entry as { post?: unknown } | undefined)?.post;
  const body = (post as { requestBody?: unknown } | undefined)?.requestBody;
  const content = (body as { content?: unknown } | undefined)?.content;
  const json = (content as Record<string, unknown> | undefined)?.[
    "application/json"
  ];
  return (json as { schema?: unknown } | undefined)?.schema;
}

export interface BuildBundleInput {
  readonly domain: string;
  readonly version: string;
  readonly raw: unknown;
}

/**
 * Parse and reduce. Throws only when the document is not a spec at all —
 * every individual section degrades to empty.
 */
export function buildSpecBundle({
  domain,
  version,
  raw,
}: BuildBundleInput): SpecBundle {
  const parsed = UpstreamSpec.parse(raw);
  const meta = parsed.meta;

  const graph: ActionGraph = {
    edges: meta?.supportedActions ?? {},
    properties: meta?.apiProperties ?? {},
  };

  const docs: Record<string, string> = {};
  for (const doc of parsed.docs) {
    if (doc.slug === undefined || doc.content.length === 0) continue;
    docs[doc.slug] =
      doc.content.length > OVERVIEW_MAX_CHARS
        ? `${doc.content.slice(0, OVERVIEW_MAX_CHARS)}\n\n…truncated.`
        : doc.content;
  }

  // Only leaves are rules — a `group` row is a heading over other rows, and
  // counting it would inflate every total by the shape of the tree.
  const rules = extractRules(parsed.validationTable?.table ?? {});
  const rule_counts: Record<string, number> = {};
  for (const row of rules) {
    rule_counts[row.action] = (rule_counts[row.action] ?? 0) + 1;
  }

  const fields: Record<string, Record<string, FieldNode[]>> = {};
  const field_counts: Record<string, number> = {};
  for (const entry of parsed.attributes) {
    if (entry.useCaseId === undefined) continue;
    const byAction: Record<string, FieldNode[]> = {};
    let total = 0;
    for (const [action, tree] of Object.entries(entry.attributeSet)) {
      const flat = flattenAttributeSet(tree);
      byAction[action] = flat;
      total += flat.length;
    }
    fields[entry.useCaseId] = byAction;
    field_counts[entry.useCaseId] = total;
  }

  const schemas: Record<string, unknown> = {};
  for (const action of allActions({
    edges: meta?.supportedActions ?? {},
    properties: meta?.apiProperties ?? {},
  })) {
    const schema = schemaFor(meta?.paths, action);
    if (schema !== undefined) schemas[action] = schema;
  }

  const declaredUsecases = meta?.usecases ?? [];
  const statusByUsecase = new Map(
    (meta?.usecaseStatus ?? []).map((entry) => [entry.usecase, entry.status]),
  );
  const usecases = declaredUsecases.map((usecase) => ({
    usecase,
    status: statusByUsecase.get(usecase) ?? "unstated",
  }));

  const error_codes = parsed.meta?.errorCodes
    .map(toErrorCode)
    .filter((entry): entry is ErrorCodeEntry => entry !== undefined)
    .sort((a, b) => a.code.localeCompare(b.code));

  // `before`/`after` blobs are dropped: they are whole spec nodes, and the
  // `summary` line already says what moved.
  const recent_changes: BuildChange[] = [];
  for (const entry of parsed.changelog) {
    for (const section of entry.sections) {
      const rows = (section as { entries?: unknown }).entries;
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (typeof row !== "object" || row === null) continue;
        const { kind, path, summary } = row as {
          kind?: unknown;
          path?: unknown;
          summary?: unknown;
        };
        if (typeof summary !== "string") continue;
        recent_changes.push({
          kind: typeof kind === "string" ? kind : "changed",
          path: typeof path === "string" ? path : "",
          summary,
        });
      }
    }
  }

  const bundle: SpecBundle = {
    domain: meta?.domain ?? domain,
    version: meta?.version ?? version,
    ...(meta?.title !== undefined ? { title: meta.title } : {}),
    ...(meta?.description !== undefined
      ? { description: meta.description }
      : {}),
    ...(meta?.buildHash !== undefined ? { build_hash: meta.buildHash } : {}),
    ...(meta?.ingestedAt !== undefined ? { ingested_at: meta.ingestedAt } : {}),
    usecases,
    graph,
    actions: allActions(graph),
    error_codes: error_codes ?? [],
    docs,
    flows: parsed.flows.map((flow) => ({
      flow_id: flow.flowId,
      ...(flow.usecase !== undefined ? { usecase: flow.usecase } : {}),
      ...(flow.description !== undefined
        ? { description: flow.description }
        : {}),
      tags: flow.tags,
    })),
    rules,
    fields,
    schemas,
    rule_counts,
    field_counts,
    recent_changes: recent_changes.slice(0, 100),
    bytes: 0,
  };

  // Measured after assembly rather than estimated: the gauge this feeds is the
  // only way anyone can tell whether the bundle cap is set sensibly.
  return { ...bundle, bytes: JSON.stringify(bundle).length };
}
