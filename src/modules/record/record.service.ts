import { randomUUID } from "node:crypto";
import jsonpath from "jsonpath";
import type { Logger } from "pino";
import type {
  TransactionEvent,
  TransactionEventKind,
  TransactionEvents,
} from "@/lib/events/transaction-events.js";
import { NotFoundError } from "@/lib/errors.js";
import type { MockEngine } from "@/lib/mock-engine/mock-engine.js";
import type { NpType } from "@/modules/catalog/catalog.schema.js";
import {
  transactionKey,
  type RecordRepository,
} from "@/modules/record/record.repository.js";
import type {
  ApiEntry,
  Attention,
  Direction,
  FormEntry,
  PayloadRecord,
  TransactionRecord,
} from "@/modules/record/record.schema.js";

/**
 * The transaction ledger: what was exchanged, and what was learned from it.
 *
 * Imports nothing from the MCP SDK. Two responsibilities, and they are
 * genuinely different:
 *
 * 1. **Append an exchange.** Assign it a `seq`, store its body out of line,
 *    keep the slim entry on the record, then wake anyone waiting. Ordering
 *    matters: the record must be durable *before* the notification fires, or a
 *    waiter can be told about work it then fails to find.
 * 2. **Merge business data.** Run the step's `saveData` config against the
 *    payload and fold the results into the transaction's accumulated data —
 *    this is what carries a provider id from `on_search` into `select`.
 */

export interface RecordServiceOptions {
  repository: RecordRepository;
  events: TransactionEvents;
  /** Needed only for `EVAL#` save expressions, which run in the sandbox. */
  mockEngine: MockEngine;
  logger: Logger;
}

export interface CreateTransactionInput {
  transactionId: string;
  sessionId: string;
  flowId: string;
  /** The **participant under test's** side. */
  subscriberType: NpType;
  subscriberUrl: string;
  autoAdvance?: boolean;
}

export interface AppendApiEntryInput {
  transactionId: string;
  subscriberUrl: string;
  action: string;
  messageId: string;
  direction: Direction;
  /** `context.timestamp` from the payload — replay orders on this. */
  timestamp: string;
  body: unknown;
  /** The ACK/NACK exchanged for this call. */
  ackBody?: unknown;
  httpStatus?: number;
  /** Event kind to publish. Defaults from `direction`. */
  eventKind?: TransactionEventKind;
}

export interface AppendFormEntryInput {
  transactionId: string;
  subscriberUrl: string;
  formId: string;
  formType: FormEntry["formType"];
  submissionId?: string;
  error?: string;
}

export interface AppendResult {
  record: TransactionRecord;
  seq: number;
  payloadId?: string;
}

export class RecordService {
  readonly #repository: RecordRepository;
  readonly #events: TransactionEvents;
  readonly #mockEngine: MockEngine;
  readonly #logger: Logger;

  constructor(options: RecordServiceOptions) {
    this.#repository = options.repository;
    this.#events = options.events;
    this.#mockEngine = options.mockEngine;
    this.#logger = options.logger;
  }

  /* ----------------------------- transactions ----------------------------- */

