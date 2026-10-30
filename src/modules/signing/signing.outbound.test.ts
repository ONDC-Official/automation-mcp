import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "@/config/env.js";
import { createContainer, type Container } from "@/container.js";
import { verifySignature } from "@/modules/signing/signing.crypto.js";
import {
  createFakeConfigServiceGateway,
  createFakeValidationGateway,
} from "@/test/fakes.js";
import { requestBody } from "@/test/mock-participant.js";
import { RUNNABLE_BUILD, RUNNABLE_FLOW_ID } from "@/test/runnable-config.js";
import { keyPair } from "@/test/signing-keys.js";

/**
 * Our outbound calls, signed, through a real flow: the payload the config
 * generates, the bytes the sender puts on the wire, and the header over them.
 */

const NP = "https://np.example.com";
const ours = keyPair();
const IDENTITY = {
  WORKBENCH_SUBSCRIBER_ID: "workbench.ondc.org",
  UKID: "wb-key",
  SIGN_PRIVATE_KEY: ours.seed,
};

let container: Container | undefined;
let agent: MockAgent | undefined;

afterEach(async () => {
  await container?.dispose();
  await agent?.close();
  container = agent = undefined;
});

/** Start the flow and send its first step, `search`, answered as given. */
async function sendSearch(
  env: Record<string, string>,
  answer: { status: number; body: unknown } = {
    status: 200,
    body: { message: { ack: { status: "ACK" } } },
  },
) {
  agent = new MockAgent();
  agent.disableNetConnect();
  container = await createContainer(
    parseConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", ...env }),
    {
      configServiceGateway: createFakeConfigServiceGateway(),
      validationGateway: createFakeValidationGateway(),
      senderDispatcher: agent,
    },
  );

  const seen = { body: "", authorization: undefined as string | undefined };
  agent
    .get(NP)
    .intercept({ path: "/search", method: "POST" })
    .reply(answer.status, (options) => {
      seen.body = requestBody(options);
      const header = (options.headers as Record<string, string>)[
        "authorization"
      ];
      seen.authorization = header;
      return answer.body;
    });

  const { session } = await container.services.session.createSession({
    subscriber_url: NP,
    np_type: "BPP",
    domain: RUNNABLE_BUILD.domain,
    version: RUNNABLE_BUILD.version,
    usecase: RUNNABLE_BUILD.usecase,
  });
  await container.services.flow.start({
    sessionId: session.session_id,
    flowId: RUNNABLE_FLOW_ID,
  });
  const outcome = await container.services.flow.proceed({
    sessionId: session.session_id,
    flowId: RUNNABLE_FLOW_ID,
  });
  return { seen, outcome };
}

describe("outbound signing", () => {
  it("signs the exact bytes sent, as our registered identity", async () => {
    const { seen } = await sendSearch(IDENTITY);

    expect(seen.authorization).toMatch(
      /^Signature keyId="workbench\.ondc\.org\|wb-key\|ed25519"/,
    );
    expect(
      await verifySignature({
        header: seen.authorization ?? "",
        body: seen.body,
        publicKey: ours.publicKey,
      }),
    ).toBe(true);
  });

  it("sends the identity it signs as in the payload's bap_id", async () => {
    // Otherwise the participant sees a keyId naming a subscriber the payload
    // does not — the mismatch our own receiver refuses.
    const { seen } = await sendSearch(IDENTITY);
    const context = (JSON.parse(seen.body) as { context: { bap_id: string } })
      .context;
    expect(context.bap_id).toBe("workbench.ondc.org");
  });

  it("sends unsigned, as before, with no identity configured", async () => {
    const { seen } = await sendSearch({});
    expect(seen.authorization).toBeUndefined();
  });

  it("points the model at verification when a signed call gets 401", async () => {
    const { outcome } = await sendSearch(IDENTITY, {
      status: 401,
      body: { message: { ack: { status: "NACK" } } },
    });

    expect(outcome.http_status).toBe(401);
    expect(outcome.message).toContain("refused our signature");
    expect(outcome.message).toContain("01-signature-verification");
  });

  it("says we do not sign when an unsigned call gets 401", async () => {
    const { outcome } = await sendSearch(
      {},
      {
        status: 401,
        body: { message: { ack: { status: "NACK" } } },
      },
    );

    expect(outcome.message).toContain("this server does not sign");
  });
});
