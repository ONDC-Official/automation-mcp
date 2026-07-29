import { describe, expect, it } from "vitest";
import {
  parseValidationMessage,
  pointerToPath,
} from "@/modules/validate/validate.parse.js";
import {
  L0_CODE,
  UNPARSED_CODE,
  primaryCode,
  summariseFindings,
} from "@/modules/validate/validate.schema.js";
import {
  DOCS_URL,
  L0_MULTI_ENTRY,
  L0_SINGLE_ENTRY,
  L1_ACTION_MISMATCH,
  L1_MULTI_RULE,
  L1_WILDCARD_PATH,
} from "@/test/validation-fixtures.js";

describe("parseValidationMessage — L1 (markdown)", () => {
  it("reports one finding per rule code, not per bullet", () => {
    const { findings } = parseValidationMessage(L1_MULTI_RULE);

    // Five `#### **CODE**` blocks, one of which carries two bulleted conditions.
    // Splitting that one would invent a failure the validator never claimed.
    expect(findings.map((finding) => finding.code)).toEqual([
      "REQUIRED_CONTEXT_CODE_1",
      "REQUIRED_CONTEXT_VERSION_8",
      "VALID_ENUM_MESSAGE_TYPE_1",
      "VEHICLE_CATEGORY_REQUIRED",
      "VALID_VEHICLE_CATEGORY",
    ]);
    expect(findings.every((finding) => finding.layer === "L1")).toBe(true);
  });

  it("joins a conjunction into one message and keeps the first path", () => {
    const [first] = parseValidationMessage(L1_MULTI_RULE).findings;

    expect(first?.json_path).toBe("$.context.location.country.code");
    expect(first?.message).toBe(
      "$.context.location.country.code must be present in the payload " +
        "All elements of $.context.location.country.code must be in " +
        '["IND"]',
    );
  });

  it("captures a conditional guard separately from the assertion", () => {
    const guarded = parseValidationMessage(L1_MULTI_RULE).findings.find(
      (finding) => finding.code === "VALID_ENUM_MESSAGE_TYPE_1",
    );

    expect(guarded?.skip_if).toBe(
      "$.message.intent.fulfillment.type is not in the payload",
    );
    // The guard must not bleed into the assertion — they say opposite things.
    expect(guarded?.message).not.toContain("Skip if");
    expect(guarded?.message).toContain('must be in ["ROUTE", "TRIP"]');
  });

  it("leaves skip_if off a rule that has no guard", () => {
    const unguarded = parseValidationMessage(L1_MULTI_RULE).findings.find(
      (finding) => finding.code === "VEHICLE_CATEGORY_REQUIRED",
    );

    expect(unguarded?.skip_if).toBeUndefined();
  });

  it("lifts the docs pointer out instead of leaving it on the last finding", () => {
    const { findings, docsUrl } = parseValidationMessage(L1_MULTI_RULE);

    expect(docsUrl).toBe(DOCS_URL);
    expect(findings.at(-1)?.message).not.toContain("for full list");
  });

  it("keeps a wildcard path intact", () => {
    // 4000 bad items collapse to one rule with a `[*]` path. Mangling the
    // brackets would make the path unevaluatable and lose the only pointer to
    // where the failure actually is.
    const [only] = parseValidationMessage(L1_WILDCARD_PATH).findings;

    expect(only?.json_path).toBe(
      "$.message.catalog.providers[*].items[*].descriptor.code",
    );
  });

  it("parses the action-mismatch rule the oracle raises on a wrong endpoint", () => {
    const [only] = parseValidationMessage(L1_ACTION_MISMATCH).findings;

    expect(only?.code).toBe("REQUIRED_CONTEXT_ACTION_9");
    expect(only?.json_path).toBe("$.context.action");
  });
});

