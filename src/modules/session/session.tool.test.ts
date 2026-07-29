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
        "receiver_start",
        "receiver_stop",
        "session_create",
        "session_get",
        "catalog_list_builds",
        "catalog_list_flows",
        "catalog_describe_flow",
        "catalog_load_flow_config",
        "flow_start",
        "flow_get_status",
        "flow_proceed",
        "flow_await",
        "record_get_payload",
        "record_get_data",
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

  it("defaults the interaction settings and mints a callback URL", async () => {
    const result = await harness.client.callTool({
      name: "session_create",
      arguments: createArgs(),
    });

    const { session } = result.structuredContent as {
      session: {
        session_id: string;
        interaction_mode: string;
        auto_advance: boolean;
        callback_url: string;
      };
    };

    expect(session.interaction_mode).toBe("llm_auto");
    expect(session.auto_advance).toBe(false);
    // The network's shape, not ours, and shared across sessions on this build:
    // a participant integrates against an endpoint, not a test run. np_type is
    // BAP here, so the mock is a BPP and advertises the `seller` URI.
    expect(session.callback_url).toBe(
      `http://127.0.0.1:3000/${FIXTURE_BUILD.domain}/${FIXTURE_BUILD.version}/seller`,
    );

    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("callback:");
  });

  it("accepts manual mode, auto-advance and a tunnel override", async () => {
    const result = await harness.client.callTool({
      name: "session_create",
      arguments: {
        ...createArgs(),
        interaction_mode: "manual",
        auto_advance: true,
        receiver_public_url: "https://tunnel.example.com",
      },
    });

    const { session } = result.structuredContent as {
      session: {
        session_id: string;
        interaction_mode: string;
        auto_advance: boolean;
        callback_url: string;
      };
    };

    expect(session.interaction_mode).toBe("manual");
    expect(session.auto_advance).toBe(true);
    // A tunnel address is the whole point of the override: without it the
    // participant is told to call an address only this machine can reach.
    expect(session.callback_url).toBe(
      `https://tunnel.example.com/${FIXTURE_BUILD.domain}/${FIXTURE_BUILD.version}/seller`,
    );

    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("manual — ask the human");
    expect(text).toContain("advance:    auto");
  });

  it("refuses a tunnel override that moves the path, not just the host", async () => {
    // Routes are registered once at boot under one prefix. Advertising a
    // different one would hand the participant a URL this server does not
    // serve, and the mistake would surface as a 404 on its first callback.
    const result = await harness.client.callTool({
      name: "session_create",
      arguments: createArgs({
        receiver_public_url: "https://tunnel.example.com/api-service",
      }),
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "validation_error" },
    });
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
