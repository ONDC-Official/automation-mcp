import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "@/config/env.js";
import { createContainer, type Container } from "@/container.js";
import {
  createFakeConfigServiceGateway,
  createFakeValidationGateway,
} from "@/test/fakes.js";
import { RUNNABLE_BUILD } from "@/test/runnable-config.js";
import { UI_ROUTE_PREFIX } from "@/modules/ui/ui.routes.js";

/**
 * The viewer on the **stdio** transport.
 *
 * Under stdio there is no HTTP server at all until `receiver_start` binds one,
 * and that listener is built by a different function from the main app — bare
 * on purpose, with no security plugin, no zod compilers and no CORS. So every
 * property the viewer depends on has to be established twice, and a change that
 * only touches `app.ts` would leave the viewer working over HTTP and silently
 * dead on the transport most likely to be running on somebody's laptop.
 *
 * That is not a hypothetical: this is also the listener that binds `0.0.0.0`,
 * which is why the token matters here more than anywhere else.
 */

const NP = "https://np.example.com";
const TOKEN = "test-viewer-token";
const PAGE = "https://viewer.example.com";

const config = parseConfig({
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  UI_TOKEN: TOKEN,
  UI_BASE_URL: PAGE,
  // Any free port: the lifecycle reports back the one it actually bound.
  RECEIVER_PORT: "0",
});

let container: Container;
let baseUrl: string;
let sessionId: string;

beforeEach(async () => {
  container = await createContainer(config, {
    transport: "stdio",
    configServiceGateway: createFakeConfigServiceGateway(),
    validationGateway: createFakeValidationGateway(),
  });

  const status = await container.receiver.start(container);
  expect(status.running).toBe(true);
  expect(status.mode).toBe("standalone");
  expect(status.port).toBeGreaterThan(0);
  baseUrl = `http://127.0.0.1:${String(status.port)}`;

  const created = await container.services.session.createSession({
    subscriber_url: NP,
    np_type: "BPP",
    domain: RUNNABLE_BUILD.domain,
    version: RUNNABLE_BUILD.version,
    usecase: RUNNABLE_BUILD.usecase,
  });
  sessionId = created.session.session_id;
});

afterEach(async () => {
  await container.dispose();
});

describe("the standalone listener", () => {
  it("serves the viewer, schemas and all", async () => {
    // The zod serialiser is set on this host too, or a schema'd route is a
    // boot-time error rather than a 200.
    const response = await fetch(`${baseUrl}${UI_ROUTE_PREFIX}/sessions`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sessions: { session_id: string }[];
    };
    expect(body.sessions.map((entry) => entry.session_id)).toContain(sessionId);
  });

  it("still demands the token — this port binds 0.0.0.0", async () => {
    const response = await fetch(`${baseUrl}${UI_ROUTE_PREFIX}/sessions`);

    expect(response.status).toBe(401);
    await response.body?.cancel();
  });

  it("answers a preflight for the page's origin", async () => {
    const response = await fetch(`${baseUrl}${UI_ROUTE_PREFIX}/sessions`, {
      method: "OPTIONS",
      headers: {
        origin: PAGE,
        "access-control-request-method": "GET",
        "access-control-request-private-network": "true",
      },
    });

    expect(response.headers.get("access-control-allow-origin")).toBe(PAGE);
    expect(response.headers.get("access-control-allow-private-network")).toBe(
      "true",
    );
    await response.body?.cancel();
  });

  it("grants no cross-origin access to the receiver's own routes", async () => {
    // The counterparty is a server, and a person opening a form link is not
    // making a cross-origin XHR. Neither needs a grant, so neither gets one.
    const response = await fetch(
      `${baseUrl}/${RUNNABLE_BUILD.domain}/${RUNNABLE_BUILD.version}/seller`,
      { headers: { origin: PAGE } },
    );

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    await response.body?.cancel();
  });

  it("hands out a link pointing at the page, with the token in the fragment", () => {
    const url = container.viewerUrl(sessionId);
    expect(url).toBeDefined();

    const parsed = new URL(url ?? "");
    expect(parsed.origin).toBe(PAGE);
    expect(parsed.pathname).toBe("/mcp-session");
    // A query string is sent to the page's host in the request line, and would
    // put a credential for *this* server into somebody else's access logs.
    expect(parsed.search).toBe("");

    const params = new URLSearchParams(parsed.hash.slice(1));
    expect(params.get("session")).toBe(sessionId);
    expect(params.get("k")).toBe(TOKEN);
    expect(params.get("engine")).toBe(container.receiverPublicUrl);
  });
});
