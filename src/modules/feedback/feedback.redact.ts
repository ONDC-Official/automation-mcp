import { createHmac } from "node:crypto";
import type { IncidentEvidence } from "@/modules/feedback/feedback.schema.js";
import {
  EVIDENCE_STRING_LIMIT,
  REPORT_FINDING_LIMIT,
  RUNNER_LOG_LIMIT,
} from "@/modules/feedback/feedback.schema.js";

/**
 * Everything that decides what a report may contain.
 *
 * This file is to `feedback` what `validate.parse.ts` is to `validate`: the one
 * module that can be wrong in a way nothing downstream catches. It is pure, it
 * does no I/O, and it is where the tests live.
 *
 * ## Default-deny, not deny-list
 *
 * A deny-list of PII paths is only as good as the imagination of whoever wrote
 * it, and ONDC payloads are somebody else's schema — FIS12 loan applications and
 * TRV11 trip bookings carry personal data in places no list here would predict,
 * and `form_submit`'s `fields` map is a flat bag of loan-application answers with
 * no protocol shape at all.
 *
 * So the rule inverts: **every leaf value is replaced by a type token unless an
 * allowlist entry names it.** Key names, types and array lengths survive, which
 * is what a protocol corpus actually needs — the bug is nearly always "this
 * field is missing / the wrong type / the wrong shape", never "this field said
 * Ramesh". A field nobody thought about is redacted by omission rather than
 * leaked by oversight.
 *
 * ## The three transforms, and why free text needs its own
 *
 * 1. `structuralise` — payload bodies. Default-deny, as above.
 * 2. `pseudonymise` — identifiers. Stable per install, so one participant's runs
 *    correlate across reports, and not reversible without the local salt.
 * 3. `scrubText` — prose. Structural redaction cannot reach a value quoted
 *    *inside* a sentence, and three of our sources do exactly that: the
 *    validation oracle's L0 grammar (`at '/p': got 'ram@x.com', want …`), a
 *    participant's NACK message, and the model's own narration.
 *
 * All three are applied before anything is written to the store, never at
 * upload time. Unredacted personal data should not sit in the state store
 * waiting for a flush that may never come.
 */

/* -------------------------------------------------------------------------- */
/* Caps                                                                        */
/* -------------------------------------------------------------------------- */

/** How deep `structuralise` descends before it stops describing. */
const MAX_DEPTH = 12;
/** How many elements of an array are described; the rest are counted. */
const MAX_ARRAY_SAMPLE = 3;
/**
 * Total nodes any one `structuralise` may emit.
 *
 * An `on_search` catalog is hundreds of kilobytes, and its *shape* is nearly as
 * large as its content. A report is not the place to find that out.
 */
const MAX_NODES = 1_500;

const TRUNCATED = "<truncated>";

/* -------------------------------------------------------------------------- */
/* The allowlist                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Leaves kept verbatim, matched against the **tail** of a path.
 *
 * Tail matching rather than absolute paths, for two reasons: the same context
 * block appears at different depths across beckn versions, and it sidesteps the
 * bracket-quoting problem entirely — paths are compared as segment arrays, so a
 * key like `@ondc/org/settlement` never has to be escaped in the first place.
 *
 * Everything here is protocol machinery that identifies no one:
 *
 * - the context coordinates, which are what a corpus groups by;
 * - `timestamp` and `ttl`, because clock skew is a real finding — `seq` ordering
 *   in `reduce-history.ts` exists precisely because a participant's clock ran
 *   fast, and a report that structuralises the timestamps could never show it;
 * - `city` / `country`, which are ONDC standard codes (`std:080`, `IND`), not
 *   locations;
 * - error codes and ACK statuses, which are the finding itself.
 */
