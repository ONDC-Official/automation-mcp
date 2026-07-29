import { MockRunner } from "@ondc/automation-mock-runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCacheStore } from "@/lib/cache/in-memory-cache-store.js";
import { TransactionEvents } from "@/lib/events/transaction-events.js";
import { NotFoundError } from "@/lib/errors.js";
import { logger } from "@/lib/logger.js";
import { MockEngine } from "@/lib/mock-engine/mock-engine.js";
import {
  businessDataKey,
  expectationKey,
  flowStatusKey,
  RecordRepository,
  transactionKey,
} from "@/modules/record/record.repository.js";
import { RecordService } from "@/modules/record/record.service.js";

/**
 * The ledger's contract, exercised against the real `InMemoryCacheStore` rather
 * than a stub of it — the TTL and key behaviour under test *is* the store's.
 */

const TXN = "txn-1";
const NP_URL = "https://np.example.com";
const SCOPE = {
  domain: "ONDC:RET10",
  version: "2.0.2",
  role: "buyer",
} as const;

let cache: InMemoryCacheStore;
let events: TransactionEvents;
let engine: MockEngine;
let service: RecordService;

beforeEach(async () => {
  cache = new InMemoryCacheStore({ sweepIntervalMs: 0 });
  events = new TransactionEvents();
  engine = new MockEngine({
    logger,
    allowedFetchBaseUrls: [],
    idleTtlMs: 60_000,
  });

  service = new RecordService({
    repository: new RecordRepository({
      cache,
      transactionTtlMs: 172_800_000,
      flowStatusTtlMs: 18_000_000,
      expectationTtlMs: 300_000,
    }),
    events,
    mockEngine: engine,
    expectationTtlMs: 300_000,
    logger,
  });

  await service.createTransaction({
    transactionId: TXN,
    sessionId: "sess-1",
    flowId: "flow-1",
    subscriberType: "BPP",
    subscriberUrl: NP_URL,
    scope: SCOPE,
  });
});

afterEach(async () => {
  engine.dispose();
  events.close();
  await cache.close();
});

function apiInput(overrides: Record<string, unknown> = {}) {
  return {
    transactionId: TXN,
    subscriberUrl: NP_URL,
    action: "search",
    messageId: "msg-1",
    direction: "outbound" as const,
    timestamp: "2026-01-01T00:00:00.000Z",
    body: { context: { action: "search" }, message: {} },
    ackBody: { message: { ack: { status: "ACK" } } },
    ...overrides,
  };
}

describe("RecordService — appending", () => {
  it("stores the body out of line and keeps only a handle on the record", async () => {
    const { record, payloadId } = await service.appendApiEntry(apiInput());

    expect(record.apiList).toHaveLength(1);
    const [entry] = record.apiList;
    expect(entry).toMatchObject({
      entryType: "API",
      action: "search",
      payloadId,
      seq: 1,
      direction: "outbound",
    });
    // The point of the split: the entry carries no body at all.
    expect(entry).not.toHaveProperty("body");

    const payload = await service.requirePayload(payloadId ?? "");
    expect(payload.body).toMatchObject({ context: { action: "search" } });
  });

  it("assigns strictly increasing seq numbers", async () => {
    const first = await service.appendApiEntry(apiInput());
    const second = await service.appendApiEntry(
      apiInput({
        action: "on_search",
        messageId: "msg-1",
        direction: "inbound",
      }),
    );

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(second.record.seq).toBe(2);
  });

  it("tracks latest action and de-duplicates message ids", async () => {
    await service.appendApiEntry(apiInput());
    const { record } = await service.appendApiEntry(
      apiInput({
        action: "on_search",
        direction: "inbound",
        timestamp: "2026-01-01T00:00:05.000Z",
      }),
    );

    expect(record.latestAction).toBe("on_search");
    expect(record.latestTimestamp).toBe("2026-01-01T00:00:05.000Z");
    // Both calls of a request/response pair share a message_id by design.
    expect(record.messageIds).toEqual(["msg-1"]);
  });

  it("wakes a waiter only after the record is durable", async () => {
    // The ordering that makes flow_await race-proof: by the time a waiter is
    // told about seq 1, reading the store must already show it.
    const pending = events.waitFor(transactionKey(TXN, NP_URL), {
      afterSeq: 0,
      timeoutMs: 2_000,
    });

    await service.appendApiEntry(apiInput({ direction: "inbound" }));

    const event = await pending;
    expect(event).toMatchObject({ seq: 1, kind: "INBOUND", action: "search" });

    const record = await service.requireTransaction(TXN, NP_URL);
    expect(record.apiList.some((entry) => entry.seq === event?.seq)).toBe(true);
  });

  it("records a form submission", async () => {
    const { record, seq } = await service.appendFormEntry({
      transactionId: TXN,
      subscriberUrl: NP_URL,
      formId: "kyc_form",
      formType: "HTML_FORM",
      submissionId: "sub-9",
    });

    expect(seq).toBe(1);
    expect(record.apiList[0]).toMatchObject({
      entryType: "FORM",
      formId: "kyc_form",
      submissionId: "sub-9",
    });
  });

  it("refuses to append to an unknown transaction", async () => {
    await expect(
      service.appendApiEntry(apiInput({ transactionId: "nope" })),
    ).rejects.toThrow(NotFoundError);
  });

  it("keeps the same transaction id against two counterparties apart", async () => {
    // Same flow, two participants under test: two independent records.
    await service.createTransaction({
      transactionId: TXN,
      sessionId: "sess-2",
      flowId: "flow-1",
      subscriberType: "BPP",
      subscriberUrl: "https://other.example.com",
      scope: SCOPE,
    });

    await service.appendApiEntry(apiInput());

    const mine = await service.requireTransaction(TXN, NP_URL);
    const theirs = await service.requireTransaction(
      TXN,
      "https://other.example.com",
    );
    expect(mine.apiList).toHaveLength(1);
    expect(theirs.apiList).toHaveLength(0);
  });
});

