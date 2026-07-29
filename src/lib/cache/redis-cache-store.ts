import { Redis } from "ioredis";
import type { RedisOptions } from "ioredis";
import type { Logger } from "pino";
import type {
  CacheStore,
  ListAppendOptions,
} from "@/lib/cache/cache-store.js";
import { UpstreamError } from "@/lib/errors.js";

/**
 * The `CacheStore` that survives a restart.
 *
 * This is the second implementation the port was written for, and it holds the
 * state a mock NP genuinely cannot recompute: sessions, transaction records,
 * stored payloads, business data, expectations. The flow catalog deliberately
 * does *not* come here — see the comment in `createContainer`.
 *
 * Redis does the two hard parts of the contract for free: `PX` gives per-entry
 * TTL set at write time, and an expired key is simply a missing key, so
 * "expired is indistinguishable from absent" is not something this class has to
 * enforce. What it does have to get right is failure.
 *
 * ## Reads throw. They do not return `undefined`.
 *
 * This is the most consequential decision in the file, and it runs against the
 * grain of a cache. Returning `undefined` when Redis is unreachable would be
 * legal under the port's contract and catastrophic in practice:
 * `SessionService.requireSession` turns `undefined` into a `NotFoundError`
 * whose message tells the model *"Sessions expire. Call session_create to start
 * a new one."* — so a thirty-second Redis blip would end with the model opening
 * a second transaction against a real participant's wire. An outage has to look
 * like an outage. `UpstreamError` is the same channel `mock-engine` already
 * uses for a dependency that broke.
 *
 * `ping()` is the one exception: it is the readiness probe, so it answers
 * `false` rather than throwing.
 *
 * ## Nothing here may block boot, and nothing may hold the loop open
 *
 * `createContainer` is awaited during startup, so the client connects lazily —
 * a Redis that is down degrades `/ready`, it does not stop the process from
 * listening. And every command carries a hard timeout, because the inbound
 * receiver reads state *inside the ACK window*: a hung command would hold the
 * participant's connection open for as long as Redis stayed dead.
 */

/**
 * The slice of a Redis client this store uses.
 *
 * ioredis's `Redis` satisfies it structurally, which is the point: the real
 * client is assigned to a field of this type, so the compiler checks the shape,
 * while a test fake only has to implement six commands and an event emitter.
 * If a future ioredis release stops matching, widen this interface to match the
 * library — never paper over it with a cast, which is the one thing that could
 * make the fake and the real client disagree.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  /** Opens a transaction. The append family's atomicity rests on this. */
  multi(): RedisPipelineLike;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
  disconnect(): void;
  connect(): Promise<void>;
  on(event: "error", handler: (error: Error) => void): unknown;
  on(event: "ready" | "end", handler: () => void): unknown;
}

/**
 * The queued half of a `MULTI`.
 *
 * Only the four commands the append family needs, for the same reason
 * `RedisLike` carries only six: a test fake should be implementable in a dozen
 * lines. Methods return the interface rather than `this` so ioredis's
 * `ChainableCommander` — whose methods return `ChainableCommander` — satisfies
 * it structurally.
 */
export interface RedisPipelineLike {
  incrby(key: string, increment: number): RedisPipelineLike;
  pexpire(key: string, ttlMs: number): RedisPipelineLike;
  rpush(key: string, ...values: string[]): RedisPipelineLike;
  ltrim(key: string, start: number, stop: number): RedisPipelineLike;
  /**
   * `null` when the transaction was discarded; otherwise one
   * `[error, result]` pair per queued command — a failure inside a `MULTI` is
   * reported per command rather than thrown, which is why `#exec` inspects
   * every pair instead of trusting the call to have rejected.
   */
  exec(): Promise<[Error | null, unknown][] | null>;
}

export interface RedisCacheStoreOptions {
  /** `redis://` or `rediss://`. TLS is selected by the scheme. */
  url: string;
  logger: Logger;
  /**
   * Prepended to every key with `::`. Defaults to none, which writes the
   * workbench's literal key layout.
   */
  keyPrefix?: string;
  /** Hard ceiling on a single command. Defaults to 1.5s. */
  commandTimeoutMs?: number;
  /** Injected by tests. Defaults to a real client built from `url`. */
  client?: RedisLike;
}

export class RedisCacheStore implements CacheStore {
  readonly #client: RedisLike;
  readonly #logger: Logger;
  readonly #prefix: string;
  #healthy = true;
  #closed = false;

