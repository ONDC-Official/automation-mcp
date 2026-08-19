import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logger } from "@/lib/logger.js";
import {
  MIRROR_SCHEMA_VERSION,
  type MirrorBatch,
  type MirrorRecord,
} from "@/modules/mirror/mirror.schema.js";
import { BufferedHttpMirrorSink } from "@/modules/mirror/mirror.sink.js";

/**
 * The buffering, under the conditions that break it.
 *
 * Everything asserted here is a failure this sink is specifically shaped to
 * avoid, and every one of them would be invisible in a happy-path test: an
 * unbounded queue, concurrent posts starving the protocol path's connection
 * pool, a refused batch re-queued until the process runs out of memory, a final
 * flush that rejects out of `dispose()`.
 */

const ENDPOINT = "https://mirror.example.com";
const PATH = "/ingest";

let agent: MockAgent;
let sink: BufferedHttpMirrorSink | undefined;

/**
 * Read an intercepted request body.
 *
 * Narrowed rather than `String()`d: undici types `body` as a union wide enough
 * to include objects, and stringifying one of those gives `[object Object]` —
 * an assertion that then passes or fails for reasons unrelated to the payload.
 */
function bodyText(body: unknown): string {
  if (typeof body === "string") return body;
  throw new Error(`expected a string request body, got ${typeof body}`);
}

function readBatch(body: unknown): MirrorBatch {
  return JSON.parse(bodyText(body)) as MirrorBatch;
}

function record(seq: number): MirrorRecord {
  return {
    schema_version: MIRROR_SCHEMA_VERSION,
    emitted_at: "2026-08-17T09:00:00.000Z",
    install_id: "inst_x",
    instance_id: "proc_x",
    session_ref: "sess_x",
    kind: "JOURNAL",
    event: {
      seq,
      at: "2026-08-17T09:00:00.000Z",
      kind: "OUTBOUND_SENT",
      summary: `line ${String(seq)}`,
    },
  };
}

function build(
  overrides: Partial<
    ConstructorParameters<typeof BufferedHttpMirrorSink>[0]
  > = {},
): BufferedHttpMirrorSink {
  sink = new BufferedHttpMirrorSink({
    endpoint: `${ENDPOINT}${PATH}`,
    timeoutMs: 1_000,
    // Long enough that nothing in these tests flushes by timer — every flush
    // asserted below is one the test asked for, by size or by `close()`.
    flushIntervalMs: 60_000,
    batchSize: 3,
    queueMax: 5,
    instanceId: "proc_x",
    dispatcher: agent,
    logger: logger.child({ silent: true }),
    ...overrides,
  });
  return sink;
}

