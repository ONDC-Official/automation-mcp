import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHttpApp, type App } from "@/app.js";
import { parseConfig } from "@/config/env.js";
import { createContainer, type Container } from "@/container.js";
import { readSubmissionId } from "@/modules/forms/forms.service.js";
import type { Session } from "@/modules/session/session.schema.js";
import {
  createFakeConfigServiceGateway,
  createFakeValidationGateway,
} from "@/test/fakes.js";
import {
  acceptsAction,
  counterpartyContext,
  receiverPath,
  requestBody,
} from "@/test/mock-participant.js";
import {
  RUNNABLE_BUILD,
  RUNNABLE_FORM_FLOW_ID,
} from "@/test/runnable-config.js";

/**
 * Forms, both directions, through the real HTTP stack.
 *
 * The two halves are genuinely different problems and both are exercised here:
 * a page the participant serves (fetch, screen, parse, fill, post) and a page
 * this mock serves (render the config's own template, take the submission, mint
 * an id, advance). The only thing stubbed is the socket.
 */

const NP = "https://np.example.com";
const config = parseConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });

const PARTICIPANT_FORM = `<!DOCTYPE html>
<html><head><title>KYC</title></head><body>
  <form id="kyc" method="POST" action="/kyc/submit">
    <label for="pan">PAN number</label>
    <input type="text" id="pan" name="pan" required />
    <input type="hidden" name="ref" value="abc" />
    <input type="submit" value="Go" />
  </form>
</body></html>`;

let app: App;
let container: Container;
let agent: MockAgent;
let sessionId: string;
let session: Session;
let transactionId: string;

async function boot(interactionMode: "llm_auto" | "manual" = "llm_auto") {
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
    interaction_mode: interactionMode,
  });
  sessionId = created.session.session_id;
  session = created.session;

  acceptsAction(agent, NP, "search");
  acceptsAction(agent, NP, "select");

  await container.services.flow.start({
    sessionId,
    flowId: RUNNABLE_FORM_FLOW_ID,
  });
  // Unassigned until a payload crosses: this mock is the BAP here, so sending
  // `search` in `reachFormStep` is what mints it.
  transactionId = "";
}

afterEach(async () => {
  // Guarded: the pure-function suite at the bottom never boots anything, and
  // closing a disposed agent throws.
  if (!container) return;
  await app.close();
  await container.dispose();
  await agent.close();
  container = undefined as unknown as Container;
});

function callbackFor(
  action: string,
  message: Record<string, unknown>,
): Record<string, unknown> {
  return {
    context: counterpartyContext(session, NP, {
      transactionId,
      action,
      messageId: `msg-${action}`,
    }),
    message,
  };
}

function post(action: string, body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: receiverPath(session, action),
    headers: { "content-type": "application/json" },
    payload: body,
  });
}

/**
 * Drive the flow to its form step, with the participant having advertised a
 * form URL along the way.
 */
