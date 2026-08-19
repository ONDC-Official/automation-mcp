import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import {
  installId,
  pseudonymise,
  scrubProse,
} from "@/modules/feedback/feedback.redact.js";
import type { Correlation } from "@/modules/feedback/feedback.schema.js";
import type { SessionEvent } from "@/modules/record/record.schema.js";
import type { SessionEventObserver } from "@/modules/record/record.service.js";
import type { Session } from "@/modules/session/session.schema.js";
import {
  MIRROR_SCHEMA_VERSION,
  MIRROR_SUMMARY_LIMIT,
  type MirrorKind,
  type MirrorRecord,
} from "@/modules/mirror/mirror.schema.js";
import type { MirrorSink } from "@/modules/mirror/mirror.sink.js";

/**
 * A live feed of what this mock is doing, for a sibling service.
 *
 * Three taps, and the third is the one that is easy to argue away:
 *
 * 1. **The journal**, through `RecordService`'s observer list. Covers all
 *    thirteen `SessionEventKind`s, which is most of what happens.
 * 2. **`SessionService.createSession`**, because a session's existence — and
 *    especially its `expires_at` — is not a journal line. `CacheStore` expiry
 *    is silent by design and has no eviction callback, so `expires_at` is the
 *    only way a consumer can ever know a session ended.
 * 3. **`FlowService.start`**, because **nothing journals a run opening.**
 *    `flow_start` deliberately persists no transaction, so there is no
 *    `TRANSACTION_BOUND` yet — and there may never be one: a run that opens and
 *    is immediately `BLOCKED` is the single most interesting row in a triage
 *    corpus and produces no journal line at all. The alternative, adding a
 *    `FLOW_STARTED` journal kind, was rejected: the journal is **model-facing**
 *    and sized for a tool result, and the model just called `flow_start` and is
 *    holding the answer. Telemetry is not a reason to spend a line of its
 *    context. The emit is from the *service* and not from
 *    `FlowRepository.saveBinding`, because telemetry out of a data-access layer
 *    is a layering smell that gets worse every time it is repeated.
 *
 * ## Two things this must never do
 *
 * - **Never call `RecordService#journal`.** It observes the journal; writing to
 *   it would recurse until the process dies. `FeedbackService` needs an
 *   explicit `ISSUE_OPEN` skip for exactly this reason — the mirror needs no
 *   such guard *precisely because* it holds no journal writer, and that is a
 *   property worth keeping rather than a coincidence to be optimised away.
 * - **Never call `drainEvents`.** That advances the MCP client's delivery
 *   cursor, and the model would silently stop being told what happened on the
 *   wire. `readEvents` exists for cursor-neutral reads; the mirror needs
 *   neither, because the observer hands it every line as it is written.
 *
 * ## Redaction
 *
 * Structural fields go verbatim: `payload_id` is a handle, `overrides` are
 * JSONPaths (a path says where a value is, never what it was), and ack codes
 * and actions are protocol vocabulary. `summary` is the one free-text field and
 * goes through `scrubProse`, exactly as `FeedbackService#renderReport` does to
 * the same strings.
 */

export interface MirrorServiceOptions {
  sink: MirrorSink;
  /** Per-install HMAC salt. The same one `feedback` uses, so pseudonyms join. */
  salt: string;
  /** `TELEMETRY_CORRELATION`. Adds one key and changes nothing else. */
  correlation?: boolean;
  logger: Logger;
  /** Injectable clock, so a test can assert on `emitted_at`. */
  now?: () => Date;
  /** Injectable, so a test can assert `instance_id` is stable per process. */
  instanceId?: string;
}

export class MirrorService implements SessionEventObserver {
  readonly #sink: MirrorSink;
  readonly #salt: string;
  readonly #correlation: boolean;
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #installId: string;
  readonly #instanceId: string;

  constructor(options: MirrorServiceOptions) {
    this.#sink = options.sink;
    this.#salt = options.salt;
    this.#correlation = options.correlation ?? false;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.#installId = installId(options.salt);
    this.#instanceId = options.instanceId ?? randomUUID();
  }

  /* --------------------------------- taps --------------------------------- */

