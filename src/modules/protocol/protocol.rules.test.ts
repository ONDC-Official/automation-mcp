import { describe, expect, it } from "vitest";
import {
  classifyQuery,
  indexRules,
  lookupRules,
  normaliseRuleName,
  pseudoCodeNote,
} from "@/modules/protocol/protocol.rules.js";
import { L0_CODE, UNPARSED_CODE } from "@/modules/validate/validate.schema.js";

/**
 * Rows below are shaped exactly as the live builds publish them, including the
 * two spellings that break a naive index: RET's markdown-asterisk names and
 * the backtick-wrapped `scope`.
 */
const TABLE = {
  search: {
    rows: [
      {
        rowType: "group",
        name: "SEARCH_CONTEXT",
        description: "Sub-tests: A, B",
      },
      {
        rowType: "leaf",
        name: "REQUIRED_CONTEXT_CODE_1",
        group: "SEARCH_CONTEXT > CONTEXT_REQUIRED",
        scope: "`$.context.location.city`",
        description:
          "**All of the following must be true:** - $.context.location.country.code must be present",
        skipIf: "",
        errorCode: "30000",
      },
      {
        rowType: "leaf",
        name: "**CONTEXT_REQUIRED**",
        description: "- $.context.timestamp must be present in the payload",
        errorCode: "30000",
      },
    ],
  },
  on_search: {
    rows: [
      {
        rowType: "leaf",
        // The same rule name, a different action. 142 of 508 TRV11 names do this.
        name: "REQUIRED_CONTEXT_CODE_1",
        description: "- $.context.location.country.code must be present",
        errorCode: "30000",
      },
      {
        rowType: "leaf",
        name: "VALIDATE_ITEM_PRICE",
        scope: "`$.message.catalog['bpp/providers'][*].items[*]`",
        description: "- item price must equal the quoted price",
        errorCode: "",
      },
    ],
  },
};

const index = indexRules(TABLE);

describe("indexRules", () => {
  it("drops group rows, which are headings rather than checks", () => {
    expect(index.rows).toHaveLength(4);
    expect(index.rows.map((r) => r.name)).not.toContain("SEARCH_CONTEXT");
  });

  it("keeps the leaf's breadcrumb, which is what the group row said", () => {
    const row = index.rows.find((r) => r.name === "REQUIRED_CONTEXT_CODE_1");
    expect(row?.group).toBe("SEARCH_CONTEXT > CONTEXT_REQUIRED");
  });

  it("strips backticks from scope", () => {
    // Every published row with a scope is backtick-wrapped. A JSONPath matcher
    // that keeps them finds nothing, forever, with no error.
    expect(
      index.rows.find((r) => r.name === "REQUIRED_CONTEXT_CODE_1")?.scope,
    ).toBe("$.context.location.city");
    expect(
      index.rows.find((r) => r.name === "VALIDATE_ITEM_PRICE")?.scope,
    ).toBe("$.message.catalog['bpp/providers'][*].items[*]");
  });

  it("drops an empty errorCode rather than reporting it as a code", () => {
    expect(
      index.rows.find((r) => r.name === "VALIDATE_ITEM_PRICE")?.error_code,
    ).toBeUndefined();
  });

  it("survives a malformed table without throwing", () => {
    expect(indexRules({}).rows).toEqual([]);
    expect(indexRules({ a: {} }).rows).toEqual([]);
    expect(indexRules({ a: { rows: [null, 3, { name: "" }] } }).rows).toEqual(
      [],
    );
  });
});

describe("normaliseRuleName", () => {
  it("makes RET's asterisks and TRV's bare name the same key", () => {
    // `**CONTEXT_REQUIRED**` is also the spelling `validate.parse.ts` scrapes
    // out of an `#### **CODE**` header, which is what lets a real rejection be
    // matched back to its published rule.
    expect(normaliseRuleName("**CONTEXT_REQUIRED**")).toBe(
      normaliseRuleName("CONTEXT_REQUIRED"),
    );
  });
});

describe("classifyQuery", () => {
  it.each([
    ["REQUIRED_CONTEXT_CODE_1", "rule_name"],
    ["**CONTEXT_REQUIRED**", "rule_name"],
    ["30000", "error_code"],
    ["60001", "error_code"],
    ["$.context.domain", "json_path"],
    [L0_CODE, "pseudo_code"],
    [UNPARSED_CODE, "pseudo_code"],
  ])("reads %s as %s", (query, kind) => {
    expect(classifyQuery(query)).toBe(kind);
  });

  it("does not mistake a name that merely contains digits for a code", () => {
    expect(classifyQuery("REQUIRED_CONTEXT_CODE_1")).toBe("rule_name");
    expect(classifyQuery("CODE_30000_CHECK")).toBe("rule_name");
  });
});

describe("lookupRules", () => {
  it("returns EVERY action a rule name applies to, not one of them", () => {
    // The whole reason the index is keyed on (action, name). Answering with a
    // single arbitrary action's row is a confident wrong answer.
    const found = lookupRules(index, "REQUIRED_CONTEXT_CODE_1", { limit: 20 });
    expect(found.total).toBe(2);
    expect(found.matches.map((r) => r.action).sort()).toEqual([
      "on_search",
      "search",
    ]);
    expect(found.per_action).toEqual({ search: 1, on_search: 1 });
  });

  it("narrows to one action when the caller names one", () => {
    const found = lookupRules(index, "REQUIRED_CONTEXT_CODE_1", {
      action: "on_search",
      limit: 20,
    });
    expect(found.total).toBe(1);
    expect(found.matches[0]?.action).toBe("on_search");
  });

  it("matches a rejection's scraped code back to the published rule", () => {
    const found = lookupRules(index, "**CONTEXT_REQUIRED**", { limit: 20 });
    expect(found.matches[0]?.description).toMatch(/timestamp must be present/);
  });

  it("collects every rule carrying an error code, across actions", () => {
    const found = lookupRules(index, "30000", { limit: 20 });
    expect(found.total).toBe(3);
  });

  it("finds rules by a JSONPath in scope, description or skip condition", () => {
    expect(
      lookupRules(index, "$.context.location.city", { limit: 20 }).total,
    ).toBe(1);
    expect(lookupRules(index, "$.context.timestamp", { limit: 20 }).total).toBe(
      1,
    );
  });

  it("caps at the limit but still reports the true total", () => {
    const found = lookupRules(index, "30000", { limit: 1 });
    expect(found.matches).toHaveLength(1);
    expect(found.total).toBe(3);
  });

  it("answers our own pseudo-codes with nothing, so the note can explain", () => {
    expect(lookupRules(index, L0_CODE, { limit: 20 }).matches).toEqual([]);
    expect(lookupRules(index, UNPARSED_CODE, { limit: 20 }).matches).toEqual(
      [],
    );
  });
});

describe("pseudoCodeNote", () => {
  it("explains a schema failure and points at the schema resource", () => {
    expect(pseudoCodeNote(L0_CODE)).toMatch(/ondc:\/\/schema/);
  });

  it("tells a caller holding an unparsed code to search by path instead", () => {
    expect(pseudoCodeNote(UNPARSED_CODE)).toMatch(/json_path/);
  });

  it("says nothing about a real rule name", () => {
    expect(pseudoCodeNote("REQUIRED_CONTEXT_CODE_1")).toBeUndefined();
  });
});
