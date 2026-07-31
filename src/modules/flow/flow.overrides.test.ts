import { describe, expect, it } from "vitest";
import {
  applyOverrides,
  MAX_OVERRIDES,
  MAX_OVERRIDE_VALUE_BYTES,
  suggestOverrides,
} from "@/modules/flow/flow.overrides.js";

/**
 * The file that decides what a model may do to a generated payload.
 *
 * Everything here is pure, so this is where the rules live rather than in the
 * loop tests: a wrong answer in `applyOverrides` reaches a third party's wire
 * and nothing downstream catches it.
 */

function payload(): Record<string, unknown> {
  return {
    context: {
      action: "search",
      transaction_id: "txn-1",
      bpp_uri: ["https://np.example.com/seller"],
    },
    message: {
      intent: { stops: [{ code: "A" }, { code: "B" }] },
    },
  };
}

describe("applyOverrides — the case it was built for", () => {
  it("repairs the field a config failed to unwrap", () => {
    // Live TRV11 `search2_METRO_201`: `context.bpp_uri = sessionData?.bppUri`
    // with no `[0]`, so a list reaches a field the schema types as a string.
    const body = payload();

    const result = applyOverrides(body, {
      "$.context.bpp_uri": "https://np.example.com/seller",
    });

    expect(result.problems).toEqual([]);
    expect(result.applied).toEqual([
      {
        path: "$.context.bpp_uri",
        value: "https://np.example.com/seller",
      },
    ]);
    expect((body["context"] as Record<string, unknown>)["bpp_uri"]).toBe(
      "https://np.example.com/seller",
    );
  });

  it("supplies a field the config omitted entirely", () => {
    // Not only correction: a generator that assigns `undefined` deletes the
    // field the default payload had right, and the fix is to put it back.
    const body = payload();

    const result = applyOverrides(body, { "$.context.bpp_id": "np.example.com" });

    expect(result.problems).toEqual([]);
    expect((body["context"] as Record<string, unknown>)["bpp_id"]).toBe(
      "np.example.com",
    );
  });

  it("writes into an array by index", () => {
    // `jsonpath.stringify(["$","message",...,"0"])` is `["0"]` — an object key,
    // not an element — so numeric components have to survive as numbers.
    const body = payload();

    const result = applyOverrides(body, {
      "$.message.intent.stops[0].code": "PATCHED",
    });

    expect(result.problems).toEqual([]);
    const stops = (
      (body["message"] as Record<string, unknown>)["intent"] as Record<
        string,
        unknown
      >
    )["stops"] as { code: string }[];
    expect(stops[0]?.code).toBe("PATCHED");
    expect(stops[1]?.code).toBe("B");
    expect(Array.isArray(stops)).toBe(true);
  });
});

