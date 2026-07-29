import { describe, expect, it } from "vitest";
import { cacheKey } from "@/lib/cache/cache-store.js";
import { InMemoryCacheStore } from "@/lib/cache/in-memory-cache-store.js";
import { describeCacheStoreContract } from "@/test/cache-store-contract.js";

function store(clock: { value: number }): InMemoryCacheStore {
  // No sweep timer: these tests drive expiry through the injected clock.
  return new InMemoryCacheStore({ sweepIntervalMs: 0, now: () => clock.value });
}

// The shared port contract. Runs on the real clock, so no injected `now` here.
describeCacheStoreContract(
  "in-memory",
  () => new InMemoryCacheStore({ sweepIntervalMs: 0 }),
);

// Everything below is specific to *this* implementation — the injected clock,
// the sweep, and the `size()` probe that is not part of the port.

describe("in-memory cache store", () => {
  it("round-trips a value within its TTL", async () => {
    const clock = { value: 1_000 };
    const cache = store(clock);

    await cache.set("k", { hello: "world" }, 5_000);
    clock.value += 4_999;

    await expect(cache.get("k")).resolves.toEqual({ hello: "world" });
    await expect(cache.has("k")).resolves.toBe(true);
  });

  /**
   * The contract every caller depends on: an expired entry is indistinguishable
   * from one that was never written. Callers branch on `undefined`, never on an
   * expiry timestamp.
   */
  it("reports an expired entry as absent, without waiting for a sweep", async () => {
    const clock = { value: 1_000 };
    const cache = store(clock);

    await cache.set("k", "v", 5_000);
    clock.value += 5_000;

    await expect(cache.get("k")).resolves.toBeUndefined();
    await expect(cache.has("k")).resolves.toBe(false);
  });

  it("drops expired entries from the footprint", async () => {
    const clock = { value: 0 };
    const cache = store(clock);

    await cache.set("short", "v", 1_000);
    await cache.set("long", "v", 10_000);
    clock.value = 2_000;

    expect(cache.size()).toBe(1);
  });

  it("overwrites a key and restarts its TTL", async () => {
    const clock = { value: 0 };
    const cache = store(clock);

    await cache.set("k", "first", 1_000);
    clock.value = 900;
    await cache.set("k", "second", 1_000);
    clock.value = 1_500;

    await expect(cache.get("k")).resolves.toBe("second");
  });

  it("deletes on demand", async () => {
    const cache = store({ value: 0 });

    await cache.set("k", "v", 1_000);
    await cache.delete("k");

    await expect(cache.get("k")).resolves.toBeUndefined();
  });

  it("empties on close so a disposed container releases its state", async () => {
    const cache = store({ value: 0 });

    await cache.set("k", "v", 60_000);
    await cache.close();

    expect(cache.size()).toBe(0);
    await expect(cache.close()).resolves.toBeUndefined();
  });

  it("namespaces keys the way the workbench does", () => {
    expect(cacheKey("flows", "ONDC:FIS12", "2.0.3", "PERSONAL LOAN")).toBe(
      "flows::ONDC:FIS12::2.0.3::PERSONAL LOAN",
    );
  });
});
