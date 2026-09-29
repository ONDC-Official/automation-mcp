import { describe, expect, it } from "vitest";
import { InMemoryCacheStore } from "@/lib/cache/in-memory-cache-store.js";
import {
  BatchRepository,
  type BatchMeta,
} from "@/modules/batch/batch.repository.js";
import type { BatchTransactionResult } from "@/modules/batch/batch.schema.js";

const TTL_MS = 60_000;

function subject(): BatchRepository {
  return new BatchRepository(new InMemoryCacheStore({ sweepIntervalMs: 0 }));
}

function meta(overrides: Partial<BatchMeta> = {}): BatchMeta {
  return {
    batch_id: "batch-1",
    state: "running",
    input: {
      role: "initiator",
      domain: "ONDC:TRV11",
      version: "2.0.0",
      usecase: "Metro",
      flow_id: "SOME_FLOW",
      counterparty_subscriber_url: "http://127.0.0.1:3010",
      transaction_count: 10,
      concurrency: 5,
      per_transaction_timeout_ms: 60_000,
    },
    accepted_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function result(
  index: number,
  status: BatchTransactionResult["status"],
): BatchTransactionResult {
  return {
    index,
    status,
    transaction_id: `txn-${String(index)}`,
    message: `result ${String(index)}`,
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:00:01.000Z",
    duration_ms: 1000,
  };
}

describe("BatchRepository meta", () => {
  it("round-trips a saved meta record", async () => {
    const repo = subject();
    await repo.saveMeta(meta(), TTL_MS);
    expect(await repo.getMeta("batch-1")).toEqual(meta());
  });

  it("returns undefined for an unknown batch", async () => {
    const repo = subject();
    expect(await repo.getMeta("nope")).toBeUndefined();
  });

  it("updateMeta patches an existing record without touching other fields", async () => {
    const repo = subject();
    await repo.saveMeta(meta(), TTL_MS);
    await repo.updateMeta("batch-1", TTL_MS, {
      state: "completed",
      finished_at: "2026-01-01T00:05:00.000Z",
    });

    const updated = await repo.getMeta("batch-1");
    expect(updated?.state).toBe("completed");
    expect(updated?.finished_at).toBe("2026-01-01T00:05:00.000Z");
    expect(updated?.input.transaction_count).toBe(10);
  });

  it("updateMeta on an unknown batch is a safe no-op", async () => {
    const repo = subject();
    await expect(
      repo.updateMeta("nope", TTL_MS, { state: "cancelled" }),
    ).resolves.toBeUndefined();
  });
});

describe("BatchRepository progress", () => {
  it("starts every status at zero", async () => {
    const repo = subject();
    expect(await repo.getProgress("batch-1")).toEqual({
      queued: 0,
      in_flight: 0,
      completed: 0,
      blocked: 0,
      nacked: 0,
      timed_out: 0,
      errored: 0,
    });
  });

  it("bumps a single status atomically", async () => {
    const repo = subject();
    await repo.bumpProgress("batch-1", "completed", TTL_MS);
    await repo.bumpProgress("batch-1", "completed", TTL_MS);
    await repo.bumpProgress("batch-1", "errored", TTL_MS);

    const progress = await repo.getProgress("batch-1");
    expect(progress.completed).toBe(2);
    expect(progress.errored).toBe(1);
    expect(progress.blocked).toBe(0);
  });

  it("supports negative increments for in_flight decrements", async () => {
    const repo = subject();
    await repo.bumpProgress("batch-1", "in_flight", TTL_MS, 3);
    await repo.bumpProgress("batch-1", "in_flight", TTL_MS, -1);
    expect((await repo.getProgress("batch-1")).in_flight).toBe(2);
  });

  it("progress for one batch never leaks into another", async () => {
    const repo = subject();
    await repo.bumpProgress("batch-A", "completed", TTL_MS, 5);
    await repo.bumpProgress("batch-B", "completed", TTL_MS, 1);
    expect((await repo.getProgress("batch-A")).completed).toBe(5);
    expect((await repo.getProgress("batch-B")).completed).toBe(1);
  });
});

describe("BatchRepository results", () => {
  it("appends and lists results in order", async () => {
    const repo = subject();
    await repo.appendResult("batch-1", result(0, "completed"), TTL_MS);
    await repo.appendResult("batch-1", result(1, "blocked"), TTL_MS);

    const results = await repo.listResults("batch-1", 0, -1);
    expect(results).toHaveLength(2);
    expect(results[0]?.index).toBe(0);
    expect(results[1]?.status).toBe("blocked");
  });

  it("countResults reflects every appended entry", async () => {
    const repo = subject();
    for (let i = 0; i < 5; i++) {
      await repo.appendResult("batch-1", result(i, "completed"), TTL_MS);
    }
    expect(await repo.countResults("batch-1")).toBe(5);
  });

  it("listResults paginates with LRANGE semantics", async () => {
    const repo = subject();
    for (let i = 0; i < 10; i++) {
      await repo.appendResult("batch-1", result(i, "completed"), TTL_MS);
    }
    const page = await repo.listResults("batch-1", 2, 4);
    expect(page.map((r) => r.index)).toEqual([2, 3, 4]);
  });

  it("an unknown batch's results are an empty list, not an error", async () => {
    const repo = subject();
    expect(await repo.listResults("nope", 0, -1)).toEqual([]);
    expect(await repo.countResults("nope")).toBe(0);
  });
});
