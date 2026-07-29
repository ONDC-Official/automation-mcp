import { z } from "zod";
import { EventsField } from "@/modules/record/record.schema.js";

/**
 * The vocabulary of protocol validation.
 *
 * ## The layer model, and how to add to it
 *
 * ONDC validation is layered, and the layers are independent of *who* performs
 * them. Today L0 and L1 are answered by the workbench's api-service and the rest
 * are unbuilt; tomorrow either could be a local pure function. Nothing outside
 * `validate.service.ts` should care which — that is the whole reason
 * `ValidationLayer` is a flat enum and `ValidationCheck` (see the service) is an
 * interface.
 *
 * **Adding a layer is: one value here, one `ValidationCheck` registered in the
 * service.** Every consumer — the tool, the outbound gate, the receiver, the
 * report — reads `findings[].layer` and needs no change.
 */

/**
 * Which layer of the stack a finding came from.
 *
 * | Layer     | What it decides                                    | Who runs it today |
 * | --------- | -------------------------------------------------- | ----------------- |
 * | `L0`      | JSON Schema: structure and types                   | api-service       |
 * | `L1`      | contextual rules from the spec's `x-validations`   | api-service       |
 * | `context` | ids match the session, timestamp window, TTL       | *not built*       |
 * | `L2`      | business / semantic judgement                       | *not built* (the model) |
 *
 * `context` and `L2` are declared before they exist on purpose: the shapes that
 * carry findings are the hardest thing to change later, and leaving them out
 * would mean every consumer needed a second pass when they land.
 */
export const ValidationLayer = z.enum(["L0", "L1", "context", "L2"]);
export type ValidationLayer = z.infer<typeof ValidationLayer>;

/**
 * The stable code for a schema failure.
 *
 * Upstream gives L0 failures no code at all — only prose — and L1 codes are real
 * rule identifiers from the spec (`VEHICLE_CATEGORY_REQUIRED`). Rather than
 * invent a per-shape taxonomy that would *look* like a protocol code without
 * being one, every L0 finding carries this and puts the detail in `message`.
 */
export const L0_CODE = "L0_SCHEMA";

/** The code for a failure whose text we could not parse. */
export const UNPARSED_CODE = "VALIDATION_UNPARSED";

export const ValidationFinding = z.object({
  layer: ValidationLayer.describe("Which layer rejected the payload."),
  code: z
    .string()
    .describe(
      "Machine-readable identifier. An L1 rule name, or L0_SCHEMA for a " +
        "schema failure, which upstream does not code.",
    ),
  json_path: z
    .string()
    .describe(
      "Where in the payload, e.g. $.message.intent.fulfillment.vehicle.category. " +
        "`$` when the failure is not attributable to one location.",
    ),
  message: z.string().describe("What is wrong, in the validator's own words."),
  skip_if: z
    .string()
    .optional()
    .describe(
      "The condition under which this rule would not have applied. Present " +
        "only for conditional L1 rules, and often the fastest route to the fix.",
    ),
});
export type ValidationFinding = z.infer<typeof ValidationFinding>;

/**
 * The three answers, and why there are three.
 *
 * `unavailable` is **not** a synonym for `valid`. It means no verdict was
 * reached — the oracle timed out, the build is not served, the payload was
 * missing something we need before we could even ask. Collapsing it into
 * "passed" is how our own outage becomes a clean bill of health in somebody
 * else's compliance report, which is the same reasoning that makes
 * `RedisCacheStore` throw rather than answer `undefined`.
 */
export const ValidationStatus = z.enum(["valid", "invalid", "unavailable"]);
export type ValidationStatus = z.infer<typeof ValidationStatus>;

/** A layer that did not produce a verdict, and why. */
export const UncheckedLayer = z.object({
  layer: ValidationLayer,
  reason: z
    .string()
    .describe("Why this layer did not run — an outage, a guard, or a knob."),
});
export type UncheckedLayer = z.infer<typeof UncheckedLayer>;

