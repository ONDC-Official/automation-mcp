import jsonpath from "jsonpath";

/**
 * Patching a generated payload, for the case where the flow's own config is
 * wrong and nothing in this repo can fix it.
 *
 * ## Why this exists
 *
 * The payload is produced by the flow's published `generate`, which is normally
 * the strongest thing about this server — it cannot drift from the spec the way
 * a model's draft can. But a published config can simply be **wrong**, and then
 * the run has nowhere to go. Live TRV11, `search2_METRO_201`:
 *
 * ```js
 * existingPayload.context.bpp_id  = sessionData?.bppId[0];   // unwraps
 * existingPayload.context.bpp_uri = sessionData?.bppUri;     // ← missing [0]
 * ```
 *
 * `saveData` runs `jsonpath.query`, so `bppUri` is a list. One line unwraps and
 * the adjacent one does not, an array reaches a field the schema types as a
 * string, and the outbound gate stops the run. Two runs on 2026-07-31 ended
 * `gave_up` there: a correct participant got no compliance report because one
 * step of one flow had a typo upstream.
 *
 * ## What this is not
 *
 * Not a validation bypass. The gate still runs, on the *patched* payload, so an
 * override that does not fix the finding still blocks. The point is to let the
 * run continue with a **correct** payload — sending one we already know
 * violates L0 would write our defect into the participant's compliance report
 * and teach neither side anything.
 *
 * ## Two properties worth keeping
 *
 * - **Concrete paths only.** A wildcard, filter, slice or descendant selects a
 *   set, and `jsonpath.value` would write to exactly one member of it — the
 *   first, silently. A patch that half-lands is worse than one that is refused,
 *   because the model has no way to see which half.
 * - **All or nothing.** Every path is checked before any is written, so a
 *   refusal leaves the generated payload exactly as `generate` produced it.
 *   Otherwise a rejected call would still have mutated the payload, and the
 *   `applied` list would describe a state nobody asked for.
 */

/** Cap on how many paths one call may patch. */
export const MAX_OVERRIDES = 20;
/** Cap on one override's serialised value. */
export const MAX_OVERRIDE_VALUE_BYTES = 4_096;

/**
 * Paths an override may never name, in canonical form.
 *
 * Only the transaction id, and the reason is narrow: it is the one field that
 * breaks **our own** bookkeeping rather than the participant's expectations.
 * Records are keyed on it, the run binds to it, and `#assertTransactionId`
 * already exists to undo a config that rewrites it — letting a model do
 * deliberately what that guard undoes by accident would leave the receiver
 * writing to one half of a transaction while the loop tools read the other.
 *
 * `context.action` and `context.message_id` are deliberately **allowed**.
 * Making a payload disagree with itself is negative testing, which is a stated
 * goal of this server, and it costs nothing but a NACK from the counterparty.
 */
const REFUSED_PATHS = new Map<string, string>([
  [
    "context.transaction_id",
    "the transaction id keys every record and expectation for this run; " +
      "use flow_restart to open a fresh one instead",
  ],
]);

const SET_REFUSAL =
  "only a direct path can be overridden — a wildcard, filter, slice or `..` " +
  "selects a set, and a patch that lands on one member of it is worse than no patch";

export interface OverrideProblem {
  /** The path exactly as the caller wrote it. */
  readonly path: string;
  readonly reason: string;
}

export interface AppliedOverride {
  /** Canonical form, so two spellings of one location read alike. */
  readonly path: string;
  readonly value: unknown;
}

export interface OverrideOutcome {
  readonly applied: readonly AppliedOverride[];
  readonly problems: readonly OverrideProblem[];
}

