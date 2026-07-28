import type { FastifyError, FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { config } from "@/config/env.js";
import { isAppError, toAppError } from "@/lib/errors.js";

/**
 * Central error handling for the **REST** surface (`/health`, `/ready`, the
 * OAuth metadata routes).
 *
 * The `/mcp` endpoint does not pass through here: JSON-RPC has its own error
 * envelope, and the MCP handler owns it end to end. Mapping MCP failures into
 * HTTP status codes would corrupt the protocol.
 */

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

async function plugin(app: FastifyInstance): Promise<void> {
  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      error: {
        code: "not_found",
        message: `Route ${request.method} ${request.url} not found.`,
      },
    } satisfies ErrorBody);
  });

  // Fastify 5 types the handler's error as `unknown` by default.
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    // Schema validation → 400 with the offending fields.
    if (hasZodFastifySchemaValidationErrors(error)) {
      request.log.warn({ err: error }, "request failed validation");
      return reply.code(400).send({
        error: {
          code: "validation_error",
          message: "Request failed validation.",
          details: error.validation,
        },
      } satisfies ErrorBody);
    }

    // Rate limiting and other Fastify errors carry their own status.
    const status = error.statusCode ?? 500;
    if (status < 500) {
      request.log.warn({ err: error }, "request rejected");
      return reply.code(status).send({
        error: { code: error.code ?? "bad_request", message: error.message },
      } satisfies ErrorBody);
    }

    const appError = toAppError(error);
    request.log.error({ err: error }, "unhandled error");

    // Never leak internals in production — no stack, no driver message.
    const exposed = isAppError(error) && appError.expose;
    return reply.code(500).send({
      error: {
        code: appError.code,
        message:
          exposed || config.NODE_ENV !== "production"
            ? appError.message
            : "An internal error occurred.",
      },
    } satisfies ErrorBody);
  });
}

export const errorHandlerPlugin = fp(plugin, {
  name: "error-handler",
  fastify: "5.x",
});
