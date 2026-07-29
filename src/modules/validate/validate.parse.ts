import {
  L0_CODE,
  UNPARSED_CODE,
  type ValidationFinding,
} from "@/modules/validate/validate.schema.js";

/**
 * Turning the api-service's prose into findings.
 *
 * ## Why this file is the one with the tests
 *
 * The oracle answers a rejection with a single `error.message` string. There is
 * no structured alternative: ONIX's error model does carry an `error.paths`
 * field of `;`-joined JSONPaths, but it was empty on every response captured
 * from the live service, L0 and L1 alike. So every code and every JSONPath this
 * server reports about protocol validity is produced here.
 *
 * ## Two grammars, and L0 short-circuits L1
 *
 * A schema failure stops the pipeline, so the two never mix — which is what
 * makes the layer inferable rather than guessed.
 *
 * **L0** — plain text, entries joined by `";\n "`:
 *
 * ```
 * at '/context/timestamp': got number, want string;
 *  at '/message/intent': got string, want object
 * ```
 *
 * **L1** — markdown, one block per rule code, each block optionally carrying a
 * conjunction of conditions and a "Skip if" guard:
 *
 * ```
 * #### **REQUIRED_CONTEXT_CODE_1**
 *
 * **All of the following must be true:**
 *   - $.context.location.country.code must be present in the payload
 *   - All elements of $.context.location.country.code must be in ["IND"];
 *  #### **VALID_ENUM_MESSAGE_TYPE_1**
 *
 * - All elements of $.message.intent.fulfillment.type must be in ["ROUTE", "TRIP"]
 *
 * > **Skip if:**
 * >
 * >     - $.message.intent.fulfillment.type is not in the payload;
 *  for full list of validations refer https://…
 * ```
 *
 * ## The two rules this file must never break
 *
 * **It never throws.** This runs inside the receiver's ACK window. An upstream
 * copy-edit must not become a 500 answered to a participant, who would record it
 * as our non-compliance.
 *
 * **It never silently loses a failure.** Anything unrecognised becomes one
 * finding carrying the raw text under `VALIDATION_UNPARSED`. A rejection we
 * cannot parse is still a rejection, and dropping it would turn `invalid` into
 * an empty finding list — which reads exactly like `valid`.
 */

export interface ParsedMessage {
  findings: ValidationFinding[];
  /** The published rule list, lifted out of the trailing sentence. */
  docsUrl?: string;
}

/** The sentence upstream appends to every L1 rejection. */
const DOCS_CLAUSE = /[;\s]*for full list of validations refer\s+(\S+)\s*$/i;

/** `#### **CODE**` — the header that opens each L1 block. */
const L1_BLOCK = /#{2,6}\s*\*\*/;

/** `at '/pointer': detail` — one L0 entry. */
const L0_ENTRY = /^at\s+'([^']*)'\s*:\s*([\s\S]*)$/;

/** The first JSONPath in a sentence. Stops at whitespace, comma or semicolon. */
const JSON_PATH = /\$(?:\.[^\s,;]+)?/;

/** Markdown scaffolding that carries no information about the failure. */
const NOISE = /\*\*All of the following must be true:\*\*/gi;

export function parseValidationMessage(raw: string): ParsedMessage {
  const withoutDocs = raw.replace(DOCS_CLAUSE, "");
  const docsUrl = DOCS_CLAUSE.exec(raw)?.[1];
  const text = withoutDocs.trim();

  const findings =
    text === ""
      ? [
          unparsed(
            "The validator rejected this payload without saying why.",
          ),
        ]
      : L1_BLOCK.test(text)
        ? parseL1(text)
        : parseL0(text);

  return { findings, ...(docsUrl !== undefined ? { docsUrl } : {}) };
}

/* -------------------------------------------------------------------------- */
/* L1 — markdown, one block per rule                                           */
/* -------------------------------------------------------------------------- */

/**
 * One finding per **rule code**, not per bullet.
 *
 * A rule with "All of the following must be true" fails as a unit and is
 * reported by the spec as a unit, so splitting its conditions into separate
 * findings would invent failures the validator never claimed. The conditions are
 * joined into the message instead.
 */