  /** Tap one: every journal line, as it is written. */
  onSessionEvent(sessionId: string, event: SessionEvent): void {
    this.#emit(sessionId, "JOURNAL", event.transaction_id, {
      event: {
        seq: event.seq,
        at: event.at,
        kind: event.kind,
        ...(event.flow_id !== undefined ? { flow_id: event.flow_id } : {}),
        ...(event.transaction_id !== undefined
          ? { transaction_id: event.transaction_id }
          : {}),
        ...(event.action !== undefined ? { action: event.action } : {}),
        ...(event.ack !== undefined ? { ack: event.ack } : {}),
        ...(event.nack_code !== undefined
          ? { nack_code: event.nack_code }
          : {}),
        ...(event.payload_id !== undefined
          ? { payload_id: event.payload_id }
          : {}),
        ...(event.overrides !== undefined
          ? { overrides: event.overrides }
          : {}),
        // The one hole, closed. A summary quotes a participant's NACK text and
        // mints transaction ids in plain prose; structural redaction cannot
        // reach a value inside a sentence.
        summary: scrubProse(event.summary, this.#salt, MIRROR_SUMMARY_LIMIT),
      },
    });
  }

  /** Tap two: a session was created. The only source of `expires_at`. */
  noteSessionCreated(session: Session): void {
    this.#emit(session.session_id, "SESSION_CREATED", undefined, {
      session: {
        domain: session.build.domain,
        version: session.build.version,
        ...(session.build.usecase !== undefined
          ? { usecase: session.build.usecase }
          : {}),
        mock_role: session.mock_role,
        np_type: session.np.type,
        // The same pseudonym `PSEUDONYM_KEYS` produces for `subscriber_url`, so
        // a mirror document and an issue report about one participant join.
        subscriber_ref: pseudonymise(session.np.subscriber_url, this.#salt, "np"),
        callback_url: session.callback_url,
        interaction_mode: session.interaction_mode,
        auto_advance: session.auto_advance,
        created_at: session.created_at,
        expires_at: session.expires_at,
      },
    });
  }

  /** Tap three: a run opened. See the header for why this is not a journal kind. */
  noteRunStarted(
    sessionId: string,
    run: {
      flowId: string;
      attempt: number;
      autoAdvance: boolean;
      startedAt: string;
    },
  ): void {
    this.#emit(sessionId, "RUN_STARTED", undefined, {
      run: {
        flow_id: run.flowId,
        attempt: run.attempt,
        auto_advance: run.autoAdvance,
        started_at: run.startedAt,
      },
    });
  }

  /* -------------------------------- private -------------------------------- */

  /**
   * Build one record and hand it to the sink.
   *
   * Absorbs everything. Two of the three taps are on somebody's hot path — the
   * journal tap after an ACK is decided, `createSession` inside a tool call —
   * and `RecordService` only guards the first of them. A mirror that threw
   * would turn our telemetry into the participant's recorded non-compliance,
   * which is the same contract `RecordService#journal` documents.
   */
  #emit(
    sessionId: string,
    kind: MirrorKind,
    transactionId: string | undefined,
    body: Pick<MirrorRecord, "session" | "run" | "event">,
  ): void {
    try {
      const correlation: Correlation | undefined = this.#correlation
        ? {
            session_id: sessionId,
            ...(transactionId !== undefined
              ? { transaction_id: transactionId }
              : {}),
          }
        : undefined;

      this.#sink.emit({
        schema_version: MIRROR_SCHEMA_VERSION,
        emitted_at: this.#now().toISOString(),
        install_id: this.#installId,
        instance_id: this.#instanceId,
        // Always present, always pseudonymised: it is the join key for every
        // record of one session, and it is one whether or not the clear id is.
        session_ref: pseudonymise(sessionId, this.#salt, "sess"),
        ...(correlation !== undefined ? { correlation } : {}),
        kind,
        ...body,
      });
    } catch (error) {
      this.#logger.warn(
        { err: error, session_id: sessionId, kind },
        "could not mirror a record; nothing else is affected",
      );
    }
  }

  /** Flush and stop. Called from `container.dispose()`. Never rejects. */
  close(): Promise<void> {
    return this.#sink.close();
  }
}
