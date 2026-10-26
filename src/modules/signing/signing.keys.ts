import type { CacheStore } from "@/lib/cache/cache-store.js";
import type {
  LookupResult,
  RegistryGateway,
} from "@/modules/signing/signing.gateway.js";

/**
 * Where a participant's signing public key comes from: the cache, for
 * `SIGNING_KEY_CACHE_TTL_MS`, then the registry.
 *
 * The cache is `catalogCache`, in-process: a key is derived data we can always
 * fetch again, and reading it must cost nothing inside the ACK window.
 *
 * `fresh` skips the cache. The caller uses it once, when a signature fails
 * against a cached key — a participant that has just rotated its key would
 * otherwise be rejected for the rest of the TTL while signing correctly.
 */

export type KeyResult =
  | (LookupResult & {
      status: "found";
      source: "cache" | "registry";
    })
  | Exclude<LookupResult, { status: "found" }>;

/** How long "the registry has no such key" is remembered. */
const NOT_FOUND_TTL_MS = 60_000;

const NOT_FOUND = "__not_found__";

export interface KeyProviderOptions {
  /** Absent when no registry is configured: then no key can be found. */
  registry: RegistryGateway | undefined;
  cache: CacheStore;
  ttlMs: number;
}

export class KeyProvider {
  readonly #options: KeyProviderOptions;

  constructor(options: KeyProviderOptions) {
    this.#options = options;
  }

  /** Whether any key can be found at all. */
  get hasSource(): boolean {
    return this.#options.registry !== undefined;
  }

  async lookup(
    subscriberId: string,
    uniqueKeyId: string,
    { fresh = false }: { fresh?: boolean } = {},
  ): Promise<KeyResult> {
    const { registry, cache, ttlMs } = this.#options;
    if (registry === undefined) return { status: "not_found" };

    const cacheKey = `signing_key::${subscriberId}|${uniqueKeyId}`;
    if (!fresh) {
      const cached = await cache.get<string>(cacheKey);
      if (cached === NOT_FOUND) return { status: "not_found" };
      if (cached !== undefined) {
        return { status: "found", publicKey: cached, source: "cache" };
      }
    }

    const result = await registry.lookup(subscriberId, uniqueKeyId);
    if (result.status === "found") {
      await cache.set(cacheKey, result.publicKey, ttlMs);
      return { ...result, source: "registry" };
    }
    if (result.status === "not_found") {
      await cache.set(cacheKey, NOT_FOUND, NOT_FOUND_TTL_MS);
    }
    // `unavailable` is never cached: the next call should try again.
    return result;
  }
}
