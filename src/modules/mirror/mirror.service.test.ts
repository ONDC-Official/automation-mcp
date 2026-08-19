import { describe, expect, it } from "vitest";
import { logger } from "@/lib/logger.js";
import { pseudonymise } from "@/modules/feedback/feedback.redact.js";
import type { SessionEvent } from "@/modules/record/record.schema.js";
import type { Session } from "@/modules/session/session.schema.js";
import { MirrorService } from "@/modules/mirror/mirror.service.js";
import { NoopMirrorSink } from "@/modules/mirror/mirror.sink.js";
import { PII_PROSE, expectNoPii } from "@/test/pii-fixtures.js";

/**
 * What the mirror puts on the wire, and what it must not.
 *
 * The interesting risk in this module is not the batching — that is
 * `mirror.sink.test.ts` — it is `summary`. Every other field is a handle, a
 * JSONPath, a protocol enum or a public catalog coordinate. `summary` is free
 * prose written by whoever produced the event, and it routinely quotes a
 * participant's NACK message and mints transaction ids in plain text.
 */

const SALT = "mirror-test-salt";
const SESSION = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const NOW = new Date("2026-08-17T09:00:00.000Z");

function service(
  correlation = false,
): { mirror: MirrorService; sink: NoopMirrorSink } {
  const sink = new NoopMirrorSink();
  const mirror = new MirrorService({
    sink,
    salt: SALT,
    correlation,
    logger: logger.child({ silent: true }),
    now: () => NOW,
    instanceId: "proc_test",
  });
  return { mirror, sink };
}

function session(): Session {
  return {
    session_id: SESSION,
    created_at: "2026-08-17T08:00:00.000Z",
    expires_at: "2026-08-19T08:00:00.000Z",
    np: { subscriber_url: "https://np.example.com", type: "BPP" },
    mock_role: "BAP",
    build: { domain: "ONDC:TRV11", version: "2.0.0", usecase: "METRO" },
    interaction_mode: "llm_auto",
    auto_advance: true,
    callback_url: "https://mock.example.com/ONDC:TRV11/2.0.0/buyer",
  };
}

function event(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    seq: 4,
    at: "2026-08-17T09:00:00.000Z",
    kind: "INBOUND_NACK",
    flow_id: "flow-1",
    action: "on_search",
    nack_code: "OUT_OF_SEQUENCE",
    summary: "refused",
    ...overrides,
  };
}

