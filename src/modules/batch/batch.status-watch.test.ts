import { describe, expect, it } from "vitest";
import { OrderStatusWatch } from "@/modules/batch/batch.status-watch.js";
import type { SessionEvent } from "@/modules/record/record.schema.js";

const event = (overrides: Partial<SessionEvent>): SessionEvent =>
  ({
    seq: 1,
    at: "2026-10-06T10:00:00.000Z",
    kind: "INBOUND_ACK",
    transaction_id: "txn-1",
    action: "on_status",
    ack: "ACK",
    ...overrides,
  }) as SessionEvent;

describe("OrderStatusWatch", () => {
  it("tells the batch service when an accepted on_status lands", () => {
    const seen: [string, string][] = [];
    const watch = new OrderStatusWatch();
    watch.attach((sessionId, transactionId) =>
      seen.push([sessionId, transactionId]),
    );

    watch.onSessionEvent("sess-1", event({}));

    expect(seen).toEqual([["sess-1", "txn-1"]]);
  });

  it("ignores other actions, NACKs and events without a transaction", () => {
    const seen: [string, string][] = [];
    const watch = new OrderStatusWatch();
    watch.attach((sessionId, transactionId) =>
      seen.push([sessionId, transactionId]),
    );

    watch.onSessionEvent("sess-1", event({ action: "on_confirm" }));
    watch.onSessionEvent("sess-1", event({ kind: "INBOUND_NACK" }));
    watch.onSessionEvent("sess-1", event({ transaction_id: undefined }));

    expect(seen).toEqual([]);
  });

  it("never throws into the receiver, even if the target does", () => {
    const watch = new OrderStatusWatch();
    watch.attach(() => {
      throw new Error("boom");
    });
    expect(() => watch.onSessionEvent("sess-1", event({}))).not.toThrow();
  });
});
