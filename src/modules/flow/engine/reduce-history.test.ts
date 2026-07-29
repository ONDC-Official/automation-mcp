import { describe, expect, it } from "vitest";
import type {
  ApiHistory,
  EngineHistoryEntry,
} from "@/modules/flow/engine/engine-types.js";
import {
  checkPerfectAck,
  reduceApiDataList,
  sortForReplay,
} from "@/modules/flow/engine/reduce-history.js";

function api(
  action: string,
  messageId: string,
  timestamp: string,
  extra: Partial<EngineHistoryEntry> = {},
): EngineHistoryEntry {
  return {
    entryType: "API",
    action,
    payloadId: `${action}-${messageId}`,
    messageId,
    response: { message: { ack: { status: "ACK" } } },
    timestamp,
    ...extra,
  } as EngineHistoryEntry;
}

describe("reduceApiDataList", () => {
  it("collapses repeats of the same exchange but keeps every payload", () => {
    // A retried send, a duplicated callback: the flow advanced once, so the
    // map must see one entry — but the bodies are all evidence.
    const reduced = reduceApiDataList([
      api("search", "m1", "2026-01-01T00:00:00.000Z"),
      api("search", "m1", "2026-01-01T00:00:01.000Z"),
    ]);

    expect(reduced).toHaveLength(1);
    const [entry] = reduced;
    expect(entry?.entryType).toBe("API");
    if (entry?.entryType === "API") {
      expect(entry.payloads).toHaveLength(2);
      // First writer wins on metadata: that is the response acted on.
      expect(entry.timestamp).toBe("2026-01-01T00:00:00.000Z");
    }
  });

  it("keeps distinct message ids apart", () => {
    const reduced = reduceApiDataList([
      api("on_status", "m1", "2026-01-01T00:00:00.000Z"),
      api("on_status", "m2", "2026-01-01T00:00:01.000Z"),
    ]);

    expect(reduced).toHaveLength(2);
  });

  it("carries seq through so replay can order on it", () => {
    const reduced = reduceApiDataList([
      api("search", "m1", "2026-01-01T00:00:00.000Z", { seq: 7 }),
    ]);

    expect(reduced[0]?.seq).toBe(7);
  });
});

describe("sortForReplay", () => {
  it("orders by seq — the order we observed — over the counterparty's clock", () => {
    // The regression this exists for: a participant whose clock runs fast
    // stamps its callback *after* the reply we sent because of it. Ordering on
    // timestamp replays them backwards, the reply matches no pending step, and
    // a compliant implementation reads as broken.
    const skewed: ApiHistory[] = [
      {
        entryType: "API",
        action: "select",
        messageId: "m2",
        timestamp: "2026-01-01T00:00:00.500Z",
        subStatus: "SUCCESS",
        payloads: [],
        seq: 3,
      },
      {
        entryType: "API",
        action: "on_search",
        messageId: "m1",
        // One second in our future — the participant's clock is ahead.
        timestamp: "2026-01-01T00:00:01.000Z",
        subStatus: "SUCCESS",
        payloads: [],
        seq: 2,
      },
    ];

    expect(
      sortForReplay(skewed).map((entry) =>
        entry.entryType === "API" ? entry.action : entry.formType,
      ),
    ).toEqual(["on_search", "select"]);
  });

  it("falls back to timestamp when seq is absent", () => {
    // Upstream-shaped history has no seq; the ported behaviour must still hold.
    const entries: ApiHistory[] = [
      {
        entryType: "API",
        action: "on_search",
        messageId: "m2",
        timestamp: "2026-01-01T00:00:02.000Z",
        subStatus: "SUCCESS",
        payloads: [],
      },
      {
        entryType: "API",
        action: "search",
        messageId: "m1",
        timestamp: "2026-01-01T00:00:01.000Z",
        subStatus: "SUCCESS",
        payloads: [],
      },
    ];

    expect(
      sortForReplay(entries).map((entry) =>
        entry.entryType === "API" ? entry.action : entry.formType,
      ),
    ).toEqual(["search", "on_search"]);
  });

  it("does not mutate its input", () => {
    const entries: ApiHistory[] = [
      {
        entryType: "API",
        action: "b",
        messageId: "m2",
        timestamp: "2026-01-01T00:00:02.000Z",
        subStatus: "SUCCESS",
        payloads: [],
        seq: 2,
      },
      {
        entryType: "API",
        action: "a",
        messageId: "m1",
        timestamp: "2026-01-01T00:00:01.000Z",
        subStatus: "SUCCESS",
        payloads: [],
        seq: 1,
      },
    ];

    sortForReplay(entries);
    expect(entries[0]?.entryType === "API" && entries[0].action).toBe("b");
  });
});

describe("checkPerfectAck", () => {
  it.each([
    [{ message: { ack: { status: "ACK" } } }, "SUCCESS"],
    [{ message: { ack: { status: "NACK" } } }, "ERROR"],
    [{ error: { code: "500" } }, "ERROR"],
    [undefined, "ERROR"],
    ["text", "ERROR"],
  ])("%j → %s", (response, expected) => {
    expect(checkPerfectAck(response)).toBe(expected);
  });
});