async function reachFormStep(): Promise<void> {
  // Named by flow: sending this first action is what mints the transaction.
  const sent = await container.services.flow.proceed({
    sessionId,
    flowId: RUNNABLE_FORM_FLOW_ID,
  });
  transactionId = sent.transaction_id as string;
  await post(
    "on_search",
    callbackFor("on_search", {
      catalog: { providers: [{ id: "provider-1" }] },
    }),
  );
  await container.services.flow.proceed({
    sessionId,
    transactionId,
    inputs: { loan_amount: 1_000 },
  });
  await post("on_select", callbackFor("on_select", { order: { id: "o-1" } }));

  // The participant's form URL normally arrives in a payload; the fixture
  // config has no saveData for it, so it is placed directly.
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

function servesForm(): void {
  agent
    .get(NP)
    .intercept({ path: "/kyc/form", method: "GET" })
    .reply(200, PARTICIPANT_FORM, {
      headers: { "content-type": "text/html" },
    })
    .persist();
}

describe("a form the participant hosts", () => {
  beforeEach(async () => {
    await boot("llm_auto");
  });

  it("fetches, screens and parses its fields", async () => {
    servesForm();
    await reachFormStep();

    const form = await container.services.forms.fetchForm(
      sessionId,
      transactionId,
    );

    expect(form).toMatchObject({
      step_key: "kyc_form",
      mode: "llm_auto",
      role: "fill",
      method: "POST",
    });
    // The action was relative in the page; by the time we submit, the page's
    // own URL is gone — so it had to be resolved at fetch time.
    expect(form.action_url).toBe(`${NP}/kyc/submit`);
    expect(form.fields.map((field) => field.name)).toEqual(["pan", "ref"]);
    expect(form.fields[0]).toMatchObject({
      label: "PAN number",
      required: true,
    });
  });

  it("posts the filled fields and advances the flow", async () => {
    servesForm();
    let submitted = "";
    agent
      .get(NP)
      .intercept({ path: "/kyc/submit", method: "POST" })
      .reply(200, (options) => {
        submitted = requestBody(options);
        return { success: true, submission_id: "sub-from-np" };
      });
    await reachFormStep();

    const result = await container.services.forms.submitForm({
      sessionId,
      transactionId,
      fields: { pan: "ABCDE1234F", ref: "abc" },
    });

    expect(submitted).toBe("pan=ABCDE1234F&ref=abc");
    expect(result.submission_id).toBe("sub-from-np");

    // The id has to land where the *next* step's generator looks for it.
    const data = await container.services.record.getBusinessData(
      transactionId,
      NP,
    );
    expect(data["kyc_form"]).toBe("sub-from-np");

    const status = await container.services.flow.status(sessionId, {
      transactionId,
    });
    expect(status.sequence.at(-1)).toMatchObject({
      key: "kyc_form",
      status: "COMPLETE",
    });
  });

  it("refuses a page carrying active content", async () => {
    // Refused rather than sanitised: this is about to be filled with test data
    // and, in manual mode, shown to a person.
    agent
      .get(NP)
      .intercept({ path: "/kyc/form", method: "GET" })
      .reply(200, `<form action="/s"><script>steal()</script></form>`);
    await reachFormStep();

    await expect(
      container.services.forms.fetchForm(sessionId, transactionId),
    ).rejects.toThrow(/refused/);
  });

  it("refuses to invent an id when the answer carries none", async () => {
    servesForm();
    agent
      .get(NP)
      .intercept({ path: "/kyc/submit", method: "POST" })
      .reply(200, { ok: "thanks" });
    await reachFormStep();

    // Proceeding on a made-up id would let the flow advance on a fiction.
    await expect(
      container.services.forms.submitForm({
        sessionId,
        transactionId,
        fields: { pan: "X" },
      }),
    ).rejects.toThrow(/no recognisable submission id/);
  });

  it("reports an unreachable form page as an upstream failure", async () => {
    agent
      .get(NP)
      .intercept({ path: "/kyc/form", method: "GET" })
      .reply(503, "down");
    await reachFormStep();

    await expect(
      container.services.forms.fetchForm(sessionId, transactionId),
    ).rejects.toThrow(/503/);
  });
});

describe("manual mode", () => {
  beforeEach(async () => {
    await boot("manual");
  });

  it("hands back a link instead of fields", async () => {
    await reachFormStep();

    const form = await container.services.forms.fetchForm(
      sessionId,
      transactionId,
    );

    expect(form).toMatchObject({ mode: "manual", role: "fill" });
    expect(form.form_url).toBe(`${NP}/kyc/form`);
    expect(form.fields).toEqual([]);
    expect(form.instructions).toContain("manual mode");
  });

  it("accepts the id a human was given and advances the flow", async () => {
    await reachFormStep();

    const result = await container.services.forms.submitForm({
      sessionId,
      transactionId,
      submissionId: "human-sub-1",
    });

    expect(result.submission_id).toBe("human-sub-1");
    expect(result.outcome.outcome).toBe("SENT");
  });

  it("insists on an id rather than posting the form itself", async () => {
    await reachFormStep();

    await expect(
      container.services.forms.submitForm({
        sessionId,
        transactionId,
        fields: { pan: "X" },
      }),
    ).rejects.toThrow(/manual mode/);
  });
});

describe("a form this mock hosts", () => {
  beforeEach(async () => {
    // Mock plays BAP against a BPP; flip it so the form step (owned by BPP) is
    // ours to serve.
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
      np_type: "BAP",
      domain: RUNNABLE_BUILD.domain,
      version: RUNNABLE_BUILD.version,
      usecase: RUNNABLE_BUILD.usecase,
    });
    sessionId = created.session.session_id;
    session = created.session;

    acceptsAction(agent, NP, "on_search");
    acceptsAction(agent, NP, "on_select");

    await container.services.flow.start({
      sessionId,
      flowId: RUNNABLE_FORM_FLOW_ID,
    });
    // The participant is the buyer here, so it sends `search` and the
    // transaction id is its to choose. We pick it for the fixture and the
    // receiver adopts it.
    transactionId = "np-chosen-form-txn";
  });

  /** Drive to the form step with the participant playing the buyer. */
  async function reachHostedForm(): Promise<void> {
    await post(
      "search",
      callbackFor("search", { intent: { descriptor: { name: "loan" } } }),
    );
    await container.services.flow.proceed({ sessionId, transactionId });
    await post("select", callbackFor("select", { order: {} }));
    await container.services.flow.proceed({ sessionId, transactionId });
  }

  it("serves the config's own form template at the URL it advertised", async () => {
    await reachHostedForm();

    const response = await app.inject({
      method: "GET",
      url: `/forms/${RUNNABLE_BUILD.domain}/kyc_form/?transaction_id=${transactionId}&session_id=${sessionId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    // The template's `<%= actionUrl %>` must have been rendered, not emitted.
    expect(response.body).toContain("/submit?transaction_id=");
    expect(response.body).not.toContain("actionUrl");
    expect(response.body).toContain('name="pan"');
  });

  it("takes a submission, mints an id, and advances the flow", async () => {
    await reachHostedForm();

    const response = await app.inject({
      method: "POST",
      url: `/forms/${RUNNABLE_BUILD.domain}/kyc_form/submit?transaction_id=${transactionId}&session_id=${sessionId}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "pan=ABCDE1234F",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ success: boolean; submission_id: string }>();
    expect(body.success).toBe(true);
    expect(body.submission_id).toHaveLength(36);

    const status = await container.services.flow.status(sessionId, {
      transactionId,
    });
    expect(status.sequence.at(-1)).toMatchObject({
      key: "kyc_form",
      status: "COMPLETE",
    });

    // What the participant typed is kept, keyed by form — a later step may
    // need to quote it back.
    const data = await container.services.record.getBusinessData(
      transactionId,
      NP,
    );
    expect(data["formData"]).toMatchObject({
      kyc_form: { pan: "ABCDE1234F" },
    });
  });

  it("serves a browser an HTML confirmation instead of JSON", async () => {
    await reachHostedForm();

    const response = await app.inject({
      method: "POST",
      url: `/forms/${RUNNABLE_BUILD.domain}/kyc_form/submit?transaction_id=${transactionId}&session_id=${sessionId}`,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
      },
      payload: "pan=X",
    });

    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Form submitted");
  });

  it("tells form_fetch there is nothing to fetch", async () => {
    await reachHostedForm();

    const form = await container.services.forms.fetchForm(
      sessionId,
      transactionId,
    );

    expect(form).toMatchObject({ role: "host" });
    expect(form.form_url).toContain(
      `/forms/${RUNNABLE_BUILD.domain}/kyc_form/`,
    );
    expect(form.instructions).toContain("flow_await");
  });

  it("answers a 404 page for a step with no published form", async () => {
    await reachHostedForm();

    const response = await app.inject({
      method: "GET",
      url: `/forms/${RUNNABLE_BUILD.domain}/not_a_form/?transaction_id=${transactionId}&session_id=${sessionId}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toContain("No form is published");
  });
});

describe("readSubmissionId", () => {
  it.each([
    [{ submission_id: "a" }, "a"],
    [{ submissionId: "b" }, "b"],
    [{ form_submission_id: "c" }, "c"],
    [{ data: { submission_id: "d" } }, "d"],
    [{ message: { submissionId: "e" } }, "e"],
    [{ ok: true }, undefined],
    ["text", undefined],
    [null, undefined],
  ])("%j → %s", (body, expected) => {
    expect(readSubmissionId(body)).toBe(expected);
  });
});
