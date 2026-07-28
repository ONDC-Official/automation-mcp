import type { CacheStore } from "@/lib/cache/cache-store.js";

/**
 * The default `CacheStore`: a `Map` with per-entry expiry.
 *
 * Single-process only, which is the right trade until the ONDC receiver routes
 * exist and more than one replica can serve the same transaction. At that point
 * a Redis implementation of `CacheStore` replaces this one and nothing else
 * changes.
 *
 * Expiry is enforced two ways: lazily on read (so a stale value can never be
 * returned even if the sweep is late) and by a periodic sweep (so entries
 * nobody reads again do not pin memory for the life of the process). The sweep
 * timer is `unref`'d — it must never be the reason a stdio process stays alive.
 */

interface Entry {
  readonly value: unknown;
  readonly expiresAt: number;
}

export interface InMemoryCacheStoreOptions {
  /** How often to sweep expired entries. Defaults to 60s. */
  sweepIntervalMs?: number;
  /** Injectable clock, for tests that need to cross a TTL boundary. */
  now?: () => number;
}

export class InMemoryCacheStore implements CacheStore {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  #sweepTimer: NodeJS.Timeout | undefined;

  constructor(options: InMemoryCacheStoreOptions = {}) {
    this.#now = options.now ?? Date.now;

    const interval = options.sweepIntervalMs ?? 60_000;
    if (interval > 0) {
      this.#sweepTimer = setInterval(() => {
        this.#sweep();
      }, interval);
      // Never hold the event loop open on account of a cache.
      this.#sweepTimer.unref();
    }
  }

  get<T>(key: string): Promise<T | undefined> {
    const entry = this.#entries.get(key);
    if (!entry) return Promise.resolve(undefined);

    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return Promise.resolve(undefined);
    }

    return Promise.resolve(entry.value as T);
  }

  set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.#entries.set(key, { value, expiresAt: this.#now() + ttlMs });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.#entries.delete(key);
    return Promise.resolve();
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }

  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }

  close(): Promise<void> {
    if (this.#sweepTimer) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = undefined;
    }
    this.#entries.clear();
    return Promise.resolve();
  }

  /** Live entry count, after dropping anything expired. Tests and metrics. */
  size(): number {
    this.#sweep();
    return this.#entries.size;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
  }
}