const ALLOW_TAILS: readonly (readonly string[])[] = [
  ["context", "action"],
  ["context", "domain"],
  ["context", "version"],
  ["context", "core_version"],
  ["context", "country"],
  ["context", "city"],
  ["context", "ttl"],
  ["context", "timestamp"],
  ["location", "country", "code"],
  ["location", "city", "code"],
  ["error", "code"],
  ["error", "type"],
  ["ack", "status"],
  ["status"],
];

/**
 * Keys whose values are replaced by a stable pseudonym rather than a type token.
 *
 * These are worth keeping *correlatable* — two reports naming the same
 * participant should be linkable — but never legible. A subscriber URL is a
 * hostname that identifies a company; a transaction id is a join key.
 */
const PSEUDONYM_KEYS = new Map<string, string>([
  ["bap_id", "np"],
  ["bpp_id", "np"],
  ["bap_uri", "np"],
  ["bpp_uri", "np"],
  ["subscriber_id", "np"],
  ["subscriber_url", "np"],
  ["transaction_id", "txn"],
  ["message_id", "msg"],
]);

/* -------------------------------------------------------------------------- */
/* Text scrubbing                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Ordered, and the order is load-bearing in two places that are easy to get
 * backwards — both were caught by the tests below rather than by reading:
 *
 * - **URL userinfo must precede the email rule.** `https://user:pw@np.example.com`
 *   contains something the email pattern matches, and if it wins the credential
 *   is only half removed. Running userinfo first also disarms the email rule for
 *   that span, because the `>` the placeholder ends with is not in the local-part
 *   character class.
 * - **E.164 must precede the bare 12-digit rule**, which would otherwise eat
 *   `+91` + a 10-digit mobile as though it were an account number. Specific
 *   shapes before general ones throughout, or the corpus loses the distinction
 *   between "an Aadhaar leaked here" and "some number leaked here".
 */
const SCRUBBERS: readonly (readonly [RegExp, string])[] = [
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1<userinfo>@"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<jwt>"],
  [/\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b/g, "<gstin>"],
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, "<pan>"],
  [/-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/g, "<gps>"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ipv4>"],
  [/\+\d{1,3}[-\s]?\d{6,12}\b/g, "<phone>"],
  [/\b\d{4}\s\d{4}\s\d{4}\b/g, "<id12>"],
  [/\b\d{12}\b/g, "<id12>"],
  [/\b[6-9]\d{9}\b/g, "<phone>"],
  [/\b\d{9,}\b/g, "<digits>"],
];

/**
 * Remove anything that looks personal from free prose.
 *
 * Deliberately eager. A false positive costs a `<phone>` where an order number
 * would have been more useful; a false negative puts a real customer's mobile
 * number in a corpus we intend to share.
 */
export function scrubText(
  value: string,
  limit = EVIDENCE_STRING_LIMIT,
): string {
  let out = value;
  for (const [pattern, replacement] of SCRUBBERS) {
    out = out.replace(pattern, replacement);
  }
  return out.length > limit ? `${out.slice(0, limit)}${TRUNCATED}` : out;
}

/** UUID v1–v5, the shape every id in this system takes. */
const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Replace ids quoted *inside prose* with the same pseudonyms the structured
 * fields get.
 *
 * Without this the report is inconsistent in a way that defeats the point:
 * `context.transaction_id` is pseudonymised, and then a journal summary says
 * "Flow X minted transaction f5473454-…" in plain text two lines below. Found by
 * reading an actual generated report rather than by a test, which is why the
 * plan's "read the JSON by eye" step exists.
 *
 * Pseudonymised rather than blanked so two lines about the same run still
 * correlate inside the corpus — which is most of what a journal slice is for.
 */
export function scrubIds(value: string, salt: string): string {
  return value.replace(UUID_PATTERN, (match) =>
    pseudonymise(match.toLowerCase(), salt, "id"),
  );
}

