import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { Config } from "@/config/env.js";
import type { Container } from "@/container.js";
import { logger } from "@/lib/logger.js";
import { healthRoutes } from "@/modules/health/health.routes.js";
import { metricsRoutes } from "@/modules/metrics/metrics.routes.js";
import { formsRoutes } from "@/modules/forms/forms.routes.js";
import { receiverRoutes } from "@/modules/transport/receiver.routes.js";
import { uiRoutes } from "@/modules/ui/ui.routes.js";
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
    routerOptions: {
      // A counterparty that stored our URI with a trailing slash composes
      // `{uri}//{action}`; one that appends `/{action}/` leaves a trailing
      // slash. Both are the same call, and neither is worth a 404.
      ignoreTrailingSlash: true,
      ignoreDuplicateSlashes: true,
    },
  });

  // zod as the one schema language, for REST routes as well as MCP tools.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(errorHandlerPlugin);
  await app.register(securityPlugin, config);
  await app.register(authPlugin, config);
  await app.register(mcpPlugin, container);
  await app.register(healthRoutes(container));
  // Beside health, and unauthenticated in the same sense: an operator's probe,
  // not an MCP client's call. Its own bearer check lives in the route, because
  // `app.authenticate` answers with an OAuth discovery pointer a Prometheus
  // scraper cannot follow. Registers nothing at all when METRICS_ENABLED is off.
  await app.register(metricsRoutes(container));
  // The viewer's read-only JSON, root-mounted for the same reason as the two
  // above: it is an operator's surface, not a URL we advertise to a
  // counterparty. Registers nothing at all when UI_ENABLED is off.
  await app.register(uiRoutes(container));

  // The ONDC receiver, registered after health and left unauthenticated for
  // the same reason: it is called by a third-party network participant that has
  // no MCP credentials. Its authenticity check is the ONDC signature, inside
  // the receiver — not an MCP bearer token.
  // Both mount under the public URL's path, or every URI we advertise —
  // receiver and hosted forms alike — points somewhere this app does not serve.
  const mountOpts = { prefix: container.receiverRoutePrefix || "/" };
  await app.register(receiverRoutes(container), mountOpts);
  // Forms this mock hosts. Same reasoning: the person opening the link is a
  // tester following a URL out of a beckn payload, not an MCP client.
  await app.register(formsRoutes(container), mountOpts);
  container.receiver.markMounted();

  return app;
}

/**
 * The concrete instance type, inferred rather than annotated: passing a pino
 * `Logger` as `loggerInstance` specialises Fastify's generics, so a plain
 * `FastifyInstance` annotation would not match.
 */
export type App = Awaited<ReturnType<typeof buildHttpApp>>;
