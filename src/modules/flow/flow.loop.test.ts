import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHttpApp, type App } from "@/app.js";
import { NotFoundError } from "@/lib/errors.js";
import { parseConfig } from "@/config/env.js";
import { createContainer, type Container } from "@/container.js";
import {
  createFakeConfigServiceGateway,
  createFakeValidationGateway,
  invalidFrom,
  type FakeValidationGateway,
} from "@/test/fakes.js";
import { L1_MULTI_RULE } from "@/test/validation-fixtures.js";
import type { StepOutcome } from "@/modules/flow/flow.schema.js";
import type { Session } from "@/modules/session/session.schema.js";
import {
  acceptsAction,
  acceptsActionAndCallsBack,
  counterpartyContext,
  receiverPath,
} from "@/test/mock-participant.js";
import { NoopMirrorSink } from "@/modules/mirror/mirror.sink.js";
import {
  RUNNABLE_BUILD,
  RUNNABLE_CHAIN_FLOW_ID,
  RUNNABLE_FLOW_ID,
} from "@/test/runnable-config.js";

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
let validation: FakeValidationGateway;
let sessionId: string;
let session: Session;
let transactionId: string;

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
  // A run that has put nothing on the wire has no transaction id — this mock
  // sends `search`, and doing so is what mints one.
  expect(started.runtime.bound).toBe(false);
  transactionId = "";
}

/**
 * Send the flow's first action, and record the id it minted.
 *
 * Named by flow rather than by transaction, because before this call there is
 * no transaction to name.
 */
async function sendFirstAction(
  extra: { inputs?: Record<string, unknown> } = {},
): Promise<StepOutcome> {
  const sent = await container.services.flow.proceed({
    sessionId,
    flowId: RUNNABLE_FLOW_ID,
    ...extra,
  });
  if (sent.transaction_id !== undefined) transactionId = sent.transaction_id;
  return sent;
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
    const selectCall = acceptsAction(agent, NP, "select");
    await start();

    // 1. Our move: search.
    const search = await sendFirstAction();
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

    // The fixture's `select` generator rewrites context.transaction_id, the way
    // published configs do. The flow keeps one id, so what went out is ours.
    const sentSelect = selectCall.seen[0] as {
      context: Record<string, string>;
    };
    expect(sentSelect.context["transaction_id"]).toBe(transactionId);
    expect(sentSelect.context["transaction_id"]).not.toBe(
      "config-rewrote-this",
    );

    // 4. Theirs.
    await post(
      "on_select",
      callbackFor("on_select", { order: { id: "order-1" } }, 3_000),
    );

    const status = await container.services.flow.status(sessionId, {
      transactionId,
    });
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

  /**
   * Inputs nested under the declaration's name never reach the generator.
   *
   * `select`'s generator reads `sessionData.user_inputs?.loan_amount` flat,
   * and the fixture declares it the way TRV11 does — under a wrapper id
   * (`SelectInputId`) that reads exactly like a key to nest beneath. Left
   * unchecked, the nested shape generates an order with a null amount and puts
   * it on the wire; the participant's NACK, or an L1 finding at
   * `$.message.order.amount`, is then the first sign anything is wrong, and it
   * points at the config rather than at the input. That cost a real run.
   */
  it("refuses inputs nested under the declaration instead of sending them", async () => {
    acceptsAction(agent, NP, "search");
    const selectCall = acceptsAction(agent, NP, "select");
    await start();
    await sendFirstAction();
    await post("on_search", callbackFor("on_search", CATALOG, 1_000));

    const nested = await container.services.flow.proceed({
      sessionId,
      transactionId,
      inputs: { SelectInputId: { loan_amount: 50_000 } },
    });

    expect(nested).toMatchObject({
      outcome: "INPUT_REQUIRED",
      step_key: "select_1",
      input_problems: [{ code: "nested_under_declaration" }],
    });
    expect(nested.inputs_required?.fields.map((field) => field.name)).toEqual([
      "loan_amount",
    ]);

    // Nothing crossed the wire, and nothing was recorded — so the correction
    // costs the run nothing.
    expect(selectCall.seen).toHaveLength(0);
    const stalled = await container.services.record.requireTransaction(
      transactionId,
      NP,
    );
    expect(stalled.apiList).toHaveLength(2);

    // And the flat shape it asked for goes straight through.
    const flat = await container.services.flow.proceed({
      sessionId,
      transactionId,
      inputs: { loan_amount: 50_000 },
    });
    expect(flat).toMatchObject({ outcome: "SENT", action: "select" });
    expect(selectCall.seen).toHaveLength(1);
    expect(selectCall.seen[0]).toMatchObject({
      message: { order: { amount: 50_000 } },
    });
  });
});

describe("a callback that overtakes its own ACK", () => {
  /**
   * The participant answers our `select` *and* fires `on_select` from the same
   * handler, and the callback's forward leg beats the ACK's return leg.
   *
   * Observed live: an 18ms inversion produced a NACK `OUT_OF_SEQUENCE` against a
   * correct implementation. The two legs are independent connections, so no
   * ordering is guaranteed and a participant cannot fix this from its side — it
   * is ours to absorb, by recording the outbound step when we send it rather
   * than when it is answered.
   */
  it("is accepted, not NACKed as out of sequence", async () => {
    acceptsAction(agent, NP, "search");

    let callback: Awaited<ReturnType<typeof post>> | undefined;
    let stateWhenCallbackLanded: unknown = "never ran";

    acceptsActionAndCallsBack(agent, NP, "select", async () => {
      const mid = await container.services.record.requireTransaction(
        transactionId,
        NP,
      );
      const entry = mid.apiList.find(
        (e) => e.entryType === "API" && e.action === "select",
      );
      stateWhenCallbackLanded =
        entry === undefined
          ? "absent"
          : entry.entryType === "API"
            ? (entry.sendState ?? "settled")
            : "form";
      callback = await post(
        "on_select",
        callbackFor("on_select", { order: { id: "order-1" } }, 3_000),
      );
    });

    await start();
    await sendFirstAction();
    await post("on_search", callbackFor("on_search", CATALOG, 1_000));

    const select = await container.services.flow.proceed({
      sessionId,
      transactionId,
      inputs: { loan_amount: 50_000 },
    });
    expect(select).toMatchObject({ outcome: "SENT", action: "select" });

    // The inversion this test exists for, pinned rather than hoped for: the
    // callback was handled end to end while our own `select` was still
    // unanswered. Without this the test could go green by never racing at all.
    expect(stateWhenCallbackLanded).toBe("in_flight");

    // The whole point: a legal follow-up is ACKed even though it arrived while
    // our own `select` was still waiting for its answer.
    expect(callback?.statusCode).toBe(200);
    expect(callback?.json()).toMatchObject({
      message: { ack: { status: "ACK" } },
    });

    const status = await container.services.flow.status(sessionId, {
      transactionId,
    });
    expect(status.flow_status).toBe("COMPLETE");
    expect(status.missed_steps).toEqual([]);

    // And replay reads in the order things actually happened. `seq` is stamped
    // at dispatch, so `select` precedes the `on_select` that overtook its ACK —
    // stamped at ACK-return time it took the *higher* number and the engine
    // replayed the pair backwards.
    const record = await container.services.record.requireTransaction(
      transactionId,
      NP,
    );
    expect(
      record.apiList.map((entry) =>
        entry.entryType === "API" ? entry.action : entry.formType,
      ),
    ).toEqual(["search", "on_search", "select", "on_select"]);
    expect(record.apiList.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);

    // Settled, and holding the ACK the participant eventually sent back.
    const sent = record.apiList.find(
      (entry) => entry.entryType === "API" && entry.action === "select",
    );
    expect(sent?.entryType === "API" && sent.sendState).toBeUndefined();
    expect(sent?.entryType === "API" && sent.response).toMatchObject({
      message: { ack: { status: "ACK" } },
    });
  });
});

