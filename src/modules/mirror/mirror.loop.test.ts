import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHttpApp, type App } from "@/app.js";
import { parseConfig } from "@/config/env.js";
import { createContainer, type Container } from "@/container.js";
import { NoopMirrorSink } from "@/modules/mirror/mirror.sink.js";
import type { Session } from "@/modules/session/session.schema.js";
import {
  createFakeConfigServiceGateway,
  createFakeValidationGateway,
} from "@/test/fakes.js";
import {
  acceptsAction,
  counterpartyContext,
  receiverPath,
} from "@/test/mock-participant.js";
import { RUNNABLE_BUILD, RUNNABLE_FLOW_ID } from "@/test/runnable-config.js";

/**
 * The mirror against a real run.
 *
 * The unit tests cover what one record contains; this covers the **wiring** —
 * three taps in three different files, one of which is an entry in an observer
 * list that a refactor could quietly drop. The sequence is asserted in order
 * because a missing tap looks exactly like a tap that fired late.
 */

const NP = "https://np.example.com";
const config = parseConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });

let app: App;
let container: Container;
let agent: MockAgent;
let mirror: NoopMirrorSink;
let sessionId: string;
let session: Session;
let transactionId = "";

beforeEach(async () => {
  agent = new MockAgent();
  agent.disableNetConnect();
  mirror = new NoopMirrorSink();

  container = await createContainer(config, {
    configServiceGateway: createFakeConfigServiceGateway(),
    validationGateway: createFakeValidationGateway(),
    senderDispatcher: agent,
    mirrorSink: mirror,
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
        timestampOffsetMs: 1_000,
      }),
      message,
    },
  });
}

const CATALOG = {
  catalog: { providers: [{ id: "provider-1", descriptor: { name: "Bank" } }] },
};

describe("the mirror during a real run", () => {
  it("streams session, run and journal records in order", async () => {
    acceptsAction(agent, NP, "search");
    // Auto-advance off, so the sequence below is the taps and nothing else.
    // With it on — the `llm_auto` default — a `CHAIN_PAUSED` lands between the
    // send and the callback, which is correct and would only make this
    // assertion about chaining rather than about wiring.
    await container.services.flow.start({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      autoAdvance: false,
    });

    const sent = await container.services.flow.proceed({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
    });
    transactionId = sent.transaction_id ?? "";
    expect(transactionId).not.toBe("");

    await post("on_search", CATALOG);

    // Named by kind, and by journal kind where there is one, so a failure says
    // which tap went missing rather than which index moved.
    const shape = mirror.emitted.map((entry) =>
      entry.kind === "JOURNAL"
        ? `JOURNAL(${entry.event?.kind ?? "?"})`
        : entry.kind,
    );

    expect(shape).toEqual([
      // Tap two — the only source of `expires_at`.
      "SESSION_CREATED",
      // Tap three — nothing journals a run opening.
      "RUN_STARTED",
      // Tap one, from here on.
      "JOURNAL(TRANSACTION_BOUND)",
      "JOURNAL(OUTBOUND_SENT)",
      "JOURNAL(INBOUND_ACK)",
    ]);

    // Every session-scoped record carries the same pseudonymous join key, and
    // no record carries the real id — the correlation flag is off here, which
    // is the default.
    const refs = new Set(mirror.emitted.map((entry) => entry.session_ref));
    expect(refs.size).toBe(1);
    expect(JSON.stringify(mirror.emitted)).not.toContain(sessionId);

    // Journal seqs strictly increase and never repeat. A duplicate would mean
    // one line reached two taps; a gap would mean an observer threw and took
    // the rest of its feed with it.
    const seqs = mirror.emitted.flatMap((entry) =>
      entry.event === undefined ? [] : [entry.event.seq],
    );
    expect(seqs.length).toBeGreaterThan(2);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    // And `SESSION_CREATED` really did carry the one field that cannot be
    // recovered any other way.
    expect(mirror.emitted[0]?.session?.expires_at).toBe(session.expires_at);
  });
});