describe("MirrorService", () => {
  it("scrubs ids and personal data quoted inside a journal summary", () => {
    const { mirror, sink } = service();

    mirror.onSessionEvent(
      SESSION,
      event({
        summary:
          "NACKed on_search for transaction " +
          "b4f1e2a0-0000-4000-8000-000000000001: " +
          PII_PROSE,
      }),
    );

    const [record] = sink.emitted;
    expect(record?.kind).toBe("JOURNAL");

    const summary = record?.event?.summary ?? "";
    // Pseudonymised rather than blanked, so two lines about the same run still
    // correlate inside the mirror — which is most of what a live view is for.
    expect(summary).not.toContain("b4f1e2a0-0000-4000-8000-000000000001");
    expect(summary).toContain("id_");
    expect(summary).toContain("<email>");
    expect(summary).toContain("<phone>");

    expectNoPii(record);
  });

  it("keeps handles, JSONPaths and protocol vocabulary verbatim", () => {
    // These are safe by construction and the mirror is worth much less without
    // them: `payload_id` is a handle not a body, and a JSONPath says *where* a
    // value is, never what it was — the same reason `feedback.redact.ts` keeps
    // `json_path` untouched.
    const { mirror, sink } = service();

    mirror.onSessionEvent(
      SESSION,
      event({
        kind: "OUTBOUND_SENT",
        ack: "ACK",
        payload_id: "payload-handle-1",
        overrides: ["$.context.bpp_uri"],
        nack_code: undefined,
        summary: "sent select",
      }),
    );

    expect(sink.emitted[0]?.event).toMatchObject({
      kind: "OUTBOUND_SENT",
      action: "on_search",
      ack: "ACK",
      payload_id: "payload-handle-1",
      overrides: ["$.context.bpp_uri"],
    });
  });

  it("carries expires_at on SESSION_CREATED, because expiry is unobservable", () => {
    // `CacheStore` TTL expiry is silent by design and has no eviction callback,
    // so this is the **only** way a consumer can learn when a session ended.
    const { mirror, sink } = service();
    mirror.noteSessionCreated(session());

    const [record] = sink.emitted;
    expect(record?.kind).toBe("SESSION_CREATED");
    expect(record?.session).toMatchObject({
      domain: "ONDC:TRV11",
      version: "2.0.0",
      usecase: "METRO",
      mock_role: "BAP",
      np_type: "BPP",
      interaction_mode: "llm_auto",
      auto_advance: true,
      created_at: "2026-08-17T08:00:00.000Z",
      expires_at: "2026-08-19T08:00:00.000Z",
    });
  });

  it("names the participant with the pseudonym an issue report would use", () => {
    // The join: a mirror document and a report about one participant have to
    // line up without either naming them, which only works if both derive from
    // the same salt with the same key.
    const { mirror, sink } = service();
    mirror.noteSessionCreated(session());

    expect(sink.emitted[0]?.session?.subscriber_ref).toBe(
      pseudonymise("https://np.example.com", SALT, "np"),
    );
    // And never the URL itself — a subscriber hostname identifies a company.
    expect(JSON.stringify(sink.emitted)).not.toContain("np.example.com");
  });

  it("gives every record a stable, pseudonymised session_ref", () => {
    const { mirror, sink } = service();
    mirror.noteSessionCreated(session());
    mirror.noteRunStarted(SESSION, {
      flowId: "flow-1",
      attempt: 1,
      autoAdvance: true,
      startedAt: NOW.toISOString(),
    });
    mirror.onSessionEvent(SESSION, event());

    const expected = pseudonymise(SESSION, SALT, "sess");
    expect(sink.emitted.map((entry) => entry.session_ref)).toEqual([
      expected,
      expected,
      expected,
    ]);
    // Present regardless of the correlation flag: it is the join key for a
    // session's records, and it is one whether or not the clear id is there.
    expect(sink.emitted.every((entry) => entry.correlation === undefined)).toBe(
      true,
    );
    expect(JSON.stringify(sink.emitted)).not.toContain(SESSION);
  });

  it("adds clear ids only under the correlation flag", () => {
    const { mirror, sink } = service(true);
    mirror.onSessionEvent(
      SESSION,
      event({ transaction_id: "txn-abc", summary: "refused" }),
    );

    expect(sink.emitted[0]?.correlation).toEqual({
      session_id: SESSION,
      transaction_id: "txn-abc",
    });
    // The pseudonym is still there alongside it. That is the intended result:
    // its job was never to protect a UUID we minted, it was to keep the
    // participant unlinkable and the corpus internally consistent.
    expect(sink.emitted[0]?.session_ref).toBe(
      pseudonymise(SESSION, SALT, "sess"),
    );
  });

  it("records a run that started, which nothing journals", () => {
    const { mirror, sink } = service();
    mirror.noteRunStarted(SESSION, {
      flowId: "flow-1",
      attempt: 2,
      autoAdvance: false,
      startedAt: "2026-08-17T08:30:00.000Z",
    });

    expect(sink.emitted[0]).toMatchObject({
      kind: "RUN_STARTED",
      instance_id: "proc_test",
      run: {
        flow_id: "flow-1",
        attempt: 2,
        auto_advance: false,
        started_at: "2026-08-17T08:30:00.000Z",
      },
    });
  });

  it("absorbs a sink that throws rather than failing its caller", () => {
    // Two of the three taps are on somebody's hot path, and `RecordService`
    // only guards one of them. A mirror that threw out of `createSession` would
    // fail a tool call over telemetry.
    const mirror = new MirrorService({
      sink: {
        emit: () => {
          throw new Error("sink exploded");
        },
        close: () => Promise.resolve(),
      },
      salt: SALT,
      logger: logger.child({ silent: true }),
    });

    expect(() => mirror.noteSessionCreated(session())).not.toThrow();
    expect(() => mirror.onSessionEvent(SESSION, event())).not.toThrow();
  });
});
