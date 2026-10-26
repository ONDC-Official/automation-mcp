import { defineTool, type Registerable } from "@/lib/define-tool.js";
import type { FlowSummary } from "@/modules/catalog/catalog.schema.js";
import {
  CreateSessionInput,
  CreateSessionOutput,
  GetSessionInput,
  GetSessionOutput,
  settingsOf,
  UpdateSessionSettingsInput,
  UpdateSessionSettingsOutput,
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
    `  inputs:     ${session.interaction_mode === "manual" ? "manual — ask the human" : "llm_auto — you supply them"}`,
    `  advance:    ${session.auto_advance ? "auto" : "step by step"}`,
    `  signatures: ${settingsOf(session).header_validation ? "checked" : "not checked"} (header_validation)`,
    `  expires:    ${session.expires_at}`,
    /*
     * The viewer link is a directive, not a field.
     *
     * It used to sit inside the block above, between `callback:` and
     * `inputs:` — aligned, two-space indented, indistinguishable from
     * `expires:`. A model composing its reply summarised the block and the URL
     * went with the rest of the plumbing, so in practice the human only ever
     * got the link by asking for it. Outside the block, with the deadline
     * stated, it reads as something owed rather than something known.
     *
     * The wording has to hold at both call sites, because `session_get` shares
     * this function: "before your next tool call" is true mid-run, where
     * "before you start a flow" would already be stale. "First line of your
     * reply" was tried and failed in auto mode: the model chains straight into
     * flow_start, so its reply came many calls later, if the link survived at
     * all. Restating it on
     * `session_get` is deliberate — that is the tool called when the link was
     * lost. "Plain text" because a markdown link hides the URL a human wants to
     * copy.
     */
    ...(viewerUrl !== undefined
      ? [
          "",
          "→ HAND THIS TO THE PERSON YOU ARE TESTING FOR — write it to them now,",
          "  before your next tool call, as plain text on its own line so they can",
          "  copy it. This holds in auto mode too, and for every new session: each",
          "  has its own link. It is the only view of the run they have that is not",
          "  you describing it; read-only, so you keep driving.",
          `  ${viewerUrl}`,
        ]
      : []),
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
        "flow available for its build. Before calling, ask the person you are " +
        "testing for whether they want manual or auto mode, and pass it as " +
        "interaction_mode. Supply the participant's subscriber URL " +
        "and whether it is a BAP (buyer app) or BPP (seller app); this server " +
        "automatically takes the opposite role and answers as that counterparty. " +
        "Domain, version and use-case must be a published combination — call " +
        "catalog_list_builds first if unsure, because an unknown use-case is " +
        "rejected rather than silently returning no flows. " +
        "The returned callback_url is what the participant must send its " +
        "callbacks to; give it to them before starting a flow. " +
        "The returned viewer_url is a live read-only page of this session's " +
        "flows, payloads and events: right after this call, before your next " +
        "tool call, write it to the person you are testing for as a plain URL " +
        "on its own line — in auto mode too, and for every new session, since " +
        "each has its own link. A human who never receives it has no view of " +
        "the run except your description of it. Then list the flows and ask " +
        "whether to run one or explain one first.",
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
          "",
          "→ List these flows to the person, each with its description, and ask",
          "  whether to run one or explain one first.",
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
        "Also restates the viewer_url, which is how the human gets the link " +
        "back if it was lost. Returns an error result if the session is " +
        "unknown or has expired.",
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

    defineTool({
      name: "session_update_settings",
      title: "Update session settings",
      description:
        "Change a session's settings without starting a new one. Pass only " +
        "the settings to change. header_validation: when true (the default), " +
        "every call the participant sends must carry a valid ONDC " +
        "Authorization header or it is refused with 401; set it false when " +
        "the person asks to switch signature checks off. A change applies " +
        "from the participant's next call.",
      inputSchema: UpdateSessionSettingsInput,
      outputSchema: UpdateSessionSettingsOutput,
      annotations: {
        // Setting the same value twice leaves the session as it was.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      render: ({ session_id, settings, events }) =>
        [
          `session ${session_id} settings`,
          `  header_validation: ${String(settings.header_validation)}`,
          "  applies from the participant's next call",
          ...renderEvents(events),
        ].join("\n"),
      handler: async ({ session_id, settings }) => ({
        session_id,
        settings: await service.updateSettings(session_id, settings),
        ...(await eventsFor(records, session_id)),
      }),
    }),
  ];
}
