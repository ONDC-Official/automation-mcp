import { describe, expect, it } from "vitest";
import {
  buildCompletedOnConfirm,
  completionUrl,
  onConfirmBody,
  partiesFromOnConfirm,
  postOnComplete,
} from "@/modules/batch/batch.on-complete.js";

const sellerOnConfirm = {
  context: {
    domain: "ONDC:TRV11",
    country: "IND",
    city: "std:080",
    action: "on_confirm",
    core_version: "2.0.0",
    bap_id: "buyer.example.com",
    bap_uri: "https://buyer.example.com/ONDC:TRV11/2.0.0/buyer",
    bpp_id: "seller.example.com",
    bpp_uri: "https://seller.example.com/ONDC:TRV11/2.0.0/seller",
    transaction_id: "txn-1",
    message_id: "seller-msg",
    timestamp: "2026-10-06T10:00:00.000Z",
    ttl: "PT30S",
  },
  message: {
    order: {
      id: "ord-42",
      state: "Accepted",
      provider: { id: "P1", descriptor: { name: "Metro Co" } },
      quote: { price: { value: "180.00", currency: "INR" } },
      payments: [
        {
          id: "PAY-1",
          status: "PAID",
          params: { amount: "180.00", currency: "INR" },
          tags: [
            {
              descriptor: { code: "SETTLEMENT_TERMS" },
              list: [
                { descriptor: { code: "SETTLEMENT_AMOUNT" }, value: "162.00" },
                { descriptor: { code: "SETTLEMENT_TYPE" }, value: "NEFT" },
              ],
            },
          ],
        },
      ],
    },
  },
};

describe("buildCompletedOnConfirm", () => {
  it("keeps every value from the seller's on_confirm and changes only what must change", () => {
    const body = buildCompletedOnConfirm(sellerOnConfirm, {
      transactionId: "txn-9",
      now: new Date("2026-10-06T12:00:00.000Z"),
    }) as {
      context: Record<string, unknown>;
      message: { order: Record<string, unknown> };
    };

    expect(body.context).toMatchObject({
      domain: "ONDC:TRV11",
      country: "IND",
      city: "std:080",
      core_version: "2.0.0",
      bap_id: "buyer.example.com",
      bpp_uri: "https://seller.example.com/ONDC:TRV11/2.0.0/seller",
      ttl: "PT30S",
      action: "on_confirm",
      transaction_id: "txn-9",
      timestamp: "2026-10-06T12:00:00.000Z",
    });
    expect(body.context["message_id"]).not.toBe("seller-msg");
    expect(body.message.order).toMatchObject({
      id: "ord-42",
      state: "Completed",
      provider: { id: "P1", descriptor: { name: "Metro Co" } },
      quote: { price: { value: "180.00", currency: "INR" } },
    });
    expect(JSON.stringify(body.message.order["payments"])).toContain("162.00");
  });

  it("returns nothing when the on_confirm has no order", () => {
    expect(
      buildCompletedOnConfirm({ context: {} }, { transactionId: "t" }),
    ).toBeUndefined();
  });
});

describe("onConfirmBody", () => {
  it("returns the newest on_confirm the order recorded", () => {
    const rows = [
      { key: "on_confirm_METRO_200", payload_ids: ["p1"] },
      { key: "on_status_METRO_200", payload_ids: ["p2"] },
    ];
    const bodies = new Map<string, unknown>([
      ["p1", sellerOnConfirm],
      ["p2", { context: {}, message: {} }],
    ]);
    expect(onConfirmBody(rows, bodies)).toEqual(sellerOnConfirm);
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

  it("does not double the slash when the base ends with one", () => {
    expect(completionUrl("https://dev-workbench.ondc.tech/")).toBe(
      "https://dev-workbench.ondc.tech/rsf-api/api/inbound/on_confirm",
    );
  });
});
