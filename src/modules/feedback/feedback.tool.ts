import { NotFoundError, ValidationError } from "@/lib/errors.js";
import { defineTool, type Registerable } from "@/lib/define-tool.js";
import {
  claimMatches,
  isTerminal,
  ListReportsInput,
  ListReportsOutput,
  ReportedProblem,
  SubmitReportInput,
  SubmitReportOutput,
  UNSCOPED_SESSION,
  type Narration,
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

/**
 * One sentence, repeated wherever a user might reasonably ask.
 *
 * The clause on the end is not decoration. Without it the notice says
 * "identifiers are pseudonymised", which under `TELEMETRY_CORRELATION` is no
 * longer the whole truth — the report also carries this session's and this
 * transaction's ids in the clear. `feedback_list_reports` is documented as the
 * honest answer to "what are you sending about me?", so the notice it returns
 * has to change when the answer does.
 */
function sharingNotice(correlates: boolean): string {
  return (
    "Issue reports describe what failed, never what was in the payload: every " +
    "value is replaced by a type token and identifiers are pseudonymised " +
    "before anything is written. They are stored locally and, when this server " +
    "is configured with an ingest URL, uploaded there to improve the tooling." +
    (correlates
      ? " This server also has TELEMETRY_CORRELATION on, so each report " +
        "additionally carries this session's id and this run's transaction id " +
        "in the clear, under `correlation`, so a report can be linked back to " +
        "the run that produced it. Nothing else is affected — the payload and " +
        "the participant are redacted exactly as above."
      : "")
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

/**
 * The fields that belong to a report the model opens, refused beside an
 * incident id.
 *
 * Half-mixing the two shapes is the failure worth preventing: `problem` and
 * `tool` describe what the report is *about*, and an incident already knows
 * that from the evidence that was captured when it opened. Silently ignoring
 * them would leave the model believing it had said something it had not.
 */
function refuseReportFields(input: SubmitReportInput): void {
  const named = (["problem", "tool", "observed"] as const).filter(
    (key) => input[key] !== undefined,
  );
  if (named.length === 0) return;
  throw new ValidationError(
    `${named.join(", ")} cannot be given alongside an incident_id`,
    {
      hint:
        "An incident already carries what it is about. Use these fields only " +
        "when opening a report of your own, with no incident_id.",
    },
  );
}

/** The model opening its own incident: the branch with no id to answer. */
async function openReport(
  feedback: FeedbackService,
  input: SubmitReportInput,
  narration: Narration,
): Promise<
  Pick<SubmitReportOutput, "incident_id" | "state" | "accepted" | "message">
> {
  if (input.problem === undefined) {
    throw new ValidationError(
      "problem is required when there is no incident_id",
      {
        hint: `One of: ${ReportedProblem.options.join(", ")}.`,
      },
    );
  }

  const incident = await feedback.report({
    ...(input.session_id !== undefined ? { sessionId: input.session_id } : {}),
    ...(input.tool !== undefined ? { tool: input.tool } : {}),
    problem: input.problem,
    ...(input.observed !== undefined ? { observed: input.observed } : {}),
    narration,
  });

  if (incident === undefined) {
    // `accepted: false` finally means something. Capture swallows its own
    // store failures — a telemetry outage must not become a protocol one — so
    // the only honest answer is that nothing was recorded.
    return {
      incident_id: "",
      state: "REPORTED",
      accepted: false,
      message:
        "Nothing was recorded: issue reporting is switched off on this " +
        "server, or its store refused the write. Your run is unaffected.",
    };
  }

  return {
    incident_id: incident.id,
    state: incident.state,
    accepted: true,
    message: `Recorded. ${sharingNotice(feedback.correlates)}`,
  };
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
        "Report what went wrong, in either of two ways. **Answering an " +
        "incident**: pass the `incident_id` from an ISSUE_OPEN event, with " +
        "its `session_id`, AFTER you have tried to resolve the problem, so " +
        "you can say how it turned out — report it whether or not you " +
        "succeeded, because a failure you could not rescue is the more useful " +
        "of the two. **Opening your own**: pass no `incident_id` and no " +
        "`session_id`, plus `problem`, for anything this server could not see " +
        "itself — a result your client refused, a tool description that " +
        "misled you, an answer that was wrong, something you needed that does " +
        "not exist. Nothing detects those, so if you do not say it, nobody " +
        "learns it. `tooling_gap` is the most valuable field: it is what " +
        "changes the tools you are given next time. Do not paste payload " +
        "values into any field — name the JSONPath instead; values are " +
        "stripped either way.",
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
        const narration = {
          diagnosis: input.diagnosis,
          attempted: input.attempted,
          outcome: input.outcome,
          suspected_cause: input.suspected_cause,
          ...(input.tooling_gap !== undefined
            ? { tooling_gap: input.tooling_gap }
            : {}),
          at: new Date().toISOString(),
        };

        if (input.incident_id === undefined) {
          const opened = await openReport(feedback, input, narration);
          return {
            ...opened,
            // Absent with no session, because there is no journal to drain.
            // `events` is optional for exactly this reason.
            ...(input.session_id !== undefined
              ? await eventsFor(records, input.session_id)
              : {}),
          };
        }

        // The session is the authorisation check, exactly as `record_get_payload`
        // treats it: an incident id is a bare uuid and names no owner. Which is
        // also why one cannot be answered without a session: there would be
        // nothing to check it against.
        if (input.session_id === undefined) {
          throw new ValidationError(
            "incident_id needs the session_id that owns it",
            {
              hint:
                "Pass session_id with incident_id. To report something that " +
                "happened outside a session, pass neither, plus `problem`.",
            },
          );
        }
        refuseReportFields(input);
        await sessions.requireSession(input.session_id);

        const updated = await feedback.narrate(
          input.session_id,
          input.incident_id,
          narration,
        );

        if (updated === undefined) {
          // The tool channel, not a throw: the model can fix this by reading
          // `feedback_list_reports` and trying a different id. Never opened as
          // a new incident either — a mistyped id would become a row with no
          // evidence in it, which is worse than the error.
          throw new NotFoundError("incident", input.incident_id, {
            hint: "Call feedback_list_reports to see this session's incidents.",
          });
        }

        // Only worth saying once the run has reached a verdict of its own.
        // Narration almost always arrives while the incident is still `OPEN` —
        // the model explains itself and moves on — and there is nothing to
        // disagree with yet. This used to compare `gave_up` against
        // `ABANDONED`, which nothing produces any more, so every `gave_up`
        // would now be reported as a mismatch.
        const disagrees =
          isTerminal(updated.state) &&
          !claimMatches(input.outcome, updated.state);

        return {
          incident_id: updated.id,
          state: updated.state,
          accepted: true,
          message:
            `Recorded. ${sharingNotice(feedback.correlates)}` +
            (disagrees
              ? ` Note that the run itself ended ${updated.state}, which does ` +
                `not match your "${input.outcome}" — both are kept.`
              : ""),
          ...(await eventsFor(records, input.session_id)),
        };
      },
    }),

    defineTool({
      name: "feedback_list_reports",
      title: "List issue reports for this session",
      description:
        "Every incident this session has opened, with its derived state and " +
        "whether it still needs your account. Omit `session_id` to list the " +
        "reports you opened yourself with no session behind them. Pass " +
        "`include_body: true` to see " +
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
            ? "No issues recorded."
            : `${String(output.incidents.length)} issue(s):`,
          ...output.incidents.map(summarise),
          `  ${output.sharing}`,
          ...renderEvents(output.events),
        ].join("\n"),
      handler: async (input) => {
        // No session named means the reports that have none — the ones filed
        // about the session-less half of this server. Nothing to authorise
        // against, and nothing session-specific in them to protect.
        const partition = input.session_id ?? UNSCOPED_SESSION;
        if (input.session_id !== undefined) {
          await sessions.requireSession(input.session_id);
        }

        const incidents = (await feedback.list(partition)).slice(-input.limit);

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
          sharing: sharingNotice(feedback.correlates),
          ...(input.session_id !== undefined
            ? await eventsFor(records, input.session_id)
            : {}),
        };
      },
    }),
  ];
}
