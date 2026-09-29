import type { McpServer } from "@modelcontextprotocol/server";
import {
  MODULE_NAMES,
  resolveFeatures,
  type ModuleName,
} from "@/config/features.js";
import type { Container } from "@/container.js";
import type { Registerable, ToolHooks } from "@/lib/define-tool.js";
import { createBatchTools } from "@/modules/batch/batch.tool.js";
import { createCatalogResources } from "@/modules/catalog/catalog.resource.js";
import { createCatalogTools } from "@/modules/catalog/catalog.tool.js";
import { createFeedbackTools } from "@/modules/feedback/feedback.tool.js";
import { createFlowPrompts } from "@/modules/flow/flow.prompt.js";
import { createFlowTools } from "@/modules/flow/flow.tool.js";
import { createFormsTools } from "@/modules/forms/forms.tool.js";
import { createProtocolPrompts } from "@/modules/protocol/protocol.prompt.js";
import { createProtocolResources } from "@/modules/protocol/protocol.resource.js";
import { createProtocolTools } from "@/modules/protocol/protocol.tool.js";
import { createRecordResources } from "@/modules/record/record.resource.js";
import { createRecordTools } from "@/modules/record/record.tool.js";
import { createSessionResources } from "@/modules/session/session.resource.js";
import { createSessionTools } from "@/modules/session/session.tool.js";
import { createTransportTools } from "@/modules/transport/transport.tool.js";
import { createValidateTools } from "@/modules/validate/validate.tool.js";

/**
 * The one place that knows which capabilities exist.
 *
 * Still one entry per module and still explicit — but keyed by module name
 * rather than written as a bare array, so `PROFILE` / `MODULES_DISABLED` can
 * decide what the model actually sees. Registration order is `MODULE_NAMES`,
 * so the sequence lives beside the module list rather than in the shape of a
 * literal here.
 *
 * This is where the real gap closed: before it, `FEEDBACK_DISABLED=1` made the
 * feedback service inert but still advertised `feedback_submit_report` and
 * `feedback_list_reports` to the model — a tool that is present and does
 * nothing is worse than one that is absent.
 *
 * `record` reaches every session-scoped tool because each one drains the
 * session's event journal into its result — see `eventsFor`. That is the only
 * channel guaranteed to put what happened on the wire in front of the model,
 * so it is deliberately not something a tool can opt out of, and the module
 * dependency table in `config/features.ts` makes it un-disableable in any
 * profile that keeps them.
 */
type CapabilityFactory = (container: Container) => Registerable[];

const BY_MODULE: Partial<Record<ModuleName, CapabilityFactory>> = {
  transport: (c) => [...createTransportTools(c)],
  session: (c) => [
    ...createSessionTools(c.services.session, c.services.record),
    ...createSessionResources(c.services.session),
  ],
  catalog: (c) => [
    // The third argument is the `reality` block's only wiring. Passing the
    // service rather than importing it keeps the dependency pointing one way:
    // `protocol` needs `catalog` to validate a build, so `catalog` must not
    // need `protocol` back.
    ...createCatalogTools(
      c.services.catalog,
      c.services.session,
      resolveFeatures(c.config).enabled("protocol")
        ? c.services.protocol
        : undefined,
    ),
    ...createCatalogResources(c.services.catalog),
  ],
  protocol: (c) => [
    ...createProtocolTools(c.services.protocol),
    ...createProtocolResources(c.services.protocol),
    ...createProtocolPrompts(),
  ],
  flow: (c) => [
    ...createFlowTools(c.services.flow, c.services.record, {
      maxAwaitMs: c.config.AWAIT_MAX_WAIT_MS,
    }),
    ...createFlowPrompts(),
  ],
  forms: (c) => [...createFormsTools(c.services.forms, c.services.record)],
  batch: (c) => [...createBatchTools(c.services.batch)],
  validate: (c) => [
    ...createValidateTools(
      c.services.validate,
      c.services.session,
      c.services.record,
    ),
  ],
  record: (c) => [
    ...createRecordTools(c.services.record, c.services.session),
    ...createRecordResources(c.services.record, c.services.session),
  ],
  feedback: (c) => [
    ...createFeedbackTools(
      c.services.feedback,
      c.services.session,
      c.services.record,
    ),
  ],
};

export function collectCapabilities(container: Container): Registerable[] {
  const features = resolveFeatures(container.config);
  return MODULE_NAMES.flatMap((name) =>
    features.enabled(name) ? (BY_MODULE[name]?.(container) ?? []) : [],
  );
}

export function registerCapabilities(
  server: McpServer,
  container: Container,
): void {
  /*
   * The one place that has both the tool list and the container, which is why
   * the drift hook is built here rather than declared per tool.
   *
   * `defineTool` has already dropped the undeclared keys by the time this
   * runs; what it buys is that somebody finds out. A published schema and the
   * object a handler builds are two spellings of one shape, and when they stop
   * agreeing there is no other symptom on this side — the SDK's own output
   * check passes, because zod strips rather than refuses. The symptom was
   * entirely on the client's side, and a client cannot file an incident.
   */
  const hooks: ToolHooks = {
    onOutputDrift: (tool, paths, sessionId) => {
      container.services.feedback.noteToolDrift(tool, paths, sessionId);
    },
  };

  for (const capability of collectCapabilities(container)) {
    capability.register(server, hooks);
  }
}
