import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";
import type { Config } from "@/config/env.js";
import type { CacheStore } from "@/lib/cache/cache-store.js";
import { createUserKeyCheck, type UserKeyCheck } from "@/lib/user-key-check.js";

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
 * request while appearing correct. Every implementation here populates it.
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
 * API-key verifier, for two kinds of key:
 *
 * - keys listed in `AUTH_API_KEYS` (services such as the batch peer, or a shared
 *   key), compared with `timingSafeEqual` to prevent timing attacks;
 * - per-user `ondc_mcp_…` keys from the Workbench website, checked with
 *   user-management when `AUTH_APIKEY_VERIFY_URL` is set.
 */
export function createApiKeyVerifier(
  config: Config,
  deps: VerifierDeps,
): OAuthTokenVerifier {
  const fixedKeys = config.AUTH_API_KEYS.map((key) => Buffer.from(key));
  const checkUserKey = userKeyCheckFrom(config, deps);
  if (fixedKeys.length === 0 && checkUserKey === undefined) {
    // Unreachable: env.ts refuses to boot in apikey mode with neither.
    throw new Error(
      "API key verifier requires AUTH_API_KEYS or AUTH_APIKEY_VERIFY_URL",
    );
  }

  return {
    verifyAccessToken(token: string): Promise<AuthInfo> {
      // Fixed keys first: they need no network, so the batch peer keeps working if user-management is down.
      if (matchesFixedKey(fixedKeys, token)) {
        return Promise.resolve(fixedKeyAuthInfo(token));
      }
      if (checkUserKey !== undefined) return checkUserKey(token);
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid API key");
    },
  };
}

/** The Workbench user key check, or undefined when this deploy accepts only fixed keys. */
function userKeyCheckFrom(
  config: Config,
  deps: VerifierDeps,
): UserKeyCheck | undefined {
  if (config.AUTH_APIKEY_VERIFY_URL === undefined) return undefined;
  if (config.AUTH_APIKEY_VERIFY_TOKEN === undefined) {
    // Unreachable: env.ts refuses a verify URL without its token.
    throw new Error("AUTH_APIKEY_VERIFY_URL requires AUTH_APIKEY_VERIFY_TOKEN");
  }
  return createUserKeyCheck({
    url: config.AUTH_APIKEY_VERIFY_URL,
    serviceToken: config.AUTH_APIKEY_VERIFY_TOKEN,
    timeoutMs: config.AUTH_APIKEY_VERIFY_TIMEOUT_MS,
    cacheTtlMs: config.AUTH_APIKEY_CACHE_TTL_MS,
    cache: deps.cache,
    logger: deps.logger,
  });
}

function matchesFixedKey(keys: readonly Buffer[], token: string): boolean {
  const presented = Buffer.from(token);
  // Length is checked first because `timingSafeEqual` throws on unequal lengths.
  return keys.some(
    (key) => key.length === presented.length && timingSafeEqual(key, presented),
  );
}

/** The identity given to a caller with a fixed key; it names no user. */
function fixedKeyAuthInfo(token: string): AuthInfo {
  return {
    token,
    clientId: "apikey-client",
    scopes: ["mcp"],
    expiresAt: Math.floor(Date.now() / 1000) + 86400 * 365,
    extra: { kind: "service" },
  };
}

/** What a verifier needs from the container: the shared state store (for the key-check cache) and a logger. */
export interface VerifierDeps {
  readonly cache: CacheStore;
  readonly logger: Logger;
}

export function createTokenVerifier(
  config: Config,
  deps: VerifierDeps,
): OAuthTokenVerifier | undefined {
  if (config.AUTH_MODE === "jwt") return createJwtVerifier(config);
  if (config.AUTH_MODE === "apikey") return createApiKeyVerifier(config, deps);
  return undefined;
}
