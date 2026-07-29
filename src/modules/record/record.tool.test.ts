import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecordService } from "@/modules/record/record.service.js";
import { FIXTURE_BUILD } from "@/test/fakes.js";
import { createHarness, resourceText, type Harness } from "@/test/harness.js";

/**
 * The read-back surface, over a real MCP client.
 *
 * The size guards are the substance here: these two tools are the *only* path
 * by which a several-hundred-kilobyte catalog could reach the model's context,
 * so every cap and every announcement of a cap is worth a test.
 */

let harness: Harness;
let records: RecordService;
let sessionId: string;
const NP_URL = "https://np.example.com";

/** A catalog large enough to trip the default cap. */
function bigCatalog(): Record<string, unknown> {
  return {
    context: {
      action: "on_search",
      message_id: "msg-1",
      transaction_id: "txn-1",
      bap_uri: "https://bap.local",
    },
    message: {
      catalog: {
        providers: Array.from({ length: 400 }, (_, i) => ({
          id: `provider-${String(i)}`,
          descriptor: {
            name: `Lender number ${String(i)}`,
            long_desc: "x".repeat(80),
          },
        })),
      },
    },
  };
}

beforeEach(async () => {
  harness = await createHarness();
  records = harness.container.services.record;

  const created = await harness.client.callTool({
    name: "session_create",
    arguments: {
      subscriber_url: NP_URL,
      np_type: "BPP",
      domain: FIXTURE_BUILD.domain,
      version: FIXTURE_BUILD.version,
      usecase: FIXTURE_BUILD.usecase,
    },
  });
  sessionId = (created.structuredContent as { session: { session_id: string } })
    .session.session_id;

  await records.createTransaction({
    transactionId: "txn-1",
    sessionId,
    flowId: "flow-1",
    subscriberType: "BPP",
    subscriberUrl: NP_URL,
    scope: {
      domain: FIXTURE_BUILD.domain,
      version: FIXTURE_BUILD.version,
      role: "buyer",
    },
  });
});

afterEach(async () => {
  await harness.close();
});

async function recordOnSearch(): Promise<string> {
  const { payloadId } = await records.appendApiEntry({
    transactionId: "txn-1",
    subscriberUrl: NP_URL,
    action: "on_search",
    messageId: "msg-1",
    direction: "inbound",
    timestamp: "2026-01-01T00:00:00.000Z",
    body: bigCatalog(),
    ackBody: { message: { ack: { status: "ACK" } } },
  });
  return payloadId ?? "";
}

describe("record_get_payload", () => {
  it("truncates a large body and says so", async () => {
    const payloadId = await recordOnSearch();

    const result = await harness.client.callTool({
      name: "record_get_payload",
      arguments: { session_id: sessionId, payload_id: payloadId },
    });

    const output = result.structuredContent as {
      truncated: boolean;
      size_bytes: number;
      payload: string;
      action: string;
      direction: string;
    };
    expect(output.truncated).toBe(true);
    expect(output.size_bytes).toBeGreaterThan(20_000);
    expect(output.payload).toContain("[truncated at 20000 bytes]");
    expect(output.action).toBe("on_search");
    expect(output.direction).toBe("inbound");

    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("TRUNCATED");
  });

  it("returns a JSONPath slice in full when it fits", async () => {
    const payloadId = await recordOnSearch();

    const result = await harness.client.callTool({
      name: "record_get_payload",
      arguments: {
        session_id: sessionId,
        payload_id: payloadId,
        jsonpath: "$.message.catalog.providers[0].id",
      },
    });

    const output = result.structuredContent as {
      truncated: boolean;
      payload: string[];
    };
    expect(output.truncated).toBe(false);
    expect(output.payload).toEqual(["provider-0"]);
  });

  it("carries the ACK the counterparty answered with", async () => {
    const payloadId = await recordOnSearch();

    const result = await harness.client.callTool({
      name: "record_get_payload",
      arguments: {
        session_id: sessionId,
        payload_id: payloadId,
        jsonpath: "$.context.action",
      },
    });

    expect(result.structuredContent).toMatchObject({
      ack: { message: { ack: { status: "ACK" } } },
    });
  });

  it("reports a malformed JSONPath as a tool error the model can fix", async () => {
    const payloadId = await recordOnSearch();

    const result = await harness.client.callTool({
      name: "record_get_payload",
      arguments: {
        session_id: sessionId,
        payload_id: payloadId,
        jsonpath: "$$$nonsense",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "validation_error" },
    });
  });

  it("reports an unknown handle as not found", async () => {
    const result = await harness.client.callTool({
      name: "record_get_payload",
      arguments: { session_id: sessionId, payload_id: "nope" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "not_found" },
    });
  });
});

