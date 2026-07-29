import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Container } from "@/container.js";
import { createServerFactory } from "@/mcp/server.js";
import { hostValidation, originValidation } from "@/plugins/security.js";

/**
 * Mounts the MCP Streamable HTTP endpoint.
 *
 * `createMcpHandler` produces a fetch-shaped handler that builds one server
 * instance **per request** from the factory — no session map, no sticky
 * routing, no shared mutable state. That is what lets you put N replicas
 * behind a round-robin load balancer and have any of them answer any request.
 *
 * `toNodeHandler` adapts it to Node's `(req, res)` and is preferred over
 * hand-rolling Request/Response conversion because it honours write
 * backpressure on streamed SSE responses.
 */

const MCP_ROUTE = "/mcp";

async function plugin(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const handler = createMcpHandler(createServerFactory(container), {
    // Serve clients still speaking the 2025 protocol, statelessly, from the
    // same factory. Set to "reject" to go modern-only.
    legacy: "stateless",
    // Single JSON body unless a handler streams before its result.
    responseMode: "auto",
    // In-process event bus by default. For multiple replicas, pass a shared
    // implementation over Redis pub/sub so `subscriptions/listen` streams see
    // events raised on any instance.
    onerror: (error) => {
      app.log.error({ err: error }, "mcp handler error");
    },
  });

  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => {
      app.log.error({ err: error }, "mcp node adapter error");
    },
  });

  app.route({
    method: ["GET", "POST", "DELETE"],
    url: MCP_ROUTE,
    // DNS-rebinding protection, scoped to this route rather than the app.
    //
    // It exists because a local MCP server is a fully-privileged tool surface
    // on loopback with no browser origin policy in front of it. That threat is
    // specific to *this* endpoint: the receiver is a public protocol endpoint
    // that a third-party participant must be able to reach from anywhere, and
    // applying a localhost Host check to it would reject the only traffic it
    // is for.
    onRequest: [hostValidation(container.config), originValidation(container.config)],
    preHandler: app.authenticate,
    // Fastify parses the JSON body; hand it over so the handler doesn't try to
    // re-read an already-consumed stream.
    handler: async (request, reply) => {
      reply.hijack();
      await nodeHandler(request.raw, reply.raw, request.body);
    },
  });

  // Drain in-flight exchanges before the process exits.
  app.addHook("onClose", async () => {
    await handler.close();
  });

  app.log.info({ route: MCP_ROUTE }, "mcp endpoint mounted");
}

export const mcpPlugin = fp(plugin, {
  name: "mcp",
  dependencies: ["auth"],
  fastify: "5.x",
});