/**
 * The full treatment for free text: **ids first, then shapes.**
 *
 * That order is load-bearing and was found by a failing test rather than by
 * reading. A UUID's last group is twelve hex digits, and roughly one in ten is
 * all decimal — so `\b\d{12}\b` fires on the tail of
 * `…-8333-444455556666` and turns half an id into `<id12>`, which is both a
 * worse redaction and a corrupted one. Pseudonymising first removes the
 * hyphenated shape entirely, and the `id_…` it leaves behind is immune to the
 * digit rules because `_` is a word character and kills the `\b`.
 *
 * Everything prose-shaped that reaches a report goes through this: the
 * validator's quoted values, a participant's NACK message, the model's own
 * narration, a journal summary.
 */
export function scrubProse(
  value: string,
  salt: string,
  limit = EVIDENCE_STRING_LIMIT,
): string {
  return scrubText(scrubIds(value, salt), limit);
}

/**
 * Scrub a stack trace, keeping `file:line` and losing the filesystem.
 *
 * An absolute path outside the repository contains the operator's home
 * directory, and therefore their name — `/Users/<name>/...` is PII that arrives
 * by accident in every sandbox throw. Paths inside the repo become relative,
 * which is strictly more readable than what we started with.
 */
export function scrubStack(
  stack: string,
  repoRoot?: string,
  limit = EVIDENCE_STRING_LIMIT,
): string {
  const withoutPaths = stack.replace(/(?:\/[^\s():[\]"']+)+/g, (match) => {
    if (
      repoRoot !== undefined &&
      repoRoot.length > 0 &&
      match.startsWith(repoRoot)
    ) {
      const relative = match.slice(repoRoot.length).replace(/^\/+/, "");
      return relative.length > 0 ? relative : ".";
    }
    const basename = match.slice(match.lastIndexOf("/") + 1);
    return basename.length > 0 ? `<path>/${basename}` : "<path>";
  });
  return scrubText(withoutPaths, limit);
}

/* -------------------------------------------------------------------------- */
/* Pseudonyms                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A stable, non-reversible stand-in for an identifier.
 *
 * HMAC rather than a plain hash so that knowing the input space — and subscriber
 * URLs are a small, public, enumerable space — is not enough to invert it. The
 * salt never leaves the machine.
 */
export function pseudonymise(value: string, salt: string, kind = "id"): string {
  const digest = createHmac("sha256", salt).update(value).digest("hex");
  return `${kind}_${digest.slice(0, 12)}`;
}

/** A stable pseudonym for the installation itself, so its reports group. */
export function installId(salt: string): string {
  return pseudonymise("__install__", salt, "inst");
}

/* -------------------------------------------------------------------------- */
/* Structural redaction                                                        */
/* -------------------------------------------------------------------------- */

function typeToken(value: unknown): string {
  if (value === null) return "<null>";
  switch (typeof value) {
    case "string":
      return `<string:${String(value.length)}>`;
    case "number":
      return "<number>";
    case "boolean":
      return "<bool>";
    default:
      return `<${typeof value}>`;
  }
}

function matchesTail(
  path: readonly string[],
  tail: readonly string[],
): boolean {
  if (tail.length > path.length) return false;
  const offset = path.length - tail.length;
  return tail.every((segment, index) => path[offset + index] === segment);
}

function isAllowed(path: readonly string[]): boolean {
  return ALLOW_TAILS.some((tail) => matchesTail(path, tail));
}

interface Budget {
  nodes: number;
}

function walk(
  value: unknown,
  path: readonly string[],
  depth: number,
  salt: string,
  budget: Budget,
): unknown {
  if (budget.nodes <= 0) return TRUNCATED;
  budget.nodes -= 1;

  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return `<array:${String(value.length)}>`;
    // The element path drops the index, so `items[3].id` and `items[0].id` are
    // one path as far as the allowlist is concerned.
    const sample = value
      .slice(0, MAX_ARRAY_SAMPLE)
      .map((entry) => walk(entry, path, depth + 1, salt, budget));
    const hidden = value.length - sample.length;
    return hidden > 0 ? [...sample, `<+${String(hidden)} more>`] : sample;
  }

  if (value !== null && typeof value === "object") {
    if (depth >= MAX_DEPTH) return "<object>";
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (budget.nodes <= 0) {
        out[TRUNCATED] = true;
        break;
      }
      out[key] = walk(entry, [...path, key], depth + 1, salt, budget);
    }
    return out;
  }

  const key = path[path.length - 1];
  const pseudonymKind = key !== undefined ? PSEUDONYM_KEYS.get(key) : undefined;
  if (pseudonymKind !== undefined && typeof value === "string") {
    return pseudonymise(value, salt, pseudonymKind);
  }

  if (isAllowed(path)) {
    // Allowlisted, but still prose as far as we know — an `error.code` that
    // quotes the offending value is not hypothetical.
    return typeof value === "string" ? scrubText(value, 200) : value;
  }

  return typeToken(value);
}

