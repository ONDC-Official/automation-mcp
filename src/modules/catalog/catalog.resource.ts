import type { McpServer } from "@modelcontextprotocol/server";
import type { Registerable } from "@/lib/define-tool.js";
import { jsonContents, MIME_JSON } from "@/lib/resource-contents.js";
import type { CatalogService } from "@/modules/catalog/catalog.service.js";

/**
 * The published build catalog as a readable document.
 *
 * Same data as `catalog_list_builds`, addressed by URI so a client can pin it
 * into context without spending a tool call. It changes only when a new domain
 * or version is deployed, so a shared cache is safe.
 */
export function createCatalogResources(
  service: CatalogService,
): Registerable[] {
  return [
    {
      name: "ondc-builds",
      register(server: McpServer): void {
        server.registerResource(
          "ondc-builds",
          "ondc://builds",
          {
            title: "ONDC builds",
            description:
              "Every domain, version and use-case published by the config-service, " +
              "as JSON. These are the only valid values for session_create.",
            mimeType: MIME_JSON,
            cacheHint: { ttlMs: 300_000, cacheScope: "public" },
          },
          async (uri) => {
            const builds = await service.listBuilds();
            return jsonContents(uri, { builds, total: builds.length });
          },
        );
      },
    },
  ];
}
