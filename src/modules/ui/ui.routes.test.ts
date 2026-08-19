import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHttpApp, type App } from "@/app.js";
import { parseConfig, type Config } from "@/config/env.js";
import { createContainer, type Container } from "@/container.js";
import {
  createFakeConfigServiceGateway,
  createFakeValidationGateway,
} from "@/test/fakes.js";
import { RUNNABLE_BUILD, RUNNABLE_FLOW_ID } from "@/test/runnable-config.js";
import { UI_ROUTE_PREFIX } from "@/modules/ui/ui.routes.js";

/**
 * The viewer's HTTP surface, through `app.inject()`.
 *
 * The behaviours pinned here are the ones whose failure is invisible: a token
 * check that 500s instead of 401ing, a preflight that a browser silently
 * refuses, and a disabled viewer that advertises its own existence.
 */

const NP = "https://np.example.com";
const PAGE = "https://viewer.example.com";

function testConfig(overrides: Record<string, string> = {}): Config {
  return parseConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    UI_TOKEN: "test-viewer-token",
    UI_BASE_URL: PAGE,
    ...overrides,
  });
}

let app: App;
let container: Container;
let agent: MockAgent;
let sessionId: string;

async function boot(config: Config): Promise<void> {
  agent = new MockAgent();
  agent.disableNetConnect();
  container = await createContainer(config, {
    configServiceGateway: createFakeConfigServiceGateway(),
    validationGateway: createFakeValidationGateway(),
    senderDispatcher: agent,
  });
  app = await buildHttpApp(container, config);
  await app.ready();

  const created = await container.services.session.createSession({
    subscriber_url: NP,
    np_type: "BPP",
    domain: RUNNABLE_BUILD.domain,
    version: RUNNABLE_BUILD.version,
    usecase: RUNNABLE_BUILD.usecase,
  });
  sessionId = created.session.session_id;
}

afterEach(async () => {
  await app.close();
  await container.dispose();
  await agent.close();
});

function get(url: string, headers: Record<string, string> = {}) {
  return app.inject({ method: "GET", url, headers });
}

const authed = { authorization: "Bearer test-viewer-token" };