/**
 * A payload with its shape intact and its content gone.
 *
 * Key names, types and array lengths survive; every leaf value outside
 * `ALLOW_TAILS` becomes a type token, and identifiers become pseudonyms.
 */
export function structuralise(value: unknown, salt: string): unknown {
  return walk(value, [], 0, salt, { nodes: MAX_NODES });
}

/* -------------------------------------------------------------------------- */
/* Evidence                                                                    */
/* -------------------------------------------------------------------------- */

export interface RedactOptions {
  /** Per-install HMAC salt. Never leaves the machine. */
  readonly salt: string;
  /** Absolute repo root, so in-repo stack frames stay readable. */
  readonly repoRoot?: string;
}

/**
 * Redact evidence at capture time.
 *
 * Called from `note()`, not from `flush()`, so nothing unredacted is ever
 * written to the state store — a report that is never sent should still not
 * have left personal data sitting behind it.
 */
export function redactEvidence(
  evidence: IncidentEvidence,
  options: RedactOptions,
): IncidentEvidence {
  const { salt, repoRoot } = options;

  return {
    ...(evidence.message !== undefined
      ? { message: scrubProse(evidence.message, salt) }
      : {}),
    ...(evidence.runner_logs !== undefined
      ? {
          runner_logs: evidence.runner_logs
            .slice(0, RUNNER_LOG_LIMIT)
            .map((line) => scrubProse(line, salt, 500)),
        }
      : {}),
    ...(evidence.runner_stack !== undefined
      ? { runner_stack: scrubIds(scrubStack(evidence.runner_stack, repoRoot), salt) }
      : {}),
    ...(evidence.sequence !== undefined ? { sequence: evidence.sequence } : {}),
    ...(evidence.delivery !== undefined ? { delivery: evidence.delivery } : {}),
    ...(evidence.error_codes !== undefined
      ? { error_codes: evidence.error_codes }
      : {}),
    ...(evidence.http_status !== undefined
      ? { http_status: evidence.http_status }
      : {}),
    ...(evidence.ack !== undefined ? { ack: evidence.ack } : {}),
    ...(evidence.findings !== undefined
      ? {
          // `layer`, `code` and `json_path` are structural and stay verbatim —
          // a JSONPath is where a value is, never the value. Only the prose is
          // scrubbed, because upstream's L0 grammar quotes what it rejected.
          findings: evidence.findings
            .slice(0, REPORT_FINDING_LIMIT)
            .map((finding) => ({
              ...finding,
              message: scrubProse(finding.message, salt, 500),
            })),
        }
      : {}),
    ...(evidence.unchecked !== undefined
      ? {
          unchecked: evidence.unchecked.map((entry) => ({
            layer: entry.layer,
            reason: scrubProse(entry.reason, salt, 300),
          })),
        }
      : {}),
    ...(evidence.payload_shape !== undefined
      ? { payload_shape: structuralise(evidence.payload_shape, salt) }
      : {}),
  };
}
