import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHttpApp, type App } from "@/app.js";
import { parseConfig } from "@/config/env.js";
import { createContainer, type Container } from "@/container.js";
import {
  createFakeConfigServiceGateway,
  createFakeValidationGateway,
  invalidFrom,
  type FakeValidationGateway,
} from "@/test/fakes.js";
import { L1_MULTI_RULE } from "@/test/validation-fixtures.js";
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
let validation: FakeValidationGateway;
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
  validation = createFakeValidationGateway();
  container = await createContainer(config, {
    configServiceGateway: createFakeConfigServiceGateway(),
    validationGateway: validation,
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
  await container.services.flow.start({ sessionId, flowId: RUNNABLE_FLOW_ID });
  // No id yet, and deliberately so: this mock is the BAP here, so the flow's
  // first action is ours to send and `sendSearch` is what mints it.
  transactionId = "";
});

afterEach(async () => {
  await app.close();
  await container.dispose();
  await agent.close();
});

/**
 * Send `search` so the flow is waiting on `on_search`.
 *
 * Driven by `flowId`, because until this call lands there is no transaction to
 * name — sending the flow's first action is what mints its id.
 */
async function sendSearch(): Promise<void> {
  const outcome = await container.services.flow.proceed({
    sessionId,
    flowId: RUNNABLE_FLOW_ID,
  });
  if (outcome.transaction_id === undefined) {
    throw new Error(`search did not go out: ${outcome.message}`);
  }
  transactionId = outcome.transaction_id;
}

describe("receiver — accepting a callback", () => {
  it("ACKs a valid callback and records it", async () => {
    await sendSearch();

    const response = await callback("on_search", onSearch());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: { ack: { status: "ACK" } } });

    const status = await container.services.flow.status(sessionId, {
      transactionId,
    });
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

    const status = await container.services.flow.status(sessionId, {
      transactionId,
    });
    // Recorded as a finding, and the flow did NOT advance past on_search.
    expect(status.missed_steps).toHaveLength(1);
    expect(status.missed_steps[0]?.action).toBe("on_confirm");
    expect(status.sequence[1]?.status).toBe("LISTENING");
  });
});

