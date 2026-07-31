import { describe, expect, it } from "vitest";
import {
  checkInputs,
  describeInputs,
  mockStepInputs,
  resolveInputSpec,
} from "@/modules/catalog/catalog.inputs.js";
import type { UpstreamMockConfig } from "@/modules/catalog/catalog.schema.js";

/**
 * The live `ONDC:TRV11/2.0.1/Metro` declaration for `search1_METRO_201`,
 * verbatim from the config-service — flow-definition half and mock-config half.
 *
 * Keep it verbatim. The whole failure mode this module exists for is a shape
 * that reads as one thing and means another, and a tidied-up fixture would tidy
 * the trap away.
 */
const METRO_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    city_code: {
      type: "string",
      default: "std:011",
      pattern: "^std:\\d{3,5}$",
    },
  },
  required: ["city_code"],
  additionalProperties: true,
  default: {},
};

/** How the flow definition (`GET /ui/flow`) publishes it. */
const METRO_FLOW_INPUT = [
  { name: "ExampleInputId", type: "ExampleInputId", schema: METRO_SCHEMA },
];

/** How the mock config (`GET /mock/playground`) publishes the same thing. */
const METRO_CONFIG_INPUT = { id: "ExampleInputId", jsonSchema: METRO_SCHEMA };

/** The FIS12 shape: a wrapper around bare field declarations. */
const OLD_STYLE = {
  oldInputs: [
    {
      name: "form_submission_id",
      label: "Enter Form Submission id",
      type: "HTML_FORM",
      reference: "$.reference_data.personal_loan_information_form",
    },
  ],
};

describe("resolveInputSpec — reading a declaration", () => {
  it("takes the fields from the schema's properties, not the declaration's name", () => {
    const spec = resolveInputSpec(METRO_FLOW_INPUT, METRO_CONFIG_INPUT);

    expect(spec.fields).toEqual([
      {
        name: "city_code",
        required: true,
        type: "string",
        default: "std:011",
        pattern: "^std:\\d{3,5}$",
      },
    ]);
    // The name is a wrapper: it names the declaration and nothing in user_inputs.
    expect(spec.wrapperNames).toEqual(["ExampleInputId"]);
  });

  it("takes the field from the declaration's own name when it carries no schema", () => {
    const spec = resolveInputSpec(OLD_STYLE);

    expect(spec.fields).toEqual([
      {
        name: "form_submission_id",
        required: false,
        type: "HTML_FORM",
        label: "Enter Form Submission id",
        reference: "$.reference_data.personal_loan_information_form",
      },
    ]);
    // Nothing to nest under — every declared name here *is* a key.
    expect(spec.wrapperNames).toEqual([]);
    expect(spec.schema).toBeUndefined();
  });

  it("merges declarations flat, because user_inputs is one flat object", () => {
    const spec = resolveInputSpec([
      { name: "A", schema: { properties: { one: { type: "string" } } } },
      {
        name: "B",
        schema: {
          properties: { two: { type: "number" } },
          required: ["two"],
        },
      },
    ]);

    expect(spec.fields.map((field) => field.name)).toEqual(["one", "two"]);
    expect(spec.schema).toMatchObject({
      properties: { one: { type: "string" }, two: { type: "number" } },
      required: ["two"],
    });
    expect(spec.wrapperNames).toEqual(["A", "B"]);
  });

  it("builds an example from sampleData and declared defaults", () => {
    expect(resolveInputSpec(METRO_CONFIG_INPUT).example).toEqual({
      city_code: "std:011",
    });
    expect(
      resolveInputSpec({
        id: "X",
        jsonSchema: { properties: { a: { default: 1 }, b: {} } },
        sampleData: { b: "sampled" },
      }).example,
    ).toEqual({ b: "sampled", a: 1 });
  });

  it("degrades to nothing on a shape it does not recognise", () => {
    for (const shape of [undefined, {}, "nope", 7, [], { oldInputs: {} }]) {
      expect(resolveInputSpec(shape).fields).toEqual([]);
    }
  });

  it("reads a step's declaration out of a mock config by key", () => {
    const config = {
      steps: [
        { action_id: "a", api: "search", mock: { inputs: METRO_CONFIG_INPUT } },
        { action_id: "b", api: "select" },
      ],
    } as unknown as UpstreamMockConfig;

    expect(mockStepInputs(config, "a")).toBe(METRO_CONFIG_INPUT);
    expect(mockStepInputs(config, "b")).toBeUndefined();
    expect(mockStepInputs(undefined, "a")).toBeUndefined();
  });
});

