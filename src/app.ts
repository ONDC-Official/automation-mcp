import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { Config } from "@/config/env.js";
import type { Container } from "@/container.js";
import { logger } from "@/lib/logger.js";
import { healthRoutes } from "@/modules/health/health.routes.js";
import { authPlugin } from "@/plugins/auth.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.js";
import { mcpPlugin } from "@/plugins/mcp.js";
import { securityPlugin } from "@/plugins/security.js";

/**
 * Builds the HTTP host and **does not listen**. `entrypoints/http.ts` is the
 * only file that binds a port; tests drive this instance through
 * `app.inject()` instead.
 *
 * ## Registration is explicit, not autoloaded
 *
 * The order below is load-bearing — security hooks must run before auth, auth
 * must be decorated before the MCP route can reference it as a preHandler, and
 * the error handler must be installed before any route. A directory autoloader
 * would hide that ordering behind filename luck, so the sequence is written out.
 */
export async function buildHttpApp(container: Container, config: Config) {
  const app = Fastify({
    // Share the process logger so stdio and HTTP emit the same shape — and so
    // HTTP logs also land on stderr, keeping stdout free of anything but data.
    loggerInstance: logger,
    requestTimeout: config.REQUEST_TIMEOUT_MS,
    // Trust the reverse proxy for client IPs (rate limiting) when not on loopback.
    trustProxy: config.HOST !== "127.0.0.1",
    genReqId: () => crypto.randomUUID(),
  });

  // zod as the one schema language, for REST routes as well as MCP tools.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(errorHandlerPlugin);
  await app.register(securityPlugin, config);
  await app.register(authPlugin, config);
  await app.register(mcpPlugin, container);
  await app.register(healthRoutes(container));

  return app;
}

/**
 * The concrete instance type, inferred rather than annotated: passing a pino
 * `Logger` as `loggerInstance` specialises Fastify's generics, so a plain
 * `FastifyInstance` annotation would not match.
 */
export type App = Awaited<ReturnType<typeof buildHttpApp>>;
