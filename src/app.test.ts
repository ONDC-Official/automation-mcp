import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHttpApp, type App } from "@/app.js";
import { parseConfig, type Config } from "@/config/env.js";
import { createContainer, type Container } from "@/container.js";
import type { ConfigServiceGateway } from "@/modules/catalog/catalog.gateway.js";
import { createFakeConfigServiceGateway } from "@/test/fakes.js";

/**
 * HTTP-level tests through `app.inject()` — the full stack (security hooks,
 * auth, routing, the MCP handler) with no socket bound.
 */

const PROTOCOL_VERSION = "2026-07-28";

// Streamable HTTP requires clients to accept BOTH content types — the server
// chooses per response whether to answer with JSON or upgrade to an SSE
// stream. Sending only `application/json` earns a 406.
const ACCEPT = "application/json, text/event-stream";

function testConfig(overrides: Record<string, string> = {}): Config {
  return parseConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    MCP_PUBLIC_URL: "http://127.0.0.1:3000/mcp",
    ...overrides,
  });
}

/**
 * Read a JSON-RPC response body.
 *
 * With `responseMode: "auto"` the server answers with a plain JSON body *or*
 * upgrades to an SSE stream, its choice. A real client handles both, so the
 * tests do too rather than pinning the server to one mode.
 */
function rpcBody<T>(response: LightMyRequestResponse): T {
  const contentType = response.headers["content-type"];

  if (
    typeof contentType !== "string" ||
    !contentType.includes("text/event-stream")
  ) {
    return JSON.parse(response.body) as T;
  }

  const dataLine = response.body
    .split("\n")
    .find((line) => line.startsWith("data:"));
  if (!dataLine) throw new Error(`no SSE data frame in: ${response.body}`);
  return JSON.parse(dataLine.slice("data:".length).trim()) as T;
}

/**
 * Build a 2026-07-28 request.
 *
 * The revision replaced the `initialize` handshake with a per-request
 * envelope, and it is strict — all three `_meta` keys are mandatory on every
 * request, or the server answers `-32602` naming the missing one.
 */
function rpc(method: string, params: Record<string, unknown> = {}, id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": {
          name: "test",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
}

/**
 * Headers for a 2026-07-28 request (SEP-2243).
 *
 * `Mcp-Method` — and `Mcp-Name` for `tools/call` — are **required**, and must
 * agree with the body or the request is rejected. They exist so load
 * balancers, gateways and rate limiters can route and meter on the operation
 * without parsing the JSON-RPC body.
 */
function mcpHeaders(method: string, name?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: ACCEPT,
    "mcp-method": method,
    ...(name ? { "mcp-name": name } : {}),
  };
}

let app: App;
let container: Container;

async function boot(config: Config, gateway?: ConfigServiceGateway) {
  container = await createContainer(config, {
    // Never let a readiness probe reach the real config-service.
    configServiceGateway: gateway ?? createFakeConfigServiceGateway(),
  });
  app = await buildHttpApp(container, config);
  await app.ready();
}

afterEach(async () => {
  await app.close();
  await container.dispose();
});

describe("health endpoints", () => {
  beforeEach(async () => {
    await boot(testConfig());
  });

  it("reports liveness without touching dependencies", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
  });

  it("reports readiness with a per-dependency breakdown", async () => {
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      status: string;
      checks: { name: string; status: string }[];
    }>();
    expect(body.status).toBe("ready");
    expect(body.checks.map((check) => check.name)).toContain(
      "config-service",
    );
  });
});

describe("readiness when a dependency is down", () => {
  it("answers 503 so a load balancer stops routing here", async () => {
    await boot(
      testConfig(),
      createFakeConfigServiceGateway({
        failWith: new Error("connection refused"),
      }),
    );

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    const body = response.json<{
      status: string;
      checks: { status: string; error?: string }[];
    }>();
    expect(body.status).toBe("degraded");
    expect(body.checks[0]?.error).toContain("connection refused");
  });
});

describe("mcp endpoint", () => {
  beforeEach(async () => {
    await boot(testConfig());
  });

  it("serves tools/list over Streamable HTTP", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: mcpHeaders("tools/list"),
      payload: rpc("tools/list"),
    });

    expect(response.statusCode).toBe(200);
    const body = rpcBody<{ result?: { tools?: { name: string }[] } }>(response);
    expect(body.result?.tools?.map((tool) => tool.name)).toContain(
      "catalog_list_builds",
    );
  });

  it("executes a tool call and returns structuredContent", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: mcpHeaders("tools/call", "catalog_list_builds"),
      payload: rpc("tools/call", {
        name: "catalog_list_builds",
        arguments: { domain: "ONDC:FIS12" },
      }),
    });

    expect(response.statusCode).toBe(200);
    const body = rpcBody<{
      result?: { structuredContent?: { total?: number } };
    }>(response);
    expect(body.result?.structuredContent?.total).toBe(1);
  });

  it("carries cache hints on tools/list so clients can stop refetching", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: mcpHeaders("tools/list"),
      payload: rpc("tools/list"),
    });

    // Default would be ttlMs: 0 / private; server.ts sets these deliberately.
    const body = rpcBody<{
      result?: { ttlMs?: number; cacheScope?: string };
    }>(response);
    expect(body.result?.ttlMs).toBe(300_000);
    expect(body.result?.cacheScope).toBe("public");
  });
});

