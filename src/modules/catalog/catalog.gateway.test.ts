import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logger } from "@/lib/logger.js";
import { HttpConfigServiceGateway } from "@/modules/catalog/catalog.gateway.js";
import { FIXTURE_BUILD, FIXTURE_FLOW_ID } from "@/test/fakes.js";
import {
  BUILDS_RESPONSE,
  FLOWS_RESPONSE,
  MOCK_CONFIG_RESPONSE,
} from "@/test/ondc-fixtures.js";

/**
 * The real HTTP client, driven against an intercepting dispatcher.
 *
 * These cases exist because the config-service's failure modes are unusual and
 * every one of them has bitten someone: a base URL with a path prefix that must
 * survive, a 404 that is a legitimate answer rather than an outage, and error
 * bodies whose `message` is far more useful than the status code alone.
 */

const ORIGIN = "https://config.test";
const BASE_URL = `${ORIGIN}/config-service`;

let agent: MockAgent;

function gateway(baseUrl: string = BASE_URL): HttpConfigServiceGateway {
  return new HttpConfigServiceGateway({
    baseUrl,
    timeoutMs: 1_000,
    dispatcher: agent,
    logger,
  });
}

beforeEach(() => {
  agent = new MockAgent();
  // A test that can reach the network is a test that fails for the wrong reason.
  agent.disableNetConnect();
});

afterEach(async () => {
  await agent.close();
});

describe("fetching builds", () => {
  it("keeps the base URL's path prefix and normalises the catalog", async () => {
    agent
      .get(ORIGIN)
      .intercept({
        path: "/config-service/protocol/available-builds",
        method: "GET",
      })
      .reply(200, BUILDS_RESPONSE);

    const builds = await gateway().fetchBuilds();

    expect(builds).toContainEqual(
      expect.objectContaining({ domain: FIXTURE_BUILD.domain }),
    );
    const fis12 = builds.find((b) => b.domain === FIXTURE_BUILD.domain);
    expect(fis12?.versions).toContainEqual(
      expect.objectContaining({
        version: FIXTURE_BUILD.version,
        usecases: expect.arrayContaining([FIXTURE_BUILD.usecase]),
      }),
    );
  });

  it("tolerates a trailing slash on the base URL", async () => {
    agent
      .get(ORIGIN)
      .intercept({
        path: "/config-service/protocol/available-builds",
        method: "GET",
      })
      .reply(200, BUILDS_RESPONSE);

    await expect(
      gateway(`${BASE_URL}///`).fetchBuilds(),
    ).resolves.not.toHaveLength(0);
  });
});

describe("fetching flows", () => {
  it("sends the build as query parameters and unwraps data.flows", async () => {
    let seenPath = "";
    agent
      .get(ORIGIN)
      .intercept({
        path: (path) => {
          seenPath = path;
          return path.startsWith("/config-service/ui/flow");
        },
        method: "GET",
      })
      .reply(200, FLOWS_RESPONSE);

    const flows = await gateway().fetchFlows(FIXTURE_BUILD);

    expect(flows.map((flow) => flow.id)).toContain(FIXTURE_FLOW_ID);
    // A space in the use-case must survive encoding; upstream decodes `+`.
    expect(seenPath).toContain("usecase=PERSONAL+LOAN");
    expect(seenPath).toContain("domain=ONDC%3AFIS12");
  });

  it("surfaces the upstream message on a 4xx rather than just the status", async () => {
    agent
      .get(ORIGIN)
      .intercept({
        path: (path) => path.startsWith("/config-service/ui/flow"),
        method: "GET",
      })
      .reply(400, { message: "version, usecase are required" });

    await expect(gateway().fetchFlows(FIXTURE_BUILD)).rejects.toMatchObject({
      code: "upstream_error",
      message: expect.stringContaining("version, usecase are required"),
    });
  });

  it("fails loudly when the response shape is not what we parse", async () => {
    agent
      .get(ORIGIN)
      .intercept({
        path: (path) => path.startsWith("/config-service/ui/flow"),
        method: "GET",
      })
      .reply(200, { unexpected: true });

    await expect(gateway().fetchFlows(FIXTURE_BUILD)).rejects.toMatchObject({
      code: "upstream_error",
      message: expect.stringContaining("unexpected shape"),
    });
  });
});

describe("fetching a mock config", () => {
  it("returns the config for a known flow", async () => {
    agent
      .get(ORIGIN)
      .intercept({
        path: (path) => path.startsWith("/config-service/mock/playground"),
        method: "GET",
      })
      .reply(200, MOCK_CONFIG_RESPONSE);

    const config = await gateway().fetchMockConfig(
      FIXTURE_BUILD,
      FIXTURE_FLOW_ID,
    );

    expect(config?.steps.length).toBeGreaterThan(0);
  });

  /**
   * An unknown flowId genuinely 404s here. That is an answer, not a fault: the
   * service turns it into a `not_found` the model can act on, so the gateway
   * must not raise it as an upstream failure.
   */
  it("treats a 404 as 'no such flow' rather than an upstream failure", async () => {
    agent
      .get(ORIGIN)
      .intercept({
        path: (path) => path.startsWith("/config-service/mock/playground"),
        method: "GET",
      })
      .reply(404, {
        data: null,
        message: "No flow found with the given flowId",
      });

    await expect(
      gateway().fetchMockConfig(FIXTURE_BUILD, "Nope"),
    ).resolves.toBeUndefined();
  });
});

describe("health probe", () => {
  it("resolves when the service answers /health", async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: "/config-service/health", method: "GET" })
      .reply(200, { status: "ok" });

    await expect(gateway().ping()).resolves.toBe(true);
  });

  it("rejects when the service is down, so /ready can answer 503", async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: "/config-service/health", method: "GET" })
      .reply(503, "unavailable");

    await expect(gateway().ping()).rejects.toMatchObject({
      code: "upstream_error",
    });
  });
});
