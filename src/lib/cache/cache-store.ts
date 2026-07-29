/**
 * The one storage port in the server.
 *
 * Everything with a lifetime longer than a request — sessions, fetched flow
 * catalogs, mock-runner configs — goes through here. The in-memory
 * implementation ships by default so the server runs with zero infrastructure;
 * replacing it with Redis or a database means writing a second class against
 * this interface and changing one line in `createContainer`. Nothing above this
 * layer moves.
 *
 * Four properties every implementation must preserve:
 *
 * 1. **TTL is per entry, set at write time.** A session lives 48h, a fetched
 *    catalog ~15min. The store never invents a default.
 * 2. **An expired entry is indistinguishable from an absent one.** Callers
 *    branch on `undefined`, never on an expiry timestamp.
 * 3. **`get` returns a value you own.** Mutating it does not update the store;
 *    only `set` does. `InMemoryCacheStore` happens to hand back its own
 *    reference, but no caller may rely on that — `RedisCacheStore` returns a
 *    fresh parse of what was written. Read, build a new value, write it back.
 * 4. **`ttlMs <= 0` means gone.** It deletes rather than failing, so a caller
 *    that computes a TTL from a deadline already past does not have to
 *    special-case it.
 *
 * A corollary of (3) that bites silently: values are round-tripped through
 * JSON, so an explicit `undefined` property is **dropped**, not preserved —
 * `{a: undefined}` comes back as `{}` and `"a" in value` flips from true to
 * false. Build stored shapes by omitting optional keys
 * (`...(x !== undefined ? { x } : {})`, the idiom used throughout this
 * codebase) rather than by assigning `undefined` to them.
 *
 * Keys are namespaced with `::` to mirror the workbench's own Redis
 * conventions (`session::{id}`, `flows::{domain}::{version}::{usecase}`), which
 * is what made the Redis implementation a drop-in rather than a re-key.
 */

export interface CacheStore {
  get<T>(key: string): Promise<T | undefined>;
  /**
   * Store under `key`, expiring after `ttlMs`. Overwrites silently, and an
   * overwrite restarts the TTL. A `ttlMs <= 0` deletes instead of writing.
   */
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  /** Dependency probe surfaced through `/ready`. */
  ping(): Promise<boolean>;
  /** Release any resources held by the implementation. Idempotent. */
  close(): Promise<void>;
}

/** Build a namespaced key. Segments are joined with the workbench's `::`. */
export function cacheKey(...segments: (string | number)[]): string {
  return segments.map((segment) => String(segment)).join("::");
}
