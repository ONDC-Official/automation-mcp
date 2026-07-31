import { NotFoundError } from "@/lib/errors.js";
import { defineTool, type Registerable } from "@/lib/define-tool.js";
import {
  ListReportsInput,
  ListReportsOutput,
  SubmitReportInput,
  SubmitReportOutput,
} from "@/modules/feedback/feedback.schema.js";
import type { FeedbackService } from "@/modules/feedback/feedback.service.js";
import { eventsFor, renderEvents } from "@/modules/record/record.tool.js";
import type { RecordService } from "@/modules/record/record.service.js";
import type { SessionService } from "@/modules/session/session.service.js";

/**
 * The model's half of the corpus.
 *
 * Everything factual about a failure is captured without these tools — that is
 * the point of the two taps, and a report ships whether or not either of these
 * is ever called. What the model adds is the part only it has: what it thought
 * was wrong, what it tried, and whether any of it worked.
 *
 * Two tools, not five. The surface is already nineteen tools wide, and a
 * reporting feature that costs the model a decision on every turn would be paid
 * for out of the attention the actual transaction needs.
 */

/** One sentence, repeated wherever a user might reasonably ask. */
function sharingNotice(): string {
  return (
    "Issue reports describe what failed, never what was in the payload: every " +
    "value is replaced by a type token and identifiers are pseudonymised " +
    "before anything is written. They are stored locally and, when this server " +
    "is configured with an ingest URL, uploaded there to improve the tooling."
  );
}

/** One line per incident, in the shape the tool actually answers with. */
function summarise(entry: ListReportsOutput["incidents"][number]): string {
  const step = entry.step_key ?? "—";
  const repeats = entry.occurrences > 1 ? ` ×${String(entry.occurrences)}` : "";
  const pending = entry.narrated ? "" : " · awaiting your report";
  return (
    `  • ${entry.incident_id} [${entry.state}] ${entry.trigger}` +
    `(${entry.code}) at ${step}${repeats}${pending}`
  );
}

export function createFeedbackTools(
  feedback: FeedbackService,
  sessions: SessionService,
  records: RecordService,
): Registerable[] {
  return [
    defineTool({
      name: "feedback_submit_report",
      title: "Report what went wrong",
      description:
        "Record your account of an incident this session opened — you will " +
        "see one as an ISSUE_OPEN event on a tool result. Call it AFTER you " +
        "have tried to resolve the problem, so you can say how it turned out; " +
        "report it whether or not you succeeded, because a failure you could " +
        "not rescue is the more useful of the two. `tooling_gap` is the most " +
        "valuable field: it is what changes the tools you are given next time. " +
        "Do not paste payload values into any field — name the JSONPath " +
        "instead; values are stripped either way.",
      inputSchema: SubmitReportInput,
      outputSchema: SubmitReportOutput,
      annotations: {
        // Not read-only and not idempotent: it finalises a report and hands it
        // to the sink, which for a configured install means an upload.
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      render: (output) =>
        [
          `[${output.accepted ? "RECORDED" : "REJECTED"}] ${output.message}`,
          `  derived state: ${output.state}`,
          ...renderEvents(output.events),
        ].join("\n"),
      handler: async (input) => {
        // The session is the authorisation check, exactly as `record_get_payload`
        // treats it: an incident id is a bare uuid and names no owner.
        await sessions.requireSession(input.session_id);

        const updated = await feedback.narrate(
          input.session_id,
          input.incident_id,
          {
            diagnosis: input.diagnosis,
            attempted: input.attempted,
            outcome: input.outcome,
            suspected_cause: input.suspected_cause,
            ...(input.tooling_gap !== undefined
              ? { tooling_gap: input.tooling_gap }
              : {}),
            at: new Date().toISOString(),
          },
        );

        if (updated === undefined) {
          // The tool channel, not a throw: the model can fix this by reading
          // `feedback_list_reports` and trying a different id.
          throw new NotFoundError("incident", input.incident_id, {
            hint: "Call feedback_list_reports to see this session's incidents.",
          });
        }

        const agrees =
          (input.outcome === "gave_up") === (updated.state === "ABANDONED");

        return {
          incident_id: updated.id,
          state: updated.state,
          accepted: true,
          message:
            `Recorded. ${sharingNotice()}` +
            (agrees
              ? ""
              : ` Note that the run itself ended ${updated.state}, which does ` +
                `not match your "${input.outcome}" — both are kept.`),
          ...(await eventsFor(records, input.session_id)),
        };
      },
    }),

    defineTool({
      name: "feedback_list_reports",
      title: "List issue reports for this session",
      description:
        "Every incident this session has opened, with its derived state and " +
        "whether it still needs your account. Pass `include_body: true` to see " +
        "the fully-redacted report exactly as it would be uploaded — that is " +
        "the honest answer to a user asking what is being sent about them.",
      inputSchema: ListReportsInput,
      outputSchema: ListReportsOutput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      render: (output) =>
        [
          output.incidents.length === 0
            ? "No issues recorded for this session."
            : `${String(output.incidents.length)} issue(s):`,
          ...output.incidents.map(summarise),
          `  ${output.sharing}`,
          ...renderEvents(output.events),
        ].join("\n"),
      handler: async (input) => {
        await sessions.requireSession(input.session_id);

        const incidents = (await feedback.list(input.session_id)).slice(
          -input.limit,
        );

        return {
          incidents: await Promise.all(
            incidents.map(async (incident) => ({
              incident_id: incident.id,
              trigger: incident.trigger,
              code: incident.code,
              ...(incident.step_key !== undefined
                ? { step_key: incident.step_key }
                : {}),
              flow_id: incident.flow_id,
              state: incident.state,
              occurrences: incident.occurrences,
              narrated: incident.narration !== undefined,
              first_seen_at: incident.first_seen_at,
              ...(input.include_body
                ? { report: await feedback.buildReport(incident) }
                : {}),
            })),
          ),
          sharing: sharingNotice(),
          ...(await eventsFor(records, input.session_id)),
        };
      },
    }),
  ];
}
