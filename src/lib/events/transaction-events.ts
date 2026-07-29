/**
 * The wake-up primitive behind `flow_await`.
 *
 * The model drives the loop by alternating "do the next thing" with "wait until
 * the participant does the next thing". Without this, waiting means polling
 * `flow_get_status` on a timer — which either burns context or misses the
 * callback by seconds.
 *
 * ## Why this is not a message bus
 *
 * Events are a **hint that something changed**, never the change itself. The
 * change is already durable in the transaction record before `notify` fires, and
 * every waiter is keyed on a monotonically increasing `seq` that also lives in
 * that record. So a waiter that arrives late, or misses a notification
 * entirely, still sees the work by reading the store — `flow_await` reads the
 * record *first* and only registers a waiter if there is genuinely nothing new.
 * That ordering is what makes the wait race-proof.
 *
 * ## Scope
 *
 * In-process, like the default `CacheStore`. Two replicas do not share waiters,
 * exactly as two replicas do not share sessions today; a Redis `CacheStore`
 * would come with pub/sub behind this same interface.
 */

/**
 * What woke a waiter. Mirrors the kinds recorded on the transaction, plus one.
 *
 * `JOURNAL` is deliberately opaque: it says "the session's event journal grew"
 * and nothing else. A waiter on the session drains the journal from the store
 * when it wakes, so putting the entry's own kind here would be a second copy of
 * something already durable — and the first thing to go stale. It is the
 * clearest expression of this class's rule that an event is a *hint*, never the
 * change itself.
 */
export type TransactionEventKind =
  | "INBOUND"
  | "OUTBOUND"
  | "FORM_SUBMITTED"
  | "CHAIN_SENT"
  | "CHAIN_PAUSED"
  | "JOURNAL";

export interface TransactionEvent {
  /** Position in the transaction's entry list. Strictly increasing. */
  readonly seq: number;
  readonly kind: TransactionEventKind;
  /** Protocol action or form step key this event concerns. */
  readonly action?: string;
  /** Handle for the stored payload, when the event carries one. */
  readonly payload_id?: string;
  /** Free-form note — a NACK reason, a pause cause. */
  readonly detail?: string;
}

export interface WaitOptions {
  /** Only wake for events strictly newer than this. */
  afterSeq: number;
  timeoutMs: number;
}

interface Waiter {
  readonly afterSeq: number;
  readonly resolve: (event: TransactionEvent | undefined) => void;
  timer: NodeJS.Timeout;
}

export class TransactionEvents {
  readonly #waiters = new Map<string, Set<Waiter>>();

  /**
   * Wake every waiter interested in this event.
   *
   * Never throws and never awaits: it is called from the receiver **after** the
   * ACK has been written, and a failure to notify must not become a failure to
   * respond.
   */
  notify(key: string, event: TransactionEvent): void {
    const waiters = this.#waiters.get(key);
    if (!waiters) return;

    for (const waiter of [...waiters]) {
      if (event.seq <= waiter.afterSeq) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }

    if (waiters.size === 0) this.#waiters.delete(key);
  }

  /**
   * Block until an event newer than `afterSeq` arrives for `key`.
   *
   * Resolves `undefined` on timeout — a timeout is an ordinary outcome the
   * model long-polls through, not an error.
   */
  waitFor(
    key: string,
    options: WaitOptions,
  ): Promise<TransactionEvent | undefined> {
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(key) ?? new Set<Waiter>();
      this.#waiters.set(key, waiters);

      const waiter: Waiter = {
        afterSeq: options.afterSeq,
        resolve,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          if (waiters.size === 0) this.#waiters.delete(key);
          resolve(undefined);
        }, options.timeoutMs),
      };

      // A pending timer must never be the reason a stdio process refuses to exit.
      waiter.timer.unref?.();
      waiters.add(waiter);
    });
  }

  /** Waiters currently parked on `key`. Tests and diagnostics. */
  waiterCount(key: string): number {
    return this.#waiters.get(key)?.size ?? 0;
  }

  /** Release every waiter — they resolve as if timed out. Idempotent. */
  close(): void {
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(undefined);
      }
    }
    this.#waiters.clear();
  }
}