  constructor(options: RedisCacheStoreOptions) {
    this.#logger = options.logger;
    this.#prefix = options.keyPrefix ?? "";

    const commandTimeout = options.commandTimeoutMs ?? 1_500;

    this.#client =
      options.client ??
      new Redis(options.url, {
        // Boot must not wait on a socket. `createContainer` is awaited at
        // startup, so a dial here would mean a Redis that is merely slow
        // delays the server from listening at all.
        lazyConnect: true,
        connectTimeout: 5_000,
        // The ceiling on any single command, applied before the command is
        // even queued — so it bounds a command issued against a dead
        // connection, not just one already in flight. This is what keeps a
        // broken Redis out of the ACK window.
        commandTimeout,
        // Default is 20: a command would ride twenty reconnect cycles before
        // failing. Fail the command quickly and let the caller see it; the
        // connection keeps retrying underneath.
        maxRetriesPerRequest: 2,
        // Commands issued while the first connection is still being
        // established wait rather than throwing. `commandTimeout` bounds it.
        enableOfflineQueue: true,
        retryStrategy: (times: number) => Math.min(times * 200, 5_000),
      } satisfies RedisOptions);

    // ioredis reports connection failures as an EventEmitter `error`. With no
    // listener attached Node re-throws it as an unhandled 'error' event and
    // kills the process — so an unreachable Redis would take down the very
    // server that is supposed to degrade gracefully. This handler is
    // load-bearing, not diagnostics.
    this.#client.on("error", (error: Error) => {
      if (this.#closed) return; // teardown noise
      if (!this.#healthy) return; // already reported; do not flood the log
      this.#healthy = false;
      this.#logger.warn(
        { err: error },
        "redis connection lost; /ready will report the state store down",
      );
    });