describe("a send that fails", () => {
  it("withdraws the entry when the connection never came up", async () => {
    acceptsAction(agent, NP, "search");
    await start();
    await sendFirstAction();
    await post("on_search", callbackFor("on_search", CATALOG, 1_000));

    agent
      .get(NP)
      .intercept({ path: "/select", method: "POST" })
      .replyWithError(
        Object.assign(new Error("connect refused"), {
          code: "ECONNREFUSED",
        }),
      );

    await expect(
      container.services.flow.proceed({
        sessionId,
        transactionId,
        inputs: { loan_amount: 50_000 },
      }),
    ).rejects.toThrow(/could not reach/);

    // Nothing crossed the wire, so the step is still owed and the record must
    // not claim otherwise.
    const record = await container.services.record.requireTransaction(
      transactionId,
      NP,
    );
    expect(
      record.apiList.map((entry) =>
        entry.entryType === "API" ? entry.action : entry.formType,
      ),
    ).toEqual(["search", "on_search"]);

    // `seq` keeps the gap rather than reissuing 3 — it is a cursor waiters hold,
    // not a count.
    expect(record.seq).toBe(3);

    // And the retry works, taking the next number.
    const retry = acceptsAction(agent, NP, "select");
    const select = await container.services.flow.proceed({
      sessionId,
      transactionId,
      inputs: { loan_amount: 50_000 },
    });
    expect(select).toMatchObject({ outcome: "SENT", action: "select" });
    expect(retry.seen).toHaveLength(1);
  });

  it("keeps the entry, marked failed, when delivery is uncertain", async () => {
    acceptsAction(agent, NP, "search");
    await start();
    await sendFirstAction();
    await post("on_search", callbackFor("on_search", CATALOG, 1_000));

    agent
      .get(NP)
      .intercept({ path: "/select", method: "POST" })
      .replyWithError(
        Object.assign(new Error("headers timeout"), {
          code: "UND_ERR_HEADERS_TIMEOUT",
        }),
      );

    await expect(
      container.services.flow.proceed({
        sessionId,
        transactionId,
        inputs: { loan_amount: 50_000 },
      }),
    ).rejects.toThrow(/could not reach/);

    // The request was written; the participant may well have processed it.
    // Withdrawing the entry would let the next proceed send a second one.
    const record = await container.services.record.requireTransaction(
      transactionId,
      NP,
    );
    const failed = record.apiList.at(-1);
    expect(failed?.entryType === "API" && failed.action).toBe("select");
    expect(failed?.entryType === "API" && failed.sendState).toBe("failed");
    expect(failed?.entryType === "API" && failed.sendError).toMatch(
      /headers timeout/,
    );
  });
});