describe("RecordService — business data", () => {
  const payload = {
    context: {
      message_id: "m-77",
      bap_uri: "https://bap.local",
      bap_id: "bap.local",
      bpp_uri: "https://bpp.local",
      bpp_id: "bpp.local",
    },
    message: {
      catalog: { providers: [{ id: "p1" }, { id: "p2" }] },
      order: { id: "o-1" },
    },
  };

  it("saves JSONPath results as arrays, matching the configs' expectations", async () => {
    const data = await service.saveBusinessData(TXN, NP_URL, payload, {
      providerId: "$.message.catalog.providers[*].id",
    });

    // jsonpath.query always yields a list; every config unwraps accordingly,
    // so returning a scalar here would silently break generation.
    expect(data["providerId"]).toEqual(["p1", "p2"]);
  });

  it("injects the five context paths every config assumes are present", async () => {
    const data = await service.saveBusinessData(TXN, NP_URL, payload, {});

    expect(data).toMatchObject({
      latestMessage_id: ["m-77"],
      bapUri: ["https://bap.local"],
      bapId: ["bap.local"],
      bppUri: ["https://bpp.local"],
      bppId: ["bpp.local"],
    });
  });

  it("concatenates under APPEND# instead of replacing", async () => {
    await service.saveBusinessData(TXN, NP_URL, payload, {
      "APPEND#seenProviders": "$.message.catalog.providers[*].id",
    });
    const data = await service.saveBusinessData(TXN, NP_URL, payload, {
      "APPEND#seenProviders": "$.message.catalog.providers[*].id",
    });

    expect(data["seenProviders"]).toEqual(["p1", "p2", "p1", "p2"]);
  });

  it("runs an EVAL# expression in the sandbox", async () => {
    const expression = MockRunner.encodeBase64(
      `function getSave(payload) {
         return payload.message.catalog.providers.length;
       }`,
    );

    const data = await service.saveBusinessData(TXN, NP_URL, payload, {
      providerCount: `EVAL#${expression}`,
    });

    expect(data["providerCount"]).toBe(2);
  });

  it("skips a key whose path cannot be satisfied and keeps the rest", async () => {
    const data = await service.saveBusinessData(TXN, NP_URL, payload, {
      broken: "$$$not a path",
      orderId: "$.message.order.id",
    });

    expect(data["orderId"]).toEqual(["o-1"]);
    expect(data).not.toHaveProperty("broken");
  });

  it("accumulates across steps", async () => {
    await service.saveBusinessData(TXN, NP_URL, payload, {
      providerId: "$.message.catalog.providers[*].id",
    });
    const data = await service.saveBusinessData(
      TXN,
      NP_URL,
      { context: {}, message: { order: { id: "o-2" } } },
      { orderId: "$.message.order.id" },
    );

    expect(data["providerId"]).toEqual(["p1", "p2"]);
    expect(data["orderId"]).toEqual(["o-2"]);
  });
});

