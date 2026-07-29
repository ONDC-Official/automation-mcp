import type { McpServer } from "@modelcontextprotocol/server";
import type { Container } from "@/container.js";
import type { Registerable } from "@/lib/define-tool.js";
import { createCatalogResources } from "@/modules/catalog/catalog.resource.js";
import { createCatalogTools } from "@/modules/catalog/catalog.tool.js";
import { createFlowPrompts } from "@/modules/flow/flow.prompt.js";
import { createFlowTools } from "@/modules/flow/flow.tool.js";
import { createFormsTools } from "@/modules/forms/forms.tool.js";
import { createRecordResources } from "@/modules/record/record.resource.js";
import { createRecordTools } from "@/modules/record/record.tool.js";
import { createSessionResources } from "@/modules/session/session.resource.js";
import { createSessionTools } from "@/modules/session/session.tool.js";
import { createTransportTools } from "@/modules/transport/transport.tool.js";

/**
 * The one place that knows which capabilities exist.
 *
 * Adding a module means adding one line here — nothing else in the scaffold
 * needs to change, and both transports pick it up automatically because both
 * are built from the same factory.
 */
export function collectCapabilities(container: Container): Registerable[] {
  const { catalog, session, record, flow, forms } = container.services;

  return [
    ...createTransportTools(container),
    ...createSessionTools(session),
    ...createCatalogTools(catalog, session),
    ...createFlowTools(flow, {
      maxAwaitMs: container.config.AWAIT_MAX_WAIT_MS,
    }),
    ...createFormsTools(forms),
    ...createRecordTools(record, session),
    ...createSessionResources(session),
    ...createCatalogResources(catalog),
    ...createRecordResources(record, session),
    ...createFlowPrompts(),
  ];
}

export function registerCapabilities(
  server: McpServer,
  container: Container,
): void {
  for (const capability of collectCapabilities(container)) {
    capability.register(server);
  }
}
