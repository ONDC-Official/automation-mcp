import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { pino, type Bindings, type Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  correlationFields,
  defineTool,
  undeclaredPaths,
  type ToolHooks,
} from "@/lib/define-tool.js";
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

/**
 * The published schema and the object a handler builds are two spellings of one
 * shape, and nothing on this side notices when they stop agreeing.
 *
 * `protocol_describe_action` set a `depth` key `ActionField` did not declare.
 * The SDK's own output check passed — it validates through the standard schema,
 * which for zod *strips* unknown keys rather than refusing them, and then sends
 * the unstripped original — so the only symptom was strict clients rejecting
 * every non-empty result, and no client can file an incident.
 */

async function callWithDrift(
  handler: () => Promise<Record<string, unknown>>,
  hooks?: ToolHooks,
): Promise<{ structuredContent: unknown; text: string; isError?: boolean }> {
  const server = new McpServer(
    { name: "define-tool-test", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  defineTool({
    name: "test_drifts",
    title: "Test tool",
    description: "Returns more than it declares.",
    inputSchema: z.object({ session_id: z.string().optional() }),
    outputSchema: z.object({
      total: z.number(),
      items: z.array(z.object({ path: z.string() })),
    }),
    render: (output) => JSON.stringify(output),
    handler: handler as never,
  }).register(server, hooks);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    // The client only checks a result against a schema it has already seen, so
    // this listing is what makes the assertion below mean anything at all.
    await client.listTools();
    const result = await client.callTool({
      name: "test_drifts",
      arguments: { session_id: "sess-1" },
    });
    return {
      structuredContent: result.structuredContent,
      text: (result.content as { text: string }[])[0]?.text ?? "",
      ...(result.isError !== undefined ? { isError: result.isError } : {}),
    };
  } finally {
    await client.close();
    await server.close();
  }
}

describe("undeclaredPaths", () => {
  it("names a key the parse dropped, at depth", () => {
    expect(
      undeclaredPaths({ a: 1, b: { c: 2, d: 3 } }, { a: 1, b: { c: 2 } }),
    ).toEqual(["b.d"]);
  });

  it("collapses array indices, so a hundred rows are one path", () => {
    const items = Array.from({ length: 100 }, () => ({ path: "$", depth: 2 }));
    expect(
      undeclaredPaths(
        { items },
        { items: items.map(({ path }) => ({ path })) },
      ),
    ).toEqual(["items[].depth"]);
  });

  it("is not tripped by an explicitly undefined value", () => {
    // JSON drops it and so does the parse: it never reaches the wire either
    // way, so calling it drift would cry wolf on a shape that is fine.
    expect(undeclaredPaths({ a: 1, b: undefined }, { a: 1 })).toEqual([]);
  });

  it("answers nothing when the two agree", () => {
    expect(undeclaredPaths({ a: [1, 2] }, { a: [1, 2] })).toEqual([]);
  });
});

describe("tool output conforms to its own schema", () => {
  it("drops an undeclared key instead of shipping it to the client", async () => {
    const result = await callWithDrift(() =>
      Promise.resolve({
        total: 1,
        items: [{ path: "$.context", depth: 2 }],
        extra: "nope",
      }),
    );

    // A strict client would have refused this result outright.
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      total: 1,
      items: [{ path: "$.context" }],
    });
    // Rendered from the same value, so the prose cannot describe a key the
    // structured half no longer carries.
    expect(result.text).not.toContain("depth");
  });

  it("reports the drift, because a silent strip would hide the defect", async () => {
    const seen: { tool: string; paths: string[]; sessionId?: string }[] = [];

    await callWithDrift(
      () =>
        Promise.resolve({
          total: 1,
          items: [{ path: "$.context", depth: 2 }],
        }),
      {
        onOutputDrift: (tool, paths, sessionId) => {
          seen.push({
            tool,
            paths,
            ...(sessionId !== undefined ? { sessionId } : {}),
          });
        },
      },
    );

    expect(seen).toEqual([
      {
        tool: "test_drifts",
        paths: ["items[].depth"],
        // Lifted off the input by the correlation helper, so the incident is
        // filed against the session that made the call.
        sessionId: "sess-1",
      },
    ]);
  });

  it("says nothing when a tool returns exactly what it declares", async () => {
    const seen: string[][] = [];
    const result = await callWithDrift(
      () => Promise.resolve({ total: 0, items: [] }),
      { onOutputDrift: (_tool, paths) => seen.push(paths) },
    );

    expect(result.structuredContent).toEqual({ total: 0, items: [] });
    expect(seen).toEqual([]);
  });

  it("leaves a genuinely invalid output to the SDK", async () => {
    // Not our error to raise: the SDK's own output check already says it, and
    // says it better. What must not happen is a strip that papers over it.
    const result = await callWithDrift(() =>
      Promise.resolve({ total: "one", items: [] }),
    );
    expect(result.isError).toBeTruthy();
  });
});
