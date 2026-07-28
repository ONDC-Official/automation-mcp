import type {
  ApiHistory,
  EngineHistoryEntry,
} from "@/modules/flow/engine/engine-types.js";

/**
 * Collapse the raw exchange list into one entry per logical exchange.
 *
 * The same `(action, message_id)` can be recorded more than once — a retried
 * send, a duplicate callback, the request and its error reply. The flow only
 * ever advanced once, so the map must see one entry; the individual payloads
 * are kept alongside it so nothing is lost.
 *
 * First writer wins on the metadata (timestamp, ack), later payloads are
 * appended. That ordering matters: the *first* response is the one the
 * counterparty actually acted on.
 */
export function reduceApiDataList(data: EngineHistoryEntry[]): ApiHistory[] {
  const map = new Map<string, ApiHistory>();

  for (const item of data) {
    if (item.entryType === "FORM") {
      const key = `${item.formType}|${item.formId}|${String(item.submissionId)}`;
      if (!map.has(key)) {
        map.set(key, {
          entryType: "FORM",
          formType: item.formType,
          formId: item.formId,
          submissionId: item.submissionId,
          timestamp: item.timestamp,
          subStatus: item.error ? "ERROR" : "SUCCESS",
          error: item.error,
        });
      }
      continue;
    }

    const key = `${item.action}|${item.messageId}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        entryType: "API",
        action: item.action,
        messageId: item.messageId,
        timestamp: item.timestamp,
        subStatus: checkPerfectAck(item.response),
        payloads: [{ payloadId: item.payloadId, response: item.response }],
      });
    } else if (existing.entryType === "API") {
      existing.payloads.push({
        payloadId: item.payloadId,
        response: item.response,
      });
    }
  }

  return Array.from(map.values());
}

/**
 * Whether a recorded response was a clean ACK.
 *
 * Anything else — a NACK, an error body, a transport failure recorded as
 * `undefined` — is an ERROR. The step still counts as *taken*; the sub-status
 * is what the compliance report reads.
 */
export function checkPerfectAck(response: unknown): "SUCCESS" | "ERROR" {
  if (response && typeof response === "object" && "message" in response) {
    const typed = response as { message?: { ack?: { status?: string } } };
    if (typed.message?.ack?.status === "ACK") {
      return "SUCCESS";
    }
  }
  return "ERROR";
}
