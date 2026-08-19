import type { Logger } from "pino";
import type { CatalogService } from "@/modules/catalog/catalog.service.js";
import type { FlowService } from "@/modules/flow/flow.service.js";
import type { RecordService } from "@/modules/record/record.service.js";
import type { SessionEvent } from "@/modules/record/record.schema.js";
import type { Session } from "@/modules/session/session.schema.js";
import type { SessionService } from "@/modules/session/session.service.js";
import type {
  UiFlowResponse,
  UiPayloadResponse,
  UiRun,
  UiSession,
} from "@/modules/ui/ui.schema.js";
import type { z } from "zod";

/**
 * The read model behind the viewer.
 *
 * Assembly only: every fact here already exists on another service, and this
 * file's job is to gather them into one answer per screen so the page does not
 * make six calls to render a header. It writes nothing, and that is a property
 * worth stating rather than assuming — see `readEvents` below.
 *
 * ## What it must never do
 *
 * **Never `RecordService#drainEvents`.** That advances
 * `journal_cursor::{sessionId}`, which belongs to the *model*: it is how the
 * `events` block on every tool result knows what has not been delivered yet. A
 * viewer that drained it would consume the model's notifications, and the
 * symptom would be a model that stops hearing about callbacks while a human
 * watches them arrive on screen. `readEvents(sessionId, afterSeq)` is
 * cursor-neutral and exists for exactly this; `MirrorService` carries the same
 * prohibition for the same reason.
 *
 * The viewer is also **invisible to the model** — no tool, no resource, no line
 * in `capabilities.ts`. It is not part of the transaction, and a model that
 * could see it would start reasoning about it.
 */

export interface UiServiceOptions {
  sessions: SessionService;
  catalog: CatalogService;
  flows: FlowService;
  records: RecordService;
  logger: Logger;
}

/** How many sessions the landing list answers with. */
export const UI_SESSION_LIST_LIMIT = 50;

export class UiService {
  readonly #sessions: SessionService;
  readonly #catalog: CatalogService;
  readonly #flows: FlowService;
  readonly #records: RecordService;
  readonly #logger: Logger;

  constructor(options: UiServiceOptions) {
    this.#sessions = options.sessions;
    this.#catalog = options.catalog;
    this.#flows = options.flows;
    this.#records = options.records;
    this.#logger = options.logger;
  }

  async listSessions(): Promise<{ sessions: UiSession[] }> {
    const sessions = await this.#sessions.recentSessions(UI_SESSION_LIST_LIMIT);
    return { sessions: sessions.map(toUiSession) };
  }

  async session(sessionId: string): Promise<{
    session: UiSession;
    flows: Awaited<ReturnType<CatalogService["listFlows"]>>;
    runs: UiRun[];
    transaction_ids: string[];
    seq: number;
  }> {
    const session = await this.#sessions.requireSession(sessionId);

    const [flows, bindings, transactionIds, seq] = await Promise.all([
      this.#catalog.listFlows(session.build, session.mock_role),
      this.#flows.listRuns(sessionId),
      this.#records.listTransactionIds(sessionId),
      this.#journalSeq(sessionId),
    ]);

    const runs = await Promise.all(
      bindings.map((binding) => this.#summariseRun(sessionId, binding)),
    );

    return {
      session: toUiSession(session),
      flows,
      runs,
      transaction_ids: transactionIds,
      seq,
    };
  }

  async flow(
    sessionId: string,
    flowId: string,
  ): Promise<z.infer<typeof UiFlowResponse>> {
    const view = await this.#flows.flowView(sessionId, { flowId });
    const { next } = view;

    return {
      ...view.header,
      reference_data_keys: view.referenceDataKeys,
      map: view.map,
      // Narrowed rather than passed whole: `StepOutcome` carries `ack_body`,
      // `inputs_required` and a generated `payload_id`, none of which this
      // screen renders — and the first of those is a payload body arriving
      // through a route that does not say it serves one.
      next: {
        outcome: next.outcome,
        message: next.message,
        ...(next.step_key !== undefined ? { step_key: next.step_key } : {}),
        ...(next.action !== undefined ? { action: next.action } : {}),
        ...(next.expected_action !== undefined
          ? { expected_action: next.expected_action }
          : {}),
        ...(next.reason !== undefined ? { reason: next.reason } : {}),
      },
    };
  }

  /**
   * One stored payload.
   *
   * Scoped under a session and resolved through it first, because a
   * `payload_id` is a bare uuid with no session in it — the same
   * authorisation shape `record_get_payload` uses. The session read is the
   * check; the payload is only served once it has passed.
   */
  async payload(
    sessionId: string,
    payloadId: string,
  ): Promise<z.infer<typeof UiPayloadResponse>> {
    await this.#sessions.requireSession(sessionId);
    const payload = await this.#records.requirePayload(payloadId);

    return {
      payload_id: payload.payloadId,
      transaction_id: payload.transactionId,
      action: payload.action,
      direction: payload.direction,
      message_id: payload.messageId,
      timestamp: payload.timestamp,
      ...(payload.httpStatus !== undefined
        ? { http_status: payload.httpStatus }
        : {}),
      req: payload.body,
      res: { response: payload.ackBody },
    };
  }

  async businessData(
    sessionId: string,
    transactionId: string,
  ): Promise<{ transaction_id: string; data: Record<string, unknown> }> {
    const session = await this.#sessions.requireSession(sessionId);
    return {
      transaction_id: transactionId,
      data: await this.#records.getBusinessData(
        transactionId,
        session.np.subscriber_url,
      ),
    };
  }

