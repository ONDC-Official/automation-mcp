import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "@/config/env.js";
import { keyPair } from "@/test/signing-keys.js";

const { seed } = keyPair();
const IDENTITY = {
  WORKBENCH_SUBSCRIBER_ID: "mock.example",
  UKID: "k1",
  SIGN_PRIVATE_KEY: seed,
};

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

function boot(env: Record<string, string>) {
  return parseConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", ...env });
}

describe("signing config", () => {
  it("boots with nothing configured", () => {
    const config = boot({});
    expect(config.WORKBENCH_SUBSCRIBER_ID).toBeUndefined();
    expect(config.SIGNING_KEY_CACHE_TTL_MS).toBe(900_000);
  });

  it("boots with a full identity and a registry", () => {
    const config = boot({
      ...IDENTITY,
      IN_HOUSE_REGISTRY: "https://registry.example.com/v2.0/",
    });
    expect(config.UKID).toBe("k1");
  });

  it("refuses half an identity", () => {
    expect(
      bootError({
        WORKBENCH_SUBSCRIBER_ID: "mock.example",
        UKID: "k1",
      }),
    ).toContain("must be set together");
  });

  it("refuses a registry without an identity to sign lookups with", () => {
    expect(
      bootError({
        IN_HOUSE_REGISTRY: "https://registry.example.com/v2.0/",
      }),
    ).toContain("IN_HOUSE_REGISTRY requires");
  });

  it("refuses a private key that is neither 32 nor 64 bytes", () => {
    expect(
      bootError({
        ...IDENTITY,
        SIGN_PRIVATE_KEY: Buffer.alloc(16).toString("base64"),
      }),
    ).toContain("32 or 64 bytes");
  });

  it("treats blank values as unset", () => {
    const config = boot({
      WORKBENCH_SUBSCRIBER_ID: "",
      UKID: "",
      SIGN_PRIVATE_KEY: "",
      IN_HOUSE_REGISTRY: "",
    });
    expect(config.WORKBENCH_SUBSCRIBER_ID).toBeUndefined();
    expect(config.IN_HOUSE_REGISTRY).toBeUndefined();
  });
});
