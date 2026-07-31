import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCacheStore } from "@/lib/cache/in-memory-cache-store.js";
import { UpstreamError } from "@/lib/errors.js";
import { FeedbackRepository } from "@/modules/feedback/feedback.repository.js";
import { FeedbackService } from "@/modules/feedback/feedback.service.js";
import { NoopSink } from "@/modules/feedback/feedback.sink.js";
import { FlowRepository } from "@/modules/flow/flow.repository.js";
import { RecordRepository } from "@/modules/record/record.repository.js";
import { CacheSessionRepository } from "@/modules/session/session.repository.js";
import type { JournalEntry } from "@/modules/record/record.service.js";
import type { SessionEvent } from "@/modules/record/record.schema.js";
import { logger } from "@/lib/logger.js";

const SESSION = "sess-1";
const FLOW = "flow-1";

interface Harness {
  feedback: FeedbackService;
  repository: FeedbackRepository;
  sink: NoopSink;
  journalled: JournalEntry[];
  /** Capture is fire-and-forget; every assertion has to wait for it. */
  settle(): Promise<void>;
}

function harness(
  overrides: { enabled?: boolean; journal?: () => Promise<void> } = {},
): Harness {
  const cache = new InMemoryCacheStore();
  const repository = new FeedbackRepository({ cache, sessionTtlMs: 60_000 });
  const journalled: JournalEntry[] = [];

  const sink = new NoopSink();
  const feedback = new FeedbackService({
    repository,
    flows: new FlowRepository({ cache, transactionTtlMs: 60_000 }),
    records: new RecordRepository({
      cache,
      transactionTtlMs: 60_000,
      flowStatusTtlMs: 60_000,
      expectationTtlMs: 60_000,
      sessionTtlMs: 60_000,
    }),
    sessions: new CacheSessionRepository(cache),
    sink,
    journal: async (_sessionId, entry) => {
      journalled.push(entry);
      if (overrides.journal) await overrides.journal();
    },
    salt: "test-salt",
    enabled: overrides.enabled ?? true,
    logger: logger.child({ silent: true }),
  });

  return {
    feedback,
    repository,
    sink,
    journalled,
    settle: () => feedback.settled(),
  };
}

function event(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    seq: 1,
    at: "2026-07-30T11:00:00.000Z",
    kind: "INBOUND_NACK",
    nack_code: "OUT_OF_SEQUENCE",
    flow_id: FLOW,
    summary: "refused",
    ...overrides,
  };
}

describe("FeedbackService — capture", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("opens one incident from a journal line", async () => {
    h.feedback.onSessionEvent(SESSION, event());
    await h.settle();

    const [incident] = await h.feedback.list(SESSION);
    expect(incident?.trigger).toBe("INBOUND_NACK");
    expect(incident?.code).toBe("OUT_OF_SEQUENCE");
    expect(incident?.state).toBe("OPEN");
    expect(incident?.occurrences).toBe(1);
  });

  it("counts a repeat instead of opening a second incident", async () => {
    // Three retries of the same wrong guess are one story told three times, and
    // `occurrences` is what says how hard the model fought it.
    for (let i = 0; i < 3; i += 1) h.feedback.onSessionEvent(SESSION, event());
    await h.settle();

    const incidents = await h.feedback.list(SESSION);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.occurrences).toBe(3);
  });

  it("separates two different failures on the same step", async () => {
    h.feedback.noteOutcome(SESSION, FLOW, {
      outcome: "BLOCKED",
      message: "not ready",
      reason: "requirements_not_met",
      step_key: "select",
    });
    h.feedback.noteOutcome(SESSION, FLOW, {
      outcome: "BLOCKED",
      message: "cannot generate",
      reason: "generation_error",
      step_key: "select",
    });
    await h.settle();

    expect((await h.feedback.list(SESSION)).map((i) => i.code).sort()).toEqual([
      "generation_error",
      "requirements_not_met",
    ]);
  });

  it("records a thrown send failure, which produces no outcome at all", async () => {
    h.feedback.noteError(
      SESSION,
      FLOW,
      new UpstreamError("network-participant", "could not reach", {
        delivery: "unreachable",
      }),
      { stepKey: "search" },
    );
    await h.settle();

    const [incident] = await h.feedback.list(SESSION);
    expect(incident?.trigger).toBe("SEND_FAILED");
    expect(incident?.evidence.delivery).toBe("unreachable");
  });

  it("redacts evidence on the way in, not on the way out", async () => {
    // Nothing unredacted may sit in the store waiting for a flush that may
    // never come.
    h.feedback.noteOutcome(SESSION, FLOW, {
      outcome: "SENT",
      message: "sent",
      ack: "NACK",
      ack_body: {
        error: { code: "30001", message: "no account for 9876543210" },
      },
    });
    await h.settle();

    const [incident] = await h.feedback.list(SESSION);
    expect(incident?.evidence.message).toContain("<phone>");
    expect(JSON.stringify(incident)).not.toContain("9876543210");
  });
});

