import type { McpServer } from "@modelcontextprotocol/server";
import type { Container } from "@/container.js";
import type { Registerable } from "@/lib/define-tool.js";
import { createCatalogResources } from "@/modules/catalog/catalog.resource.js";
import { createCatalogTools } from "@/modules/catalog/catalog.tool.js";
import { createSessionResources } from "@/modules/session/session.resource.js";
import { createSessionTools } from "@/modules/session/session.tool.js";

/**
 * The one place that knows which capabilities exist.
 *
 * Adding a module means adding one line here — nothing else in the scaffold
 * needs to change, and both transports pick it up automatically because both
 * are built from the same factory.
 */
export function collectCapabilities(container: Container): Registerable[] {
  return [
    ...createSessionTools(container.services.session),
    ...createCatalogTools(container.services.catalog, container.services.session),
    ...createSessionResources(container.services.session),
    ...createCatalogResources(container.services.catalog),
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
