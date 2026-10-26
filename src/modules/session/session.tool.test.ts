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

  it("hands the viewer link over as a directive, not as a field", async () => {
    const result = await harness.client.callTool({
      name: "session_create",
      arguments: createArgs(),
    });

    const { viewer_url } = result.structuredContent as { viewer_url?: string };
    expect(viewer_url).toBeDefined();

    const text = (result.content as { text: string }[])[0]?.text ?? "";
    const lines = text.split("\n");

    /*
     * The URL must stand on its own line, under the directive, and *not* be
     * one of the aligned `key:` fields above it. Inside that block a model
     * composing its reply summarised it away with the rest of the plumbing,
     * which is the whole bug this shape exists to fix.
     */
    expect(text).toContain("HAND THIS TO THE PERSON YOU ARE TESTING FOR");
    expect(text).toContain("before your next tool call");
    expect(text).toContain("plain text on its own line");
    expect(text).toContain("auto mode too");

    const urlLine = lines.findIndex((line) => line.includes(viewer_url ?? ""));
    expect(urlLine).toBeGreaterThan(-1);
    expect(lines[urlLine]?.trim()).toBe(viewer_url);
    expect(lines.slice(0, urlLine).join("\n")).toContain(
      "HAND THIS TO THE PERSON",
    );
  });

  it("ends by telling the model to list the flows and ask run or explain", async () => {
    const result = await harness.client.callTool({
      name: "session_create",
      arguments: createArgs(),
    });

    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(text.trimEnd()).toMatch(/run one or explain one first\.$/);
  });

  it("asks for the mode before a session is created", async () => {
    const { tools } = await harness.client.listTools();
    const create = tools.find((tool) => tool.name === "session_create");
    expect(create?.description).toContain("manual or auto mode");
  });

  it("restates the viewer link on session_get, for a human who lost it", async () => {
    const created = await harness.client.callTool({
      name: "session_create",
      arguments: createArgs(),
    });
    const { session, viewer_url } = created.structuredContent as {
      session: { session_id: string };
      viewer_url?: string;
    };

    const fetched = await harness.client.callTool({
      name: "session_get",
      arguments: { session_id: session.session_id },
    });

    expect(fetched.structuredContent).toMatchObject({ viewer_url });
    const text = (fetched.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain(viewer_url);
    expect(text).toContain("HAND THIS TO THE PERSON YOU ARE TESTING FOR");
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
    // Follows the interaction mode. An `llm_auto` caller has already said it
    // supplies everything itself, so asking it to approve a step that needs
    // nothing is a question it can only answer one way — and everything sent
    // this way comes back as a CHAIN_SENT event, so nothing happens unseen.
    expect(session.auto_advance).toBe(true);
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

describe("session settings over MCP", () => {
  /** A server that can verify signatures: it has a registry to ask. */
  async function withKeys(): Promise<void> {
    await harness.close();
    harness = await createHarness({
      registryGateway: {
        lookup: () => Promise.resolve({ status: "not_found" }),
      },
    });
  }

  async function create(args: Record<string, unknown> = {}) {
    const created = await harness.client.callTool({
      name: "session_create",
      arguments: createArgs(args),
    });
    return created.structuredContent as {
      session: { session_id: string; settings: unknown };
      header_validation_available: boolean;
    };
  }

  function update(sessionId: string, settings: Record<string, unknown>) {
    return harness.client.callTool({
      name: "session_update_settings",
      arguments: { session_id: sessionId, settings },
    });
  }

  async function sessionText(sessionId: string): Promise<string> {
    const got = await harness.client.callTool({
      name: "session_get",
      arguments: { session_id: sessionId },
    });
    return (got.content as { type: string; text: string }[])[0]?.text ?? "";
  }

  describe("on a server with keys", () => {
    beforeEach(withKeys);

    it("checks signatures by default", async () => {
      const created = await create();
      expect(created.header_validation_available).toBe(true);
      expect(created.session.settings).toEqual({ header_validation: true });
    });

    it("takes settings at creation", async () => {
      const created = await create({ settings: { header_validation: false } });
      expect(created.session.settings).toEqual({ header_validation: false });
    });

    it("turns header validation off and on mid-session", async () => {
      const { session } = await create();

      const off = await update(session.session_id, {
        header_validation: false,
      });
      expect(off.isError).toBeFalsy();
      expect(off.structuredContent).toMatchObject({
        settings: { header_validation: false },
      });
      expect(await sessionText(session.session_id)).toContain(
        "signatures: not checked (header_validation off)",
      );

      const on = await update(session.session_id, { header_validation: true });
      expect(on.structuredContent).toMatchObject({
        settings: { header_validation: true },
      });
    });

    it("leaves settings it was not given alone", async () => {
      const { session } = await create({
        settings: { header_validation: false },
      });
      const result = await update(session.session_id, {});
      expect(result.structuredContent).toMatchObject({
        settings: { header_validation: false },
      });
    });
  });

  describe("on a server with no keys", () => {
    it("creates every session with header validation off, and says why", async () => {
      const created = await create({ settings: { header_validation: true } });

      expect(created.header_validation_available).toBe(false);
      expect(created.session.settings).toEqual({ header_validation: false });
      expect(await sessionText(created.session.session_id)).toContain(
        "this server has no signing keys",
      );
    });

    it("refuses to turn header validation on", async () => {
      const { session } = await create();

      const result = await update(session.session_id, {
        header_validation: true,
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: "validation_error" },
      });
    });
  });

  it("reports an unknown session as an error result", async () => {
    const result = await update("does-not-exist", { header_validation: false });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "not_found" },
    });
  });
});