describe("FeedbackService — resolution is derived, never claimed", () => {
  async function openOn(h: Harness, action: string): Promise<void> {
    h.feedback.onSessionEvent(
      SESSION,
      event({ nack_code: "OUT_OF_SEQUENCE", action }),
    );
    await h.settle();
  }

  it("marks RECOVERED when the same action later succeeds", async () => {
    const h = harness();
    await openOn(h, "select");

    h.feedback.onSessionEvent(
      SESSION,
      event({ kind: "INBOUND_ACK", action: "select", nack_code: undefined }),
    );
    await h.settle();

    const [incident] = await h.feedback.list(SESSION);
    expect(incident?.state).toBe("RECOVERED");
    expect(incident?.resolved_at).toBeDefined();
  });

  it("leaves it open when a different action succeeds", async () => {
    // "The run moved on" is not "the step worked". A flow can advance past a
    // step that never went, and calling that a recovery turns the corpus's most
    // valuable column into noise.
    const h = harness();
    await openOn(h, "select");

    h.feedback.onSessionEvent(
      SESSION,
      event({ kind: "INBOUND_ACK", action: "on_search", nack_code: undefined }),
    );
    await h.settle();

    expect((await h.feedback.list(SESSION))[0]?.state).toBe("OPEN");
  });

  it("marks ABANDONED on flow_restart — the give-up signal", async () => {
    const h = harness();
    await openOn(h, "select");

    h.feedback.onSessionEvent(SESSION, event({ kind: "FLOW_RESTARTED" }));
    await h.settle();

    const abandoned = (await h.feedback.list(SESSION)).filter(
      (incident) => incident.trigger === "INBOUND_NACK",
    );
    expect(abandoned[0]?.state).toBe("ABANDONED");
  });

  it("marks everything still open RECOVERED when the flow completes", async () => {
    const h = harness();
    await openOn(h, "select");

    h.feedback.onSessionEvent(SESSION, event({ kind: "FLOW_COMPLETE" }));
    await h.settle();

    expect((await h.feedback.list(SESSION))[0]?.state).toBe("RECOVERED");
  });

  it("does not retract a validation finding just because the send worked", async () => {
    // The payload carried those findings whether or not the participant took
    // it. Retracting them would overstate how clean the run was.
    const h = harness();
    h.feedback.noteOutcome(SESSION, FLOW, {
      outcome: "SENT",
      message: "sent",
      action: "select",
      ack: "ACK",
      validation: {
        status: "invalid",
        findings: [
          {
            layer: "L1",
            code: "TTL_REQUIRED",
            json_path: "$.context.ttl",
            message: "missing",
          },
        ],
        checked: ["L0", "L1"],
        unchecked: [],
      },
    });
    await h.settle();

    h.feedback.onSessionEvent(
      SESSION,
      event({ kind: "OUTBOUND_SENT", ack: "ACK", action: "select" }),
    );
    await h.settle();

    expect((await h.feedback.list(SESSION))[0]?.state).toBe("OPEN");
  });

  it("re-opens an incident that recurs after being resolved", async () => {
    // The run got past it and then hit the same wall again, which is a worse
    // story than either half on its own.
    const h = harness();
    await openOn(h, "select");
    h.feedback.onSessionEvent(
      SESSION,
      event({ kind: "INBOUND_ACK", action: "select", nack_code: undefined }),
    );
    await h.settle();
    expect((await h.feedback.list(SESSION))[0]?.state).toBe("RECOVERED");

    await openOn(h, "select");

    const [incident] = await h.feedback.list(SESSION);
    expect(incident?.state).toBe("OPEN");
    expect(incident?.occurrences).toBe(2);
  });
});

