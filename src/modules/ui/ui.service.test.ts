import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "@/config/env.js";
import { createContainer, type Container } from "@/container.js";
import {
  createFakeConfigServiceGateway,
  createFakeValidationGateway,
} from "@/test/fakes.js";
import { acceptsAction } from "@/test/mock-participant.js";
import { RUNNABLE_BUILD, RUNNABLE_FLOW_ID } from "@/test/runnable-config.js";
import { UiService } from "@/modules/ui/ui.service.js";

/**
 * The viewer's read model, against a run that actually happened.
 *
 * Two properties matter more than the field-by-field shape, and both are
 * invisible when they break:
 *
 * 1. The viewer and `flow_get_status` must not disagree about a run. They are
 *    two renderings of one read, and a second implementation of the status
 *    derivation would drift without anybody noticing which of them was wrong.
 * 2. Reading the viewer must not consume the model's events. The symptom of
 *    getting that wrong is a model that stops being told about callbacks while
 *    a human watches them arrive on screen — a failure nobody would attribute
 *    to a page.
 */

const NP = "https://np.example.com";
const config = parseConfig({
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  UI_TOKEN: "test-viewer-token",
});

let container: Container;
let agent: MockAgent;
let sessionId: string;

beforeEach(async () => {
  agent = new MockAgent();
  agent.disableNetConnect();
  container = await createContainer(config, {
    configServiceGateway: createFakeConfigServiceGateway(),
    validationGateway: createFakeValidationGateway(),
    senderDispatcher: agent,
  });

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
  await agent.close();
});

/** Open the run and put its first action on the wire, so there is history. */
async function runOneStep(): Promise<void> {
  acceptsAction(agent, NP, "search");
  await container.services.flow.start({
    sessionId,
    flowId: RUNNABLE_FLOW_ID,
    autoAdvance: false,
  });
  await container.services.flow.proceed({
    sessionId,
    flowId: RUNNABLE_FLOW_ID,
  });
}

describe("the viewer and flow_get_status", () => {
  it("agree about a run that has not started", async () => {
    await container.services.flow.start({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      autoAdvance: false,
    });

    const view = await container.ui.flow(sessionId, RUNNABLE_FLOW_ID);
    const status = await container.services.flow.status(sessionId, {
      flowId: RUNNABLE_FLOW_ID,
    });

    expect(view.flow_status).toBe(status.flow_status);
    expect(view.transaction_id).toBe(status.transaction_id);
    expect(view.seq).toBe(status.seq);
    expect(view.map.sequence).toHaveLength(status.sequence.length);
    expect(view.map.sequence.map((step) => step.status)).toEqual(
      status.sequence.map((step) => step.status),
    );
  });

  it("agree after a step has crossed the wire", async () => {
    await runOneStep();

    const view = await container.ui.flow(sessionId, RUNNABLE_FLOW_ID);
    const status = await container.services.flow.status(sessionId, {
      flowId: RUNNABLE_FLOW_ID,
    });

    expect(view.flow_status).toBe("IN_PROGRESS");
    expect(view.flow_status).toBe(status.flow_status);
    expect(view.transaction_id).toBe(status.transaction_id);
    expect(view.transaction_id).not.toBeNull();
    expect(view.map.sequence.map((step) => step.status)).toEqual(
      status.sequence.map((step) => step.status),
    );
    // Handles, on both sides, for the step that went out.
    expect(view.map.sequence[0]?.payloads).toBeDefined();
  });

  it("narrows `next` rather than passing the whole outcome through", async () => {
    await runOneStep();

    const view = await container.ui.flow(sessionId, RUNNABLE_FLOW_ID);

    // `StepOutcome` carries `ack_body` — a payload body arriving through a
    // route that does not say it serves one.
    expect(view.next).not.toHaveProperty("ack_body");
    expect(view.next.outcome).toBeTruthy();
  });
});

describe("the model's event cursor", () => {
  it("is untouched by every read the viewer makes", async () => {
    await runOneStep();

    const before = await container.services.record.eventCursor(sessionId);

    await container.ui.listSessions();
    await container.ui.session(sessionId);
    await container.ui.flow(sessionId, RUNNABLE_FLOW_ID);
    await container.ui.events(sessionId, 0);

    expect(await container.services.record.eventCursor(sessionId)).toBe(before);
  });

  it("still delivers everything to the model afterwards", async () => {
    await runOneStep();
    await container.ui.events(sessionId, 0);

    // The drain is the model's, and it must still see the whole backlog.
    const delta = await container.services.record.drainEvents(sessionId);

    expect(delta?.events.length).toBeGreaterThan(0);
  });
});

describe("session and payload reads", () => {
  it("lists every run, including one with no transaction yet", async () => {
    await container.services.flow.start({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      autoAdvance: false,
    });

    const body = await container.ui.session(sessionId);

    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      flow_id: RUNNABLE_FLOW_ID,
      transaction_id: null,
      steps_complete: 0,
    });
    expect(body.transaction_ids).toEqual([]);
  });

  it("serves a payload in the shape the page's step card already reads", async () => {
    await runOneStep();

    const view = await container.ui.flow(sessionId, RUNNABLE_FLOW_ID);
    const entry = view.map.sequence[0]?.payloads;
    const payloadId =
      entry?.entryType === "API" ? entry.payloads[0]?.payloadId : undefined;
    expect(payloadId).toBeDefined();

    const payload = await container.ui.payload(sessionId, payloadId ?? "");

    // `{req, res: {response}}` is the workbench's `PayloadResponse`, and
    // matching it is why the existing card needs no new branch.
    expect(payload.req).toMatchObject({ context: { action: "search" } });
    expect(payload.res.response).toMatchObject({
      message: { ack: { status: "ACK" } },
    });
    expect(payload.direction).toBe("outbound");
  });

  it("refuses a payload handle under a session that does not exist", async () => {
    await runOneStep();

    const view = await container.ui.flow(sessionId, RUNNABLE_FLOW_ID);
    const entry = view.map.sequence[0]?.payloads;
    const payloadId =
      entry?.entryType === "API" ? entry.payloads[0]?.payloadId : undefined;

    // The session read is the authorisation check — a handle is a bare uuid
    // and carries no session of its own.
    await expect(
      container.ui.payload("no-such-session", payloadId ?? ""),
    ).rejects.toThrow(/session/i);
  });
});

describe("one unreadable run", () => {
  it("is reported on its own row rather than blanking the list", async () => {
    // A run whose config the catalog can no longer serve — a flow withdrawn
    // upstream, most often. Stubbed rather than staged, because the point is
    // the *handling*: the other runs are exactly what somebody opening this
    // page is trying to see, and one of them failing must not cost them all.
    const service = new UiService({
      sessions: container.services.session,
      catalog: container.services.catalog,
      records: container.services.record,
      logger: container.logger,
      flows: {
        listRuns: () =>
          Promise.resolve([
            {
              sessionId,
              flowId: "Withdrawn_Flow",
              attempt: 1,
              startedAt: new Date().toISOString(),
              autoAdvance: false,
              previousAttempts: [],
            },
          ]),
        flowView: () => Promise.reject(new Error("no such flow")),
      } as unknown as (typeof container.services)["flow"],
    });

    const body = await service.session(sessionId);

    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      flow_id: "Withdrawn_Flow",
      error: "no such flow",
    });
    // The header still rendered, which is the whole point.
    expect(body.session.session_id).toBe(sessionId);
  });
});