describe("parseValidationMessage — L0 (plain text)", () => {
  it("splits entries on the `;\\n ` join and converts pointers to paths", () => {
    const { findings } = parseValidationMessage(L0_MULTI_ENTRY);

    expect(findings).toEqual([
      {
        layer: "L0",
        code: L0_CODE,
        json_path: "$.context.timestamp",
        message: "got number, want string",
      },
      {
        layer: "L0",
        code: L0_CODE,
        json_path: "$.message.intent",
        message: "got string, want object",
      },
    ]);
  });

  it("handles a lone entry, which carries no trailing semicolon", () => {
    const { findings } = parseValidationMessage(L0_SINGLE_ENTRY);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.json_path).toBe("$.message");
    expect(findings[0]?.layer).toBe("L0");
  });

  it("never emits an L1 finding for schema text", () => {
    // L0 short-circuits L1 upstream, so the two grammars never mix. If this
    // fails, the layer attribution everything downstream reads is wrong.
    const { findings } = parseValidationMessage(L0_MULTI_ENTRY);

    expect(findings.some((finding) => finding.layer === "L1")).toBe(false);
  });
});

describe("pointerToPath", () => {
  const cases: [string, string][] = [
    ["", "$"],
    ["/", "$"],
    ["/context", "$.context"],
    ["/context/timestamp", "$.context.timestamp"],
    ["/message/items/0/id", "$.message.items[0].id"],
    // ONDC field names really do look like this, and dotted form cannot
    // express them — `$.payment.@ondc/org/x` is not a path anything can read.
    ["/payment/@ondc~1org~1settlement", "$.payment['@ondc/org/settlement']"],
    ["/a/b-c", "$.a['b-c']"],
    ["/tilde~0key", "$['tilde~key']"],
  ];

  it.each(cases)("%s → %s", (pointer, expected) => {
    expect(pointerToPath(pointer)).toBe(expected);
  });
});

describe("degrading rather than throwing", () => {
  // This runs inside the receiver's ACK window. An upstream copy-edit must not
  // become a 500 that a participant records as our non-compliance.
  const hostile: [string, string][] = [
    ["empty", ""],
    ["whitespace", "   \n  "],
    ["prose we have never seen", "something else went wrong entirely"],
    ["a header with no code", "#### ****\n\n- $.context.x must be present;"],
    ["an unterminated header", "#### **NO_CLOSING_MARKER"],
    ["only the docs pointer", ` for full list of validations refer ${DOCS_URL}`],
    ["a lone dollar", "$"],
    ["nested markdown", "#### **A**\n\n#### **B**\n\n- $.x is wrong;"],
  ];

  it.each(hostile)("survives %s", (_label, input) => {
    expect(() => parseValidationMessage(input)).not.toThrow();
  });

  it("never answers a rejection with zero findings", () => {
    // An empty finding list reads exactly like `valid` to every consumer, so a
    // rejection we cannot parse must still produce something.
    for (const [, input] of hostile) {
      expect(parseValidationMessage(input).findings.length).toBeGreaterThan(0);
    }
  });

  it("keeps unrecognised text verbatim under a code that admits it", () => {
    const { findings } = parseValidationMessage("something else went wrong");

    expect(findings[0]?.code).toBe(UNPARSED_CODE);
    expect(findings[0]?.message).toBe("something else went wrong");
  });
});

describe("reading a verdict", () => {
  it("leads with L0, because a type error explains the rules it breaks", () => {
    const findings = [
      ...parseValidationMessage(L1_MULTI_RULE).findings,
      ...parseValidationMessage(L0_MULTI_ENTRY).findings,
    ];

    expect(primaryCode(findings)).toBe(L0_CODE);
  });

  it("caps a summary and says how much it dropped", () => {
    const { findings } = parseValidationMessage(L1_MULTI_RULE);
    const summary = summariseFindings(findings, 2);

    expect(summary).toContain("REQUIRED_CONTEXT_CODE_1");
    // A truncated list that does not announce itself reads as a complete one.
    expect(summary).toContain("(and 3 more)");
  });

  it("summarises an empty list without pretending it passed", () => {
    expect(summariseFindings([])).toBe("Validation failed.");
  });
});