describe("flow_await", () => {
  it("returns immediately for something already recorded", async () => {
    // The race the read-first ordering exists to close: the callback landed
    // before anyone started waiting for it, and must not be missed.
    acceptsAction(agent, NP, "search");
    await start();
    await sendFirstAction();
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
    await sendFirstAction();

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
    // `next` is computed after the wake, so it reflects the new state. Always
    // present in run scope — only a session-scope wait answers without one.
    expect(result.next?.outcome).toBe("INPUT_REQUIRED");
  });

  it("times out without error so the caller can long-poll", async () => {
    acceptsAction(agent, NP, "search");
    await start();
    await sendFirstAction();

    const result = await container.services.flow.awaitEvent({
      sessionId,
      transactionId,
      afterSeq: 1,
      timeoutMs: 60,
    });

    expect(result.timedOut).toBe(true);
    expect(result.event).toBeUndefined();
    expect(result.seq).toBe(1);
    expect(result.next?.outcome).toBe("WAITING");
  });

  it("does not re-report an event the caller has already seen", async () => {
    acceptsAction(agent, NP, "search");
    await start();
    await sendFirstAction();
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

    await sendFirstAction();
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
    await sendFirstAction();

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

describe("flow_restart", () => {
  it("opens a second attempt that shares nothing with the first", async () => {
    const searchCall = acceptsAction(agent, NP, "search");
    await start();

    // Attempt 1: get the run properly under way, then decide it went wrong.
    await sendFirstAction();
    await post("on_search", callbackFor("on_search", CATALOG, 1_000));
    const firstTxn = transactionId;

    const restarted = await container.services.flow.restart({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      reason: "wanted to try different inputs",
    });

    expect(restarted.attempt).toBe(2);
    expect(restarted.abandonedTransactionId).toBe(firstTxn);
    // Unbound again: the next action mints an id, exactly as a fresh run does.
    expect(restarted.runtime.bound).toBe(false);
    expect(restarted.outcome).toMatchObject({
      outcome: "READY",
      action: "search",
    });

    // Attempt 2 really is a different transaction on the wire.
    transactionId = "";
    const second = await sendFirstAction();
    expect(second.outcome).toBe("SENT");
    expect(transactionId).not.toBe(firstTxn);
    expect(searchCall.seen).toHaveLength(2);
    expect(
      (searchCall.seen[1] as { context: Record<string, string> }).context[
        "transaction_id"
      ],
    ).toBe(transactionId);

    // Attempt 2's state starts clean — `on_search` has not happened for it.
    const status = await container.services.flow.status(sessionId, {
      flowId: RUNNABLE_FLOW_ID,
    });
    expect(status.attempt).toBe(2);
    expect(status.transaction_id).toBe(transactionId);
    expect(status.sequence.map((step) => step.status)).toEqual([
      "COMPLETE",
      "LISTENING",
      "WAITING",
      "WAITING",
    ]);
  });

  it("keeps every payload the abandoned attempt recorded", async () => {
    // The reason a restart archives rather than deletes: a failed attempt is
    // the finding, and the report is made of exactly these payloads.
    acceptsAction(agent, NP, "search");
    await start();
    await sendFirstAction();
    await post("on_search", callbackFor("on_search", CATALOG, 1_000));
    const firstTxn = transactionId;

    await container.services.flow.restart({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      reason: "on_search came back empty",
    });

    const abandoned = await container.services.record.requireTransaction(
      firstTxn,
      NP,
    );
    expect(abandoned.abandoned).toMatchObject({
      attempt: 1,
      reason: "on_search came back empty",
    });
    expect(abandoned.apiList).toHaveLength(2);

    // And each body is still readable behind its handle.
    for (const entry of abandoned.apiList) {
      if (entry.entryType !== "API") continue;
      await expect(
        container.services.record.requirePayload(entry.payloadId),
      ).resolves.toMatchObject({ transactionId: firstTxn });
    }

    // Reading it still works, and says plainly that it has been written off.
    const status = await container.services.flow.status(sessionId, {
      transactionId: firstTxn,
    });
    expect(status.flow_status).toBe("BLOCKED");
    expect(status.abandoned).toMatchObject({ attempt: 1 });
    expect(status.next).toMatchObject({ reason: "attempt_abandoned" });
  });

  it("refuses to advance the attempt it wrote off", async () => {
    const selectCall = acceptsAction(agent, NP, "select");
    acceptsAction(agent, NP, "search");
    await start();
    await sendFirstAction();
    await post("on_search", callbackFor("on_search", CATALOG, 1_000));
    const firstTxn = transactionId;

    await container.services.flow.restart({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
    });

    // A model still holding the old id would otherwise put `select` on a real
    // participant's wire for a run that no longer exists.
    const blocked = await container.services.flow.proceed({
      sessionId,
      transactionId: firstTxn,
      inputs: { loan_amount: 50_000 },
    });

    expect(blocked).toMatchObject({
      outcome: "BLOCKED",
      reason: "attempt_abandoned",
    });
    expect(selectCall.seen).toHaveLength(0);
  });

  it("refuses a late callback for the abandoned attempt, and keeps it", async () => {
    acceptsAction(agent, NP, "search");
    const selectCall = acceptsAction(agent, NP, "select");
    // auto_advance on, so a call the receiver *accepted* would chain straight
    // into `select`. This one must not.
    await start(true);
    await sendFirstAction();
    await post("on_search", callbackFor("on_search", CATALOG, 1_000));
    const firstTxn = transactionId;

    await container.services.flow.restart({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
    });

    const late = await post(
      "on_select",
      callbackFor("on_select", { order: { id: "order-1" } }, 3_000),
    );

    expect(late.statusCode).toBe(200);
    expect(late.json()).toMatchObject({
      message: { ack: { status: "NACK" } },
      error: { code: "TRANSACTION_ABANDONED" },
    });

    await settle();
    expect(selectCall.seen).toHaveLength(0);

    // Filed out of line, never appended: appending would advance a run we just
    // refused, and would wake a `flow_await` parked on the *current* attempt.
    const abandoned = await container.services.record.requireTransaction(
      firstTxn,
      NP,
    );
    expect(abandoned.apiList).toHaveLength(2);
    expect(abandoned.attention).toMatchObject({
      kind: "TRANSACTION_ABANDONED",
    });
  });

  it("restarts a run that never sent anything, without inventing an attempt", async () => {
    await start();

    const restarted = await container.services.flow.restart({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
    });

    // Nothing crossed the wire, so there was no attempt to write off and the
    // counter has nothing to count.
    expect(restarted.attempt).toBe(1);
    expect(restarted.abandonedTransactionId).toBeNull();
    expect(restarted.runtime.bound).toBe(false);
  });

  it("refuses to restart a flow that was never started", async () => {
    // On the tool channel, with the hint that names the way forward: there is
    // no attempt to abandon, so what the caller wants is `flow_start`.
    const failure = await container.services.flow
      .restart({ sessionId, flowId: RUNNABLE_FLOW_ID })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NotFoundError);
    expect((failure as NotFoundError).details).toMatchObject({
      hint: expect.stringContaining("flow_start"),
    });
  });
});

/** Let the receiver's post-ACK `setImmediate` chain run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/* -------------------------------------------------------------------------- */
/* Session-scope await                                                         */
/* -------------------------------------------------------------------------- */

describe("flow_await in session scope", () => {
  const awaitSession = (
    extra: Parameters<
      Container["services"]["flow"]["awaitEvent"]
    >[0] extends infer T
      ? Partial<Omit<T & object, "sessionId">>
      : never = {},
  ) =>
    container.services.flow.awaitEvent({
      sessionId,
      timeoutMs: 2_000,
      ...extra,
    });

  /**
   * Consume whatever setting the scene already journaled.
   *
   * Starting a run and sending its first action are themselves events, so a
   * wait issued straight afterwards returns that backlog instantly and never
   * parks. Draining first is what lets a test say "now block".
   */
  async function drainBacklog(): Promise<void> {
    await container.services.record.drainEvents(sessionId);
  }

  it("returns a backlog immediately, without parking", async () => {
    await container.services.record.journal(sessionId, {
      kind: "INBOUND_ACK",
      action: "on_search",
      summary: "ACKed on_search.",
    });

    const result = await awaitSession({ timeoutMs: 30_000 });

    // 30s budget, but it had something to say and said it at once.
    expect(result.timedOut).toBe(false);
    expect(result.scope).toBe("session");
    expect(result.events?.events).toHaveLength(1);
    // No single run to name, so no id and no `next`.
    expect(result.transactionId).toBeNull();
    expect(result.next).toBeUndefined();
  });

  it("wakes on an event journaled while it is parked", async () => {
    const waiting = awaitSession();

    setTimeout(() => {
      void container.services.record.journal(sessionId, {
        kind: "CHAIN_SENT",
        action: "select",
        summary: "Auto-sent select.",
      });
    }, 20);

    const result = await waiting;
    expect(result.timedOut).toBe(false);
    expect(result.events?.events[0]).toMatchObject({ kind: "CHAIN_SENT" });
  });

  /**
   * The point of the whole plan: a callback on a run the model is not watching
   * still reaches it.
   */
  it("wakes on a real callback the caller never named", async () => {
    acceptsAction(agent, NP, "search");
    await start();
    await sendFirstAction();
    await drainBacklog();

    const waiting = awaitSession();
    setTimeout(() => {
      void post("on_search", callbackFor("on_search", CATALOG, 1_000));
    }, 20);

    const result = await waiting;

    expect(result.timedOut).toBe(false);
    expect(
      result.events?.events.map((event) => [event.kind, event.action]),
    ).toContainEqual(["INBOUND_ACK", "on_search"]);
  });

  /**
   * Sending the flow's first action is itself two journal entries — the id it
   * minted, and the payload it put on the wire. Both reach the model on its
   * next call, whatever that call is.
   */
  it("reports what the caller's own proceed did", async () => {
    acceptsAction(agent, NP, "search");
    await start();
    await sendFirstAction();

    const result = await awaitSession({ timeoutMs: 30_000 });

    expect(result.timedOut).toBe(false);
    expect(result.events?.events.map((event) => event.kind)).toEqual([
      "TRANSACTION_BOUND",
      "OUTBOUND_SENT",
    ]);
  });

  it("times out as an ordinary outcome", async () => {
    const result = await awaitSession({ timeoutMs: 60 });

    expect(result.timedOut).toBe(true);
    expect(result.events).toBeUndefined();
    expect(result.scope).toBe("session");
  });

  it("delivers each event exactly once across two waits", async () => {
    await container.services.record.journal(sessionId, {
      kind: "INBOUND_ACK",
      summary: "one",
    });

    const first = await awaitSession({ timeoutMs: 30_000 });
    expect(first.events?.events).toHaveLength(1);

    // Nothing new, so the second wait genuinely waits — and times out empty.
    const second = await awaitSession({ timeoutMs: 60 });
    expect(second.timedOut).toBe(true);
    expect(second.events).toBeUndefined();
  });

  describe("filters", () => {
    it("does not wake for a kind it was not watching", async () => {
      await container.services.record.journal(sessionId, {
        kind: "CHAIN_SENT",
        summary: "not what you asked for",
      });

      const result = await awaitSession({
        kinds: ["INBOUND_NACK"],
        timeoutMs: 80,
      });

      expect(result.timedOut).toBe(true);
      // ...but the event is delivered anyway. The cursor has already moved past
      // it, so withholding it would lose it for good.
      expect(result.events?.events).toHaveLength(1);
      expect(result.events?.events[0]).toMatchObject({ kind: "CHAIN_SENT" });
    });

    it("wakes for a matching kind", async () => {
      await container.services.record.journal(sessionId, {
        kind: "INBOUND_NACK",
        nack_code: "OUT_OF_SEQUENCE",
        summary: "refused",
      });

      const result = await awaitSession({
        kinds: ["INBOUND_NACK"],
        timeoutMs: 30_000,
      });

      expect(result.timedOut).toBe(false);
    });

    it("filters by flow, and treats an event with no flow as no match", async () => {
      await container.services.record.journal(sessionId, {
        kind: "CHAIN_SENT",
        flow_id: "other-flow",
        summary: "another flow moved",
      });
      await container.services.record.journal(sessionId, {
        kind: "CHAIN_SENT",
        summary: "no flow at all",
      });

      const result = await awaitSession({
        flowIds: [RUNNABLE_FLOW_ID],
        timeoutMs: 80,
      });

      expect(result.timedOut).toBe(true);
      expect(result.events?.events).toHaveLength(2);
    });
  });

  it("reports where every run stands", async () => {
    acceptsAction(agent, NP, "search");
    await start();
    await sendFirstAction();

    const result = await awaitSession({ timeoutMs: 60 });

    expect(result.runs).toEqual([
      expect.objectContaining({
        flow_id: RUNNABLE_FLOW_ID,
        transaction_id: transactionId,
        attempt: 1,
        // We sent `search`; the participant owes `on_search`.
        outcome: "WAITING",
      }),
    ]);
  });

  it("reports an unbound run with a null transaction id", async () => {
    await start();

    const result = await awaitSession({ timeoutMs: 60 });

    expect(result.runs).toEqual([
      expect.objectContaining({
        flow_id: RUNNABLE_FLOW_ID,
        transaction_id: null,
      }),
    ]);
  });

  /**
   * The re-arm sweep. A model parked here for longer than the expectation
   * window would otherwise come back to an endpoint that had quietly stopped
   * accepting the callback it was waiting for.
   */
  it("re-arms a lapsed expectation before parking", async () => {
    acceptsAction(agent, NP, "search");
    await start();
    await sendFirstAction();
    // The sweep runs before a *park*, so the wait has to actually park: with a
    // backlog outstanding it would answer at once, which is the right thing to
    // do and the wrong thing to test with.
    await drainBacklog();

    const scope = {
      domain: RUNNABLE_BUILD.domain,
      version: RUNNABLE_BUILD.version,
      role: "buyer" as const,
    };
    // Simulate the window closing under a long wait.
    await container.services.record.clearExpectationsForSession(
      scope,
      sessionId,
    );
    await expect(
      container.services.record.expectationsForSession(scope, sessionId),
    ).resolves.toEqual([]);

    await awaitSession({ timeoutMs: 80 });

    const armed = await container.services.record.expectationsForSession(
      scope,
      sessionId,
    );
    expect(armed.map((entry) => entry.expectedAction)).toEqual(["on_search"]);
  });

  it("keeps run scope working exactly as before", async () => {
    acceptsAction(agent, NP, "search");
    await start();
    await sendFirstAction();

    const result = await container.services.flow.awaitEvent({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      afterSeq: 1,
      timeoutMs: 60,
    });

    expect(result.scope).toBe("run");
    expect(result.transactionId).toBe(transactionId);
    expect(result.next?.outcome).toBe("WAITING");
    expect(result.runs).toBeUndefined();
    // Run scope does not drain the journal; the tool layer does that.
    expect(result.events).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Auto-send by default                                                        */
/* -------------------------------------------------------------------------- */

describe("auto-send by default", () => {
  const journalOf = () => container.services.record.readEvents(sessionId);

  const kinds = async () => (await journalOf()).map((event) => event.kind);

  it("is on for an llm_auto session and off for a manual one", async () => {
    const auto = await container.services.session.createSession({
      subscriber_url: NP,
      np_type: "BPP",
      domain: RUNNABLE_BUILD.domain,
      version: RUNNABLE_BUILD.version,
      usecase: RUNNABLE_BUILD.usecase,
    });
    const manual = await container.services.session.createSession({
      subscriber_url: NP,
      np_type: "BPP",
      domain: RUNNABLE_BUILD.domain,
      version: RUNNABLE_BUILD.version,
      usecase: RUNNABLE_BUILD.usecase,
      interaction_mode: "manual",
    });

    expect(auto.session.auto_advance).toBe(true);
    expect(manual.session.auto_advance).toBe(false);
  });

  it("lets an explicit value win over the mode", async () => {
    const off = await container.services.session.createSession({
      subscriber_url: NP,
      np_type: "BPP",
      domain: RUNNABLE_BUILD.domain,
      version: RUNNABLE_BUILD.version,
      usecase: RUNNABLE_BUILD.usecase,
      auto_advance: false,
    });
    const on = await container.services.session.createSession({
      subscriber_url: NP,
      np_type: "BPP",
      domain: RUNNABLE_BUILD.domain,
      version: RUNNABLE_BUILD.version,
      usecase: RUNNABLE_BUILD.usecase,
      interaction_mode: "manual",
      auto_advance: true,
    });

    expect(off.session.auto_advance).toBe(false);
    expect(on.session.auto_advance).toBe(true);
  });

  /**
   * The new trigger site. Before this, auto-advance only ever fired from the
   * receiver, so two mock-owned steps in a row stopped dead after the first —
   * and the model had to ask for a step that needed nothing from it.
   */
  it("carries on past a step of our own after a model-initiated send", async () => {
    acceptsAction(agent, NP, "search");
    const statusCall = acceptsAction(agent, NP, "status");

    await container.services.flow.start({
      sessionId,
      flowId: RUNNABLE_CHAIN_FLOW_ID,
    });
    const sent = await container.services.flow.proceed({
      sessionId,
      flowId: RUNNABLE_CHAIN_FLOW_ID,
    });
    expect(sent).toMatchObject({ outcome: "SENT", action: "search" });

    // The answer came back before the chain ran — the caller is not made to
    // wait for the rest of the flow.
    expect(statusCall.seen).toHaveLength(0);

    await settle();
    expect(statusCall.seen).toHaveLength(1);

    // And the model learns about it from the journal, not from having asked.
    expect(await kinds()).toEqual([
      "TRANSACTION_BOUND",
      "OUTBOUND_SENT",
      "CHAIN_SENT",
      "CHAIN_PAUSED",
    ]);
    const [chained] = (await journalOf()).filter(
      (event) => event.kind === "CHAIN_SENT",
    );
    expect(chained).toMatchObject({ action: "status", ack: "ACK" });
    expect(chained?.summary).toContain("Auto-sent");
  });

  it("does not chain when the run has auto-advance off", async () => {
    acceptsAction(agent, NP, "search");
    const statusCall = acceptsAction(agent, NP, "status");

    await container.services.flow.start({
      sessionId,
      flowId: RUNNABLE_CHAIN_FLOW_ID,
      autoAdvance: false,
    });
    await container.services.flow.proceed({
      sessionId,
      flowId: RUNNABLE_CHAIN_FLOW_ID,
    });

    await settle();
    expect(statusCall.seen).toHaveLength(0);
    expect(await kinds()).toEqual(["TRANSACTION_BOUND", "OUTBOUND_SENT"]);
  });

  it("pauses at a step that needs input, and says which", async () => {
    acceptsAction(agent, NP, "search");
    const selectCall = acceptsAction(agent, NP, "select");
    await start(true);
    await sendFirstAction();
    await post("on_search", callbackFor("on_search", CATALOG, 1_000));
    await settle();

    expect(selectCall.seen).toHaveLength(0);

    // The *latest* pause: the first was the chain after `search`, stopping
    // because it was then the participant's turn — which is the loop working,
    // not a problem.
    const paused = (await journalOf())
      .filter((event) => event.kind === "CHAIN_PAUSED")
      .at(-1);
    expect(paused?.summary).toContain("INPUT_REQUIRED");
    expect(paused?.summary).toContain("select_1");
  });

  it("does not chain a chained send into a second chain", async () => {
    acceptsAction(agent, NP, "search");
    const statusCall = acceptsAction(agent, NP, "status");

    await container.services.flow.start({
      sessionId,
      flowId: RUNNABLE_CHAIN_FLOW_ID,
    });
    await container.services.flow.proceed({
      sessionId,
      flowId: RUNNABLE_CHAIN_FLOW_ID,
    });
    await settle();

    // Exactly one `status`, not one per nested chain.
    expect(statusCall.seen).toHaveLength(1);
    expect(
      (await kinds()).filter((kind) => kind === "CHAIN_SENT"),
    ).toHaveLength(1);
  });
});

/**
 * The other direction: this mock is the BPP, so the participant opens the flow
 * and every step of ours is a reply. With auto-advance on by default, that
 * whole exchange happens without the model making a single call.
 */
describe("auto-send when the participant moves first", () => {
  it("answers a participant-initiated flow with zero model calls", async () => {
    const created = await container.services.session.createSession({
      subscriber_url: NP,
      // A BAP under test, so this mock plays the BPP and owes `on_search`.
      np_type: "BAP",
      domain: RUNNABLE_BUILD.domain,
      version: RUNNABLE_BUILD.version,
      usecase: RUNNABLE_BUILD.usecase,
    });
    const sellerSession = created.session;
    expect(sellerSession.auto_advance).toBe(true);

    const onSearchCall = acceptsAction(agent, NP, "on_search");

    // The only call the model makes: open the run. It arms, and answers WAITING.
    const started = await container.services.flow.start({
      sessionId: sellerSession.session_id,
      flowId: RUNNABLE_FLOW_ID,
    });
    expect(started.outcome.outcome).toBe("WAITING");

    // The participant sends the flow's first action, choosing the id.
    const theirTxn = "participant-chosen-txn";
    const response = await app.inject({
      method: "POST",
      url: receiverPath(sellerSession, "search"),
      headers: { "content-type": "application/json" },
      payload: {
        context: {
          domain: RUNNABLE_BUILD.domain,
          action: "search",
          version: RUNNABLE_BUILD.version,
          transaction_id: theirTxn,
          message_id: "msg-search",
          timestamp: new Date().toISOString(),
          bap_id: "np.example.com",
          bap_uri: NP,
        },
        message: { intent: { descriptor: { name: "loan" } } },
      },
    });
    expect(response.statusCode).toBe(200);

    await settle();

    // `on_search` went out on its own — no second model call anywhere.
    expect(onSearchCall.seen).toHaveLength(1);

    const events = await container.services.record.readEvents(
      sellerSession.session_id,
    );
    expect(events.map((event) => event.kind)).toEqual([
      "TRANSACTION_BOUND",
      "INBOUND_ACK",
      "CHAIN_SENT",
      "CHAIN_PAUSED",
    ]);
    // And the whole story is legible from those four lines alone: they opened
    // the transaction, we ACKed their `search`, we answered `on_search`, and we
    // are now waiting on their `select`.
    expect(events.map((event) => event.action)).toEqual([
      undefined,
      "search",
      "on_search",
      "select",
    ]);
    expect(events.at(-1)?.summary).toContain("WAITING");
  });
});

/* -------------------------------------------------------------------------- */
/* The end-to-end claims this whole mechanism exists to make                    */
/* -------------------------------------------------------------------------- */

describe("what the model actually sees", () => {
  /**
   * The one that motivated the design.
   *
   * Two flows are open in one session. The model is busy driving flow A; flow B
   * gets a callback it never asked about and is not waiting on. Before the
   * journal that event was ACKed, recorded, and surfaced to nobody — the only
   * way to find it was a `flow_get_status` on B that the model had no reason to
   * make. Now it arrives on the back of the next call about A.
   */
  it("learns about flow B from a call it made about flow A", async () => {
    const searchA = acceptsAction(agent, NP, "search");
    await container.services.flow.start({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      autoAdvance: false,
    });
    const sentA = await container.services.flow.proceed({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
    });
    const txnA = sentA.transaction_id as string;
    expect(searchA.seen).toHaveLength(1);

    // Flow B, in the same session, also under way — and left to advance itself
    // as far as it can, so it is genuinely waiting on the participant.
    acceptsAction(agent, NP, "search");
    acceptsAction(agent, NP, "status");
    await container.services.flow.start({
      sessionId,
      flowId: RUNNABLE_CHAIN_FLOW_ID,
    });
    const sentB = await container.services.flow.proceed({
      sessionId,
      flowId: RUNNABLE_CHAIN_FLOW_ID,
    });
    const txnB = sentB.transaction_id as string;
    await settle();

    // Everything so far is old news as far as the model is concerned.
    await container.services.record.drainEvents(sessionId);

    // B's participant answers while the model's attention is entirely on A.
    await app.inject({
      method: "POST",
      url: receiverPath(session, "on_status"),
      headers: { "content-type": "application/json" },
      payload: {
        context: counterpartyContext(session, NP, {
          transactionId: txnB,
          action: "on_status",
          messageId: "msg-on_status",
          timestampOffsetMs: 1_000,
        }),
        message: { order: { id: "order-1", state: "ACTIVE" } },
      },
    });
    await settle();

    // The model asks about A — and is told about B, without having asked.
    const aboutA = await container.services.flow.status(sessionId, {
      transactionId: txnA,
    });
    expect(aboutA.flow_id).toBe(RUNNABLE_FLOW_ID);

    const delta = await container.services.record.drainEvents(sessionId);
    const inbound = delta?.events.filter(
      (event) => event.kind === "INBOUND_ACK",
    );
    expect(inbound).toHaveLength(1);
    expect(inbound?.[0]).toMatchObject({
      flow_id: RUNNABLE_CHAIN_FLOW_ID,
      transaction_id: txnB,
      action: "on_status",
    });
    // Named well enough to act on without a second lookup.
    expect(inbound?.[0]?.summary).toContain("on_status");
  });

  /**
   * The autonomy target from the plan, measured rather than asserted: a flow
   * that needs nothing from the model costs `flow_start` + one `flow_proceed`,
   * and everything after that arrives through waits.
   */
  it("drives a no-input flow to COMPLETE on two calls and a wait", async () => {
    acceptsAction(agent, NP, "search");
    acceptsAction(agent, NP, "status");

    // Call 1.
    await container.services.flow.start({
      sessionId,
      flowId: RUNNABLE_CHAIN_FLOW_ID,
    });
    // Call 2 — and the last one that sends anything.
    const sent = await container.services.flow.proceed({
      sessionId,
      flowId: RUNNABLE_CHAIN_FLOW_ID,
    });
    const txn = sent.transaction_id as string;

    // `status` follows on its own; the flow then waits for the participant.
    await settle();

    // The participant answers, closing the flow.
    await app.inject({
      method: "POST",
      url: receiverPath(session, "on_status"),
      headers: { "content-type": "application/json" },
      payload: {
        context: counterpartyContext(session, NP, {
          transactionId: txn,
          action: "on_status",
          messageId: "msg-on_status",
          timestampOffsetMs: 2_000,
        }),
        message: { order: { id: "order-1", state: "COMPLETE" } },
      },
    });
    await settle();

    const status = await container.services.flow.status(sessionId, {
      transactionId: txn,
    });
    expect(status.flow_status).toBe("COMPLETE");
    expect(status.sequence.map((step) => step.status)).toEqual([
      "COMPLETE",
      "COMPLETE",
      "COMPLETE",
    ]);
    expect(status.missed_steps).toEqual([]);

    // And the run is legible from the journal alone, completion included.
    const journal = await container.services.record.readEvents(sessionId);
    expect(journal.map((event) => event.kind)).toEqual([
      "TRANSACTION_BOUND",
      "OUTBOUND_SENT",
      "CHAIN_SENT",
      "CHAIN_PAUSED",
      "INBOUND_ACK",
      "FLOW_COMPLETE",
    ]);
  });

  /**
   * `FLOW_COMPLETE` is claimed once, atomically. The mapper reports COMPLETE on
   * every read after the last exchange, so an unguarded journal would append the
   * same line to every status read until the transaction expired.
   */
  it("says a flow completed exactly once, however often it is asked", async () => {
    acceptsAction(agent, NP, "search");
    acceptsAction(agent, NP, "status");
    await container.services.flow.start({
      sessionId,
      flowId: RUNNABLE_CHAIN_FLOW_ID,
    });
    const sent = await container.services.flow.proceed({
      sessionId,
      flowId: RUNNABLE_CHAIN_FLOW_ID,
    });
    const txn = sent.transaction_id as string;
    await settle();

    await app.inject({
      method: "POST",
      url: receiverPath(session, "on_status"),
      headers: { "content-type": "application/json" },
      payload: {
        context: counterpartyContext(session, NP, {
          transactionId: txn,
          action: "on_status",
          messageId: "msg-on_status",
          timestampOffsetMs: 2_000,
        }),
        message: { order: { id: "order-1", state: "COMPLETE" } },
      },
    });
    await settle();

    for (let i = 0; i < 3; i++) {
      await container.services.flow.status(sessionId, { transactionId: txn });
      await container.services.flow.noteCompletion(sessionId, txn);
    }

    const journal = await container.services.record.readEvents(sessionId);
    expect(
      journal.filter((event) => event.kind === "FLOW_COMPLETE"),
    ).toHaveLength(1);
  });
});

describe("the outbound gate", () => {
  it("keeps a non-compliant payload off the wire entirely", async () => {
    const search = acceptsAction(agent, NP, "search");
    validation.setResult(invalidFrom(L1_MULTI_RULE));
    await container.services.flow.start({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
    });

    const outcome = await container.services.flow.proceed({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
    });

    expect(outcome).toMatchObject({
      outcome: "BLOCKED",
      reason: "validation_failed",
    });
    // The assertion that matters: nothing reached the participant.
    expect(search.seen).toHaveLength(0);
  });

  it("mints nothing, so the run is still free to try again", async () => {
    acceptsAction(agent, NP, "search");
    validation.setResult(invalidFrom(L1_MULTI_RULE));
    await container.services.flow.start({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
    });
    const blockedOutcome = await container.services.flow.proceed({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
    });

    // A blocked dispatch persists nothing — the flow's first action is still
    // unspoken for, so no id was burned and no second transaction was opened.
    expect(blockedOutcome.transaction_id).toBeUndefined();

    validation.setResult({ status: "valid" });
    const retry = await container.services.flow.proceed({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
    });

    expect(retry).toMatchObject({ outcome: "SENT", action: "search" });
    expect(retry.transaction_id).toBeTruthy();
  });

  it("sends anyway when the oracle is unreachable, and says so", async () => {
    const search = acceptsAction(agent, NP, "search");
    validation.setResult({ status: "unavailable", reason: "oracle was down" });
    await container.services.flow.start({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
    });

    const outcome = await container.services.flow.proceed({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
    });

    // Failing closed here would let a workbench outage strand every run in
    // flight. There was no gate at all before this, so open is never a
    // regression — but it has to be visible.
    expect(outcome.outcome).toBe("SENT");
    expect(search.seen).toHaveLength(1);
    expect(outcome.validation?.status).toBe("unavailable");
  });

  it("validates a dry run without blocking it", async () => {
    validation.setResult(invalidFrom(L1_MULTI_RULE));
    await container.services.flow.start({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
    });

    const outcome = await container.services.flow.proceed({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      dryRun: true,
    });

    // A draft exists to be inspected, and one that fails is the most useful
    // kind to look at — so it comes back DRAFTED with the findings attached.
    expect(outcome.outcome).toBe("DRAFTED");
    expect(outcome.validation?.status).toBe("invalid");
    expect(outcome.payload_id).toBeTruthy();
  });
});

/**
 * `payload_overrides` — the escape hatch for a config that is itself wrong.
 *
 * Driven end to end rather than as unit tests (those are in
 * `flow.overrides.test.ts`) because the claim is about the whole path: the
 * patch has to reach the bytes the gate judges, the bytes the participant
 * receives, and the record the compliance report will read. A fake verdict
 * that ignored the payload would pass whether or not any of that happened,
 * which is why the gateway judges each payload on its merits here.
 */
describe("payload_overrides", () => {
  /** Reject every search whose descriptor name is not `patched`. */
  function rejectUnlessPatched(): void {
    validation.setResponder((request) => {
      const name = (
        (
          (request.payload as { message?: { intent?: { descriptor?: unknown } } })
            .message?.intent?.descriptor as { name?: unknown } | undefined
        )?.name
      );
      return name === "patched"
        ? { status: "valid" }
        : invalidFrom(
            "at '/message/intent/descriptor/name': got string, want object",
          );
    });
  }

  it("gets a run past a config that generates a non-compliant payload", async () => {
    /*
     * The 2026-07-31 case, reproduced: live TRV11 `search2_METRO_201` assigns
     * `context.bpp_uri = sessionData?.bppUri` with no `[0]`, so a list reaches
     * a string field. Two runs ended `gave_up` there — a correct participant
     * got no compliance report because one step of one flow had a typo
     * upstream, and nothing in this repo could fix it.
     */
    const search = acceptsAction(agent, NP, "search");
    rejectUnlessPatched();
    await container.services.flow.start({ sessionId, flowId: RUNNABLE_FLOW_ID });

    const refused = await container.services.flow.proceed({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
    });
    expect(refused).toMatchObject({
      outcome: "BLOCKED",
      reason: "validation_failed",
    });
    expect(search.seen).toHaveLength(0);
    // The block names the way out. Before this it said only "inspect it with
    // dry_run", which is where both runs stopped.
    expect(
      (refused.details as { recovery?: string }).recovery,
    ).toContain("$.message.intent.descriptor.name");

    const sent = await container.services.flow.proceed({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      payloadOverrides: { "$.message.intent.descriptor.name": "patched" },
    });

    expect(sent).toMatchObject({ outcome: "SENT", ack: "ACK" });
    expect(sent.overrides).toEqual(["$.message.intent.descriptor.name"]);
    // The patch reached the wire, not just the verdict.
    expect(search.seen[0]).toMatchObject({
      message: { intent: { descriptor: { name: "patched" } } },
    });
  });

  it("still blocks when the override does not fix the finding", async () => {
    // Not a validation bypass. Sending a payload we already know violates L0
    // would write our defect into the participant's compliance report.
    const search = acceptsAction(agent, NP, "search");
    rejectUnlessPatched();
    await container.services.flow.start({ sessionId, flowId: RUNNABLE_FLOW_ID });

    const outcome = await container.services.flow.proceed({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      payloadOverrides: { "$.message.intent.descriptor.name": "still-wrong" },
    });

    expect(outcome).toMatchObject({
      outcome: "BLOCKED",
      reason: "validation_failed",
    });
    expect(search.seen).toHaveLength(0);
  });

  it("records the patched step as patched", async () => {
    // A compliance report that cannot say the participant was tested against a
    // payload this flow's config did not produce is claiming more than it knows.
    acceptsAction(agent, NP, "search");
    rejectUnlessPatched();
    await container.services.flow.start({ sessionId, flowId: RUNNABLE_FLOW_ID });

    const sent = await container.services.flow.proceed({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      payloadOverrides: { "$.message.intent.descriptor.name": "patched" },
    });

    const record = await container.services.record.requireTransaction(
      sent.transaction_id ?? "",
      NP,
    );
    const entry = record.apiList.find(
      (item) => item.entryType === "API" && item.direction === "outbound",
    );
    expect(entry).toMatchObject({ overrides: ["$.message.intent.descriptor.name"] });

    // And on the journal, which is what the incident corpus reads — it is the
    // difference between RECOVERED and RECOVERED_WITH_OVERRIDE.
    const journal = await container.services.record.readEvents(sessionId);
    const sentLine = journal.find((event) => event.kind === "OUTBOUND_SENT");
    expect(sentLine?.overrides).toEqual(["$.message.intent.descriptor.name"]);
  });

  it("does not let a chained step inherit them", async () => {
    /*
     * The property that keeps this safe to leave on. Auto-advance sends with
     * nobody watching; a chained step carrying a patch nobody re-stated would
     * put bytes on a third party's wire that neither the config nor the model
     * chose. `RUNNABLE_CHAIN_FLOW_ID` runs two mock-owned steps back to back,
     * so the second one is genuinely chained rather than asked for.
     */
    const searchCall = acceptsAction(agent, NP, "search");
    const statusCall = acceptsAction(agent, NP, "status");
    await container.services.flow.start({
      sessionId,
      flowId: RUNNABLE_CHAIN_FLOW_ID,
    });

    const sent = await container.services.flow.proceed({
      sessionId,
      flowId: RUNNABLE_CHAIN_FLOW_ID,
      payloadOverrides: { "$.context.ttl": "PT99S" },
    });
    expect(sent).toMatchObject({ outcome: "SENT", action: "search" });
    expect(sent.overrides).toEqual(["$.context.ttl"]);

    await settle();

    // Positive on both halves, so neither assertion can pass by the field
    // simply being absent: the patch landed on the step it was given for...
    const ttlOf = (call: { seen: unknown[] }, index = 0): unknown =>
      (call.seen[index] as { context: Record<string, unknown> }).context["ttl"];
    expect(ttlOf(searchCall)).toBe("PT99S");
    // ...and the chained step carries the config's own value instead.
    expect(statusCall.seen).toHaveLength(1);
    expect(ttlOf(statusCall)).toBe("PT30S");

    const record = await container.services.record.requireTransaction(
      sent.transaction_id ?? "",
      NP,
    );
    const chained = record.apiList.find(
      (item) => item.entryType === "API" && item.action === "status",
    );
    expect(chained).toBeDefined();
    expect(chained).not.toHaveProperty("overrides");
  });

  it("refuses the transaction id and leaves the payload alone", async () => {
    const search = acceptsAction(agent, NP, "search");
    await container.services.flow.start({ sessionId, flowId: RUNNABLE_FLOW_ID });

    const outcome = await container.services.flow.proceed({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      payloadOverrides: { "$.context.transaction_id": "somebody-elses-id" },
    });

    expect(outcome).toMatchObject({
      outcome: "BLOCKED",
      reason: "overrides_refused",
    });
    expect(outcome.override_problems?.[0]?.reason).toContain("flow_restart");
    // Nothing generated, nothing bound, nothing sent — so correcting it and
    // calling again costs the run nothing.
    expect(search.seen).toHaveLength(0);
    expect(outcome.transaction_id).toBeUndefined();
  });

  it("refuses them on a step that is not ours to send", async () => {
    // Silently dropping them is exactly the failure this feature answers: a
    // caller states an intent and nothing honours it or says so.
    acceptsAction(agent, NP, "search");
    await container.services.flow.start({ sessionId, flowId: RUNNABLE_FLOW_ID });
    await sendFirstAction();

    const outcome = await container.services.flow.proceed({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      payloadOverrides: { "$.context.ttl": "PT10S" },
    });

    expect(outcome).toMatchObject({
      outcome: "BLOCKED",
      reason: "overrides_not_applicable",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* What made a correct participant look like a silent one                       */
/* -------------------------------------------------------------------------- */

/**
 * `flow_await` used to sit out its whole budget with the answer already in the
 * store. Three separate causes, all reproduced from live runs against
 * workbench.ondc.tech, all costing five minutes a call.
 *
 * The common shape is worth stating: every one of them made a **participant
 * that had done exactly the right thing** indistinguishable from one that had
 * gone quiet. That is the worst failure this server can have, because the run
 * it produces is a compliance report blaming the wrong side.
 */
describe("a wait that could never have ended", () => {
  it("ignores an after_seq from the session journal's counter", async () => {
    // The one from the logs. `flow_proceed` used to report no run `seq` at all,
    // so the only number in front of the model was the journal's — a different
    // counter, and always further along, because it counts everything in the
    // session rather than one transaction's exchanges. Passing it parked the
    // waiter above the record's high-water mark, where `notify`'s
    // `event.seq > afterSeq` test could never reach it: deaf not merely to the
    // callback already recorded, but to every future one too.
    acceptsAction(agent, NP, "search");
    await start();
    await sendFirstAction();
    await post("on_search", callbackFor("on_search", CATALOG, 1_000));

    const record = await container.services.record.requireTransaction(
      transactionId,
      NP,
    );
    expect(record.seq).toBe(2);

    // What the journal was up to by then — comfortably past the record, which
    // is the whole trap.
    const journal = await container.services.record.readEvents(sessionId);
    expect(journal.at(-1)?.seq).toBeGreaterThan(record.seq);

    const started = Date.now();
    const result = await container.services.flow.awaitEvent({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      afterSeq: journal.at(-1)?.seq ?? 7,
      timeoutMs: 10_000,
    });

    // Answers at once with the callback that had already landed, rather than
    // blocking until the timeout and reporting that nothing arrived.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.timedOut).toBe(false);
    expect(result.event?.action).toBe("on_search");
    // And says why, because silently correcting it would leave the caller
    // making the same mistake on every subsequent call.
    expect(result.afterSeqAdjusted).toBe(2);
    expect(result.seq).toBe(2);
  });

  it("does not wait on a run that owes the caller the next step", async () => {
    // Both live stalls were this: `next` said COMPLETE, then INPUT_REQUIRED.
    // Neither run was expecting the participant to do anything, so parking
    // could only ever run out the clock.
    acceptsAction(agent, NP, "search");
    await start();
    await sendFirstAction();
    await post("on_search", callbackFor("on_search", CATALOG, 1_000));

    const started = Date.now();
    const result = await container.services.flow.awaitEvent({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      afterSeq: 2,
      timeoutMs: 10_000,
    });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.waited).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.next?.outcome).toBe("INPUT_REQUIRED");
  });

  it("waits anyway when the caller names a timeout", async () => {
    // The escape hatch, and the reason the short-circuit is not unconditional:
    // a participant may still fire an unsolicited side-channel step at a run
    // whose sequence has nothing pending. Naming a timeout says "I know".
    acceptsAction(agent, NP, "search");
    await start();
    await sendFirstAction();
    await post("on_search", callbackFor("on_search", CATALOG, 1_000));

    const started = Date.now();
    const result = await container.services.flow.awaitEvent({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      afterSeq: 2,
      timeoutMs: 300,
      waitAnyway: true,
    });

    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(result.waited).toBe(true);
    expect(result.timedOut).toBe(true);
  });

  it("reports the newest exchange when no cursor was given, not the oldest", async () => {
    // A bare wait used to answer with entry 1 every single time. Observed four
    // exchanges stale, next to a `next` that correctly said the flow had moved
    // on — and a stale event reads exactly like a fresh one.
    acceptsAction(agent, NP, "search");
    acceptsAction(agent, NP, "select");
    await start();
    await sendFirstAction();
    await post("on_search", callbackFor("on_search", CATALOG, 1_000));
    await container.services.flow.proceed({
      sessionId,
      transactionId,
      inputs: { loan_amount: 50_000 },
    });

    const result = await container.services.flow.awaitEvent({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      timeoutMs: 10_000,
    });

    expect(result.timedOut).toBe(false);
    expect(result.event?.action).toBe("select");
    expect(result.event?.seq).toBe(3);
  });

  it("ends a parked wait when the participant's call is refused outright", async () => {
    // A 400 or an unmatched 412 is filed against no transaction — there is
    // nothing to append it to, which is why it was refused — so it publishes no
    // run event and used to leave a run-scoped waiter parked for its full
    // budget. The refusal lands in the session journal, so the park races that
    // too. This is the mock-BPP direction's failure mode in particular, where
    // an armed expectation is the only way in.
    acceptsAction(agent, NP, "search");
    await start();
    await sendFirstAction();

    const started = Date.now();
    const waiting = container.services.flow.awaitEvent({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      afterSeq: 1,
      timeoutMs: 10_000,
    });

    // A call the receiver cannot key on: no counterparty URI, so it cannot even
    // say who is calling. Before this it produced no record, no journal line
    // and no log the model could read — completely invisible.
    const refused = await post("on_search", {
      context: {
        domain: session.build.domain,
        version: session.build.version,
        action: "on_search",
        transaction_id: transactionId,
        message_id: "msg-malformed",
        timestamp: new Date().toISOString(),
      },
      message: CATALOG,
    });
    expect(refused.statusCode).toBe(400);

    const result = await waiting;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.waited).toBe(true);

    // The refusal itself reaches the caller through the events piggyback, which
    // is the only channel a call belonging to no transaction can use.
    const journal = await container.services.record.readEvents(sessionId);
    const line = journal.find(
      (entry) => entry.nack_code === "MALFORMED_CONTEXT",
    );
    expect(line?.kind).toBe("POSSIBLY_RELATED");
    // This mock is the BAP, so the caller identifies itself as the BPP. Naming
    // the field is the whole value of the line: it is what the integrator has
    // to change.
    expect(line?.summary).toContain("context.bpp_uri is required");
    // And the body is kept, because "what did they actually send?" is the only
    // question worth asking next.
    expect(line?.payload_id).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Metrics                                                                     */
/* -------------------------------------------------------------------------- */

describe("the exposition after a real run", () => {
  it("counts both directions and quotes no transaction id", async () => {
    acceptsAction(agent, NP, "search");
    acceptsAction(agent, NP, "select");
    await start();
    await sendFirstAction();
    await post("on_search", callbackFor("on_search", CATALOG, 1_000));
    await container.services.flow.proceed({
      sessionId,
      transactionId,
      inputs: { loan_amount: 50_000 },
    });
    await post(
      "on_select",
      callbackFor("on_select", { order: { id: "order-1" } }, 3_000),
    );

    const exposition = await app
      .inject({ method: "GET", url: "/metrics" })
      .then((response) => response.body);

    // Outbound comes off the journal via `MetricsObserver`; inbound likewise.
    // Both are asserted here rather than in a unit test because the wiring —
    // observer in the list, container passing one registry to everybody — is
    // the part that can silently come undone.
    expect(exposition).toMatch(
      /ondc_outbound_sends_total\{action="search",outcome="ACK"\} 1/,
    );
    expect(exposition).toMatch(
      /ondc_outbound_sends_total\{action="select",outcome="ACK"\} 1/,
    );
    expect(exposition).toMatch(
      /ondc_inbound_calls_total\{action="on_search",ack="ACK",nack_code=""\} 1/,
    );
    expect(exposition).toMatch(
      /ondc_inbound_calls_total\{action="on_select",ack="ACK",nack_code=""\} 1/,
    );
    // The ACK window was measured, which is the one thing the journal cannot say.
    expect(exposition).toContain(
      'ondc_inbound_duration_seconds_count{action="on_search",ack="ACK"}',
    );

    /*
     * The cardinality canary, blunt on purpose.
     *
     * A transaction id in the exposition means some label is per-transaction,
     * and a scrape that grows without bound is the kind of failure that shows
     * up as an outage in a monitoring system rather than as a failing test.
     * Asserting on the whole text rather than on a list of label names catches
     * the instrument nobody remembered to check.
     */
    expect(transactionId.length).toBeGreaterThan(0);
    expect(exposition).not.toContain(transactionId);
    expect(exposition).not.toContain(sessionId);
  });
});

/* -------------------------------------------------------------------------- */
/* The mirror's run tap                                                        */
/* -------------------------------------------------------------------------- */

describe("a run that opens and immediately blocks", () => {
  /**
   * The case the mirror's third tap exists for.
   *
   * `flow_start` persists no transaction, so there is no `TRANSACTION_BOUND`;
   * a blocked dispatch persists nothing either, so there is no `OUTBOUND_SENT`.
   * This run therefore journals **nothing at all** — and it is the most
   * interesting shape in a triage corpus, because it is a flow that could not
   * even open. Without an explicit tap in `FlowService.start` it would be
   * invisible to a live view.
   */
  it("is mirrored as RUN_STARTED and never as TRANSACTION_BOUND", async () => {
    const search = acceptsAction(agent, NP, "search");
    const mirror = new NoopMirrorSink();

    const blocked = await createContainer(config, {
      configServiceGateway: createFakeConfigServiceGateway(),
      validationGateway: (() => {
        const gateway = createFakeValidationGateway();
        gateway.setResult(invalidFrom(L1_MULTI_RULE));
        return gateway;
      })(),
      senderDispatcher: agent,
      mirrorSink: mirror,
    });

    try {
      const created = await blocked.services.session.createSession({
        subscriber_url: NP,
        np_type: "BPP",
        domain: RUNNABLE_BUILD.domain,
        version: RUNNABLE_BUILD.version,
        usecase: RUNNABLE_BUILD.usecase,
      });

      await blocked.services.flow.start({
        sessionId: created.session.session_id,
        flowId: RUNNABLE_FLOW_ID,
        autoAdvance: false,
      });
      const outcome = await blocked.services.flow.proceed({
        sessionId: created.session.session_id,
        flowId: RUNNABLE_FLOW_ID,
      });

      expect(outcome).toMatchObject({
        outcome: "BLOCKED",
        reason: "validation_failed",
      });
      expect(search.seen).toHaveLength(0);

      const kinds = mirror.emitted.map((entry) =>
        entry.kind === "JOURNAL"
          ? `JOURNAL(${entry.event?.kind ?? "?"})`
          : entry.kind,
      );
      expect(kinds).toContain("RUN_STARTED");
      expect(kinds).not.toContain("JOURNAL(TRANSACTION_BOUND)");
      expect(kinds).not.toContain("JOURNAL(OUTBOUND_SENT)");

      const run = mirror.emitted.find((entry) => entry.kind === "RUN_STARTED");
      expect(run?.run).toMatchObject({
        flow_id: RUNNABLE_FLOW_ID,
        attempt: 1,
      });
    } finally {
      await blocked.dispose();
    }
  });
});