/** Let a `setImmediate`-scheduled flush and its POST run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
});

afterEach(async () => {
  await sink?.close();
  sink = undefined;
  await agent.close();
});

describe("BufferedHttpMirrorSink", () => {
  it("posts a batch once the queue reaches the batch size", async () => {
    const seen: MirrorBatch[] = [];
    agent
      .get(ENDPOINT)
      .intercept({ path: PATH, method: "POST" })
      .reply(202, (opts) => {
        seen.push(readBatch(opts.body));
        return "";
      });

    const s = build();
    s.emit(record(1));
    s.emit(record(2));
    // Two is below the batch size, so nothing has gone yet — the flush is a
    // consequence of the third, not of `emit` doing I/O.
    expect(seen).toHaveLength(0);
    s.emit(record(3));
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.records).toHaveLength(3);
    expect(seen[0]?.instance_id).toBe("proc_x");
    expect(seen[0]?.dropped_since_last_batch).toBe(0);
  });

  it("keeps one request in flight under a burst", async () => {
    let started = 0;
    let peak = 0;

    // Delayed on purpose: without it every POST completes before the next
    // begins and the test would pass against a sink with no guard at all.
    agent
      .get(ENDPOINT)
      .intercept({ path: PATH, method: "POST" })
      .reply(202, () => {
        started += 1;
        peak = Math.max(peak, started);
        return "";
      })
      .delay(30)
      .times(10);

    const s = build({ batchSize: 1, queueMax: 50 });
    for (let i = 0; i < 10; i++) s.emit(record(i));

    // Five concurrent flushes, the way a burst of emits plus a timer tick would
    // arrive. The property that matters: the shared undici agent is the same
    // pool protocol calls use, and concurrent posts to a slow sibling would
    // open connections through it without bound — telemetry starving the thing
    // it was watching.
    await Promise.all([
      s.flush(),
      s.flush(),
      s.flush(),
      s.flush(),
      s.flush(),
    ]);

    expect(peak).toBe(1);
    // Four of the five found a send already in flight and returned rather than
    // queueing behind it; the rest of the queue waits for the next tick.
    expect(s.depth()).toBe(9);
  });

  it("re-queues a refused batch and retries it on the next flush", async () => {
    const bodies: string[] = [];
    agent
      .get(ENDPOINT)
      .intercept({ path: PATH, method: "POST" })
      .reply(503, (opts) => {
        bodies.push(bodyText(opts.body));
        return "down";
      });
    agent
      .get(ENDPOINT)
      .intercept({ path: PATH, method: "POST" })
      .reply(202, (opts) => {
        bodies.push(bodyText(opts.body));
        return "";
      });

    const s = build();
    s.emit(record(1));
    s.emit(record(2));
    s.emit(record(3));
    await settle();

    expect(bodies).toHaveLength(1);
    // Nothing was lost: the refused batch is back at the head, in order.
    expect(s.depth()).toBe(3);

    await s.flush();
    expect(bodies).toHaveLength(2);
    expect(s.depth()).toBe(0);

    const retried = JSON.parse(bodies[1] ?? "{}") as MirrorBatch;
    expect(retried.records.map((entry) => entry.event?.seq)).toEqual([1, 2, 3]);
  });

  it("drops a refused batch rather than growing past the ceiling", async () => {
    agent
      .get(ENDPOINT)
      .intercept({ path: PATH, method: "POST" })
      .reply(503, "down")
      .times(5);

    // queueMax 5, batchSize 3: a refused batch of 3 cannot be put back on top
    // of a queue that has since filled. Re-queueing unconditionally here is a
    // memory leak with a network interface.
    const s = build();
    for (let i = 0; i < 3; i++) s.emit(record(i));
    await settle();
    expect(s.depth()).toBe(3);

    for (let i = 3; i < 8; i++) s.emit(record(i));
    await settle();

    expect(s.depth()).toBeLessThanOrEqual(5);
  });

  it("drops the oldest when the queue is full and says so on the next batch", async () => {
    const seen: MirrorBatch[] = [];
    agent
      .get(ENDPOINT)
      .intercept({ path: PATH, method: "POST" })
      .reply(202, (opts) => {
        seen.push(readBatch(opts.body));
        return "";
      })
      .times(5);

    // No timer, no size trigger: a queue that fills entirely before anything
    // is sent, which is what a slow or wedged ingest looks like.
    const s = build({ batchSize: 100, queueMax: 3 });
    for (let i = 1; i <= 6; i++) s.emit(record(i));

    expect(s.depth()).toBe(3);
    await s.flush();

    expect(seen).toHaveLength(1);
    // Newest kept, oldest gone — a live view wants the newest.
    expect(seen[0]?.records.map((entry) => entry.event?.seq)).toEqual([4, 5, 6]);
    // And the gap is *stated*. A consumer must be able to tell "the mock
    // skipped a step" from "the mirror dropped a record"; those are opposite
    // findings, and only one of them is about the participant.
    expect(seen[0]?.dropped_since_last_batch).toBe(3);
  });

  it("flushes on close and never rejects", async () => {
    const seen: MirrorBatch[] = [];
    agent
      .get(ENDPOINT)
      .intercept({ path: PATH, method: "POST" })
      .reply(202, (opts) => {
        seen.push(readBatch(opts.body));
        return "";
      });

    const s = build({ batchSize: 100 });
    s.emit(record(1));
    await expect(s.close()).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);

    // Idempotent, and emitting after close is a no-op rather than a throw:
    // `dispose()` races anything still finishing.
    await expect(s.close()).resolves.toBeUndefined();
    s.emit(record(2));
    expect(s.depth()).toBe(0);
  });

  it("never throws out of emit when the endpoint is unreachable", async () => {
    agent
      .get(ENDPOINT)
      .intercept({ path: PATH, method: "POST" })
      .replyWithError(new Error("connect ECONNREFUSED"))
      .times(3);

    const s = build();
    // `emit` is called from inside the ACK window. A throw here would become a
    // 500 the participant records as our non-compliance — telemetry failing a
    // protocol call is the one outcome this module must make impossible.
    expect(() => {
      s.emit(record(1));
      s.emit(record(2));
      s.emit(record(3));
    }).not.toThrow();

    await settle();
    await expect(s.flush()).resolves.toBeUndefined();
  });
});
