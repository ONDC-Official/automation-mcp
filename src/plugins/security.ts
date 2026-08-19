import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation as mcpOriginValidation,
} from "@modelcontextprotocol/fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { Config } from "@/config/env.js";
import {
  addPrivateNetworkPreflight,
  UI_ROUTE_PREFIX,
  uiCorsOrigins,
} from "@/modules/ui/ui.routes.js";

/**
 * Transport hardening.
 *
 * Helmet, CORS and the rate limiter are app-wide: they are about the process,
 * not about who is calling.
 *
 * **DNS rebinding protection is not.** Without Host/Origin validation any web
 * page the user visits can have their browser resolve an attacker domain to
 * 127.0.0.1 and drive a local MCP server, which is a fully-privileged tool
 * surface with no browser origin policy in front of it. That threat is
 * specific to the MCP endpoint, so the two hooks are exported here and
 * attached to that route in `mcp.ts` rather than to the whole app.
 *
 * Applying them app-wide would break the thing this server exists to do: the
 * ONDC receiver is a *public* endpoint that a third-party participant reaches
 * over a tunnel or a proxy, and `localhostHostValidation` — the default
 * whenever `MCP_ALLOWED_HOSTS` is unset — would 403 every one of its callbacks
 * before the receiver ever saw them.
 */

/** Host header check for the MCP surface. */
export function hostValidation(config: Config) {
  return config.MCP_ALLOWED_HOSTS
    ? hostHeaderValidation(config.MCP_ALLOWED_HOSTS)
    : localhostHostValidation();
}

/** Origin check for the MCP surface. */
export function originValidation(config: Config) {
  return config.MCP_ALLOWED_ORIGINS
    ? mcpOriginValidation(config.MCP_ALLOWED_ORIGINS)
    : localhostOriginValidation();
}

async function plugin(app: FastifyInstance, config: Config): Promise<void> {
  await app.register(helmet, {
    // Still `'none'`: this process serves JSON and the odd machine-generated
    // form page, never an application UI. The viewer's page is hosted
    // elsewhere and only *reads* `/ui/api`, so nothing here needs to load a
    // script, a style or a font.
    contentSecurityPolicy: { directives: { "default-src": ["'none'"] } },
  });

  addPrivateNetworkPreflight(app, config);

  // One cors registration, path-aware, rather than a second one scoped to the
  // viewer: `@fastify/cors` claims the `OPTIONS *` route, so registering it
  // twice is a duplicate-route error at boot. The delegate form is how it
  // supports differing per request, and it keeps both allow-lists in one place.
  const uiOrigins = uiCorsOrigins(config);

  await app.register(cors, {
    // A thenable because `@fastify/cors` tells a promise-shaped delegate from a
    // callback-shaped one by arity, and answers `Invalid CORS origin option`
    // when a one-argument delegate returns something that is not one.
    delegator: (request: FastifyRequest) =>
      Promise.resolve({
        origin: request.url.startsWith(UI_ROUTE_PREFIX)
          ? uiOrigins
          : (config.MCP_ALLOWED_ORIGINS ?? false),
        // Clients read the session/protocol headers off the response.
        exposedHeaders: ["mcp-protocol-version", "www-authenticate"],
        // The viewer authenticates with a token it holds, never with a cookie —
        // so nothing here should be sent ambiently by a browser.
        credentials: false,
      }),
  });

  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    // Rate limits are per-instance. Behind more than one replica, point this
    // at a shared store (@fastify/rate-limit accepts a Redis client) or the
    // effective limit multiplies by the replica count.
  });

  // Host/Origin validation is deliberately NOT registered here — see above.
}

export const securityPlugin = fp(plugin, {
  name: "security",
  fastify: "5.x",
});
