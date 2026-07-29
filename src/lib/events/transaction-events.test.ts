import { describe, expect, it } from "vitest";
import { TransactionEvents } from "@/lib/events/transaction-events.js";

describe("TransactionEvents", () => {
  it("wakes a waiter when a newer event arrives", async () => {
    const events = new TransactionEvents();
    const pending = events.waitFor("txn::np", {
      afterSeq: 0,
      timeoutMs: 5_000,
    });

    expect(events.waiterCount("txn::np")).toBe(1);
    events.notify("txn::np", { seq: 1, kind: "INBOUND", action: "on_search" });

    await expect(pending).resolves.toMatchObject({
      seq: 1,
      action: "on_search",
    });
    expect(events.waiterCount("txn::np")).toBe(0);
  });

  it("ignores events the waiter has already seen", async () => {
    const events = new TransactionEvents();
    const pending = events.waitFor("txn::np", { afterSeq: 3, timeoutMs: 200 });

    // Replayed / stale notifications must not resolve a waiter that is
    // already past them, or the model loops on the same event forever.
    events.notify("txn::np", { seq: 2, kind: "INBOUND" });
    events.notify("txn::np", { seq: 3, kind: "INBOUND" });

    await expect(pending).resolves.toBeUndefined();
  });

  it("resolves undefined on timeout so the model can long-poll", async () => {
    const events = new TransactionEvents();
    await expect(
      events.waitFor("txn::np", { afterSeq: 0, timeoutMs: 50 }),
    ).resolves.toBeUndefined();
    expect(events.waiterCount("txn::np")).toBe(0);
  });

  it("keys waiters independently", async () => {
    const events = new TransactionEvents();
    const a = events.waitFor("a", { afterSeq: 0, timeoutMs: 5_000 });
    const b = events.waitFor("b", { afterSeq: 0, timeoutMs: 100 });

    events.notify("a", { seq: 1, kind: "OUTBOUND" });

    await expect(a).resolves.toMatchObject({ kind: "OUTBOUND" });
    await expect(b).resolves.toBeUndefined();
  });

  it("wakes every eligible waiter on one event", async () => {
    const events = new TransactionEvents();
    const first = events.waitFor("k", { afterSeq: 0, timeoutMs: 5_000 });
    const second = events.waitFor("k", { afterSeq: 0, timeoutMs: 5_000 });

    events.notify("k", { seq: 7, kind: "FORM_SUBMITTED" });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { seq: 7, kind: "FORM_SUBMITTED" },
      { seq: 7, kind: "FORM_SUBMITTED" },
    ]);
  });

  it("releases parked waiters on close", async () => {
    const events = new TransactionEvents();
    const pending = events.waitFor("k", { afterSeq: 0, timeoutMs: 60_000 });

    events.close();

    await expect(pending).resolves.toBeUndefined();
    expect(events.waiterCount("k")).toBe(0);
  });

  it("notify on a key nobody waits on is a no-op", () => {
    const events = new TransactionEvents();
    expect(() => {
      events.notify("nobody", { seq: 1, kind: "INBOUND" });
    }).not.toThrow();
  });
});
