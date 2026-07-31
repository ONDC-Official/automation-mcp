/**
 * What a step declares it needs, and whether what a caller supplied matches.
 *
 * ## The contract this file exists to state
 *
 * Everything passed under `flow_proceed`'s `inputs` reaches the flow's own
 * `generate` as **`sessionData.user_inputs`, flat**. This is a real published
 * step (`ONDC:TRV11/2.0.1/Metro`, `search1_METRO_201`), verbatim:
 *
 * ```js
 * async function generate(existingPayload, sessionData) {
 *   const userInput = sessionData?.user_inputs;
 *   existingPayload.context.location.city.code = userInput?.city_code;
 *   return existingPayload;
 * }
 * ```
 *
 * It reads `city_code` off the top of `user_inputs`. But the declaration the
 * caller is shown for that same step looks like this:
 *
 * ```json
 * [{ "name": "ExampleInputId", "type": "ExampleInputId",
 *    "schema": { "properties": { "city_code": { "pattern": "^std:\\d{3,5}$" } } } }]
 * ```
 *
 * — so `ExampleInputId` reads like a key to nest under, and it is not. It is
 * the id of the *declaration*; the schema's `properties` are the keys.
 *
 * A caller that nests (`{ExampleInputId: {city_code: "std:011"}}`) hands
 * `generate` an object with no `city_code`, so the assignment above writes
 * `undefined` — which **deletes the field the default payload already had
 * right**. The run then fails an L1 rule at `$.context.location.city.code`
 * with nothing anywhere pointing back at the input. That happened, cost a run,
 * and was filed as a config defect. The config was fine.
 *
 * ## Two declaration shapes are live, and they mean opposite things
 *
 * | Shape                                 | Where the field names are                    |
 * | ------------------------------------- | -------------------------------------------- |
 * | `{name, schema:{properties}}` (TRV11) | in `schema.properties` — `name` is a wrapper |
 * | `{name, label, type}` (FIS12)         | `name` **is** the field                      |
 *
 * Hence `wrapperNames`: a name belonging to a schema-bearing declaration that
 * is not itself a field. Nesting under one of those is the mistake worth
 * naming by name, and it is the one `checkInputs` names — ahead of the schema,
 * because `additionalProperties: true` (which the TRV11 schema sets) means a
 * declaration with no required field would let the nested shape validate
 * cleanly and fail exactly as silently as before.
 */

// Named, not default: Ajv ships CJS, and under `moduleResolution: NodeNext` the
// default export is the module namespace rather than the class.
import { Ajv, type ErrorObject } from "ajv";
import type { UpstreamMockConfig } from "@/modules/catalog/catalog.schema.js";

/**
 * Keys that are ours, not the generator's.
 *
 * `id` names a manual step (naming it *is* the trigger) and `submission_id`
 * carries a form submission. Neither is a value `generate` reads, so neither is
 * held to the declared schema — a schema with `additionalProperties: false`
 * would otherwise reject our own control channel.
 */
const CONTROL_KEYS = new Set(["id", "submission_id"]);

const FLAT_NOTE =
  "Pass these as a flat object under `inputs` — it becomes " +
  "`sessionData.user_inputs` verbatim, and the step's generator reads the " +
  "field names below off the top of it.";

/** One value the flow's `generate` will read off `sessionData.user_inputs`. */
export interface InputField {
  name: string;
  required: boolean;
  type?: string;
  label?: string;
  description?: string;
  default?: unknown;
  pattern?: string;
  enum?: unknown[];
  reference?: string;
}

export interface InputSpec {
  /** JSON Schema for the flat `user_inputs` object, when one was declared. */
  schema?: Record<string, unknown>;
  fields: InputField[];
  /**
   * Declaration ids that are **not** keys of `user_inputs`. Empty for the
   * old-style shape, where every declared name is a field.
   */
  wrapperNames: string[];
  /** A correctly-shaped example, from `sampleData` and declared defaults. */
  example?: Record<string, unknown>;
}

export type InputProblemCode = "nested_under_declaration" | "schema";

export interface InputProblem {
  code: InputProblemCode;
  message: string;
  field?: string;
}

export interface InputCheck {
  ok: boolean;
  problems: InputProblem[];
  /** One line fit for an outcome message; empty when `ok`. */
  message: string;
}

/** The `inputs_required` block put on an outcome or a step state. */
export interface InputsRequired {
  fields: InputField[];
  note: string;
  schema?: Record<string, unknown>;
  example?: Record<string, unknown>;
}

interface RawDeclaration {
  name: string;
  schema?: Record<string, unknown>;
  sampleData?: Record<string, unknown>;
  type?: string;
  label?: string;
  reference?: string;
}

