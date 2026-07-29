import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHttpApp, type App } from "@/app.js";
import { parseConfig } from "@/config/env.js";
import { createContainer, type Container } from "@/container.js";
import { createFakeConfigServiceGateway } from "@/test/fakes.js";
import type { Session } from "@/modules/session/session.schema.js";
import {
  acceptsAction,
  counterpartyContext,
  receiverPath,
} from "@/test/mock-participant.js";
import { RUNNABLE_BUILD, RUNNABLE_FLOW_ID } from "@/test/runnable-config.js";

/**
 * The loop, end to end, against a scripted participant.
 *
 * Both directions are real: outbound calls go through undici (socket
 * intercepted), inbound callbacks arrive through the actual Fastify routes via
 * `app.inject()`. Payloads are produced by the mock config's own JavaScript in a
 * worker thread. What is *not* real is the participant's judgement — it ACKs
 * and calls back on cue, which is exactly the variable a loop test wants held
 * still.
 *
 * The behaviour under test is the alternation itself: proceed → await →
 * proceed, with the flow's state re-derived each time from what was recorded
 * rather than from a pointer anyone had to remember to update.
 */

const NP = "https://np.example.com";
const config = parseConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });

let app: App;
let container: Container;
let agent: MockAgent;
let sessionId: string;
let session: Session;
let transactionId: string;

