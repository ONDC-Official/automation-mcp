import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { request, type Dispatcher } from "undici";
import { z } from "zod";
import type { CacheStore } from "@/lib/cache/cache-store.js";
import { UpstreamError } from "@/lib/errors.js";

/**
 * Per-user API keys issued by the Workbench website, checked under
 * `AUTH_MODE=apikey` when `AUTH_APIKEY_VERIFY_URL` is set.
 *
 * Keys are verified with automation-user-management (`POST /mcp/verify`) and
 * the answer is remembered briefly in the shared state store (Redis in
 * production). Workbench deletes a remembered answer when its key is
 * regenerated or revoked, so a dead key still stops working at once.
 * Contract: Workbench's `mcp-key-verification.md`.
 */

/** The exact shape Workbench issues; anything else is refused without a network call. */
const USER_KEY_PATTERN = /^ondc_mcp_[A-Za-z0-9_-]{43}$/;

/** How long a "bad key" answer is remembered; short, and only to keep repeated bad keys off Workbench. */
const REJECTED_TTL_MS = 10_000;

/** user-management could not give an answer; the auth plugin turns this into a 503, never a 401. */
export class AuthUnavailableError extends Error {
  override readonly name = "AuthUnavailableError";
}

/** A date string; checked because it can end up in a response header, where stray characters would break it. */
const DateString = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "not a date");

/** A `200` from the verify route; `user_id` is the stable identity. */
const ValidKeyReply = z.object({
  valid: z.literal(true),
  user_id: z.string().min(1),
  username: z.string().min(1),
  email: z.string().nullish(),
  expires_at: DateString,
});

/** A `401` from the verify route; `reason` says why the key is no good. */
const RejectedKeyReply = z.object({
  reason: z.string().optional(),
  expires_at: DateString.optional().catch(undefined),
});

/** Workbench's answer about a key, as used here and as remembered in the cache. */
const Verdict = z.discriminatedUnion("valid", [
  ValidKeyReply,
  z.object({
    valid: z.literal(false),
    reason: z.string().optional(),
    expires_at: DateString.optional(),
  }),
]);

type Verdict = z.infer<typeof Verdict>;
type ValidKey = z.infer<typeof ValidKeyReply>;

export interface UserKeyCheckOptions {
  /** The full verify URL, `AUTH_APIKEY_VERIFY_URL`, including `/automation-user-management`. */
  readonly url: string;
  /** The service secret, `AUTH_APIKEY_VERIFY_TOKEN`, sent as `X-Service-Token`. */
  readonly serviceToken: string;
  readonly timeoutMs: number;
  /** `AUTH_APIKEY_CACHE_TTL_MS`; 0 asks Workbench on every call. */
  readonly cacheTtlMs: number;
  /** The container's state store, so answers sit in the Redis that Workbench clears. */
  readonly cache: CacheStore;
  readonly logger: Logger;
  /** Injected by tests; production uses undici's global agent. */
  readonly dispatcher?: Dispatcher;
}

/** Resolves a user key to its owner, or throws `OAuthError` (bad key) or `AuthUnavailableError` (could not check). */
export type UserKeyCheck = (token: string) => Promise<AuthInfo>;

/** Where an answer is remembered; Workbench deletes `<REDIS_KEY_PREFIX>::` + this to revoke a key at once. */
export function userKeyCacheKey(token: string): string {
  return `mcp_key_check:${createHash("sha256").update(token).digest("hex")}`;
}

export function createUserKeyCheck(options: UserKeyCheckOptions): UserKeyCheck {
  return async (token) => {
    if (!USER_KEY_PATTERN.test(token)) {
      throw invalidKey(reasonMessage("invalid_format"));
    }

    const cacheKey = userKeyCacheKey(token);
    const verdict =
      (await readCachedVerdict(cacheKey, options)) ??
      (await askAndRemember(token, cacheKey, options));

    if (!verdict.valid) {
      throw invalidKey(reasonMessage(verdict.reason, verdict.expires_at));
    }
    return userAuthInfo(token, verdict);
  };
}

/** Asks Workbench, then remembers the answer; "couldn't check" throws first, so it is never remembered. */
async function askAndRemember(
  token: string,
  cacheKey: string,
  options: UserKeyCheckOptions,
): Promise<Verdict> {
  const verdict = await verifyWithWorkbench(token, options);
  await rememberVerdict(
    cacheKey,
    verdict,
    cacheTtl(verdict, options.cacheTtlMs),
    options,
  );
  return verdict;
}

/** How long to remember an answer: a valid key never outlives its own `expires_at`. */
function cacheTtl(verdict: Verdict, cacheTtlMs: number): number {
  if (!verdict.valid) return Math.min(REJECTED_TTL_MS, cacheTtlMs);
  return Math.min(cacheTtlMs, Date.parse(verdict.expires_at) - Date.now());
}

