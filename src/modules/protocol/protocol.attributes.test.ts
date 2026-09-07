import { describe, expect, it } from "vitest";
import {
  compareRanked,
  filterFields,
  flattenAttributeSet,
  rankFields,
  searchFields,
} from "@/modules/protocol/protocol.attributes.js";
import {
  appendSegment,
  pointerToPath,
} from "@/modules/validate/validate.parse.js";

/**
 * The flattener's tests.
 *
 * It is the only part of the ingest that *invents* rather than echoes — it
 * synthesises the JSONPath a model then trusts — so this is where the
 * assertions live. The literals are ONDC key shapes taken from live builds.
 */

const TREE = {
  _description: { info: "<placeholder description>", type: "object" },
  context: {
    _description: {
      required: true,
      info: "Envelope",
      owner: "BAP",
      type: "object",
    },
    domain: {
      _description: {
        required: true,
        usage: "ONDC:RET10",
        info: "Identifies the ONDC domain",
        owner: "BAP",
        type: "enum",
        enums: [
          {
            code: "ONDC:RET10",
            description: "Grocery",
            reference: "<PR/Issue/Discussion Links md format text>",
          },
          {
            code: "ONDC:RET11",
            description: "F&B",
            reference: "<PR/Issue/Discussion Links md format text>",
          },
        ],
      },
    },
  },
  message: {
    _description: {
      required: false,
      info: "The body",
      owner: "BPP",
      type: "object",
    },
    catalog: {
      _description: { required: false, owner: "BPP", type: "object" },
      // The whole reason this file has tests: a `/` inside an object key.
      "bpp/providers": {
        _description: {
          required: true,
          info: "Providers this seller publishes",
          owner: "BPP",
          type: "array",
        },
        items: {
          _description: { required: true, owner: "BPP", type: "object" },
          "@ondc/org/return_window": {
            _description: {
              required: false,
              info: "ISO8601 return window",
              owner: "BPP",
              type: "string",
            },
          },
        },
      },
    },
  },
};

describe("flattenAttributeSet", () => {
  const fields = flattenAttributeSet(TREE);
  const at = (path: string) => fields.find((f) => f.path === path);

  it("bracket-quotes a key that is not a bare identifier", () => {
    // `$.message.catalog.bpp/providers` looks right, evaluates to nothing, and
    // sends the model to a field that does not exist. RET11 has 28 such keys.
    expect(at("$.message.catalog['bpp/providers']")).toBeDefined();
    expect(
      at("$.message.catalog['bpp/providers'].items['@ondc/org/return_window']"),
    ).toBeDefined();
    expect(fields.map((f) => f.path)).not.toContain(
      "$.message.catalog.bpp/providers",
    );
  });

  it("spells a path exactly as validate/ spells a finding's json_path", () => {
    // If these two ever drift, `protocol_explain_rule` stops matching a real
    // rejection to the field it names — and does so silently. Driven from
    // segments, because a JSON Pointer escapes `/` as `~1`: reconstructing the
    // pointer by splitting the *path* on `/` is the very mistake this guards.
    const cases: string[][] = [
      ["context", "domain"],
      ["message", "catalog", "bpp/providers"],
      [
        "message",
        "catalog",
        "bpp/providers",
        "items",
        "@ondc/org/return_window",
      ],
    ];
    for (const segments of cases) {
      const built = segments.reduce(appendSegment, "$");
      const pointer = `/${segments
        .map((segment) => segment.replace(/~/g, "~0").replace(/\//g, "~1"))
        .join("/")}`;
      expect(pointerToPath(pointer)).toBe(built);
      expect(fields.map((f) => f.path)).toContain(built);
    }
  });

  it("drops upstream's placeholder prose instead of showing it", () => {
    expect(at("$.message.catalog")?.info).toBeUndefined();
    expect(fields.map((f) => JSON.stringify(f))).not.toContain(
      expect.stringContaining("<placeholder"),
    );
  });

  it("never emits the root as a field", () => {
    // It describes the payload as a whole; listing it as `$` crowds out a real
    // field and nobody sets it.
    expect(at("$")).toBeUndefined();
  });

  it("does not propagate `required` in either direction", () => {
    // A required leaf under an optional branch is what upstream means:
    // *if* you send the branch, this is required inside it.
    expect(at("$.message")?.required).toBe(false);
    expect(at("$.message.catalog['bpp/providers']")?.required).toBe(true);
  });

  it("surfaces `usage` as an example, and keeps enum descriptions", () => {
    const domain = at("$.context.domain");
    // Note the value: a RET11 build publishing `ONDC:RET10` as its own
    // example. Verified live, and why the field is never called `default`.
    expect(domain?.example).toBe("ONDC:RET10");
    expect(domain?.enums).toEqual([
      { code: "ONDC:RET10", description: "Grocery" },
      { code: "ONDC:RET11", description: "F&B" },
    ]);
    // `reference` is the same placeholder on every build — bytes carrying
    // nothing.
    expect(JSON.stringify(domain)).not.toContain("reference");
  });

  it("caps enums and states the true count", () => {
    const many = flattenAttributeSet({
      code: {
        _description: {
          type: "enum",
          enums: Array.from({ length: 30 }, (_, i) => ({
            code: `C${String(i)}`,
          })),
        },
      },
    });
    expect(many[0]?.enums).toHaveLength(12);
    expect(many[0]?.enum_total).toBe(30);
  });

  it("orders required-first then by path, so truncation is deterministic", () => {
    const paths = fields.map((f) => f.path);
    const firstOptional = fields.findIndex((f) => !f.required);
    expect(fields.slice(0, firstOptional).every((f) => f.required)).toBe(true);
    expect(fields.slice(firstOptional).some((f) => f.required)).toBe(false);
    // Stable across calls.
    expect(flattenAttributeSet(TREE).map((f) => f.path)).toEqual(paths);
  });

  it("records depth from the root", () => {
    expect(at("$.context")?.depth).toBe(1);
    expect(at("$.context.domain")?.depth).toBe(2);
    expect(
      at("$.message.catalog['bpp/providers'].items['@ondc/org/return_window']")
        ?.depth,
    ).toBe(5);
  });

  it("reads `owner: false` as absent rather than as a side", () => {
    // A handful of published nodes carry the boolean. "false" in front of a
    // model asked which side populates a field would be nonsense.
    const odd = flattenAttributeSet({
      x: { _description: { owner: false, type: "string" } },
    });
    expect(odd[0]?.owner).toBeUndefined();
  });

  it("survives an empty or malformed tree without throwing", () => {
    expect(flattenAttributeSet({})).toEqual([]);
    expect(flattenAttributeSet(undefined)).toEqual([]);
    expect(flattenAttributeSet({ a: "not an object" })).toEqual([]);
    expect(flattenAttributeSet({ a: { _description: null } })).toEqual([]);
  });
});

