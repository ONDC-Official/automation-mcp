import {
  bearerAuthChallengeResponse,
  getOAuthProtectedResourceMetadataUrl,
  verifyBearerToken,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { Config } from "@/config/env.js";
import { createTokenVerifier } from "@/lib/token-verifier.js";

/**
 * The Resource Server half of the MCP authorization flow.
 *
 * MCP's model is OAuth 2.1 with discovery: an unauthenticated client gets a
 * `401` carrying `WWW-Authenticate: Bearer ... resource_metadata="<url>"`,
 * fetches that RFC 9728 document to learn which authorization server to talk
 * to, obtains a token, and retries. The two halves — the challenge and the
 * metadata document — must agree, so both are produced here from one config.
 *
 * The Fastify adapter ships no bearer middleware (only Express does), so this
 * uses the SDK's framework-free primitives and bridges the returned web
 * `Response` onto a Fastify reply.
 */

declare module "fastify" {
  interface FastifyRequest {
    /** Verified token info, present only after `authenticate` has run. */
    authInfo?: AuthInfo;
  }
  interface FastifyInstance {
    /** preHandler gating a route on a valid bearer token. */
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }
}

/** Copy a web-standard `Response` onto a Fastify reply. */
async function sendWebResponse(
  reply: FastifyReply,
  response: Response,
): Promise<void> {
  response.headers.forEach((value, key) => {
    void reply.header(key, value);
  });
  const body = await response.text();
  await reply
    .code(response.status)
    .type(response.headers.get("content-type") ?? "application/json")
    .send(body);
}

async function plugin(app: FastifyInstance, config: Config): Promise<void> {
  const resourceUrl = new URL(config.MCP_PUBLIC_URL);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  const verifier: OAuthTokenVerifier | undefined = createTokenVerifier(config);

  app.decorateRequest("authInfo", undefined);

  app.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      // `AUTH_MODE=none`: dev only. env.ts refuses this combination when
      // NODE_ENV=production, so an unauthenticated deploy can't happen by
      // configuration alone.
      if (!verifier) return;

      try {
        request.authInfo = await verifyBearerToken(
          request.headers.authorization,
          {
            verifier,
            requiredScopes: config.AUTH_REQUIRED_SCOPES,
            resourceMetadataUrl,
          },
        );
        // The node adapter forwards `req.auth` to the MCP handler as its
        // pass-through authInfo, which is how tools see `ctx.http.authInfo`.
        (request.raw as { auth?: AuthInfo }).auth = request.authInfo;
      } catch (error) {
        request.log.warn({ err: error }, "bearer authentication failed");
        await sendWebResponse(
          reply,
          bearerAuthChallengeResponse(error, {
            requiredScopes: config.AUTH_REQUIRED_SCOPES,
            resourceMetadataUrl,
          }),
        );
      }
    },
  );

  // RFC 9728 Protected Resource Metadata. The path mirrors the resource path,
  // e.g. resource `/mcp` → `/.well-known/oauth-protected-resource/mcp`, which
  // is exactly what the 401 challenge advertises.
  const metadataPath = new URL(resourceMetadataUrl).pathname;

  app.route({
    method: "GET",
    url: metadataPath,
    // Discovery must be reachable *without* a token — it is what an
    // unauthenticated client reads to find out how to authenticate.
    handler: (_request, reply) =>
      reply.header("cache-control", "public, max-age=3600").send({
        resource: resourceUrl.href,
        authorization_servers: config.AUTH_ISSUER ? [config.AUTH_ISSUER] : [],
        scopes_supported: config.AUTH_REQUIRED_SCOPES,
        bearer_methods_supported: ["header"],
        resource_name: "ondc-mcp",
      }),
  });

  app.log.info(
    { authMode: config.AUTH_MODE, metadataPath },
    "authorization configured",
  );
}

export const authPlugin = fp(plugin, {
  name: "auth",
  fastify: "5.x",
});
