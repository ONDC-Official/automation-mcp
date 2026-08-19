import { cacheKey, type CacheStore } from "@/lib/cache/cache-store.js";
import { receiverRole } from "@/modules/catalog/catalog.service.js";
import type { ExpectationScope } from "@/modules/record/record.schema.js";
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
  /**
   * Every session created against one endpoint, oldest first.
   *
   * The endpoint — `{domain}/{version}/{buyer|seller}` — is the only thing an
   * arriving call identifies, and it is shared by every session on that build.
   * So when the receiver has to refuse a call it cannot attribute, this is the
   * set of sessions it could conceivably have belonged to. Ids only: an entry
   * that no longer resolves is simply a session that has expired.
   */
  listByEndpoint(scope: ExpectationScope): Promise<string[]>;
  /**
   * Every session this process knows of, newest first.
   *
   * There is no other way to ask. `CacheStore` has no `keys()` or `scan()` —
   * deliberately, since a Redis `SCAN` across a shared keyspace is the kind of
   * call that is fine until it is not — and `listByEndpoint` needs a
   * domain/version/role you do not have when all you were given is "show me
   * what is running". So this index exists purely to answer the viewer's
   * landing page, and like the endpoint index it is a list of candidates: ids
   * only, resolved one by one, and an entry that no longer resolves is simply a
   * session that has expired.
   */
  listRecent(limit: number): Promise<string[]>;
  /** Dependency probe surfaced through `/ready`. */
  ping(): Promise<boolean>;
}

/**
 * How many sessions one endpoint's index remembers.
 *
 * Trimmed oldest-first, which is the right end to lose: the sessions most
 * likely to still be running are the ones created most recently.
 */
export const ENDPOINT_INDEX_LIMIT = 500;

/**
 * How many sessions the process-wide index remembers.
 *
 * Smaller than the per-endpoint index because this one is read to render a
 * list a human scrolls, not to attribute a call. Trimmed oldest-first, which is
 * the right end to lose.
 */
export const RECENT_INDEX_LIMIT = 200;

export class CacheSessionRepository implements SessionRepository {
  readonly #cache: CacheStore;

  constructor(cache: CacheStore) {
    this.#cache = cache;
  }

  async save(session: Session, ttlMs: number): Promise<void> {
    const key = this.#key(session.session_id);
    // Only index a session the first time it is written. `save` is also how a
    // session is updated, and re-appending on every write would fill the index
    // with one id.
    const known = await this.#cache.has(key);

    await this.#cache.set(key, session, ttlMs);

    if (!known) {
      // Atomic append rather than read-modify-write: `session_create` is
      // concurrent by nature, and `CLAUDE.md` forbids adding a fourth site that
      // can lose an entry to a racing writer.
      await this.#cache.listAppend(
        endpointIndexKey({
          domain: session.build.domain,
          version: session.build.version,
          role: receiverRole(session.mock_role),
        }),
        session.session_id,
        { ttlMs, maxLength: ENDPOINT_INDEX_LIMIT },
      );
      await this.#cache.listAppend(recentIndexKey(), session.session_id, {
        ttlMs,
        maxLength: RECENT_INDEX_LIMIT,
      });
    }
  }

  find(sessionId: string): Promise<Session | undefined> {
    return this.#cache.get<Session>(this.#key(sessionId));
  }

  delete(sessionId: string): Promise<void> {
    // The endpoint index is deliberately left alone: it is a list of candidates,
    // not a source of truth, and every reader resolves each id before using it.
    return this.#cache.delete(this.#key(sessionId));
  }

  async listByEndpoint(scope: ExpectationScope): Promise<string[]> {
    return [
      ...new Set(await this.#cache.listRange<string>(endpointIndexKey(scope))),
    ];
  }

  async listRecent(limit: number): Promise<string[]> {
    const ids = [
      ...new Set(await this.#cache.listRange<string>(recentIndexKey())),
    ];
    // Appended oldest-first, read newest-first: the tail is what a viewer wants.
    return ids.reverse().slice(0, Math.max(0, limit));
  }

  ping(): Promise<boolean> {
    return this.#cache.ping();
  }

  #key(sessionId: string): string {
    return cacheKey("session", sessionId);
  }
}

/**
 * Every session, in creation order.
 *
 * One key rather than one per anything: the question it answers ("what is
 * running?") has no other axis, and a single bounded list is cheaper than a
 * scan the store cannot do.
 */
export function recentIndexKey(): string {
  return cacheKey("sessions_recent");
}

/** Sessions bucketed by the endpoint their callbacks arrive on. */
export function endpointIndexKey(scope: ExpectationScope): string {
  return cacheKey(
    "endpoint_sessions",
    scope.domain.trim().toUpperCase(),
    scope.version.trim(),
    scope.role,
  );
}
