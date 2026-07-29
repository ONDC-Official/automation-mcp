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
