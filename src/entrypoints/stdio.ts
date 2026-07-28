#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { config } from "@/config/env.js";
import { createContainer } from "@/container.js";
import { logger } from "@/lib/logger.js";
import { guardStdout } from "@/lib/stdout-guard.js";
import { createServerFactory } from "@/mcp/server.js";

// Before a single tool runs — and certainly before the mock-runner's worker
// pool boots — rebind `console` onto stderr so no dependency can write into
// the JSON-RPC stream. Console methods are read at call time, so installing
// the guard here covers every module already imported. See `lib/stdout-guard.ts`.
guardStdout();

/**
 * stdio entrypoint — for local clients (Claude Code, Claude Desktop, the MCP
 * Inspector), which launch this process and speak JSON-RPC over stdin/stdout.
 *
 * ## stdout belongs to the protocol
 *
 * Nothing here may write to stdout except the transport. Diagnostics go to
 * stderr via the logger; `no-console` is an ESLint error; and
 * `stdio.test.ts` spawns this file and fails the build if a single
 * non-protocol byte appears on stdout.
 *
 * Unlike the HTTP entrypoint, `serveStdio` pins **one** server instance for
 * the lifetime of the connection — a stdio connection is inherently a session.
 * The same factory backs both, so the capabilities are identical either way.
 */

async function main(): Promise<void> {
  const container = await createContainer(config);

  const handle = serveStdio(createServerFactory(container), {
    // Also serve clients still speaking the 2025 protocol.
    legacy: "serve",
    onerror: (error) => {
      logger.error({ err: error }, "stdio transport error");
    },
  });

  logger.info({ transport: "stdio" }, "mcp server ready");

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    void (async () => {
      try {
        await handle.close();
        await container.dispose();
        process.exit(0);
      } catch (error) {
        logger.error({ err: error }, "error during shutdown");
        process.exit(1);
      }
    })();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // The client closing stdin is the stdio equivalent of a hangup.
  process.stdin.on("close", () => {
    shutdown("SIGTERM");
  });
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "failed to start stdio server");
  process.exit(1);
});
