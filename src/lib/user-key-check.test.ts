import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import { pino } from "pino";
import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "@/config/env.js";
import { InMemoryCacheStore } from "@/lib/cache/in-memory-cache-store.js";
import { UpstreamError } from "@/lib/errors.js";
import {
  AuthUnavailableError,
  createUserKeyCheck,
  userKeyCacheKey,
  type UserKeyCheckOptions,
} from "@/lib/user-key-check.js";

const ORIGIN = "https://dev-workbench.test";
const VERIFY_PATH = "/automation-user-management/mcp/verify";
const SERVICE_TOKEN = "service-secret";
/** Workbench's shape: `ondc_mcp_` plus 43 base64url characters. */
const USER_KEY = `ondc_mcp_${"aB3-_".repeat(8)}xyz`;

/** The entry Workbench deletes (the Redis store adds the `ondc-mcp::` prefix), computed independently. */
const CACHE_KEY = `mcp_key_check:${createHash("sha256").update(USER_KEY).digest("hex")}`;

/** A store that fails the way the Redis store does during an outage. */
class UnreachableStore extends InMemoryCacheStore {
  override get<T>(): Promise<T | undefined> {
    return Promise.reject(new UpstreamError("redis", "ECONNREFUSED"));
  }
  override set(): Promise<void> {
    return Promise.reject(new UpstreamError("redis", "ECONNREFUSED"));
  }
}

const VALID_REPLY = {
  valid: true,
  user_id: "6ac73eeb76f3376f6c12e5a5",
  username: "rudransh-local",
  email: "someone@example.com",
  expires_at: "2027-01-06T06:58:00.793Z",
};