describe("applyOverrides — what it refuses", () => {
  it("refuses the transaction id by name, however it is spelled", () => {
    // It keys every record and expectation for the run. `#assertTransactionId`
    // exists to undo a *config* that rewrites it; doing it deliberately would
    // leave the receiver writing to one half of a transaction while the loop
    // tools read the other.
    for (const path of [
      "$.context.transaction_id",
      "$['context']['transaction_id']",
    ]) {
      const body = payload();
      const result = applyOverrides(body, { [path]: "somebody-elses-id" });

      expect(result.applied).toEqual([]);
      expect(result.problems[0]?.path).toBe(path);
      expect(result.problems[0]?.reason).toContain("flow_restart");
      expect((body["context"] as Record<string, unknown>)["transaction_id"]).toBe(
        "txn-1",
      );
    }
  });

  it("allows action and message_id, because that is negative testing", () => {
    // Making a payload disagree with itself is a stated goal of this server.
    // It costs a NACK from the counterparty and breaks nothing of ours.
    const body = payload();

    const result = applyOverrides(body, { "$.context.action": "select" });

    expect(result.problems).toEqual([]);
    expect((body["context"] as Record<string, unknown>)["action"]).toBe("select");
  });

  it.each([
    ["$.message.intent.stops[*].code", "wildcard"],
    ["$..code", "descendant"],
    ["$.message.intent.stops[?(@.code=='A')].code", "filter"],
    ["$.message.intent.stops[0:1]", "slice"],
  ])("refuses %s, which selects a set", (path) => {
    // `jsonpath.value` writes to the first match only, silently. A patch that
    // half-lands is worse than one that is refused: the model cannot see which
    // half landed.
    const body = payload();

    const result = applyOverrides(body, { [path]: "X" });

    expect(result.applied).toEqual([]);
    expect(result.problems[0]?.reason).toContain("selects a set");
  });

  it("refuses a malformed path as a problem, never a throw", () => {
    const result = applyOverrides(payload(), { $$$nonsense: "X" });

    expect(result.applied).toEqual([]);
    expect(result.problems[0]?.reason).toContain("not a valid JSONPath");
  });

  it("refuses two spellings of one field", () => {
    // They would otherwise apply in object-key order, which is not an order the
    // caller chose.
    const result = applyOverrides(payload(), {
      "$.context.bpp_uri": "first",
      "$['context']['bpp_uri']": "second",
    });

    expect(result.applied).toEqual([]);
    expect(result.problems[0]?.reason).toContain("same field");
  });

  it("refuses a value too large to be a repair", () => {
    const result = applyOverrides(payload(), {
      "$.message.catalog": "x".repeat(MAX_OVERRIDE_VALUE_BYTES + 1),
    });

    expect(result.applied).toEqual([]);
    expect(result.problems[0]?.reason).toContain("does not supply a message body");
  });

  it("refuses more paths than a broken field could need", () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_OVERRIDES + 1 }, (_, i) => [
        `$.message.f${String(i)}`,
        i,
      ]),
    );

    const result = applyOverrides(payload(), many);

    expect(result.applied).toEqual([]);
    expect(result.problems[0]?.reason).toContain("wrong flow");
  });
});

describe("applyOverrides — all or nothing", () => {
  it("writes none of them when one is refused", () => {
    /*
     * The property that matters most here. A partial application would leave
     * the payload in a state nobody asked for, `applied` describing something
     * other than what happened, and the *next* call regenerating from a body
     * this one had already mutated.
     */
    const body = payload();

    const result = applyOverrides(body, {
      "$.context.bpp_uri": "https://np.example.com/seller",
      "$.context.transaction_id": "somebody-elses-id",
    });

    expect(result.applied).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect((body["context"] as Record<string, unknown>)["bpp_uri"]).toEqual([
      "https://np.example.com/seller",
    ]);
  });

  it("does nothing at all when given nothing", () => {
    const body = payload();
    const before = JSON.stringify(body);

    const result = applyOverrides(body, {});

    expect(result).toEqual({ applied: [], problems: [] });
    expect(JSON.stringify(body)).toBe(before);
  });
});

describe("suggestOverrides", () => {
  it("names the findings' own paths", () => {
    const suggestion = suggestOverrides([
      { json_path: "$.context.bpp_uri" },
      { json_path: "$.context.location.city.code" },
    ]);

    expect(suggestion).toContain('"$.context.bpp_uri"');
    expect(suggestion).toContain('"$.context.location.city.code"');
    // The gate is not being bypassed, and saying so is half the point.
    expect(suggestion).toContain("still blocks");
  });

  it("leaves out a path an override would be refused for", () => {
    // Suggesting it and then refusing it would cost a round trip and read as
    // the tool contradicting itself.
    const suggestion = suggestOverrides([
      { json_path: "$.context.transaction_id" },
      { json_path: "$.context.bpp_uri" },
    ]);

    expect(suggestion).not.toContain("transaction_id");
    expect(suggestion).toContain("bpp_uri");
  });

  it("says nothing when no finding carries a usable path", () => {
    expect(suggestOverrides([{ json_path: undefined }, {}])).toBeUndefined();
    expect(suggestOverrides([])).toBeUndefined();
  });
});
