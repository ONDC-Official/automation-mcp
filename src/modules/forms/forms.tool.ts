import { defineTool, type Registerable } from "@/lib/define-tool.js";
import { renderOutcome } from "@/modules/flow/flow.tool.js";
import {
  FetchFormInput,
  FetchFormOutput,
  SubmitFormInput,
  SubmitFormOutput,
} from "@/modules/forms/forms.schema.js";
import type { FormsService } from "@/modules/forms/forms.service.js";

/**
 * The two tools a form step needs — and only when the participant hosts it.
 *
 * A form this mock serves needs no tool at all: the participant opens the URL
 * we already sent, submits it, and the flow advances from the route. The caller
 * only has to wait.
 */

export function renderForm(output: FetchFormOutput): string {
  const lines = [
    `form ${output.step_key} — ${output.role === "host" ? "served by this mock" : "hosted by the participant"} (${output.mode})`,
  ];

  if (output.form_url !== undefined) lines.push(`  url:    ${output.form_url}`);
  if (output.action_url !== undefined) {
    lines.push(`  submit: ${output.method ?? "POST"} ${output.action_url}`);
  }

  for (const field of output.fields) {
    const marks = [
      field.required ? "required" : "optional",
      ...(field.options ? [`one of: ${field.options.join(", ")}`] : []),
      ...(field.value !== undefined ? [`prefilled "${field.value}"`] : []),
    ].join(" · ");
    lines.push(
      `  ${field.name} (${field.type}) — ${field.label ?? "no label"} [${marks}]`,
    );
  }

  for (const warning of output.warnings) lines.push(`  ! ${warning}`);
  lines.push("", output.instructions);
  return lines.join("\n");
}

export function createFormsTools(service: FormsService): Registerable[] {
  return [
    defineTool({
      name: "form_fetch",
      title: "Read a pending form",
      description:
        "Read the form a flow is waiting on. When the participant hosts it, " +
        "this fetches the page, screens it for active content, and returns its " +
        "fields ready to fill — then call form_submit. When this mock hosts it, " +
        "there is nothing to do but wait for the participant, and the answer " +
        "says so. In a manual-mode session it returns the link to hand to a " +
        "person instead of the fields. Omit step_key to use whichever form the " +
        "flow is currently waiting on.",
      inputSchema: FetchFormInput,
      outputSchema: FetchFormOutput,
      annotations: {
        // Fetches a third-party page, so not read-only in the world sense.
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      render: renderForm,
      handler: (input) =>
        service.fetchForm(
          input.session_id,
          input.transaction_id,
          input.step_key,
        ),
    }),

    defineTool({
      name: "form_submit",
      title: "Submit a pending form",
      description:
        "Complete the form step and advance the flow. In llm_auto sessions " +
        "pass `fields` (the names come from form_fetch) and this posts them to " +
        "the participant and reads back the submission id it issues. In manual " +
        "sessions pass the `submission_id` the person was given instead. " +
        "Either way the id is saved where the next step's payload expects it.",
      inputSchema: SubmitFormInput,
      outputSchema: SubmitFormOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // Submitting twice creates a second submission at the participant.
        idempotentHint: false,
        openWorldHint: true,
      },
      render: (output) =>
        [
          `form ${output.step_key} submitted — submission_id ${output.submission_id}`,
          "",
          renderOutcome(output.outcome),
        ].join("\n"),
      handler: (input) =>
        service.submitForm({
          sessionId: input.session_id,
          transactionId: input.transaction_id,
          stepKey: input.step_key,
          fields: input.fields,
          submissionId: input.submission_id,
        }),
    }),
  ];
}
