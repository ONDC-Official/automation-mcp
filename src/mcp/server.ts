import {
  McpServer,
  type McpRequestContext,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import type { Container } from "@/container.js";
import { registerCapabilities } from "@/mcp/capabilities.js";

/**
 * The MCP analogue of `buildApp()`.
 *
 * Constructs a fully-configured `McpServer` and **binds no transport**. The
 * stdio entrypoint, the HTTP handler, and every test consume exactly this — so
 * what the tests exercise is what production runs.
 *
 * ## Keep this function cheap
 *
 * Under `createMcpHandler` this runs **once per HTTP request** — that is the
 * mechanism that makes the 2026-07-28 transport stateless and lets any
 * instance answer any request. Registering handlers is cheap; opening a
 * connection pool is not. Everything expensive belongs in `createContainer`,
 * which is built once at boot and closed over here.
 *
 * `server.test.ts` asserts the factory performs no I/O, so a regression here
 * fails the build rather than quietly degrading throughput under load.
 */

const SERVER_NAME = "ondc-mcp";
const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = [
  "This server makes you a mock ONDC network participant.",
  "You test a real participant by behaving as its counterparty: if it is a BAP",
  "(buyer app) you act as the BPP (seller app), and vice versa. The inversion is",
  "derived for you — never ask which role to play.",
  "",
  "Start with session_create, giving the participant's subscriber URL, whether it",
  "is a BAP or a BPP, and the domain, version and use-case under test. Call",
  "catalog_list_builds first if any of those values are uncertain; use-case names",
  "are case- and space-sensitive. session_create returns the flows you can drive.",
  "",
  "Then catalog_describe_flow to see one flow's sequence. Every step is tagged",
  "with an actor: 'mock' means you must produce it, 'np' means you wait for the",
  "participant to send it.",
  "",
  "A failed call returns an error result rather than throwing — read it and adapt.",
].join(" ");

export function buildMcpServer(
  container: Container,
  _ctx?: McpRequestContext,
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: INSTRUCTIONS,
      // Revision 2026-07-28 cache hints. Without these the SDK emits
      // `ttlMs: 0, cacheScope: "private"` and every client re-fetches the
      // tool list on each call. The listings below change only on deploy.
      cacheHints: {
        "tools/list": { ttlMs: 300_000, cacheScope: "public" },
        "prompts/list": { ttlMs: 300_000, cacheScope: "public" },
        "resources/list": { ttlMs: 60_000, cacheScope: "public" },
        "resources/templates/list": { ttlMs: 300_000, cacheScope: "public" },
        "server/discover": { ttlMs: 300_000, cacheScope: "public" },
      },
    },
  );

  registerCapabilities(server, container);
  return server;
}

/** Bind a container to produce the factory both entrypoints expect. */
export function createServerFactory(container: Container): McpServerFactory {
  return (ctx: McpRequestContext) => buildMcpServer(container, ctx);
}
