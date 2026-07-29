import { afterEach, describe, expect, it, vi } from "vitest";
import type { RedisLike } from "@/lib/cache/redis-cache-store.js";
import { RedisCacheStore } from "@/lib/cache/redis-cache-store.js";
import { NotFoundError, UpstreamError } from "@/lib/errors.js";
import { logger } from "@/lib/logger.js";
import { describeCacheStoreContract } from "@/test/cache-store-contract.js";

/**
 * A `RedisLike` backed by a `Map`, so the whole store is testable without a
 * server. It records the commands it was asked to run, which is how the tests
 * below assert things a live Redis makes awkward — that `has` never issues a
 * `GET`, that a non-positive TTL becomes a `DEL` rather than a `SET`, and that
 * the key written carries the configured prefix.
 *
 * Expiry is real-time rather than clock-injected, because the shared contract
 * suite runs against this fake too and Redis cannot be lied to about time.
 */
class FakeRedis implements RedisLike {
  readonly #entries = new Map<string, { value: string; expiresAt: number }>();
  readonly calls: string[] = [];
  readonly #handlers = new Map<string, ((argument: never) => void)[]>();

  /** Every command rejects while set. Simulates an outage. */
  failAll = false;
  /** `quit()` rejects while set. Simulates a server that vanished. */
  failQuit = false;
  connected = false;
  disconnectCount = 0;

  get(key: string): Promise<string | null> {
    this.calls.push(`GET ${key}`);
    if (this.failAll) return Promise.reject(new Error("ECONNREFUSED"));

    const entry = this.#entries.get(key);
    if (!entry) return Promise.resolve(null);
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value);
  }

  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown> {
    this.calls.push(`SET ${key} ${mode} ${String(ttlMs)}`);
    if (this.failAll) return Promise.reject(new Error("ECONNREFUSED"));
    // Mirror the real server: PX must be a positive integer.
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      return Promise.reject(new Error("ERR invalid expire time in 'set'"));
    }
    this.#entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    return Promise.resolve("OK");
  }

  del(...keys: string[]): Promise<number> {
    this.calls.push(`DEL ${keys.join(" ")}`);
    if (this.failAll) return Promise.reject(new Error("ECONNREFUSED"));
    let removed = 0;
    for (const key of keys) if (this.#entries.delete(key)) removed += 1;
    return Promise.resolve(removed);
  }

  exists(...keys: string[]): Promise<number> {
    this.calls.push(`EXISTS ${keys.join(" ")}`);
    if (this.failAll) return Promise.reject(new Error("ECONNREFUSED"));
    let found = 0;
    for (const key of keys) {
      const entry = this.#entries.get(key);
      if (entry && entry.expiresAt > Date.now()) found += 1;
    }
    return Promise.resolve(found);
  }

  ping(): Promise<string> {
    this.calls.push("PING");
    if (this.failAll) return Promise.reject(new Error("ECONNREFUSED"));
    return Promise.resolve("PONG");
  }

  quit(): Promise<unknown> {
    this.calls.push("QUIT");
    if (this.failQuit) return Promise.reject(new Error("connection gone"));
    this.connected = false;
    return Promise.resolve("OK");
  }

  disconnect(): void {
    this.disconnectCount += 1;
    this.connected = false;
  }

  connect(): Promise<void> {
    this.connected = true;
    this.#emit("ready");
    return Promise.resolve();
  }

  on(event: "error", handler: (error: Error) => void): this;
  on(event: "ready" | "end", handler: () => void): this;
  on(event: string, handler: (argument: never) => void): this {
    const existing = this.#handlers.get(event) ?? [];
    existing.push(handler);
    this.#handlers.set(event, existing);
    return this;
  }

  /** Drive an event the way ioredis would. */
  emitError(error: Error): void {
    for (const handler of this.#handlers.get("error") ?? []) {
      (handler as (argument: Error) => void)(error);
    }
  }

  #emit(event: string): void {
    for (const handler of this.#handlers.get(event) ?? []) {
      (handler as () => void)();
    }
  }

  /** The raw key set, for asserting what was actually written. */
  keys(): string[] {
    return [...this.#entries.keys()];
  }
}

