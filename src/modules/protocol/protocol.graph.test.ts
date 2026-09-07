import { describe, expect, it } from "vitest";
import {
  allActions,
  entryActions,
  isRepeatable,
  isUnsolicited,
  mustEcho,
  realityFor,
  successorsOf,
  type ActionGraph,
} from "@/modules/protocol/protocol.graph.js";

/**
 * The literals below are `ONDC:TRV11/2.0.1`'s real `meta.supportedActions` and
 * `meta.apiProperties`, transcribed from a live fetch.
 *
 * Deliberately hand-written rather than read from `protocol-fixtures.ts`. That
 * fixture is `ONDC:FIS12/2.0.3` — faithfully captured, and faithfully *narrow*:
 * FIS12 publishes no self-looping action and no `transaction_partner`, so it
 * cannot exercise fan-out, unsolicited callbacks or the echo contract, which
 * are the three facts this file exists to pin. A unit test may invent; a
 * fixture may not.
 */
const TRV11: ActionGraph = {
  edges: {
    null: ["search", "select", "init"],
    search: ["on_search", "search"],
    on_search: ["search", "select", "init", "on_search"],
    select: ["on_select"],
    on_select: ["select", "init"],
    init: ["on_init"],
    on_init: ["init", "confirm"],
    confirm: ["on_confirm", "status"],
    on_confirm: [
      "confirm",
      "status",
      "cancel",
      "on_status",
      "update",
      "issue",
      "on_cancel",
    ],
    status: ["on_status"],
    on_status: ["status", "cancel", "issue", "on_status"],
  },
  properties: {
    search: { async_predecessor: null, transaction_partner: [] },
    on_search: { async_predecessor: null, transaction_partner: ["search"] },
    select: { async_predecessor: null, transaction_partner: [] },
    on_select: { async_predecessor: "select", transaction_partner: ["select"] },
    init: { async_predecessor: null, transaction_partner: [] },
    on_init: { async_predecessor: "init", transaction_partner: ["init"] },
    confirm: {
      async_predecessor: null,
      transaction_partner: ["init", "on_init"],
    },
    on_confirm: {
      async_predecessor: "confirm",
      transaction_partner: ["init", "on_init", "confirm"],
    },
    status: {
      async_predecessor: null,
      transaction_partner: ["init", "on_init", "confirm"],
    },
    on_status: {
      async_predecessor: null,
      transaction_partner: ["init", "on_init", "confirm"],
    },
  },
};

describe("the action graph", () => {
  it("reads the entry set from the literal 'null' key", () => {
    // A JSON object key cannot be null, so upstream serialises it as the
    // four-character string. Reading it as a missing entry loses the whole
    // entry-point set — and with it the fact that a transaction need not open
    // at `search`.
    expect(entryActions(TRV11)).toEqual(["search", "select", "init"]);
    expect(allActions(TRV11)).not.toContain("null");
  });

  it("marks a self-looping action repeatable — this is catalogue fan-out", () => {
    // One `search` reaches many sellers through the gateway; each answers
    // separately. A flow shows one `on_search` step, so nothing else in this
    // server would ever tell a model to expect N.
    expect(isRepeatable(TRV11, "on_search")).toBe(true);
    expect(isRepeatable(TRV11, "on_status")).toBe(true);
    expect(isRepeatable(TRV11, "on_confirm")).toBe(false);
  });

  it("marks a callback unsolicited only when nothing pairs with it", () => {
    // `on_status` has no async_predecessor: a seller may send one whenever the
    // order changes, days later, with no `status` from us.
    expect(isUnsolicited(TRV11, "on_status")).toBe(true);
    // `on_confirm` answers `confirm`, so it is not unsolicited...
    expect(isUnsolicited(TRV11, "on_confirm")).toBe(false);
    // ...and a request is never unsolicited, whatever its predecessor says.
    expect(isUnsolicited(TRV11, "search")).toBe(false);
    expect(isUnsolicited(TRV11, "confirm")).toBe(false);
  });

  it("reports the echo contract, which is the answer to hardcoding", () => {
    expect(mustEcho(TRV11, "confirm")).toEqual(["init", "on_init"]);
    expect(mustEcho(TRV11, "on_confirm")).toEqual([
      "init",
      "on_init",
      "confirm",
    ]);
    expect(mustEcho(TRV11, "search")).toEqual([]);
  });

  it("answers the seven successors of on_confirm, annotated", () => {
    const next = successorsOf(TRV11, "on_confirm");
    expect(next.map((entry) => entry.action)).toEqual([
      "confirm",
      "status",
      "cancel",
      "on_status",
      "update",
      "issue",
      "on_cancel",
    ]);
    const onStatus = next.find((entry) => entry.action === "on_status");
    expect(onStatus).toMatchObject({ unsolicited: true, repeatable: true });
    expect(onStatus?.must_echo).toEqual(["init", "on_init", "confirm"]);
  });

  it("asks what may open a transaction when given null", () => {
    expect(successorsOf(TRV11, null).map((e) => e.action)).toEqual([
      "search",
      "select",
      "init",
    ]);
  });

  it("treats an action with no published successor as terminal, not an error", () => {
    // The caller may well be asking precisely to find this out.
    expect(successorsOf(TRV11, "on_cancel")).toEqual([]);
  });
});