  async createTransaction(
    input: CreateTransactionInput,
    now: Date = new Date(),
  ): Promise<TransactionRecord> {
    const record: TransactionRecord = {
      transactionId: input.transactionId,
      sessionId: input.sessionId,
      flowId: input.flowId,
      subscriberType: input.subscriberType,
      subscriberUrl: input.subscriberUrl,
      latestAction: "",
      latestTimestamp: now.toISOString(),
      messageIds: [],
      apiList: [],
      seq: 0,
      createdAt: now.toISOString(),
      autoAdvance: input.autoAdvance ?? false,
    };

    await this.#repository.saveTransaction(record);
    await this.#repository.indexTransaction(
      input.sessionId,
      input.transactionId,
    );
    return record;
  }

  findTransaction(
    transactionId: string,
    subscriberUrl: string,
  ): Promise<TransactionRecord | undefined> {
    return this.#repository.findTransaction(transactionId, subscriberUrl);
  }

  /**
   * @throws {NotFoundError} on the tool channel — the model can start a new
   * flow rather than being told the transport failed.
   */
  async requireTransaction(
    transactionId: string,
    subscriberUrl: string,
  ): Promise<TransactionRecord> {
    const record = await this.#repository.findTransaction(
      transactionId,
      subscriberUrl,
    );
    if (!record) {
      throw new NotFoundError("transaction", transactionId, {
        subscriber_url: subscriberUrl,
        hint: "Transactions expire after 48h. Call flow_start to begin a new one.",
      });
    }
    return record;
  }

  listTransactionIds(sessionId: string): Promise<string[]> {
    return this.#repository.listTransactionIds(sessionId);
  }

  /* ------------------------------- appending ------------------------------ */

  /**
   * Record one protocol call, in both directions.
   *
   * The body goes to its own key and only its handle stays on the record. A
   * flow accumulates a dozen exchanges and an `on_search` catalog alone can run
   * to hundreds of kilobytes — inlining them would make every status read
   * deserialise the whole transaction.
   */
  async appendApiEntry(input: AppendApiEntryInput): Promise<AppendResult> {
    const record = await this.requireTransaction(
      input.transactionId,
      input.subscriberUrl,
    );

    const seq = record.seq + 1;
    const payloadId = randomUUID();

    const payload: PayloadRecord = {
      payloadId,
      transactionId: input.transactionId,
      subscriberUrl: input.subscriberUrl,
      direction: input.direction,
      action: input.action,
      messageId: input.messageId,
      timestamp: input.timestamp,
      body: input.body,
      ...(input.ackBody !== undefined ? { ackBody: input.ackBody } : {}),
      ...(input.httpStatus !== undefined
        ? { httpStatus: input.httpStatus }
        : {}),
    };
    await this.#repository.savePayload(payload);

    const entry: ApiEntry = {
      entryType: "API",
      action: input.action,
      payloadId,
      messageId: input.messageId,
      response: input.ackBody,
      timestamp: input.timestamp,
      seq,
      direction: input.direction,
    };

    const updated: TransactionRecord = {
      ...record,
      apiList: [...record.apiList, entry],
      latestAction: input.action,
      latestTimestamp: input.timestamp,
      messageIds: record.messageIds.includes(input.messageId)
        ? record.messageIds
        : [...record.messageIds, input.messageId],
      seq,
    };
    await this.#repository.saveTransaction(updated);

    this.#publish(updated, {
      seq,
      kind:
        input.eventKind ??
        (input.direction === "inbound" ? "INBOUND" : "OUTBOUND"),
      action: input.action,
      payload_id: payloadId,
    });

    return { record: updated, seq, payloadId };
  }

  /** Record a form submission. Forms carry no protocol payload. */
  async appendFormEntry(input: AppendFormEntryInput): Promise<AppendResult> {
    const record = await this.requireTransaction(
      input.transactionId,
      input.subscriberUrl,
    );

    const seq = record.seq + 1;
    const timestamp = new Date().toISOString();

    const entry: FormEntry = {
      entryType: "FORM",
      formType: input.formType,
      formId: input.formId,
      ...(input.submissionId !== undefined
        ? { submissionId: input.submissionId }
        : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      timestamp,
      seq,
    };

    const updated: TransactionRecord = {
      ...record,
      apiList: [...record.apiList, entry],
      latestAction: input.formType,
      latestTimestamp: timestamp,
      seq,
    };
    await this.#repository.saveTransaction(updated);

    this.#publish(updated, {
      seq,
      kind: "FORM_SUBMITTED",
      action: input.formId,
      ...(input.error !== undefined ? { detail: input.error } : {}),
    });

    return { record: updated, seq };
  }

  /**
   * Note why the loop stopped, so the reason outlives the call that produced it.
   *
   * Auto-advance runs after the ACK has already gone out — there is nobody left
   * to return to. Without this the model's next `flow_get_status` would show a
   * stalled flow and no explanation.
   */
  async setAttention(
    transactionId: string,
    subscriberUrl: string,
    attention: Attention | undefined,
  ): Promise<void> {
    const record = await this.requireTransaction(transactionId, subscriberUrl);
    const updated: TransactionRecord =
      attention === undefined
        ? { ...record, attention: undefined }
        : { ...record, attention };
    await this.#repository.saveTransaction(updated);
  }

  /** Publish an event that carries no new entry — a chain pause, say. */
  publishEvent(
    record: TransactionRecord,
    event: Omit<TransactionEvent, "seq">,
  ): void {
    this.#publish(record, { ...event, seq: record.seq });
  }

  #publish(record: TransactionRecord, event: TransactionEvent): void {
    this.#events.notify(
      transactionKey(record.transactionId, record.subscriberUrl),
      event,
    );
  }

  /* ---------------------------- business data ----------------------------- */

  getBusinessData(
    transactionId: string,
    subscriberUrl: string,
  ): Promise<Record<string, unknown>> {
    return this.#repository.getBusinessData(transactionId, subscriberUrl);
  }

  /** Replace business data wholesale. Used when the receiver resolves a form. */
  overwriteBusinessData(
    transactionId: string,
    subscriberUrl: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    return this.#repository.saveBusinessData(
      transactionId,
      subscriberUrl,
      data,
    );
  }

  /**
   * Fold a payload into the transaction's business data, per the step's
   * `saveData` config.
   *
   * Ported from the workbench (`workbench-cache.ts:getUpdatedData`) including
   * its quirks, because the config JavaScript is written against exactly these:
   *
   * - **Five context paths are injected on every save.** `latestMessage_id`,
   *   `bapUri`, `bppUri`, `bppId`, `bapId` are how a response step learns which
   *   message it is answering and whom to address. Configs assume they are
   *   there; a config that also declares one simply overrides it.
   * - **`APPEND#key` concatenates** instead of replacing — for the steps that
   *   repeat, where each occurrence adds to a list.
   * - **`EVAL#<base64>` runs code** in the sandbox instead of a JSONPath, for
   *   the saves a path cannot express.
   * - **Values are arrays.** `jsonpath.query` always returns a list, so
   *   `providerId` is `["p1"]`, not `"p1"`. Every config unwraps accordingly.
   * - **A failing key is skipped, not fatal.** One unsatisfiable path must not
   *   cost the whole step its saved data.
   */
  async saveBusinessData(
    transactionId: string,
    subscriberUrl: string,
    payload: unknown,
    saveDataConfig: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const data = await this.#repository.getBusinessData(
      transactionId,
      subscriberUrl,
    );

    const config: Record<string, string> = {
      ...saveDataConfig,
      latestMessage_id: "$.context.message_id",
      bapUri: "$.context.bap_uri",
      bppUri: "$.context.bpp_uri",
      bppId: "$.context.bpp_id",
      bapId: "$.context.bap_id",
    };

    for (const [key, path] of Object.entries(config)) {
      try {
        if (typeof path !== "string" || path.length === 0) continue;

        const appendMode = key.startsWith("APPEND#");
        const evalMode = path.startsWith("EVAL#");
        // `APPEND#providerId` saves under `providerId`.
        const actualKey = key.split("#").pop() ?? key;
        const actualPath = evalMode ? (path.split("#")[1] ?? "") : path;

        const result = evalMode
          ? (await this.#mockEngine.runGetSave(payload, actualPath)).result
          : jsonpath.query(payload as object, actualPath);

        if (appendMode) {
          const current = Array.isArray(data[actualKey])
            ? (data[actualKey] as unknown[])
            : [];
          data[actualKey] = [
            ...current,
            ...(Array.isArray(result) ? result : [result]),
          ];
        } else {
          data[actualKey] = result;
        }
      } catch (error) {
        this.#logger.warn(
          { transactionId, key, path, err: error },
          "skipped a save-data key",
        );
      }
    }

    await this.#repository.saveBusinessData(
      transactionId,
      subscriberUrl,
      data,
    );
    return data;
  }

  /* ------------------------------- payloads ------------------------------- */

  async requirePayload(payloadId: string): Promise<PayloadRecord> {
    const payload = await this.#repository.findPayload(payloadId);
    if (!payload) {
      throw new NotFoundError("payload", payloadId, {
        hint: "Payload handles come from flow_get_status and flow_await, and expire with the transaction.",
      });
    }
    return payload;
  }
}
