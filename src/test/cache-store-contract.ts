import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { CacheStore } from "@/lib/cache/cache-store.js";

/**
 * The `CacheStore` contract, as executable tests.
 *
 * Every implementation runs this same suite, which is the only thing that makes
 * "swap the store and nothing above it moves" a claim rather than a hope. The
 * four properties in `cache-store.ts` are stated there in prose and asserted
 * here.
 *
 * It lives in `src/test/` rather than next to the stores for two reasons:
 * vitest's `include` glob picks up every `.test.ts` under `src`, so naming this
 * one `.test.ts` would run it standalone with no store to test; and `src/test/`
 * is already excluded from coverage, which is where a file that only exports
 * `describe` blocks belongs.
 *
 * Note the deliberate absence of an injected clock. `InMemoryCacheStore` takes
 * one and its own suite uses it, but Redis expires entries on its own wall
 * clock and cannot be lied to — so the one test here that has to cross a TTL
 * boundary sleeps for real. That is ~80ms per implementation, paid once.
 */
export function describeCacheStoreContract(
  name: string,
  createStore: () => CacheStore | Promise<CacheStore>,
): void {
  describe(`CacheStore contract: ${name}`, () => {
    /** Build a store and guarantee it is closed even when the test throws. */
    async function withStore(
      body: (cache: CacheStore) => Promise<void>,
    ): Promise<void> {
      const cache = await createStore();
      try {
        await body(cache);
      } finally {
        await cache.close();
      }
    }

    it("round-trips a nested value within its TTL", async () => {
      await withStore(async (cache) => {
        const value = {
          session_id: "abc",
          np: { subscriber_url: "https://np.example.com", type: "BAP" },
          flows: ["a", "b"],
          nested: { deep: { count: 3, ok: true } },
        };

        await cache.set("k", value, 60_000);

        await expect(cache.get("k")).resolves.toEqual(value);
      });
    });

    it("reports an absent key as undefined", async () => {
      await withStore(async (cache) => {
        await expect(cache.get("never-written")).resolves.toBeUndefined();
        await expect(cache.has("never-written")).resolves.toBe(false);
      });
    });

    it("answers `has` for a key that exists", async () => {
      await withStore(async (cache) => {
        await cache.set("k", "v", 60_000);

        await expect(cache.has("k")).resolves.toBe(true);
      });
    });

    it("overwrites a key with the newer value", async () => {
      await withStore(async (cache) => {
        await cache.set("k", "first", 60_000);
        await cache.set("k", "second", 60_000);

        await expect(cache.get("k")).resolves.toBe("second");
      });
    });

    it("deletes on demand, and deleting an absent key is not an error", async () => {
      await withStore(async (cache) => {
        await cache.set("k", "v", 60_000);
        await cache.delete("k");

        await expect(cache.get("k")).resolves.toBeUndefined();
        await expect(cache.delete("k")).resolves.toBeUndefined();
      });
    });

    /**
     * Property 2: an expired entry is indistinguishable from an absent one.
     * The only test here that spends real time, and the reason is in the
     * suite's header.
     */
    it("reports an expired entry as absent", async () => {
      await withStore(async (cache) => {
        await cache.set("k", "v", 50);
        await sleep(120);

        await expect(cache.get("k")).resolves.toBeUndefined();
        await expect(cache.has("k")).resolves.toBe(false);
      });
    });

    /** Property 4. A caller computing a TTL from a past deadline must not fail. */
    it("treats a non-positive TTL as a delete", async () => {
      await withStore(async (cache) => {
        await cache.set("zero", "v", 60_000);
        await cache.set("zero", "v", 0);
        await expect(cache.get("zero")).resolves.toBeUndefined();

        await cache.set("negative", "v", 60_000);
        await cache.set("negative", "v", -1_000);
        await expect(cache.get("negative")).resolves.toBeUndefined();
      });
    });

    /**
     * Real keys carry `::` separators, colons inside a domain (`ONDC:FIS12`),
     * spaces inside a use-case, and a URL. A store that mangles any of them
     * writes one key and reads another.
     */
    it("round-trips the key shapes this codebase actually uses", async () => {
      await withStore(async (cache) => {
        const keys = [
          "session::0f1c8a1e-1111-2222-3333-444455556666",
          "flows::ONDC:FIS12::2.0.3::PERSONAL LOAN",
          "MOCK_DATA::txn-1::https://np.example.com/ondc",
          "FLOW_STATUS_txn-1::https://np.example.com/ondc",
        ];

        for (const [index, key] of keys.entries()) {
          await cache.set(key, { index }, 60_000);
        }

        for (const [index, key] of keys.entries()) {
          await expect(cache.get(key)).resolves.toEqual({ index });
        }
      });
    });

    it("keeps distinct keys distinct", async () => {
      await withStore(async (cache) => {
        await cache.set("a", "first", 60_000);
        await cache.set("b", "second", 60_000);

        await expect(cache.get("a")).resolves.toBe("first");
        await expect(cache.get("b")).resolves.toBe("second");
      });
    });

    it("survives falsy values without confusing them for absence", async () => {
      await withStore(async (cache) => {
        await cache.set("zero", 0, 60_000);
        await cache.set("empty", "", 60_000);
        await cache.set("false", false, 60_000);

        await expect(cache.get("zero")).resolves.toBe(0);
        await expect(cache.get("empty")).resolves.toBe("");
        await expect(cache.get("false")).resolves.toBe(false);
        await expect(cache.has("zero")).resolves.toBe(true);
      });
    });

    it("reports a healthy dependency through ping", async () => {
      await withStore(async (cache) => {
        await expect(cache.ping()).resolves.toBe(true);
      });
    });

    it("closes idempotently", async () => {
      const cache = await createStore();

      await expect(cache.close()).resolves.toBeUndefined();
      await expect(cache.close()).resolves.toBeUndefined();
    });
  });
}
