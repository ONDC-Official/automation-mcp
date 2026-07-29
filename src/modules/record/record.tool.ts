import jsonpath from "jsonpath";
import { defineTool, type Registerable } from "@/lib/define-tool.js";
import { ValidationError } from "@/lib/errors.js";
import type { RecordService } from "@/modules/record/record.service.js";
import {
  GetDataInput,
  GetDataOutput,
  GetPayloadInput,
  GetPayloadOutput,
} from "@/modules/record/record.schema.js";
import type { SessionService } from "@/modules/session/session.service.js";

/**
 * Reading back what happened — the model's window onto the ledger.
 *
 * Both tools exist mainly to **keep large things out of context**. A real
 * `on_search` catalog is hundreds of kilobytes and resolved form HTML is worse;
 * either one pasted into a tool result would evict everything the model needs to
 * actually drive the flow. So bodies are addressed by handle, sliceable by
 * JSONPath, and capped by default, and the caps announce themselves so a
 * truncated answer is never mistaken for a complete one.
 */

/** Default ceiling on a returned body. Generous for a payload, cheap for context. */
const DEFAULT_MAX_BYTES = 20_000;

/** Business-data values above this are described rather than returned. */
const DATA_VALUE_LIMIT = 4_000;

export function renderPayload(
  output: GetPayloadOutput,
  serialised: string,
): string {
  const arrow = output.direction === "outbound" ? "→ sent" : "← received";
  const head = [
    `${output.action} ${arrow} at ${output.timestamp}`,
    `  message_id ${output.message_id} · ${String(output.size_bytes)} bytes stored`,
  ];
  if (output.truncated) {
    head.push(
      "  TRUNCATED — pass a jsonpath to narrow this, or raise max_bytes.",
    );
  }
  return [...head, "", serialised].join("\n");
}

export function createRecordTools(
  records: RecordService,
  sessions: SessionService,
): Registerable[] {
  return [
    defineTool({
      name: "record_get_payload",
      title: "Read a recorded payload",
      description:
        "Fetch a payload this session sent or received, by the handle reported " +
        "in flow_get_status or flow_await. Payload bodies are held server-side " +
        "and can be very large — a catalog runs to hundreds of kilobytes — so " +
        "prefer a jsonpath slice (e.g. $.message.catalog.providers[*].id) over " +
        "the whole body. The result says whether it was truncated.",
      inputSchema: GetPayloadInput,
      outputSchema: GetPayloadOutput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      render: (output) =>
        renderPayload(output, JSON.stringify(output.payload, null, 2)),
      handler: async (input) => {
        // Resolving the session is the authorisation check: a payload handle
        // is a bare uuid, and without this any session could read any other's.
        await sessions.requireSession(input.session_id);
        const payload = await records.requirePayload(input.payload_id);

        const full = JSON.stringify(payload.body ?? null);
        const sizeBytes = Buffer.byteLength(full, "utf8");

        let selected: unknown = payload.body;
        if (input.jsonpath !== undefined) {
          try {
            selected = jsonpath.query(
              payload.body ?? {},
              input.jsonpath,
            ) as unknown[];
          } catch (error) {
            throw new ValidationError(
              `"${input.jsonpath}" is not a valid JSONPath: ${
                error instanceof Error ? error.message : String(error)
              }`,
              { jsonpath: input.jsonpath },
            );
          }
        }

        const limit = input.max_bytes ?? DEFAULT_MAX_BYTES;
        const serialised = JSON.stringify(selected ?? null);
        const truncated = Buffer.byteLength(serialised, "utf8") > limit;

        return {
          payload_id: payload.payloadId,
          action: payload.action,
          direction: payload.direction,
          message_id: payload.messageId,
          timestamp: payload.timestamp,
          size_bytes: sizeBytes,
          truncated,
          payload: truncated
            ? `${serialised.slice(0, limit)}… [truncated at ${String(limit)} bytes]`
            : selected,
          ...(payload.ackBody !== undefined ? { ack: payload.ackBody } : {}),
        };
      },
    }),

    defineTool({
      name: "record_get_data",
      title: "Read a transaction's business data",
      description:
        "The values a flow has accumulated across its steps — provider ids, " +
        "order ids, form submission ids — as the mock config saved them. This " +
        "is what the next step's payload is generated from, so read it when a " +
        "step reports missing requirements. Large values (resolved form HTML) " +
        "are listed under 'omitted' rather than returned; ask for one by name.",
      inputSchema: GetDataInput,
      outputSchema: GetDataOutput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      render: ({ transaction_id, data, omitted }) => {
        const entries = Object.entries(data);
        const lines = [`business data for ${transaction_id}`];
        if (entries.length === 0) {
          lines.push("  (nothing saved yet)");
        }
        for (const [key, value] of entries) {
          lines.push(`  ${key} = ${JSON.stringify(value)}`);
        }
        for (const entry of omitted) {
          lines.push(
            `  ${entry.key} — ${String(entry.size_bytes)} bytes, omitted (request it by name)`,
          );
        }
        return lines.join("\n");
      },
      handler: async (input) => {
        const session = await sessions.requireSession(input.session_id);
        // Asserts the transaction exists and belongs to this counterparty.
        await records.requireTransaction(
          input.transaction_id,
          session.np.subscriber_url,
        );

        const stored = await records.getBusinessData(
          input.transaction_id,
          session.np.subscriber_url,
        );

        const data: Record<string, unknown> = {};
        const omitted: { key: string; size_bytes: number }[] = [];
        const wanted = input.keys;

        for (const [key, value] of Object.entries(stored)) {
          if (wanted !== undefined && !wanted.includes(key)) continue;

          const size = Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
          // An explicit request for a key overrides the size guard — that is
          // the only way to read resolved form HTML back out.
          if (size > DATA_VALUE_LIMIT && wanted === undefined) {
            omitted.push({ key, size_bytes: size });
            continue;
          }
          data[key] = value;
        }

        return { transaction_id: input.transaction_id, data, omitted };
      },
    }),
  ];
}
