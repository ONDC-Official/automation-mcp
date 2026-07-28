import { cacheKey, type CacheStore } from "@/lib/cache/cache-store.js";
import type { Session } from "@/modules/session/session.schema.js";

/**
 * Data access only — no business rules, no MCP types.
 *
 * Sessions are stored through `CacheStore` rather than a bespoke map, so the
 * day the server needs more than one replica the swap is a single Redis
 * implementation of that port and nothing here changes. The key format matches
 * the workbench's own (`session::{id}`) for the same reason.
 *
 * Expiry is the store's job: a session that has outlived its TTL simply is not
 * found, which is exactly how the service should see it.
 */

export interface SessionRepository {
  save(session: Session, ttlMs: number): Promise<void>;
  find(sessionId: string): Promise<Session | undefined>;
  delete(sessionId: string): Promise<void>;
  /** Dependency probe surfaced through `/ready`. */
  ping(): Promise<boolean>;
}

export class CacheSessionRepository implements SessionRepository {
  readonly #cache: CacheStore;

  constructor(cache: CacheStore) {
    this.#cache = cache;
  }

  save(session: Session, ttlMs: number): Promise<void> {
    return this.#cache.set(this.#key(session.session_id), session, ttlMs);
  }

  find(sessionId: string): Promise<Session | undefined> {
    return this.#cache.get<Session>(this.#key(sessionId));
  }

  delete(sessionId: string): Promise<void> {
    return this.#cache.delete(this.#key(sessionId));
  }

  ping(): Promise<boolean> {
    return this.#cache.ping();
  }

  #key(sessionId: string): string {
    return cacheKey("session", sessionId);
  }
}
