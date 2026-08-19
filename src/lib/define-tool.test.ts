import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { pino, type Bindings, type Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { correlationFields, defineTool } from "@/lib/define-tool.js";
import { logger } from "@/lib/logger.js";

/**
 * Correlation is asserted at the boundary, not per tool.
 *
 * `correlationFields` is the whole of the mechanism, so it is tested directly;
 * the plumbing test below then proves the fields actually reach the two lines
 * `defineTool` emits, which is the part a refactor could silently drop.
 */

describe("correlationFields", () => {
  it("lifts the three session-scoped keys off a tool's input", () => {
    expect(
      correlationFields({
        session_id: "s1",
        flow_id: "f1",
        transaction_id: "t1",
        inputs: { city_code: "std:080" },
      }),
    ).toEqual({ session_id: "s1", flow_id: "f1", transaction_id: "t1" });
  });

  it("takes only the keys that are present, and only when they are strings", () => {
    expect(correlationFields({ session_id: "s1" })).toEqual({
      session_id: "s1",
    });
    // A number here would render as `"7"` and quietly join the wrong lines.
    expect(correlationFields({ session_id: 7, flow_id: null })).toEqual({});
  });

  it("answers empty for anything that is not an object", () => {
    expect(correlationFields(undefined)).toEqual({});
    expect(correlationFields(null)).toEqual({});
    expect(correlationFields("session_id")).toEqual({});
  });
});

/** Log lines a tool call produced, captured off a real pino destination. */
async function callAndCapture(
  args: Record<string, unknown>,
  handler: () => Promise<{ ok: boolean }> = () => Promise.resolve({ ok: true }),
): Promise<Record<string, unknown>[]> {
  const lines: Record<string, unknown>[] = [];
  const capture = pino(
    { level: "trace" },
    {
      write(line: string): void {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );

  // `requestLogger` builds its child off the module singleton, which is pinned
  // to stderr and so cannot be read back in-process. Swapping only `child`
  // keeps the real merge — bindings still go through pino, not an assertion.
  vi.spyOn(logger, "child").mockImplementation(((bindings: Bindings) =>
    capture.child(bindings)) as unknown as Logger["child"]);

  const server = new McpServer(
    { name: "define-tool-test", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  defineTool({
    name: "test_do_thing",
    title: "Test tool",
    description: "Exists only to be called.",
    inputSchema: z.object({
      session_id: z.string().optional(),
      flow_id: z.string().optional(),
    }),
    outputSchema: z.object({ ok: z.boolean() }),
    render: () => "done",
    handler,
  }).register(server);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    await client.callTool({ name: "test_do_thing", arguments: args });
  } finally {
    await client.close();
    await server.close();
  }

  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tool-boundary correlation", () => {
  it("tags the success line with the input's session and flow", async () => {
    const lines = await callAndCapture({ session_id: "s1", flow_id: "f1" });

    const succeeded = lines.find((line) => line.msg === "tool call succeeded");
    expect(succeeded).toMatchObject({
      tool: "test_do_thing",
      session_id: "s1",
      flow_id: "f1",
    });
  });

  it("tags the failure line too, which is the one that gets searched", async () => {
    const lines = await callAndCapture(
      { session_id: "s1", flow_id: "f1" },
      () => Promise.reject(new Error("boom")),
    );

    expect(lines.find((line) => line.msg === "tool call failed")).toMatchObject(
      {
        session_id: "s1",
        flow_id: "f1",
      },
    );
  });

  it("emits no correlation keys when the input carries none", async () => {
    const lines = await callAndCapture({});

    const succeeded = lines.find((line) => line.msg === "tool call succeeded");
    expect(succeeded).toBeDefined();
    expect(succeeded).not.toHaveProperty("session_id");
    expect(succeeded).not.toHaveProperty("flow_id");
  });
});
