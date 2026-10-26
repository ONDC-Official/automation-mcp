import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logger } from "@/lib/logger.js";
import { verifySignature } from "@/modules/signing/signing.crypto.js";
import { HttpRegistryGateway } from "@/modules/signing/signing.gateway.js";
import { keyPair } from "@/test/signing-keys.js";
import { requestBody } from "@/test/mock-participant.js";

const REGISTRY = "https://registry.example.com";
const ours = keyPair();

let agent: MockAgent;
let gateway: HttpRegistryGateway;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  gateway = new HttpRegistryGateway({
    baseUrl: `${REGISTRY}/v2.0/`,
    identity: {
      subscriberId: "mock.example",
      uniqueKeyId: "our-key",
      privateKey: ours.seed,
    },
    timeoutMs: 500,
    logger,
    dispatcher: agent,
  });
});

afterEach(async () => {
  await agent.close();
});

function registry() {
  return agent
    .get(REGISTRY)
    .intercept({ path: "/v2.0/lookup", method: "POST" });
}

describe("HttpRegistryGateway", () => {
  it("asks for one key and signs the lookup with our identity", async () => {
    let body = "";
    let authorization = "";
    registry().reply(200, (options) => {
      body = requestBody(options);
      authorization = String(
        (options.headers as Record<string, string>)["authorization"],
      );
      return [
        { subscriber_id: "np.example", ukId: "k1", signing_public_key: "PUB" },
      ];
    });

    const result = await gateway.lookup("np.example", "k1");

    expect(result).toEqual({ status: "found", publicKey: "PUB" });
    expect(JSON.parse(body)).toEqual({
      subscriber_id: "np.example",
      ukId: "k1",
    });
    expect(authorization).toMatch(
      /^Signature keyId="mock\.example\|our-key\|ed25519"/,
    );
    expect(
      await verifySignature({
        header: authorization,
        body,
        publicKey: ours.publicKey,
      }),
    ).toBe(true);
  });

  it("prefers the entry for the ukId it asked about", async () => {
    registry().reply(200, [
      { ukId: "old", signing_public_key: "OLD" },
      { ukId: "k1", signing_public_key: "NEW" },
    ]);

    expect(await gateway.lookup("np.example", "k1")).toEqual({
      status: "found",
      publicKey: "NEW",
    });
  });

  it("answers not_found for an empty list", async () => {
    registry().reply(200, []);
    expect(await gateway.lookup("np.example", "k1")).toEqual({
      status: "not_found",
    });
  });

  it.each([
    ["a refused lookup", 401, "{}"],
    ["a server error", 500, "oops"],
    ["a non-JSON body", 200, "<html>"],
    ["an unexpected shape", 200, '{"keys":[]}'],
  ])("answers unavailable for %s", async (_label, status, body) => {
    registry().reply(status, body);
    expect((await gateway.lookup("np.example", "k1")).status).toBe(
      "unavailable",
    );
  });

  it("answers unavailable when the registry cannot be reached", async () => {
    registry().replyWithError(new Error("ECONNREFUSED"));
    expect((await gateway.lookup("np.example", "k1")).status).toBe(
      "unavailable",
    );
  });

  it("answers unavailable on a timeout", async () => {
    registry().reply(200, []).delay(2_000);
    expect((await gateway.lookup("np.example", "k1")).status).toBe(
      "unavailable",
    );
  });
});
