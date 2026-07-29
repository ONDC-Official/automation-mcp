import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHttpApp, type App } from "@/app.js";
import { parseConfig } from "@/config/env.js";
import { createContainer, type Container } from "@/container.js";
import { createFakeConfigServiceGateway } from "@/test/fakes.js";
import type { Session } from "@/modules/session/session.schema.js";
import { acceptsAction, receiverPath } from "@/test/mock-participant.js";
import { RUNNABLE_BUILD, RUNNABLE_FLOW_ID } from "@/test/runnable-config.js";

/**
 * The inbound half, through the real HTTP stack via `app.inject()`.
 *
 * The whole point of these tests is the **status/ACK split**: a rejected but
 * well-formed call is an HTTP 200 carrying a protocol NACK, and only a request
 * we cannot even file gets a 4xx. Getting that wrong makes a participant's
 * error handling untestable, because every refusal looks like a transport
 * failure.
 */

const NP = "https://np.example.com";
const config = parseConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });

let app: App;
let container: Container;
let agent: MockAgent;
let sessionId: string;
let session: Session;
let transactionId: string;

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const capability = container.services;
  switch (name) {
    case "session_create":
      return await capability.session.createSession(args as never);
    default:
      throw new Error(`unsupported: ${name}`);
  }
}

/** POST a callback exactly as the participant would. */
async function callback(
  action: string,
  body: Record<string, unknown>,
  url = receiverPath(session, action),
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json" },
    payload: body,
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? response.json() : {},
  };
}

function onSearch(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    context: {
      domain: RUNNABLE_BUILD.domain,
      action: "on_search",
      version: RUNNABLE_BUILD.version,
      transaction_id: transactionId,
      message_id: "msg-callback-1",
      timestamp: new Date(Date.now() + 2_000).toISOString(),
      bap_id: "mock.ondc-mcp.local",
      bpp_id: "np.example.com",
      bpp_uri: NP,
    },
    message: {
      catalog: {
        providers: [{ id: "provider-1", descriptor: { name: "Bank" } }],
      },
    },
    ...overrides,
  };
}

beforeEach(async () => {
  agent = new MockAgent();
  agent.disableNetConnect();
  container = await createContainer(config, {
    configServiceGateway: createFakeConfigServiceGateway(),
    senderDispatcher: agent,
  });
  app = await buildHttpApp(container, config);
  await app.ready();

  const created = (await callTool("session_create", {
    subscriber_url: NP,
    np_type: "BPP",
    domain: RUNNABLE_BUILD.domain,
    version: RUNNABLE_BUILD.version,
    usecase: RUNNABLE_BUILD.usecase,
  })) as { session: Session };
  sessionId = created.session.session_id;
  session = created.session;

  acceptsAction(agent, NP, "search");
  const started = await container.services.flow.start({
    sessionId,
    flowId: RUNNABLE_FLOW_ID,
  });
  transactionId = started.runtime.record.transactionId;
});

afterEach(async () => {
  await app.close();
  await container.dispose();
  await agent.close();
});

/** Send `search` so the flow is waiting on `on_search`. */
async function sendSearch(): Promise<void> {
  await container.services.flow.proceed({ sessionId, transactionId });
}

describe("receiver — accepting a callback", () => {
  it("ACKs a valid callback and records it", async () => {
    await sendSearch();

    const response = await callback("on_search", onSearch());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: { ack: { status: "ACK" } } });

    const status = await container.services.flow.status(
      sessionId,
      transactionId,
    );
    expect(status.sequence.map((step) => [step.key, step.status])).toEqual([
      ["search_1", "COMPLETE"],
      ["on_search_1", "COMPLETE"],
      ["select_1", "INPUT-REQUIRED"],
      ["on_select_1", "WAITING"],
    ]);
  });

  it("folds the callback into business data for the next step", async () => {
    await sendSearch();
    await callback("on_search", onSearch());

    const data = await container.services.record.getBusinessData(
      transactionId,
      NP,
    );
    // `on_search`'s saveData declares providerId — which is exactly what
    // `select_1`'s requirements check blocks on.
    expect(data["providerId"]).toEqual(["provider-1"]);
  });

  it("advances the flow so the next mock step becomes reachable", async () => {
    await sendSearch();
    await callback("on_search", onSearch());

    acceptsAction(agent, NP, "select");
    const outcome = await container.services.flow.proceed({
      sessionId,
      transactionId,
      inputs: { loan_amount: 50_000 },
    });

    expect(outcome).toMatchObject({ outcome: "SENT", action: "select" });
  });
});