function parseL1(text: string): ValidationFinding[] {
  const [preamble, ...blocks] = text.split(L1_BLOCK);
  const findings: ValidationFinding[] = [];

  // Text before the first header. Normally empty; if upstream ever puts
  // something there, it is a failure we would otherwise drop.
  const leading = (preamble ?? "").trim();
  if (leading !== "") findings.push(unparsed(leading));

  for (const block of blocks) {
    const split = /^([^*]*)\*\*([\s\S]*)$/.exec(block);
    if (!split) {
      const stray = block.trim();
      if (stray !== "") findings.push(unparsed(stray));
      continue;
    }

    const code = (split[1] ?? "").trim();
    const body = split[2] ?? "";

    // The guard is worth keeping whole: for a conditional rule it is usually the
    // fastest route to the fix — the field is absent, or has a value that should
    // have exempted it.
    const guardAt = body.search(/>\s*\*\*Skip if:\*\*/i);
    const assertion = guardAt >= 0 ? body.slice(0, guardAt) : body;
    const guard = guardAt >= 0 ? body.slice(guardAt) : undefined;

    const message = clean(assertion);
    const skipIf =
      guard === undefined
        ? undefined
        : clean(guard.replace(/>\s*\*\*Skip if:\*\*/i, "").replace(/^\s*>/gm, ""));

    findings.push({
      layer: "L1",
      code: code === "" ? UNPARSED_CODE : code,
      json_path: pathIn(message) ?? pathIn(skipIf ?? "") ?? "$",
      message: message === "" ? "This rule rejected the payload." : message,
      ...(skipIf !== undefined && skipIf !== "" ? { skip_if: skipIf } : {}),
    });
  }

  return findings.length > 0 ? findings : [unparsed(text)];
}

/* -------------------------------------------------------------------------- */
/* L0 — plain text, one entry per schema violation                             */
/* -------------------------------------------------------------------------- */

function parseL0(text: string): ValidationFinding[] {
  const findings = text
    .split(/;\s*\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry): ValidationFinding => {
      const match = L0_ENTRY.exec(entry);
      if (!match) return unparsed(entry, "L0");

      return {
        layer: "L0",
        code: L0_CODE,
        json_path: pointerToPath(match[1] ?? ""),
        message: clean(match[2] ?? ""),
      };
    });

  return findings.length > 0 ? findings : [unparsed(text, "L0")];
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A JSON Pointer as a JSONPath.
 *
 * Numeric segments become indices, and anything that is not a bare identifier
 * gets bracket-quoted — ONDC field names include `@ondc/org/...`, which is not
 * expressible in dotted form and would otherwise produce a path no JSONPath
 * implementation can evaluate.
 */
export function pointerToPath(pointer: string): string {
  const trimmed = pointer.replace(/^\//, "");
  if (trimmed === "") return "$";

  return trimmed
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((path, segment) => {
      if (/^\d+$/.test(segment)) return `${path}[${segment}]`;
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) return `${path}.${segment}`;
      return `${path}['${segment.replace(/'/g, "\\'")}']`;
    }, "$");
}

/** The first JSONPath mentioned, with trailing punctuation trimmed. */
function pathIn(text: string): string | undefined {
  const found = JSON_PATH.exec(text)?.[0];
  if (found === undefined) return undefined;
  const trimmed = found.replace(/[.,;:]+$/, "");
  return trimmed === "$" || trimmed.length > 1 ? trimmed : undefined;
}

/** Markdown and whitespace out, one readable sentence in. */
function clean(text: string): string {
  return text
    .replace(NOISE, "")
    .replace(/^[\s>]*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .replace(/[;\s]+$/, "")
    .trim();
}

/**
 * A failure we could not parse, kept verbatim.
 *
 * The layer is a guess and the code says so. L1 is the default because it is the
 * broader claim — "a rule rejected this" rather than "this is structurally
 * malformed" — and because L0 short-circuiting means the markdown path is the
 * one that actually runs most of the time.
 */
function unparsed(
  message: string,
  layer: "L0" | "L1" = "L1",
): ValidationFinding {
  return { layer, code: UNPARSED_CODE, json_path: "$", message };
}