describe("filterFields", () => {
  const fields = flattenAttributeSet(TREE);

  it("narrows by path prefix", () => {
    const narrowed = filterFields(fields, { path_prefix: "$.message.catalog" });
    expect(narrowed.length).toBeGreaterThan(0);
    expect(narrowed.every((f) => f.path.startsWith("$.message.catalog"))).toBe(
      true,
    );
  });

  it("narrows by depth, which is what tames a 180-field action", () => {
    expect(
      filterFields(fields, { max_depth: 2 }).every((f) => f.depth <= 2),
    ).toBe(true);
  });

  it("narrows by required and by owner", () => {
    expect(
      filterFields(fields, { required_only: true }).every((f) => f.required),
    ).toBe(true);
    expect(
      filterFields(fields, { owner: "bpp" }).every((f) => f.owner === "BPP"),
    ).toBe(true);
  });
});

describe("searchFields", () => {
  const fields = flattenAttributeSet(TREE);

  it("ranks a path match above a prose match", () => {
    const hits = searchFields(fields, "domain");
    expect(hits[0]?.path).toBe("$.context.domain");
  });

  it("finds a field by an enum code", () => {
    expect(searchFields(fields, "ONDC:RET11")[0]?.path).toBe(
      "$.context.domain",
    );
  });

  it("finds a field by its prose alone", () => {
    expect(searchFields(fields, "return window")[0]?.path).toBe(
      "$.message.catalog['bpp/providers'].items['@ondc/org/return_window']",
    );
  });

  it("answers an empty query with nothing rather than everything", () => {
    expect(searchFields(fields, "   ")).toEqual([]);
  });

  it("matches a multi-word query across an underscored field name", () => {
    // The bug this replaced: a whole-query substring match returns nothing for
    // "return window", because the field is `@ondc/org/return_window`.
    // Observed live against ONDC:RET11/1.2.5, which plainly publishes it.
    expect(searchFields(fields, "return window")[0]?.path).toBe(
      "$.message.catalog['bpp/providers'].items['@ondc/org/return_window']",
    );
    expect(searchFields(fields, "return_window")).toHaveLength(1);
    expect(searchFields(fields, "RETURN Window")).toHaveLength(1);
  });

  it("requires every term, so an extra word narrows rather than widens", () => {
    expect(searchFields(fields, "return window zzzz")).toEqual([]);
  });
});

describe("compareRanked", () => {
  const fields = flattenAttributeSet(TREE);

  it("puts a path match ahead of a prose match, whatever the input order", () => {
    // The bug this guards: `protocol_search_fields` ranks each action's fields
    // separately and then truncates the concatenation. Against
    // ONDC:RET11/1.2.5 that returned four prose matches from `confirm` and
    // dropped the exact path hit in `on_search`, because `confirm` sorts first
    // alphabetically. Ranking per group and truncating across groups is not
    // ranking — so the merged list must be sorted with this.
    const merged = [
      ...rankFields(fields, "return window"),
      ...rankFields(fields, "domain"),
    ].sort(compareRanked);
    expect(merged[0]?.rank).toBe(0);
    expect(merged.map((entry) => entry.rank)).toEqual(
      [...merged.map((entry) => entry.rank)].sort((a, b) => a - b),
    );
  });

  it("exposes the rank searchFields hides", () => {
    expect(rankFields(fields, "domain")[0]?.rank).toBe(0);
    expect(rankFields(fields, "ISO8601")[0]?.rank).toBe(2);
    expect(searchFields(fields, "domain")[0]?.path).toBe("$.context.domain");
  });
});
