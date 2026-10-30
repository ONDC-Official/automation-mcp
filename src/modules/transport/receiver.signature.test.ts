import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { buildHttpApp, type App } from "@/app.js";
import { parseConfig } from "@/config/env.js";
import { createContainer, type Container } from "@/container.js";
import { createAuthorizationHeader } from "ondc-crypto-sdk-nodejs";
import {
  expandPrivateKey,
  signRequest,
} from "@/modules/signing/signing.crypto.js";
import type { RegistryGateway } from "@/modules/signing/signing.gateway.js";
import type { Session } from "@/modules/session/session.schema.js";
import {
  createFakeConfigServiceGateway,
  createFakeValidationGateway,
} from "@/test/fakes.js";
import { acceptsAction, receiverPath } from "@/test/mock-participant.js";
import { RUNNABLE_BUILD, RUNNABLE_FLOW_ID } from "@/test/runnable-config.js";
import { keyPair } from "@/test/signing-keys.js";

/**
 * The receiver's signature check, end to end through the real routes: the raw
 * bytes, the session setting, the 401, and that a refused call is recorded on
 * its step as a NACK, as the workbench records it.
 */

const NP = "https://np.example.com";
const NP_ID = "np.example.com";
const np = keyPair();
const stranger = keyPair();

let app: App | undefined;
let container: Container | undefined;
let agent: MockAgent | undefined;

afterEach(async () => {
  await app?.close();
  await container?.dispose();
  await agent?.close();
  app = container = agent = undefined;
});

/** A registry that knows the participant's key, and nobody else's. */
const REGISTRY: RegistryGateway = {
  lookup: (subscriberId, uniqueKeyId) =>
    Promise.resolve(
      subscriberId === NP_ID && uniqueKeyId === "k1"
        ? { status: "found", publicKey: np.publicKey }
        : { status: "not_found" },
    ),
};

/** `null` boots a server with no registry, and so no keys. */
async function boot(
  registryGateway: RegistryGateway | null = REGISTRY,
): Promise<{ app: App; container: Container; agent: MockAgent }> {
  const config = parseConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });
  agent = new MockAgent();
  agent.disableNetConnect();
  container = await createContainer(config, {
    configServiceGateway: createFakeConfigServiceGateway(),
    validationGateway: createFakeValidationGateway(),
    senderDispatcher: agent,
    ...(registryGateway !== null ? { registryGateway } : {}),
  });
  app = await buildHttpApp(container, config);
  await app.ready();
  return { app, container, agent };
}

async function createSession(
  c: Container,
  npType: "BAP" | "BPP",
  settings?: { header_validation: boolean },
): Promise<Session> {
  const { session } = await c.services.session.createSession({
    subscriber_url: NP,
    np_type: npType,
    domain: RUNNABLE_BUILD.domain,
    version: RUNNABLE_BUILD.version,
    usecase: RUNNABLE_BUILD.usecase,
    ...(settings !== undefined ? { settings } : {}),
  });
  return session;
}

function sign(
  body: string,
  key = np.seed,
  subscriberId = NP_ID,
): Promise<string> {
  return signRequest({
    body,
    privateKey: key,
    subscriberId,
    uniqueKeyId: "k1",
  });
}