describe("record_get_data", () => {
  it("returns accumulated business data", async () => {
    await records.saveBusinessData(
      "txn-1",
      NP_URL,
      {
        context: { message_id: "m-1" },
        message: { catalog: { providers: [{ id: "p1" }] } },
      },
      { providerId: "$.message.catalog.providers[*].id" },
    );

    const result = await harness.client.callTool({
      name: "record_get_data",
      arguments: { session_id: sessionId, transaction_id: "txn-1" },
    });

    expect(result.structuredContent).toMatchObject({
      transaction_id: "txn-1",
      data: { providerId: ["p1"], latestMessage_id: ["m-1"] },
    });
  });

  it("omits an oversized value but names it, and returns it when asked", async () => {
    // This is how resolved form HTML behaves: too big to include by default,
    // still reachable by name.
    await records.overwriteBusinessData("txn-1", NP_URL, {
      kyc_form: "<html>".padEnd(5_000, "x"),
      orderId: ["o-1"],
    });

    const listed = await harness.client.callTool({
      name: "record_get_data",
      arguments: { session_id: sessionId, transaction_id: "txn-1" },
    });
    const output = listed.structuredContent as {
      data: Record<string, unknown>;
      omitted: { key: string; size_bytes: number }[];
    };
    expect(output.data).not.toHaveProperty("kyc_form");
    expect(output.data["orderId"]).toEqual(["o-1"]);
    expect(output.omitted[0]).toMatchObject({ key: "kyc_form" });

    const asked = await harness.client.callTool({
      name: "record_get_data",
      arguments: {
        session_id: sessionId,
        transaction_id: "txn-1",
        keys: ["kyc_form"],
      },
    });
    expect(
      (asked.structuredContent as { data: Record<string, string> }).data[
        "kyc_form"
      ],
    ).toHaveLength(5_000);
  });

  it("refuses a transaction that is not this session's counterparty", async () => {
    const result = await harness.client.callTool({
      name: "record_get_data",
      arguments: { session_id: sessionId, transaction_id: "unknown-txn" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "not_found" },
    });
  });
});

describe("record resources", () => {
  it("serves a slim transaction document", async () => {
    await recordOnSearch();

    const result = await harness.client.readResource({
      uri: `ondc://txn/${sessionId}/txn-1`,
    });
    const body = JSON.parse(resourceText(result)) as {
      entries: { payloadId: string }[];
      latest_action: string;
      seq: number;
    };

    expect(body.latest_action).toBe("on_search");
    expect(body.seq).toBe(1);
    // Slim: handles only. The catalog itself must not be in here.
    expect(body.entries[0]).toHaveProperty("payloadId");
    expect(resourceText(result)).not.toContain("provider-399");
  });

  it("serves the full body from the payload resource", async () => {
    const payloadId = await recordOnSearch();

    const result = await harness.client.readResource({
      uri: `ondc://payload/${payloadId}`,
    });

    expect(resourceText(result)).toContain("provider-399");
  });
});

/* -------------------------------------------------------------------------- */
/* Piggyback delivery                                                          */
/* -------------------------------------------------------------------------- */

