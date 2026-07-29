import jsonpath from "jsonpath";
import { defineTool, type Registerable } from "@/lib/define-tool.js";
import { ValidationError } from "@/lib/errors.js";
import type { RecordService } from "@/modules/record/record.service.js";
import {
  GetDataInput,
  GetDataOutput,
  GetEventsInput,
  GetEventsOutput,
  GetPayloadInput,
  GetPayloadOutput,
  type EventsDelta,
  type SessionEvent,
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

/** Default page size for an explicit journal read. */
const DEFAULT_EVENT_LIMIT = 50;

/* -------------------------------------------------------------------------- */
/* Piggyback delivery                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Drain the session's journal into the shape every tool result spreads.
 *
 * Called **after** a tool's real work, never before — so a `flow_proceed` that
 * sends a payload reports its own send, and a `flow_await` that unblocks on a
 * callback reports the callback it unblocked on. Draining first would deliver
 * every result one call late, which for the tool that exists to tell you
 * something arrived is the same as not delivering it.
 *
 * Lives here, next to the journal it reads, and is imported by the other tool
 * modules the way they already import `renderOutcome` from `flow.tool.ts`.
 * Never throws: `drainEvents` swallows its own failures, because a journal
 * problem must not become a failed `flow_proceed`.
 */
export async function eventsFor(
  records: RecordService,
  sessionId: string,
): Promise<{ events?: EventsDelta }> {
  const delta = await records.drainEvents(sessionId);
  return delta ? { events: delta } : {};
}

/** One journal line, as the model reads it. */
export function renderEvent(event: SessionEvent): string {
  const tail = [
    ...(event.nack_code !== undefined ? [event.nack_code] : []),
    ...(event.payload_id !== undefined
      ? [`payload ${event.payload_id}`]
      : []),
  ].join(" · ");
  return `  • ${event.kind}${tail === "" ? "" : ` [${tail}]`} — ${event.summary}`;
}

/**
 * The events block appended to every rendered tool result.
 *
 * Returns an empty array rather than an empty string so callers can splice it
 * into their own line list without deciding whether a blank line is wanted.
 */
export function renderEvents(delta: EventsDelta | undefined): string[] {
  if (delta === undefined || delta.events.length === 0) return [];
  return [
    "",
    `since your last call (${String(delta.events.length)} event${
      delta.events.length === 1 ? "" : "s"
    }${delta.more > 0 ? `, ${String(delta.more)} more — call record_get_events` : ""}):`,
    ...delta.events.map(renderEvent),
  ];
}

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
        [
          renderPayload(output, JSON.stringify(output.payload, null, 2)),
          ...renderEvents(output.events),
        ].join("\n"),
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
          ...(await eventsFor(records, input.session_id)),
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
      render: ({ transaction_id, data, omitted, events }) => {
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
        lines.push(...renderEvents(events));
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

        return {
          transaction_id: input.transaction_id,
          data,
          omitted,
          ...(await eventsFor(records, input.session_id)),
        };
      },
    }),

    defineTool({
      name: "record_get_events",
      title: "Re-read the session event journal",
      description:
        "Read this session's event journal without consuming it. You do not " +
        "normally need this: every session-scoped tool result already carries " +
        "the events since your last call, delivered once each. Reach for it " +
        "when a result said `more` was outstanding, when you want to re-read " +
        "something already delivered, or to recover a delta lost to an error — " +
        "reading here never moves the delivery cursor, so it cannot consume " +
        "what piggyback has not yet shown you.",
      inputSchema: GetEventsInput,
      outputSchema: GetEventsOutput,
      annotations: {
        // Genuinely read-only: cursor-neutral by design, which is the entire
        // reason this tool can be used to recover from a lost delta.
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      render: ({ events, more, delivered_through }) => {
        if (events.length === 0) {
          return `no events past seq ${String(delivered_through)} in this session's journal`;
        }
        return [
          `${String(events.length)} event(s)${more > 0 ? `, ${String(more)} more` : ""} · delivered through seq ${String(delivered_through)}`,
          ...events.map(
            (event) => `${String(event.seq).padStart(4)} ${event.at}\n${renderEvent(event)}`,
          ),
        ].join("\n");
      },
      handler: async (input) => {
        await sessions.requireSession(input.session_id);

        const matching = await records.readEvents(
          input.session_id,
          input.since_seq ?? 0,
        );
        const limit = input.limit ?? DEFAULT_EVENT_LIMIT;

        return {
          events: matching.slice(0, limit),
          more: Math.max(0, matching.length - limit),
          delivered_through: await records.eventCursor(input.session_id),
        };
      },
    }),
  ];
}