async function post(
  session: Session,
  action: string,
  body: string,
  authorization?: string,
) {
  const response = await (app as App).inject({
    method: "POST",
    url: receiverPath(session, action),
    headers: {
      "content-type": "application/json",
      ...(authorization !== undefined ? { authorization } : {}),
    },
    payload: body,
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? response.json<unknown>() : undefined,
    challenge: response.headers["www-authenticate"],
  };
}

/** The NACK names the check that failed; the guide goes to the model. */
function refused(reason: string) {
  return {
    message: { ack: { status: "NACK" } },
    error: { code: "10001", message: `Invalid signature: ${reason}.` },
  };
}

/** Mock is the BAP: we send `search`, the participant answers `on_search`. */
describe("a participant's callback on a known transaction", () => {
  async function waitingForOnSearch() {
    const booted = await boot();
    const session = await createSession(booted.container, "BPP");
    acceptsAction(booted.agent, NP, "search");
    await booted.container.services.flow.start({
      sessionId: session.session_id,
      flowId: RUNNABLE_FLOW_ID,
    });
    const sent = await booted.container.services.flow.proceed({
      sessionId: session.session_id,
      flowId: RUNNABLE_FLOW_ID,
    });
    const transactionId = sent.transaction_id ?? "";
    const onSearch = (overrides: Record<string, unknown> = {}) => ({
      context: {
        domain: RUNNABLE_BUILD.domain,
        action: "on_search",
        version: RUNNABLE_BUILD.version,
        transaction_id: transactionId,
        message_id: "msg-callback-1",
        timestamp: new Date(Date.now() + 2_000).toISOString(),
        bap_id: "mock.ondc-mcp.local",
        bpp_id: NP_ID,
        bpp_uri: NP,
        ...overrides,
      },
      message: { catalog: { providers: [{ id: "provider-1" }] } },
    });
    const onSearchStep = async () => {
      const status = await booted.container.services.flow.status(
        session.session_id,
        { flowId: RUNNABLE_FLOW_ID },
      );
      return status.sequence.find((step) => step.key === "on_search_1");
    };
    const onSearchStatus = async () => (await onSearchStep())?.status;
    return {
      ...booted,
      session,
      transactionId,
      onSearch,
      onSearchStep,
      onSearchStatus,
    };
  }

  it("ACKs a correctly signed call", async () => {
    const { session, onSearch, onSearchStatus } = await waitingForOnSearch();
    const body = JSON.stringify(onSearch());

    const response = await post(session, "on_search", body, await sign(body));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: { ack: { status: "ACK" } } });
    expect(await onSearchStatus()).toBe("COMPLETE");
  });

  it("verifies the bytes as sent, pretty-printed or not", async () => {
    const { session, onSearch } = await waitingForOnSearch();
    const body = JSON.stringify(onSearch(), null, 2);

    const response = await post(session, "on_search", body, await sign(body));

    expect(response.status).toBe(200);
  });

  it.each([
    [
      "no Authorization header",
      (_body: string) => Promise.resolve(undefined),
      "the Authorization header is missing or malformed",
    ],
    [
      "a signature over different bytes",
      async (body: string) => sign(`${body} `),
      "the signature does not verify against the registered key",
    ],
    [
      "a key that is not the participant's",
      async (body: string) => sign(body, stranger.seed),
      "the signature does not verify against the registered key",
    ],
    [
      "a keyId naming somebody other than the payload's sender",
      async (body: string) => sign(body, np.seed, "someone-else.example.com"),
      "the keyId's subscriber is not the payload's sender",
    ],
  ])(
    "refuses %s with 401, and records it as a NACK on the step",
    async (_label, header, reason) => {
      const { session, onSearch, onSearchStep } = await waitingForOnSearch();
      const body = JSON.stringify(onSearch());

      const response = await post(
        session,
        "on_search",
        body,
        await header(body),
      );

      expect(response.status).toBe(401);
      expect(response.body).toEqual(refused(reason));
      expect(response.challenge).toBe(
        'Signature realm="mock.ondc-mcp.local",headers="(created) (expires) digest"',
      );
      // As the workbench draws it: the step was taken, and refused.
      expect(await onSearchStep()).toMatchObject({
        status: "COMPLETE",
        ack: "NACK",
      });
    },
  );

  it("refuses an expired header", async () => {
    const { session, onSearch } = await waitingForOnSearch();
    const body = JSON.stringify(onSearch());
    const now = Math.floor(Date.now() / 1000);
    const expired = await createAuthorizationHeader({
      body,
      privateKey: expandPrivateKey(np.seed),
      subscriberId: NP_ID,
      subscriberUniqueKeyId: "k1",
      created: String(now - 7200),
      expires: String(now - 3600),
    });

    const response = await post(session, "on_search", body, expired);
    expect(response.status).toBe(401);
    expect(response.body).toEqual(
      refused("the header is expired or not yet valid"),
    );
  });

  it("tells the model, and a signed retry needs flow_restart", async () => {
    const {
      session,
      container: c,
      agent: a,
      onSearch,
      onSearchStep,
    } = await waitingForOnSearch();
    const body = JSON.stringify(onSearch());

    await post(session, "on_search", body);
    const events = await c.services.record.readEvents(session.session_id);
    const refusal = events.find((event) => event.nack_code === "10001");
    expect(refusal).toMatchObject({ kind: "ATTENTION", action: "on_search" });
    // The model gets the reason and the guide; the participant only the reason.
    expect(refusal?.summary).toContain(
      "the Authorization header is missing or malformed",
    );
    expect(refusal?.summary).toContain(
      "write ONDC's signing guide to them as the full URL, plain text on its own line: " +
        "https://dev-workbench.ondc.tech/developer-guide/auth-tools",
    );
    expect(refusal?.summary).toContain(
      "read 28-authorization-header-creation and 27-digest-generation with protocol_search_knowledge",
    );
    expect(refusal?.summary).toContain("call flow_restart");
    expect(refusal?.payload_id).toBeDefined();

    // The flow has moved past the refused step, so a retry on it is late.
    const late = await post(session, "on_search", body, await sign(body));
    expect(late.body).toMatchObject({ message: { ack: { status: "NACK" } } });

    await c.services.flow.restart({
      sessionId: session.session_id,
      flowId: RUNNABLE_FLOW_ID,
    });
    acceptsAction(a, NP, "search");
    const resent = await c.services.flow.proceed({
      sessionId: session.session_id,
      flowId: RUNNABLE_FLOW_ID,
    });
    const retryBody = JSON.stringify({
      ...onSearch(),
      context: {
        ...onSearch().context,
        transaction_id: resent.transaction_id,
        message_id: "msg-callback-2",
      },
    });
    const retry = await post(
      session,
      "on_search",
      retryBody,
      await sign(retryBody),
    );
    expect(retry.body).toEqual({ message: { ack: { status: "ACK" } } });
    expect(await onSearchStep()).toMatchObject({
      status: "COMPLETE",
      ack: "ACK",
    });
  });

  it("stops checking from the next call once the setting is off", async () => {
    const { session, container: c, onSearch } = await waitingForOnSearch();
    await c.services.session.updateSettings(session.session_id, {
      header_validation: false,
    });

    const response = await post(
      session,
      "on_search",
      JSON.stringify(onSearch()),
    );

    expect(response.status).toBe(200);
  });
});

