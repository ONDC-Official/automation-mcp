import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, resourceText, type Harness } from "@/test/harness.js";
import { FIXTURE_BUILD } from "@/test/fakes.js";

/**
 * Tool-layer tests: a real client talking to a real server over an in-memory
 * transport, so schema conversion, result envelopes and error channels are all
 * genuinely exercised.
 */

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.close();
});

function createArgs(overrides: Record<string, unknown> = {}) {
  return {
    subscriber_url: "https://bap.example.com",
    np_type: "BAP",
    domain: FIXTURE_BUILD.domain,
    version: FIXTURE_BUILD.version,
    usecase: FIXTURE_BUILD.usecase,
    ...overrides,
  };
}

describe("session tools over MCP", () => {
  it("advertises the mock-participant tools with both schemas", async () => {
    const { tools } = await harness.client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "session_create",
        "session_get",
        "catalog_list_builds",
        "catalog_list_flows",
        "catalog_describe_flow",
        "catalog_load_flow_config",
      ]),
    );

    for (const tool of tools) {
      expect(tool.inputSchema, `${tool.name} inputSchema`).toBeDefined();
      expect(tool.outputSchema, `${tool.name} outputSchema`).toBeDefined();
    }
  });

  it("creates a session, inverting the role and listing flows", async () => {
    const result = await harness.client.callTool({
      name: "session_create",
      arguments: createArgs(),
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      session: {
        np: { type: "BAP", subscriber_url: "https://bap.example.com" },
        mock_role: "BPP",
        build: FIXTURE_BUILD,
      },
    });

    const { total } = result.structuredContent as { total: number };
    expect(total).toBeGreaterThan(0);

    // The text block is what the model reads; the inversion must be legible.
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    expect(text).toContain("mock plays: BPP");
    expect(text).toContain("flow(s) available");
  });

  it("returns an error result — not a protocol fault — for a bad use-case", async () => {
    const result = await harness.client.callTool({
      name: "session_create",
      arguments: createArgs({ usecase: "personal loan" }),
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "validation_error" },
    });
  });

  it("rejects a malformed subscriber URL at the schema boundary", async () => {
    const result = await harness.client.callTool({
      name: "session_create",
      arguments: createArgs({ subscriber_url: "not-a-url" }),
    });

    expect(result.isError).toBe(true);
  });

  it("round-trips a session through session_get", async () => {
    const created = await harness.client.callTool({
      name: "session_create",
      arguments: createArgs({ np_type: "BPP" }),
    });
    const { session } = created.structuredContent as {
      session: { session_id: string };
    };

    const fetched = await harness.client.callTool({
      name: "session_get",
      arguments: { session_id: session.session_id },
    });

    expect(fetched.isError).toBeFalsy();
    expect(fetched.structuredContent).toMatchObject({
      session: { session_id: session.session_id, mock_role: "BAP" },
    });
  });

  it("reports an unknown session as an error result", async () => {
    const result = await harness.client.callTool({
      name: "session_get",
      arguments: { session_id: "does-not-exist" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("serves a session as a resource", async () => {
    const created = await harness.client.callTool({
      name: "session_create",
      arguments: createArgs(),
    });
    const { session } = created.structuredContent as {
      session: { session_id: string };
    };

    const read = await harness.client.readResource({
      uri: `ondc://session/${session.session_id}`,
    });

    expect(JSON.parse(resourceText(read))).toMatchObject({
      session: { session_id: session.session_id },
    });
  });
});
