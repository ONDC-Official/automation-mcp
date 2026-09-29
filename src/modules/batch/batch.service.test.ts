import { MockAgent } from "undici";
import { InMemoryCacheStore } from "@/lib/cache/in-memory-cache-store.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHttpApp, type App } from "@/app.js";
import { parseConfig } from "@/config/env.js";
import { createContainer, type Container } from "@/container.js";
import { NotFoundError } from "@/lib/errors.js";
import {
  createFakeConfigServiceGateway,
  createFakeValidationGateway,
} from "@/test/fakes.js";
import {
  acceptsAction,
  acceptsActionAndCallsBack,
  requestJson,
} from "@/test/mock-participant.js";
import { advertisedUri } from "@/modules/session/session.service.js";
import type { BatchPeer } from "@/modules/batch/batch.peer.js";
import {
  BatchService,
  BatchRepository,
} from "@/modules/batch/batch.service.js";
import {
  BATCH_FIXTURE_BUILD,
  BATCH_FIXTURE_FLOW_ID,
} from "@/modules/batch/batch.test-fixture.js";
import type { GetBatchRunStatusOutput } from "@/modules/batch/batch.schema.js";

/**
 * `BatchService`'s own mechanics — the pool, the progress bookkeeping and
 * cancellation — as opposed to `batch.driver.test.ts`, which proves one
 * virtual transaction end to end.
 *
 * Every transaction here is driven against the batch fixture build with only
 * `search` accepted and never answered, so **every** transaction settles on
 * its own `per_transaction_timeout_ms` deterministically — the point is never
 * whether a transaction completes, only how the pool schedules and counts
 * them. Kept short (low tens of ms) so the suite stays fast.
 */

const NP = "https://np.example.com";
const config = parseConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });

let app: App;
let container: Container;
let agent: MockAgent;

beforeEach(async () => {
  agent = new MockAgent();
  agent.disableNetConnect();
  container = await createContainer(config, {
    configServiceGateway: createFakeConfigServiceGateway(),
    validationGateway: createFakeValidationGateway(),
    senderDispatcher: agent,
  });
  app = await buildHttpApp(container, config);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await container.dispose();
});