    this.#client.on("ready", () => {
      if (!this.#healthy) this.#logger.info("redis connection restored");
      this.#healthy = true;
    });

    // Warm the connection without blocking boot, so the first `/ready` probe
    // tells the truth and a misconfigured URL surfaces immediately rather than
    // on the first tool call. Failures arrive at the handler above.
    void this.#client.connect().catch(() => {
      /* reported by the error handler */
    });
  }

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.#run("get", key, () =>
      this.#client.get(this.#k(key)),
    );
    if (raw === null) return undefined;

    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      // A value we cannot read is a value that is not there. Deliberately not
      // a throw — one poisoned key must not break the loop — and deliberately
      // not a delete either, because the writer may be another process that
      // knows something we do not.
      this.#logger.warn(
        { err: error, key },
        "unparseable value in redis; treating as absent",
      );
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const serialized = JSON.stringify(value);

    // `SET … PX 0` is an error in Redis, and `JSON.stringify(undefined)`
    // returns `undefined` rather than a string. Under this port both mean the
    // same thing — an entry that should not exist — so both become a delete
    // rather than a failure.
    if (ttlMs <= 0 || serialized === undefined) {
      await this.delete(key);
      return;
    }

    // `PX` takes an integer; nothing in the port stops a caller deriving a
    // fractional TTL from two timestamps.
    await this.#run("set", key, () =>
      this.#client.set(this.#k(key), serialized, "PX", Math.ceil(ttlMs)),
    );
  }

  async delete(key: string): Promise<void> {
    await this.#run("delete", key, () => this.#client.del(this.#k(key)));
  }

  async has(key: string): Promise<boolean> {
    // `EXISTS`, not `get() !== undefined`. This is the one place the port is
    // cheaper over a socket than in memory, and answering a boolean by pulling
    // a stored payload across the wire would throw that away.
    const count = await this.#run("has", key, () =>
      this.#client.exists(this.#k(key)),
    );
    return count > 0;
  }

  /*
   * The append family.
   *
   * Each is one `MULTI`, so the mutation and the expiry that bounds it either
   * both land or neither does. Written as separate commands rather than a Lua
   * script deliberately: `INCRBY`/`RPUSH`/`LTRIM`/`PEXPIRE` are what a
   * developer will see in `MONITOR` while debugging, and a script would trade
   * that for nothing — a transaction is already atomic.
   */

  async increment(key: string, ttlMs: number, by = 1): Promise<number> {
    // Property 4: a caller deriving this from a deadline already past means
    // "gone". The value it would have had still comes back, since nothing
    // survives the call to disagree.
    if (ttlMs <= 0) {
      await this.delete(key);
      return by;
    }

    const replies = await this.#exec("increment", key, (multi) =>
      multi.incrby(this.#k(key), by).pexpire(this.#k(key), Math.ceil(ttlMs)),
    );

    const value = replies[0];
    if (typeof value !== "number") {
      throw new UpstreamError(
        "redis",
        `state store increment for "${key}" answered ${typeof value}, not a number`,
        { key, operation: "increment" },
      );
    }
    return value;
  }

  async listAppend<T>(
    key: string,
    value: T,
    options: ListAppendOptions,
  ): Promise<void> {
    const serialized = JSON.stringify(value);
    // `JSON.stringify(undefined)` is `undefined`, and an entry that cannot be
    // written is not an entry. Appending "undefined" would poison every later
    // read of the list.
    if (serialized === undefined) return;

    if (options.ttlMs <= 0) {
      await this.delete(key);
      return;
    }

    await this.#exec("listAppend", key, (multi) => {
      let queued = multi.rpush(this.#k(key), serialized);
      if (options.maxLength !== undefined) {
        // Keep the newest `maxLength`. Negative indices count from the tail, so
        // this is "drop everything before the last N" without knowing the length.
        queued = queued.ltrim(this.#k(key), -options.maxLength, -1);
      }
      return queued.pexpire(this.#k(key), Math.ceil(options.ttlMs));
    });
  }

  async listRange<T>(key: string, start = 0, end = -1): Promise<T[]> {
    const raw = await this.#run("listRange", key, () =>
      this.#client.lrange(this.#k(key), start, end),
    );

    const parsed: T[] = [];
    for (const entry of raw) {
      try {
        parsed.push(JSON.parse(entry) as T);
      } catch (error) {
        // Same rule as `get`: a value we cannot read is a value that is not
        // there. Dropping one entry beats failing the read of every other.
        this.#logger.warn(
          { err: error, key },
          "unparseable list entry in redis; skipping it",
        );
      }
    }
    return parsed;
  }

  async ping(): Promise<boolean> {
    try {
      const reply = await this.#client.ping();
      this.#healthy = reply === "PONG";
      return this.#healthy;
    } catch {
      // The probe never throws — `/ready` wants a verdict, and a thrown error
      // here would be reported as the health check itself being broken.
      this.#healthy = false;
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    try {
      // `quit` waits for a reply. On a client that never connected ioredis
      // short-circuits it, but on one whose server just vanished it can hang
      // until the socket times out, so it races a timer.
      await Promise.race([
        this.#client.quit(),
        new Promise<void>((resolve) => {
          setTimeout(resolve, 1_000).unref();
        }),
      ]);
    } catch {
      // Already down. The disconnect below is the part that matters.
    }

    // Unconditional, and outside the try: `disconnect` is what clears the
    // reconnect timer, and a live reconnect timer is a process that never
    // exits — which on stdio is a client hanging forever on shutdown.
    this.#client.disconnect();
  }

  /** Build the stored key. */
  #k(key: string): string {
    return this.#prefix === "" ? key : `${this.#prefix}::${key}`;
  }

  /**
   * Run one command, turning a dependency failure into an `UpstreamError`.
   *
   * Prefixing is done here rather than through ioredis's own `keyPrefix`
   * option on purpose. That option only rewrites arguments the command table
   * marks as keys, so a `SCAN MATCH` pattern silently escapes it — and the key
   * this code builds should be the key a developer finds when they type
   * `redis-cli GET` during a debugging session.
   */
  async #run<R>(
    operation: string,
    key: string,
    call: () => Promise<R>,
  ): Promise<R> {
    try {
      return await call();
    } catch (error) {
      this.#healthy = false;
      const reason = error instanceof Error ? error.message : String(error);
      throw new UpstreamError(
        "redis",
        `state store ${operation} failed for "${key}": ${reason}`,
        { key, operation },
      );
    }
  }

  /**
   * Run one `MULTI`, and treat a per-command failure as a failure.
   *
   * `EXEC` resolves rather than rejecting when a queued command fails — a
   * `WRONGTYPE` on the `RPUSH` arrives as an `Error` sitting in the results
   * array, and an unchecked call would report a silent no-op as a successful
   * append. `null` means the transaction was discarded entirely.
   */
  async #exec(
    operation: string,
    key: string,
    queue: (multi: RedisPipelineLike) => RedisPipelineLike,
  ): Promise<unknown[]> {
    const replies = await this.#run(operation, key, () =>
      queue(this.#client.multi()).exec(),
    );

    if (replies === null) {
      this.#healthy = false;
      throw new UpstreamError(
        "redis",
        `state store ${operation} for "${key}" was discarded before it ran`,
        { key, operation },
      );
    }

    return replies.map(([error, value]) => {
      if (error) {
        this.#healthy = false;
        throw new UpstreamError(
          "redis",
          `state store ${operation} failed for "${key}": ${error.message}`,
          { key, operation },
        );
      }
      return value;
    });
  }
}