describe("receiver — refusing a callback", () => {
  it("NACKs at HTTP 200 when the step's validator rejects the payload", async () => {
    // The load-bearing case: a protocol-level refusal is a *successful* HTTP
    // exchange. Answering 4xx here would make it indistinguishable from a
    // proxy failure on the participant's side.
    await sendSearch();

    const response = await callback(
      "on_search",
      onSearch({ message: { catalog: undefined } }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      message: { ack: { status: "NACK" } },
      error: { code: "30001" },
    });
  });

  it("still records a rejected callback", async () => {
    await sendSearch();
    await callback("on_search", onSearch({ message: {} }));

    const record = await container.services.record.requireTransaction(
      transactionId,
      NP,
    );
    // The evidence has to survive the refusal, or the compliance report has
    // nothing to report.
    expect(record.apiList).toHaveLength(2);
    expect(record.apiList[1]).toMatchObject({ action: "on_search" });
  });

  it("answers 400 for a context with no message_id", async () => {
    // A deliberate divergence: the workbench panics with a 500 here.
    await sendSearch();

    const response = await callback("on_search", {
      context: { action: "on_search", transaction_id: transactionId },
      message: {},
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "MALFORMED_CONTEXT" },
    });
  });

  it("answers 400 when the caller does not identify itself", async () => {
    // The endpoint's role is ours, so the counterparty has to be on the other
    // side of the context. Nothing in the URL says who is calling.
    await sendSearch();
    const body = onSearch();
    delete (body["context"] as Record<string, unknown>)["bpp_uri"];

    const response = await callback("on_search", body);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "MALFORMED_CONTEXT" },
    });
    expect(
      (response.body["error"] as { message: string }).message,
    ).toContain("bpp_uri");
  });

  it("answers 412 when no transaction and no expectation exist", async () => {
    const response = await callback("on_search", {
      context: {
        action: "on_search",
        transaction_id: "never-seen-before",
        message_id: "m-1",
        timestamp: new Date().toISOString(),
        bpp_uri: NP,
      },
      message: { catalog: { providers: [] } },
    });

    expect(response.status).toBe(412);
    expect(response.body).toMatchObject({ error: { code: "NO_EXPECTATION" } });
    // The workbench's own wording: it names both halves of what it looked for.
    expect((response.body["error"] as { message: string }).message).toContain(
      "never-seen-before",
    );
  });

  it("answers 412 when the transaction belongs to a different endpoint", async () => {
    // "No expectation" would send an integrator looking in the wrong place.
    await sendSearch();

    const response = await callback(
      "on_search",
      onSearch(),
      `/ONDC:OTHER/9.9.9/buyer/on_search`,
    );

    expect(response.status).toBe(412);
    expect(response.body).toMatchObject({ error: { code: "WRONG_ENDPOINT" } });
    expect((response.body["error"] as { message: string }).message).toContain(
      RUNNABLE_BUILD.domain,
    );
  });

  it("NACKs at 200 when context.action contradicts the URL it arrived on", async () => {
    await sendSearch();

    // Well-formed HTTP carrying a real protocol defect — worth recording, not
    // worth a 4xx.
    const response = await callback(
      "on_search",
      onSearch(),
      receiverPath(session, "on_select"),
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      message: { ack: { status: "NACK" } },
      error: { code: "ACTION_MISMATCH" },
    });

    const record = await container.services.record.requireTransaction(
      transactionId,
      NP,
    );
    expect(record.apiList).toHaveLength(2);
  });

  it("NACKs an action the flow is not waiting for, and records it as evidence", async () => {
    await sendSearch();

    const response = await callback("on_confirm", {
      context: {
        action: "on_confirm",
        transaction_id: transactionId,
        message_id: "m-surprise",
        timestamp: new Date(Date.now() + 3_000).toISOString(),
        bpp_uri: NP,
      },
      message: {},
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      message: { ack: { status: "NACK" } },
      error: { code: "OUT_OF_SEQUENCE" },
    });

    const status = await container.services.flow.status(
      sessionId,
      transactionId,
    );
    // Recorded as a finding, and the flow did NOT advance past on_search.
    expect(status.missed_steps).toHaveLength(1);
    expect(status.missed_steps[0]?.action).toBe("on_confirm");
    expect(status.sequence[1]?.status).toBe("LISTENING");
  });
});

describe("receiver — opening a transaction from an expectation", () => {
  it("creates the transaction when the participant moves first", async () => {
    // A mock BPP waiting for `search` has no transaction yet: the participant
    // chooses the transaction_id. The armed expectation is what permits us to
    // create the record on arrival rather than answering 412.
    const created = (await callTool("session_create", {
      subscriber_url: NP,
      np_type: "BAP",
      domain: RUNNABLE_BUILD.domain,
      version: RUNNABLE_BUILD.version,
      usecase: RUNNABLE_BUILD.usecase,
    })) as { session: Session };
    const buyerSession = created.session.session_id;

    const started = await container.services.flow.start({
      sessionId: buyerSession,
      flowId: RUNNABLE_FLOW_ID,
    });
    // Mock is BPP here, so `search` is the participant's — the loop waits.
    expect(started.outcome.outcome).toBe("WAITING");
    await container.services.flow.proceed({
      sessionId: buyerSession,
      transactionId: started.runtime.record.transactionId,
    });

    const response = await callback(
      "search",
      {
        context: {
          action: "search",
          transaction_id: "np-chosen-txn",
          message_id: "m-first",
          timestamp: new Date().toISOString(),
          // Mock is BPP here, so the caller is the BAP and says so.
          bap_uri: NP,
        },
        message: { intent: {} },
      },
      receiverPath(created.session, "search"),
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: { ack: { status: "ACK" } } });

    const record = await container.services.record.requireTransaction(
      "np-chosen-txn",
      NP,
    );
    expect(record.flowId).toBe(RUNNABLE_FLOW_ID);
  });
});

