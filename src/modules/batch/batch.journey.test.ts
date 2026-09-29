import { describe, expect, it } from "vitest";
import {
  assembleJourney,
  summariseOrder,
} from "@/modules/batch/batch.journey.js";

const exchange = (
  payloadId: string,
  direction: "outbound" | "inbound",
  seq: number,
) => ({
  payloadId,
  direction,
  messageId: `m${String(seq)}`,
  timestamp: `2026-01-01T00:00:0${String(seq)}.000Z`,
  seq,
});

describe("assembleJourney", () => {
  const steps = [
    {
      key: "search1",
      action: "search",
      owner: "BAP" as const,
      status: "COMPLETE",
      ack: "ACK",
      payload_ids: ["p1"],
    },
    {
      key: "on_search1",
      action: "on_search",
      owner: "BPP" as const,
      status: "COMPLETE",
      ack: "ACK",
      payload_ids: ["p2"],
    },
    {
      key: "select",
      action: "select",
      owner: "BAP" as const,
      status: "WAITING",
      payload_ids: [],
    },
  ];
  const exchanges = [
    exchange("p1", "outbound", 1),
    exchange("p2", "inbound", 2),
  ];

  it("lists what happened, in order, with direction and ACK, and skips steps with no payload", () => {
    const journey = assembleJourney({ steps, exchanges });
    expect(journey.map((j) => j.step_key)).toEqual(["search1", "on_search1"]);
    expect(journey[0]).toMatchObject({
      n: 1,
      from: "BAP",
      to: "BPP",
      direction: "sent",
      ack: "ACK",
      message_id: "m1",
    });
    expect(journey[1]).toMatchObject({
      n: 2,
      from: "BPP",
      to: "BAP",
      direction: "received",
    });
    expect(journey[0]?.payload).toBeUndefined();
  });

  it("attaches bodies only when given, and caps them", () => {
    const bodies = new Map<string, unknown>([
      ["p1", { big: "x".repeat(5_000) }],
      ["p2", { ok: 1 }],
    ]);
    const journey = assembleJourney({
      steps,
      exchanges,
      bodies,
      maxPayloadBytes: 1_000,
    });
    expect(journey[0]?.payload_truncated).toBe(true);
    expect(journey[1]?.payload).toEqual({ ok: 1 });
  });

  it("marks a step whose payload was repaired by an override", () => {
    const journey = assembleJourney({
      steps,
      exchanges: [
        { ...exchange("p1", "outbound", 1), overrides: ["$.context.bpp_uri"] },
        exchange("p2", "inbound", 2),
      ],
    });
    expect(journey[0]?.patched_paths).toEqual(["$.context.bpp_uri"]);
  });
});

describe("summariseOrder", () => {
  it("reads id, status, payment, total, items and fulfillment state", () => {
    const summary = summariseOrder({
      stepKey: "on_status",
      body: {
        message: {
          order: {
            id: "o1",
            status: "COMPLETED",
            items: [{ id: "I1", quantity: { selected: { count: 2 } } }],
            payments: [{ status: "PAID" }],
            quote: { price: { value: "40", currency: "INR" } },
            fulfillments: [{ state: { descriptor: { code: "COMPLETED" } } }],
          },
        },
      },
    });
    expect(summary).toEqual({
      order_id: "o1",
      order_status: "COMPLETED",
      payment_status: "PAID",
      total: "40",
      currency: "INR",
      items: [{ id: "I1", count: 2 }],
      fulfillment_state: "COMPLETED",
      from_step: "on_status",
    });
  });

  it("is undefined when no payload describes an order", () => {
    expect(summariseOrder(undefined)).toBeUndefined();
    expect(
      summariseOrder({ stepKey: "search", body: { message: { intent: {} } } }),
    ).toBeUndefined();
  });
});
