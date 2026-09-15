import {
  McpServer,
  type McpRequestContext,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import { resolveFeatures } from "@/config/features.js";
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

/**
 * The model-facing preamble.
 *
 * Built from the enabled module set rather than written as one constant,
 * because a narrow `PROFILE` must not leave the server telling a model to call
 * a tool it never registered. The persona is always true; the sentences that
 * name specific tools travel with the module that provides them.
 */
function instructionsFor(container: Container): string {
  const features = resolveFeatures(container.config);
  const lines = [
  "This server makes you a mock ONDC network participant.",
  "You test a real participant by behaving as its counterparty: if it is a BAP",
  "(buyer app) you act as the BPP (seller app), and vice versa. The inversion is",
  "derived for you — never ask which role to play.",
  "",
  "Start with session_create, giving the participant's subscriber URL, whether it",
  "is a BAP or a BPP, and the domain, version and use-case under test. Call",
  "catalog_list_builds first if any of those values are uncertain; use-case names",
  "are case- and space-sensitive. session_create returns the flows you can drive.",
  ];
  if (features.enabled("ui")) {
    lines.push(
      "",
      "session_create also returns viewer_url: a live, read-only page of every flow,",
      "payload and event in the session. State that URL in full in your reply to the",
      "person you are testing for, before your turn ends — do not wait to be asked,",
      "and do not summarise it away. A human who never receives it has no view of the",
      "run except your description of it.",
    );
  }
  if (features.enabled("catalog")) {
    lines.push(
      "",
      "Then catalog_describe_flow to see one flow's sequence. Every step is tagged",
      "with an actor: 'mock' means you must produce it, 'np' means you wait for the",
      "participant to send it.",
    );
  }
  if (features.enabled("protocol")) {
    lines.push(
      "",
      "A flow is one scripted path, not the protocol. When the question is how ONDC",
      "itself works — what an action's fields mean, what a validator's rule code",
      "meant, what may legitimately happen next — use the protocol_* tools, which",
      "answer from the published spec and need no session: protocol_describe_build",
      "for a domain's actions, use-cases and error codes, and protocol_next_actions",
      "for the action graph a flow is only one path through. Look it up rather than",
      "inferring it from a flow that happened to pass. When a payload is refused,",
      "protocol_explain_rule takes the finding's code — or its json_path — and",
      "returns the published rule it broke.",
      "",
      "For how the network itself works rather than what one build publishes —",
      "signing and key rotation, the registry and gateway, onboarding, TTL and",
      "idempotency, the catalog model, the order state machine, error and reason",
      "codes — use protocol_search_knowledge. A prompt is opt-in and this is not,",
      "so: that tool exists, it needs no session, and it is where those answers",
      "come from instead of from memory.",
    );
  }
  if (features.enabled("feedback")) {
    lines.push(
      "",
      "When a run gets stuck, feedback_submit_report records what happened — the",
      "tooling_gap field is the one that improves this tool surface.",
    );
  }
  lines.push(
    "",
    "A failed call returns an error result rather than throwing — read it and adapt.",
  );
  return lines.join(" ");
}

export function buildMcpServer(
  container: Container,
  _ctx?: McpRequestContext,
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: instructionsFor(container),
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
