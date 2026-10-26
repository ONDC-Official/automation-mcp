import { describe, expect, it } from "vitest";
import { InMemoryCacheStore } from "@/lib/cache/in-memory-cache-store.js";
import type {
  LookupResult,
  RegistryGateway,
} from "@/modules/signing/signing.gateway.js";
import { KeyProvider } from "@/modules/signing/signing.keys.js";

/** A registry that answers from a script and counts what it was asked. */
function fakeRegistry(answers: LookupResult[]): RegistryGateway & {
  calls: number;
} {
  const fake = {
    calls: 0,
    lookup(): Promise<LookupResult> {
      const answer = answers[Math.min(fake.calls, answers.length - 1)];
      fake.calls += 1;
      return Promise.resolve(answer ?? { status: "not_found" });
    },
  };
  return fake;
}

function provider(
  registry: RegistryGateway | undefined,
  staticKeys: Record<string, string> = {},
) {
  return new KeyProvider({
    staticKeys,
    registry,
    cache: new InMemoryCacheStore(),
    ttlMs: 60_000,
  });
}

describe("KeyProvider", () => {
  it("answers a static key without asking the registry", async () => {
    const registry = fakeRegistry([{ status: "found", publicKey: "REG" }]);
    const keys = provider(registry, { "np.example|k1": "STATIC" });

    expect(await keys.lookup("np.example", "k1")).toEqual({
      status: "found",
      publicKey: "STATIC",
      source: "static",
    });
    expect(registry.calls).toBe(0);
  });

  it("answers not_found when there is no registry and no static key", async () => {
    expect(await provider(undefined).lookup("np.example", "k1")).toEqual({
      status: "not_found",
    });
  });

  it("caches a registry key, so a flow's calls cost one lookup", async () => {
    const registry = fakeRegistry([{ status: "found", publicKey: "REG" }]);
    const keys = provider(registry);

    expect(await keys.lookup("np.example", "k1")).toMatchObject({
      publicKey: "REG",
      source: "registry",
    });
    expect(await keys.lookup("np.example", "k1")).toMatchObject({
      publicKey: "REG",
      source: "cache",
    });
    expect(registry.calls).toBe(1);
  });

  it("keys the cache on subscriber and ukId together", async () => {
    const registry = fakeRegistry([
      { status: "found", publicKey: "A" },
      { status: "found", publicKey: "B" },
    ]);
    const keys = provider(registry);

    await keys.lookup("np.example", "k1");
    expect(await keys.lookup("np.example", "k2")).toMatchObject({
      publicKey: "B",
    });
    expect(registry.calls).toBe(2);
  });

  it("fresh skips the cache and replaces a rotated key", async () => {
    const registry = fakeRegistry([
      { status: "found", publicKey: "OLD" },
      { status: "found", publicKey: "NEW" },
    ]);
    const keys = provider(registry);

    await keys.lookup("np.example", "k1");
    expect(
      await keys.lookup("np.example", "k1", { fresh: true }),
    ).toMatchObject({ publicKey: "NEW", source: "registry" });
    expect(await keys.lookup("np.example", "k1")).toMatchObject({
      publicKey: "NEW",
      source: "cache",
    });
  });

  it("remembers not_found briefly, so a bad keyId does not hit the registry every call", async () => {
    const registry = fakeRegistry([{ status: "not_found" }]);
    const keys = provider(registry);

    await keys.lookup("np.example", "k1");
    expect(await keys.lookup("np.example", "k1")).toEqual({
      status: "not_found",
    });
    expect(registry.calls).toBe(1);
  });

  it("never caches unavailable", async () => {
    const registry = fakeRegistry([
      { status: "unavailable", reason: "down" },
      { status: "found", publicKey: "REG" },
    ]);
    const keys = provider(registry);

    expect((await keys.lookup("np.example", "k1")).status).toBe("unavailable");
    expect(await keys.lookup("np.example", "k1")).toMatchObject({
      publicKey: "REG",
    });
  });
});