  /**
   * The journal since `afterSeq`, without consuming it.
   *
   * The session read is again the authorisation check, and it comes first so a
   * bad id answers 404 rather than an empty list.
   */
  async events(
    sessionId: string,
    afterSeq: number,
  ): Promise<{ events: SessionEvent[]; seq: number }> {
    await this.#sessions.requireSession(sessionId);
    const events = await this.#records.readEvents(sessionId, afterSeq);
    return { events, seq: events.at(-1)?.seq ?? afterSeq };
  }

  /**
   * Where the journal has got to, for a caller that wants to stream from now.
   *
   * Derived from the entries rather than read from `journal_seq`, because that
   * counter is reserved *before* the append — so a value read from it can name
   * a line no reader can see yet, and a stream told to start there would skip
   * it.
   */
  async #journalSeq(sessionId: string): Promise<number> {
    const events = await this.#records.readEvents(sessionId, 0);
    return events.at(-1)?.seq ?? 0;
  }

  /**
   * A run reduced to what a list row shows.
   *
   * Reading a run means loading its mock config, and a config the catalog can
   * no longer serve throws. One such run must not blank the whole list — the
   * others are exactly what somebody opening this page is trying to see — so
   * the failure is reported on the row and logged, not raised.
   */
  async #summariseRun(
    sessionId: string,
    binding: {
      flowId: string;
      transactionId?: string | undefined;
      attempt: number;
      startedAt: string;
      autoAdvance: boolean;
    },
  ): Promise<UiRun> {
    const base = {
      flow_id: binding.flowId,
      transaction_id: binding.transactionId ?? null,
      attempt: binding.attempt,
      started_at: binding.startedAt,
      auto_advance: binding.autoAdvance,
    };

    try {
      const view = await this.#flows.flowView(sessionId, {
        flowId: binding.flowId,
      });
      return {
        ...base,
        transaction_id: view.header.transaction_id,
        flow_status: view.header.flow_status,
        steps_total: view.map.sequence.length,
        steps_complete: view.map.sequence.filter(
          (step) => step.status === "COMPLETE",
        ).length,
        next_outcome: view.next.outcome,
        next_message: view.next.message,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.warn(
        { session_id: sessionId, flow_id: binding.flowId, err: message },
        "viewer: could not read run",
      );
      return { ...base, error: message };
    }
  }
}

function toUiSession(session: Session): UiSession {
  return {
    session_id: session.session_id,
    created_at: session.created_at,
    expires_at: session.expires_at,
    np: {
      subscriber_url: session.np.subscriber_url,
      ...(session.np.subscriber_id !== undefined
        ? { subscriber_id: session.np.subscriber_id }
        : {}),
      type: session.np.type,
    },
    mock_role: session.mock_role,
    build: session.build,
    interaction_mode: session.interaction_mode,
    auto_advance: session.auto_advance,
    callback_url: session.callback_url,
  };
}
