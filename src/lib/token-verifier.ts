import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { timingSafeEqual } from "node:crypto";
import type { Config } from "@/config/env.js";

/**
 * Token verification, behind the SDK's one-method `OAuthTokenVerifier` seam.
 *
 * Swap the implementation (RFC 7662 introspection, an opaque-token cache, a
 * vendor SDK) without touching the plugin that consumes it.
 *
 * ## The gotcha that costs an afternoon
 *
 * The SDK's bearer middleware **rejects any token whose `AuthInfo.expiresAt`
 * is unset** — silently, as a plain 401 with no hint about why. A verifier that
 * returns a valid-looking `AuthInfo` without `expiresAt` therefore fails every
 * request while appearing correct. Both implementations below populate it.
 */

function scopesFrom(payload: JWTPayload): string[] {
  const raw = payload["scope"] ?? payload["scp"];
  if (typeof raw === "string") return raw.split(/\s+/).filter(Boolean);
  if (Array.isArray(raw))
    return raw.filter((s): s is string => typeof s === "string");
  return [];
}

/** Verifies RS256/ES256 bearer tokens against a remote JWKS. */
export function createJwtVerifier(config: Config): OAuthTokenVerifier {
  if (!config.AUTH_JWKS_URL || !config.AUTH_ISSUER || !config.AUTH_AUDIENCE) {
    // Unreachable: env.ts refuses to boot in jwt mode without these.
    throw new Error("JWT verifier requires issuer, audience and JWKS URL");
  }

  // Built once — the JWKS is cached and refreshed by jose, so this must not be
  // constructed per request.
  const jwks = createRemoteJWKSet(new URL(config.AUTH_JWKS_URL));
  const issuer = config.AUTH_ISSUER;
  const audience = config.AUTH_AUDIENCE;

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, jwks, { issuer, audience }));
      } catch (cause) {
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          cause instanceof Error ? cause.message : "Token verification failed",
        );
      }

      if (payload.exp === undefined) {
        // Without an expiry the SDK would reject this anyway; failing loudly
        // here points at the real cause instead of an unexplained 401.
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          "Token has no `exp` claim; expiry is required.",
        );
      }

      return {
        token,
        clientId:
          typeof payload.azp === "string"
            ? payload.azp
            : (payload.sub ?? "unknown"),
        scopes: scopesFrom(payload),
        expiresAt: payload.exp, // seconds since epoch — required by the SDK
        ...(payload.aud === undefined ? {} : { resource: new URL(audience) }),
        extra: { sub: payload.sub },
      };
    },
  };
}

/**
 * Development-only verifier: accepts any non-empty token.
 *
 * `env.ts` refuses to boot with `AUTH_MODE=none` when `NODE_ENV=production`,
 * so this cannot reach a production deployment through configuration alone.
 */
export function createPermissiveVerifier(): OAuthTokenVerifier {
  return {
    verifyAccessToken(token: string): Promise<AuthInfo> {
      return Promise.resolve({
        token,
        clientId: "dev-client",
        scopes: ["mcp"],
        // Still required, even here.
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
    },
  };
}

/**
 * Static API-key verifier: accepts any token that matches a configured key.
 *
 * Keys are compared with `timingSafeEqual` to prevent timing attacks.
 * `AUTH_API_KEYS` is a comma-separated list; any match grants access.
 */
export function createApiKeyVerifier(config: Config): OAuthTokenVerifier {
  if (config.AUTH_API_KEYS.length === 0) {
    throw new Error(
      "API key verifier requires at least one key in AUTH_API_KEYS",
    );
  }

  const keys = config.AUTH_API_KEYS.map((k) => Buffer.from(k));

  return {
    verifyAccessToken(token: string): Promise<AuthInfo> {
      const buf = Buffer.from(token);
      const match = keys.some(
        (k) => k.length === buf.length && timingSafeEqual(k, buf),
      );
      if (!match) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid API key");
      }
      return Promise.resolve({
        token,
        clientId: "apikey-client",
        scopes: ["mcp"],
        expiresAt: Math.floor(Date.now() / 1000) + 86400 * 365,
      });
    },
  };
}

export function createTokenVerifier(
  config: Config,
): OAuthTokenVerifier | undefined {
  if (config.AUTH_MODE === "jwt") return createJwtVerifier(config);
  if (config.AUTH_MODE === "apikey") return createApiKeyVerifier(config);
  return undefined;
}
