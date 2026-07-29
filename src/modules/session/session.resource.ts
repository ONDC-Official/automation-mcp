import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";
import type { Registerable } from "@/lib/define-tool.js";
import { toAppError } from "@/lib/errors.js";
import { jsonContents, MIME_JSON } from "@/lib/resource-contents.js";
import type { SessionService } from "@/modules/session/session.service.js";

/**
 * A session as a readable document, addressed by id.
 *
 * Private and short-lived on purpose: a session names the participant under
 * test and is only meaningful to the client that opened it.
 */
export function createSessionResources(
  service: SessionService,
): Registerable[] {
  return [
    {
      name: "ondc-session",
      register(server: McpServer): void {
        server.registerResource(
          "ondc-session",
          new ResourceTemplate("ondc://session/{sessionId}", {
            list: undefined,
          }),
          {
            title: "Session by id",
            description:
              "The participant under test, the role this server plays against " +
              "it, the build, and the session's expiry — as JSON.",
            mimeType: MIME_JSON,
            cacheHint: { ttlMs: 10_000, cacheScope: "private" },
          },
          async (uri) => {
            const sessionId = decodeURIComponent(
              uri.pathname.replace(/^\/+/, ""),
            );
            try {
              return jsonContents(uri, {
                session: await service.requireSession(sessionId),
              });
            } catch (error) {
              // Resources have no `isError` channel — surface it as a protocol
              // error instead.
              throw toAppError(error);
            }
          },
        );
      },
    },
  ];
}
