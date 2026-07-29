import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryCacheStore } from "@/lib/cache/in-memory-cache-store.js";
import { FlowRepository } from "@/modules/flow/flow.repository.js";
import { FlowBinding } from "@/modules/flow/flow.schema.js";
import { flowRunKey } from "@/modules/record/record.repository.js";

/**
 * The binding is what a caller holds while a run has no `transaction_id` — the
 * window that exists because that id belongs to whoever sends the flow's first
 * action, and may therefore be the participant's to choose.
 */

const SESSION = "sess-1";
const FLOW = "Runnable_Loop";

let cache: InMemoryCacheStore;
let repository: FlowRepository;

beforeEach(() => {
  cache = new InMemoryCacheStore({ sweepIntervalMs: 0 });
  repository = new FlowRepository({ cache, transactionTtlMs: 60_000 });
});

/** A first-attempt binding, with only the fields a test cares about named. */
function binding(overrides: Partial<FlowBinding> = {}): FlowBinding {
  return {
    sessionId: SESSION,
    flowId: FLOW,
    autoAdvance: false,
    startedAt: new Date().toISOString(),
    attempt: 1,
    previousAttempts: [],
    ...overrides,
  };
}

describe("FlowRepository", () => {
  it("stores a run with no transaction id at all", async () => {
    await repository.saveBinding(binding());

    const found = await repository.findBinding(SESSION, FLOW);

    expect(found).toMatchObject({ sessionId: SESSION, flowId: FLOW });
    // Absent, not empty. A blank id would key reads at a place nothing lives
    // and read back as an ordinary miss.
    expect(found?.transactionId).toBeUndefined();
    expect(FlowBinding.parse(found)).toBeDefined();
  });

  it("binds an id later, without disturbing when the run started", async () => {
    const startedAt = "2026-01-01T00:00:00.000Z";
    await repository.saveBinding(binding({ autoAdvance: true, startedAt }));

    const before = await repository.findBinding(SESSION, FLOW);
    await repository.saveBinding({
      ...(before as FlowBinding),
      transactionId: "np-chosen-txn",
    });

    expect(await repository.findBinding(SESSION, FLOW)).toMatchObject({
      transactionId: "np-chosen-txn",
      autoAdvance: true,
      startedAt,
    });
  });

  it("keys on the same string the event bus parks on", async () => {
    // Load-bearing: `flow_await` on an unbound run parks on `flowRunKey`, and
    // the callback that binds the run publishes under it. Two spellings would
    // mean the waiter never wakes.
    await repository.saveBinding(binding());

    expect(await cache.has(flowRunKey(SESSION, FLOW))).toBe(true);
    expect(flowRunKey(SESSION, FLOW)).toBe(`flow_run::${SESSION}::${FLOW}`);
  });

  it("scopes a run to its session, so two sessions on one flow do not collide", async () => {
    await repository.saveBinding(binding({ transactionId: "txn-a" }));
    await repository.saveBinding(
      binding({ sessionId: "sess-2", transactionId: "txn-b" }),
    );

    expect((await repository.findBinding(SESSION, FLOW))?.transactionId).toBe(
      "txn-a",
    );
    expect((await repository.findBinding("sess-2", FLOW))?.transactionId).toBe(
      "txn-b",
    );
  });

  it("answers undefined for a run nobody started", async () => {
    expect(await repository.findBinding(SESSION, "never_started")).toBeUndefined();
  });

  it("round-trips the attempt archive a restart leaves behind", async () => {
    await repository.saveBinding(
      binding({
        attempt: 2,
        previousAttempts: [
          {
            attempt: 1,
            transactionId: "txn-first-try",
            startedAt: "2026-01-01T00:00:00.000Z",
            abandonedAt: "2026-01-01T00:05:00.000Z",
            reason: "select was NACKed",
          },
        ],
      }),
    );

    const found = await repository.findBinding(SESSION, FLOW);

    expect(found?.attempt).toBe(2);
    expect(found?.previousAttempts).toHaveLength(1);
    expect(found?.previousAttempts[0]).toMatchObject({
      transactionId: "txn-first-try",
      reason: "select was NACKed",
    });
    expect(FlowBinding.parse(found)).toBeDefined();
  });

  it("returns a restarted run to genuinely unbound, not to a blank id", async () => {
    // The whole point of a restart: the run must read as if its first action
    // had never crossed the wire, so the next one mints a fresh id. A binding
    // written with `transactionId: undefined` would survive here and *vanish*
    // through Redis's JSON round trip — omitting the key is what makes the two
    // stores agree.
    await repository.saveBinding(binding({ transactionId: "txn-first-try" }));
    await repository.saveBinding(binding({ attempt: 2 }));

    const found = await repository.findBinding(SESSION, FLOW);

    expect(found?.transactionId).toBeUndefined();
    expect(Object.hasOwn(found as object, "transactionId")).toBe(false);
  });

  it("defaults the attempt fields for a binding stored before they existed", async () => {
    // Nothing parses what comes out of the store, so a binding written by an
    // older process against a shared Redis arrives without them. Left raw,
    // `attempt + 1` is NaN and every attempt looks like every other.
    await cache.set(
      flowRunKey(SESSION, FLOW),
      {
        sessionId: SESSION,
        flowId: FLOW,
        autoAdvance: false,
        startedAt: "2026-01-01T00:00:00.000Z",
      },
      60_000,
    );

    const found = await repository.findBinding(SESSION, FLOW);

    expect(found?.attempt).toBe(1);
    expect(found?.previousAttempts).toEqual([]);
  });
});
