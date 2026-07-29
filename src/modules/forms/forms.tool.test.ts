import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHttpApp, type App } from "@/app.js";
import { parseConfig } from "@/config/env.js";
import { createContainer, type Container } from "@/container.js";
import { buildMcpServer } from "@/mcp/server.js";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  createFakeConfigServiceGateway,
  createFakeValidationGateway,
} from "@/test/fakes.js";
import type { Session } from "@/modules/session/session.schema.js";
import {
  acceptsAction,
  counterpartyContext,
  receiverPath,
} from "@/test/mock-participant.js";
import {
  RUNNABLE_BUILD,
  RUNNABLE_FORM_FLOW_ID,
} from "@/test/runnable-config.js";

/**
 * The form tools as a model sees them.
 *
 * `forms.service.test.ts` covers the mechanics; this covers the surface — the
 * text block a model actually reads, which is what decides whether it fills the
 * form correctly or guesses.
 */

const NP = "https://np.example.com";
const config = parseConfig({
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  // The clamp is what is under test, not its production value — a real
  // five-minute wait would make this suite unusable.
  AWAIT_MAX_WAIT_MS: "300",
});

const FORM_HTML = `<!DOCTYPE html><html><body>
  <form method="POST" action="/kyc/submit">
    <label for="pan">PAN number</label>
    <input type="text" id="pan" name="pan" required />
    <label for="employment">Employment</label>
    <select id="employment" name="employment">
      <option value="salaried">Salaried</option>
      <option value="self">Self employed</option>
    </select>
    <input type="hidden" name="ref" value="abc" />
    <input type="submit" value="Go" />
  </form>
</body></html>`;

let app: App;
let container: Container;
let client: Client;
let agent: MockAgent;
let sessionId: string;
let session: Session;
let transactionId: string;

beforeEach(async () => {
  agent = new MockAgent();
  agent.disableNetConnect();
  container = await createContainer(config, {
    configServiceGateway: createFakeConfigServiceGateway(),
    validationGateway: createFakeValidationGateway(),
    senderDispatcher: agent,
  });
  app = await buildHttpApp(container, config);
  await app.ready();

  // A real MCP client over the same container the HTTP app is using, so the
  // tools and the receiver routes share one set of state.
  const server = buildMcpServer(container);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const created = await container.services.session.createSession({
    subscriber_url: NP,
    np_type: "BPP",
    domain: RUNNABLE_BUILD.domain,
    version: RUNNABLE_BUILD.version,
    usecase: RUNNABLE_BUILD.usecase,
  });
  sessionId = created.session.session_id;
  session = created.session;

  acceptsAction(agent, NP, "search");
  acceptsAction(agent, NP, "select");
  agent
    .get(NP)
    .intercept({ path: "/kyc/form", method: "GET" })
    .reply(200, FORM_HTML)
    .persist();

  await container.services.flow.start({
    sessionId,
    flowId: RUNNABLE_FORM_FLOW_ID,
  });
  // Unassigned until a payload crosses: this mock sends the flow's first
  // action, so `reachFormStep` is what mints it.
  transactionId = "";
});

afterEach(async () => {
  await client.close();
  await app.close();
  await container.dispose();
  await agent.close();
});

function post(action: string, message: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: receiverPath(session, action),
    headers: { "content-type": "application/json" },
    payload: {
      context: counterpartyContext(session, NP, {
        transactionId,
        action,
        messageId: `msg-${action}`,
      }),
      message,
    },
  });
}

/**
 * Send the flow's first action.
 *
 * Named by flow rather than by transaction, because this call is what mints
 * the transaction id — before it there is nothing to name.
 */
async function sendFirstAction(): Promise<void> {
  const sent = await container.services.flow.proceed({
    sessionId,
    flowId: RUNNABLE_FORM_FLOW_ID,
  });
  transactionId = sent.transaction_id as string;
}

async function reachFormStep(): Promise<void> {
  await sendFirstAction();
  await post("on_search", { catalog: { providers: [{ id: "provider-1" }] } });
  await container.services.flow.proceed({
    sessionId,
    transactionId,
    inputs: { loan_amount: 1_000 },
  });
  await post("on_select", { order: { id: "o-1" } });

  const data = await container.services.record.getBusinessData(
    transactionId,
    NP,
  );
  data["kyc_form"] = `${NP}/kyc/form`;
  await container.services.record.overwriteBusinessData(
    transactionId,
    NP,
    data,
  );
}