describe("createUserKeyCheck", () => {
  let agent: MockAgent;
  let store: InMemoryCacheStore;

  beforeEach(() => {
    agent = new MockAgent();
    // Any call without a matching intercept fails, which is how "no network call" is proven.
    agent.disableNetConnect();
    // No sweep timer, so nothing outlives the test.
    store = new InMemoryCacheStore({ sweepIntervalMs: 0 });
  });

  afterEach(async () => {
    await agent.close();
    await store.close();
  });

  function userKeyCheck(overrides: Partial<UserKeyCheckOptions> = {}) {
    return createUserKeyCheck({
      url: `${ORIGIN}${VERIFY_PATH}`,
      serviceToken: SERVICE_TOKEN,
      timeoutMs: 1_000,
      cacheTtlMs: 60_000,
      cache: store,
      logger: pino({ enabled: false }),
      dispatcher: agent,
      ...overrides,
    });
  }

  /** One expected verify call; it only matches with the service token and the key in the body. */
  function expectVerify(key = USER_KEY) {
    return agent.get(ORIGIN).intercept({
      path: VERIFY_PATH,
      method: "POST",
      headers: { "x-service-token": SERVICE_TOKEN },
      body: JSON.stringify({ key }),
    });
  }

  async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => {
        throw new Error("expected the check to refuse the key");
      },
      (error: unknown) => error,
    );
  }

  async function expectInvalidToken(
    promise: Promise<unknown>,
    message?: string,
  ) {
    const error = await rejectionOf(promise);
    expect(error).toBeInstanceOf(OAuthError);
    expect((error as OAuthError).code).toBe(OAuthErrorCode.InvalidToken);
    if (message !== undefined) {
      expect((error as OAuthError).message).toContain(message);
    }
  }

  it("identifies a valid key as its Workbench user", async () => {
    expectVerify().reply(200, VALID_REPLY);

    const info = await userKeyCheck()(USER_KEY);

    expect(info.clientId).toBe("6ac73eeb76f3376f6c12e5a5");
    expect(info.extra).toEqual({
      kind: "user",
      username: "rudransh-local",
      email: "someone@example.com",
      expires_at: "2027-01-06T06:58:00.793Z",
    });
    // The key's own 90-day expiry, so the SDK refuses it once it lapses.
    expect(info.expiresAt).toBe(
      Math.floor(Date.parse("2027-01-06T06:58:00.793Z") / 1000),
    );
  });

  it.each([
    ["no prefix", "some-random-key"],
    ["too short", "ondc_mcp_abc123"],
    ["a character outside base64url", `ondc_mcp_${"a".repeat(42)}!`],
  ])("refuses a key with %s without calling Workbench", async (_label, key) => {
    await expectInvalidToken(userKeyCheck()(key), "doesn't look like");
  });

  describe("remembers answers in the state store", () => {
    it("answers a repeat call from the cache, without asking Workbench", async () => {
      expectVerify().reply(200, VALID_REPLY);
      const check = userKeyCheck();

      await check(USER_KEY);
      // Only one intercept exists, so a second network call would fail.
      const again = await check(USER_KEY);

      expect(again.clientId).toBe("6ac73eeb76f3376f6c12e5a5");
    });

    it("stores the answer under the key name Workbench deletes", async () => {
      expectVerify().reply(200, VALID_REPLY);

      await userKeyCheck()(USER_KEY);

      expect(userKeyCacheKey(USER_KEY)).toBe(CACHE_KEY);
      expect(await store.get(CACHE_KEY)).toEqual(VALID_REPLY);
    });

    it("stops accepting a key as soon as Workbench deletes its entry", async () => {
      expectVerify().reply(200, VALID_REPLY);
      expectVerify().reply(401, { reason: "not_found", valid: false });
      const check = userKeyCheck();

      await check(USER_KEY);
      // What user-management does on regenerate, revoke or delete.
      await store.delete(CACHE_KEY);

      await expectInvalidToken(check(USER_KEY), "Key not recognised");
    });

    it("never remembers a valid key past its own expiry", async () => {
      const soon = new Date(Date.now() + 5_000).toISOString();
      expectVerify().reply(200, { ...VALID_REPLY, expires_at: soon });
      const set = vi.spyOn(store, "set");

      await userKeyCheck()(USER_KEY);

      const ttl = set.mock.calls[0]?.[2] ?? Infinity;
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(5_000);
    });

    it("remembers a rejected key for 10 seconds, with its reason", async () => {
      expectVerify().reply(401, { reason: "revoked", valid: false });
      const set = vi.spyOn(store, "set");
      const check = userKeyCheck();

      await expectInvalidToken(check(USER_KEY), "was revoked");
      // Answered from the cache: same message, no second network call.
      await expectInvalidToken(check(USER_KEY), "was revoked");

      expect(set.mock.calls[0]?.[2]).toBe(10_000);
    });

    it("never remembers a failure to check", async () => {
      expectVerify().reply(500, { reason: "internal_error" });
      expectVerify().reply(200, VALID_REPLY);
      const check = userKeyCheck();

      await expect(check(USER_KEY)).rejects.toBeInstanceOf(
        AuthUnavailableError,
      );
      const info = await check(USER_KEY);
      expect(info.clientId).toBe("6ac73eeb76f3376f6c12e5a5");
    });

    it("re-checks, rather than trusts, an entry it cannot read", async () => {
      await store.set(CACHE_KEY, { valid: "yes" }, 60_000);
      expectVerify().reply(401, { reason: "not_found", valid: false });

      await expectInvalidToken(userKeyCheck()(USER_KEY), "Key not recognised");
    });

    it("asks Workbench when the store is down, so users are not locked out", async () => {
      expectVerify().reply(200, VALID_REPLY);
      const down = new UnreachableStore({ sweepIntervalMs: 0 });

      const info = await userKeyCheck({ cache: down })(USER_KEY);

      expect(info.clientId).toBe("6ac73eeb76f3376f6c12e5a5");
      await down.close();
    });

    it("asks Workbench on every call when the cache is off", async () => {
      expectVerify().reply(200, VALID_REPLY).times(2);
      const check = userKeyCheck({ cacheTtlMs: 0 });

      await check(USER_KEY);
      await check(USER_KEY);

      // Both intercepts were used, so both calls reached Workbench.
      agent.assertNoPendingInterceptors();
    });
  });

  describe("tells the user what to do when Workbench rejects the key", () => {
    it.each([
      ["not_found", undefined, "If you regenerated it"],
      ["revoked", undefined, "was revoked"],
      ["expired", "2027-01-06T06:58:00.793Z", "expired on 2027-01-06"],
      ["expired", 'bad"\r\nvalue', "This key has expired"],
      ["something_new", undefined, "Invalid API key"],
    ])("for reason %s", async (reason, expiresAt, message) => {
      expectVerify().reply(401, { reason, expires_at: expiresAt });

      await expectInvalidToken(userKeyCheck()(USER_KEY), message);
    });

    it("even when the 401 has no readable body", async () => {
      expectVerify().reply(401, "nope");

      await expectInvalidToken(userKeyCheck()(USER_KEY), "Invalid API key");
    });
  });

  describe("fails closed when Workbench cannot give a clear answer", () => {
    it.each([
      ["a refused service token", 403, { error: "forbidden" }],
      ["rate limiting", 429, { reason: "rate_limited" }],
      ["a bad request", 400, { reason: "invalid_body" }],
      ["a server error", 500, { reason: "internal_error" }],
      ["a 200 that is not a valid key", 200, { valid: false }],
      [
        "a 200 with a broken expiry",
        200,
        { ...VALID_REPLY, expires_at: "soon" },
      ],
    ])("on %s", async (_label, status, reply) => {
      expectVerify().reply(status, reply);

      await expect(userKeyCheck()(USER_KEY)).rejects.toBeInstanceOf(
        AuthUnavailableError,
      );
    });

    it("on the website's HTML page, which a URL without /automation-user-management returns", async () => {
      expectVerify().reply(200, "<!doctype html><html></html>", {
        headers: { "content-type": "text/html" },
      });

      const error = await rejectionOf(userKeyCheck()(USER_KEY));
      expect(error).toBeInstanceOf(AuthUnavailableError);
      expect((error as Error).message).toContain("AUTH_APIKEY_VERIFY_URL");
    });

    it("on a network error", async () => {
      expectVerify().replyWithError(new Error("ECONNREFUSED"));

      await expect(userKeyCheck()(USER_KEY)).rejects.toBeInstanceOf(
        AuthUnavailableError,
      );
    });

    it("on a timeout", async () => {
      expectVerify().reply(200, VALID_REPLY).delay(200);

      await expect(
        userKeyCheck({ timeoutMs: 20 })(USER_KEY),
      ).rejects.toBeInstanceOf(AuthUnavailableError);
    });
  });
});