describe("FeedbackService — the nudge", () => {
  it("journals ISSUE_OPEN once, on the first sighting only", async () => {
    const h = harness();

    for (let i = 0; i < 3; i += 1) h.feedback.onSessionEvent(SESSION, event());
    await h.settle();

    const opens = h.journalled.filter((entry) => entry.kind === "ISSUE_OPEN");
    expect(opens).toHaveLength(1);
    expect(opens[0]?.summary).toContain("feedback_submit_report");
  });

  it("never reacts to its own ISSUE_OPEN line", async () => {
    // The observer writes through the journal it observes. Without the guard
    // this recurses until the process dies, so it is asserted rather than
    // trusted to the reader.
    const h = harness();

    h.feedback.onSessionEvent(SESSION, event({ kind: "ISSUE_OPEN" }));
    await h.settle();

    expect(await h.feedback.list(SESSION)).toEqual([]);
    expect(h.journalled).toEqual([]);
  });
});

describe("FeedbackService — the report ships either way", () => {
  it("delivers an incident nobody ever narrated, with narration: null", async () => {
    // This is the guarantee the whole feature rests on. If shipping depended on
    // the model answering, "reports every time" would mean "reports whenever
    // the model remembered", which is the status quo it replaces.
    const h = harness();
    h.feedback.onSessionEvent(SESSION, event({ action: "select" }));
    await h.settle();

    await h.feedback.drain();

    expect(h.sink.delivered).toHaveLength(1);
    expect(h.sink.delivered[0]?.narration).toBeNull();
    expect(h.sink.delivered[0]?.incident.state).toBe("UNRESOLVED");
  });

  it("delivers on resolution, without waiting for shutdown", async () => {
    const h = harness();
    h.feedback.onSessionEvent(SESSION, event({ action: "select" }));
    await h.settle();

    h.feedback.onSessionEvent(
      SESSION,
      event({ kind: "INBOUND_ACK", action: "select", nack_code: undefined }),
    );
    await h.settle();

    expect(h.sink.delivered).toHaveLength(1);
    expect(h.sink.delivered[0]?.incident.state).toBe("RECOVERED");
  });

  it("never ships the same incident twice", async () => {
    // An incident can reach a terminal state more than once — an INBOUND_ACK
    // then a FLOW_COMPLETE — and a corpus with duplicates is worth much less.
    const h = harness();
    h.feedback.onSessionEvent(SESSION, event({ action: "select" }));
    await h.settle();

    h.feedback.onSessionEvent(
      SESSION,
      event({ kind: "INBOUND_ACK", action: "select", nack_code: undefined }),
    );
    await h.settle();
    h.feedback.onSessionEvent(SESSION, event({ kind: "FLOW_COMPLETE" }));
    await h.settle();
    await h.feedback.drain();

    expect(h.sink.delivered).toHaveLength(1);
  });

  it("carries the journal, scrubbed, and no payload values", async () => {
    const h = harness();
    h.feedback.noteOutcome(SESSION, FLOW, {
      outcome: "SENT",
      message: "sent",
      action: "confirm",
      ack: "NACK",
      ack_body: { error: { code: "30001", message: "no user 9876543210" } },
    });
    await h.settle();
    await h.feedback.drain();

    const [delivered] = h.sink.delivered;
    expect(delivered?.evidence.message).toContain("<phone>");
    expect(JSON.stringify(delivered)).not.toContain("9876543210");
    expect(delivered?.install_id).toMatch(/^inst_/);
  });
});

describe("FeedbackService — it cannot break its callers", () => {
  it("swallows a repository failure", async () => {
    const h = harness();
    vi.spyOn(h.repository, "save").mockRejectedValue(
      new Error("redis is down"),
    );

    expect(() => {
      h.feedback.onSessionEvent(SESSION, event());
    }).not.toThrow();
    await expect(h.settle()).resolves.toBeUndefined();
  });

  it("swallows a journal failure", async () => {
    // The nudge is best-effort by construction: the report ships regardless,
    // so a failed notification must not undo a captured incident.
    const h = harness({
      journal: () => Promise.reject(new Error("no journal")),
    });

    h.feedback.onSessionEvent(SESSION, event());
    await expect(h.settle()).resolves.toBeUndefined();
  });

  it("captures nothing at all when disabled", async () => {
    const h = harness({ enabled: false });

    h.feedback.onSessionEvent(SESSION, event());
    h.feedback.noteOutcome(SESSION, FLOW, {
      outcome: "BLOCKED",
      message: "x",
      reason: "generation_error",
    });
    await h.settle();

    expect(await h.feedback.list(SESSION)).toEqual([]);
    expect(h.journalled).toEqual([]);
  });
});