describe("RecordService — flow status and attention", () => {
  it("reads an absent marker as AVAILABLE", async () => {
    const repository = new RecordRepository({
      cache,
      transactionTtlMs: 1_000,
      flowStatusTtlMs: 1_000,
      expectationTtlMs: 1_000,
    });

    // The safe fallback: a dispatch that crashed without writing AVAILABLE
    // back must not wedge its step until the TTL expires.
    await expect(repository.getFlowStatus(TXN, NP_URL)).resolves.toBe(
      "AVAILABLE",
    );

    await repository.setFlowStatus(TXN, NP_URL, "WORKING");
    await expect(repository.getFlowStatus(TXN, NP_URL)).resolves.toBe(
      "WORKING",
    );

    // Per-step markers are independent of the flow-level one.
    await expect(
      repository.getFlowStatus(TXN, NP_URL, "extra_step"),
    ).resolves.toBe("AVAILABLE");
  });

  it("persists why the loop paused", async () => {
    await service.setAttention(TXN, NP_URL, {
      kind: "INPUT_REQUIRED",
      message: "select_1 needs loan_amount",
      step_key: "select_1",
      at: "2026-01-01T00:00:00.000Z",
    });

    const record = await service.requireTransaction(TXN, NP_URL);
    expect(record.attention).toMatchObject({ step_key: "select_1" });

    await service.setAttention(TXN, NP_URL, undefined);
    expect(
      (await service.requireTransaction(TXN, NP_URL)).attention,
    ).toBeUndefined();
  });

  it("indexes transactions per session", async () => {
    await service.createTransaction({
      transactionId: "txn-2",
      sessionId: "sess-1",
      flowId: "flow-1",
      subscriberType: "BPP",
      subscriberUrl: NP_URL,
      scope: SCOPE,
    });

    await expect(service.listTransactionIds("sess-1")).resolves.toEqual([
      TXN,
      "txn-2",
    ]);
  });
});

describe("record key layout", () => {
  it("reproduces the workbench's Redis keys exactly", () => {
    // Not cosmetic: keeping these means a shared Redis with the real workbench
    // stays a configuration change rather than a migration.
    expect(transactionKey("t1", "https://np")).toBe("t1::https://np");
    expect(businessDataKey("t1", "https://np")).toBe(
      "MOCK_DATA::t1::https://np",
    );
    expect(flowStatusKey("t1", "https://np")).toBe(
      "FLOW_STATUS_t1::https://np",
    );
    expect(flowStatusKey("t1", "https://np", "extra")).toBe(
      "EXTRA_FLOW_STATUS_t1::https://np::extra",
    );
  });

  it("folds away insignificant differences in a counterparty URL", () => {
    // Half these URLs are the one registered at session_create and half are
    // whatever the participant advertises in its payloads. They are meant to
    // be the same string; when they are not, every key derived from them has
    // to agree anyway or the receiver writes one record and the tools read
    // another.
    for (const spelling of [
      "https://np.example.com",
      "https://np.example.com/",
      "https://NP.Example.com",
      "https://np.example.com:443",
      "  https://np.example.com  ",
    ]) {
      expect(transactionKey("t1", spelling)).toBe(
        "t1::https://np.example.com",
      );
    }
  });

  it("keeps a path, because a path is a different participant", () => {
    expect(transactionKey("t1", "https://np.example.com/ondc")).not.toBe(
      transactionKey("t1", "https://np.example.com"),
    );
  });

  it("buckets expectations by endpoint, case-folding the domain", () => {
    expect(
      expectationKey({ domain: "ondc:ret10", version: "2.0.2", role: "buyer" }),
    ).toBe(
      expectationKey({ domain: "ONDC:RET10", version: "2.0.2", role: "buyer" }),
    );
    expect(
      expectationKey({ domain: "ONDC:RET10", version: "2.0.2", role: "buyer" }),
    ).not.toBe(
      expectationKey({
        domain: "ONDC:RET10",
        version: "2.0.2",
        role: "seller",
      }),
    );
  });
});

