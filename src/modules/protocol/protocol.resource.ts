import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";
import type { Registerable } from "@/lib/define-tool.js";
import { toAppError, ValidationError } from "@/lib/errors.js";
import { jsonContents, MIME_JSON } from "@/lib/resource-contents.js";
import type { ProtocolService } from "@/modules/protocol/protocol.service.js";

/**
 * The spec as readable documents.
 *
 * `ondc://schema/…` has been listed as planned since this server started, and
 * it lands here because the measurement changed: `meta.components` is null and
 * `meta.paths` carries no `$ref` on any published build, so an action's schema
 * is fully inlined at 0.8-6.8 KB and needs no resolver.
 *
 * A resource rather than a field on `protocol_describe_action`, and the
 * distinction is worth writing down: a resource is pulled deliberately by a
 * client and cached there. Unlike a tool result it does not land in context on
 * a call the model did not intend. That is exactly why the one large thing in
 * this module belongs here.
 *
 * Both are `public`: they carry no session, no participant and no transaction,
 * and are byte-identical for every client on a given build.
 */

/**
 * Split `/{domain}/{version}[/{action}]`.
 *
 * Each segment is decoded individually — a domain code contains a literal
 * colon (`ONDC:RET11`), which is legal in a path segment and is the only place
 * in this server where one appears.
 */
function segments(pathname: string, expected: number): string[] {
  const parts = pathname
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part !== "")
    .map((part) => decodeURIComponent(part));
  if (parts.length !== expected) {
    throw new ValidationError(
      `Expected ${String(expected)} path segments, got ${String(parts.length)}.`,
      { pathname },
    );
  }
  return parts;
}

export function createProtocolResources(
  protocol: ProtocolService,
): Registerable[] {
  return [
    {
      name: "ondc-spec",
      register(server: McpServer): void {
        server.registerResource(
          "ondc-spec",
          new ResourceTemplate("ondc://spec/{domain}/{version}", {
            list: undefined,
          }),
          {
            title: "Build specification",
            description:
              "One domain and version: its published business context, " +
              "use-cases, every action it defines, which actions may open a " +
              "transaction, and its error codes. No session required.",
            mimeType: MIME_JSON,
            cacheHint: { ttlMs: 3_600_000, cacheScope: "public" },
          },
          async (uri) => {
            try {
              const [domain, version] = segments(uri.pathname, 2);
              const card = await protocol.describeBuild({ domain, version }, [
                "overview",
                "flows",
              ]);
              return jsonContents(uri, card);
            } catch (error) {
              // Resources have no `isError` channel — surface it as a protocol
              // error instead.
              throw toAppError(error);
            }
          },
        );
      },
    },
    {
      name: "ondc-schema",
      register(server: McpServer): void {
        server.registerResource(
          "ondc-schema",
          new ResourceTemplate("ondc://schema/{domain}/{version}/{action}", {
            list: undefined,
          }),
          {
            title: "Action request schema",
            description:
              "The JSON Schema for one action's request body, as published " +
              "for this build. Fully inlined — there are no $refs to resolve.",
            mimeType: MIME_JSON,
            cacheHint: { ttlMs: 3_600_000, cacheScope: "public" },
          },
          async (uri) => {
            try {
              const [domain, version, action] = segments(uri.pathname, 3);
              const found = await protocol.schemaFor(
                { domain, version },
                action as string,
              );
              return jsonContents(uri, {
                ...found,
                source: "config-service meta.paths",
              });
            } catch (error) {
              throw toAppError(error);
            }
          },
        );
      },
    },
  ];
}