describe("receiver — a counterparty whose advertised URI has drifted", () => {
  /**
   * The registered `subscriber_url` and the URI a participant advertises are
   * meant to be the same string and often are not. Resolving by transaction id
   * is what keeps that from silently splitting the transaction in two — the
   * receiver writing to one record while every read tool looks at another.
   */
  it("still resolves when only a trailing slash differs", async () => {
    await sendSearch();
    const body = onSearch();
    (body["context"] as Record<string, unknown>)["bpp_uri"] = `${NP}/`;

    const response = await callback("on_search", body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: { ack: { status: "ACK" } } });
  });

  it("still resolves when the pathname differs, and files it on the one record", async () => {
    await sendSearch();
    const body = onSearch();
    (body["context"] as Record<string, unknown>)["bpp_uri"] =
      `${NP}/ondc/v2`;

    const response = await callback("on_search", body);

    expect(response.status).toBe(200);

    // The record stays under the registered URL. A second one would leave the
    // flow reading a different half of its own history.
    const record = await container.services.record.requireTransaction(
      transactionId,
      NP,
    );
    expect(record.apiList).toHaveLength(2);
  });
});

describe("receiver — reachability surface", () => {
  it("describes itself at the exact URI it advertised", async () => {
    // A tester curling the callback_url we handed over should learn something
    // other than "404".
    const response = await app.inject({
      method: "GET",
      url: new URL(session.callback_url).pathname,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      domain: RUNNABLE_BUILD.domain,
      role: "buyer",
      mock_role: "BAP",
    });
  });

  it("404s a role segment that is not buyer or seller", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/${RUNNABLE_BUILD.domain}/${RUNNABLE_BUILD.version}/wholesaler/on_search`,
      headers: { "content-type": "application/json" },
      payload: onSearch(),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "UNKNOWN_ROLE" },
    });
  });

  it("forgives a trailing or doubled slash on the action", async () => {
    // Composed by a counterparty that stored our URI with a trailing slash.
    await sendSearch();
    const path = receiverPath(session, "on_search");

    const response = await callback(
      "on_search",
      onSearch(),
      path.replace("/on_search", "//on_search/"),
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: { ack: { status: "ACK" } } });
  });

  it("does not shadow the form routes", async () => {
    // Both are four segments, but a static prefix beats a parametric one.
    const response = await app.inject({
      method: "POST",
      url: `/forms/${RUNNABLE_BUILD.domain}/kyc_form/submit`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "pan=X",
    });

    expect(response.statusCode).not.toBe(404);
    expect(response.json()).not.toMatchObject({
      error: { code: "UNKNOWN_ROLE" },
    });
  });

  it("is not behind MCP auth", async () => {
    // The participant has no MCP credentials and never will; requiring them
    // would make the receiver unreachable by the only caller it has.
    const authed = parseConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      AUTH_MODE: "jwt",
      AUTH_ISSUER: "https://auth.example.com",
      AUTH_AUDIENCE: "http://127.0.0.1:3000/mcp",
      AUTH_JWKS_URL: "https://auth.example.com/.well-known/jwks.json",
    });
    const guarded = await createContainer(authed, {
      configServiceGateway: createFakeConfigServiceGateway(),
    });
    const guardedApp = await buildHttpApp(guarded, authed);
    await guardedApp.ready();

    const response = await guardedApp.inject({
      method: "POST",
      url: `/${RUNNABLE_BUILD.domain}/${RUNNABLE_BUILD.version}/buyer/on_search`,
      headers: { "content-type": "application/json" },
      payload: { context: { message_id: "m" } },
    });

    // 400 (malformed context), not 401 — it got past auth.
    expect(response.statusCode).toBe(400);

    await guardedApp.close();
    await guarded.dispose();
  });

  it("is reachable through a tunnel, not just from loopback", async () => {
    // DNS-rebinding protection defends the MCP tool surface and defaults to a
    // localhost Host check. Applied app-wide it would 403 every callback a
    // real participant sends to our public URL — which is the entire job.
    await sendSearch();

    const response = await app.inject({
      method: "POST",
      url: receiverPath(session, "on_search"),
      headers: {
        "content-type": "application/json",
        host: "abc123.ngrok-free.app",
      },
      payload: onSearch(),
    });

    expect(response.statusCode).toBe(200);
  });
});