describe("expectations", () => {
  const armed = (sessionId: string, action: string, url = NP_URL) => ({
    sessionId,
    flowId: "flow-1",
    expectedAction: action,
    subscriberUrl: url,
    autoAdvance: false,
  });

  it("upserts rather than appending, so re-arming cannot grow the bucket", async () => {
    // #armExpectation fires from the listen branch of every proceed, and
    // auto-advance chains proceed up to twenty times.
    for (let i = 0; i < 5; i++) {
      await service.armExpectation(SCOPE, armed("sess-1", "search"));
    }

    await expect(
      service.expectationsForSession(SCOPE, "sess-1"),
    ).resolves.toHaveLength(1);
  });

  it("consumes exactly one entry and leaves the rest armed", async () => {
    await service.armExpectation(SCOPE, armed("sess-1", "search"));
    await service.armExpectation(SCOPE, armed("sess-2", "select"));

    const taken = await service.consumeExpectation(SCOPE, {
      action: "search",
      transactionId: "txn-x",
      subscriberUrl: NP_URL,
    });

    expect(taken?.sessionId).toBe("sess-1");
    await expect(
      service.expectationsForSession(SCOPE, "sess-1"),
    ).resolves.toEqual([]);
    await expect(
      service.expectationsForSession(SCOPE, "sess-2"),
    ).resolves.toHaveLength(1);
  });

  it("drops expired entries in the same pass", async () => {
    const armedAt = new Date("2026-01-01T00:00:00.000Z");
    await service.armExpectation(SCOPE, armed("sess-1", "search"), armedAt);

    const later = new Date(armedAt.getTime() + 600_000);
    await expect(
      service.consumeExpectation(
        SCOPE,
        { action: "search", transactionId: "t", subscriberUrl: NP_URL },
        later,
      ),
    ).resolves.toBeUndefined();
    await expect(
      service.expectationsForSession(SCOPE, "sess-1", later),
    ).resolves.toEqual([]);
  });

  it("prefers the session whose transaction the caller quotes", async () => {
    await service.armExpectation(SCOPE, {
      ...armed("sess-older", "on_search"),
      transactionId: "txn-a",
    });
    await service.armExpectation(SCOPE, {
      ...armed("sess-newer", "on_search"),
      transactionId: "txn-b",
    });

    const taken = await service.consumeExpectation(SCOPE, {
      action: "on_search",
      transactionId: "txn-b",
      subscriberUrl: NP_URL,
    });

    expect(taken?.sessionId).toBe("sess-newer");
  });

  it("falls back to the session that registered the calling URL", async () => {
    await service.armExpectation(
      SCOPE,
      armed("sess-other", "search", "https://elsewhere.example.com"),
    );
    await service.armExpectation(SCOPE, armed("sess-match", "search", NP_URL));

    const taken = await service.consumeExpectation(SCOPE, {
      action: "search",
      transactionId: "unknown",
      subscriberUrl: `${NP_URL}/`,
    });

    expect(taken?.sessionId).toBe("sess-match");
  });

  it("falls back to oldest-armed when nothing else separates them", async () => {
    const first = new Date("2026-01-01T00:00:00.000Z");
    await service.armExpectation(SCOPE, armed("sess-first", "search"), first);
    await service.armExpectation(
      SCOPE,
      armed("sess-second", "search"),
      new Date(first.getTime() + 1000),
    );

    const taken = await service.consumeExpectation(
      SCOPE,
      { action: "search", transactionId: "unknown", subscriberUrl: NP_URL },
      new Date(first.getTime() + 2000),
    );

    expect(taken?.sessionId).toBe("sess-first");
  });

  it("hands back copies, so a caller cannot mutate stored state", async () => {
    // InMemoryCacheStore returns the reference it stored. Without a copy this
    // passes here and breaks the day the store is Redis.
    await service.armExpectation(SCOPE, armed("sess-1", "search"));

    const [entry] = await service.expectationsForSession(SCOPE, "sess-1");
    entry!.expectedAction = "tampered";

    const [reread] = await service.expectationsForSession(SCOPE, "sess-1");
    expect(reread?.expectedAction).toBe("search");
  });
});