/** Mock is the BPP: the participant's `search` opens the transaction. */
describe("a participant's first call, on an armed expectation", () => {
  function search(transactionId: string): string {
    return JSON.stringify({
      context: {
        action: "search",
        transaction_id: transactionId,
        message_id: `m-${transactionId}`,
        timestamp: new Date().toISOString(),
        bap_id: NP_ID,
        bap_uri: NP,
      },
      message: { intent: {} },
    });
  }

  it("records a refused first call on the run it opens", async () => {
    const { container: c } = await boot();
    const session = await createSession(c, "BAP");
    await c.services.flow.start({
      sessionId: session.session_id,
      flowId: RUNNABLE_FLOW_ID,
    });
    const searchStep = async () =>
      (
        await c.services.flow.status(session.session_id, {
          flowId: RUNNABLE_FLOW_ID,
        })
      ).sequence.find((step) => step.action === "search");

    const refused = await post(session, "search", search("txn-unsigned"));
    expect(refused.status).toBe(401);
    // As the workbench does: the call opened the transaction, and its step
    // shows as taken and refused.
    expect(
      await c.services.record.listTransactionIds(session.session_id),
    ).toEqual(["txn-unsigned"]);
    expect(await searchStep()).toMatchObject({
      status: "COMPLETE",
      ack: "NACK",
    });

    // Delete and play again: a signed search with a fresh id opens attempt 2.
    await c.services.flow.restart({
      sessionId: session.session_id,
      flowId: RUNNABLE_FLOW_ID,
    });
    const body = search("txn-signed");
    const accepted = await post(session, "search", body, await sign(body));
    expect(accepted.body).toEqual({ message: { ack: { status: "ACK" } } });
    expect(await searchStep()).toMatchObject({
      status: "COMPLETE",
      ack: "ACK",
    });
  });
});

describe("when the key cannot be had", () => {
  function onSearchFor(session: Session) {
    return post(
      session,
      "search",
      JSON.stringify({
        context: {
          action: "search",
          transaction_id: "txn-1",
          message_id: "m-1",
          timestamp: new Date().toISOString(),
          bap_id: NP_ID,
          bap_uri: NP,
        },
        message: { intent: {} },
      }),
      'Signature keyId="np.example.com|k1|ed25519",algorithm="ed25519",created="1",expires="9999999999",headers="(created) (expires) digest",signature="AAAA"',
    );
  }

  const REGISTRY_DOWN: RegistryGateway = {
    lookup: () =>
      Promise.resolve({ status: "unavailable", reason: "registry down" }),
  };

  it("refuses the call when the registry is unreachable, without blaming the signature", async () => {
    const { container: c } = await boot(REGISTRY_DOWN);
    const session = await createSession(c, "BAP");
    await c.services.flow.start({
      sessionId: session.session_id,
      flowId: RUNNABLE_FLOW_ID,
    });

    const response = await onSearchFor(session);
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      message: { ack: { status: "NACK" } },
      error: {
        code: "10001",
        message:
          "Could not verify signature: the registry lookup for your keyId failed.",
      },
    });

    const events = await c.services.record.readEvents(session.session_id);
    const refusal = events.find((event) => event.nack_code === "10001");
    expect(refusal?.summary).toContain(
      "could not get the participant's key from the registry (registry down)",
    );
    expect(refusal?.summary).not.toContain("28-authorization-header-creation");
    // Recorded on the run it opened, like any other refusal.
    expect(
      await c.services.record.listTransactionIds(session.session_id),
    ).toEqual(["txn-1"]);
  });

  it("accepts the call when the registry is unreachable and checking is off", async () => {
    const { container: c } = await boot(REGISTRY_DOWN);
    const session = await createSession(c, "BAP", {
      header_validation: false,
    });
    await c.services.flow.start({
      sessionId: session.session_id,
      flowId: RUNNABLE_FLOW_ID,
    });

    expect((await onSearchFor(session)).status).toBe(200);
  });

  it("does not check at all on a server with no keys", async () => {
    const { container: c } = await boot(null);
    expect(c.services.signing.canVerify).toBe(false);
    // Asked for, and still off: there is nothing to verify with.
    const session = await createSession(c, "BAP", { header_validation: true });
    expect(session.settings).toEqual({ header_validation: false });
    await c.services.flow.start({
      sessionId: session.session_id,
      flowId: RUNNABLE_FLOW_ID,
    });

    expect((await onSearchFor(session)).status).toBe(200);
  });
});
