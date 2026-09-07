import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_BUILD, FIXTURE_FLOW_ID } from "@/test/fakes.js";
import { createHarness, resourceText, type Harness } from "@/test/harness.js";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.close();
});

async function openSession(npType = "BAP"): Promise<string> {
  const result = await harness.client.callTool({
    name: "session_create",
    arguments: {
      subscriber_url: "https://np.example.com",
      np_type: npType,
      domain: FIXTURE_BUILD.domain,
      version: FIXTURE_BUILD.version,
      usecase: FIXTURE_BUILD.usecase,
    },
  });
  const { session } = result.structuredContent as {
    session: { session_id: string };
  };
  return session.session_id;
}

function textOf(result: { content: unknown }): string {
  return (result.content as { type: string; text: string }[])[0]?.text ?? "";
}

describe("catalog tools over MCP", () => {
  it("lists published builds without needing a session", async () => {
    const result = await harness.client.callTool({
      name: "catalog_list_builds",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain(FIXTURE_BUILD.domain);
  });

  it("filters the catalog by domain", async () => {
    const result = await harness.client.callTool({
      name: "catalog_list_builds",
      arguments: { domain: FIXTURE_BUILD.domain },
    });

    expect(result.structuredContent).toMatchObject({ total: 1 });
  });

  it("lists a session's flows with per-actor counts", async () => {
    const sessionId = await openSession();

    const result = await harness.client.callTool({
      name: "catalog_list_flows",
      arguments: { session_id: sessionId },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      mock_role: "BPP",
      build: FIXTURE_BUILD,
    });
    expect(textOf(result)).toContain("mock plays BPP");
  });

  it("describes a flow, marking who sends each step", async () => {
    const sessionId = await openSession();

    const result = await harness.client.callTool({
      name: "catalog_describe_flow",
      arguments: { session_id: sessionId, flow_id: FIXTURE_FLOW_ID },
    });

    expect(result.isError).toBeFalsy();

    const flow = result.structuredContent as {
      sequence: { type: string; actor: string }[];
      mock_role: string;
    };
    expect(flow.mock_role).toBe("BPP");
    expect(flow.sequence.find((step) => step.type === "on_search")?.actor).toBe(
      "mock",
    );

    // The rendered legend is how the model tells the two apart at a glance.
    expect(textOf(result)).toContain("» = this server sends it");
  });

  it("summarises a flow's mock config without leaking the config itself", async () => {
    const sessionId = await openSession();

    const result = await harness.client.callTool({
      name: "catalog_load_flow_config",
      arguments: { session_id: sessionId, flow_id: FIXTURE_FLOW_ID },
    });

    expect(result.isError).toBeFalsy();

    const summary = result.structuredContent as {
      cache_key: string;
      steps: { has: Record<string, boolean> }[];
      total_bytes: number;
    };
    expect(summary.cache_key).toContain(FIXTURE_FLOW_ID);
    expect(summary.steps[0]?.has.generate).toBe(true);
    expect(summary.total_bytes).toBeGreaterThan(0);

    // The whole point of the summary: the payload the model receives is a
    // fraction of the config held server-side.
    expect(JSON.stringify(summary).length).toBeLessThan(summary.total_bytes);
  });

  it("reports an unknown flow as an error result naming the real ones", async () => {
    const sessionId = await openSession();

    const result = await harness.client.callTool({
      name: "catalog_describe_flow",
      arguments: { session_id: sessionId, flow_id: "Nope" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("refuses flow tools for an expired or unknown session", async () => {
    const result = await harness.client.callTool({
      name: "catalog_list_flows",
      arguments: { session_id: "gone" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("serves the build catalog as a resource", async () => {
    const read = await harness.client.readResource({ uri: "ondc://builds" });
    const parsed = JSON.parse(resourceText(read)) as {
      builds: { domain: string }[];
    };

    expect(parsed.builds.map((build) => build.domain)).toContain(
      FIXTURE_BUILD.domain,
    );
  });
});

describe("the reality block on catalog_describe_flow", () => {
  it("says a flow is one path, and names what the build also permits", async () => {
    // It rides along on the tool the model already reads before every run,
    // rather than waiting in a tool it has to think to call. A prompt is
    // opt-in in every client; this is not.
    const sessionId = await openSession();
    const result = await harness.client.callTool({
      name: "catalog_describe_flow",
      arguments: { session_id: sessionId, flow_id: FIXTURE_FLOW_ID },
    });

    const { reality } = result.structuredContent as {
      reality?: { note: string; may_start_with: string[]; not_in_this_flow: string[] };
    };
    expect(reality).toBeDefined();
    expect(reality?.note).toMatch(/ONE path/);
    expect(reality?.may_start_with.length).toBeGreaterThan(0);
    expect(textOf(result)).toMatch(/ONE path/);
  });

  it("stays inside its byte budget", async () => {
    const sessionId = await openSession();
    const result = await harness.client.callTool({
      name: "catalog_describe_flow",
      arguments: { session_id: sessionId, flow_id: FIXTURE_FLOW_ID },
    });
    const { reality } = result.structuredContent as { reality?: unknown };
    expect(JSON.stringify(reality).length).toBeLessThan(1_500);
  });

  it("is absent, not broken, when the protocol module is off", async () => {
    const off = await createHarness({ env: { MODULES_DISABLED: "protocol" } });
    try {
      const created = await off.client.callTool({
        name: "session_create",
        arguments: {
          subscriber_url: "https://np.example.com",
          np_type: "BAP",
          domain: FIXTURE_BUILD.domain,
          version: FIXTURE_BUILD.version,
          usecase: FIXTURE_BUILD.usecase,
        },
      });
      const { session } = created.structuredContent as {
        session: { session_id: string };
      };
      const result = await off.client.callTool({
        name: "catalog_describe_flow",
        arguments: { session_id: session.session_id, flow_id: FIXTURE_FLOW_ID },
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).not.toHaveProperty("reality");
      // The sequence itself must still be there — that is the whole point of
      // making the block optional rather than part of the answer.
      const { sequence } = result.structuredContent as { sequence: unknown[] };
      expect(sequence.length).toBeGreaterThan(0);
    } finally {
      await off.close();
    }
  });
});