describe("realityFor", () => {
  const sequence = ["search", "on_search", "select", "on_select", "confirm"];

  it("names the actions the flow never exercises", () => {
    const reality = realityFor(TRV11, sequence);
    expect(reality.not_in_this_flow).toContain("on_status");
    expect(reality.not_in_this_flow).toContain("cancel");
    expect(reality.not_in_this_flow).not.toContain("search");
  });

  it("reports repeat and echo caveats for steps that are in the flow", () => {
    const reality = realityFor(TRV11, sequence);
    const onSearch = reality.steps.find((s) => s.action === "on_search");
    expect(onSearch?.repeatable).toBe(true);

    const confirm = reality.steps.find((s) => s.action === "confirm");
    expect(confirm?.must_echo).toEqual(["init", "on_init"]);
  });

  it("omits steps that carry no caveat, rather than listing them empty", () => {
    const reality = realityFor(TRV11, sequence);
    // `select` neither repeats, arrives unsolicited, nor echoes anything.
    expect(reality.steps.map((s) => s.action)).not.toContain("select");
  });

  it("stays inside its byte budget", () => {
    // This block rides along on every `catalog_describe_flow`, so its size is
    // a contract, not an aspiration. Asserted mechanically because a budget
    // nobody measures is a budget that rots on the first added field.
    const reality = realityFor(TRV11, sequence);
    expect(JSON.stringify(reality).length).toBeLessThan(1_500);
  });

  it("survives a build whose graph publishes nothing", () => {
    const empty: ActionGraph = { edges: {}, properties: {} };
    expect(realityFor(empty, ["search"])).toMatchObject({
      may_start_with: [],
      steps: [],
      not_in_this_flow: [],
    });
  });
});

describe("upstream noise", () => {
  it("drops a blank action name rather than listing a nameless action", () => {
    // `ONDC:RET11/1.2.5` publishes a literal empty-string key in
    // supportedActions. Observed live; the FIS12 fixture has no such key, so
    // only a real fetch could have found this.
    const noisy: ActionGraph = {
      edges: { "": ["search"], null: ["search"], search: ["on_search", ""] },
      properties: {},
    };
    expect(allActions(noisy)).toEqual(["on_search", "search"]);
    expect(successorsOf(noisy, "search").map((e) => e.action)).toEqual([
      "on_search",
    ]);
    expect(realityFor(noisy, ["search"]).not_in_this_flow).toEqual([
      "on_search",
    ]);
  });
});
