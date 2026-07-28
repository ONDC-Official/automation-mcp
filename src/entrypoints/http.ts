import closeWithGrace from "close-with-grace";
import { buildHttpApp } from "@/app.js";
import { config } from "@/config/env.js";
import { createContainer } from "@/container.js";
import { logger } from "@/lib/logger.js";

/**
 * HTTP entrypoint — the **only** file in the codebase that binds a port.
 *
 * Everything it composes (`createContainer`, `buildHttpApp`) is independently
 * constructible, which is why the tests can exercise the whole stack through
 * `app.inject()` without a socket.
 */

async function main(): Promise<void> {
  const container = await createContainer(config);
  const app = await buildHttpApp(container, config);

  // Drain in-flight requests, then release resources. Fastify's `close()`
  // fires the onClose hooks, which is where the MCP handler shuts down.
  closeWithGrace(
    { delay: config.REQUEST_TIMEOUT_MS + 5_000 },
    async ({ signal, err }) => {
      if (err) logger.error({ err }, "shutting down after error");
      else logger.info({ signal }, "shutting down");

      await app.close();
      await container.dispose();
    },
  );

  await app.listen({ port: config.PORT, host: config.HOST });

  logger.info(
    {
      transport: "streamable-http",
      url: `http://${config.HOST}:${String(config.PORT)}/mcp`,
      authMode: config.AUTH_MODE,
    },
    "mcp server listening",
  );
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "failed to start http server");
  process.exit(1);
});
