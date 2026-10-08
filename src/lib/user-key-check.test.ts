import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "@/config/env.js";
import {
  AuthUnavailableError,
  createUserKeyCheck,
  type UserKeyCheckOptions,
} from "@/lib/user-key-check.js";

const ORIGIN = "https://dev-workbench.test";
const VERIFY_PATH = "/automation-user-management/mcp/verify";
const SERVICE_TOKEN = "service-secret";
/** Workbench's shape: `ondc_mcp_` plus 43 base64url characters. */
const USER_KEY = `ondc_mcp_${"aB3-_".repeat(8)}xyz`;

const VALID_REPLY = {
  valid: true,
  user_id: "6ac73eeb76f3376f6c12e5a5",
  username: "rudransh-local",
  email: "someone@example.com",
  expires_at: "2027-01-06T06:58:00.793Z",
};

describe("createUserKeyCheck", () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    // Any call without a matching intercept fails, which is how "no network call" is proven.
    agent.disableNetConnect();
  });

  afterEach(async () => {
    await agent.close();
  });

  function userKeyCheck(overrides: Partial<UserKeyCheckOptions> = {}) {
    return createUserKeyCheck({
      url: `${ORIGIN}${VERIFY_PATH}`,
      serviceToken: SERVICE_TOKEN,
      timeoutMs: 1_000,
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

  it("verifies on every call, because nothing is cached", async () => {
    expectVerify().reply(200, VALID_REPLY).times(2);
    const check = userKeyCheck();

    await check(USER_KEY);
    await check(USER_KEY);

    // Both intercepts were used, so both calls reached Workbench.
    agent.assertNoPendingInterceptors();
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
  });
});