/** A parsed path: its components, or why it cannot have any. */
type Parsed =
  | { readonly ok: true; readonly components: (string | number)[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Reduce a path to its components, or say why it cannot be one.
 *
 * `$.context.bpp_uri` and `$['context']['bpp_uri']` name the same location and
 * must be refused, recorded and reported as the same string. Numeric subscripts
 * stay numbers: `jsonpath.stringify(["$", "a", "0"])` is `$.a["0"]`, which sets
 * an object key rather than an array element.
 */
function parsePath(path: string): Parsed {
  let parsed: { expression: { type: string; value: unknown }; scope?: string }[];
  try {
    parsed = jsonpath.parse(path) as typeof parsed;
  } catch (error) {
    return {
      ok: false,
      reason: `not a valid JSONPath: ${
        error instanceof Error
          ? (error.message.split("\n")[0] ?? "unparseable")
          : String(error)
      }`,
    };
  }

  const components: (string | number)[] = [];
  for (const node of parsed) {
    const { type, value } = node.expression;
    if (type === "root") continue;
    if (node.scope !== "child") return { ok: false, reason: SET_REFUSAL };

    if (type === "identifier" || type === "string_literal") {
      components.push(String(value));
    } else if (type === "numeric_literal") {
      components.push(Number(value));
    } else {
      return { ok: false, reason: SET_REFUSAL };
    }
  }

  if (components.length === 0) {
    return {
      ok: false,
      reason: "the whole payload cannot be replaced — name the field to patch",
    };
  }
  return { ok: true, components };
}

/** How two spellings of one location are recognised as one. */
function canonicalise(components: readonly (string | number)[]): string {
  return jsonpath.stringify(["$", ...components]);
}

function sizeOf(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch {
    // A cycle, or a BigInt. Either way it is not going in a payload.
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Patch `payload` in place, or refuse and leave it untouched.
 *
 * Mutates on success only — every path is judged first. What a refusal means is
 * the caller's decision; here it is only ever reported.
 */
export function applyOverrides(
  payload: unknown,
  overrides: Record<string, unknown>,
): OverrideOutcome {
  const entries = Object.entries(overrides);

  if (entries.length > MAX_OVERRIDES) {
    return {
      applied: [],
      problems: [
        {
          path: "*",
          reason:
            `${String(entries.length)} overrides in one call, and the limit is ` +
            `${String(MAX_OVERRIDES)} — patching this much means the wrong flow ` +
            "is being run, not that one field is broken",
        },
      ],
    };
  }

  // Pass one: decide. Nothing is written until every path has been judged.
  const problems: OverrideProblem[] = [];
  const planned: { canonical: string; components: (string | number)[]; value: unknown }[] =
    [];
  const seen = new Map<string, string>();

  for (const [path, value] of entries) {
    const parsed = parsePath(path);
    if (!parsed.ok) {
      problems.push({ path, reason: parsed.reason });
      continue;
    }

    const canonical = canonicalise(parsed.components);
    const refusal = REFUSED_PATHS.get(parsed.components.join("."));
    if (refusal !== undefined) {
      problems.push({
        path,
        reason: `${canonical} cannot be overridden: ${refusal}`,
      });
      continue;
    }

    // Two spellings of one location would otherwise apply in object-key order,
    // which is not an order the caller chose.
    const twin = seen.get(canonical);
    if (twin !== undefined) {
      problems.push({
        path,
        reason: `names the same field as "${twin}" — give it once`,
      });
      continue;
    }
    seen.set(canonical, path);

    const bytes = sizeOf(value);
    if (bytes > MAX_OVERRIDE_VALUE_BYTES) {
      problems.push({
        path,
        reason:
          `the value is ${
            Number.isFinite(bytes) ? `${String(bytes)} bytes` : "not serialisable"
          }, and the limit is ${String(MAX_OVERRIDE_VALUE_BYTES)} — an override ` +
          "repairs a field, it does not supply a message body",
      });
      continue;
    }

    planned.push({ canonical, components: parsed.components, value });
  }

  if (problems.length > 0) return { applied: [], problems };

  // Pass two: write. `jsonpath.value` creates missing intermediate objects, so
  // a field the config omitted entirely can be supplied and not only corrected.
  const applied: AppliedOverride[] = planned.map(({ canonical, value }) => {
    jsonpath.value(payload, canonical, value);
    return { path: canonical, value };
  });

  return { applied, problems: [] };
}

/**
 * The override that would fix a set of findings, as a line the model can act on.
 *
 * The gate already knows each offending `json_path`; before this it said only
 * "inspect it with dry_run", which is what walked a model into diagnosing a
 * config defect correctly and then stopping anyway. Paths that could not be
 * overridden are left out rather than suggested and then refused.
 */
export function suggestOverrides(
  findings: readonly { json_path?: string | undefined }[],
): string | undefined {
  const paths = [
    ...new Set(
      findings
        .map((finding) => finding.json_path)
        .filter((path): path is string => path !== undefined && path.length > 0),
    ),
  ].filter((path) => {
    const parsed = parsePath(path);
    return (
      parsed.ok && !REFUSED_PATHS.has(parsed.components.join("."))
    );
  });

  if (paths.length === 0) return undefined;

  return (
    "If the flow's own config is at fault and cannot be fixed at source, patch " +
    "the field and re-run this step rather than abandoning the run: " +
    `payload_overrides {${paths
      .map((path) => `"${path}": <a valid value>`)
      .join(", ")}}. The gate still runs on the patched payload, so an override ` +
    "that does not fix the finding still blocks."
  );
}