describe("the token gate", () => {
  beforeEach(async () => {
    await boot(testConfig());
  });

  it("refuses a request with no token", async () => {
    const response = await get(`${UI_ROUTE_PREFIX}/sessions`);

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("Bearer");
    expect(response.json()).toMatchObject({
      error: { code: "unauthorized" },
    });
  });

  it("refuses a token of the wrong length with 401, not 500", async () => {
    // `timingSafeEqual` throws on unequal lengths. Without the length guard
    // this is a 500, which both confuses the caller and leaks the correct
    // length through the status code.
    const response = await get(`${UI_ROUTE_PREFIX}/sessions`, {
      authorization: "Bearer x",
    });

    expect(response.statusCode).toBe(401);
  });

  it("refuses a wrong token of the right length", async () => {
    const response = await get(`${UI_ROUTE_PREFIX}/sessions`, {
      authorization: "Bearer test-viewer-tokeN",
    });

    expect(response.statusCode).toBe(401);
  });

  it("accepts the token as a bearer header", async () => {
    const response = await get(`${UI_ROUTE_PREFIX}/sessions`, authed);

    expect(response.statusCode).toBe(200);
  });

  it("accepts the token as a query parameter, because EventSource cannot set headers", async () => {
    const response = await get(
      `${UI_ROUTE_PREFIX}/sessions?k=test-viewer-token`,
    );

    expect(response.statusCode).toBe(200);
  });

  it("tells browsers and proxies not to keep the response", async () => {
    const response = await get(`${UI_ROUTE_PREFIX}/sessions`, authed);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("relaxes the app-wide resource policy, which is same-origin", async () => {
    // Helmet's `same-origin` is right everywhere else and wrong for the one
    // surface built to be read from another origin.
    const viewer = await get(`${UI_ROUTE_PREFIX}/sessions`, authed);
    const elsewhere = await get("/health");

    expect(viewer.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(elsewhere.headers["cross-origin-resource-policy"]).toBe(
      "same-origin",
    );
  });
});

describe("CORS", () => {
  beforeEach(async () => {
    await boot(testConfig());
  });

  it("allows the origin the page is served from", async () => {
    const response = await get(`${UI_ROUTE_PREFIX}/sessions`, {
      ...authed,
      origin: PAGE,
    });

    expect(response.headers["access-control-allow-origin"]).toBe(PAGE);
  });

  it("answers a preflight without demanding a token", async () => {
    // A preflight carries no Authorization header by definition. Refusing it
    // would fail the request the browser sends *before* the one that could
    // have authenticated.
    const response = await app.inject({
      method: "OPTIONS",
      url: `${UI_ROUTE_PREFIX}/sessions`,
      headers: {
        origin: PAGE,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });

    expect(response.statusCode).toBeLessThan(300);
    expect(response.headers["access-control-allow-origin"]).toBe(PAGE);
  });

  it("grants Private Network Access, so a hosted page can read a local engine", async () => {
    // Chrome refuses a public-origin fetch of `http://127.0.0.1` unless the
    // preflight answers this. Without it the viewer works against a deployed
    // engine and silently not against one on a laptop.
    const response = await app.inject({
      method: "OPTIONS",
      url: `${UI_ROUTE_PREFIX}/sessions`,
      headers: {
        origin: PAGE,
        "access-control-request-method": "GET",
        "access-control-request-private-network": "true",
      },
    });

    expect(response.headers["access-control-allow-private-network"]).toBe(
      "true",
    );
  });

  it("does not grant it to anything outside the viewer's prefix", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/health",
      headers: {
        origin: PAGE,
        "access-control-request-method": "GET",
        "access-control-request-private-network": "true",
      },
    });

    expect(
      response.headers["access-control-allow-private-network"],
    ).toBeUndefined();
  });

  it("does not extend the viewer's origins to the MCP endpoint", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { origin: PAGE, "content-type": "application/json" },
      payload: {},
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("when the viewer is switched off", () => {
  beforeEach(async () => {
    await boot(testConfig({ UI_ENABLED: "0" }));
  });

  it("registers no route at all, so there is nothing to find", async () => {
    // 404 rather than 403: "there is nothing here" and "there is something
    // here you may not have" are different disclosures, and only one is true.
    const response = await get(`${UI_ROUTE_PREFIX}/sessions`, authed);

    expect(response.statusCode).toBe(404);
  });

  it("hands out no link", async () => {
    const created = await container.services.session.createSession({
      subscriber_url: NP,
      np_type: "BPP",
      domain: RUNNABLE_BUILD.domain,
      version: RUNNABLE_BUILD.version,
      usecase: RUNNABLE_BUILD.usecase,
    });

    expect(created.viewer_url).toBeUndefined();
  });
});

describe("reads", () => {
  beforeEach(async () => {
    await boot(testConfig());
  });

  it("lists the sessions this process knows of", async () => {
    const response = await get(`${UI_ROUTE_PREFIX}/sessions`, authed);

    expect(response.statusCode).toBe(200);
    const body = response.json<{ sessions: { session_id: string }[] }>();
    expect(body.sessions.map((entry) => entry.session_id)).toContain(sessionId);
  });

  it("answers one session with its build, its flows and its runs", async () => {
    await container.services.flow.start({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      autoAdvance: false,
    });

    const response = await get(
      `${UI_ROUTE_PREFIX}/sessions/${sessionId}`,
      authed,
    );

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      session: { build: { domain: string }; callback_url: string };
      flows: { flow_id: string }[];
      runs: {
        flow_id: string;
        transaction_id: string | null;
        steps_total?: number;
      }[];
    }>();

    expect(body.session.build.domain).toBe(RUNNABLE_BUILD.domain);
    expect(body.flows.map((flow) => flow.flow_id)).toContain(RUNNABLE_FLOW_ID);
    expect(body.runs).toHaveLength(1);
    // A run that has put nothing on the wire has no id yet, and the viewer must
    // say so rather than showing the placeholder the engine works with.
    expect(body.runs[0]).toMatchObject({
      flow_id: RUNNABLE_FLOW_ID,
      transaction_id: null,
    });
    expect(body.runs[0]?.steps_total).toBeGreaterThan(0);
  });

  it("serves the engine's own step map, unprojected", async () => {
    await container.services.flow.start({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      autoAdvance: false,
    });

    const response = await get(
      `${UI_ROUTE_PREFIX}/sessions/${sessionId}/flows/${RUNNABLE_FLOW_ID}`,
      authed,
    );

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      flow_status: string;
      map: { sequence: { actionId: string; status: string }[] };
    }>();

    expect(body.flow_status).toBe("NOT_STARTED");
    expect(body.map.sequence.length).toBeGreaterThan(0);
    // The field names are the mapper's, not this module's — that is what lets
    // the page's step renderer consume it with no adaptation.
    expect(body.map.sequence[0]).toHaveProperty("actionId");
    expect(body.map.sequence[0]).toHaveProperty("pairActionId");
  });

  it("404s an unknown session rather than answering an empty one", async () => {
    const response = await get(
      `${UI_ROUTE_PREFIX}/sessions/nope/flows/${RUNNABLE_FLOW_ID}`,
      authed,
    );

    expect(response.statusCode).toBe(404);
  });
});
