import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";
import type { Registerable } from "@/lib/define-tool.js";
import { toAppError, ValidationError } from "@/lib/errors.js";
import { jsonContents, MIME_JSON } from "@/lib/resource-contents.js";
import type { RecordService } from "@/modules/record/record.service.js";
import type { SessionService } from "@/modules/session/session.service.js";

/**
 * The ledger as readable documents.
 *
 * A resource, not a tool, because a client should be able to pin a transaction
 * into context and re-read it without spending a tool call on every turn. Both
 * are `private` and short-lived: a transaction names a participant under test
 * and changes on every exchange.
 *
 * `ondc://txn/…` stays **slim** — the entry list with handles, never bodies.
 * Reading a body is `ondc://payload/…` or `record_get_payload`, which is where
 * the size guards live.
 */
export function createRecordResources(
  records: RecordService,
  sessions: SessionService,
): Registerable[] {
  return [
    {
      name: "ondc-transaction",
      register(server: McpServer): void {
        server.registerResource(
          "ondc-transaction",
          new ResourceTemplate("ondc://txn/{sessionId}/{transactionId}", {
            list: undefined,
          }),
          {
            title: "Transaction by id",
            description:
              "One flow instance: the ordered exchanges with the participant " +
              "under test, each with a payload handle, plus whatever the loop " +
              "is currently waiting on. Bodies are not included.",
            mimeType: MIME_JSON,
            cacheHint: { ttlMs: 2_000, cacheScope: "private" },
          },
          async (uri) => {
            try {
              const [sessionId, transactionId] = uri.pathname
                .replace(/^\/+/, "")
                .split("/")
                .map((segment) => decodeURIComponent(segment));

              if (!sessionId || !transactionId) {
                throw new ValidationError(
                  "Expected ondc://txn/{sessionId}/{transactionId}.",
                  { uri: uri.href },
                );
              }

              const session = await sessions.requireSession(sessionId);
              const record = await records.requireTransaction(
                transactionId,
                session.np.subscriber_url,
              );

              return jsonContents(uri, {
                transaction_id: record.transactionId,
                session_id: record.sessionId,
                flow_id: record.flowId,
                np_type: record.subscriberType,
                subscriber_url: record.subscriberUrl,
                created_at: record.createdAt,
                latest_action: record.latestAction,
                latest_timestamp: record.latestTimestamp,
                seq: record.seq,
                auto_advance: record.autoAdvance,
                ...(record.attention ? { attention: record.attention } : {}),
                entries: record.apiList,
              });
            } catch (error) {
              // Resources have no `isError` channel — surface it as a protocol
              // error instead.
              throw toAppError(error);
            }
          },
        );
      },
    },

    {
      name: "ondc-payload",
      register(server: McpServer): void {
        server.registerResource(
          "ondc-payload",
          new ResourceTemplate("ondc://payload/{payloadId}", {
            list: undefined,
          }),
          {
            title: "Recorded payload",
            description:
              "The full body of one recorded call. Large by nature — prefer " +
              "record_get_payload, which can slice it with a JSONPath and caps " +
              "what it returns.",
            mimeType: MIME_JSON,
            cacheHint: { ttlMs: 60_000, cacheScope: "private" },
          },
          async (uri) => {
            try {
              const payloadId = decodeURIComponent(
                uri.pathname.replace(/^\/+/, ""),
              );
              const payload = await records.requirePayload(payloadId);

              return jsonContents(uri, {
                payload_id: payload.payloadId,
                transaction_id: payload.transactionId,
                action: payload.action,
                direction: payload.direction,
                message_id: payload.messageId,
                timestamp: payload.timestamp,
                body: payload.body,
                ...(payload.ackBody !== undefined
                  ? { ack: payload.ackBody }
                  : {}),
                ...(payload.httpStatus !== undefined
                  ? { http_status: payload.httpStatus }
                  : {}),
              });
            } catch (error) {
              throw toAppError(error);
            }
          },
        );
      },
    },
  ];
}
