import { describe, expect, it } from "vitest";
import {
  buildOnConfirm,
  completionUrl,
  partiesFromOnConfirm,
  postOnComplete,
} from "@/modules/batch/batch.on-complete.js";

const order = {
  order_id: "ord-42",
  order_status: "COMPLETED",
  payment_status: "PAID",
  total: "180.00",
  currency: "INR",
  from_step: "on_confirm_METRO_200",
};

describe("buildOnConfirm", () => {
  it("fills the on_confirm body from this order's own data", () => {
    const body = buildOnConfirm({
      domain: "ONDC:TRV11",
      version: "2.0.0",
      transactionId: "txn-1",
      bapId: "mock-bap.local",
      bppId: "mock-bpp.local",
      bppUri: "https://seller.example.com/ONDC:TRV11/2.0.0/seller",
      order,
      now: new Date("2026-10-06T10:00:00.000Z"),
    }) as {
      context: Record<string, unknown>;
      message: { order: Record<string, unknown> };
    };

    expect(body.context).toMatchObject({
      domain: "ONDC:TRV11",
      action: "on_confirm",
      transaction_id: "txn-1",
      timestamp: "2026-10-06T10:00:00.000Z",
      bap_id: "mock-bap.local",
      bpp_id: "mock-bpp.local",
      bpp_uri: "https://seller.example.com/ONDC:TRV11/2.0.0/seller",
      ttl: "P2D",
    });
    expect(body.message.order).toMatchObject({
      id: "ord-42",
      state: "Completed",
      quote: { price: { value: "180.00", currency: "INR" } },
    });
    expect(body.message.order["payments"]).toEqual([
      expect.objectContaining({
        status: "PAID",
        params: { amount: "180.00", currency: "INR", transaction_id: "txn-1" },
      }),
    ]);
  });

  it("leaves out what the batch does not know, rather than inventing it", () => {
    const body = buildOnConfirm({
      domain: "ONDC:TRV11",
      version: "2.0.0",
      transactionId: "txn-2",
      order: { order_id: "ord-9", order_status: "COMPLETED" },
    }) as {
      context: Record<string, unknown>;
      message: { order: Record<string, unknown> };
    };

    expect(body.context).not.toHaveProperty("bap_id");
    expect(body.context).not.toHaveProperty("bpp_uri");
    expect(body.message.order).not.toHaveProperty("quote");
  });
});

describe("postOnComplete", () => {
  it("POSTs the body as JSON to the configured URL", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake: typeof fetch = (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(new Response("ok", { status: 200 }));
    };

    await postOnComplete("https://hook.example.com/complete", { a: 1 }, fake);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://hook.example.com/complete");
    expect(calls[0]?.init.method).toBe("POST");
    const sent = calls[0]?.init.body;
    expect(typeof sent === "string" ? JSON.parse(sent) : undefined).toEqual({
      a: 1,
    });
  });

  it("throws on a non-2xx answer, so the caller can log it", async () => {
    const fake: typeof fetch = () =>
      Promise.resolve(new Response("no", { status: 500 }));
    await expect(
      postOnComplete("https://hook.example.com/complete", {}, fake),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("partiesFromOnConfirm", () => {
  const onConfirmBody = {
    context: {
      bap_id: "buyer.example.com",
      bap_uri: "https://buyer.example.com/ONDC:TRV11/2.0.0/buyer",
      bpp_id: "seller.example.com",
      bpp_uri: "https://seller.example.com/ONDC:TRV11/2.0.0/seller",
    },
  };

  it("reads all four party fields from the on_confirm", () => {
    const rows = [{ key: "on_confirm_METRO_200", payload_ids: ["p1"] }];
    const bodies = new Map<string, unknown>([["p1", onConfirmBody]]);
    expect(partiesFromOnConfirm(rows, bodies)).toEqual({
      bap_id: "buyer.example.com",
      bap_uri: "https://buyer.example.com/ONDC:TRV11/2.0.0/buyer",
      bpp_id: "seller.example.com",
      bpp_uri: "https://seller.example.com/ONDC:TRV11/2.0.0/seller",
    });
  });

  it("returns nothing when the order has no on_confirm", () => {
    const rows = [{ key: "on_init_METRO_200", payload_ids: ["p1"] }];
    const bodies = new Map<string, unknown>([["p1", onConfirmBody]]);
    expect(partiesFromOnConfirm(rows, bodies)).toBeUndefined();
  });

  it("returns nothing when any one of the four is missing", () => {
    const partial = { context: { bap_id: "b", bap_uri: "u", bpp_id: "s" } };
    const rows = [{ key: "on_confirm_METRO_200", payload_ids: ["p1"] }];
    const bodies = new Map<string, unknown>([["p1", partial]]);
    expect(partiesFromOnConfirm(rows, bodies)).toBeUndefined();
  });
});

describe("completionUrl", () => {
  it("appends the on_confirm route to the configured base", () => {
    expect(completionUrl("https://dev-workbench.ondc.tech")).toBe(
      "https://dev-workbench.ondc.tech/rsf-api/api/inbound/on_confirm",
    );
  });

  it("carries the settlement terms the receiving end requires", () => {
    const body = buildOnConfirm({
      domain: "ONDC:TRV11",
      version: "2.0.0",
      transactionId: "txn-3",
      order: {
        order_id: "ord-3",
        order_status: "COMPLETED",
        total: "120.00",
        currency: "INR",
      },
    }) as { message: { order: { payments: { tags: unknown }[] } } };
    expect(JSON.stringify(body.message.order.payments[0]?.tags)).toContain(
      "SETTLEMENT_AMOUNT",
    );
    expect(JSON.stringify(body.message.order.payments[0]?.tags)).toContain(
      "NEFT",
    );
  });

  it("does not double the slash when the base ends with one", () => {
    expect(completionUrl("https://dev-workbench.ondc.tech/")).toBe(
      "https://dev-workbench.ondc.tech/rsf-api/api/inbound/on_confirm",
    );
  });
});
