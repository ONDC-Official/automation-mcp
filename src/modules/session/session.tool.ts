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

/**
 * The protocol edge for sessions — no data access, no business rules.
 *
 * `render` matters more here than in most modules: the text block is what the
 * model actually reads, and a session is only useful if the role inversion and
 * the available flows are legible at a glance.
 */

export function renderSession(session: Session): string {
  return [
    `session ${session.session_id}`,
    `  under test: ${session.np.type} at ${session.np.subscriber_url}`,
    `  mock plays: ${session.mock_role}`,
    `  build:      ${session.build.domain} ${session.build.version} / ${session.build.usecase}`,
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

export function createSessionTools(service: SessionService): Registerable[] {
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
        "rejected rather than silently returning no flows.",
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
      render: ({ session, flows, total }) => {
        const header = renderSession(session);
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
      render: ({ session }) => renderSession(session),
      handler: async ({ session_id }) => ({
        session: await service.requireSession(session_id),
      }),
    }),
  ];
}
