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
 * How to guide a human through a manual session.
 *
 * In the preamble rather than only in `mock_buyer` / `mock_seller`, because a
 * prompt is opt-in in every client and a session that never selected one
 * would otherwise run manual mode exactly like auto mode. The preamble is the
 * same for every session, so the paragraph names its own condition.
 */
function manualModeLines(
  features: ReturnType<typeof resolveFeatures>,
): string[] {
  const lines = [
    "In a manual session the person is the participant under test: they send",
    "its requests and fill its forms, and you guide them. Once they pick a flow,",
    "list its steps — each one, who sends it (them or this mock) and what it does.",
    "Ask whether they will send their steps from their app or with terminal",
    "commands you give them. On each of their steps, tell them which request to",
    "send and the exact URL. Before each of this mock's steps, ask whether to",
    "send it now, and call flow_proceed only on yes; leave auto_advance off. If",
    "their last request was NACKed, explain the findings and do not offer the",
    "reply.",
  ];
  if (features.enabled("validate") && features.enabled("protocol")) {
    lines.push(
      "For a terminal command, build the request yourself:",
      "protocol_describe_action for its fields, record_get_payload with a jsonpath",
      "for the values it must echo from earlier messages, then payload_validate",
      "until it passes. Ask them for any values the step declares as inputs. Only",
      "then give them a curl to the step's URL with Content-Type:",
      "application/json — never an unchecked body.",
    );
  }
  return lines;
}

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
    "Before session_create, ask the person you are testing for which mode they",
    "want: manual (they send their app's requests and fill its forms themselves,",
    "and you guide each step) or auto (you drive the whole run). Pass their answer",
    "as interaction_mode; do not pick one for them.",
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
      "payload and event in the session. Right after every session_create, before",
      "your next tool call, write it to the person you are testing for: the full URL",
      "as plain text on its own line, not a markdown link, so they can copy it. This",
      "holds in auto mode too, and for a second session in the same conversation —",
      "each session has its own link. Do not wait to be asked, and do not summarise",
      "it away. A human who never receives it has no view of the run except your",
      "description of it.",
    );
  }
  if (features.enabled("catalog")) {
    lines.push(
      "",
      "Then list the flows to the person — each one's name and description — and ask",
      "whether to run one or explain one first. To explain a flow, describe its",
      "scenario and steps in plain words.",
      "",
      "catalog_describe_flow shows one flow's sequence. Every step is tagged",
      "with an actor: 'mock' means you must produce it, 'np' means you wait for the",
      "participant to send it.",
    );
  }
  if (features.enabled("flow")) {
    lines.push("", ...manualModeLines(features));
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
      "When a run gets stuck, feedback_submit_report records what happened. It also",
      "takes a report with no incident_id and no session at all: if your client",
      "refused a result, a tool description misled you, an answer was wrong, or",
      "something you needed does not exist, say so there — nothing on this side can",
      "see any of that, so unsaid means unknown. The tooling_gap field is the one",
      "that improves this tool surface.",
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