function subject(options: { keyPrefix?: string } = {}): {
  store: RedisCacheStore;
  client: FakeRedis;
} {
  const client = new FakeRedis();
  const store = new RedisCacheStore({
    url: "redis://127.0.0.1:6379",
    logger,
    client,
    ...(options.keyPrefix !== undefined
      ? { keyPrefix: options.keyPrefix }
      : {}),
  });
  return { store, client };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// The fake is held to exactly the same contract as the real client.
describeCacheStoreContract("redis (fake client)", () => {
  const client = new FakeRedis();
  return new RedisCacheStore({
    url: "redis://127.0.0.1:6379",
    logger,
    client,
    keyPrefix: "ondc-mcp",
  });
});

describe("redis cache store", () => {
  describe("key prefixing", () => {
    it("writes the configured namespace into the key", async () => {
      const { store, client } = subject({ keyPrefix: "ondc-mcp" });

      await store.set("session::abc", { id: "abc" }, 60_000);

      expect(client.keys()).toEqual(["ondc-mcp::session::abc"]);
      await store.close();
    });

    /**
     * An empty prefix writes the workbench's literal layout, which is what
     * makes sharing a Redis with it a configuration change rather than a
     * migration.
     */
    it("writes the bare key when the prefix is empty", async () => {
      const { store, client } = subject({ keyPrefix: "" });

      await store.set("session::abc", { id: "abc" }, 60_000);

      expect(client.keys()).toEqual(["session::abc"]);
      await store.close();
    });

    it("reads back through the same prefix it wrote", async () => {
      const { store } = subject({ keyPrefix: "ondc-mcp" });

      await store.set("k", { hello: "world" }, 60_000);

      await expect(store.get("k")).resolves.toEqual({ hello: "world" });
      await store.close();
    });
  });

  describe("reads", () => {
    it("maps a missing key to undefined", async () => {
      const { store } = subject();

      await expect(store.get("nothing")).resolves.toBeUndefined();
      await store.close();
    });

    /** One poisoned key must not break the loop for every other key. */
    it("treats an unparseable value as absent and warns", async () => {
      const { store, client } = subject();
      const warn = vi.spyOn(logger, "warn").mockReturnValue(undefined);
      await client.set("broken", "{not json", "PX", 60_000);

      await expect(store.get("broken")).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      // Deliberately left in place: another writer may know something we do not.
      expect(client.keys()).toContain("broken");
      await store.close();
    });
  });

  describe("writes", () => {
    it("issues DEL rather than SET for a zero TTL", async () => {
      const { store, client } = subject();
      await store.set("k", "v", 60_000);
      client.calls.length = 0;

      await store.set("k", "v", 0);

      expect(client.calls).toEqual(["DEL k"]);
      await expect(store.get("k")).resolves.toBeUndefined();
      await store.close();
    });

    it("issues DEL rather than SET for a negative TTL", async () => {
      const { store, client } = subject();
      client.calls.length = 0;

      await store.set("k", "v", -1_000);

      expect(client.calls).toEqual(["DEL k"]);
      await store.close();
    });

    /** `JSON.stringify(undefined)` is not a string; storing it would throw. */
    it("issues DEL when the value serializes to nothing", async () => {
      const { store, client } = subject();
      await store.set("k", "v", 60_000);
      client.calls.length = 0;

      await store.set("k", undefined, 60_000);

      expect(client.calls).toEqual(["DEL k"]);
      await store.close();
    });

    it("rounds a fractional TTL up to an integer PX", async () => {
      const { store, client } = subject();

      await store.set("k", "v", 1_500.7);

      expect(client.calls).toContain("SET k PX 1501");
      await store.close();
    });
  });

  /**
   * The one place the port is cheaper over a socket than in memory. Answering a
   * boolean by pulling a stored payload across the wire would throw that away.
   */
  it("answers `has` with EXISTS, never GET", async () => {
    const { store, client } = subject();
    await store.set("k", { big: "payload" }, 60_000);
    client.calls.length = 0;

    await expect(store.has("k")).resolves.toBe(true);

    expect(client.calls).toEqual(["EXISTS k"]);
    expect(client.calls.some((call) => call.startsWith("GET"))).toBe(false);
    await store.close();
  });

  describe("failure policy", () => {
    /**
     * The guard on the decision documented at the top of the store. If a failed
     * read returned `undefined`, `requireSession` would raise `NotFoundError`,
     * the model would read "call session_create to start a new one", and a
     * Redis blip would put a second transaction on a real participant's wire.
     */
    it("throws UpstreamError from a failed read rather than reporting absence", async () => {
      const { store, client } = subject();
      client.failAll = true;

      const error = await store.get("k").catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(UpstreamError);
      expect(error).not.toBeInstanceOf(NotFoundError);
      expect(error).not.toBeUndefined();
      expect((error as UpstreamError).message).toContain("redis");
      await store.close();
    });

    it("throws from a failed write, delete and has", async () => {
      const { store, client } = subject();
      client.failAll = true;

      await expect(store.set("k", "v", 60_000)).rejects.toBeInstanceOf(
        UpstreamError,
      );
      await expect(store.delete("k")).rejects.toBeInstanceOf(UpstreamError);
      await expect(store.has("k")).rejects.toBeInstanceOf(UpstreamError);
      await store.close();
    });

    /** `/ready` wants a verdict; a throw would read as a broken probe. */
    it("answers ping false instead of throwing when the client rejects", async () => {
      const { store, client } = subject();
      client.failAll = true;

      await expect(store.ping()).resolves.toBe(false);
      await store.close();
    });

    /**
     * Regression test for the failure mode that would take the process down:
     * ioredis emits `error` on an EventEmitter, and an unhandled 'error' event
     * is fatal in Node.
     */
    it("survives an error event without throwing", async () => {
      const { store, client } = subject();
      const warn = vi.spyOn(logger, "warn").mockReturnValue(undefined);

      expect(() => {
        client.emitError(new Error("ECONNREFUSED"));
      }).not.toThrow();

      expect(warn).toHaveBeenCalledTimes(1);

      // A second failure does not flood the log...
      client.emitError(new Error("ECONNREFUSED"));
      expect(warn).toHaveBeenCalledTimes(1);

      // ...but a recovery followed by a new failure is reported again.
      await client.connect();
      client.emitError(new Error("ECONNREFUSED"));
      expect(warn).toHaveBeenCalledTimes(2);

      await store.close();
    });
  });

  describe("close", () => {
    it("is idempotent and quits exactly once", async () => {
      const { store, client } = subject();

      await store.close();
      await store.close();

      expect(client.calls.filter((call) => call === "QUIT")).toHaveLength(1);
      expect(client.disconnectCount).toBe(1);
    });

    /**
     * `disconnect` is what clears the reconnect timer, and a live reconnect
     * timer is a stdio process that never exits — so it must run even when the
     * polite `quit` fails.
     */
    it("disconnects even when quit rejects", async () => {
      const { store, client } = subject();
      client.failQuit = true;

      await expect(store.close()).resolves.toBeUndefined();

      expect(client.disconnectCount).toBe(1);
    });

    it("does not log connection errors raised during teardown", async () => {
      const { store, client } = subject();
      const warn = vi.spyOn(logger, "warn").mockReturnValue(undefined);

      await store.close();
      client.emitError(new Error("socket closed"));

      expect(warn).not.toHaveBeenCalled();
    });
  });
});
