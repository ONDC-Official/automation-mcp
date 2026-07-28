import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
} from "@modelcontextprotocol/fastify";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Config } from "@/config/env.js";

/**
 * Transport hardening.
 *
 * The MCP-specific part is **DNS rebinding protection**. A local MCP server
 * is a fully-privileged tool surface listening on loopback with no browser
 * origin policy protecting it; without Host/Origin validation any web page the
 * user visits can have their browser resolve an attacker domain to 127.0.0.1
 * and drive the server. Both hooks come from the official Fastify adapter.
 */

async function plugin(app: FastifyInstance, config: Config): Promise<void> {
  await app.register(helmet, {
    // No browser UI is served here; a strict default CSP is still the right
    // posture for the JSON endpoints and any error pages.
    contentSecurityPolicy: { directives: { "default-src": ["'none'"] } },
  });

  await app.register(cors, {
    origin: config.MCP_ALLOWED_ORIGINS ?? false,
    // Clients read the session/protocol headers off the response.
    exposedHeaders: ["mcp-protocol-version", "www-authenticate"],
    credentials: false,
  });

  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    // Rate limits are per-instance. Behind more than one replica, point this
    // at a shared store (@fastify/rate-limit accepts a Redis client) or the
    // effective limit multiplies by the replica count.
  });

  app.addHook(
    "onRequest",
    config.MCP_ALLOWED_HOSTS
      ? hostHeaderValidation(config.MCP_ALLOWED_HOSTS)
      : localhostHostValidation(),
  );

  app.addHook(
    "onRequest",
    config.MCP_ALLOWED_ORIGINS
      ? originValidation(config.MCP_ALLOWED_ORIGINS)
      : localhostOriginValidation(),
  );
}

export const securityPlugin = fp(plugin, {
  name: "security",
  fastify: "5.x",
});