describe("checkInputs — the nesting trap", () => {
  const spec = resolveInputSpec(METRO_FLOW_INPUT, METRO_CONFIG_INPUT);

  it("accepts the flat shape the generator actually reads", () => {
    expect(checkInputs(spec, { city_code: "std:011" })).toMatchObject({
      ok: true,
      problems: [],
    });
  });

  it("rejects the nested shape, and says which key is the wrapper", () => {
    const check = checkInputs(spec, {
      ExampleInputId: { city_code: "std:011" },
    });

    expect(check.ok).toBe(false);
    expect(check.problems).toHaveLength(1);
    expect(check.problems[0]).toMatchObject({
      code: "nested_under_declaration",
      field: "ExampleInputId",
    });
    // Naming the wrapper and showing the shape is the whole point: "must have
    // required property 'city_code'" is true and points away from the fix.
    expect(check.message).toContain("ExampleInputId");
    expect(check.message).toContain("city_code");
    expect(check.message).toContain('{"city_code":"std:011"}');
  });

  it("catches nesting even when the schema alone would pass it", () => {
    // Nothing required, extra keys allowed — so ajv is perfectly happy with the
    // nested object, and this is the case that would still fail silently if the
    // wrapper check were left to the schema.
    const loose = resolveInputSpec({
      id: "Wrapper",
      jsonSchema: {
        type: "object",
        properties: { thing: { type: "string" } },
        additionalProperties: true,
      },
    });

    expect(checkInputs(loose, { thing: "ok" }).ok).toBe(true);
    expect(checkInputs(loose, { Wrapper: { thing: "ok" } })).toMatchObject({
      ok: false,
      problems: [{ code: "nested_under_declaration" }],
    });
  });

  it("does not cry nesting when the declared name really is a field", () => {
    // Old-style: `form_submission_id` is a key, so an object value under it is
    // the caller's business, not a mistake.
    const old = resolveInputSpec(OLD_STYLE);
    expect(checkInputs(old, { form_submission_id: { any: "thing" } }).ok).toBe(
      true,
    );
  });
});

describe("checkInputs — the declared schema", () => {
  const spec = resolveInputSpec(METRO_CONFIG_INPUT);

  it("reports a value that breaks the declared pattern, by field", () => {
    const check = checkInputs(spec, { city_code: "delhi" });

    expect(check.ok).toBe(false);
    expect(check.problems[0]).toMatchObject({
      code: "schema",
      field: "city_code",
    });
    expect(check.message).toContain("city_code");
  });

  it("reports a missing required field by name", () => {
    const check = checkInputs(spec, { something_else: 1 });

    expect(check.ok).toBe(false);
    expect(check.problems[0]).toMatchObject({
      code: "schema",
      field: "city_code",
    });
  });

  it("passes absent inputs through — readiness is the gate's call, not ours", () => {
    expect(checkInputs(spec, undefined).ok).toBe(true);
  });

  it("exempts our own control keys from the declared schema", () => {
    // `id` triggers a manual step and `submission_id` carries a form; neither is
    // a value the generator reads, and a strict schema must not reject them.
    expect(
      checkInputs(spec, {
        city_code: "std:011",
        id: "search1_METRO_201",
        submission_id: "sub-1",
      }).ok,
    ).toBe(true);
  });

  it("has nothing to enforce when no declaration carries a schema", () => {
    expect(checkInputs(resolveInputSpec(OLD_STYLE), { anything: 1 }).ok).toBe(
      true,
    );
  });
});

describe("describeInputs", () => {
  it("states the flat contract, and warns off the wrapper by name", () => {
    const described = describeInputs(
      resolveInputSpec(METRO_FLOW_INPUT, METRO_CONFIG_INPUT),
    );

    expect(described.fields.map((field) => field.name)).toEqual(["city_code"]);
    expect(described.note).toContain("flat object");
    expect(described.note).toContain("ExampleInputId");
    expect(described.example).toEqual({ city_code: "std:011" });
    expect(described.schema).toMatchObject({ required: ["city_code"] });
  });

  it("says nothing about wrappers when there are none", () => {
    const described = describeInputs(resolveInputSpec(OLD_STYLE));

    expect(described.note).toContain("flat object");
    expect(described.note).not.toContain("nest under");
    expect(described.schema).toBeUndefined();
  });
});
