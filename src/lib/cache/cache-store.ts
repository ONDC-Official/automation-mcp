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
 *
 * ## The append family is atomic, and that is the whole reason it exists
 *
 * `get` + mutate + `set` is a read-modify-write, and over a socket the window
 * between the two halves is milliseconds wide. `CLAUDE.md` names three sites
 * that already lose updates that way and forbids a fourth — so anything that
 * accumulates (a counter, an append-only log) uses `increment` / `listAppend`
 * instead, which each implementation performs as **one** indivisible operation:
 * trivially so in process, and through `MULTI` over Redis.
 *
 * They are also the documented migration target for the three existing races.
 */

/** How an appended list is bounded and how long it lives. */
export interface ListAppendOptions {
  /** Lifetime of the whole list, restarted by every append. */
  ttlMs: number;
  /**
   * Keep at most this many entries, dropping the **oldest** first. Omitted, the
   * list grows without bound — which for anything a participant can drive is a
   * memory leak with a network interface.
   */
  maxLength?: number;
}

export interface CacheStore {
  get<T>(key: string): Promise<T | undefined>;
  /**
   * Store under `key`, expiring after `ttlMs`. Overwrites silently, and an
   * overwrite restarts the TTL. A `ttlMs <= 0` deletes instead of writing.
   */
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  /**
   * Add `by` (default 1) to the counter at `key` and answer the **new** value,
   * in one indivisible step.
   *
   * An absent, expired or non-numeric entry counts as zero, so the first call
   * answers `by`. Every call restarts the TTL, because a counter that outlives
   * the thing it numbers is worse than one that expires with it: the sequence
   * would resume mid-way for an unrelated successor.
   *
   * `ttlMs <= 0` deletes, per property 4. The value still comes back so a
   * caller deriving a TTL from a past deadline needs no special case; nothing
   * survives the call to read it.
   */
  increment(key: string, ttlMs: number, by?: number): Promise<number>;
  /**
   * Append to the list at `key`, trimming the oldest entries past
   * `maxLength`, in one indivisible step.
   *
   * A key holding a non-list is replaced rather than merged — same rule as
   * `increment`, and the only sane answer when two shapes collide on one key.
   */
  listAppend<T>(
    key: string,
    value: T,
    options: ListAppendOptions,
  ): Promise<void>;
  /**
   * Read a slice of the list at `key`, **Redis `LRANGE` semantics**: zero-based,
   * `end` inclusive, negatives counting back from the tail (`-1` is the last
   * entry). Defaults to the whole list. An absent key is an empty list.
   */
  listRange<T>(key: string, start?: number, end?: number): Promise<T[]>;
  /** Dependency probe surfaced through `/ready`. */
  ping(): Promise<boolean>;
  /** Release any resources held by the implementation. Idempotent. */
  close(): Promise<void>;
}

/**
 * `LRANGE`'s index arithmetic, shared so the in-memory store cannot drift from
 * the Redis one. Out-of-range indices clamp; an inverted range is empty.
 */
export function sliceListRange<T>(
  list: readonly T[],
  start: number,
  end: number,
): T[] {
  const length = list.length;
  const from = Math.max(0, start < 0 ? length + start : start);
  const to = Math.min(length - 1, end < 0 ? length + end : end);
  if (from > to || from >= length) return [];
  return list.slice(from, to + 1);
}

/** Build a namespaced key. Segments are joined with the workbench's `::`. */
export function cacheKey(...segments: (string | number)[]): string {
  return segments.map((segment) => String(segment)).join("::");
}