describe("REST error handling", () => {
  beforeEach(async () => {
    await boot(testConfig());
  });

  it("returns a structured 404 for an unknown route", async () => {
    const response = await app.inject({ method: "GET", url: "/nope" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("uses one error envelope across the REST surface", async () => {
    const response = await app.inject({ method: "DELETE", url: "/health" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toHaveProperty("error.message");
  });
});

describe("statelessness", () => {
  beforeEach(async () => {
    await boot(testConfig());
  });

  it("serves a tool call to an instance that never saw a prior request", async () => {
    // The core scalability claim, simulated: two independent instances stand
    // in for two replicas behind a round-robin load balancer. Instance A is
    // asked for the tool list; instance B — with no shared session store and
    // no knowledge of A — executes the call. Under the old stateful transport
    // this required sticky routing.
    const config = testConfig();

    const containerA = await createContainer(config, {
      configServiceGateway: createFakeConfigServiceGateway(),
    });
    const instanceA = await buildHttpApp(containerA, config);
    await instanceA.ready();

    const listed = await instanceA.inject({
      method: "POST",
      url: "/mcp",
      headers: mcpHeaders("tools/list"),
      payload: rpc("tools/list"),
    });
    expect(listed.statusCode).toBe(200);

    // Nothing carried over from A — no session id exists to carry.
    const called = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: mcpHeaders("tools/call", "catalog_list_builds"),
      payload: rpc("tools/call", {
        name: "catalog_list_builds",
        arguments: { domain: "ONDC:FIS12" },
      }),
    });

    expect(called.statusCode).toBe(200);
    const body = rpcBody<{
      result?: { structuredContent?: { total?: number } };
    }>(called);
    expect(body.result?.structuredContent?.total).toBe(1);

    expect(listed.headers["mcp-session-id"]).toBeUndefined();

    await instanceA.close();
    await containerA.dispose();
  });

  it("still serves 2025-era clients through the legacy fallback", async () => {
    // `legacy: "stateless"` in plugins/mcp.ts. A 2025 client sends no
    // envelope and no routing headers; it must still work.
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json", accept: ACCEPT },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "legacy-client", version: "0.0.0" },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = rpcBody<{ result?: { serverInfo?: { name: string } } }>(
      response,
    );
    expect(body.result?.serverInfo?.name).toBe("ondc-mcp");
  });
});

describe("DNS rebinding protection", () => {
  beforeEach(async () => {
    await boot(testConfig());
  });

  it("rejects a request whose Host header is not allowed", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...mcpHeaders("tools/list"), host: "evil.example.com" },
      payload: rpc("tools/list"),
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects a disallowed browser Origin", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        ...mcpHeaders("tools/list"),
        host: "127.0.0.1:3000",
        origin: "https://evil.example.com",
      },
      payload: rpc("tools/list"),
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("authorization", () => {
  const authConfig = testConfig({
    AUTH_MODE: "jwt",
    AUTH_ISSUER: "https://auth.example.com",
    AUTH_AUDIENCE: "http://127.0.0.1:3000/mcp",
    AUTH_JWKS_URL: "https://auth.example.com/.well-known/jwks.json",
    AUTH_REQUIRED_SCOPES: "mcp",
  });

  beforeEach(async () => {
    await boot(authConfig);
  });

  it("serves RFC 9728 metadata without a token", async () => {
    // Discovery must be open — it is what an unauthenticated client reads.
    const response = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource/mcp",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      resource: "http://127.0.0.1:3000/mcp",
      authorization_servers: ["https://auth.example.com"],
      scopes_supported: ["mcp"],
    });
  });

  it("challenges an unauthenticated call with a discoverable 401", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: mcpHeaders("tools/list"),
      payload: rpc("tools/list"),
    });

    expect(response.statusCode).toBe(401);

    // The challenge must point at the metadata document, or the client has no
    // way to discover which authorization server to use.
    const challenge = response.headers["www-authenticate"];
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain(
      'resource_metadata="http://127.0.0.1:3000/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("leaves health endpoints unauthenticated", async () => {
    // Probes must answer before a token exists, or orchestrators can't schedule.
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
  });
});