export const ValidationVerdict = z.object({
  status: ValidationStatus,
  findings: z
    .array(ValidationFinding)
    .describe("Every failure found, across every layer that ran."),
  checked: z
    .array(ValidationLayer)
    .describe("Layers that actually produced a verdict."),
  unchecked: z
    .array(UncheckedLayer)
    .describe(
      "Layers that did not. A `valid` status only covers what is in `checked`.",
    ),
  docs_url: z
    .string()
    .optional()
    .describe("The published rule list for this build, when upstream named one."),
});
export type ValidationVerdict = z.infer<typeof ValidationVerdict>;

/* -------------------------------------------------------------------------- */
/* What the oracle answers                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The api-service's response envelope — the ONDC ACK/NACK shape.
 *
 * `error.code` is deliberately *not* trusted as a code: upstream sets it to the
 * literal string `"Bad Request"` on every rejection regardless of layer, so it
 * distinguishes nothing. Everything meaningful is inside `error.message`, which
 * is what `validate.parse.ts` exists for.
 *
 * Loose, because this is somebody else's payload and a field we did not expect
 * is not a reason to refuse an otherwise readable verdict.
 */
export const UpstreamValidationResponse = z.looseObject({
  message: z
    .looseObject({
      ack: z.looseObject({ status: z.string() }).optional(),
    })
    .optional(),
  error: z
    .looseObject({
      code: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
});
export type UpstreamValidationResponse = z.infer<
  typeof UpstreamValidationResponse
>;

/* -------------------------------------------------------------------------- */
/* Tool IO                                                                     */
/* -------------------------------------------------------------------------- */

export const ValidatePayloadInput = z.object({
  session_id: z
    .string()
    .min(1)
    .describe("Session whose build (domain + version) the payload is judged against."),
  payload: z
    .looseObject({})
    .describe("The full protocol payload, exactly as it would go on the wire."),
  action: z
    .string()
    .optional()
    .describe(
      "Action to validate as. Defaults to the payload's own context.action, " +
        "which is almost always what you want.",
    ),
});
export type ValidatePayloadInput = z.infer<typeof ValidatePayloadInput>;

export const ValidatePayloadOutput = ValidationVerdict.extend({
  action: z.string().describe("The action the payload was judged as."),
  ...EventsField,
});
export type ValidatePayloadOutput = z.infer<typeof ValidatePayloadOutput>;

/* -------------------------------------------------------------------------- */
/* Reading a verdict                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The code to put on a NACK.
 *
 * The first finding, ordered by layer, because L0 failures explain L1 ones: a
 * field that is the wrong type will also fail every rule that reads it, and
 * leading with the rule sends the reader to the wrong place.
 */
export function primaryCode(findings: readonly ValidationFinding[]): string {
  return orderedFindings(findings)[0]?.code ?? "VALIDATION_ERROR";
}

/** Findings ordered the way a human should read them. */
export function orderedFindings(
  findings: readonly ValidationFinding[],
): ValidationFinding[] {
  const rank: Record<ValidationLayer, number> = {
    L0: 0,
    L1: 1,
    context: 2,
    L2: 3,
  };
  return [...findings].sort((a, b) => rank[a.layer] - rank[b.layer]);
}

/**
 * A one-line-per-failure summary, for a NACK body or a journal line.
 *
 * Capped, because this string reaches a counterparty's error log and our own
 * session journal, and a payload that fails forty rules should not produce a
 * forty-line NACK. The count of what was dropped is kept — a truncated list that
 * does not say it is truncated reads as a complete one.
 */
export function summariseFindings(
  findings: readonly ValidationFinding[],
  limit = 5,
): string {
  if (findings.length === 0) return "Validation failed.";

  const ordered = orderedFindings(findings);
  const shown = ordered
    .slice(0, limit)
    .map((finding) => `${finding.code} at ${finding.json_path}: ${finding.message}`);
  const hidden = ordered.length - shown.length;

  return [
    ...shown,
    ...(hidden > 0 ? [`(and ${String(hidden)} more)`] : []),
  ].join("; ");
}
