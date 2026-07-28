import { defineTool, type Registerable } from "@/lib/define-tool.js";
import {
  DescribeFlowInput,
  DescribeFlowOutput,
  ListBuildsInput,
  ListBuildsOutput,
  ListFlowsInput,
  ListFlowsOutput,
  LoadFlowConfigInput,
  LoadFlowConfigOutput,
  type FlowStep,
} from "@/modules/catalog/catalog.schema.js";
import type { CatalogService } from "@/modules/catalog/catalog.service.js";
import { renderFlowSummary } from "@/modules/session/session.tool.js";
import type { SessionService } from "@/modules/session/session.service.js";

/**
 * The protocol edge for the flow catalog.
 *
 * Every flow tool takes a `session_id` rather than a build triple: the session
 * already pins the domain, version and use-case, and — more importantly — it
 * carries the mock's role, which is what lets each step be labelled as ours to
 * send or theirs to await. Asking the model to restate the build on every call
 * would invite drift between the session and the flow it is reading.
 */

function renderStep(step: FlowStep, index: number): string {
  const marker = step.actor === "mock" ? "»" : step.actor === "np" ? "«" : "?";
  const inputs =
    step.inputs.length > 0
      ? ` [inputs: ${step.inputs.map((input) => input.name).join(", ")}]`
      : "";
  const owner = step.owner !== undefined ? ` ${step.owner}` : "";
  return `${String(index + 1).padStart(2)} ${marker} ${step.type}${owner} (${step.key})${inputs}`;
}

export function createCatalogTools(
  catalog: CatalogService,
  sessions: SessionService,
): Registerable[] {
  return [
    defineTool({
      name: "catalog_list_builds",
      title: "List available builds",
      description:
        "List every domain, version and use-case published by the ONDC " +
        "config-service. Call this before session_create when the exact " +
        "domain code, version or use-case name is uncertain — use-case names " +
        "are case- and space-sensitive and must match exactly.",
      inputSchema: ListBuildsInput,
      outputSchema: ListBuildsOutput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      render: ({ builds, total }) => {
        if (total === 0) return "No builds matched.";
        return builds
          .map((build) =>
            [
              build.domain,
              ...build.versions.map(
                (version) =>
                  `  ${version.version} — ${version.usecases.join(", ")}`,
              ),
            ].join("\n"),
          )
          .join("\n");
      },
      handler: async ({ domain }) => {
        const builds = await catalog.listBuilds(domain);
        return { builds, total: builds.length };
      },
    }),

    defineTool({
      name: "catalog_list_flows",
      title: "List flows for a session",
      description:
        "List every flow published for the session's build, with the number of " +
        "steps this server must produce versus the number expected from the " +
        "participant under test. Use catalog_describe_flow for the full sequence.",
      inputSchema: ListFlowsInput,
      outputSchema: ListFlowsOutput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      render: ({ flows, total, mock_role, build }) => {
        const header = `${String(total)} flow(s) for ${build.domain} ${build.version} / ${build.usecase} — mock plays ${mock_role}:`;
        if (total === 0) return header;
        return [header, ...flows.map(renderFlowSummary)].join("\n");
      },
      handler: async ({ session_id }) => {
        const session = await sessions.requireSession(session_id);
        const flows = await catalog.listFlows(
          session.build,
          session.mock_role,
        );
        return {
          session_id: session.session_id,
          build: session.build,
          mock_role: session.mock_role,
          flows,
          total: flows.length,
        };
      },
    }),

    defineTool({
      name: "catalog_describe_flow",
      title: "Describe a flow",
      description:
        "The full ordered sequence of one flow. Every step is tagged with an " +
        "actor: 'mock' means this server must produce it, 'np' means it must " +
        "arrive from the participant under test. Also lists the inputs each " +
        "step needs and any parallel or unsolicited steps.",
      inputSchema: DescribeFlowInput,
      outputSchema: DescribeFlowOutput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      render: (flow) => {
        const lines = [
          `${flow.flow_id} — ${String(flow.step_count)} steps, mock plays ${flow.mock_role}`,
          flow.description,
          "",
          "» = this server sends it   « = awaited from the participant",
          ...flow.sequence.map(renderStep),
        ];
        if (flow.extra_sequence.length > 0) {
          lines.push(
            "",
            "extra (parallel / unsolicited):",
            ...flow.extra_sequence.map(renderStep),
          );
        }
        return lines.join("\n");
      },
      handler: async ({ session_id, flow_id }) => {
        const session = await sessions.requireSession(session_id);
        return catalog.describeFlow(
          session.build,
          flow_id,
          session.mock_role,
        );
      },
    }),

    defineTool({
      name: "catalog_load_flow_config",
      title: "Load a flow's mock config",
      description:
        "Fetch and cache the mock-runner configuration for a flow — the " +
        "per-step generation, validation, requirement and save-data logic the " +
        "workbench uses to drive it. Returns a summary of what each step " +
        "carries; the configuration itself is held server-side under the " +
        "returned cache_key for later execution, because it is far too large " +
        "to read directly.",
      inputSchema: LoadFlowConfigInput,
      outputSchema: LoadFlowConfigOutput,
      annotations: {
        // Caches server-side, but the observable result is the same every time.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      render: (config) => {
        const header = `${config.flow_id} — ${String(config.step_count)} steps, ${String(Math.round(config.total_bytes / 1024))}KB cached as ${config.cache_key}`;
        const steps = config.steps.map((step) => {
          const carried = Object.entries(step.has)
            .filter(([, present]) => present)
            .map(([name]) => name)
            .join(", ");
          const inputs =
            step.input_names.length > 0
              ? ` [inputs: ${step.input_names.join(", ")}]`
              : "";
          return `  ${step.actor === "mock" ? "»" : "«"} ${step.api} (${step.action_id}) — ${carried || "no logic"}${inputs}`;
        });
        return [header, ...steps].join("\n");
      },
      handler: async ({ session_id, flow_id }) => {
        const session = await sessions.requireSession(session_id);
        return catalog.loadMockConfig(
          session.build,
          flow_id,
          session.mock_role,
        );
      },
    }),
  ];
}