beforeEach(async () => {
  agent = new MockAgent();
  agent.disableNetConnect();
  container = await createContainer(config, {
    configServiceGateway: createFakeConfigServiceGateway(),
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
  session = created.session;
});

afterEach(async () => {
  await app.close();
  await container.dispose();
  await agent.close();
});

async function start(autoAdvance = false): Promise<void> {
  const started = await container.services.flow.start({
    sessionId,
    flowId: RUNNABLE_FLOW_ID,
    autoAdvance,
  });
  transactionId = started.runtime.record.transactionId;
}

function callbackFor(
  action: string,
  message: Record<string, unknown>,
  offsetMs: number,
): Record<string, unknown> {
  return {
    context: counterpartyContext(session, NP, {
      transactionId,
      action,
      messageId: `msg-${action}`,
      timestampOffsetMs: offsetMs,
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

const CATALOG = {
  catalog: { providers: [{ id: "provider-1", descriptor: { name: "Bank" } }] },
};

describe("the flow loop", () => {
  it("completes a full request/callback transaction", async () => {
    acceptsAction(agent, NP, "search");
    acceptsAction(agent, NP, "select");
    await start();

    // 1. Our move: search.
    const search = await container.services.flow.proceed({
      sessionId,
      transactionId,
    });
    expect(search).toMatchObject({ outcome: "SENT", ack: "ACK" });

    // 2. Their move.
    await post("on_search", callbackFor("on_search", CATALOG, 1_000));

    // 3. Ours again, once they have supplied a provider.
    const select = await container.services.flow.proceed({
      sessionId,
      transactionId,
      inputs: { loan_amount: 50_000 },
    });
    expect(select).toMatchObject({ outcome: "SENT", action: "select" });

    // 4. Theirs.
    await post(
      "on_select",
      callbackFor("on_select", { order: { id: "order-1" } }, 3_000),
    );

    const status = await container.services.flow.status(
      sessionId,
      transactionId,
    );
    expect(status.flow_status).toBe("COMPLETE");
    expect(status.sequence.map((step) => step.status)).toEqual([
      "COMPLETE",
      "COMPLETE",
      "COMPLETE",
      "COMPLETE",
    ]);
    expect(status.next.outcome).toBe("COMPLETE");
    expect(status.missed_steps).toEqual([]);

    // Every exchange is on the record, with a readable payload behind each.
    const record = await container.services.record.requireTransaction(
      transactionId,
      NP,
    );
    expect(record.apiList.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    expect(
      record.apiList.map((entry) =>
        entry.entryType === "API" ? entry.action : entry.formType,
      ),
    ).toEqual(["search", "on_search", "select", "on_select"]);

    // And the values carried between steps really were carried.
    const data = await container.services.record.getBusinessData(
      transactionId,
      NP,
    );
    expect(data["providerId"]).toEqual(["provider-1"]);
    expect(data["orderId"]).toEqual(["order-1"]);
  });
});

describe("flow_await", () => {
  it("returns immediately for something already recorded", async () => {
    // The race the read-first ordering exists to close: the callback landed
    // before anyone started waiting for it, and must not be missed.
    acceptsAction(agent, NP, "search");
    await start();
    await container.services.flow.proceed({ sessionId, transactionId });
    await post("on_search", callbackFor("on_search", CATALOG, 1_000));

    const result = await container.services.flow.awaitEvent({
      sessionId,
      transactionId,
      afterSeq: 1,
      timeoutMs: 50,
    });

    expect(result.timedOut).toBe(false);
    expect(result.event).toMatchObject({
      kind: "INBOUND",
      action: "on_search",
    });
    expect(result.seq).toBe(2);
  });

  it("blocks, then wakes when the participant calls back", async () => {
    acceptsAction(agent, NP, "search");
    await start();
    await container.services.flow.proceed({ sessionId, transactionId });

    const waiting = container.services.flow.awaitEvent({
      sessionId,
      transactionId,
      afterSeq: 1,
      timeoutMs: 5_000,
    });

    // Arrives while the wait is parked.
    setTimeout(() => {
      void post("on_search", callbackFor("on_search", CATALOG, 1_000));
    }, 20);

    const result = await waiting;
    expect(result.timedOut).toBe(false);
    expect(result.event).toMatchObject({ action: "on_search" });
    // `next` is computed after the wake, so it reflects the new state.
    expect(result.next.outcome).toBe("INPUT_REQUIRED");
  });

  it("times out without error so the caller can long-poll", async () => {
    acceptsAction(agent, NP, "search");
    await start();
    await container.services.flow.proceed({ sessionId, transactionId });

    const result = await container.services.flow.awaitEvent({
      sessionId,
      transactionId,
      afterSeq: 1,
      timeoutMs: 60,
    });

    expect(result.timedOut).toBe(true);
    expect(result.event).toBeUndefined();
    expect(result.seq).toBe(1);
    expect(result.next.outcome).toBe("WAITING");
  });

  it("does not re-report an event the caller has already seen", async () => {
    acceptsAction(agent, NP, "search");
    await start();
    await container.services.flow.proceed({ sessionId, transactionId });
    await post("on_search", callbackFor("on_search", CATALOG, 1_000));

    const seen = await container.services.flow.awaitEvent({
      sessionId,
      transactionId,
      afterSeq: 1,
      timeoutMs: 50,
    });
    const again = await container.services.flow.awaitEvent({
      sessionId,
      transactionId,
      afterSeq: seen.seq,
      timeoutMs: 60,
    });

    expect(again.timedOut).toBe(true);
  });
});

describe("auto-advance", () => {
  it("chains this mock's own next step once the participant answers", async () => {
    // With auto_advance on, the receiver fires `select` itself after ACKing
    // `on_search` — the caller never has to ask.
    const sent = acceptsAction(agent, NP, "select");
    acceptsAction(agent, NP, "search");
    await start(true);

    await container.services.flow.proceed({ sessionId, transactionId });
    await post("on_search", callbackFor("on_search", CATALOG, 1_000));

    // `select_1` declares an input, so the chain should pause rather than
    // guess a value.
    await settle();
    expect(sent.seen).toHaveLength(0);

    const record = await container.services.record.requireTransaction(
      transactionId,
      NP,
    );
    expect(record.attention).toMatchObject({
      kind: "INPUT_REQUIRED",
      step_key: "select_1",
    });
  });

  it("keeps the ACK off the chain's critical path", async () => {
    acceptsAction(agent, NP, "search");
    await start(true);
    await container.services.flow.proceed({ sessionId, transactionId });

    const response = await post(
      "on_search",
      callbackFor("on_search", CATALOG, 1_000),
    );

    // The participant is answered before any of our own sending begins.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: { ack: { status: "ACK" } } });
    await settle();
  });
});

/** Let the receiver's post-ACK `setImmediate` chain run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
