import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ValidatePayloadOutput } from "@/modules/validate/validate.schema.js";
import {
  createFakeValidationGateway,
  invalidFrom,
  type FakeValidationGateway,
} from "@/test/fakes.js";
import { createHarness, type Harness } from "@/test/harness.js";
import { RUNNABLE_BUILD } from "@/test/runnable-config.js";
import { L0_MULTI_ENTRY, L1_MULTI_RULE } from "@/test/validation-fixtures.js";

const NP = "https://np.example.com";

let harness: Harness;
let validation: FakeValidationGateway;
let sessionId: string;

function payload(overrides: Record<string, unknown> = {}): unknown {
  return {
    context: {
      domain: RUNNABLE_BUILD.domain,
      version: RUNNABLE_BUILD.version,
      action: "search",
      transaction_id: "txn-1",
      message_id: "msg-1",
      timestamp: new Date().toISOString(),
      ...overrides,
    },
    message: { intent: {} },
  };
}

async function validate(
  args: Record<string, unknown>,
): Promise<{ output: ValidatePayloadOutput; text: string; isError: boolean }> {
  const result = await harness.client.callTool({
    name: "payload_validate",
    arguments: args,
  });
  return {
    output: result.structuredContent as ValidatePayloadOutput,
    text: (result.content as { text: string }[])[0]?.text ?? "",
    isError: result.isError === true,
  };
}

beforeEach(async () => {
  validation = createFakeValidationGateway();
  harness = await createHarness({ validationGateway: validation });

  const created = await harness.client.callTool({
    name: "session_create",
    arguments: {
      subscriber_url: NP,
      np_type: "BPP",
      domain: RUNNABLE_BUILD.domain,
      version: RUNNABLE_BUILD.version,
      usecase: RUNNABLE_BUILD.usecase,
    },
  });
  sessionId = (created.structuredContent as { session: { session_id: string } })
    .session.session_id;
});

afterEach(async () => {
  await harness.close();
});

describe("payload_validate", () => {
  it("judges a payload against the session's build", async () => {
    const { output } = await validate({ session_id: sessionId, payload: payload() });

    expect(output.status).toBe("valid");
    expect(output.action).toBe("search");
    expect(validation.seen[0]).toMatchObject({
      domain: RUNNABLE_BUILD.domain,
      version: RUNNABLE_BUILD.version,
      action: "search",
    });
  });

  it("takes the action from the payload's own context", async () => {
    const { output } = await validate({
      session_id: sessionId,
      payload: payload({ action: "select" }),
    });

    expect(output.action).toBe("select");
  });

  it("lets an explicit action override the context", async () => {
    const { output } = await validate({
      session_id: sessionId,
      payload: payload({ action: "select" }),
      action: "search",
    });

    expect(output.action).toBe("search");
  });

  it("returns findings with a code and a JSONPath", async () => {
    validation.setResult(invalidFrom(L1_MULTI_RULE));
    const { output } = await validate({ session_id: sessionId, payload: payload() });

    expect(output.status).toBe("invalid");
    expect(output.findings[0]).toMatchObject({
      layer: "L1",
      code: "REQUIRED_CONTEXT_CODE_1",
      json_path: "$.context.location.country.code",
    });
  });

  it("renders findings and coverage for the model to read", async () => {
    validation.setResult(invalidFrom(L0_MULTI_ENTRY));
    const { text } = await validate({ session_id: sessionId, payload: payload() });

    expect(text).toContain("REJECTED");
    expect(text).toContain("$.context.timestamp");
    // The coverage block is not decoration: two of four layers are unbuilt, and
    // a verdict that hid that would read as a clean bill of health.
    expect(text).toContain("not checked:");
    expect(text).toContain("context");
  });

  it("says a payload went unjudged rather than calling it valid", async () => {
    validation.setResult({ status: "unavailable", reason: "oracle was down" });
    const { output, text } = await validate({
      session_id: sessionId,
      payload: payload(),
    });

    expect(output.status).toBe("unavailable");
    expect(output.checked).toEqual([]);
    expect(text).toContain("no verdict");
  });

  it("asks for an action rather than guessing when the context has none", async () => {
    const { isError, text } = await validate({
      session_id: sessionId,
      payload: { context: { transaction_id: "t" }, message: {} },
    });

    // Tool channel — the model can fix this in one retry.
    expect(isError).toBe(true);
    expect(text).toContain("context.action");
  });

  it("reports an unknown session on the tool channel", async () => {
    const { isError } = await validate({
      session_id: "nope",
      payload: payload(),
    });

    expect(isError).toBe(true);
  });

  it("is announced as read-only, because it is", async () => {
    const { tools } = await harness.client.listTools();
    const tool = tools.find((entry) => entry.name === "payload_validate");

    // Clients auto-approve on these. Nothing is recorded here, and the oracle
    // behind it has no side effects of its own.
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
    });
  });
});
