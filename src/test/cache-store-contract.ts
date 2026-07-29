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

    /* ------------------------- the append family ------------------------- */

    /**
     * These are the primitives the session journal is built on, and the
     * property that matters is not "it counts" but "it counts *atomically*".
     * A `get`-mutate-`set` would pass most of what follows and still lose
     * entries under concurrency — so the concurrency test below is the one
     * that carries the weight.
     */
    describe("increment", () => {
      it("starts at one and accumulates", async () => {
        await withStore(async (cache) => {
          await expect(cache.increment("seq", 60_000)).resolves.toBe(1);
          await expect(cache.increment("seq", 60_000)).resolves.toBe(2);
          await expect(cache.increment("seq", 60_000)).resolves.toBe(3);
        });
      });

      it("adds an explicit step", async () => {
        await withStore(async (cache) => {
          await expect(cache.increment("seq", 60_000, 5)).resolves.toBe(5);
          await expect(cache.increment("seq", 60_000, 3)).resolves.toBe(8);
        });
      });

      it("keeps counters on different keys independent", async () => {
        await withStore(async (cache) => {
          await cache.increment("a", 60_000);
          await cache.increment("a", 60_000);
          await expect(cache.increment("b", 60_000)).resolves.toBe(1);
          await expect(cache.increment("a", 60_000)).resolves.toBe(3);
        });
      });

      /**
       * The whole point. Fired in the same tick, a read-modify-write hands both
       * callers the same number; an atomic one cannot.
       */
      it("hands every concurrent caller a distinct number", async () => {
        await withStore(async (cache) => {
          const issued = await Promise.all(
            Array.from({ length: 20 }, () => cache.increment("seq", 60_000)),
          );

          expect(new Set(issued).size).toBe(20);
          expect([...issued].sort((a, b) => a - b)).toEqual(
            Array.from({ length: 20 }, (_, index) => index + 1),
          );
        });
      });

      it("restarts once the counter has expired", async () => {
        await withStore(async (cache) => {
          await expect(cache.increment("seq", 50)).resolves.toBe(1);
          await sleep(120);

          await expect(cache.increment("seq", 60_000)).resolves.toBe(1);
        });
      });

      it("treats a non-positive TTL as a delete", async () => {
        await withStore(async (cache) => {
          await cache.increment("seq", 60_000);
          await cache.increment("seq", 0);

          await expect(cache.has("seq")).resolves.toBe(false);
          await expect(cache.increment("seq", 60_000)).resolves.toBe(1);
        });
      });
    });

    describe("listAppend / listRange", () => {
      it("returns an absent list as empty rather than undefined", async () => {
        await withStore(async (cache) => {
          await expect(cache.listRange("never-written")).resolves.toEqual([]);
        });
      });

      it("appends in order and reads the whole list by default", async () => {
        await withStore(async (cache) => {
          for (const seq of [1, 2, 3]) {
            await cache.listAppend("log", { seq }, { ttlMs: 60_000 });
          }

          await expect(cache.listRange("log")).resolves.toEqual([
            { seq: 1 },
            { seq: 2 },
            { seq: 3 },
          ]);
        });
      });

      it("round-trips nested entries", async () => {
        await withStore(async (cache) => {
          const entry = {
            seq: 1,
            kind: "INBOUND_NACK",
            nested: { code: "OUT_OF_SEQUENCE", ids: ["a", "b"] },
          };
          await cache.listAppend("log", entry, { ttlMs: 60_000 });

          await expect(cache.listRange("log")).resolves.toEqual([entry]);
        });
      });

      /** `LRANGE` semantics: zero-based, end inclusive, negatives from the tail. */
      it("slices with Redis index semantics", async () => {
        await withStore(async (cache) => {
          for (const seq of [1, 2, 3, 4, 5]) {
            await cache.listAppend("log", seq, { ttlMs: 60_000 });
          }

          await expect(cache.listRange("log", 0, 2)).resolves.toEqual([1, 2, 3]);
          await expect(cache.listRange("log", 2)).resolves.toEqual([3, 4, 5]);
          await expect(cache.listRange("log", -2)).resolves.toEqual([4, 5]);
          await expect(cache.listRange("log", 1, -2)).resolves.toEqual([2, 3, 4]);
          // Out of range clamps; inverted is empty. Neither is an error.
          await expect(cache.listRange("log", 0, 99)).resolves.toHaveLength(5);
          await expect(cache.listRange("log", 3, 1)).resolves.toEqual([]);
          await expect(cache.listRange("log", 99, 120)).resolves.toEqual([]);
        });
      });

      it("trims to maxLength, keeping the newest", async () => {
        await withStore(async (cache) => {
          for (const seq of [1, 2, 3, 4, 5]) {
            await cache.listAppend("log", seq, { ttlMs: 60_000, maxLength: 3 });
          }

          await expect(cache.listRange("log")).resolves.toEqual([3, 4, 5]);
        });
      });

      /** Concurrent appends must all survive — that is what the cap is for. */
      it("keeps every concurrent append", async () => {
        await withStore(async (cache) => {
          await Promise.all(
            Array.from({ length: 20 }, (_, index) =>
              cache.listAppend("log", index, { ttlMs: 60_000, maxLength: 50 }),
            ),
          );

          const stored = await cache.listRange<number>("log");
          expect(stored).toHaveLength(20);
          expect([...stored].sort((a, b) => a - b)).toEqual(
            Array.from({ length: 20 }, (_, index) => index),
          );
        });
      });

      /**
       * A list that expired mid-flow would silently truncate the journal, so
       * every append restarts the clock rather than letting the first one
       * decide how long the whole log lives.
       */
      it("restarts the TTL on every append", async () => {
        await withStore(async (cache) => {
          await cache.listAppend("log", 1, { ttlMs: 250 });
          await sleep(150);
          await cache.listAppend("log", 2, { ttlMs: 250 });
          await sleep(150);

          // 300ms since the first write, but only 150ms since the refresh.
          await expect(cache.listRange("log")).resolves.toEqual([1, 2]);
        });
      });

      it("reports an expired list as empty", async () => {
        await withStore(async (cache) => {
          await cache.listAppend("log", 1, { ttlMs: 50 });
          await sleep(120);

          await expect(cache.listRange("log")).resolves.toEqual([]);
        });
      });

      it("treats a non-positive TTL as a delete", async () => {
        await withStore(async (cache) => {
          await cache.listAppend("log", 1, { ttlMs: 60_000 });
          await cache.listAppend("log", 2, { ttlMs: 0 });

          await expect(cache.listRange("log")).resolves.toEqual([]);
        });
      });

      /** A caller must never be able to edit stored state through a read. */
      it("hands back a slice the caller owns", async () => {
        await withStore(async (cache) => {
          await cache.listAppend("log", { seq: 1 }, { ttlMs: 60_000 });

          const first = await cache.listRange<{ seq: number }>("log");
          first.push({ seq: 99 });

          await expect(cache.listRange("log")).resolves.toEqual([{ seq: 1 }]);
        });
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