/**
 * Compiled-schema cache, and the reason it is allowed to be module-level.
 *
 * It holds no request state: Ajv keys its cache on the serialised schema, and
 * the schemas here are rebuilt identically from published config on every call,
 * so the cache is bounded by the number of distinct step declarations in the
 * catalog rather than by traffic. `strict: false` because published schemas
 * carry draft-07 keywords Ajv's strict mode would rather refuse than honour.
 */
const ajv = new Ajv({ allErrors: true, strict: false });

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function declarationFrom(entry: unknown): RawDeclaration | undefined {
  const record = asRecord(entry);
  if (record === undefined) return undefined;

  // `name` in a flow definition, `id` in a mock config — same thing.
  const name = asString(record["name"]) ?? asString(record["id"]);
  if (name === undefined) return undefined;

  const schema = asRecord(record["schema"] ?? record["jsonSchema"]);
  const sampleData = asRecord(record["sampleData"]);
  const type = asString(record["type"]);
  const label = asString(record["label"]);
  const reference = asString(record["reference"]);

  return {
    name,
    ...(schema !== undefined ? { schema } : {}),
    ...(sampleData !== undefined ? { sampleData } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(reference !== undefined ? { reference } : {}),
  };
}

/**
 * Read declarations out of any of the shapes upstream publishes.
 *
 * A bare array, a single descriptor object (`{id, jsonSchema, sampleData}`), or
 * a wrapper around a list (`{oldInputs: [...]}`). An unfamiliar shape yields no
 * declarations rather than throwing — a step we cannot describe must still be
 * sendable.
 */
export function normaliseDeclarations(inputs: unknown): RawDeclaration[] {
  if (Array.isArray(inputs)) {
    return inputs
      .map(declarationFrom)
      .filter((entry): entry is RawDeclaration => entry !== undefined);
  }

  const record = asRecord(inputs);
  if (record === undefined) return [];

  const direct = declarationFrom(record);
  if (direct !== undefined) return [direct];

  return Object.values(record)
    .filter((value): value is unknown[] => Array.isArray(value))
    .flatMap((entries) => entries.map(declarationFrom))
    .filter((entry): entry is RawDeclaration => entry !== undefined);
}

/** Whether a declaration describes an object whose properties are the fields. */
function propertiesOf(
  declaration: RawDeclaration,
): Record<string, unknown> | undefined {
  return asRecord(declaration.schema?.["properties"]);
}

function fieldsOf(declaration: RawDeclaration): InputField[] {
  const properties = propertiesOf(declaration);

  if (properties === undefined) {
    // Old style: the declaration *is* the field. Never `required` — some carry
    // a `reference` and are resolved from saved data rather than supplied.
    return [
      {
        name: declaration.name,
        required: false,
        ...(declaration.type !== undefined ? { type: declaration.type } : {}),
        ...(declaration.label !== undefined
          ? { label: declaration.label }
          : {}),
        ...(declaration.reference !== undefined
          ? { reference: declaration.reference }
          : {}),
      },
    ];
  }

  const declared = declaration.schema?.["required"];
  const required = new Set(
    Array.isArray(declared)
      ? declared.filter((n) => typeof n === "string")
      : [],
  );

  return Object.entries(properties).map(([name, raw]) => {
    const property = asRecord(raw) ?? {};
    const type = asString(property["type"]);
    const description = asString(property["description"]);
    const pattern = asString(property["pattern"]);
    const enumeration = property["enum"];

    return {
      name,
      required: required.has(name),
      ...(type !== undefined ? { type } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(property["default"] !== undefined
        ? { default: property["default"] }
        : {}),
      ...(pattern !== undefined ? { pattern } : {}),
      ...(Array.isArray(enumeration) ? { enum: enumeration } : {}),
    };
  });
}

/** A mock config step's own declaration, by step key. */
export function mockStepInputs(
  config: UpstreamMockConfig | undefined,
  actionId: string,
): unknown {
  return config?.steps.find((entry) => entry.action_id === actionId)?.mock
    ?.inputs;
}

/**
 * What one step declares, merged across every place it can be declared.
 *
 * Sources are given in increasing order of authority, so a mock config's
 * declaration passed after a flow definition's wins where the two overlap: it
 * is the one whose `jsonSchema` the runner was authored against. The flow
 * definition fills in anything the config does not describe — for many live
 * steps it is the only one of the two carrying a declaration at all.
 */
export function resolveInputSpec(...sources: unknown[]): InputSpec {
  const merged = new Map<string, RawDeclaration>();
  for (const declaration of sources.flatMap(normaliseDeclarations)) {
    merged.set(declaration.name, {
      ...merged.get(declaration.name),
      ...declaration,
    });
  }

  const declarations = [...merged.values()];
  const fields = new Map<string, InputField>();
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  const sample: Record<string, unknown> = {};
  let hasSchema = false;

  for (const declaration of declarations) {
    for (const field of fieldsOf(declaration)) fields.set(field.name, field);

    const declaredProperties = propertiesOf(declaration);
    if (declaredProperties !== undefined) {
      hasSchema = true;
      Object.assign(properties, declaredProperties);
      const declaredRequired = declaration.schema?.["required"];
      if (Array.isArray(declaredRequired)) {
        for (const name of declaredRequired) {
          if (typeof name === "string") required.add(name);
        }
      }
    }
    if (declaration.sampleData !== undefined) {
      Object.assign(sample, declaration.sampleData);
    }
  }

  const wrapperNames = declarations
    .filter((declaration) => propertiesOf(declaration) !== undefined)
    .map((declaration) => declaration.name)
    .filter((name) => !fields.has(name));

  const example: Record<string, unknown> = { ...sample };
  for (const field of fields.values()) {
    if (example[field.name] === undefined && field.default !== undefined) {
      example[field.name] = field.default;
    }
  }

  return {
    fields: [...fields.values()],
    wrapperNames,
    ...(hasSchema
      ? {
          schema: {
            type: "object",
            properties,
            required: [...required],
            // Extra keys are the caller's business, and our own control keys
            // ride along in the same object.
            additionalProperties: true,
          },
        }
      : {}),
    ...(Object.keys(example).length > 0 ? { example } : {}),
  };
}

/** The block handed back on an `INPUT_REQUIRED` outcome or a step state. */
export function describeInputs(spec: InputSpec): InputsRequired {
  const note =
    spec.wrapperNames.length > 0
      ? `${FLAT_NOTE} ${spec.wrapperNames
          .map((name) => `"${name}"`)
          .join(", ")} names a declaration, not a value — do not nest under it.`
      : FLAT_NOTE;

  return {
    fields: spec.fields,
    note,
    ...(spec.schema !== undefined ? { schema: spec.schema } : {}),
    ...(spec.example !== undefined ? { example: spec.example } : {}),
  };
}

/**
 * Whether what the caller supplied is the shape `generate` will read.
 *
 * Absent inputs are not this function's business — whether a step may proceed
 * without them is `inputGate`'s call, and a step can legitimately declare
 * fields it does not require.
 */
export function checkInputs(
  spec: InputSpec,
  inputs: Record<string, unknown> | undefined,
): InputCheck {
  if (inputs === undefined) return { ok: true, problems: [], message: "" };

  const supplied = Object.fromEntries(
    Object.entries(inputs).filter(([key]) => !CONTROL_KEYS.has(key)),
  );

  const nested = nestingProblems(spec, supplied);
  // Reported alone: the schema's complaint about the same mistake is "must
  // have required property 'city_code'", which is true, unhelpful, and points
  // away from the fix.
  if (nested.length > 0) return failure(nested);

  if (spec.schema === undefined) return { ok: true, problems: [], message: "" };

  const validate = ajv.compile(spec.schema);
  if (validate(supplied)) return { ok: true, problems: [], message: "" };

  const problems = (validate.errors ?? []).map(
    (error: ErrorObject): InputProblem => {
      const field =
        error.instancePath.replace(/^\//, "").replace(/\//g, ".") ||
        asString(
          (error.params as { missingProperty?: unknown }).missingProperty,
        );
      return {
        code: "schema",
        ...(field !== undefined && field !== "" ? { field } : {}),
        message: `\`inputs${field !== undefined && field !== "" ? `.${field}` : ""}\` ${error.message ?? "is invalid"}.`,
      };
    },
  );

  return failure(
    problems.length > 0
      ? problems
      : [
          {
            code: "schema",
            message: "`inputs` does not match the declared schema.",
          },
        ],
  );
}

function nestingProblems(
  spec: InputSpec,
  supplied: Record<string, unknown>,
): InputProblem[] {
  const problems: InputProblem[] = [];

  for (const [key, value] of Object.entries(supplied)) {
    if (!spec.wrapperNames.includes(key)) continue;
    if (asRecord(value) === undefined) continue;

    const names = spec.fields.map((field) => field.name);
    problems.push({
      code: "nested_under_declaration",
      field: key,
      message:
        `"${key}" is the name of the input declaration, not a value to nest ` +
        `under — the generator reads ${
          names.length > 0
            ? names.map((name) => `\`${name}\``).join(", ")
            : "its fields"
        } off the top of \`inputs\`. ` +
        (spec.example !== undefined
          ? `Send \`inputs\` as ${JSON.stringify(spec.example)}.`
          : `Send those fields at the top level of \`inputs\`.`),
    });
  }

  return problems;
}

function failure(problems: InputProblem[]): InputCheck {
  return {
    ok: false,
    problems,
    message: problems.map((problem) => problem.message).join(" "),
  };
}
