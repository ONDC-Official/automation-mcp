import { appendSegment } from "@/modules/validate/validate.parse.js";

/**
 * The published field dictionary, flattened. Pure.
 *
 * **This is the file that can be wrong in a way nothing downstream catches**,
 * and therefore the file with the tests — this module's `validate.parse.ts`.
 *
 * The reason is narrow and worth stating. Every other part of the ingest
 * *echoes* something upstream published: a rule's description, an error code's
 * text. This one **invents** the thing a model then trusts most — the
 * JSONPath. The attribute tree carries no path of its own; it is a nest of
 * object keys, and the path is synthesised from them. ONDC key names include
 * `/` and `@` (`bpp/providers`, `@ondc/org/return_window` — 28 such keys in
 * `ONDC:RET11/1.2.5` alone), so a flattener that joins with dots produces
 * `$.message.catalog.bpp/providers.id`: a path that *looks* right, evaluates
 * to nothing, and sends the model to a field that does not exist. A plausible
 * wrong answer with no downstream detector.
 *
 * Hence `appendSegment`, imported from `validate.parse.ts` rather than
 * reimplemented. That file already spells a validator finding's `json_path`,
 * and the two must agree or `protocol_explain_rule` cannot match a real
 * rejection to the field it names.
 *
 * ## `usage` is an example, never a value
 *
 * Upstream calls it `usage`; we surface it as `example`, and the schema says
 * out loud that it is sometimes wrong — `ONDC:TRV11/2.0.1` publishes
 * `ONDC:FIS13` as the example for `context.domain`, and `ONDC:RET11/1.2.5`
 * publishes `ONDC:RET10`. Both verified live. Calling it `default` would put
 * a wrong value in front of the model at exactly the field it is most tempted
 * to copy.
 */

/** Upstream's per-node metadata. The only key that is ever a leaf marker. */
const DESCRIPTION_KEY = "_description";

/** Upstream ships this literal string where nobody wrote prose. */
const PLACEHOLDER = /^<.*>$/;

/** Enum values kept per field before `enum_total` takes over. */
const MAX_ENUMS = 12;

export interface FieldEnum {
  code: string;
  description?: string;
}

export interface FieldNode {
  /** JSONPath into the action's payload, spelled as `validate/` spells one. */
  path: string;
  /** Segments below `$`. Used by the depth filter. */
  depth: number;
  required: boolean;
  type?: string;
  /** Which side populates it. A field the counterparty owns is not yours to choose. */
  owner?: string;
  info?: string;
  /** Upstream's `usage`. Illustrative, sometimes wrong — never a value to copy. */
  example?: string;
  enums?: FieldEnum[];
  /** True count, when `enums` was truncated. */
  enum_total?: number;
}

interface RawDescription {
  required?: unknown;
  usage?: unknown;
  info?: unknown;
  owner?: unknown;
  type?: unknown;
  enums?: unknown;
}

/** Upstream writes `<placeholder description>` where nobody wrote prose. */
function prose(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || PLACEHOLDER.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * `owner` is `false` on a handful of nodes across the published builds rather
 * than a side name. Absent is the honest reading; "false" would be nonsense in
 * front of a model asked which side populates a field.
 */
function side(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function toEnums(value: unknown): Pick<FieldNode, "enums" | "enum_total"> {
  if (!Array.isArray(value) || value.length === 0) return {};
  const all = value.flatMap((entry): FieldEnum[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { code, description } = entry as {
      code?: unknown;
      description?: unknown;
    };
    if (typeof code !== "string") return [];
    const text = prose(description);
    return [{ code, ...(text !== undefined ? { description: text } : {}) }];
  });
  if (all.length === 0) return {};
  // `reference` is dropped: every published build ships the same placeholder
  // string in it, so it is bytes that carry nothing.
  return all.length > MAX_ENUMS
    ? { enums: all.slice(0, MAX_ENUMS), enum_total: all.length }
    : { enums: all };
}

function toField(path: string, depth: number, raw: RawDescription): FieldNode {
  const info = prose(raw.info);
  const example = prose(raw.usage);
  const type = side(raw.type);
  const owner = side(raw.owner);
  return {
    path,
    depth,
    required: raw.required === true,
    ...(type !== undefined ? { type } : {}),
    ...(owner !== undefined ? { owner } : {}),
    ...(info !== undefined ? { info } : {}),
    ...(example !== undefined ? { example } : {}),
    ...toEnums(raw.enums),
  };
}

/**
 * One action's field tree → a flat, sorted list.
 *
 * **Required first, then path-lexicographic.** That ordering is not cosmetic:
 * every tool that returns fields truncates, and a truncation over an unstable
 * order is a different answer on every call. It also means the default answer
 * leads with the fields a caller must populate.
 *
 * `required` never propagates in either direction. A required leaf under an
 * optional branch is exactly what upstream means — *if* you send the branch,
 * this is required inside it — and inferring either way would be us making up
 * protocol.
 */
export function flattenAttributeSet(tree: unknown): FieldNode[] {
  const fields: FieldNode[] = [];

  const walk = (node: unknown, path: string, depth: number): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node))
      return;
    const entries = node as Record<string, unknown>;

    const description = entries[DESCRIPTION_KEY];
    if (typeof description === "object" && description !== null) {
      // The root node describes the payload as a whole; it is never a field
      // anyone sets, and listing it as `$` crowds out a real one.
      if (depth > 0) {
        fields.push(toField(path, depth, description));
      }
    }

    for (const [key, value] of Object.entries(entries)) {
      if (key === DESCRIPTION_KEY) continue;
      walk(value, appendSegment(path, key), depth + 1);
    }
  };

  walk(tree, "$", 0);

  return fields.sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
}

