import { cacheKey, type CacheStore } from "@/lib/cache/cache-store.js";
import type { Incident } from "@/modules/feedback/feedback.schema.js";

/**
 * Where incidents live.
 *
 * Two keys and an index, and the shape of them is decided by one rule from
 * `CLAUDE.md §6`: **do not add a fourth read-modify-write.** So the per-session
 * index is an atomic `listAppend`, and the occurrence counter is an atomic
 * `increment` on a key of its own rather than a field on the incident that two
 * concurrent failures would both read as 1.
 *
 * The incident body itself *is* loaded and saved whole, but only ever from a
 * single writer per signature: `note()` serialises on the signature before it
 * touches anything, so the load-modify-save inside is not concurrent with
 * itself. The counter is separate precisely because that guarantee does not
 * extend across processes.
 *
 * Incidents share the session TTL rather than the transaction's. An incident
 * outlives the run it describes — that is the whole point of `UNRESOLVED` —
 * and a report waiting to be flushed must not expire before the session that
 * would flush it.
 */

export interface FeedbackRepositoryOptions {
  cache: CacheStore;
  /** Lifetime of an incident and of a session's index. */
  sessionTtlMs: number;
}

/** How many incidents one session may accumulate before the oldest is dropped. */
export const INCIDENT_INDEX_LIMIT = 200;

/** `incident::{sessionId}::{signature}` — the deduped body. */
export function incidentKey(sessionId: string, signature: string): string {
  return cacheKey("incident", sessionId, signature);
}

/** `incident_seen::{sessionId}::{signature}` — the atomic occurrence counter. */
export function incidentCountKey(sessionId: string, signature: string): string {
  return cacheKey("incident_seen", sessionId, signature);
}

/** `incidents::{sessionId}` — signatures, oldest first. */
export function sessionIncidentsKey(sessionId: string): string {
  return cacheKey("incidents", sessionId);
}

export class FeedbackRepository {
  readonly #cache: CacheStore;
  readonly #ttl: number;

  constructor(options: FeedbackRepositoryOptions) {
    this.#cache = options.cache;
    this.#ttl = options.sessionTtlMs;
  }

  find(sessionId: string, signature: string): Promise<Incident | undefined> {
    return this.#cache.get<Incident>(incidentKey(sessionId, signature));
  }

  async save(incident: Incident): Promise<void> {
    const key = incidentKey(incident.session_id, incident.signature);
    // Checked before the write, so the index grows once per signature. Two
    // concurrent first-saves can both see "absent" and both append; `list`
    // de-duplicates, and the alternative is the read-modify-write the codebase
    // forbids adding to. Same trade, and the same reasoning, as
    // `FlowRepository#saveBinding`.
    const known = await this.#cache.has(key);

    await this.#cache.set(key, incident, this.#ttl);

    if (!known) {
      await this.#cache.listAppend(
        sessionIncidentsKey(incident.session_id),
        incident.signature,
        { ttlMs: this.#ttl, maxLength: INCIDENT_INDEX_LIMIT },
      );
    }
  }

  /**
   * Count this sighting and answer the running total, in one indivisible step.
   *
   * Separate from the incident body because it is the one field two genuinely
   * concurrent failures both touch — the participant NACKing twice while
   * auto-advance retries is not exotic — and a counter that loses updates
   * understates exactly the failures that matter most.
   */
  countOccurrence(sessionId: string, signature: string): Promise<number> {
    return this.#cache.increment(
      incidentCountKey(sessionId, signature),
      this.#ttl,
    );
  }

  /** Every incident in a session, oldest first, de-duplicated. */
  async list(sessionId: string): Promise<Incident[]> {
    const signatures = await this.#cache.listRange<string>(
      sessionIncidentsKey(sessionId),
    );

    const seen = new Set<string>();
    const incidents: Incident[] = [];
    for (const signature of signatures) {
      if (seen.has(signature)) continue;
      seen.add(signature);
      const incident = await this.find(sessionId, signature);
      if (incident) incidents.push(incident);
    }
    return incidents;
  }
}