function textOf(result: { content: unknown }): string {
  return (result.content as { text: string }[])[0]?.text ?? "";
}

describe("form_fetch over MCP", () => {
  it("renders the fields legibly enough to fill without guessing", async () => {
    await reachFormStep();

    const result = await client.callTool({
      name: "form_fetch",
      arguments: { session_id: sessionId, transaction_id: transactionId },
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("hosted by the participant");
    expect(text).toContain("pan (text) — PAN number [required]");
    // A select's allowed values have to be visible, or the model invents one.
    expect(text).toContain("one of: salaried, self");
    expect(text).toContain('prefilled "abc"');
    expect(text).toContain(`${NP}/kyc/submit`);
  });

  it("reports a refused page as a tool error the model can read", async () => {
    await reachFormStep();
    const data = await container.services.record.getBusinessData(
      transactionId,
      NP,
    );
    data["kyc_form"] = `${NP}/hostile`;
    await container.services.record.overwriteBusinessData(
      transactionId,
      NP,
      data,
    );
    agent
      .get(NP)
      .intercept({ path: "/hostile", method: "GET" })
      .reply(200, `<form action="/s"><script>x()</script></form>`);

    const result = await client.callTool({
      name: "form_fetch",
      arguments: { session_id: sessionId, transaction_id: transactionId },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "validation_error" },
    });
  });

  it("rejects a step_key that is not a form", async () => {
    await reachFormStep();

    const result = await client.callTool({
      name: "form_fetch",
      arguments: {
        session_id: sessionId,
        transaction_id: transactionId,
        step_key: "search_1",
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not a form");
  });
});

describe("form_submit over MCP", () => {
  it("submits and reports where the flow now stands", async () => {
    agent
      .get(NP)
      .intercept({ path: "/kyc/submit", method: "POST" })
      .reply(200, { success: true, submission_id: "sub-1" });
    await reachFormStep();

    const result = await client.callTool({
      name: "form_submit",
      arguments: {
        session_id: sessionId,
        transaction_id: transactionId,
        fields: { pan: "ABCDE1234F", employment: "salaried", ref: "abc" },
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      step_key: "kyc_form",
      submission_id: "sub-1",
    });

    const text = textOf(result);
    expect(text).toContain("submission_id sub-1");
    // The outcome is appended so the model knows what to do next without a
    // second call.
    expect(text).toMatch(/\[(SENT|COMPLETE|WAITING|READY)\]/);
  });
});

describe("flow_await over MCP", () => {
  it("caps the wait and reports a timeout without erroring", async () => {
    await sendFirstAction();

    const started = Date.now();
    const result = await client.callTool({
      name: "flow_await",
      arguments: {
        session_id: sessionId,
        transaction_id: transactionId,
        after_seq: 1,
        // Far above the configured cap. Honouring it would outlive the
        // caller's own timeout, and it would never learn whether anything
        // arrived.
        timeout_ms: 900_000,
      },
    });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ timed_out: true });
    expect(textOf(result)).toContain("call flow_await again");
  }, 20_000);

  it("reports progress while parked, so the client does not time out first", async () => {
    // The wait is now measured in minutes, which is longer than most clients
    // will hold a tool call open unless the server keeps telling them it is
    // still working. A client that asked for progress must get some.
    await sendFirstAction();

    const progress: number[] = [];
    const result = await client.callTool(
      {
        name: "flow_await",
        arguments: {
          session_id: sessionId,
          transaction_id: transactionId,
          after_seq: 1,
        },
      },
      {
        onprogress: (update) => {
          progress.push(update.progress);
        },
      },
    );

    expect(result.structuredContent).toMatchObject({ timed_out: true });
    expect(progress.length).toBeGreaterThan(0);
  }, 20_000);

  it("reports an event that already arrived, with what to do next", async () => {
    await sendFirstAction();
    await post("on_search", { catalog: { providers: [{ id: "p1" }] } });

    const result = await client.callTool({
      name: "flow_await",
      arguments: {
        session_id: sessionId,
        transaction_id: transactionId,
        after_seq: 1,
      },
    });

    expect(result.structuredContent).toMatchObject({
      timed_out: false,
      event: { kind: "INBOUND", action: "on_search" },
    });
    const text = textOf(result);
    expect(text).toContain("INBOUND on_search");
    expect(text).toContain("[INPUT_REQUIRED]");
  });
});