async function waitUntilDone(
  batchId: string,
  timeoutMs: number,
): Promise<GetBatchRunStatusOutput> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await container.services.batch.status(batchId, {
      includeResults: false,
      sinceIndex: 0,
      limit: 1,
    });
    if (status.state !== "running") return status;
    if (Date.now() >= deadline) {
      throw new Error(
        `batch ${batchId} did not finish within ${String(timeoutMs)}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function baseInput(
  overrides: Partial<
    Parameters<typeof container.services.batch.startRun>[0]
  > = {},
) {
  return {
    role: "initiator" as const,
    domain: BATCH_FIXTURE_BUILD.domain,
    version: BATCH_FIXTURE_BUILD.version,
    usecase: BATCH_FIXTURE_BUILD.usecase,
    flow_id: BATCH_FIXTURE_FLOW_ID,
    counterparty_subscriber_url: NP,
    transaction_count: 4,
    concurrency: 2,
    per_transaction_timeout_ms: 150,
    ...overrides,
  };
}

describe("BatchService.startRun", () => {
  it("returns immediately, before any virtual transaction has settled", async () => {
    acceptsAction(agent, NP, "search");

    const started = await container.services.batch.startRun(baseInput());

    expect(started.batch_id.length).toBeGreaterThan(0);
    expect(started.transaction_count).toBe(4);
    expect(started.concurrency).toBe(2);

    // The driver needs at least one real timer tick (per_transaction_timeout_ms)
    // to settle even its first transaction, so immediately after startRun
    // resolves the batch must still be running.
    const status = await container.services.batch.status(started.batch_id, {
      includeResults: false,
      sinceIndex: 0,
      limit: 1,
    });
    expect(status.state).toBe("running");

    await waitUntilDone(started.batch_id, 5_000);
  });
});

describe("BatchService pool + progress", () => {
  it("never runs more than `concurrency` transactions at once", async () => {
    acceptsAction(agent, NP, "search");

    const started = await container.services.batch.startRun(
      baseInput({
        transaction_count: 6,
        concurrency: 2,
        per_transaction_timeout_ms: 200,
      }),
    );

    // Sample progress repeatedly while the run is still in flight; the pool
    // must never exceed its own `concurrency` slot count.
    let sawInFlight = false;
    const sampleDeadline = Date.now() + 1_500;
    while (Date.now() < sampleDeadline) {
      const status = await container.services.batch.status(started.batch_id, {
        includeResults: false,
        sinceIndex: 0,
        limit: 1,
      });
      expect(status.progress.in_flight).toBeLessThanOrEqual(2);
      if (status.progress.in_flight > 0) sawInFlight = true;
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(sawInFlight).toBe(true);

    const finalStatus = await waitUntilDone(started.batch_id, 5_000);
    expect(finalStatus.progress.timed_out).toBe(6);
    expect(finalStatus.progress.queued).toBe(0);
    expect(finalStatus.progress.in_flight).toBe(0);
  });

  it("every transaction settles as timed_out when the counterparty never answers, and results paginate", async () => {
    acceptsAction(agent, NP, "search");

    const started = await container.services.batch.startRun(
      baseInput({ transaction_count: 5, concurrency: 3 }),
    );
    await waitUntilDone(started.batch_id, 5_000);

    const page1 = await container.services.batch.status(started.batch_id, {
      includeResults: true,
      sinceIndex: 0,
      limit: 2,
    });
    expect(page1.results).toHaveLength(2);
    expect(page1.results_total).toBe(5);
    for (const result of page1.results ?? []) {
      expect(result.status).toBe("timed_out");
      expect(result.inputs).toBeDefined();
      // A timeout still says which order to go and look at.
      expect(result.session_id).toBeDefined();
      expect(result.transaction_id).not.toBeNull();
    }

    const page2 = await container.services.batch.status(started.batch_id, {
      includeResults: true,
      sinceIndex: 2,
      limit: 100,
    });
    expect(page2.results).toHaveLength(3);
  });
});

describe("BatchService.cancel", () => {
  it("stops issuing new transactions; in-flight ones still finish on their own", async () => {
    acceptsAction(agent, NP, "search");

    const started = await container.services.batch.startRun(
      baseInput({
        transaction_count: 50,
        concurrency: 2,
        per_transaction_timeout_ms: 300,
      }),
    );

    const cancelled = await container.services.batch.cancel(started.batch_id);
    expect(cancelled.state).toBe("cancelled");

    const immediately = await container.services.batch.status(
      started.batch_id,
      {
        includeResults: false,
        sinceIndex: 0,
        limit: 1,
      },
    );
    // `cancel` marks the run cancelled straight away, without waiting for the
    // in-flight pool slots to drain.
    expect(immediately.state).toBe("cancelled");

    const finalStatus = await waitUntilDone(started.batch_id, 5_000);
    expect(finalStatus.state).toBe("cancelled");
    // At most `concurrency` transactions were already in flight when
    // cancellation landed — the other 48 of 50 must never have started.
    const settled =
      finalStatus.progress.completed +
      finalStatus.progress.blocked +
      finalStatus.progress.nacked +
      finalStatus.progress.timed_out +
      finalStatus.progress.errored;
    expect(settled).toBeLessThanOrEqual(2);
  });

  it("rejects cancelling a batch id that was never started", async () => {
    await expect(
      container.services.batch.cancel("nope"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("BatchService.status", () => {
  it("rejects an unknown batch id", async () => {
    await expect(
      container.services.batch.status("nope", {
        includeResults: false,
        sinceIndex: 0,
        limit: 1,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("StartBatchRunInput limits", () => {
  it("refuses more than 1000 orders, or more than 1000 at once", async () => {
    const { StartBatchRunInput } =
      await import("@/modules/batch/batch.schema.js");
    const ok = { role: "initiator", counterparty_subscriber_url: NP };
    expect(
      StartBatchRunInput.safeParse({ ...ok, transaction_count: 1000 }).success,
    ).toBe(true);
    expect(
      StartBatchRunInput.safeParse({ ...ok, transaction_count: 1001 }).success,
    ).toBe(false);
    expect(
      StartBatchRunInput.safeParse({
        ...ok,
        transaction_count: 10,
        concurrency: 1001,
      }).success,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* role: "both" — one call drives the seller instance too                      */
/* -------------------------------------------------------------------------- */

const PEER = "https://peer.example.com";

function fakePeer(): BatchPeer & {
  started: Record<string, unknown>[];
  cancelled: string[];
} {
  const started: Record<string, unknown>[] = [];
  const cancelled: string[] = [];
  return {
    started,
    cancelled,
    receiverUrl: PEER,
    startListener(input) {
      started.push(input);
      return Promise.resolve({
        batch_id: "peer-batch-1",
        role: "listener",
        flow_id: "x",
        transaction_count: 1,
        concurrency: 1,
        accepted_at: new Date().toISOString(),
      });
    },
    status() {
      return Promise.resolve({
        batch_id: "peer-batch-1",
        state: "running",
        transaction_count: 1,
        concurrency: 1,
        progress: {
          queued: 0,
          in_flight: 2,
          completed: 0,
          blocked: 0,
          nacked: 0,
          timed_out: 0,
          errored: 0,
        },
        accepted_at: new Date().toISOString(),
      });
    },
    cancel(id) {
      cancelled.push(id);
      return Promise.resolve();
    },
  };
}

function bothService(peer?: BatchPeer): BatchService {
  return new BatchService({
    session: container.services.session,
    flow: container.services.flow,
    record: container.services.record,
    repository: new BatchRepository(
      new InMemoryCacheStore({ sweepIntervalMs: 0 }),
    ),
    logger: container.logger,
    receiverPublicUrl: container.receiverPublicUrl,
    catalog: container.services.catalog,
    armSettleMs: 0,
    ...(peer ? { peer } : {}),
  });
}

describe("role: both", () => {
  const both = {
    role: "both" as const,
    domain: BATCH_FIXTURE_BUILD.domain,
    version: BATCH_FIXTURE_BUILD.version,
    usecase: BATCH_FIXTURE_BUILD.usecase,
    flow_id: BATCH_FIXTURE_FLOW_ID,
    transaction_count: 2,
    concurrency: 2,
    per_transaction_timeout_ms: 300,
  };

  it("is refused, with the fix named, when no seller instance is configured", async () => {
    await expect(bothService().startRun(both)).rejects.toThrow(
      /BATCH_PEER_URL/,
    );
  });

  it("starts the seller first, pointed back at this instance, then drives the buyer at the seller", async () => {
    const peer = fakePeer();
    const service = bothService(peer);
    // The seller's advertised endpoint is `{peer}/{domain}/{version}/seller`,
    // and the buyer appends the action to it.
    const sellerPath = new URL(advertisedUri(PEER, BATCH_FIXTURE_BUILD, "BPP"))
      .pathname;
    const searchSeen: unknown[] = [];
    agent
      .get(PEER)
      .intercept({ path: `${sellerPath}/search`, method: "POST" })
      .reply(200, (options) => {
        searchSeen.push(options.body);
        return { message: { ack: { status: "ACK" } } };
      })
      .persist();

    const started = await service.startRun(both);

    expect(started.peer_batch_id).toBe("peer-batch-1");
    expect(peer.started).toHaveLength(1);
    expect(peer.started[0]?.["counterparty_subscriber_url"]).toBe(
      advertisedUri(container.receiverPublicUrl, BATCH_FIXTURE_BUILD, "BAP"),
    );

    // The buyer's own calls go to the seller's advertised endpoint.
    for (let i = 0; i < 60 && searchSeen.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(searchSeen.length).toBeGreaterThan(0);

    const status = await service.status(started.batch_id, {
      includeResults: false,
      sinceIndex: 0,
      limit: 1,
    });
    expect(status.peer?.batch_id).toBe("peer-batch-1");
    // The seller is still running, so the batch is not finished.
    expect(status.state).toBe("running");

    const cancelled = await service.cancel(started.batch_id);
    expect(cancelled.state).toBe("cancelled");
    expect(peer.cancelled).toEqual(["peer-batch-1"]);
    // Let the buyer's in-flight orders reach their own budget before teardown.
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  it("refuses an unknown build before touching the seller", async () => {
    const peer = fakePeer();
    await expect(
      bothService(peer).startRun({
        ...both,
        flow_id: undefined,
        version: "9.9.9",
      }),
    ).rejects.toThrow(/No default flow/);
    expect(peer.started).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* batch_run_order_log                                                         */
/* -------------------------------------------------------------------------- */

describe("orderLog", () => {
  it("returns every exchange of a finished order, both directions, with the ACKs", async () => {
    const receiverUrl = (action: string): string =>
      `${new URL(advertisedUri(container.receiverPublicUrl, BATCH_FIXTURE_BUILD, "BAP")).pathname}/${action}`;
    const reply = async (
      payload: Record<string, unknown>,
      action: string,
      message: unknown,
      extra: Record<string, unknown> = {},
    ) => {
      const ctx = (payload as { context: Record<string, string> }).context;
      await app.inject({
        method: "POST",
        url: receiverUrl(action),
        headers: { "content-type": "application/json" },
        payload: {
          context: {
            ...ctx,
            action,
            timestamp: new Date().toISOString(),
            ttl: "PT30S",
            ...extra,
          },
          message,
        },
      });
    };
    acceptsActionAndCallsBack(agent, NP, "search", (p) =>
      reply(
        p,
        "on_search",
        { catalog: { providers: [{ items: [{ id: "real-item-42" }] }] } },
        {
          bpp_id: new URL(NP).host,
          bpp_uri: NP,
        },
      ),
    );
    acceptsActionAndCallsBack(agent, NP, "select", (p) =>
      reply(p, "on_select", {
        order: {
          id: "order-1",
          status: "CREATED",
          payments: [{ status: "PAID" }],
        },
      }),
    );

    const started = await container.services.batch.startRun(
      baseInput({
        transaction_count: 1,
        concurrency: 1,
        per_transaction_timeout_ms: 15_000,
      }),
    );
    const done = await waitUntilDone(started.batch_id, 20_000);
    expect(done.progress.completed).toBe(1);

    const log = await container.services.batch.orderLog({
      batch_id: started.batch_id,
      index: 0,
      include_payloads: false,
      max_payload_bytes: 50_000,
    });

    expect(log.flow_status).toBe("COMPLETE");
    expect(log.steps.map((s) => s.action)).toEqual([
      "search",
      "on_search",
      "select",
      "on_select",
    ]);
    expect(log.steps.map((s) => s.direction)).toEqual([
      "sent",
      "received",
      "sent",
      "received",
    ]);
    expect(log.steps.every((s) => s.ack === "ACK")).toBe(true);
    expect(log.order).toMatchObject({
      order_id: "order-1",
      order_status: "CREATED",
      payment_status: "PAID",
    });
    expect(log.events.map((e) => e.kind)).toContain("OUTBOUND_SENT");
    expect(log.steps[0]?.payload).toBeUndefined();

    const full = await container.services.batch.orderLog({
      batch_id: started.batch_id,
      transaction_id: log.transaction_id,
      include_payloads: true,
      max_payload_bytes: 50_000,
    });
    expect(full.steps[1]?.payload).toBeDefined();
  });

  it("names what is missing", async () => {
    await expect(
      container.services.batch.orderLog({
        batch_id: "nope",
        index: 0,
        include_payloads: false,
        max_payload_bytes: 50_000,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const started = await container.services.batch.startRun(
      baseInput({ transaction_count: 1 }),
    );
    await expect(
      container.services.batch.orderLog({
        batch_id: started.batch_id,
        include_payloads: false,
        max_payload_bytes: 50_000,
      }),
    ).rejects.toThrow(/index/);
    acceptsAction(agent, NP, "search");
    await waitUntilDone(started.batch_id, 5_000);
  });
});

describe("batchPayloads", () => {
  async function twoOrders() {
    const receiverUrl = (action: string): string =>
      `${new URL(advertisedUri(container.receiverPublicUrl, BATCH_FIXTURE_BUILD, "BAP")).pathname}/${action}`;
    const reply = async (
      payload: Record<string, unknown>,
      action: string,
      message: unknown,
      extra: Record<string, unknown> = {},
    ) => {
      const ctx = (payload as { context: Record<string, string> }).context;
      await app.inject({
        method: "POST",
        url: receiverUrl(action),
        headers: { "content-type": "application/json" },
        payload: {
          context: {
            ...ctx,
            action,
            timestamp: new Date().toISOString(),
            ttl: "PT30S",
            ...extra,
          },
          message,
        },
      });
    };
    acceptsActionAndCallsBack(agent, NP, "search", (p) =>
      reply(
        p,
        "on_search",
        { catalog: { providers: [{ items: [{ id: "real-item-42" }] }] } },
        {
          bpp_id: new URL(NP).host,
          bpp_uri: NP,
        },
      ),
    );
    acceptsActionAndCallsBack(agent, NP, "select", (p) =>
      reply(p, "on_select", { order: { id: "order-1", status: "CREATED" } }),
    );
    const started = await container.services.batch.startRun(
      baseInput({
        transaction_count: 2,
        concurrency: 2,
        per_transaction_timeout_ms: 15_000,
      }),
    );
    const done = await waitUntilDone(started.batch_id, 20_000);
    expect(done.progress.completed).toBe(2);
    return started.batch_id;
  }

  it("returns one action's payload for every order, context and message", async () => {
    const batch_id = await twoOrders();
    const out = await container.services.batch.batchPayloads({
      batch_id,
      actions: ["on_select"],
      parts: "both",
      since_index: 0,
      limit: 10,
      max_payload_bytes: 100_000,
    });
    expect(out.orders_returned).toBe(2);
    expect(new Set(out.orders.map((o) => o.transaction_id)).size).toBe(2);
    for (const order of out.orders) {
      expect(order.payloads.map((p) => p.action)).toEqual(["on_select"]);
      expect(order.payloads[0]?.payload).toMatchObject({
        context: { action: "on_select", transaction_id: order.transaction_id },
        message: { order: { id: "order-1" } },
      });
    }
    expect(out.next_since_index).toBeUndefined();
  });

  it("returns the complete batch when no action is named, and can narrow to one part", async () => {
    const batch_id = await twoOrders();
    const all = await container.services.batch.batchPayloads({
      batch_id,
      parts: "message",
      since_index: 0,
      limit: 10,
      max_payload_bytes: 100_000,
    });
    for (const order of all.orders) {
      expect(order.payloads.map((p) => p.action)).toEqual([
        "search",
        "on_search",
        "select",
        "on_select",
      ]);
      expect(order.payloads[0]?.payload).not.toHaveProperty("context");
      expect(order.payloads[0]?.payload).toHaveProperty("intent");
    }
  });

  it("paginates over orders", async () => {
    const batch_id = await twoOrders();
    const first = await container.services.batch.batchPayloads({
      batch_id,
      actions: ["select"],
      parts: "both",
      since_index: 0,
      limit: 1,
      max_payload_bytes: 100_000,
    });
    expect(first.orders_returned).toBe(1);
    expect(first.next_since_index).toBe(1);
    const second = await container.services.batch.batchPayloads({
      batch_id,
      actions: ["select"],
      parts: "both",
      since_index: 1,
      limit: 1,
      max_payload_bytes: 100_000,
    });
    expect(second.orders_returned).toBe(1);
    expect(second.next_since_index).toBeUndefined();
    expect(second.orders[0]?.transaction_id).not.toBe(
      first.orders[0]?.transaction_id,
    );
  });

  it("rejects an unknown batch", async () => {
    await expect(
      container.services.batch.batchPayloads({
        batch_id: "nope",
        parts: "both",
        since_index: 0,
        limit: 10,
        max_payload_bytes: 100_000,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("listOrders", () => {
  async function twoOrdersWithAmount() {
    const receiverUrl = (action: string): string =>
      `${new URL(advertisedUri(container.receiverPublicUrl, BATCH_FIXTURE_BUILD, "BAP")).pathname}/${action}`;
    const reply = async (
      payload: Record<string, unknown>,
      action: string,
      message: unknown,
      extra: Record<string, unknown> = {},
    ) => {
      const ctx = (payload as { context: Record<string, string> }).context;
      await app.inject({
        method: "POST",
        url: receiverUrl(action),
        headers: { "content-type": "application/json" },
        payload: {
          context: {
            ...ctx,
            action,
            timestamp: new Date().toISOString(),
            ttl: "PT30S",
            ...extra,
          },
          message,
        },
      });
    };
    acceptsActionAndCallsBack(agent, NP, "search", (p) =>
      reply(
        p,
        "on_search",
        { catalog: { providers: [{ items: [{ id: "real-item-42" }] }] } },
        {
          bpp_id: new URL(NP).host,
          bpp_uri: NP,
        },
      ),
    );
    let orderIndex = 0;
    acceptsActionAndCallsBack(agent, NP, "select", (p) => {
      const id = `order-${String(orderIndex++)}`;
      return reply(p, "on_select", {
        order: {
          id,
          status: "CREATED",
          payments: [{ status: "PAID" }],
          quote: { price: { value: "180.00", currency: "INR" } },
        },
      });
    });
    const started = await container.services.batch.startRun(
      baseInput({
        transaction_count: 2,
        concurrency: 2,
        per_transaction_timeout_ms: 15_000,
      }),
    );
    const done = await waitUntilDone(started.batch_id, 20_000);
    expect(done.progress.completed).toBe(2);
    return started.batch_id;
  }

  it("lists every order's id and amount", async () => {
    const batch_id = await twoOrdersWithAmount();
    const out = await container.services.batch.listOrders({
      batch_id,
      since_index: 0,
      limit: 10,
    });
    expect(out.orders_returned).toBe(2);
    expect(out.results_total).toBe(2);
    expect(out.next_since_index).toBeUndefined();
    const ids = out.orders.map((o) => o.order_id).sort();
    expect(ids).toEqual(["order-0", "order-1"]);
    for (const order of out.orders) {
      expect(order.order_status).toBe("CREATED");
      expect(order.payment_status).toBe("PAID");
      expect(order.amount).toBe("180.00");
      expect(order.currency).toBe("INR");
      expect(order.batch_status).toBe("completed");
      expect(order.transaction_id).not.toBeNull();
    }
  });

  it("paginates over orders", async () => {
    const batch_id = await twoOrdersWithAmount();
    const first = await container.services.batch.listOrders({
      batch_id,
      since_index: 0,
      limit: 1,
    });
    expect(first.orders_returned).toBe(1);
    expect(first.next_since_index).toBe(1);
    const second = await container.services.batch.listOrders({
      batch_id,
      since_index: 1,
      limit: 1,
    });
    expect(second.orders_returned).toBe(1);
    expect(second.next_since_index).toBeUndefined();
    expect(second.orders[0]?.transaction_id).not.toBe(
      first.orders[0]?.transaction_id,
    );
  });

  it("reports a settled-but-not-completed order without an order id, and says why", async () => {
    acceptsAction(agent, NP, "search");
    const started = await container.services.batch.startRun(
      baseInput({
        transaction_count: 1,
        concurrency: 1,
        per_transaction_timeout_ms: 300,
      }),
    );
    await waitUntilDone(started.batch_id, 5_000);
    const out = await container.services.batch.listOrders({
      batch_id: started.batch_id,
      since_index: 0,
      limit: 10,
    });
    expect(out.orders).toHaveLength(1);
    expect(out.orders[0]?.order_id).toBeUndefined();
    expect(out.orders[0]?.batch_status).toBe("timed_out");
    expect(out.orders[0]?.message).toBeDefined();
  });

  it("rejects an unknown batch", async () => {
    await expect(
      container.services.batch.listOrders({
        batch_id: "nope",
        since_index: 0,
        limit: 10,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

/* -------------------------------------------------------------------------- */
/* who the orders are between: the bap and bpp inputs                         */
/* -------------------------------------------------------------------------- */

describe("buyer and seller identity", () => {
  const external = "https://their-seller.example.com/ONDC:FIS12/2.0.3/seller";
  const both = {
    role: "both" as const,
    domain: BATCH_FIXTURE_BUILD.domain,
    version: BATCH_FIXTURE_BUILD.version,
    usecase: BATCH_FIXTURE_BUILD.usecase,
    flow_id: BATCH_FIXTURE_FLOW_ID,
    transaction_count: 1,
    concurrency: 1,
    per_transaction_timeout_ms: 300,
  };

  it("bpp_uri runs the buyer against THAT seller and starts nothing on the seller instance", async () => {
    const peer = fakePeer();
    const service = bothService(peer);
    const seen: Record<string, unknown>[] = [];
    agent
      .get("https://their-seller.example.com")
      .intercept({ path: "/ONDC:FIS12/2.0.3/seller/search", method: "POST" })
      .reply(200, (options) => {
        seen.push(requestJson(options));
        return { message: { ack: { status: "ACK" } } };
      })
      .persist();

    const started = await service.startRun({
      ...both,
      bpp_uri: external,
      bpp_id: "their-seller.example.com",
      bap_id: "my-buyer.example.com",
    });

    expect(peer.started).toHaveLength(0);
    expect(started.peer_batch_id).toBeUndefined();
    expect(started.parties).toMatchObject({
      bap_id: "my-buyer.example.com",
      bpp_id: "their-seller.example.com",
      bpp_uri: external,
      seller: "external",
    });

    for (let i = 0; i < 60 && seen.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(seen.length).toBeGreaterThan(0);
    // The call carries the buyer identity that was asked for.
    const ctx = (seen[0] as { context: Record<string, string> }).context;
    expect(ctx["bap_id"]).toBe("my-buyer.example.com");

    await service.cancel(started.batch_id);
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  it("without bpp_uri the seller instance is used, and bap_id / bpp_id are handed to it", async () => {
    const peer = fakePeer();
    const service = bothService(peer);
    acceptsAction(agent, PEER, "search");
    const started = await service.startRun({
      ...both,
      bap_id: "buyer.x",
      bpp_id: "seller.x",
    });
    expect(started.parties?.seller).toBe("peer");
    expect(peer.started[0]).toMatchObject({
      bap_id: "buyer.x",
      bpp_id: "seller.x",
    });
    await service.cancel(started.batch_id);
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  it("refuses a bap_uri the receiver is not mounted at, saying what path it needs", async () => {
    await expect(
      bothService(fakePeer()).startRun({
        ...both,
        bap_uri: "https://me.example.com/somewhere/else",
      }),
    ).rejects.toThrow(/must end "\/ONDC:FIS12\/2.0.3\/buyer"/);
  });

  it("accepts a bap_uri on the mounted path and tells the seller to call back on it", async () => {
    const peer = fakePeer();
    const service = bothService(peer);
    acceptsAction(agent, PEER, "search");
    const started = await service.startRun({
      ...both,
      bap_uri: "https://me.example.com/ONDC:FIS12/2.0.3/buyer",
    });
    expect(peer.started[0]?.["counterparty_subscriber_url"]).toBe(
      "https://me.example.com/ONDC:FIS12/2.0.3/buyer",
    );
    await service.cancel(started.batch_id);
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
});

/* -------------------------------------------------------------------------- */
/* choosing a flow by version                                                  */
/* -------------------------------------------------------------------------- */

describe("flow selection", () => {
  const request = (flow_id: string) => ({
    role: "both" as const,
    domain: BATCH_FIXTURE_BUILD.domain,
    version: BATCH_FIXTURE_BUILD.version,
    usecase: BATCH_FIXTURE_BUILD.usecase,
    flow_id,
    transaction_count: 1,
    concurrency: 1,
    per_transaction_timeout_ms: 300,
  });

  it("runs the flow it is given, by id, and reports which one", async () => {
    const peer = fakePeer();
    acceptsAction(agent, PEER, "search");
    const started = await bothService(peer).startRun(
      request(BATCH_FIXTURE_FLOW_ID),
    );
    expect(started.flow_id).toBe(BATCH_FIXTURE_FLOW_ID);
    expect(peer.started[0]).toMatchObject({ flow_id: BATCH_FIXTURE_FLOW_ID });
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  it("names the flows that do exist when the flow_id is unknown, before starting the seller", async () => {
    const peer = fakePeer();
    await expect(
      bothService(peer).startRun(request("NO_SUCH_FLOW")),
    ).rejects.toThrow(/NO_SUCH_FLOW/);
    expect(peer.started).toHaveLength(0);
  });
});