describe("receiver — opening a transaction from an expectation", () => {
  /**
   * A mock BPP waiting for `search` has no transaction yet, and the
   * `transaction_id` is the participant's to choose. The armed expectation is
   * what permits us to create the record on arrival rather than answering 412.
   */
  async function startBuyerFlow(): Promise<{
    session: Session;
    sessionId: string;
  }> {
    const created = (await callTool("session_create", {
      subscriber_url: NP,
      np_type: "BAP",
      domain: RUNNABLE_BUILD.domain,
      version: RUNNABLE_BUILD.version,
      usecase: RUNNABLE_BUILD.usecase,
    })) as { session: Session };

    const started = await container.services.flow.start({
      sessionId: created.session.session_id,
      flowId: RUNNABLE_FLOW_ID,
    });
    // Mock is BPP here, so `search` is the participant's — the loop waits.
    expect(started.outcome.outcome).toBe("WAITING");
    return { session: created.session, sessionId: created.session.session_id };
  }

  function search(
    transactionId: string,
    messageId = "m-first",
  ): Record<string, unknown> {
    return {
      context: {
        action: "search",
        transaction_id: transactionId,
        message_id: messageId,
        timestamp: new Date().toISOString(),
        // Mock is BPP here, so the caller is the BAP and says so.
        bap_uri: NP,
      },
      message: { intent: {} },
    };
  }

  it("adopts the participant's transaction id, and opens exactly one record", async () => {
    const { session: buyer, sessionId: buyerSession } = await startBuyerFlow();

    const response = await callback(
      "search",
      search("np-chosen-txn"),
      receiverPath(buyer, "search"),
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: { ack: { status: "ACK" } } });

    const record = await container.services.record.requireTransaction(
      "np-chosen-txn",
      NP,
    );
    expect(record.flowId).toBe(RUNNABLE_FLOW_ID);

    // The whole point. `flow_start` used to mint an id of its own and file a
    // record under it, so this call opened a *second* one and left the caller
    // holding a handle that named nothing.
    const ids = await container.services.record.listTransactionIds(
      buyerSession,
    );
    expect(ids).toEqual(["np-chosen-txn"]);
  });

  it("reports the adopted id against the flow the caller started", async () => {
    const { session: buyer, sessionId: buyerSession } = await startBuyerFlow();

    await callback(
      "search",
      search("np-chosen-txn"),
      receiverPath(buyer, "search"),
    );

    // The caller only ever knew the flow id; this is how it learns the rest.
    const status = await container.services.flow.status(buyerSession, {
      flowId: RUNNABLE_FLOW_ID,
    });
    expect(status.transaction_id).toBe("np-chosen-txn");
    expect(status.sequence[0]).toMatchObject({
      key: "search_1",
      status: "COMPLETE",
    });
  });

  it("arms from flow_start alone, with no flow_proceed in between", async () => {
    // A model that does what a WAITING outcome tells it calls flow_await, not
    // flow_proceed. Arming only in `proceed` meant the participant's very first
    // callback was refused 412 for a flow the caller had correctly started.
    const { session: buyer } = await startBuyerFlow();

    const response = await callback(
      "search",
      search("np-chosen-txn"),
      receiverPath(buyer, "search"),
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: { ack: { status: "ACK" } } });
  });

  it("wakes a flow_await that parked before the id existed", async () => {
    const { session: buyer, sessionId: buyerSession } = await startBuyerFlow();

    const waiting = container.services.flow.awaitEvent({
      sessionId: buyerSession,
      flowId: RUNNABLE_FLOW_ID,
      timeoutMs: 2_000,
    });

    await callback(
      "search",
      search("np-chosen-txn"),
      receiverPath(buyer, "search"),
    );

    const result = await waiting;
    expect(result.timedOut).toBe(false);
    expect(result.transactionId).toBe("np-chosen-txn");
    expect(result.event?.action).toBe("search");
  });

  it("refuses a later call that quotes a different transaction, and keeps listening", async () => {
    const { session: buyer, sessionId: buyerSession } = await startBuyerFlow();

    await callback(
      "search",
      search("np-chosen-txn"),
      receiverPath(buyer, "search"),
    );
    // `on_search` is ours to send; the call after it arms the wait for
    // `select`, and that expectation now carries the bound transaction id.
    acceptsAction(agent, NP, "on_search");
    await container.services.flow.proceed({
      sessionId: buyerSession,
      flowId: RUNNABLE_FLOW_ID,
    });
    const waiting = await container.services.flow.proceed({
      sessionId: buyerSession,
      flowId: RUNNABLE_FLOW_ID,
    });
    expect(waiting.outcome).toBe("WAITING");

    const wrong = await callback(
      "select",
      {
        context: {
          action: "select",
          transaction_id: "some-other-txn",
          message_id: "m-wrong",
          timestamp: new Date().toISOString(),
          bap_uri: NP,
        },
        message: { order: {} },
      },
      receiverPath(buyer, "select"),
    );

    expect(wrong.status).toBe(200);
    expect(wrong.body).toMatchObject({
      message: { ack: { status: "NACK" } },
      error: { code: "TRANSACTION_MISMATCH" },
    });

    // Filed as evidence against the transaction it should have quoted, without
    // advancing the step it was pretending to be.
    const status = await container.services.flow.status(buyerSession, {
      flowId: RUNNABLE_FLOW_ID,
    });
    expect(status.transaction_id).toBe("np-chosen-txn");
    expect(status.attention?.kind).toBe("TRANSACTION_MISMATCH");
    expect(
      status.sequence.find((step) => step.key === "select_1")?.status,
    ).toBe("LISTENING");

    // ...and the expectation was put back, so the correct call still lands.
    const right = await callback(
      "select",
      {
        context: {
          action: "select",
          transaction_id: "np-chosen-txn",
          message_id: "m-right",
          timestamp: new Date(Date.now() + 1_000).toISOString(),
          bap_uri: NP,
        },
        message: { order: {} },
      },
      receiverPath(buyer, "select"),
    );
    expect(right.body).toEqual({ message: { ack: { status: "ACK" } } });
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
      validationGateway: createFakeValidationGateway(),
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

/* -------------------------------------------------------------------------- */
/* Refusals nobody can be told about directly                                  */
/* -------------------------------------------------------------------------- */

/**
 * The three refusals made *before* a session is in hand.
 *
 * Note the action every test uses: `on_status`, which nothing in the runnable
 * flow is armed for. A stray `on_search` would match the expectation this
 * session already has and take the mismatch path instead — a different branch
 * entirely, and one that already knows whose call it is.
 */
describe("POSSIBLY_RELATED", () => {
  const SCOPE = {
    domain: RUNNABLE_BUILD.domain,
    version: RUNNABLE_BUILD.version,
    role: "buyer" as const,
  };

  /** Everything journaled for a session; piggyback has consumed none of it. */
  const journalOf = (id: string) => container.services.record.readEvents(id);

  const relatedFor = async (id: string) =>
    (await journalOf(id)).filter((event) => event.kind === "POSSIBLY_RELATED");

  function stray(
    action: string,
    transactionId = "belongs-to-nobody",
    message: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      context: {
        action,
        transaction_id: transactionId,
        message_id: "m-stray",
        timestamp: new Date().toISOString(),
        bpp_uri: NP,
      },
      message,
    };
  }

  it("tells a session listening on the endpoint about a call it refused", async () => {
    await sendSearch(); // now armed for on_search — but not for on_status

    const response = await callback("on_status", stray("on_status"));
    expect(response.status).toBe(412);
    expect(response.body).toMatchObject({ error: { code: "NO_EXPECTATION" } });

    const related = await relatedFor(sessionId);
    expect(related).toHaveLength(1);
    expect(related[0]).toMatchObject({
      nack_code: "NO_EXPECTATION",
      action: "on_status",
      transaction_id: "belongs-to-nobody",
      ack: "NACK",
    });
    // The kind is the honest part: it may be this session's call, and it may
    // not. The endpoint is shared, and the wire cannot say more than that.
    expect(related[0]?.summary).toContain("may belong to your run");
  });

  it("keeps the refused body readable behind the handle", async () => {
    await sendSearch();
    await callback(
      "on_status",
      stray("on_status", "belongs-to-nobody", { order: { id: "evidence" } }),
    );

    const [related] = await relatedFor(sessionId);
    const payload = await container.services.record.requirePayload(
      related?.payload_id ?? "",
    );

    // The whole call, context included — the point is to be able to recognise
    // it, and the context is the half that says who was calling.
    expect(payload.body).toMatchObject({
      context: { action: "on_status", transaction_id: "belongs-to-nobody" },
      message: { order: { id: "evidence" } },
    });
    expect(payload.direction).toBe("inbound");
  });

  it("journals nowhere when no session lives on the endpoint", async () => {
    // A build this server has no session for. Nobody could plausibly own this
    // call, so nobody is told about it.
    const response = await callback(
      "on_status",
      stray("on_status"),
      "/ONDC:NOBODY/9.9.9/buyer/on_status",
    );

    expect(response.status).toBe(412);
    await expect(journalOf(sessionId)).resolves.toEqual([]);
  });

  it("reaches both sessions when two share the endpoint", async () => {
    await sendSearch();

    const otherNp = "https://other-np.example.com";
    const other = (await callTool("session_create", {
      subscriber_url: otherNp,
      np_type: "BPP",
      domain: RUNNABLE_BUILD.domain,
      version: RUNNABLE_BUILD.version,
      usecase: RUNNABLE_BUILD.usecase,
    })) as { session: Session };
    acceptsAction(agent, otherNp, "search");
    await container.services.flow.start({
      sessionId: other.session.session_id,
      flowId: RUNNABLE_FLOW_ID,
    });
    await container.services.flow.proceed({
      sessionId: other.session.session_id,
      flowId: RUNNABLE_FLOW_ID,
    });

    await callback("on_status", stray("on_status"));

    for (const id of [sessionId, other.session.session_id]) {
      const related = await relatedFor(id);
      expect(related).toHaveLength(1);
      expect(related[0]?.nack_code).toBe("NO_EXPECTATION");
    }
  });

  it("tells the owning session alone when the call hit the wrong endpoint", async () => {
    // Here the id *is* known — the index says whose transaction it is — so this
    // is told to that session rather than broadcast. Their participant is the
    // one calling the wrong door; everyone else is a bystander.
    await sendSearch();

    await callback(
      "on_search",
      onSearch(),
      "/ONDC:OTHER/9.9.9/buyer/on_search",
    );

    const related = await relatedFor(sessionId);
    expect(related).toHaveLength(1);
    expect(related[0]).toMatchObject({
      nack_code: "WRONG_ENDPOINT",
      transaction_id: transactionId,
    });
  });

  it("reports an expired session's refusal to whoever else is listening", async () => {
    await sendSearch();

    // An expectation naming a session that is not there — what a session TTL
    // expiring mid-run leaves behind on a shared endpoint.
    await container.services.record.armExpectation(SCOPE, {
      sessionId: "00000000-0000-0000-0000-000000000000",
      flowId: RUNNABLE_FLOW_ID,
      expectedAction: "on_status",
      subscriberUrl: NP,
      autoAdvance: false,
    });

    const response = await callback("on_status", stray("on_status"));

    expect(response.status).toBe(412);
    expect(response.body).toMatchObject({ error: { code: "SESSION_EXPIRED" } });

    const related = await relatedFor(sessionId);
    expect(related).toHaveLength(1);
    expect(related[0]?.nack_code).toBe("SESSION_EXPIRED");
  });

  /**
   * This endpoint is unauthenticated by design — a third-party server has no
   * MCP credentials and never will — so a stranger must not be able to park an
   * unbounded body in the store by POSTing one.
   */
  it("caps the body it keeps for a refused call", async () => {
    await sendSearch();

    await callback(
      "on_status",
      stray("on_status", "belongs-to-nobody", {
        catalog: {
          providers: Array.from({ length: 2_000 }, (_, index) => ({
            id: `provider-${String(index)}`,
            descriptor: { long_desc: "x".repeat(200) },
          })),
        },
      }),
    );

    const [related] = await relatedFor(sessionId);
    const payload = await container.services.record.requirePayload(
      related?.payload_id ?? "",
    );

    expect(payload.body).toMatchObject({ _truncated: true });
    const stored = JSON.stringify(payload.body);
    expect(stored.length).toBeLessThan(64_000);
  });
});

describe("receiver — protocol validation", () => {
  it("NACKs a callback that is not spec-compliant, and records it", async () => {
    await sendSearch();
    validation.setResult(invalidFrom(L1_MULTI_RULE));

    const response = await callback("on_search", onSearch());

    // 200, because a protocol refusal is a successful HTTP exchange carrying a
    // NACK — the same rule the rest of this receiver follows.
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      message: { ack: { status: "NACK" } },
      error: { code: "REQUIRED_CONTEXT_CODE_1" },
    });

    // Recorded as evidence, carrying the refusal — same shape the step
    // validator's own NACK leaves behind, which is the point: a protocol
    // refusal and a step refusal have to be equally visible to the report.
    const record = await container.services.record.requireTransaction(
      transactionId,
      NP,
    );
    expect(record.apiList[1]).toMatchObject({
      action: "on_search",
      response: { message: { ack: { status: "NACK" } } },
    });
  });

  it("ACKs when the oracle is unreachable, rather than blaming the participant", async () => {
    // The test that matters. NACKing a compliant participant because *our*
    // dependency was down writes our infrastructure failure into their
    // compliance report, which is exactly what this must never do.
    await sendSearch();
    validation.setResult({ status: "unavailable", reason: "oracle was down" });

    const response = await callback("on_search", onSearch());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: { ack: { status: "ACK" } } });

    const status = await container.services.flow.status(sessionId, {
      transactionId,
    });
    expect(
      status.sequence.find((step) => step.key === "on_search_1")?.status,
    ).toBe("COMPLETE");
  });

  it("says in the journal that a callback went unvalidated", async () => {
    await sendSearch();
    validation.setResult({ status: "unavailable", reason: "oracle was down" });
    await callback("on_search", onSearch());

    const events = await container.services.record.readEvents(sessionId);
    const ack = events.find((event) => event.kind === "INBOUND_ACK");

    // The ACK is all the participant sees, so the journal is the only place
    // this can be said — and for an inbound call the model was not parked on,
    // the journal is its only channel.
    expect(ack?.summary).toContain("Protocol validation did not run");
  });

  it("does not throw the callback away when the check itself breaks", async () => {
    await sendSearch();
    validation.setThrows(new Error("gateway exploded"));

    const response = await callback("on_search", onSearch());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: { ack: { status: "ACK" } } });
  });
});
