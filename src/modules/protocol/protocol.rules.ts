import { L0_CODE, UNPARSED_CODE } from "@/modules/validate/validate.schema.js";

/**
 * The published L1 rule table, indexed. Pure.
 *
 * This closes a loop that has been open since `validate/` shipped.
 * `validate.parse.ts` regex-scrapes rule codes out of a *rejection's prose*
 * and lifts a `docs_url` it never fetches — while the very same rules are
 * published in structured form, 904 to 1942 of them per build, each with a
 * name, plain-English description and skip condition. We were reading the
 * catalogue out of the exhaust.
 *
 * ## Three things that make a naive index silently wrong
 *
 * 1. **Rule names are not unique across actions.** 142 of 508 names in
 *    `ONDC:TRV11/2.0.1` and 320 of 727 in `ONDC:RET11/1.2.5` appear in more
 *    than one action — `REQUIRED_CONTEXT_CODE_1` is in fourteen. So the index
 *    is keyed on `(action, name)` and a name-only lookup returns **every**
 *    action it applies to. Keying on the name alone answers confidently with
 *    one arbitrary action's row.
 * 2. **RET builds wrap names in markdown asterisks** — `**CONTEXT_REQUIRED**`
 *    — which is the same spelling `validate.parse.ts` scrapes out of an
 *    `#### **CODE**` header. TRV builds do not. Normalising by stripping `*`
 *    is what lets a real rejection be matched back to its published rule.
 * 3. **`scope` arrives backtick-wrapped**, on every row that has one
 *    (75/75 in TRV11, 6/6 in RET11). A JSONPath matcher that does not strip
 *    them finds nothing, forever, with no error.
 *
 * ## What is deliberately not built on
 *
 * `errorCode` is `30000` on 894 of 904 TRV11 rows and 1543 of 1942 RET11 rows,
 * the rest empty — it is the JVAL compiler's documented default `_ERROR_CODE_`,
 * not a business code. A rule → business-error-code mapping built on it would
 * be a confident wrong answer, so `explain` returns the column as published
 * and never joins on it.
 */

/** Rows that are headings over other rows, not checks. */
const GROUP_ROW = "group";

export interface RuleRow {
  action: string;
  /** As published, asterisks and all — this is what a caller will paste back. */
  name: string;
  /** Breadcrumb of enclosing group rows, when upstream gave one. */
  group?: string;
  /** JSONPath the rule is scoped to, backticks stripped. */
  scope?: string;
  description?: string;
  skip_if?: string;
  /** Published verbatim. Almost always the compiler's default — see the header. */
  error_code?: string;
}

export interface RuleIndex {
  readonly rows: readonly RuleRow[];
  /** Normalised name → every row carrying it, across actions. */
  readonly byName: ReadonlyMap<string, readonly RuleRow[]>;
}

/**
 * One spelling for a rule name.
 *
 * `**CONTEXT_REQUIRED**` (RET, and what `validate.parse.ts` scrapes) and
 * `CONTEXT_REQUIRED` (TRV) are the same rule.
 */
export function normaliseRuleName(name: string): string {
  return name.replace(/\*/g, "").trim().toUpperCase();
}

