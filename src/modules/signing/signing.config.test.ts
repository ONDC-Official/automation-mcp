import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "@/config/env.js";
import { keyPair } from "@/test/signing-keys.js";

const { seed } = keyPair();
const IDENTITY = {
  ONDC_SUBSCRIBER_ID: "mock.example",
  ONDC_UNIQUE_KEY_ID: "k1",
  ONDC_SIGNING_PRIVATE_KEY: seed,
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
    expect(config.ONDC_SUBSCRIBER_ID).toBeUndefined();
    expect(config.SIGNING_KEY_CACHE_TTL_MS).toBe(900_000);
  });

  it("boots with a full identity and a registry", () => {
    const config = boot({
      ...IDENTITY,
      ONDC_REGISTRY_URL: "https://staging.registry.ondc.org/v2.0/",
    });
    expect(config.ONDC_UNIQUE_KEY_ID).toBe("k1");
  });

  it("refuses half an identity", () => {
    expect(
      bootError({
        ONDC_SUBSCRIBER_ID: "mock.example",
        ONDC_UNIQUE_KEY_ID: "k1",
      }),
    ).toContain("must be set together");
  });

  it("refuses a registry without an identity to sign lookups with", () => {
    expect(
      bootError({
        ONDC_REGISTRY_URL: "https://staging.registry.ondc.org/v2.0/",
      }),
    ).toContain("ONDC_REGISTRY_URL requires");
  });

  it("refuses a private key that is neither 32 nor 64 bytes", () => {
    expect(
      bootError({
        ...IDENTITY,
        ONDC_SIGNING_PRIVATE_KEY: Buffer.alloc(16).toString("base64"),
      }),
    ).toContain("32 or 64 bytes");
  });

  it("treats blank values as unset", () => {
    const config = boot({
      ONDC_SUBSCRIBER_ID: "",
      ONDC_UNIQUE_KEY_ID: "",
      ONDC_SIGNING_PRIVATE_KEY: "",
      ONDC_REGISTRY_URL: "",
    });
    expect(config.ONDC_SUBSCRIBER_ID).toBeUndefined();
    expect(config.ONDC_REGISTRY_URL).toBeUndefined();
  });
});
