import { z } from "zod";
import { StepOutcome } from "@/modules/flow/flow.schema.js";

/**
 * Forms, which cut both ways.
 *
 * A flow's form step belongs to one side or the other, and which side decides
 * everything:
 *
 * - **The participant hosts it.** Its `on_search` (or similar) carried a URL;
 *   this mock has to fetch that page, fill it, and POST it back. `form_fetch`
 *   then `form_submit`.
 * - **This mock hosts it.** The payload we sent carried *our* URL, built by the
 *   config's own `createFormURL` helper, and the participant has to open and
 *   submit it. Nothing for the caller to do but wait — `flow_await` reports the
 *   submission when it lands.
 *
 * Interaction mode cuts across that. In `llm_auto` the caller fills the fields
 * itself; in `manual` it gets a link to hand to a human, and later reports back
 * the submission id the human was given.
 */

/** One input parsed out of a counterparty's form. */
export const FormField = z.object({
  name: z.string().describe("Field name to submit the value under."),
  type: z
    .string()
    .describe("HTML input type — text, email, select, textarea, hidden…"),
  label: z
    .string()
    .optional()
    .describe("Nearby label text, when there was one."),
  required: z.boolean(),
  value: z
    .string()
    .optional()
    .describe("Pre-filled value, if the form had one."),
  options: z
    .array(z.string())
    .optional()
    .describe("Allowed values, for a select. Submit one of these exactly."),
});
export type FormField = z.infer<typeof FormField>;

export const FetchFormInput = z.object({
  session_id: z.string().min(1).describe("Session returned by session_create."),
  transaction_id: z
    .string()
    .min(1)
    .describe("Transaction the form belongs to."),
  step_key: z
    .string()
    .optional()
    .describe(
      "Which form step. Omit to use whichever form the flow is waiting on.",
    ),
});
export type FetchFormInput = z.infer<typeof FetchFormInput>;

export const FetchFormOutput = z.object({
  step_key: z.string(),
  mode: z
    .enum(["llm_auto", "manual"])
    .describe(
      "'llm_auto' — fill `fields` and call form_submit. " +
        "'manual' — give form_url to the human, then call form_submit with the " +
        "submission_id they receive.",
    ),
  role: z
    .enum(["fill", "host"])
    .describe(
      "'fill' — the participant hosts this form and this mock must submit it. " +
        "'host' — this mock serves it and the participant must submit it.",
    ),
  form_url: z.string().optional().describe("Where the form lives."),
  action_url: z
    .string()
    .optional()
    .describe("Where a submission is POSTed. Resolved against the form's URL."),
  method: z.string().optional().describe("GET or POST, as the form declares."),
  fields: z
    .array(FormField)
    .describe("Inputs parsed out of the form. Empty in manual mode."),
  warnings: z
    .array(z.string())
    .describe(
      "Anything suspicious in the page — read these before filling it.",
    ),
  instructions: z
    .string()
    .describe("What to do next, given the mode and the role."),
});
export type FetchFormOutput = z.infer<typeof FetchFormOutput>;

export const SubmitFormInput = z.object({
  session_id: z.string().min(1).describe("Session returned by session_create."),
  transaction_id: z
    .string()
    .min(1)
    .describe("Transaction the form belongs to."),
  step_key: z
    .string()
    .optional()
    .describe("Which form step. Omit to use the one the flow is waiting on."),
  fields: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Field name → value, for llm_auto. Use the names from form_fetch.",
    ),
  submission_id: z
    .string()
    .optional()
    .describe(
      "The id the counterparty issued. Supply this in manual mode, after a " +
        "human has submitted the form.",
    ),
});
export type SubmitFormInput = z.infer<typeof SubmitFormInput>;

export const SubmitFormOutput = z.object({
  step_key: z.string(),
  submission_id: z
    .string()
    .describe("What the counterparty issued for this submission."),
  raw_response: z
    .unknown()
    .optional()
    .describe(
      "The counterparty's answer, when it was not in the expected " +
        "{success, submission_id} shape. Read it if the id looks wrong.",
    ),
  outcome: StepOutcome.describe("Where the flow stands now the form is done."),
});
export type SubmitFormOutput = z.infer<typeof SubmitFormOutput>;