/** `` `$.context.location.city` `` → `$.context.location.city`. */
function unquoteScope(scope: unknown): string | undefined {
  if (typeof scope !== "string") return undefined;
  const trimmed = scope.replace(/`/g, "").trim();
  return trimmed === "" ? undefined : trimmed;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

interface RawRow {
  rowType?: unknown;
  name?: unknown;
  group?: unknown;
  scope?: unknown;
  description?: unknown;
  skipIf?: unknown;
  errorCode?: unknown;
}

/**
 * Pull the leaf rows out of `validationTable.table`. Never throws.
 *
 * Split from `indexRows` because the rows are what the bundle stores: the
 * `CacheStore` contract is that a stored value round-trips through JSON, so a
 * `Map` cannot live in a bundle even though `catalogCache` is always
 * in-process. Building the index is one pass over ~2000 rows and is done where
 * it is needed rather than cached separately, which would be a second thing to
 * keep coherent with the first.
 */
export function extractRules(
  table: Readonly<Record<string, { rows?: readonly unknown[] }>>,
): RuleRow[] {
  const rows: RuleRow[] = [];

  for (const [action, entry] of Object.entries(table)) {
    for (const raw of entry.rows ?? []) {
      if (typeof raw !== "object" || raw === null) continue;
      const row = raw as RawRow;
      // A group row's description is "Sub-tests: A, B, C" — it says nothing the
      // leaves' own `group` breadcrumb does not already say.
      if (row.rowType === GROUP_ROW) continue;
      const name = text(row.name);
      if (name === undefined) continue;

      rows.push({
        action,
        name,
        ...(text(row.group) !== undefined ? { group: text(row.group) } : {}),
        ...(unquoteScope(row.scope) !== undefined
          ? { scope: unquoteScope(row.scope) }
          : {}),
        ...(text(row.description) !== undefined
          ? { description: text(row.description) }
          : {}),
        ...(text(row.skipIf) !== undefined
          ? { skip_if: text(row.skipIf) }
          : {}),
        ...(text(row.errorCode) !== undefined
          ? { error_code: text(row.errorCode) }
          : {}),
      });
    }
  }

  return rows;
}

/** Index already-extracted rows by normalised name. */
export function indexRows(rows: readonly RuleRow[]): RuleIndex {
  const byName = new Map<string, RuleRow[]>();
  for (const row of rows) {
    const key = normaliseRuleName(row.name);
    const bucket = byName.get(key);
    if (bucket === undefined) byName.set(key, [row]);
    else bucket.push(row);
  }
  return { rows, byName };
}

/** Extract and index in one step. */
export function indexRules(
  table: Readonly<Record<string, { rows?: readonly unknown[] }>>,
): RuleIndex {
  return indexRows(extractRules(table));
}

/**
 * What kind of thing a caller pasted.
 *
 * One `query` field with four grammars, because somebody holding a
 * `ValidationFinding.code` should not have to know which kind it is — that is
 * exactly the moment they know least.
 */
export type QueryKind =
  "rule_name" | "error_code" | "json_path" | "pseudo_code";

export function classifyQuery(query: string): QueryKind {
  const trimmed = query.trim();
  // Ours, not upstream's: `validate.parse.ts` synthesises these when the
  // rejection was a schema failure or could not be parsed at all.
  if (
    trimmed === L0_CODE ||
    trimmed === UNPARSED_CODE ||
    normaliseRuleName(trimmed) === L0_CODE ||
    normaliseRuleName(trimmed) === UNPARSED_CODE
  ) {
    return "pseudo_code";
  }
  if (trimmed.startsWith("$")) return "json_path";
  // Checked before rule_name: some published names are numeric-looking, but a
  // bare run of digits is always a code.
  if (/^\d{4,6}$/.test(trimmed)) return "error_code";
  return "rule_name";
}

export interface RuleLookup {
  kind: QueryKind;
  matches: RuleRow[];
  /** Total before any limit, so a caller knows what it did not see. */
  total: number;
  /** Rows per action, for a query that matched far too many to return. */
  per_action: Record<string, number>;
}

/** Resolve a query against the index. Filters by action when one is named. */
export function lookupRules(
  index: RuleIndex,
  query: string,
  options: { action?: string | undefined; limit: number },
): RuleLookup {
  const kind = classifyQuery(query);
  const trimmed = query.trim();

  let matched: readonly RuleRow[];
  switch (kind) {
    case "rule_name":
      matched = index.byName.get(normaliseRuleName(trimmed)) ?? [];
      break;
    case "error_code":
      matched = index.rows.filter((row) => row.error_code === trimmed);
      break;
    case "json_path": {
      const needle = trimmed.toLowerCase();
      matched = index.rows.filter(
        (row) =>
          row.scope?.toLowerCase().includes(needle) === true ||
          row.description?.toLowerCase().includes(needle) === true ||
          row.skip_if?.toLowerCase().includes(needle) === true,
      );
      break;
    }
    case "pseudo_code":
      // Neither is a published rule, and saying so is the answer.
      matched = [];
      break;
  }

  const scoped =
    options.action === undefined
      ? matched
      : matched.filter((row) => row.action === options.action);

  const per_action: Record<string, number> = {};
  for (const row of scoped) {
    per_action[row.action] = (per_action[row.action] ?? 0) + 1;
  }

  return {
    kind,
    matches: scoped.slice(0, options.limit),
    total: scoped.length,
    per_action,
  };
}

/** What to tell a caller who pasted one of our own synthesised codes. */
export function pseudoCodeNote(query: string): string | undefined {
  const normalised = normaliseRuleName(query.trim());
  if (normalised === L0_CODE) {
    return (
      `${L0_CODE} is not a published rule — it is what this server calls a ` +
      "JSON Schema failure. The shape it violated is the action's schema; " +
      "read it with the ondc://schema/{domain}/{version}/{action} resource, " +
      "and use the finding's json_path to find the field."
    );
  }
  if (normalised === UNPARSED_CODE) {
    return (
      `${UNPARSED_CODE} means the validator's text could not be parsed, so ` +
      "no rule name was recovered. Search by the finding's json_path instead."
    );
  }
  return undefined;
}
