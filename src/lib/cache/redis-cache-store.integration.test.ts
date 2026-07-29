import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { RedisCacheStore } from "@/lib/cache/redis-cache-store.js";
import { logger } from "@/lib/logger.js";
import { describeCacheStoreContract } from "@/test/cache-store-contract.js";

/**
 * The contract, against a real server.
 *
 * Opt-in, because the default suite must never need infrastructure:
 *
 *   docker compose -f docker-compose.dev.yml up -d
 *   RUN_REDIS_TESTS=1 npm test -- redis-cache-store
 *
 * The gate is deliberately **not** `RUN_LIVE_TESTS`. That one means "reach the
 * real config-service over the internet", and someone running it to check a
 * catalog change should not start failing because they have no local Redis.
 *
 * Every run namespaces itself under `test::{uuid}`, which is what makes this
 * safe against a Redis shared with other projects — and why cleanup is a
 * `SCAN` over that prefix rather than `FLUSHDB`. Flushing a developer's Redis
 * to tidy up after a test is precisely the behaviour the prefix exists to
 * prevent.
 */

const RUN = process.env.RUN_REDIS_TESTS === "1";
const URL = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6379";

/** Namespaces created by this file, cleaned up in `afterAll`. */
const prefixes: string[] = [];

function prefix(): string {
  const value = `test::${randomUUID()}`;
  prefixes.push(value);
  return value;
}

function store(keyPrefix: string): RedisCacheStore {
  return new RedisCacheStore({ url: URL, logger, keyPrefix });
}

describe.skipIf(!RUN)("redis cache store (live server)", () => {
  afterAll(async () => {
    if (prefixes.length === 0) return;

    // Its own connection: the stores under test have all been closed by now.
    const client = new Redis(URL, { maxRetriesPerRequest: 2 });
    try {
      for (const value of prefixes) {
        const keys: string[] = [];
        // SCAN, never KEYS — this Redis may not be ours alone.
        for await (const batch of client.scanStream({
          match: `${value}::*`,
          count: 100,
        }) as AsyncIterable<string[]>) {
          keys.push(...batch);
        }
        if (keys.length > 0) await client.del(...keys);
      }
    } finally {
      await client.quit();
      client.disconnect();
    }
  });

  // The whole port contract, run against redis:8 rather than a Map.
  describeCacheStoreContract("redis (live)", () => store(prefix()));

  it("persists a value across store instances, which is the entire point", async () => {
    const keyPrefix = prefix();
    const session = { session_id: "abc", mock_role: "BAP" };

    const first = store(keyPrefix);
    await first.set("session::abc", session, 60_000);
    await first.close();

    // A new client, as a restarted process would build.
    const second = store(keyPrefix);
    try {
      await expect(second.get("session::abc")).resolves.toEqual(session);
    } finally {
      await second.close();
    }
  });

  it("writes the key exactly as configured, so redis-cli finds it", async () => {
    const keyPrefix = prefix();
    const cache = store(keyPrefix);
    const client = new Redis(URL, { maxRetriesPerRequest: 2 });

    try {
      await cache.set("session::abc", { id: "abc" }, 60_000);

      await expect(client.exists(`${keyPrefix}::session::abc`)).resolves.toBe(
        1,
      );
      // And the TTL really is per-entry, set at write time.
      const ttl = await client.pttl(`${keyPrefix}::session::abc`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);
    } finally {
      await cache.close();
      await client.quit();
      client.disconnect();
    }
  });

  it("isolates namespaces, so a shared Redis stays safe", async () => {
    const mine = store(prefix());
    const theirs = store(prefix());

    try {
      await mine.set("session::abc", "mine", 60_000);

      await expect(theirs.get("session::abc")).resolves.toBeUndefined();
      await expect(mine.get("session::abc")).resolves.toBe("mine");
    } finally {
      await mine.close();
      await theirs.close();
    }
  });
});

/**
 * The "boot must not hang" property, proved against a real ECONNREFUSED rather
 * than a fake. Needs no server, so it runs in the default suite — this is the
 * failure mode that would otherwise be discovered in production.
 */
describe("redis cache store (unreachable server)", () => {
  it("constructs and reports itself down without blocking", async () => {
    const started = performance.now();
    // Nothing listens here. Port 6399 is not the dev container's 6379.
    const cache = new RedisCacheStore({
      url: "redis://127.0.0.1:6399",
      logger,
      keyPrefix: "test",
      commandTimeoutMs: 250,
    });
    const constructedMs = performance.now() - started;

    try {
      // The constructor must not have waited on the socket.
      expect(constructedMs).toBeLessThan(500);
      // And the readiness probe answers rather than throwing.
      await expect(cache.ping()).resolves.toBe(false);
    } finally {
      await cache.close();
    }
  });
});