/** A remembered answer, or undefined; a store outage counts as "not remembered", so Workbench is asked instead. */
async function readCachedVerdict(
  cacheKey: string,
  options: UserKeyCheckOptions,
): Promise<Verdict | undefined> {
  if (options.cacheTtlMs <= 0) return undefined;
  try {
    // Anything that isn't a verdict we wrote is ignored and re-checked, never trusted.
    const parsed = Verdict.safeParse(
      await options.cache.get<unknown>(cacheKey),
    );
    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    if (!(error instanceof UpstreamError)) throw error;
    options.logger.warn(
      { err: error },
      "key-check cache unreadable; asking Workbench",
    );
    return undefined;
  }
}

/** Remembers an answer; failing to store it only costs a repeat check, so it never fails the request. */
async function rememberVerdict(
  cacheKey: string,
  verdict: Verdict,
  ttlMs: number,
  options: UserKeyCheckOptions,
): Promise<void> {
  // Zero or less means "don't remember": the cache is off, or the key expires before the TTL would.
  if (ttlMs <= 0) return;
  try {
    await options.cache.set(cacheKey, verdict, ttlMs);
  } catch (error) {
    if (!(error instanceof UpstreamError)) throw error;
    options.logger.warn(
      { err: error },
      "key-check cache unwritable; the answer was not remembered",
    );
  }
}

/** Asks user-management whose the key is; a `401` is an answer, anything unclear throws `AuthUnavailableError`. */
async function verifyWithWorkbench(
  token: string,
  options: UserKeyCheckOptions,
): Promise<Verdict> {
  let status: number;
  let body: unknown;
  try {
    const response = await request(options.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-service-token": options.serviceToken,
      },
      body: JSON.stringify({ key: token }),
      signal: AbortSignal.timeout(options.timeoutMs),
      ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
    });
    status = response.statusCode;
    // Always read the body: undici keeps the connection busy until it is, and HTML (a wrong base URL) becomes undefined.
    body = await response.body.json().catch(() => undefined);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new AuthUnavailableError(
      `could not reach user-management to check the key: ${reason}`,
    );
  }

  // 401 is the only answer that means "this key is no good"; it goes back to the user as a 401.
  if (status === 401) {
    const rejected = RejectedKeyReply.safeParse(body);
    const reply = rejected.success ? rejected.data : {};
    return { valid: false, ...reply };
  }

  // 403/429 mean our service token is missing or wrong; 400/5xx are bugs. All are ours to fix, never the user's.
  if (status !== 200) {
    throw new AuthUnavailableError(
      `user-management answered the key check with HTTP ${String(status)}` +
        (status === 403 || status === 429
          ? " (check AUTH_APIKEY_VERIFY_TOKEN)"
          : ""),
    );
  }

  const parsed = ValidKeyReply.safeParse(body);
  if (!parsed.success) {
    // A 200 that is not the expected JSON is usually a URL missing `/automation-user-management`.
    throw new AuthUnavailableError(
      "user-management answered the key check with an unexpected body (check AUTH_APIKEY_VERIFY_URL)",
    );
  }
  return parsed.data;
}

/** What to tell the user for each `reason` Workbench sends, so they know how to fix it. */
function reasonMessage(reason?: string, expiresAt?: string): string {
  switch (reason) {
    case "invalid_format":
      return "That doesn't look like a Workbench MCP key; check for a copy/paste slip";
    case "not_found":
      return "Key not recognised. If you regenerated it, update your MCP client config";
    case "revoked":
      return "This key was revoked. Generate a new one on the Workbench website";
    case "expired":
      // Re-printed from the parsed date, so only a clean ISO timestamp reaches the WWW-Authenticate header.
      return expiresAt
        ? `This key expired on ${new Date(expiresAt).toISOString()}. Generate a new one on the Workbench website`
        : "This key has expired. Generate a new one on the Workbench website";
    default:
      return "Invalid API key";
  }
}

/** The identity tools see for a Workbench user; `clientId` is their stable `user_id`. */
function userAuthInfo(token: string, user: ValidKey): AuthInfo {
  return {
    token,
    clientId: user.user_id,
    scopes: ["mcp"],
    // The SDK refuses a token past `expiresAt`, so the 90-day key expiry is enforced here too.
    expiresAt: Math.floor(Date.parse(user.expires_at) / 1000),
    extra: {
      kind: "user",
      username: user.username,
      expires_at: user.expires_at,
      ...(user.email ? { email: user.email } : {}),
    },
  };
}

function invalidKey(message: string): OAuthError {
  return new OAuthError(OAuthErrorCode.InvalidToken, message);
}
