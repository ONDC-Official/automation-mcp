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
 * `ondc://knowledge` and `ondc://knowledge/{topicId}` land here for the same
 * reason, and it is the reason that argument was written down: the corpus is
 * 68 documents now, and "show me the whole thing" after a search hit should
 * not be a tool call that puts 5 KB in context on the way past.
 *
 * All four are `public`: they carry no session, no participant and no
 * transaction, and are byte-identical for every client.
 */

/** Knowledge documents are prose, not JSON — they are markdown as authored. */
const MIME_MARKDOWN = "text/markdown";

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
    {
      name: "ondc-knowledge-index",
      register(server: McpServer): void {
        server.registerResource(
          "ondc-knowledge-index",
          "ondc://knowledge",
          {
            title: "Knowledge base index",
            description:
              "Every topic this server can answer about the ONDC network " +
              "itself: id, title, category, how well sourced it is, and " +
              "which layer it belongs to. Read one with " +
              "ondc://knowledge/{topicId}. No session, no build required.",
            mimeType: MIME_JSON,
            cacheHint: { ttlMs: 3_600_000, cacheScope: "public" },
          },
          (uri) => {
            const entries = protocol.knowledgeIndex();
            return Promise.resolve(
              jsonContents(uri, {
                topics: entries,
                total: entries.length,
                categories: [
                  ...new Set(
                    entries
                      .map((entry) => entry.category)
                      .filter((entry) => entry !== undefined),
                  ),
                ].sort(),
              }),
            );
          },
        );
      },
    },
    {
      name: "ondc-knowledge",
      register(server: McpServer): void {
        server.registerResource(
          "ondc-knowledge",
          new ResourceTemplate("ondc://knowledge/{topicId}", {
            list: undefined,
          }),
          {
            title: "Knowledge document",
            description:
              "One whole document about how the ONDC network works, as " +
              "markdown. protocol_search_knowledge returns the section that " +
              "answers a question; this is the rest of it.",
            mimeType: MIME_MARKDOWN,
            cacheHint: { ttlMs: 3_600_000, cacheScope: "public" },
          },
          (uri) => {
            try {
              // A topic id is one segment and carries no colon, so it does not
              // need `segments()` — but it is still decoded, because an id is
              // a path segment a client may have encoded.
              const id = decodeURIComponent(
                uri.pathname.replace(/^\/+/, "").replace(/\/+$/, ""),
              );
              const doc = protocol.knowledgeDoc(id);
              const provenance = [
                doc.tier === "kb"
                  ? "Published by ONDC."
                  : "This server's own orientation notes.",
                doc.category !== undefined ? `Category: ${doc.category}.` : "",
                doc.status !== undefined ? `Sourcing: ${doc.status}.` : "",
                (doc.see_also ?? []).length > 0
                  ? `See also: ${(doc.see_also ?? []).join(", ")}.`
                  : "",
              ]
                .filter((part) => part !== "")
                .join(" ");

              return Promise.resolve({
                contents: [
                  {
                    uri: uri.href,
                    mimeType: MIME_MARKDOWN,
                    text: `# ${doc.title}\n\n_${provenance}_\n\n${doc.body}\n`,
                  },
                ],
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
