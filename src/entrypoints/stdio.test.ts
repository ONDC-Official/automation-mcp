import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The stdio contract, enforced end to end.
 *
 * Spawns the real entrypoint as a subprocess, speaks JSON-RPC to it, and
 * asserts that **every byte on stdout parses as a protocol message**. A stray
 * `console.log` anywhere in the dependency graph fails this test — which is
 * the point, because in production the same stray log corrupts the stream and
 * surfaces as an unrelated-looking parse error in the client.
 */

const ENTRYPOINT = fileURLToPath(new URL("./stdio.ts", import.meta.url));
const PROTOCOL_VERSION = "2026-07-28";

interface Exchange {
  stdout: string;
  stderr: string;
}

async function exchange(
  requests: unknown[],
  env: Record<string, string> = {},
): Promise<Exchange> {
  const child = spawn(process.execPath, ["--import", "tsx", ENTRYPOINT], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      // This test inherits the developer's environment, and a REDIS_URL
      // exported in their shell would have the child dial Redis and hold a
      // reconnect timer open — turning a stdout assertion into a hang. Empty
      // reads as unset (see `optionalUrl` in config/env.ts).
      REDIS_URL: "",
      ...env,
    },
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });

  for (const request of requests) {
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }

  // Give the server time to boot, answer, and log.
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  child.stdin.end();
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));

  return { stdout, stderr };
}

describe("stdio entrypoint", () => {
  it("writes only JSON-RPC messages to stdout and logs to stderr", async () => {
    const { stdout, stderr } = await exchange([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocol-version": PROTOCOL_VERSION,
          },
        },
      },
    ]);

    const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      // Throws — and fails the test — on any non-protocol output.
      const message = JSON.parse(line) as { jsonrpc?: string };
      expect(message.jsonrpc).toBe("2.0");
    }

    // The logger really is running; it just isn't on stdout.
    expect(stderr).toContain("mcp server ready");
    expect(stdout).not.toContain("mcp server ready");
  }, 20_000);

  it("answers tools/list with the registered tools", async () => {
    const { stdout } = await exchange([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocol-version": PROTOCOL_VERSION,
          },
        },
      },
    ]);

    const responses = stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const reply = responses.find((message) => message["id"] === 1);
    expect(reply).toBeDefined();

    const result = reply?.["result"] as
      { tools?: { name: string }[] } | undefined;
    expect(result?.tools?.map((tool) => tool.name)).toContain(
      "catalog_list_builds",
    );
  }, 20_000);

  it("keeps stdout clean with the mock-runner's own logging turned up", async () => {
    // `@ondc/automation-mock-runner` writes its diagnostics with `console.log`
    // whenever NODE_ENV=development or DEBUG is set. Those are exactly the
    // settings a developer reaches for while debugging a flow, and on stdio
    // they would land in the middle of the JSON-RPC stream. `guardStdout()`
    // is what stops that, and this is what proves it.
    const { stdout } = await exchange(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocol-version": PROTOCOL_VERSION,
            },
          },
        },
      ],
      { NODE_ENV: "development", DEBUG: "1", LOG_LEVEL: "debug" },
    );

    const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const message = JSON.parse(line) as { jsonrpc?: string };
      expect(message.jsonrpc).toBe("2.0");
    }
  }, 20_000);
});
