import type { Logger } from "pino";
import { request, type Dispatcher } from "undici";
import type { Metrics } from "@/lib/metrics/metrics.js";
import {
  MIRROR_SCHEMA_VERSION,
  type MirrorBatch,
  type MirrorRecord,
} from "@/modules/mirror/mirror.schema.js";

/**
 * Where a mirror record goes.
 *
 * ## `emit` is synchronous and returns `void`, and that is the design
 *
 * `FeedbackSink.deliver` returns a `Promise` because its only caller is
 * `FeedbackService#flush`, which is already off the hot path and can await it.
 * `emit` is called **on** the hot path — from inside the journal tap, which
 * runs after the ACK is decided but still inside the receiver's handler, and
 * from `SessionService.createSession`. A promise there has exactly two
 * possible fates: a floating `void` that nobody can observe failing, or a
 * second `#inFlight` set duplicating the one `FeedbackService` already
 * maintains. Neither is worth it for telemetry.
 *
 * So the type states the discipline: **an implementation has nowhere to put a
 * rejection, therefore it must not produce one.** Queue and return.
 */
export interface MirrorSink {
  /** Synchronous and `void` on purpose: callers are inside the ACK window and
   *  have nowhere to put a rejection. The type enforces the discipline. */
  emit(record: MirrorRecord): void;
  close(): Promise<void>;
  /**
   * Records queued and not yet sent, for `ondc_mirror_queue_depth`.
   *
   * Optional because a sink with no queue has no depth — `NoopMirrorSink`
   * answers nothing rather than a misleading zero.
   */
  depth?(): number;
}

/**
 * The sink used when mirroring is off, and in every test.
 *
 * Mirrors `NoopSink`: records are **retained** rather than discarded, so a test
 * can assert on the exact sequence that would have gone out. Bounded by the
 * length of one test's run, not by traffic.
 */
export class NoopMirrorSink implements MirrorSink {
  readonly emitted: MirrorRecord[] = [];

  emit(record: MirrorRecord): void {
    this.emitted.push(record);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export interface BufferedHttpMirrorSinkOptions {
  endpoint: string;
  apiKey?: string | undefined;
  timeoutMs: number;
  flushIntervalMs: number;
  batchSize: number;
  queueMax: number;
  instanceId: string;
  /** The process-wide undici agent. A `MockAgent` in tests. */
  dispatcher?: Dispatcher | undefined;
  logger: Logger;
  metrics?: Metrics | undefined;
}

/**
 * Batch records and POST them, without ever letting that cost a protocol call.
 *
 * Six properties, each of which is a specific way this could go wrong:
 *
 * 1. **The queue is bounded and drops the oldest.** Under pressure something
 *    must be lost; the newest records are the ones a live view actually wants.
 *    The count of drops rides the next batch as `dropped_since_last_batch`, so
 *    a gap in the corpus says so rather than looking like a step that never
 *    happened.
 * 2. **The flush interval is `unref`'d.** An un-unref'd `setInterval` keeps a
 *    stdio process alive after the client has disconnected — the process simply
 *    never exits, and the existing stdio test would not catch it because it
 *    asserts on *output*, not on shutdown.
 * 3. **A size-triggered flush is scheduled with `setImmediate`, never run
 *    inline.** `emit` is called from the journal tap; doing I/O there would put
 *    a network call inside the very window the tap exists to stay out of.
 * 4. **One POST in flight at a time.** The dispatcher is the process-wide agent
 *    that protocol calls also use. Concurrent posts to a slow sibling open
 *    unbounded connections through it and starve the path that matters, which
 *    is the failure mode where telemetry takes down the thing it was watching.
 * 5. **A refused batch is re-queued at the head only if it fits.** Re-queueing
 *    unconditionally while more records arrive is a memory leak with a network
 *    interface — the queue grows by exactly the retry every cycle and never
 *    shrinks, because the endpoint that refused the first batch refuses the
 *    second.
 * 6. **The body is always drained.** Same reason as `HttpSink`: undici holds
 *    the connection until it is, and a leaked one costs a slot in the pool
 *    protocol calls are using.
 */
export class BufferedHttpMirrorSink implements MirrorSink {
  readonly #endpoint: string;
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;
  readonly #batchSize: number;
  readonly #queueMax: number;
  readonly #instanceId: string;
  readonly #dispatcher: Dispatcher | undefined;
  readonly #logger: Logger;
  readonly #metrics: Metrics | undefined;

  readonly #queue: MirrorRecord[] = [];
  #dropped = 0;
  #sending = false;
  #closed = false;
  #scheduled = false;
  readonly #timer: ReturnType<typeof setInterval>;

  constructor(options: BufferedHttpMirrorSinkOptions) {
    this.#endpoint = options.endpoint;
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs;
    this.#batchSize = options.batchSize;
    this.#queueMax = options.queueMax;
    this.#instanceId = options.instanceId;
    this.#dispatcher = options.dispatcher;
    this.#logger = options.logger;
    this.#metrics = options.metrics;

    this.#timer = setInterval(() => {
      void this.flush();
    }, options.flushIntervalMs);
    // Property 2. Without this a stdio process holds the event loop open for
    // as long as the interval exists, which is forever.
    this.#timer.unref();
  }

