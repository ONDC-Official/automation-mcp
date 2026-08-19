import { defineTool, type Registerable } from "@/lib/define-tool.js";
import type { FlowSummary } from "@/modules/catalog/catalog.schema.js";
import {
  CreateSessionInput,
  CreateSessionOutput,
  GetSessionInput,
  GetSessionOutput,
  type Session,
} from "@/modules/session/session.schema.js";
import type { SessionService } from "@/modules/session/session.service.js";
import { eventsFor, renderEvents } from "@/modules/record/record.tool.js";
import type { RecordService } from "@/modules/record/record.service.js";

/**
 * The protocol edge for sessions — no data access, no business rules.
 *
 * `render` matters more here than in most modules: the text block is what the
 * model actually reads, and a session is only useful if the role inversion and
 * the available flows are legible at a glance.
 */

export function renderSession(session: Session, viewerUrl?: string): string {
  return [
    `session ${session.session_id}`,
    `  under test: ${session.np.type} at ${session.np.subscriber_url}`,
    `  mock plays: ${session.mock_role}`,
    `  build:      ${session.build.domain} ${session.build.version} / ${session.build.usecase}`,
    // Stated on every session read, because a callback URL the participant
    // cannot reach is the single most common way a run silently goes nowhere.
    `  callback:   ${session.callback_url}`,
    // Beside the callback URL because both are things to hand somebody, and
    // this one is the only view of the run the human has that is not this
    // model's narration of it.
    ...(viewerUrl !== undefined
      ? [
          `  viewer:     ${viewerUrl}  ← give this to the person you are testing for`,
        ]
      : []),
    `  inputs:     ${session.interaction_mode === "manual" ? "manual — ask the human" : "llm_auto — you supply them"}`,
    `  advance:    ${session.auto_advance ? "auto" : "step by step"}`,
    `  expires:    ${session.expires_at}`,
  ].join("\n");
}

/** Compact one-line shape of a sequence: the first few actions, then a count. */
function renderActions(actions: string[], shown = 6): string {
  if (actions.length === 0) return "(no steps)";
  const head = actions.slice(0, shown).join(" → ");
  const rest = actions.length - shown;
  return rest > 0 ? `${head} → …(+${String(rest)})` : head;
}

export function renderFlowSummary(flow: FlowSummary): string {
  const counts = `${String(flow.step_count)} steps · ${String(flow.mock_steps)} mock / ${String(flow.np_steps)} np${flow.form_steps > 0 ? ` · ${String(flow.form_steps)} form` : ""}`;
  return [
    `  ${flow.flow_id} — ${counts}`,
    `    ${renderActions(flow.actions)}`,
  ].join("\n");
}

export function createSessionTools(
  service: SessionService,
  records: RecordService,
): Registerable[] {
  return [
    defineTool({
      name: "session_create",
      title: "Create mock session",
      description:
        "Open a session against a network participant under test and list every " +
        "flow available for its build. Supply the participant's subscriber URL " +
        "and whether it is a BAP (buyer app) or BPP (seller app); this server " +
        "automatically takes the opposite role and answers as that counterparty. " +
        "Domain, version and use-case must be a published combination — call " +
        "catalog_list_builds first if unsure, because an unknown use-case is " +
        "rejected rather than silently returning no flows. " +
        "The returned callback_url is what the participant must send its " +
        "callbacks to; give it to them before starting a flow. " +
        "The returned viewer_url is a live read-only page showing this " +
        "session's flows, payloads and events — pass it on to the human you " +
        "are testing for.",
      inputSchema: CreateSessionInput,
      outputSchema: CreateSessionOutput,
      annotations: {
        // Creates server-side state, but nothing is destroyed and re-running it
        // yields an independent session rather than corrupting an existing one.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      render: ({ session, viewer_url, flows, total }) => {
        const header = renderSession(session, viewer_url);
        if (total === 0) {
          return `${header}\n\nNo flows are published for this build.`;
        }
        return [
          header,
          "",
          `${String(total)} flow(s) available:`,
          ...flows.map(renderFlowSummary),
        ].join("\n");
      },
      handler: (input) => service.createSession(input),
    }),

    defineTool({
      name: "session_get",
      title: "Get session",
      description:
        "Fetch a session by id: the participant under test, the role this " +
        "server plays against it, the build, and when the session expires. " +
        "Returns an error result if the session is unknown or has expired.",
      inputSchema: GetSessionInput,
      outputSchema: GetSessionOutput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      render: ({ session, viewer_url, events }) =>
        [renderSession(session, viewer_url), ...renderEvents(events)].join(
          "\n",
        ),
      handler: async ({ session_id }) => {
        const session = await service.requireSession(session_id);
        const viewerUrl = service.viewerUrl(session_id);
        return {
          session,
          ...(viewerUrl !== undefined ? { viewer_url: viewerUrl } : {}),
          ...(await eventsFor(records, session_id)),
        };
      },
    }),
  ];
}