describe("AUTH_MODE=apikey user key config", () => {
  /** `parseConfig` exits the process on bad config, so the exit is stubbed to read the message. */
  function bootError(env: Record<string, string>): string {
    let written = "";
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("__exit__");
    });
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        written += String(chunk);
        return true;
      });
    try {
      parseConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", ...env });
    } catch {
      // The stubbed exit.
    } finally {
      exit.mockRestore();
      stderr.mockRestore();
    }
    return written;
  }

  it("refuses to boot with neither fixed keys nor a verify URL", () => {
    expect(bootError({ AUTH_MODE: "apikey" })).toContain(
      "AUTH_MODE=apikey requires at least one key in AUTH_API_KEYS, or AUTH_APIKEY_VERIFY_URL",
    );
  });

  it("refuses to boot with a verify URL but no service token", () => {
    expect(
      bootError({
        AUTH_MODE: "apikey",
        AUTH_APIKEY_VERIFY_URL: `${ORIGIN}${VERIFY_PATH}`,
      }),
    ).toContain("AUTH_APIKEY_VERIFY_URL requires AUTH_APIKEY_VERIFY_TOKEN");
  });

  it("boots with a verify URL and token, and no fixed keys", () => {
    const config = parseConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      AUTH_MODE: "apikey",
      AUTH_APIKEY_VERIFY_URL: `${ORIGIN}${VERIFY_PATH}`,
      AUTH_APIKEY_VERIFY_TOKEN: SERVICE_TOKEN,
    });

    expect(config.AUTH_APIKEY_VERIFY_TIMEOUT_MS).toBe(5_000);
    expect(config.AUTH_APIKEY_CACHE_TTL_MS).toBe(60_000);
  });
});