  emit(record: MirrorRecord): void {
    if (this.#closed) return;

    if (this.#queue.length >= this.#queueMax) {
      // Oldest first: a live view wants the newest. Counted so the gap is
      // visible in the corpus rather than inferred from a hole in the seqs.
      this.#queue.shift();
      this.#dropped += 1;
      this.#metrics?.mirrorRecords.inc({ outcome: "dropped" });
    }

    this.#queue.push(record);
    this.#metrics?.mirrorRecords.inc({ outcome: "queued" });

    // Property 3. Scheduled, never inline: `emit`'s caller is on the hot path.
    if (this.#queue.length >= this.#batchSize && !this.#scheduled) {
      this.#scheduled = true;
      setImmediate(() => {
        this.#scheduled = false;
        void this.flush();
      });
    }
  }

  depth(): number {
    return this.#queue.length;
  }

  /** Send one batch, if there is one and nothing else is in flight. */
  async flush(): Promise<void> {
    // Property 4. Returning rather than queueing a second post: the next timer
    // tick is milliseconds away and will pick up whatever accumulated.
    if (this.#sending || this.#queue.length === 0) return;
    this.#sending = true;

    const batch = this.#queue.splice(0, this.#batchSize);
    const dropped = this.#dropped;
    this.#dropped = 0;

    try {
      const sent = await this.#post(batch, dropped);
      if (sent) {
        this.#metrics?.mirrorRecords.inc(
          { outcome: "sent" },
          batch.length,
        );
        return;
      }

      // Property 5. Head, so ordering survives a retry — and only if it fits,
      // because a refused endpoint stays refused and the alternative grows the
      // queue by one batch per cycle forever.
      if (this.#queue.length + batch.length <= this.#queueMax) {
        this.#queue.unshift(...batch);
        this.#dropped += dropped;
      } else {
        this.#dropped += dropped + batch.length;
        this.#metrics?.mirrorRecords.inc(
          { outcome: "dropped" },
          batch.length,
        );
      }
    } finally {
      this.#sending = false;
    }
  }

  /**
   * Stop the timer, push what is left, resolve.
   *
   * **Never rejects**, and bounded: one flush, not a drain loop. A shutdown
   * that hangs waiting for an unreachable mirror is a worse outcome than a
   * handful of lost records, and `dispose()` is on the path a `SIGTERM` takes.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    try {
      await this.flush();
    } catch (error) {
      this.#logger.warn({ err: error }, "the mirror's final flush failed");
    }
  }

  async #post(
    records: readonly MirrorRecord[],
    dropped: number,
  ): Promise<boolean> {
    const batch: MirrorBatch = {
      schema_version: MIRROR_SCHEMA_VERSION,
      instance_id: this.#instanceId,
      sent_at: new Date().toISOString(),
      dropped_since_last_batch: dropped,
      records: [...records],
    };

    try {
      const response = await request(this.#endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.#apiKey !== undefined
            ? { authorization: `Bearer ${this.#apiKey}` }
            : {}),
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(this.#timeoutMs),
        ...(this.#dispatcher ? { dispatcher: this.#dispatcher } : {}),
      });

      // Property 6. Drained regardless of status.
      await response.body.text().catch(() => undefined);

      if (response.statusCode >= 200 && response.statusCode < 300) return true;

      this.#logger.warn(
        { status: response.statusCode, endpoint: this.#endpoint },
        "the mirror ingest refused a batch; it will be retried",
      );
      this.#metrics?.mirrorRecords.inc({ outcome: "refused" }, records.length);
      return false;
    } catch (error) {
      this.#logger.warn(
        { err: error, endpoint: this.#endpoint },
        "could not reach the mirror ingest; the batch will be retried",
      );
      this.#metrics?.mirrorRecords.inc({ outcome: "refused" }, records.length);
      return false;
    }
  }
}