describe("piggyback delivery", () => {
  interface WithEvents {
    events?: {
      events: { seq: number; kind: string; summary: string }[];
      more: number;
      cursor: number;
    };
  }

  async function call(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<WithEvents> {
    const result = await harness.client.callTool({
      name,
      arguments: { session_id: sessionId, ...args },
    });
    return result.structuredContent as WithEvents;
  }

  it("attaches nothing when nothing has happened", async () => {
    const output = await call("session_get");

    // Absent, not empty: a key that only ever says "nothing" is a key the model
    // pays to read on every single call.
    expect(output.events).toBeUndefined();
  });

  /**
   * The core claim of this whole mechanism: an event journaled while the model
   * was doing something else reaches it on its next call, whatever that call
   * was about.
   */
  it("delivers an event journaled between two unrelated calls", async () => {
    await call("session_get");

    await records.journal(sessionId, {
      kind: "INBOUND_ACK",
      action: "on_search",
      summary: "ACKed on_search from the participant.",
    });

    const output = await call("session_get");

    expect(output.events?.events).toHaveLength(1);
    expect(output.events?.events[0]).toMatchObject({
      kind: "INBOUND_ACK",
      summary: "ACKed on_search from the participant.",
    });
    expect(output.events?.more).toBe(0);
  });

  it("delivers exactly once, then stops", async () => {
    await records.journal(sessionId, {
      kind: "INBOUND_ACK",
      summary: "first",
    });

    await expect(
      call("session_get").then((output) => output.events?.events),
    ).resolves.toHaveLength(1);
    await expect(
      call("session_get").then((output) => output.events),
    ).resolves.toBeUndefined();
  });

  /** Any session-scoped tool drains — that is what makes it unavoidable. */
  it("rides on every session-scoped tool, not just the flow ones", async () => {
    const payloadId = await recordOnSearch();

    for (const [name, args] of [
      ["session_get", {}],
      ["record_get_data", { transaction_id: "txn-1" }],
      ["record_get_payload", { payload_id: payloadId }],
    ] as const) {
      await records.journal(sessionId, {
        kind: "CHAIN_SENT",
        summary: `before ${name}`,
      });

      const output = await call(name, args);
      expect(output.events?.events.at(-1)?.summary).toBe(`before ${name}`);
    }
  });

  it("throttles a burst across calls rather than dropping it", async () => {
    for (let index = 0; index < 14; index++) {
      await records.journal(sessionId, {
        kind: "CHAIN_SENT",
        summary: `entry ${String(index)}`,
      });
    }

    const first = await call("session_get");
    expect(first.events?.events).toHaveLength(10);
    expect(first.events?.more).toBe(4);

    const second = await call("session_get");
    expect(second.events?.events).toHaveLength(4);
    expect(second.events?.more).toBe(0);
  });

  it("renders the delta into the text the model actually reads", async () => {
    await records.journal(sessionId, {
      kind: "INBOUND_NACK",
      nack_code: "OUT_OF_SEQUENCE",
      summary: "NACKed an unexpected on_status.",
    });

    const result = await harness.client.callTool({
      name: "session_get",
      arguments: { session_id: sessionId },
    });
    const [content] = result.content as { text: string }[];

    expect(content?.text).toContain("since your last call");
    expect(content?.text).toContain("INBOUND_NACK");
    expect(content?.text).toContain("OUT_OF_SEQUENCE");
  });

  describe("record_get_events", () => {
    it("re-reads what piggyback already consumed, without consuming it", async () => {
      await records.journal(sessionId, {
        kind: "INBOUND_ACK",
        summary: "one",
      });
      await call("session_get"); // consumes it

      const first = (
        await harness.client.callTool({
          name: "record_get_events",
          arguments: { session_id: sessionId },
        })
      ).structuredContent as {
        events: { summary: string }[];
        delivered_through: number;
        more: number;
      };

      expect(first.events.map((event) => event.summary)).toEqual(["one"]);
      expect(first.delivered_through).toBe(1);

      // Reading is repeatable, and it did not move the cursor...
      const second = (
        await harness.client.callTool({
          name: "record_get_events",
          arguments: { session_id: sessionId },
        })
      ).structuredContent as { events: unknown[]; delivered_through: number };
      expect(second.events).toHaveLength(1);
      expect(second.delivered_through).toBe(1);

      // ...so a later piggyback still delivers only what is genuinely new.
      await records.journal(sessionId, {
        kind: "INBOUND_ACK",
        summary: "two",
      });
      const output = await call("session_get");
      expect(output.events?.events.map((event) => event.summary)).toEqual([
        "two",
      ]);
    });

    it("walks the journal with since_seq and reports what is left", async () => {
      for (let index = 0; index < 5; index++) {
        await records.journal(sessionId, {
          kind: "CHAIN_SENT",
          summary: `entry ${String(index)}`,
        });
      }

      const page = (
        await harness.client.callTool({
          name: "record_get_events",
          arguments: { session_id: sessionId, since_seq: 2, limit: 2 },
        })
      ).structuredContent as {
        events: { seq: number }[];
        more: number;
      };

      expect(page.events.map((event) => event.seq)).toEqual([3, 4]);
      expect(page.more).toBe(1);
    });

    it("refuses an unknown session rather than answering an empty journal", async () => {
      const result = await harness.client.callTool({
        name: "record_get_events",
        arguments: { session_id: "00000000-0000-0000-0000-000000000000" },
      });

      expect(result.isError).toBe(true);
    });
  });
});
