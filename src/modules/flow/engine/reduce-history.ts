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
          seq: item.seq,
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
        seq: item.seq,
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
 * Order the exchanges for replay.
 *
 * **`seq` wins whenever both entries have one**, and this is a deliberate
 * divergence from the workbench, which sorts on `context.timestamp` alone.
 *
 * That timestamp is written by whoever produced the payload — for half the
 * exchanges, the participant under test. A participant whose clock runs a
 * second fast stamps its `on_search` *later* than the `select` we send in
 * response to it, and a timestamp sort then replays them backwards: `select`
 * matches no pending step, gets filed as out-of-order, and the flow never
 * completes. The symptom is a correct implementation looking non-compliant, for
 * a reason nothing in the trace points at.
 *
 * `seq` is our own append counter. It records the order we genuinely observed
 * and no counterparty can influence it, so it is strictly the better answer
 * where it exists. Timestamp remains the fallback for entries built without one
 * — which is what the ported upstream fixtures are.
 */
export function sortForReplay(entries: ApiHistory[]): ApiHistory[] {
  return [...entries].sort((a, b) => {
    if (a.seq !== undefined && b.seq !== undefined) return a.seq - b.seq;
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  });
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