export interface FieldFilter {
  /** Keep only paths at or below this prefix. */
  path_prefix?: string | undefined;
  /** Keep only paths this many segments below `$`. */
  max_depth?: number | undefined;
  required_only?: boolean | undefined;
  owner?: string | undefined;
}

/** Narrowing, in one place, so every caller filters identically. */
export function filterFields(
  fields: readonly FieldNode[],
  filter: FieldFilter,
): FieldNode[] {
  return fields.filter((field) => {
    if (filter.required_only === true && !field.required) return false;
    if (filter.max_depth !== undefined && field.depth > filter.max_depth) {
      return false;
    }
    if (
      filter.owner !== undefined &&
      field.owner?.toLowerCase() !== filter.owner.toLowerCase()
    ) {
      return false;
    }
    if (
      filter.path_prefix !== undefined &&
      !field.path.startsWith(filter.path_prefix)
    ) {
      return false;
    }
    return true;
  });
}

/**
 * Free-text search across the dictionary.
 *
 * **Term-based, not substring.** A whole-query substring match looks right and
 * fails on the only queries anyone actually types: "return window" finds
 * nothing, because the field is `@ondc/org/return_window` and the separator is
 * an underscore. Observed against `ONDC:RET11/1.2.5` — the search returned zero
 * hits for a field the build plainly publishes.
 *
 * So the query is split into terms and **every** term must appear somewhere in
 * the record. Ranking still prefers a path match over an enum code over prose,
 * because "which action carries fulfillment.stops" and "where does ONDC expect
 * a GSTIN" want opposite halves of it.
 */
export interface RankedField {
  field: FieldNode;
  /** 0 = every term in the path, 1 = path or enum code, 2 = prose only. */
  rank: number;
}

export function rankFields(
  fields: readonly FieldNode[],
  query: string,
): RankedField[] {
  // Non-alphanumerics are separators on both sides, so `return_window`,
  // `return-window` and `return window` are one query.
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return [];

  const scored: RankedField[] = [];
  for (const field of fields) {
    const path = field.path.toLowerCase();
    const codes = (field.enums ?? [])
      .map((e) => e.code.toLowerCase())
      .join(" ");
    const info = field.info?.toLowerCase() ?? "";

    if (!terms.every((term) => `${path} ${codes} ${info}`.includes(term))) {
      continue;
    }
    const rank = terms.every((term) => path.includes(term))
      ? 0
      : terms.every((term) => `${path} ${codes}`.includes(term))
        ? 1
        : 2;
    scored.push({ field, rank });
  }

  return scored.sort(compareRanked);
}

/**
 * The one ordering, exported so a caller merging several actions' hits sorts
 * the **merged** list rather than concatenating per-action rankings.
 *
 * That concatenation was a live bug: `protocol_search_fields` for "return
 * window" against `ONDC:RET11/1.2.5` returned four prose matches from
 * `confirm` and dropped the exact path match in `on_search`, because `confirm`
 * sorts first alphabetically and the limit was reached before the ranking
 * mattered. Ranking per group and truncating across groups is not ranking.
 */
export function compareRanked(a: RankedField, b: RankedField): number {
  return (
    a.rank - b.rank ||
    Number(b.field.required) - Number(a.field.required) ||
    a.field.path.localeCompare(b.field.path)
  );
}

/** Ranked hits for one field set, without the ranks. */
export function searchFields(
  fields: readonly FieldNode[],
  query: string,
): FieldNode[] {
  return rankFields(fields, query).map((entry) => entry.field);
}
