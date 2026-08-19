import { randomUUID } from "node:crypto";
import type { MockRunner } from "@ondc/automation-mock-runner";
import type { MockPlaygroundConfigType } from "@ondc/automation-mock-runner";
import type { Logger } from "pino";
import {
  ConflictError,
  NotFoundError,
  UpstreamError,
  ValidationError,
} from "@/lib/errors.js";
import type {
  TransactionEvent,
  TransactionEvents,
} from "@/lib/events/transaction-events.js";
import type { Metrics } from "@/lib/metrics/metrics.js";
import type { MockEngine } from "@/lib/mock-engine/mock-engine.js";
import {
  checkInputs,
  describeInputs,
  type InputSpec,
  mockStepInputs,
  resolveInputSpec,
} from "@/modules/catalog/catalog.inputs.js";
import {
  actorFor,
  type CatalogService,
} from "@/modules/catalog/catalog.service.js";
import type {
  UpstreamFlow,
  UpstreamMockConfig,
} from "@/modules/catalog/catalog.schema.js";
import type {
  EngineFlow,
  EngineSequenceStep,
  FlowMap,
  FlowStatusCode,
  MappedStep,
} from "@/modules/flow/engine/engine-types.js";
import {
  getFlowCompleteStatus,
  getNextActions,
} from "@/modules/flow/engine/flow-mapper.js";
import { toEngineFlow } from "@/modules/flow/engine/to-engine-flow.js";
import {
  applyOverrides,
  suggestOverrides,
} from "@/modules/flow/flow.overrides.js";
import type { FlowRepository } from "@/modules/flow/flow.repository.js";
import {
  ATTEMPT_HISTORY_LIMIT,
  type FlowBinding,
  type FlowStatusOutput,
  type InputProblem,
  type MissedStep,
  type RunSummary,
  type StepOutcome,
} from "@/modules/flow/flow.schema.js";
import {
  flowRunKey,
  journalKey,
  transactionKey,
} from "@/modules/record/record.repository.js";
import {
  emptyTransactionRecord,
  type RecordService,
} from "@/modules/record/record.service.js";
import type {
  EventsDelta,
  ExpectationScope,
  HistoryEntry,
  SessionEvent,
  SessionEventKind,
  TransactionRecord,
} from "@/modules/record/record.schema.js";
import type { Session } from "@/modules/session/session.schema.js";
import {
  receiverScope,
  type SessionService,
} from "@/modules/session/session.service.js";
import {
  summariseFindings,
  type ValidationVerdict,
} from "@/modules/validate/validate.schema.js";
import type { ValidateService } from "@/modules/validate/validate.service.js";
import type {
  SenderService,
  SendResult,
} from "@/modules/transport/sender.service.js";

/**
 * The loop.
 *
 * Dispatch semantics are ported from the workbench's `process-flow.ts`, minus
 * its queue: everything here is synchronous, because the caller is a model that
 * asked a question and is waiting for the answer, not a UI polling a job id.
 *
 * ## One step per call
 *
 * The workbench dispatches every actionable target it finds — a sequence step
 * *and* any ready extras — in a single pass. This returns exactly one
 * `StepOutcome` instead. A model needs to know what just happened and what to
 * do next; "three things went out, one of them needs input" is not something it
 * can act on. Extras still fire, one call at a time, via `trigger_extra`.
 *
 * ## Forms are ordinary steps that happen to need a submission id
 *
 * A form step is complete once a `submission_id` exists for it. That is the
 * whole contract, and it is why `form_submit` needs no privileged path: it
 * calls `proceed` with `{submission_id}` like any other input.
 */

const FORM_TYPES = new Set(["HTML_FORM", "DYNAMIC_FORM", "HTML_FORM_MULTI"]);

/**
 * How many of a session's runs one session-scope wait will touch.
 *
 * Both the re-arm sweep and the `runs` summary load a flow per run, so this
 * bounds the work a single `flow_await` can do. A session with more runs than
 * this has bigger problems than an unswept expectation.
 */
const REARM_SWEEP_LIMIT = 20;

/**
 * Journal kinds a run-scoped wait ends on, because nothing else will report them.
 *
 * Every other kind describes an exchange that was appended to a transaction and
 * published on the run's own key, so the waiter is about to be woken properly —
 * with the event, rather than with "nothing arrived" a beat before something
 * did. These two have no such follow-up: `POSSIBLY_RELATED` is a call refused
 * before it could be attributed to any run (a 400, or a 412 that matched no
 * expectation), and `ATTENTION` is auto-advance saying it has stopped and will
 * not resume. Both used to leave a run-scoped waiter sitting out its full
 * budget with the answer already in the store.
 */
const DEAD_END_JOURNAL_KINDS = new Set<SessionEventKind>([
  "POSSIBLY_RELATED",
  "ATTENTION",
]);

/** What a wait answers with, in either scope. */
export interface AwaitResult {
  timedOut: boolean;
  scope: "run" | "session";
  transactionId: string | null;
  seq: number;
  event?: TransactionEvent | undefined;
  /** Run scope only — a session wait covers several runs. */
  next?: StepOutcome | undefined;
  /** Session scope only. */
  runs?: RunSummary[] | undefined;
  /**
   * Run scope only: the caller's `after_seq` was ahead of the record and was
   * pulled back to this. See `#effectiveAfterSeq` for why that is never a
   * cursor this run produced.
   */
  afterSeqAdjusted?: number | undefined;
  /**
   * Run scope only, and only when false: the call answered without parking
   * because the run owes the *caller* the next step.
   */
  waited?: boolean | undefined;
  /**
   * Session scope only: the journal drained as the wait's own exit condition.
   *
   * Returned rather than left for the tool's usual post-call drain, because
   * this branch has **already consumed** it — a second drain would find nothing
   * and the events the caller blocked for would vanish.
   */
  events?: EventsDelta | undefined;
}

export interface FlowServiceOptions {
  sessions: SessionService;
  catalog: CatalogService;
  records: RecordService;
  /** Flow runs and the transaction ids they eventually bind to. */
  repository: FlowRepository;
  sender: SenderService;
  mockEngine: MockEngine;
  events: TransactionEvents;
  /** The gate on the outbound path — L0 + L1 before anything reaches the wire. */
  validate: ValidateService;
  logger: Logger;
  /**
   * Base URL a participant can reach this mock's receiver on. Advertised as
   * `bap_uri`/`bpp_uri`, so a wrong value means callbacks go nowhere.
   */
  receiverPublicUrl: string;
  /** Registry-style id advertised as `bap_id`/`bpp_id`. */
  mockSubscriberId: string;
  /**
   * The incident corpus. Optional, and absent in most tests — a run must work
   * identically whether or not anybody is listening.
   */
  feedback?: FeedbackObserver;
  /** Optional, on the same terms. */
  metrics?: Metrics;
  /** Optional, on the same terms. */
  mirror?: RunMirror;
}

/**
 * The half of `MirrorService` this service uses.
 *
 * Declared here rather than imported, exactly as `FeedbackObserver` is: the
 * mirror watches the loop, the loop does not know about the mirror.
 */
export interface RunMirror {
  noteRunStarted(
    sessionId: string,
    run: {
      flowId: string;
      attempt: number;
      autoAdvance: boolean;
      startedAt: string;
    },
  ): void;
}

/**
 * The half of `FeedbackService` this service uses.
 *
 * Declared here rather than imported so `flow` does not depend on `feedback` —
 * the corpus watches the loop, the loop does not know about the corpus. Both
 * calls return `void`: capture is scheduled, never awaited, because a report is
 * never worth a millisecond of a participant's connection.
 */
export interface FeedbackObserver {
  noteOutcome(sessionId: string, flowId: string, outcome: StepOutcome): void;
  noteError(
    sessionId: string,
    flowId: string,
    error: unknown,
    context?: { stepKey?: string; action?: string; transactionId?: string },
  ): void;
}

export interface StartFlowArgs {
  sessionId: string;
  flowId: string;
  transactionId?: string | undefined;
  autoAdvance?: boolean | undefined;
}

/**
 * How a caller names a run: by the flow it is running, or by its transaction.
 *
 * Both are needed and neither subsumes the other. `flowId` is the only handle
 * that exists for the whole life of a run, because a run begins before its
 * `transaction_id` does. `transactionId` is the only handle that can name one
 * specific run when a session has several, and the only way back into a
 * transaction this process did not start.
 */
export interface FlowRef {
  transactionId?: string | undefined;
  flowId?: string | undefined;
}

/**
 * A restart names the **run**, never a transaction.
 *
 * A run is what is being restarted, and it may have no transaction id at all —
 * so `flow_id` is the only handle that always works here. Naming an id would
 * also be ambiguous the moment there are two: the one being abandoned, or the
 * one being opened.
 */
export interface RestartArgs {
  sessionId: string;
  flowId: string;
  /** Recorded against the abandoned attempt, for the report. */
  reason?: string | undefined;
}

export interface RestartResult {
  runtime: FlowRuntime;
  outcome: StepOutcome;
  autoAdvance: boolean;
  /** The attempt now open. Unchanged when there was nothing to abandon. */
  attempt: number;
  /** Null when the abandoned attempt never sent anything. */
  abandonedTransactionId: string | null;
}

export interface ProceedArgs extends FlowRef {
  sessionId: string;
  inputs?: Record<string, unknown> | undefined;
  triggerExtra?: string | undefined;
  dryRun?: boolean | undefined;
  /**
   * Patch the generated payload before it is validated and sent.
   *
   * Scoped to this call by construction — `chainNext` builds its own
   * `ProceedArgs` and never copies this, so a step nobody approved cannot
   * carry a patch nobody re-stated onto a third party's wire.
   */
  payloadOverrides?: Record<string, unknown> | undefined;
  /**
   * Internal: this call came from `chainNext`, not from the model.
   *
   * Only the journal cares, and it cares a lot — `CHAIN_SENT` means "this went
   * out while you were not looking", which is the entire reason auto-advance
   * can be a default. It is set here rather than journaled by `chainNext`
   * itself so a chained send produces exactly **one** line instead of an
   * `OUTBOUND_SENT` and a `CHAIN_SENT` describing the same payload.
   */
  chained?: boolean | undefined;
}

/**
 * Everything one turn of the loop needs, resolved once.
 *
 * `record` is a **real** record when `bound` is true and a throwaway one built
 * by `emptyTransactionRecord` when it is false. The engine cannot tell the
 * difference — an empty `apiList` maps to "cursor at step 0" either way — which
 * is what lets `flow_get_status` and `flow_await` answer for a run whose first
 * action has not crossed the wire. What must never happen is a write keyed on
 * an unbound record's provisional `transactionId`: nothing is stored under it,
 * and if the participant moves first it is not the id that ends up on the wire.
 */
export interface FlowRuntime {
  session: Session;
  record: TransactionRecord;
  binding: FlowBinding;
  /** Whether `record` is persisted, or a placeholder for a run with no id yet. */
  bound: boolean;
  upstreamFlow: UpstreamFlow;
  flow: EngineFlow;
  config: UpstreamMockConfig;
  runner: MockRunner;
}

/**
 * One read of a run, before it is rendered for anybody in particular.
 *
 * `header` is exactly the scalar half of `FlowStatusOutput`, kept as one object
 * so `status()` can spread it and the viewer can pass it through — neither
 * restates the `flow_status` derivation, which is the part that would drift.
 * `map` is the engine's own `FlowMap`, unprojected.
 */
export interface FlowRunView {
  map: FlowMap;
  next: StepOutcome;
  referenceDataKeys: string[];
  header: Omit<
    FlowStatusOutput,
    | "sequence"
    | "extra_steps"
    | "missed_steps"
    | "next"
    | "reference_data_keys"
    | "events"
  >;
}

export class FlowService {
  readonly #sessions: SessionService;
  readonly #catalog: CatalogService;
  readonly #records: RecordService;
  readonly #repository: FlowRepository;
  readonly #sender: SenderService;
  readonly #mockEngine: MockEngine;
  readonly #events: TransactionEvents;
  readonly #validate: ValidateService;
  readonly #logger: Logger;
  readonly #receiverPublicUrl: string;
  readonly #mockSubscriberId: string;

  /**
   * One in-flight `flow_proceed` per run, in this process.
   *
   * Same shape and the same limit as `RecordService#expectationLocks`: it
   * serialises this process, not the cluster. Two processes sharing a Redis
   * still race, and closing that needs the store to grow a compare-and-set —
   * which is where it belongs, not here.
   */
  readonly #runLocks = new Map<string, Promise<unknown>>();

  readonly #feedback: FeedbackObserver | undefined;
  readonly #metrics: Metrics | undefined;
  readonly #mirror: RunMirror | undefined;

  constructor(options: FlowServiceOptions) {
    this.#sessions = options.sessions;
    this.#catalog = options.catalog;
    this.#records = options.records;
    this.#repository = options.repository;
    this.#sender = options.sender;
    this.#mockEngine = options.mockEngine;
    this.#events = options.events;
    this.#validate = options.validate;
    this.#logger = options.logger;
    this.#receiverPublicUrl = options.receiverPublicUrl.replace(/\/+$/, "");
    this.#mockSubscriberId = options.mockSubscriberId;
    this.#feedback = options.feedback;
    this.#metrics = options.metrics;
    this.#mirror = options.mirror;
  }

  /**
   * What the participant must call us back on.
   *
   * Read off the session rather than recomputed, because a session may carry a
   * per-session tunnel override — and the URL we advertise has to be the one
   * the participant was told about at `session_create`.
   */
  callbackUrl(session: Session): string {
    return session.callback_url;
  }

  /* --------------------------------- start -------------------------------- */

  /**
   * Open a run against a flow and report what its first step needs.
   *
   * Everything that can be wrong with a flow is checked **here**, at the one
   * moment the caller can still choose a different one: that the flow exists,
   * that a mock config was published for it, that every step has an owner, and
   * that the two agree on the step keys. Discovering any of these mid-loop
   * would strand a half-run transaction.
   *
   * ## Nothing is persisted but the binding
   *
   * No transaction is created and no id is minted, because **the
   * `transaction_id` belongs to whoever sends the flow's first action**. Half
   * these flows open on the participant's side — a mock BPP waits for `search`
   * — and there the id is theirs to choose. Minting one here produced an id
   * that was never on the wire: their call arrived carrying their own, opened a
   * second record under it, and left the caller holding a dead handle whose
   * `flow_await` could only ever time out. The workbench does not persist here
   * either (`startNewFlowController` writes nothing); it waits for a payload,
   * and so do we.
   *
   * ## It arms, and that is not incidental
   *
   * When the first step is the participant's, the expectation is armed *here*.
   * Arming only in `proceed` left a race the loop's own advice walked straight
   * into: `flow_start` answers `WAITING`, a model that does what `WAITING` says
   * calls `flow_await`, and the participant's first callback meets no armed
   * expectation and is refused 412.
   */
  async start(args: StartFlowArgs): Promise<{
    runtime: FlowRuntime;
    outcome: StepOutcome;
    autoAdvance: boolean;
  }> {
    const session = await this.#sessions.requireSession(args.sessionId);
    const upstreamFlow = await this.#catalog.requireFlow(
      session.build,
      args.flowId,
    );
    const { key, config } = await this.#catalog.requireMockConfig(
      session.build,
      args.flowId,
    );

    const flow = toEngineFlow(upstreamFlow, {
      ownerByKey: ownerByActionId(config),
    });
    assertStepsAreRunnable(flow, config);

    const existing = await this.#repository.findBinding(
      session.session_id,
      args.flowId,
    );
    const autoAdvance =
      args.autoAdvance ?? existing?.autoAdvance ?? session.auto_advance;

    const binding = await this.#openBinding(session, args, existing, {
      autoAdvance,
    });

    // `started` cannot come off the journal the way the other three statuses do
    // — **nothing journals a run opening**. `flow_start` deliberately persists
    // no transaction, so there is no `TRANSACTION_BOUND` yet and there may
    // never be one: a run that opens and is immediately `BLOCKED` produces no
    // journal line at all. Gated on the binding being new, so resuming a run
    // (which `flow_start` does on purpose) is not counted as a second start.
    if (existing === undefined) {
      this.#metrics?.flowRuns.inc({ flow_id: args.flowId, status: "started" });
      // Tap three of the mirror, and **not optional**: this is the only signal
      // a run ever existed. A run that opens and is immediately `BLOCKED` — the
      // most interesting row in a triage corpus — journals nothing at all.
      this.#mirror?.noteRunStarted(session.session_id, {
        flowId: args.flowId,
        attempt: binding.attempt,
        autoAdvance: binding.autoAdvance,
        startedAt: binding.startedAt,
      });
    }

    const record =
      binding.transactionId === undefined
        ? this.#placeholderRecord(session, binding)
        : await this.#records.requireTransaction(
            binding.transactionId,
            session.np.subscriber_url,
          );

    const runtime: FlowRuntime = {
      session,
      record,
      binding,
      bound: binding.transactionId !== undefined,
      upstreamFlow,
      flow,
      config,
      runner: this.#mockEngine.getRunner(
        key,
        config as unknown as MockPlaygroundConfigType,
      ),
    };

    this.#logger.info(
      {
        session_id: session.session_id,
        flow_id: args.flowId,
        transaction_id: binding.transactionId ?? null,
        mockRole: session.mock_role,
        autoAdvance,
      },
      binding.transactionId === undefined
        ? "flow run opened; transaction id belongs to whoever sends the first action"
        : "flow run resumed",
    );

    return {
      runtime,
      outcome: await this.#describeAndArm(runtime),
      autoAdvance,
    };
  }

  /**
   * The binding this run will use: resumed, adopted, or fresh.
   *
   * An explicit `transaction_id` means "resume that transaction", so it must
   * already exist — inventing a record for an id the caller made up would put a
   * transaction on the books that no payload ever referenced, which is the very
   * thing this change removes. It also may not belong to a different flow, and
   * it may not be an attempt `flow_restart` has written off: rebinding the run
   * to a sealed transaction would undo the restart, and the run would be stuck
   * on the same replayed history it was restarted to escape.
   */
  async #openBinding(
    session: Session,
    args: StartFlowArgs,
    existing: FlowBinding | undefined,
    options: { autoAdvance: boolean },
  ): Promise<FlowBinding> {
    if (args.transactionId !== undefined) {
      const record = await this.#records.requireTransaction(
        args.transactionId,
        session.np.subscriber_url,
      );
      if (record.flowId !== args.flowId) {
        throw new ConflictError(
          `Transaction "${args.transactionId}" is running flow "${record.flowId}", not "${args.flowId}".`,
          { transaction_id: args.transactionId, flow_id: record.flowId },
        );
      }
      if (record.abandoned) {
        throw new ConflictError(
          `Transaction "${args.transactionId}" was attempt ${String(
            record.abandoned.attempt,
          )} of this run and has been abandoned. It is kept for the report but ` +
            "cannot be resumed; call flow_start with flow_id alone to work on " +
            "the current attempt.",
          {
            transaction_id: args.transactionId,
            abandoned: record.abandoned,
          },
        );
      }

      const binding: FlowBinding = {
        sessionId: session.session_id,
        flowId: args.flowId,
        autoAdvance: options.autoAdvance,
        transactionId: args.transactionId,
        startedAt: record.createdAt,
        attempt: existing?.attempt ?? 1,
        previousAttempts: existing?.previousAttempts ?? [],
      };
      await this.#repository.saveBinding(binding);
      return binding;
    }

    // Restarting a run that already has a transaction resumes it rather than
    // conflicting — the workbench UI does the same, and the alternative is a
    // caller who has lost the id having no way back to their own flow.
    if (existing) {
      const binding: FlowBinding = {
        ...existing,
        autoAdvance: options.autoAdvance,
      };
      await this.#repository.saveBinding(binding);
      return binding;
    }

    const binding: FlowBinding = {
      sessionId: session.session_id,
      flowId: args.flowId,
      autoAdvance: options.autoAdvance,
      startedAt: new Date().toISOString(),
      attempt: 1,
      previousAttempts: [],
    };
    await this.#repository.saveBinding(binding);
    return binding;
  }

  /* -------------------------------- restart -------------------------------- */

  /**
   * Write off this run's current attempt and open a fresh one.
   *
   * ## Why a run needs this at all
   *
   * `flow_start` **resumes** a bound run, deliberately — a caller who has lost
   * the id needs a way back to their own flow. The consequence is that a run
   * which has gone wrong has no way *out*: state is derived by replaying the
   * recorded exchanges, so a NACKed step or an off-sequence callback is part of
   * the history from then on, and every subsequent read replays it. Without
   * this, the only escape is `session_create` — which strands the abandoned
   * session's armed expectations on an endpoint every session shares, where
   * they go on competing for the participant's callbacks until they expire.
   *
   * ## Nothing recorded is destroyed
   *
   * The abandoned attempt keeps its record, its payloads and its business data,
   * and stays readable through `record_get_payload` and `flow_get_status`. This
   * is a compliance server: a failed attempt is a finding, and the report has
   * to be able to say the third try passed and why the first two did not. All
   * that changes is the *binding* — the run returns to unbound, exactly as it
   * was before its first action crossed the wire, and the next action mints a
   * new `transaction_id`.
   *
   * ## Under the run lock
   *
   * A restart concurrent with a `flow_proceed` that is about to bind the run
   * would tear the binding out from under it and leave the freshly minted
   * transaction owned by nobody. The lock is the same one `proceed` takes, for
   * the same reason.
   */
  restart(args: RestartArgs): Promise<RestartResult> {
    return this.#withRunLock(args.sessionId, args.flowId, () =>
      this.#restart(args),
    );
  }

  async #restart(args: RestartArgs): Promise<RestartResult> {
    const session = await this.#sessions.requireSession(args.sessionId);
    const upstreamFlow = await this.#catalog.requireFlow(
      session.build,
      args.flowId,
    );
    const { key, config } = await this.#catalog.requireMockConfig(
      session.build,
      args.flowId,
    );

    // Validated before anything is touched, exactly as `start` does: a flow
    // that cannot be driven must not first cost the caller their old attempt.
    const flow = toEngineFlow(upstreamFlow, {
      ownerByKey: ownerByActionId(config),
    });
    assertStepsAreRunnable(flow, config);

    const existing = await this.#repository.findBinding(
      session.session_id,
      args.flowId,
    );
    if (!existing) {
      throw new NotFoundError("flow run", args.flowId, {
        session_id: session.session_id,
        hint: "There is no run of this flow to restart. Call flow_start.",
      });
    }

    const now = new Date().toISOString();
    const abandonedTransactionId = existing.transactionId ?? null;

    let attempt = existing.attempt;
    let previousAttempts = existing.previousAttempts;

    // An unbound run has no attempt to write off — nothing ever crossed the
    // wire — so the counter does not move. Restarting it is just a clean
    // re-arm, which is still worth allowing: it is how a caller recovers from
    // an expectation armed against the wrong action.
    if (existing.transactionId !== undefined) {
      await this.#seal(session, existing, now, args.reason);

      previousAttempts = [
        ...existing.previousAttempts,
        {
          attempt: existing.attempt,
          transactionId: existing.transactionId,
          startedAt: existing.startedAt,
          abandonedAt: now,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        },
      ].slice(-ATTEMPT_HISTORY_LIMIT);
      attempt = existing.attempt + 1;
    }

    // Only this run's expectations. A session may have several flows in
    // flight, and disarming a sibling would leave it waiting on an endpoint
    // that had quietly stopped accepting its callback. The entry armed for the
    // old attempt also carries its `transactionId`, so leaving it would answer
    // the new attempt's first legitimate call `TRANSACTION_MISMATCH`.
    await this.#records.clearExpectationsForFlow(
      receiverScope(session),
      session.session_id,
      args.flowId,
    );

    // The one marker key the next attempt inherits: an unbound run contends on
    // the run itself (`#lockId`), so a dispatch that died mid-flight during the
    // old attempt would otherwise read as WORKING for the new one. Everything
    // else — business data, per-transaction and per-extra markers — is keyed on
    // a transaction id the new attempt does not have yet.
    await this.#records.setFlowStatus(
      flowRunKey(session.session_id, args.flowId),
      session.np.subscriber_url,
      "AVAILABLE",
    );

    const binding: FlowBinding = {
      sessionId: session.session_id,
      flowId: args.flowId,
      autoAdvance: existing.autoAdvance,
      startedAt: now,
      attempt,
      previousAttempts,
      // `transactionId` is *omitted*, never set to undefined: the store
      // round-trips through JSON, where an explicit undefined disappears
      // anyway — but omitting it is what makes the two stores agree that this
      // run is unbound.
    };
    await this.#repository.saveBinding(binding);

    const runtime: FlowRuntime = {
      session,
      record: this.#placeholderRecord(session, binding),
      binding,
      bound: false,
      upstreamFlow,
      flow,
      config,
      runner: this.#mockEngine.getRunner(
        key,
        config as unknown as MockPlaygroundConfigType,
      ),
    };

    await this.#records.journal(session.session_id, {
      kind: "FLOW_RESTARTED",
      flow_id: args.flowId,
      ...(abandonedTransactionId !== null
        ? { transaction_id: abandonedTransactionId }
        : {}),
      summary:
        `Flow "${args.flowId}" restarted — now attempt ${String(attempt)}. ` +
        (abandonedTransactionId !== null
          ? `Transaction ${abandonedTransactionId} was abandoned but is kept for the report.`
          : "Nothing had been sent, so no transaction was abandoned."),
    });

    this.#logger.info(
      {
        session_id: session.session_id,
        flow_id: args.flowId,
        abandonedTransactionId,
        attempt,
        reason: args.reason ?? null,
      },
      "flow run restarted; the abandoned attempt is kept as evidence",
    );

    return {
      runtime,
      // Arms if the first step is the participant's, for the same reason
      // `flow_start` does: a model that obeys a `WAITING` outcome calls
      // `flow_await`, never `flow_proceed`, so nothing else would arm it.
      outcome: await this.#describeAndArm(runtime),
      autoAdvance: binding.autoAdvance,
      attempt,
      abandonedTransactionId,
    };
  }

  /**
   * Mark the outgoing attempt's transaction read-only.
   *
   * A transaction that has already expired is not a reason to refuse the
   * restart — it is one of the better reasons to want one. The archive entry on
   * the binding still names the id, so the attempt is not lost from the run's
   * history even when its record is gone.
   */
  async #seal(
    session: Session,
    binding: FlowBinding,
    at: string,
    reason: string | undefined,
  ): Promise<void> {
    const transactionId = binding.transactionId as string;
    try {
      await this.#records.abandonTransaction(
        transactionId,
        session.np.subscriber_url,
        {
          at,
          attempt: binding.attempt,
          ...(reason !== undefined ? { reason } : {}),
        },
      );
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      this.#logger.warn(
        {
          session_id: session.session_id,
          flow_id: binding.flowId,
          transaction_id: transactionId,
        },
        "restarted a run whose transaction had already expired; nothing to seal",
      );
    }
  }

  /* -------------------------------- status -------------------------------- */

  async status(sessionId: string, ref: FlowRef): Promise<FlowStatusOutput> {
    const runtime = await this.load(sessionId, ref);
    const view = await this.#buildView(runtime);
    const { mock_role: mockRole } = runtime.session;

    return {
      ...view.header,
      sequence: view.map.sequence.map((step) =>
        toStepState(step, mockRole, runtime.config),
      ),
      extra_steps: (view.map.extraSteps ?? []).map((step) =>
        toStepState(step, mockRole, runtime.config),
      ),
      missed_steps: view.map.missedSteps.map(toMissedStep),
      next: view.next,
      reference_data_keys: view.referenceDataKeys,
    };
  }

  /**
   * Every run this session has opened, bound or not.
   *
   * Exposed on the service rather than reaching for `FlowRepository`, because
   * the container publishes services and not repositories — and because an
   * unbound run is invisible to `listTransactionIds`, so this is the only
   * honest answer to "what has this session started?".
   */
  listRuns(sessionId: string): Promise<FlowBinding[]> {
    return this.#repository.listRuns(sessionId);
  }

  /**
   * The same read as `status()`, stopping one step earlier.
   *
   * `status()` builds the engine's `FlowMap` and then projects it into
   * `FlowStepState` — a shape sized for a tool result, where a model is paying
   * for every field. A browser is not, and the viewer's step renderer is a port
   * of the same mapper this engine is a port of, so it consumes `MappedStep`
   * directly. Handing it the pre-projection map is both less work and less
   * lossy.
   *
   * Read-only, like `status()`: `describeNext` describes without arming.
   */
  async flowView(sessionId: string, ref: FlowRef): Promise<FlowRunView> {
    return this.#buildView(await this.load(sessionId, ref));
  }

  /**
   * Everything both readers need, computed once.
   *
   * Extracted so `status()` and `flowView()` cannot answer differently about
   * the same run — they are two renderings of one read, and a second
   * implementation of the `flow_status` derivation below is a bug waiting for
   * somebody to notice the two disagree.
   */
  async #buildView(runtime: FlowRuntime): Promise<FlowRunView> {
    const { session, record, flow } = runtime;
    const transactionId = record.transactionId;

    const flowStatus = await this.#records.getFlowStatus(
      this.#lockId(runtime),
      session.np.subscriber_url,
    );
    const businessData = await this.#records.getBusinessData(
      transactionId,
      session.np.subscriber_url,
    );
    const extraStatuses = await this.#extraStatuses(runtime);

    const map = getFlowCompleteStatus(
      record,
      flow,
      flowStatus,
      businessData,
      extraStatuses,
    );

    const next = await this.describeNext(runtime);
    const complete =
      next.outcome === "COMPLETE" ||
      (map.sequence.every((step) => step.status === "COMPLETE") &&
        map.sequence.length > 0);

    return {
      map,
      next,
      referenceDataKeys: Object.entries(map.reference_data ?? {})
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key]) => key),
      header: {
        // Null, not the placeholder's candidate: an unbound run has no id.
        transaction_id: runtime.bound ? transactionId : null,
        flow_id: record.flowId,
        flow_status:
          record.abandoned !== undefined || flowStatus === "SUSPENDED"
            ? "BLOCKED"
            : complete
              ? "COMPLETE"
              : record.apiList.length === 0
                ? "NOT_STARTED"
                : "IN_PROGRESS",
        mock_role: session.mock_role,
        attempt: runtime.binding.attempt,
        ...(record.abandoned ? { abandoned: record.abandoned } : {}),
        seq: record.seq,
        ...(record.attention ? { attention: record.attention } : {}),
      },
    };
  }

  /* ------------------------------- proceeding ----------------------------- */

  /**
   * Advance the flow by one step, dispatching it if it is ours to send.
   *
   * The order of the checks below is the workbench's: an explicit
   * `trigger_extra` outranks the sequence, the sequence outranks a
   * self-dispatching extra, and a step already in flight outranks all of them
   * by refusing.
   */
  async proceed(args: ProceedArgs): Promise<StepOutcome> {
    let outcome: StepOutcome;

    try {
      // Named by flow, so the run may still be unbound — and an unbound run has
      // nothing durable to contend on. The `WORKING` marker cannot close this on
      // its own: both callers read `AVAILABLE` before either writes, and for a
      // bound run that costs a duplicate entry, but here it would cost a second
      // minted id, a second transaction, and the flow's first action going out
      // twice to a third party. Named by transaction, the run is bound by
      // definition and the marker is enough.
      outcome =
        args.flowId === undefined
          ? await this.#proceed(args)
          : await this.#withRunLock(args.sessionId, args.flowId, () =>
              this.#proceed(args),
            );
    } catch (error) {
      // The one path that produces no `StepOutcome` at all. `#dispatchSend`
      // settles the record entry and rethrows — no `BLOCKED`, no `attention`,
      // no journal line — and inside `chainNext` that throw used to end in a
      // `logger.error` and nothing else. This is the single observation point
      // for both, which is why it wraps the throw as well as the return.
      this.#observe(args, undefined, error);
      throw error;
    }

    this.#observe(args, outcome, undefined);
    this.#scheduleChain(args, outcome);
    return outcome;
  }

  /**
   * Hand what just happened to the incident corpus.
   *
   * Deliberately the *only* such call on this path, and deliberately at the
   * public boundary rather than beside each `blocked()`: `chainNext` re-enters
   * `proceed`, so an auto-advanced step is observed here too, and there is no
   * second site that could drift from this one. `blocked()` itself is a module
   * function with no access to the session, which is what makes this the right
   * altitude rather than merely a convenient one.
   */
  #observe(
    args: ProceedArgs,
    outcome: StepOutcome | undefined,
    error: unknown,
  ): void {
    const feedback = this.#feedback;
    if (feedback === undefined) return;

    // A run named only by transaction still belongs to a flow; the id is the
    // better label when we have neither, and it is never absent for long.
    const flowId =
      args.flowId ?? outcome?.step_key ?? args.transactionId ?? "unknown";

    try {
      if (error !== undefined) {
        feedback.noteError(args.sessionId, flowId, error, {
          ...(args.transactionId !== undefined
            ? { transactionId: args.transactionId }
            : {}),
        });
        return;
      }
      if (outcome !== undefined)
        feedback.noteOutcome(args.sessionId, flowId, outcome);
    } catch (observerError) {
      // Same contract as `RecordService#journal`: telemetry may not fail a
      // protocol call. The model's answer is already computed at this point.
      this.#logger.warn(
        { err: observerError, session_id: args.sessionId },
        "the feedback observer threw; the flow outcome is unaffected",
      );
    }
  }

  /**
   * Carry on down the flow after a send, if this run advances itself.
   *
   * Without this, auto-advance only ever fired from the *receiver* — so a run
   * whose next two steps are both ours (a `confirm` followed by a `status`, say)
   * stopped dead after the first, and the model had to call `flow_proceed`
   * again for a step that needed nothing from it. The whole point of the
   * default flip is that steps needing nothing send themselves; a step needing
   * nothing does not become interesting because the step before it was ours.
   *
   * ## Why it is scheduled rather than awaited
   *
   * The outcome is already the caller's answer, and the chain may put several
   * more calls on the wire; holding the tool result open for them would make a
   * single `flow_proceed` take as long as the rest of the flow. The model
   * learns what happened from `CHAIN_SENT` on its next call — which is exactly
   * the mechanism this milestone waited for.
   *
   * Scheduling is also what keeps it clear of the run lock: `proceed` releases
   * before the timer fires, and `chainNext` re-enters `proceed` and takes the
   * lock normally rather than deadlocking against a lock it already holds.
   *
   * `chained` is checked because `chainNext` calls `proceed` itself — without
   * it every chained send would schedule another chain, and twenty steps would
   * fan out into twenty overlapping ones.
   */
  #scheduleChain(args: ProceedArgs, outcome: StepOutcome): void {
    if (args.chained === true) return;
    if (outcome.outcome !== "SENT") return;

    const transactionId = outcome.transaction_id;
    if (transactionId === undefined) return;

    setImmediate(() => {
      void (async () => {
        try {
          // Re-read rather than trusting the arguments: `auto_advance` lives on
          // the transaction, and for the flow's first action the transaction
          // did not exist when this call started.
          const record = await this.#records.findTransaction(
            transactionId,
            (await this.#sessions.requireSession(args.sessionId)).np
              .subscriber_url,
          );
          if (!record?.autoAdvance || record.abandoned) return;
          await this.chainNext(args.sessionId, transactionId);
        } catch (error) {
          this.#logger.error(
            {
              err: error,
              session_id: args.sessionId,
              transaction_id: transactionId,
            },
            "auto-advance chain after a send failed",
          );

          // Nobody is left to return to — this runs on a `setImmediate` after
          // the tool result has gone — so before this line the run simply
          // stopped, silently, and the model's next `flow_await` sat out its
          // full timeout waiting for a step that was never going to be sent.
          // The journal is the only channel that still reaches it.
          //
          // The incident itself is already open: `chainNext` re-enters
          // `proceed`, whose own catch observed the throw. Opening a second one
          // here would double-count the same failure.
          await this.#records.journal(args.sessionId, {
            kind: "ATTENTION",
            transaction_id: transactionId,
            summary:
              "Automatic sending stopped after an error and will not resume on " +
              "its own. Call flow_get_status to see where the run stands.",
          });
        }
      })();
    });
  }

  /** Chain onto whatever is already advancing this run. */
  async #withRunLock<T>(
    sessionId: string,
    flowId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const key = flowRunKey(sessionId, flowId);
    const previous = this.#runLocks.get(key) ?? Promise.resolve();
    const current = previous.then(work, work);
    this.#runLocks.set(
      key,
      current.catch(() => undefined),
    );
    try {
      return await current;
    } finally {
      // Only the tail clears the slot, or a queued caller loses its predecessor.
      if (this.#runLocks.get(key) === current) this.#runLocks.delete(key);
    }
  }

  async #proceed(args: ProceedArgs): Promise<StepOutcome> {
    const runtime = await this.load(args.sessionId, args);
    const { session } = runtime;
    const subscriberUrl = session.np.subscriber_url;

    // Reachable only by naming the abandoned attempt's `transaction_id` —
    // by `flow_id` the binding already points at the current one. Two callers
    // do exactly that: a model still holding the old id, and `chainNext`,
    // which advances by id. Left unguarded, a late callback on a written-off
    // attempt would auto-advance it and put fresh payloads on the wire.
    if (runtime.record.abandoned) return this.#abandonedOutcome(runtime);

    const flowStatus = await this.#records.getFlowStatus(
      this.#lockId(runtime),
      subscriberUrl,
    );
    if (flowStatus === "SUSPENDED") {
      return this.#stamp(
        runtime,
        blocked(
          "flow_suspended",
          "This flow has been suspended and cannot be advanced.",
        ),
      );
    }

    const target = await this.#selectTarget(runtime, flowStatus, args);

    /*
     * Overrides only mean something on the branch that generates a payload.
     *
     * Silently dropping them on any other branch is exactly the failure this
     * whole feature exists to answer: a caller states an intent, nothing
     * honours it, and nothing says so. Refusing costs the run nothing —
     * nothing has been generated, recorded or sent at this point.
     */
    if (args.payloadOverrides !== undefined && target.kind !== "dispatch") {
      return this.#stamp(
        runtime,
        blocked(
          "overrides_not_applicable",
          "payload_overrides patch a payload this flow generates, and the next " +
            `thing this run needs is not a step for this mock to send (${target.kind}). ` +
            "Call flow_get_status to see what it is waiting on, then re-send " +
            "the overrides on the flow_proceed that dispatches the step.",
          { target: target.kind },
        ),
      );
    }

    switch (target.kind) {
      case "outcome":
        return this.#stamp(runtime, target.outcome);

      case "listen":
        await this.#armExpectation(runtime, target.step);
        return this.#stamp(runtime, this.#listening(target.step));

      case "form":
        return this.#stamp(
          runtime,
          await this.#formOutcome(runtime, target.step, args.inputs),
        );

      // The one branch that can bind the run, so it stamps its own answer.
      case "dispatch":
        return this.#dispatch(runtime, target.step, args);
    }
  }

  /* --------------------------------- await --------------------------------- */

  /**
   * Block until the participant does something, or the budget runs out.
   *
   * ## The read-then-park order is the whole design
   *
   * The store is consulted **first**. If anything newer than `after_seq` is
   * already recorded, it comes straight back and no waiter is ever registered.
   * Only when the store has nothing does a waiter park. That closes the window
   * where a callback lands between the model's last call and this one — a race
   * a pure event subscription loses every time, and loses silently.
   *
   * A timeout is an ordinary outcome, not an error: the model calls again, and
   * the pair long-polls.
   *
   * ## Which key it parks on
   *
   * A bound run parks on its transaction. An **unbound** one cannot — its
   * `transaction_id` is the participant's to choose and does not exist yet — so
   * it parks on the flow run instead, and `RecordService` publishes every event
   * under both keys. The event that binds the run is therefore the same event
   * that wakes the waiter which parked before the id existed.
   *
   * An unbound run also **re-arms** before parking. Expectations expire in five
   * minutes; a caller long-polling a participant that takes longer than that
   * would otherwise still be waiting on an endpoint that had quietly stopped
   * listening, and the callback it was waiting for would be refused 412.
   *
   * ## Three ways this used to sit out its whole budget
   *
   * All three were observed live, and all three cost five minutes a call.
   *
   * `after_seq` in the **wrong seq space** — the journal's, the only one a
   * `flow_proceed` answer used to carry — parked a waiter above the record's
   * high-water mark, where `TransactionEvents.notify` could never reach it.
   * Not merely late: deaf for the rest of the timeout, to every future event.
   * `#effectiveAfterSeq` refuses a cursor that cannot be this run's.
   *
   * Parking when the run owes the **caller** the next step could only ever time
   * out; `#awaitable` answers such a call immediately instead.
   *
   * And a *refused* inbound call — 400, or a 412 that matched no expectation —
   * appends nothing to any transaction, so it publishes no run event and could
   * not end a wait at all. The park now races the session journal, which is
   * where those refusals do land.
   */
  async awaitEvent(args: {
    sessionId: string;
    transactionId?: string | undefined;
    flowId?: string | undefined;
    afterSeq?: number | undefined;
    timeoutMs: number;
    kinds?: SessionEventKind[] | undefined;
    flowIds?: string[] | undefined;
    /**
     * The caller named a timeout, so it means to wait even on a run that is
     * not expecting anything — the only way to catch an unsolicited extra step
     * after the main sequence is done.
     */
    waitAnyway?: boolean | undefined;
  }): Promise<AwaitResult> {
    // Naming neither a flow nor a transaction means "tell me about the whole
    // session" — the wait a model reaches for when it is idle and wants to know
    // about anything at all, on any run.
    if (args.flowId === undefined && args.transactionId === undefined) {
      return this.#awaitSession(args);
    }

    const runtime = await this.load(args.sessionId, args);
    const { cursor, adjusted } = this.#effectiveAfterSeq(runtime, args);

    // 1. Anything already recorded wins, with no waiting at all.
    //
    // An outbound entry is on the record from the moment we commit to sending
    // it, so one still in flight is skipped: reporting it would answer a wait
    // with an exchange whose ACK has not come back yet. `settleApiEntry`
    // publishes it a moment later, and the park below catches that.
    const candidates = runtime.record.apiList
      .filter(
        (entry) =>
          entry.seq > (cursor ?? 0) &&
          !(entry.entryType === "API" && entry.sendState === "in_flight"),
      )
      .sort((a, b) => a.seq - b.seq);

    // With a cursor, the *oldest* unseen exchange, so a caller stepping through
    // skips nothing. Without one there is no "unseen" to honour and the newest
    // is the only answer worth giving — the oldest would be history the caller
    // has already acted on, which is what a bare wait used to hand back
    // forever.
    const recorded = cursor === undefined ? candidates.at(-1) : candidates[0];

    if (recorded) {
      return {
        timedOut: false,
        scope: "run",
        waited: false,
        transactionId: runtime.bound ? runtime.record.transactionId : null,
        seq: runtime.record.seq,
        event: toEvent(recorded),
        next: await this.describeNext(runtime),
        ...(adjusted !== undefined ? { afterSeqAdjusted: adjusted } : {}),
      };
    }

    // 2. Is there anything to wait *for*? A run whose next step is ours to send
    //    — or which is finished, or blocked — is not going to be moved by the
    //    participant, so parking on it buys nothing and costs the whole budget.
    const pending = await this.describeNext(runtime);
    if (!args.waitAnyway && !awaitable(pending)) {
      return {
        timedOut: true,
        scope: "run",
        waited: false,
        transactionId: runtime.bound ? runtime.record.transactionId : null,
        seq: runtime.record.seq,
        next: pending,
        ...(adjusted !== undefined ? { afterSeqAdjusted: adjusted } : {}),
      };
    }

    if (!runtime.bound) await this.#rearmIfLapsed(runtime);

    // 3. Nothing yet: park. A caller with no usable cursor is caught up by
    //    definition — step 1 just showed it the newest exchange, or there were
    //    none — so it waits from here rather than from the beginning.
    const event = await this.#park(
      runtime,
      cursor ?? runtime.record.seq,
      args.timeoutMs,
    );

    // Re-load by the same ref: the record moved while we were parked, the run
    // may have acquired an id, and `next` has to be computed from what is true
    // now. Re-loading by `args.transactionId` alone would miss the binding.
    const after = await this.load(args.sessionId, args);

    return {
      timedOut: event === undefined,
      scope: "run",
      waited: true,
      transactionId: after.bound ? after.record.transactionId : null,
      seq: after.record.seq,
      event,
      next: await this.describeNext(after),
      ...(adjusted !== undefined ? { afterSeqAdjusted: adjusted } : {}),
    };
  }

  /**
   * The caller's cursor, if it can possibly be one of ours.
   *
   * `undefined` means "no usable cursor", and it has two causes that deserve
   * the same treatment because they leave us knowing the same thing: nothing
   * about what the caller has already seen.
   *
   * **Omitted.** It used to mean zero, which replayed the *oldest* exchange on
   * the record on every call — four exchanges stale in one observed run, and
   * indistinguishable from something that had just happened.
   *
   * **Above the record's high-water mark**, which is not a cursor this run can
   * ever have issued: entry `seq` is assigned by `appendApiEntry` as
   * `record.seq + 1`, so nothing it hands out exceeds `record.seq`. A larger
   * number came from the session journal — a different counter on a different
   * key, and until `runSeq` existed the only `seq` a `flow_proceed` answer
   * carried. Taken at face value it is far worse than a wrong answer: the
   * wake-up test in `TransactionEvents.notify` is `event.seq > afterSeq`, so
   * the waiter goes deaf to *every* future event on the run and the call is
   * guaranteed to sit out its entire budget. Live, that was five minutes with
   * the awaited callback already on the record.
   *
   * Note what this deliberately does **not** do: clamp to the high-water mark.
   * That would stop the deafness and still skip the exchange the caller was
   * waiting for, since the callback that had already landed *is* the
   * high-water mark. Discarding the number entirely is the honest reading —
   * it told us nothing true — and `awaitEvent` then answers with the newest
   * exchange and a cursor that works.
   */
  #effectiveAfterSeq(
    runtime: FlowRuntime,
    args: { afterSeq?: number | undefined; sessionId: string },
  ): { cursor?: number; adjusted?: number } {
    if (args.afterSeq === undefined) return {};

    const highWater = runtime.record.seq;
    if (args.afterSeq <= highWater) return { cursor: args.afterSeq };

    this.#logger.warn(
      {
        session_id: args.sessionId,
        flow_id: runtime.binding.flowId,
        afterSeq: args.afterSeq,
        highWater,
      },
      "after_seq is ahead of this run's latest event, so it cannot be a cursor " +
        "this run issued — a session journal seq was probably passed instead. " +
        "Ignoring it and reporting the latest exchange.",
    );
    return { adjusted: highWater };
  }

  /**
   * Wait for this run to move, or for a refusal nobody could attribute to it.
   *
   * Two keys, because a run has two ways of being told something and only one
   * of them appends to a transaction.
   *
   * The run key — the transaction when bound, the flow run before that — is
   * where every recorded exchange is published. But a call that is *refused*
   * during resolution (400 on a malformed context, 412 for an expectation that
   * was never armed or a session that has expired) is filed against no
   * transaction at all: there is nothing to append it to, which is the whole
   * reason it was refused. Those land in the session journal instead, so the
   * journal is raced alongside.
   *
   * A journal wake is checked before it is acted on, and the test is narrow on
   * purpose: **only lines that no run event will ever follow**. Almost
   * everything in the journal describes an exchange that was also appended to a
   * transaction, so the run key is about to fire anyway and ending the wait on
   * the journal line would merely pre-empt it with the worse answer — the
   * journal carries no `TransactionEvent`, so the caller would be told nothing
   * arrived a beat before something did. Two kinds have no such follow-up:
   * `POSSIBLY_RELATED`, the refusals that could be attributed to no run at all,
   * and `ATTENTION`, which is auto-advance reporting that it has stopped and
   * will not resume. Those are precisely the ones a run-scoped waiter could
   * otherwise sit out its whole budget without hearing.
   */
  async #park(
    runtime: FlowRuntime,
    afterSeq: number,
    timeoutMs: number,
  ): Promise<TransactionEvent | undefined> {
    const sessionId = runtime.session.session_id;
    const runKey = runtime.bound
      ? transactionKey(
          runtime.record.transactionId,
          runtime.session.np.subscriber_url,
        )
      : flowRunKey(sessionId, runtime.binding.flowId);

    const deadline = Date.now() + timeoutMs;
    let journalSeq = await this.#records.eventCursor(sessionId);

    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;

      // `waitFor` resolves `undefined` on its own timeout, so the loser of this
      // race settles harmlessly on the same deadline rather than leaking.
      const winner = await Promise.race([
        this.#events
          .waitFor(runKey, { afterSeq, timeoutMs: remaining })
          .then((event) => ({ from: "run" as const, event })),
        this.#events
          .waitFor(journalKey(sessionId), {
            afterSeq: journalSeq,
            timeoutMs: remaining,
          })
          .then((event) => ({ from: "journal" as const, event })),
      ]);

      if (winner.from === "run") return winner.event;
      if (winner.event === undefined) return undefined;

      const lines = await this.#relevantJournalLines(sessionId, journalSeq);
      journalSeq = winner.event.seq;
      if (lines.length === 0) continue;

      // A refusal carries no transaction entry, so there is no `TransactionEvent`
      // to hand back. The line itself reaches the caller through the `events`
      // piggyback every session-scoped result already carries; what matters here
      // is that the wait *ends* instead of sitting out its budget.
      return undefined;
    }
  }

  /**
   * Journal lines since `afterSeq` that no run event is going to follow.
   *
   * Best-effort: the journal is a notification channel and nothing is derived
   * from it, so a read that fails costs this wait an early wake-up and never a
   * correct answer.
   */
  async #relevantJournalLines(
    sessionId: string,
    afterSeq: number,
  ): Promise<SessionEvent[]> {
    let lines: SessionEvent[];
    try {
      lines = await this.#records.readEvents(sessionId, afterSeq);
    } catch (error) {
      this.#logger.warn(
        { err: error, session_id: sessionId },
        "could not read the session journal while parked; staying parked",
      );
      return [];
    }

    return lines.filter((line) => DEAD_END_JOURNAL_KINDS.has(line.kind));
  }

  /**
   * Block until **anything** happens in this session.
   *
   * ## Why the whole session needs its own wait
   *
   * A run-scoped wait only fires for one transaction, which means a model
   * driving flow A is deaf to flow B, deaf to a refused call it should look at,
   * and deaf to the steps auto-advance sent while it was thinking. That is the
   * gap this exists to close: when the model has nothing to do, this is the one
   * call that watches everything.
   *
   * ## It is a blocking *drain*, not a subscription
   *
   * The journal's delivery cursor is both the "is anything new?" test and the
   * answer, which is what keeps a second seq space out of the model's hands
   * entirely — there is no `after_seq` to remember here, because the server
   * remembers it.
   *
   * The loop always drains at the top, including after a timeout, and that is
   * deliberate rather than tidy: an entry appended in the instant between a
   * drain that found nothing and the park that follows it would notify no one,
   * and without the re-drain the caller would sit out the full timeout with the
   * thing it asked for already sitting in the store.
   *
   * ## Filters do not discard
   *
   * `kinds` and `flow_ids` decide what **ends** the wait, never what is
   * delivered. Everything drained is returned either way, because the cursor
   * has already moved past it and a filtered-out event would otherwise be lost
   * for good — the one outcome a delivery mechanism must never have.
   */
  async #awaitSession(args: {
    sessionId: string;
    timeoutMs: number;
    kinds?: SessionEventKind[] | undefined;
    flowIds?: string[] | undefined;
  }): Promise<AwaitResult> {
    const session = await this.#sessions.requireSession(args.sessionId);
    const deadline = Date.now() + args.timeoutMs;

    const collected: SessionEvent[] = [];
    let more = 0;
    let cursor = await this.#records.eventCursor(args.sessionId);
    let matched = false;
    let swept = false;

    for (;;) {
      const delta = await this.#records.drainEvents(args.sessionId);
      if (delta) {
        collected.push(...delta.events);
        more = delta.more;
        cursor = delta.cursor;
        if (delta.events.some((event) => matchesFilter(event, args))) {
          matched = true;
          break;
        }
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      // Once per wait, not once per park: expectations last minutes and this
      // walks every run in the session, so doing it on each wake would turn a
      // long poll into a busy loop over the store.
      if (!swept) {
        swept = true;
        await this.#rearmSessionExpectations(session);
        cursor = await this.#records.eventCursor(args.sessionId);
      }

      await this.#events.waitFor(journalKey(args.sessionId), {
        afterSeq: cursor,
        timeoutMs: remaining,
      });
    }

    return {
      timedOut: !matched,
      scope: "session",
      // A session names no single run, so there is no id to report. Reporting
      // one would invite the model to keep driving whichever run happened to
      // move last.
      transactionId: null,
      seq: cursor,
      runs: await this.#summariseRuns(session),
      ...(collected.length > 0
        ? { events: { events: collected, more, cursor } }
        : {}),
    };
  }

  /**
   * Re-arm every run in this session whose expectation has lapsed.
   *
   * The session-scope twin of `#rearmIfLapsed`'s single-run guard, and it needs
   * to be a sweep for the same reason the wait does: the caller named no run,
   * so it is asking us to keep *all* of them listening. A model parked here for
   * ten minutes across three flows would otherwise come back to two endpoints
   * that had quietly stopped accepting callbacks.
   *
   * Bounded and best-effort throughout — one run whose flow no longer resolves
   * must not cost the other runs their re-arm, or the caller its wait.
   */
  async #rearmSessionExpectations(session: Session): Promise<void> {
    let bindings: FlowBinding[];
    try {
      bindings = await this.#repository.listRuns(session.session_id);
    } catch (error) {
      this.#logger.warn(
        { err: error, session_id: session.session_id },
        "could not list this session's runs; skipping the re-arm sweep",
      );
      return;
    }

    for (const binding of bindings.slice(0, REARM_SWEEP_LIMIT)) {
      try {
        const runtime = await this.load(session.session_id, {
          flowId: binding.flowId,
        });
        if (runtime.record.abandoned) continue;
        await this.#rearmIfLapsed(runtime);
      } catch (error) {
        this.#logger.warn(
          {
            err: error,
            session_id: session.session_id,
            flow_id: binding.flowId,
          },
          "could not re-arm one run's expectation during the session sweep",
        );
      }
    }
  }

  /** Where each of this session's runs stands, one line each. */
  async #summariseRuns(session: Session): Promise<RunSummary[]> {
    let bindings: FlowBinding[];
    try {
      bindings = await this.#repository.listRuns(session.session_id);
    } catch {
      return [];
    }

    const summaries: RunSummary[] = [];
    for (const binding of bindings.slice(0, REARM_SWEEP_LIMIT)) {
      try {
        const runtime = await this.load(session.session_id, {
          flowId: binding.flowId,
        });
        const next = await this.describeNext(runtime);
        summaries.push({
          flow_id: binding.flowId,
          transaction_id: runtime.bound ? runtime.record.transactionId : null,
          attempt: binding.attempt,
          outcome: next.outcome,
          message: next.message,
        });
      } catch {
        // A run whose transaction or flow has expired is not a reason to fail
        // the wait; it simply has nothing to report.
      }
    }
    return summaries;
  }

  /**
   * Re-arm an unbound run's expectation if it has lapsed, before a long park.
   *
   * Only re-arms what is genuinely missing: `armExpectation` upserts on
   * `(sessionId, expectedAction)`, so re-arming an entry that is still live
   * would only push its `armedAt` forward and lose it the oldest-first
   * tie-break against another session on the same endpoint.
   */
  async #rearmIfLapsed(runtime: FlowRuntime): Promise<void> {
    const flowStatus = await this.#records.getFlowStatus(
      this.#lockId(runtime),
      runtime.session.np.subscriber_url,
    );
    const target = await this.#selectTarget(runtime, flowStatus, {});
    if (target.kind !== "listen") return;

    const armed = await this.#records.expectationsForSession(
      receiverScope(runtime.session),
      runtime.session.session_id,
    );
    const live = armed.some(
      (entry) => entry.expectedAction === target.step.actionType,
    );
    if (live) return;

    this.#logger.info(
      {
        session_id: runtime.session.session_id,
        flow_id: runtime.binding.flowId,
        action: target.step.actionType,
      },
      "re-arming a lapsed expectation before a long wait",
    );
    await this.#armExpectation(runtime, target.step);

    // Worth a line: a lapsed expectation means the participant took longer than
    // the window to answer, and a callback that arrived in the gap was refused
    // 412. The model cannot see either of those from anywhere else.
    await this.#records.journal(runtime.session.session_id, {
      kind: "EXPECTATION_REARMED",
      flow_id: runtime.binding.flowId,
      ...(runtime.bound
        ? { transaction_id: runtime.record.transactionId }
        : {}),
      action: target.step.actionType,
      summary:
        `The expectation for ${target.step.actionType} had lapsed and was re-armed. ` +
        "A callback that arrived while it was down would have been refused.",
    });
  }

  /* --------------------------------- chain --------------------------------- */

  /**
   * Auto-advance: keep sending this mock's own steps until something needs a
   * human (or a model).
   *
   * Runs **after** the ACK is on the wire, from the receiver's `setImmediate`,
   * so nothing here is inside the participant's ACK window. Because there is
   * nobody left to return an outcome to, the reason it stopped is persisted as
   * `attention` on the transaction and published as an event — otherwise a
   * paused flow would look identical to a stalled one.
   *
   * The step cap is a runaway guard: a mis-authored flow that can always
   * dispatch would otherwise spin here forever.
   */
  async chainNext(
    sessionId: string,
    transactionId: string,
    maxSteps = 20,
  ): Promise<void> {
    for (let step = 0; step < maxSteps; step++) {
      const outcome = await this.proceed({
        sessionId,
        transactionId,
        chained: true,
      });

      if (outcome.outcome === "SENT") {
        const runtime = await this.load(sessionId, { transactionId });
        this.#records.publishEvent(runtime.record, {
          kind: "CHAIN_SENT",
          ...(outcome.action !== undefined ? { action: outcome.action } : {}),
          ...(outcome.payload_id !== undefined
            ? { payload_id: outcome.payload_id }
            : {}),
        });
        continue;
      }

      await this.#pauseChain(sessionId, transactionId, outcome);
      return;
    }

    await this.#pauseChain(sessionId, transactionId, {
      outcome: "BLOCKED",
      message: `Auto-advance stopped after ${String(maxSteps)} consecutive sends. This flow may be looping.`,
      reason: "chain_limit",
    });
  }

  async #pauseChain(
    sessionId: string,
    transactionId: string,
    outcome: StepOutcome,
  ): Promise<void> {
    const runtime = await this.load(sessionId, { transactionId });
    const subscriberUrl = runtime.session.np.subscriber_url;

    // WAITING is not a pause worth flagging — it is the loop working correctly.
    const noteworthy =
      outcome.outcome !== "WAITING" && outcome.outcome !== "COMPLETE";

    if (noteworthy) {
      await this.#records.setAttention(transactionId, subscriberUrl, {
        kind: outcome.outcome,
        message: outcome.message,
        ...(outcome.step_key !== undefined
          ? { step_key: outcome.step_key }
          : {}),
        at: new Date().toISOString(),
      });
    }

    this.#records.publishEvent(runtime.record, {
      kind: "CHAIN_PAUSED",
      ...(outcome.action !== undefined ? { action: outcome.action } : {}),
      detail: outcome.message,
    });

    // One journal line, not two. A pause already sets `attention` with the same
    // message, so also journaling `ATTENTION` would say the same thing twice —
    // and `CHAIN_PAUSED` is the more specific of the pair, because it names the
    // thing the model has to act on *and* the fact that nobody was watching.
    if (outcome.outcome === "COMPLETE") {
      await this.#journalCompletion(runtime);
      return;
    }

    await this.#records.journal(sessionId, {
      kind: "CHAIN_PAUSED",
      flow_id: runtime.record.flowId,
      transaction_id: transactionId,
      ...(outcome.action !== undefined ? { action: outcome.action } : {}),
      summary: `Auto-advance paused (${outcome.outcome}): ${outcome.message}`,
    });
  }

  /**
   * Say a flow finished — once, no matter how many paths notice.
   *
   * The mapper reports `COMPLETE` on **every** read after the last exchange, so
   * an unguarded journal here would append a line to each status read, each
   * await, and each chain pass, and the journal would fill with the same
   * sentence. The claim is atomic rather than a flag on the record because the
   * record is read-modify-written by every append and a flag on it would be
   * clobbered by one already in flight.
   */
  async #journalCompletion(runtime: FlowRuntime): Promise<void> {
    if (!runtime.bound) return;
    const transactionId = runtime.record.transactionId;

    const first = await this.#records.claimFirst(`complete::${transactionId}`);
    if (!first) return;

    await this.#records.journal(runtime.session.session_id, {
      kind: "FLOW_COMPLETE",
      flow_id: runtime.record.flowId,
      transaction_id: transactionId,
      summary: `Flow "${runtime.record.flowId}" is complete. Call report_generate for the compliance summary.`,
    });
  }

  /**
   * Journal a completion the model was not present to see.
   *
   * Called from the receiver once the ACK is on the wire, because a flow whose
   * **last** step is the participant's finishes inside their callback — there
   * is no outcome returned to anyone, and without this the run would simply
   * stop looking busy with nothing ever saying it was done.
   *
   * Best-effort by construction: it runs after the response and swallows its
   * own failures, like everything else on that path.
   */
  async noteCompletion(
    sessionId: string,
    transactionId: string,
  ): Promise<void> {
    try {
      const runtime = await this.load(sessionId, { transactionId });
      if (runtime.record.abandoned) return;
      const next = await this.describeNext(runtime);
      if (next.outcome !== "COMPLETE") return;
      await this.#journalCompletion(runtime);
    } catch (error) {
      this.#logger.warn(
        { err: error, session_id: sessionId, transaction_id: transactionId },
        "could not check whether the flow had completed",
      );
    }
  }

  /* --------------------------------- shared -------------------------------- */

  /**
   * Resolve everything one turn needs: session, binding, record, flow, config,
   * runner.
   *
   * Two ways to name a run, and the second is why this is not a plain lookup:
   *
   * - **By `transactionId`** — the transaction exists, so the record is real
   *   and its `flowId` says which flow to load.
   * - **By `flowId`** — read the binding. Bound, and it degenerates to the
   *   case above. Unbound, and there is genuinely nothing stored yet: the
   *   flow's first action has not crossed the wire and its `transaction_id`
   *   has not been chosen. The runtime is completed with a throwaway record so
   *   every read path downstream works unchanged, and `bound: false` marks it
   *   as something no write may key on.
   */
  async load(sessionId: string, ref: FlowRef): Promise<FlowRuntime> {
    const session = await this.#sessions.requireSession(sessionId);
    const { binding, record, bound } = await this.#resolveRun(session, ref);

    const upstreamFlow = await this.#catalog.requireFlow(
      session.build,
      record.flowId,
    );
    const { key, config } = await this.#catalog.requireMockConfig(
      session.build,
      record.flowId,
    );

    return {
      session,
      record,
      binding,
      bound,
      upstreamFlow,
      flow: toEngineFlow(upstreamFlow, { ownerByKey: ownerByActionId(config) }),
      config,
      runner: this.#mockEngine.getRunner(
        key,
        config as unknown as MockPlaygroundConfigType,
      ),
    };
  }

  async #resolveRun(
    session: Session,
    ref: FlowRef,
  ): Promise<{
    binding: FlowBinding;
    record: TransactionRecord;
    bound: boolean;
  }> {
    const subscriberUrl = session.np.subscriber_url;

    if (ref.transactionId !== undefined) {
      const record = await this.#records.requireTransaction(
        ref.transactionId,
        subscriberUrl,
      );
      // A transaction always belongs to a flow, so a binding always exists in
      // principle — but a stored binding only describes *this* transaction
      // while it is bound to it. Two cases where it is not: a transaction
      // opened before the binding was written (or adopted from an expectation
      // on a restarted process), and an attempt `flow_restart` wrote off, whose
      // binding has since moved on to a later attempt. Marrying attempt 1's
      // record to attempt 2's binding would make `#lockId` and the arming path
      // disagree about which run they are in. So the record wins whenever the
      // two name different transactions: it is the half that actually happened.
      const stored = await this.#repository.findBinding(
        session.session_id,
        record.flowId,
      );
      const describesThis = stored?.transactionId === record.transactionId;
      return {
        binding:
          stored !== undefined && describesThis
            ? stored
            : {
                sessionId: session.session_id,
                flowId: record.flowId,
                autoAdvance: record.autoAdvance,
                transactionId: record.transactionId,
                startedAt: record.createdAt,
                attempt: record.abandoned?.attempt ?? stored?.attempt ?? 1,
                previousAttempts: [],
              },
        record,
        bound: true,
      };
    }

    if (ref.flowId === undefined) {
      throw new ValidationError(
        "Name the run to act on: pass flow_id (the flow you started), or " +
          "transaction_id once the flow's first action has crossed the wire.",
      );
    }

    const binding = await this.#repository.findBinding(
      session.session_id,
      ref.flowId,
    );
    if (!binding) {
      throw new NotFoundError("flow run", ref.flowId, {
        session_id: session.session_id,
        hint: "Call flow_start for this flow first.",
      });
    }

    if (binding.transactionId !== undefined) {
      return {
        binding,
        record: await this.#records.requireTransaction(
          binding.transactionId,
          subscriberUrl,
        ),
        bound: true,
      };
    }

    return {
      binding,
      record: this.#placeholderRecord(session, binding),
      bound: false,
    };
  }

  /**
   * A record for a run that has not put anything on the wire yet.
   *
   * Never persisted, and never written to. Its `transactionId` is a fresh
   * candidate rather than a blank because every downstream read
   * (`getBusinessData`, `getFlowStatus`) takes one and would key on `""`
   * otherwise — colliding across every unbound run in the process. A candidate
   * that nothing was ever stored under reads as empty, which is the truth.
   */
  #placeholderRecord(
    session: Session,
    binding: FlowBinding,
  ): TransactionRecord {
    return emptyTransactionRecord({
      transactionId: randomUUID(),
      sessionId: session.session_id,
      flowId: binding.flowId,
      subscriberType: session.np.type,
      subscriberUrl: session.np.subscriber_url,
      scope: receiverScope(session),
      autoAdvance: binding.autoAdvance,
    });
  }

  /**
   * What the loop needs next, without doing any of it.
   *
   * Shared by `flow_get_status` and `flow_await` so the two can never disagree
   * with each other — or with what `flow_proceed` would actually do.
   */
  async describeNext(runtime: FlowRuntime): Promise<StepOutcome> {
    return this.#describe(runtime, { arm: false });
  }

  /**
   * This run's latest event number — the cursor `flow_await` takes.
   *
   * Exists so `flow_start` and `flow_proceed` can report it. Until they did,
   * the only `seq` in a `flow_proceed` answer was the session journal's, and a
   * model following the loop's own advice (`"Call flow_await for the
   * callback"`) had no other number to reach for. It passed that one, and the
   * wait parked above the record's high-water mark where nothing could reach
   * it. See `#effectiveAfterSeq`.
   *
   * Undefined while the run is unbound: there is no record, so there is no
   * cursor, and `flow_await` should be called without one.
   *
   * A record read, not a `load()`: this runs on the answer path of every
   * `flow_proceed` and has no use for the flow, its config or a runner.
   */
  async runSeq(
    sessionId: string,
    transactionId: string | undefined,
  ): Promise<number | undefined> {
    if (transactionId === undefined) return undefined;
    const session = await this.#sessions.requireSession(sessionId);
    const record = await this.#records.findTransaction(
      transactionId,
      session.np.subscriber_url,
    );
    return record?.seq;
  }

  /**
   * `describeNext`, but it arms the expectation it describes.
   *
   * Only `flow_start` uses it. Everywhere else describing must stay free of
   * side effects, because `flow_get_status` and `flow_await` both call
   * `describeNext` to report what the loop needs without doing any of it — and
   * `proceed` arms on its own path.
   */
  #describeAndArm(runtime: FlowRuntime): Promise<StepOutcome> {
    return this.#describe(runtime, { arm: true });
  }

  /**
   * The one answer a written-off attempt gives, wherever it is asked from.
   *
   * Shared by `proceed` and `describe` so a caller holding the old id is told
   * the same thing whether they try to advance it or merely look at it —
   * `flow_get_status` reporting "call flow_proceed" for a run that would
   * immediately refuse is exactly the sort of contradiction the loop tools are
   * built to avoid.
   */
  #abandonedOutcome(runtime: FlowRuntime): StepOutcome {
    const abandoned = runtime.record.abandoned;
    return this.#stamp(
      runtime,
      blocked(
        "attempt_abandoned",
        `Attempt ${String(abandoned?.attempt ?? 1)} of flow "${runtime.record.flowId}" was abandoned` +
          `${abandoned?.reason !== undefined ? ` (${abandoned.reason})` : ""}. ` +
          "Its payloads are kept for the report but it cannot be advanced. " +
          "Drive the current attempt by flow_id.",
        { abandoned, flow_id: runtime.record.flowId },
      ),
    );
  }

  async #describe(
    runtime: FlowRuntime,
    options: { arm: boolean },
  ): Promise<StepOutcome> {
    if (runtime.record.abandoned) return this.#abandonedOutcome(runtime);

    const flowStatus = await this.#records.getFlowStatus(
      this.#lockId(runtime),
      runtime.session.np.subscriber_url,
    );
    if (flowStatus === "SUSPENDED") {
      return this.#stamp(
        runtime,
        blocked("flow_suspended", "This flow has been suspended."),
      );
    }

    // No inputs and no trigger: describe what would happen to a bare call.
    const target = await this.#selectTarget(runtime, flowStatus, {});

    switch (target.kind) {
      case "outcome":
        return this.#stamp(runtime, target.outcome);
      case "listen":
        if (options.arm) await this.#armExpectation(runtime, target.step);
        return this.#stamp(runtime, this.#listening(target.step));
      case "form":
        return this.#stamp(
          runtime,
          await this.#formOutcome(runtime, target.step, undefined),
        );
      case "dispatch":
        return this.#stamp(runtime, {
          outcome: "READY",
          message: `Step "${target.step.actionId}" (${target.step.actionType}) is this mock's to send. Call flow_proceed.`,
          step_key: target.step.actionId,
          action: target.step.actionType,
        });
    }
  }

  /**
   * `INPUT_REQUIRED`, with the shape spelled out rather than implied.
   *
   * The raw declaration is not handed back: `{name: "ExampleInputId", schema:
   * {properties: {city_code}}}` reads as an instruction to nest, and nesting is
   * the one mistake that fails silently all the way to a validation error at an
   * unrelated JSONPath. `describeInputs` states the keys instead.
   */
  #inputRequired(
    runtime: FlowRuntime,
    step: MappedStep,
    message: string,
    problems?: InputProblem[],
  ): StepOutcome {
    return {
      outcome: "INPUT_REQUIRED",
      message,
      step_key: step.actionId,
      action: step.actionType,
      inputs_required: describeInputs(specFor(step, runtime.config)),
      ...(problems !== undefined && problems.length > 0
        ? { input_problems: problems }
        : {}),
    };
  }

  #listening(step: MappedStep): StepOutcome {
    return {
      outcome: "WAITING",
      message: `Waiting for the participant to send ${step.actionType}. Call flow_await.`,
      step_key: step.actionId,
      action: step.actionType,
      expected_action: step.actionType,
    };
  }

  /**
   * Attach the run's transaction id, when there is one to attach.
   *
   * An unbound run has no id — not a blank one, not a provisional one. The
   * placeholder record carries a candidate purely so downstream reads have a
   * key to miss on, and leaking it to the caller would recreate exactly the bug
   * this change removes: a handle that looks usable and names nothing.
   */
  #stamp(runtime: FlowRuntime, outcome: StepOutcome): StepOutcome {
    return runtime.bound
      ? { ...outcome, transaction_id: runtime.record.transactionId }
      : outcome;
  }

  /**
   * What the per-step `WORKING` marker is filed under.
   *
   * For a bound run that is the transaction, as it always was. An **unbound**
   * run has no transaction, and its placeholder carries a fresh candidate id on
   * every load — so keying the marker on that would give two concurrent
   * `flow_proceed` calls a lock each, and both would mint an id and put the
   * flow's first action on a third party's wire. The run itself is the only
   * thing they have in common, so the run is what they contend on.
   */
  #lockId(runtime: FlowRuntime): string {
    return runtime.bound
      ? runtime.record.transactionId
      : flowRunKey(runtime.session.session_id, runtime.binding.flowId);
  }

  /* ------------------------------ internals ------------------------------- */

  async #extraStatuses(
    runtime: FlowRuntime,
  ): Promise<Map<string, FlowStatusCode>> {
    return this.#records.getExtraFlowStatuses(
      runtime.record.transactionId,
      runtime.session.np.subscriber_url,
      (runtime.flow.extraSequence ?? []).map((step) => step.key),
    );
  }

  /**
   * Decide what this turn is about.
   *
   * Returns a *description* of the target, never an action, so the same
   * decision drives both `proceed` (which acts on it) and `describeNext`
   * (which reports it).
   */
  async #selectTarget(
    runtime: FlowRuntime,
    flowStatus: FlowStatusCode,
    args: Pick<ProceedArgs, "inputs" | "triggerExtra">,
  ): Promise<Target> {
    const { session, record, flow } = runtime;
    const businessData = await this.#records.getBusinessData(
      record.transactionId,
      session.np.subscriber_url,
    );
    const extraStatuses = await this.#extraStatuses(runtime);

    const { sequenceNext, extrasNext } = getNextActions(
      record,
      flow,
      flowStatus,
      businessData,
      extraStatuses,
    );

    // 1. An explicit extras trigger outranks everything.
    if (args.triggerExtra !== undefined) {
      return this.#selectExtra(
        runtime,
        args.triggerExtra,
        extrasNext ?? [],
        extraStatuses,
      );
    }

    // 2. The strict sequence.
    if (sequenceNext) {
      if (flowStatus === "WORKING") {
        return {
          kind: "outcome",
          outcome: blocked(
            "already_processing",
            `Step "${sequenceNext.actionId}" is already being dispatched. Wait for it to finish.`,
            { step_key: sequenceNext.actionId },
          ),
        };
      }

      if (FORM_TYPES.has(sequenceNext.actionType)) {
        return { kind: "form", step: sequenceNext };
      }

      switch (sequenceNext.status) {
        case "LISTENING":
          return { kind: "listen", step: sequenceNext };

        case "RESPONDING":
          return { kind: "dispatch", step: sequenceNext };

        case "INPUT-REQUIRED": {
          const gate = inputGate(sequenceNext, args.inputs);
          return gate.ready
            ? { kind: "dispatch", step: sequenceNext }
            : {
                kind: "outcome",
                outcome: this.#inputRequired(
                  runtime,
                  sequenceNext,
                  gate.message,
                ),
              };
        }

        default:
          return {
            kind: "outcome",
            outcome: blocked(
              "not_actionable",
              `Step "${sequenceNext.actionId}" is ${sequenceNext.status} and cannot be advanced from here.`,
              { step_key: sequenceNext.actionId, status: sequenceNext.status },
            ),
          };
      }
    }

    // 3. A ready side-channel step this mock owns dispatches on its own — that
    //    is what makes a paired unsolicited exchange complete without the
    //    caller having to name it.
    const ready = (extrasNext ?? []).find(
      (step) =>
        step.status === "RESPONDING" &&
        (extraStatuses.get(step.actionId) ?? "AVAILABLE") === "AVAILABLE",
    );
    if (ready) return { kind: "dispatch", step: ready };

    const pendingExtras = (extrasNext ?? []).filter(
      (step) => step.status !== "RESPONDING",
    );
    if (pendingExtras.length > 0) {
      const [first] = pendingExtras;
      return {
        kind: "outcome",
        outcome: {
          outcome: "WAITING",
          message:
            `The main sequence is finished. ${String(pendingExtras.length)} side-channel step(s) remain — ` +
            "wait for the participant, or fire one with trigger_extra.",
          ...(first
            ? { step_key: first.actionId, action: first.actionType }
            : {}),
        },
      };
    }

    return {
      kind: "outcome",
      outcome: {
        outcome: "COMPLETE",
        message:
          "Every step of this flow is done. Call report_generate for the compliance summary.",
      },
    };
  }

  #selectExtra(
    runtime: FlowRuntime,
    triggerExtra: string,
    extrasNext: MappedStep[],
    extraStatuses: ReadonlyMap<string, FlowStatusCode>,
  ): Target {
    const declared = (runtime.flow.extraSequence ?? []).find(
      (step) => step.key === triggerExtra,
    );
    if (!declared) {
      return {
        kind: "outcome",
        outcome: blocked(
          "unknown_extra",
          `"${triggerExtra}" is not a step in this flow's extra sequence.`,
          {
            available: (runtime.flow.extraSequence ?? []).map(
              (step) => step.key,
            ),
          },
        ),
      };
    }

    // Only steps this mock owns can be fired. Triggering one the participant
    // owns would mean sending its half of the conversation for it.
    if (declared.owner === runtime.record.subscriberType) {
      return {
        kind: "outcome",
        outcome: blocked(
          "not_ours_to_send",
          `Step "${declared.key}" is owned by the participant under test (${declared.owner}); wait for it instead.`,
          { step_key: declared.key, owner: declared.owner },
        ),
      };
    }

    const status = extraStatuses.get(declared.key) ?? "AVAILABLE";
    if (status !== "AVAILABLE") {
      return {
        kind: "outcome",
        outcome: blocked(
          "already_processing",
          `Step "${declared.key}" is ${status} and cannot be dispatched.`,
          { step_key: declared.key },
        ),
      };
    }

    // Prefer a live placeholder: it carries the `awaitingMessageId` that ties
    // the reply back to the exchange that prompted it.
    const placeholder = extrasNext.find(
      (step) => step.actionId === declared.key && step.status !== "COMPLETE",
    );
    return {
      kind: "dispatch",
      step: placeholder ?? synthesiseExtra(declared),
    };
  }

  /**
   * Generate, then send — and, on the flow's first action, mint the id.
   *
   * The `WORKING` marker around the whole thing is the concurrency guard, and
   * the `finally` that clears it is what stops a crashed generate from wedging
   * the step until its TTL.
   *
   * ## This is where an unbound run acquires its transaction
   *
   * When we send the flow's first action, the `transaction_id` is **ours** to
   * mint — and the honest moment to mint it is the moment a payload exists,
   * not the moment a caller expressed an intention. So the candidate id goes
   * into `sessionData` (the runner's `generateContext` reads
   * `sessionData.transaction_id` first), the config generates against it, and
   * the id that comes back **on the generated payload** is the one the
   * transaction is opened under. That is what actually goes on the wire, and a
   * record keyed on anything else would be a record of a conversation nobody
   * had.
   *
   * Order matters at the bind: create, then send. A participant fast enough to
   * call back before `send` returns must find a record waiting.
   *
   * A `BLOCKED` return before that point — unmet requirements, a generator that
   * threw — persists **nothing**. There was no payload, so there is no
   * transaction, and the run is still free to be started by whichever side
   * moves first.
   */
  async #dispatch(
    runtime: FlowRuntime,
    step: MappedStep,
    args: ProceedArgs,
  ): Promise<StepOutcome> {
    const { session } = runtime;
    const subscriberUrl = session.np.subscriber_url;
    const isExtra = step.isExtraStep === true;
    const statusKey = isExtra ? step.actionId : undefined;

    // Every key this dispatch marked WORKING, so the `finally` clears all of
    // them. One for a bound run; two for an unbound one, which contends on the
    // run until it has a transaction and on the transaction afterwards.
    const marked = new Set<string>();
    let txnId = runtime.record.transactionId;
    const bound = runtime.bound;

    const mark = async (key: string): Promise<void> => {
      marked.add(key);
      await this.#records.setFlowStatus(
        key,
        subscriberUrl,
        "WORKING",
        statusKey,
      );
    };

    await mark(this.#lockId(runtime));

    try {
      // Inputs first, ahead of requirements — whose own view of the world *is*
      // `sessionData`, and would be answering about the wrong one.
      //
      // A wrong-shaped `inputs` object reaches `generate` as an absent value,
      // and a generator that assigns it (`payload.x = user_inputs?.y`) deletes
      // the field the default payload already had right. Nothing downstream
      // ties the L1 failure that follows back to the input, so this is the last
      // point at which the real cause is still visible.
      const inputCheck = checkInputs(
        specFor(step, runtime.config),
        args.inputs,
      );
      if (!inputCheck.ok) {
        return this.#inputRequired(
          runtime,
          step,
          `Step "${step.actionId}" was not sent — the values supplied are not ` +
            `the shape its generator reads. ${inputCheck.message}`,
          inputCheck.problems,
        );
      }

      const sessionData = await this.#buildSessionData(runtime, args.inputs);

      const requirements = await this.#mockEngine.runRequirements(
        runtime.runner,
        step.actionId,
        sessionData,
      );
      if (!requirements.ok) {
        return blocked(
          "requirements_error",
          `The requirements check for "${step.actionId}" failed to run: ${requirements.error?.message ?? "unknown error"}`,
          { step_key: step.actionId, error: requirements.error },
        );
      }
      if (requirements.result?.valid === false) {
        // Surfaced to the caller instead of the workbench's "send an error
        // payload at the counterparty" — an unmet precondition is ours to fix,
        // and telling the participant about it teaches it nothing.
        return blocked(
          "requirements_not_met",
          `Step "${step.actionId}" is not ready: ${requirements.result.description ?? "requirements not met"}`,
          {
            step_key: step.actionId,
            code: requirements.result.code,
            description: requirements.result.description,
            hint: "Read record_get_data to see what the flow has saved so far.",
          },
        );
      }

      const generated = await this.#mockEngine.runGenerate(
        runtime.runner,
        step.actionId,
        sessionData,
      );
      if (!generated.ok || generated.result === undefined) {
        return blocked(
          "generation_error",
          `Could not generate the payload for "${step.actionId}": ${generated.error?.message ?? "the config returned nothing"}`,
          { step_key: step.actionId, error: generated.error },
        );
      }

      const payload = generated.result;

      /*
       * ## The escape hatch, applied here and nowhere else
       *
       * After `generate`, so it patches the bytes the config actually
       * produced; before the id is settled and before the gate, so the
       * transaction stays ours to key on and the patched payload is what gets
       * judged. An override is not a validation bypass — it exists so a run
       * blocked by a **defect in a published config** can continue with a
       * *correct* payload rather than be abandoned.
       *
       * All-or-nothing: a refusal leaves `payload` exactly as generated, so
       * fixing the paths and calling again costs the run nothing.
       */
      let overridden: readonly string[] = [];
      if (args.payloadOverrides !== undefined) {
        const result = applyOverrides(payload, args.payloadOverrides);
        if (result.problems.length > 0) {
          // Top level, like `input_problems`: it is the thing to act on, and
          // burying it in `details` makes it something to go looking for.
          return {
            ...blocked(
              "overrides_refused",
              `The payload_overrides for "${step.actionId}" were refused, so nothing ` +
                "was patched, recorded or sent — the payload is exactly as the " +
                `config generated it. ${result.problems
                  .map((problem) => `${problem.path} — ${problem.reason}`)
                  .join("; ")}`,
              { step_key: step.actionId },
            ),
            action: step.actionType,
            override_problems: result.problems.map((problem) => ({
              path: problem.path,
              reason: problem.reason,
            })),
          };
        }
        overridden = result.applied.map((entry) => entry.path);

        this.#logger.warn(
          {
            session_id: session.session_id,
            transaction_id: txnId,
            step_key: step.actionId,
            paths: overridden,
          },
          "outbound payload patched by payload_overrides; this step is not a clean step",
        );
      }
      const patched =
        overridden.length > 0 ? { overrides: [...overridden] } : {};

      if (bound) {
        // A run that already has an id keeps it for the rest of the flow.
        this.#assertTransactionId(runtime, step, payload);
      } else {
        txnId = readTransactionId(payload) ?? txnId;
        writeTransactionId(payload, txnId);
      }

      const context = readContext(payload);

      /*
       * ## The gate
       *
       * L0 + L1 on the payload the flow's own `generate` produced, before it
       * reaches a third party's wire. It runs here — after the transaction id
       * is settled, before anything is bound, recorded or sent — because those
       * are the last bytes: validating earlier would judge a payload that is
       * not the one we send.
       *
       * Note what this actually catches. The payload is generated by the
       * config's published JavaScript, not drafted by a model, so a failure
       * here is a **defect in the flow config** far more often than anything
       * else. That is golden rule `fm-001` running one step earlier than usual:
       * an `on_X` NACK is usually a generation symptom, and this is the gate
       * that says so before the counterparty has to.
       */
      const validation = await this.#validate.validate({
        domain: session.build.domain,
        version: session.build.version,
        action: step.actionType,
        payload,
        direction: "outbound",
        session,
        transactionId: txnId,
      });

      if (args.dryRun === true) {
        // A drafted payload was never on the wire, so it mints nothing: the
        // run stays unbound and the flow's first action is still unspoken for.
        // Deliberately *not* gated: a draft exists to be inspected, and one
        // that fails validation is the most useful kind to look at.
        const payloadId = await this.#records.storePayload({
          transactionId: txnId,
          subscriberUrl,
          direction: "outbound",
          action: step.actionType,
          messageId: context.message_id,
          timestamp: context.timestamp,
          body: payload,
        });
        return this.#stamp(runtime, {
          outcome: "DRAFTED",
          message:
            `Generated ${step.actionType} but did not send it. ` +
            `${describeVerdict(validation)} ` +
            (overridden.length > 0
              ? `Patched ${String(overridden.length)} path(s) first — re-send the same ` +
                "payload_overrides on the call that dispatches it, because they " +
                "apply to one call only. "
              : "") +
            "Inspect it with record_get_payload, then call flow_proceed again without dry_run.",
          step_key: step.actionId,
          action: step.actionType,
          payload_id: payloadId,
          ...patched,
          validation,
        });
      }

      if (validation.status === "invalid" && this.#validate.enforces) {
        // Nothing has been bound, recorded or sent, so this costs the run
        // nothing but the attempt — exactly like `requirements_not_met` above.
        // An unbound run stays unbound, and the flow's first action is still
        // unspoken for.
        this.#logger.warn(
          {
            session_id: session.session_id,
            transaction_id: txnId,
            step_key: step.actionId,
            findings: validation.findings.length,
          },
          "outbound payload failed protocol validation; not sending it",
        );
        return blocked(
          "validation_failed",
          `The ${step.actionType} payload this flow generated is not spec-compliant, so it was not sent: ` +
            summariseFindings(validation.findings),
          {
            step_key: step.actionId,
            findings: validation.findings,
            ...(validation.docs_url !== undefined
              ? { docs_url: validation.docs_url }
              : {}),
            // What the step declares, and what it was given, sit beside the
            // findings on purpose. The generated payload is a function of the
            // two, and a reader holding only the findings has no way to tell a
            // config defect from a value it chose — an earlier version of this
            // hint asserted "usually a config defect", and was believed.
            ...inputEvidence(step, runtime.config, args.inputs),
            ...patched,
            hint:
              "The payload is produced by the flow config's own generate " +
              "function from the inputs supplied. Compare the findings against " +
              "`declared_inputs` and `supplied_inputs` below: a field that is " +
              "empty or missing is usually one the generator read off " +
              "`user_inputs` and did not find. Inspect the payload with " +
              "flow_proceed dry_run to confirm before concluding the config is " +
              "at fault.",
            // Naming the way out, beside the reason it is needed. Before this,
            // a model that correctly diagnosed a defect in a *published* config
            // had nothing left to do but give up — which is exactly what the
            // 2026-07-31 runs did, twice.
            ...(suggestOverrides(validation.findings) !== undefined
              ? { recovery: suggestOverrides(validation.findings) }
              : {}),
          },
        );
      }

      if (!bound) {
        // From here the step is in flight against a real transaction, so the
        // marker has to exist there too — the next call will resolve the run
        // to the transaction and look for it under that key.
        await mark(txnId);
        await this.#bindOutbound(runtime, txnId);
      }

      // ## Recorded before it is sent, and this ordering is the whole point
      //
      // The counterparty is entitled to send its next request before it answers
      // ours — the ACK's return leg and their next call's forward leg are
      // independent connections and neither ordering is guaranteed. Recording
      // after `send` resolved meant our own sent step was absent from `apiList`
      // for the length of a round trip, so replay left the cursor on the step we
      // had already sent, their legitimate follow-up matched no pending step,
      // and we NACKed it `OUT_OF_SEQUENCE` — a false finding against a correct
      // implementation.
      //
      // It also fixes the replay order. `seq` is assigned here, and
      // `sortForReplay` prefers it over `context.timestamp` precisely because no
      // counterparty can influence it — but that only holds if it is stamped
      // when we *observe* the exchange. Stamped at ACK-return time, an inbound
      // call that arrived during our send took a lower `seq` than the send it
      // was answering, and replay ran them backwards.
      //
      // Over-recording is the safe direction here: the entry exists for a moment
      // before the bytes leave, but the participant cannot answer a call it has
      // not received, so nothing can match against it early.
      const { payloadId, seq } = await this.#records.appendApiEntry({
        transactionId: txnId,
        subscriberUrl,
        action: step.actionType,
        messageId: context.message_id,
        direction: "outbound",
        // Ordering replay by the payload's own timestamp, not by arrival, is
        // what keeps a request and its callback in the right order.
        timestamp: context.timestamp,
        body: payload,
        sendState: "in_flight",
        // A patched step is not a clean step, and the record is what the
        // compliance report reads. Absent when nothing was patched.
        ...patched,
        // Published once, by `settleApiEntry`, when the ACK is actually known.
        silent: true,
      });

      // Ahead of the send for the same reason: the receiver feeds business data
      // to the inbound validator, so anything this step saves has to be there
      // before their next call can be judged against it. It is derived from the
      // generated payload, which exists already, so moving it costs nothing.
      await this.#records.saveBusinessData(
        txnId,
        subscriberUrl,
        payload,
        saveDataFor(runtime.config, step.actionId),
      );

      const sent = await this.#dispatchSend(
        { transactionId: txnId, subscriberUrl, seq, payloadId },
        step.actionType,
        payload,
      );

      await this.#records.journal(session.session_id, {
        // A chained send is the one the model did not ask for, so it is the one
        // the journal exists to surface.
        kind: args.chained === true ? "CHAIN_SENT" : "OUTBOUND_SENT",
        flow_id: runtime.binding.flowId,
        transaction_id: txnId,
        action: step.actionType,
        ack: sent.ack,
        payload_id: payloadId,
        ...patched,
        summary:
          `${args.chained === true ? "Auto-sent" : "Sent"} ${step.actionType} — ` +
          `the participant answered ${sent.ack}.` +
          (overridden.length > 0
            ? ` Patched first: ${overridden.join(", ")}.`
            : "") +
          // Folded into the existing line rather than journaled separately.
          // For a chained send the journal is the *only* channel back to the
          // model, so a payload that went out unvalidated — or known-bad under
          // `advisory` — has to say so here or it is never said at all.
          (validation.status === "valid"
            ? ""
            : ` ${describeVerdict(validation)}`),
      });

      return {
        outcome: "SENT",
        message:
          (sent.ack === "ACK"
            ? `Sent ${step.actionType}; the participant ACKed it. Call flow_await for the callback.`
            : `Sent ${step.actionType}; the participant answered ${sent.ack}. Read ack_body — this is a finding, not a transport failure.`) +
          (overridden.length > 0
            ? ` Note: ${String(overridden.length)} path(s) were patched by ` +
              "payload_overrides, so this step was not generated purely by the " +
              "flow's own config and the compliance report will say so."
            : ""),
        step_key: step.actionId,
        action: step.actionType,
        transaction_id: txnId,
        payload_id: payloadId,
        ack: sent.ack,
        http_status: sent.httpStatus,
        ack_body: sent.body,
        ...patched,
        validation,
      };
    } finally {
      for (const id of marked) {
        await this.#records.setFlowStatus(
          id,
          subscriberUrl,
          "AVAILABLE",
          statusKey,
        );
      }
    }
  }

  /**
   * Put the payload on the wire and close the entry that was opened for it.
   *
   * Every exit from here leaves the record consistent, which is what lets the
   * append happen before the send at all:
   *
   * | Outcome | Entry |
   * | --- | --- |
   * | Answered (ACK **or** NACK) | settled with the answer |
   * | Threw, `delivery: unreachable` | withdrawn — nothing crossed, the step is still owed |
   * | Threw, anything else | kept, `sendState: "failed"` — it may have been delivered |
   *
   * The last row is the one that matters. A timeout is not evidence of
   * non-delivery, and treating it as such would let the next `flow_proceed`
   * re-send a call the participant had already processed. A stuck run is
   * recoverable with `flow_restart`; a duplicate on someone else's wire is not.
   */
  async #dispatchSend(
    entry: {
      transactionId: string;
      subscriberUrl: string;
      seq: number;
      payloadId: string;
    },
    action: string,
    payload: unknown,
  ): Promise<SendResult> {
    try {
      const sent = await this.#sender.send(
        entry.subscriberUrl,
        action,
        payload,
      );
      await this.#records.settleApiEntry({
        ...entry,
        ackBody: sent.body,
        httpStatus: sent.httpStatus,
      });
      return sent;
    } catch (error) {
      const delivery =
        error instanceof UpstreamError ? error.details?.delivery : undefined;

      if (delivery === "unreachable") {
        await this.#records.discardApiEntry(entry);
      } else {
        await this.#records.settleApiEntry({
          ...entry,
          sendState: "failed",
          sendError: error instanceof Error ? error.message : "the send failed",
        });
      }
      throw error;
    }
  }

  /**
   * Open the transaction this run just minted, and bind the run to it.
   *
   * The identity seed goes in here rather than at `flow_start` because there
   * was no transaction to seed until now. It matters: a published config's
   * canned identity points at `bap.example.com`, and without ours in place
   * before the *next* generate that is what would go out.
   */
  async #bindOutbound(runtime: FlowRuntime, transactionId: string) {
    const { session, binding } = runtime;

    const existing = await this.#records.findTransaction(
      transactionId,
      session.np.subscriber_url,
    );
    if (existing) {
      throw new ConflictError(
        `Transaction "${transactionId}" is already running flow "${existing.flowId}" against this participant.`,
        { transaction_id: transactionId, flow_id: existing.flowId },
      );
    }

    const record = await this.#records.createTransaction({
      transactionId,
      sessionId: session.session_id,
      flowId: binding.flowId,
      // The engine reads this as "the side the participant under test is on".
      subscriberType: session.np.type,
      subscriberUrl: session.np.subscriber_url,
      scope: receiverScope(session),
      autoAdvance: binding.autoAdvance,
    });

    await this.#records.overwriteBusinessData(
      transactionId,
      session.np.subscriber_url,
      this.#seedIdentity(session, transactionId, {}),
    );

    await this.#repository.saveBinding({ ...binding, transactionId });

    // The caller is holding a runtime built before any of this existed.
    runtime.record = record;
    runtime.bound = true;
    runtime.binding = { ...binding, transactionId };

    await this.#records.journal(session.session_id, {
      kind: "TRANSACTION_BOUND",
      flow_id: binding.flowId,
      transaction_id: transactionId,
      summary: `Flow "${binding.flowId}" minted transaction ${transactionId} for its first action.`,
    });

    this.#logger.info(
      {
        session_id: session.session_id,
        flow_id: binding.flowId,
        transaction_id: transactionId,
      },
      "minted the transaction id for this flow's first action",
    );
  }

  /**
   * Open the transaction the **participant** chose, and bind the run to it.
   *
   * The inbound twin of `#bindOutbound`, called by the receiver when an armed
   * expectation catches a flow's first call. The participant sent that action,
   * so the `transaction_id` on it is the real one by definition — there is
   * nothing to reconcile and nothing of ours to prefer.
   *
   * Both bind sites must leave identical state, which is why this is here and
   * not inlined in the receiver: a transaction opened one way and a transaction
   * opened the other are the same transaction to every read that follows.
   */
  async adoptTransaction(args: {
    session: Session;
    flowId: string;
    transactionId: string;
    autoAdvance: boolean;
    scope: ExpectationScope;
  }): Promise<TransactionRecord> {
    const { session, flowId, transactionId } = args;

    const record = await this.#records.createTransaction({
      transactionId,
      sessionId: session.session_id,
      flowId,
      subscriberType: session.np.type,
      // The registered URL, never the advertised one — see CreateTransactionInput.
      subscriberUrl: session.np.subscriber_url,
      scope: args.scope,
      autoAdvance: args.autoAdvance,
    });

    // Same reason as the outbound path: without our identity in place, the
    // config's canned `bap.example.com` is what the next generate would send.
    await this.#records.overwriteBusinessData(
      transactionId,
      session.np.subscriber_url,
      this.#seedIdentity(session, transactionId, {}),
    );

    const existing = await this.#repository.findBinding(
      session.session_id,
      flowId,
    );
    await this.#repository.saveBinding({
      sessionId: session.session_id,
      flowId,
      autoAdvance: args.autoAdvance,
      transactionId,
      startedAt: existing?.startedAt ?? record.createdAt,
      // Carried through, not reset: this is how a *restarted* run binds when
      // the participant sends the flow's first action, and the new transaction
      // is attempt N, not attempt 1.
      attempt: existing?.attempt ?? 1,
      previousAttempts: existing?.previousAttempts ?? [],
    });

    // The other half of the identity model, and the more surprising one to
    // read about after the fact: this id was the participant's to choose, so
    // the journal is where a model driving by `flow_id` learns it.
    await this.#records.journal(session.session_id, {
      kind: "TRANSACTION_BOUND",
      flow_id: flowId,
      transaction_id: transactionId,
      summary: `The participant opened flow "${flowId}" with transaction ${transactionId}.`,
    });

    return record;
  }

  /**
   * Keep one id for the whole flow instance, and say so when a config does not.
   *
   * `generateContext` reads `sessionData.transaction_id` first, so a divergence
   * here means the step's own `generate` rewrote `context` — a real thing
   * published configs do. Shipping the drifted id would not merely mis-key our
   * record: the participant would file it as a *second* transaction and the
   * flow would come apart on both sides. So it is corrected in place and
   * reported, because a config that does this is itself a finding.
   */
  #assertTransactionId(
    runtime: FlowRuntime,
    step: MappedStep,
    payload: Record<string, unknown>,
  ): void {
    const expected = runtime.record.transactionId;
    const generated = readTransactionId(payload);
    if (generated === undefined || generated === expected) return;

    this.#logger.warn(
      {
        session_id: runtime.session.session_id,
        transaction_id: expected,
        step_key: step.actionId,
        generated,
      },
      "the step's generate rewrote context.transaction_id; correcting it",
    );
    writeTransactionId(payload, expected);
  }

  /**
   * A form step: either complete it with a submission id, or say who owes what.
   */
  async #formOutcome(
    runtime: FlowRuntime,
    step: MappedStep,
    inputs: Record<string, unknown> | undefined,
  ): Promise<StepOutcome> {
    const { session, record } = runtime;
    const subscriberUrl = session.np.subscriber_url;
    const submissionId = inputs?.["submission_id"];

    if (typeof submissionId === "string" && submissionId.length > 0) {
      // The submission id lands in business data under the step's own key
      // because that is where the next step's generator looks for it.
      const data = await this.#records.getBusinessData(
        record.transactionId,
        subscriberUrl,
      );
      data[step.actionId] = submissionId;
      await this.#records.overwriteBusinessData(
        record.transactionId,
        subscriberUrl,
        data,
      );

      await this.#records.appendFormEntry({
        transactionId: record.transactionId,
        subscriberUrl,
        formId: step.actionId,
        formType:
          step.actionType === "DYNAMIC_FORM" ? "DYNAMIC_FORM" : "HTML_FORM",
        submissionId,
      });

      // Both directions land here — `form_submit` after we filled theirs, and
      // the hosted-form route after they filled ours — which is why one hook
      // covers what the plan lists as two. The second is the interesting one:
      // nobody is waiting on it, so without this it happens in silence.
      await this.#records.journal(session.session_id, {
        kind: "FORM_SUBMITTED",
        flow_id: record.flowId,
        transaction_id: record.transactionId,
        action: step.actionId,
        summary: `Form "${step.actionId}" was submitted (${submissionId}); the flow has moved on.`,
      });

      return {
        outcome: "SENT",
        message: `Recorded submission ${submissionId} for form "${step.actionId}". The flow has moved on.`,
        step_key: step.actionId,
        action: step.actionType,
      };
    }

    // `WAITING-SUBMISSION` means this mock hosts the form; anything else at a
    // form step means the participant hosts it and we have to fill it in.
    const hosting = step.status === "WAITING-SUBMISSION";
    const businessData = await this.#records.getBusinessData(
      record.transactionId,
      subscriberUrl,
    );
    const resolved = businessData[step.actionId];

    return {
      outcome: "FORM_PENDING",
      message: hosting
        ? `Form "${step.actionId}" is served by this mock; the participant has to submit it. Its URL is in the payload already sent.`
        : `Form "${step.actionId}" is hosted by the participant. Call form_fetch to read it, then form_submit.`,
      step_key: step.actionId,
      action: step.actionType,
      form_role: hosting ? "host" : "fill",
      ...(typeof resolved === "string" && /^https?:\/\//i.test(resolved)
        ? { form_url: resolved }
        : {}),
    };
  }

  /**
   * Stand up the note that lets the receiver file the participant's next call.
   *
   * `transactionId` is carried **only when the run is bound**. It is the
   * strongest tie-break the receiver has for telling two sessions armed on the
   * same endpoint apart, but an unbound run has no id to offer: the call being
   * waited for is the flow's first, and its `transaction_id` is the
   * participant's to choose. Putting the placeholder's candidate here would
   * assert we know something we do not, and the id would never match anyway.
   */
  async #armExpectation(runtime: FlowRuntime, step: MappedStep): Promise<void> {
    await this.#records.armExpectation(receiverScope(runtime.session), {
      sessionId: runtime.session.session_id,
      flowId: runtime.binding.flowId,
      ...(runtime.bound ? { transactionId: runtime.record.transactionId } : {}),
      expectedAction: step.actionType,
      subscriberUrl: runtime.session.np.subscriber_url,
      autoAdvance: runtime.binding.autoAdvance,
    });
  }

  /**
   * The session data a config's `generate` function sees.
   *
   * Three layers, and the order between them is the whole point:
   *
   * 1. Whatever the flow has saved so far — the provider ids, the order id.
   * 2. **Our** identity, which always wins. We know it definitively, and the
   *    alternative is the config's canned `bap.example.com` going out on the
   *    wire.
   * 3. The participant's identity, only as a **fallback**. Once its own
   *    payloads have told us its real `bpp_id`, that is the authoritative
   *    value and must not be overwritten by our guess.
   */
  async #buildSessionData(
    runtime: FlowRuntime,
    inputs: Record<string, unknown> | undefined,
  ): Promise<Record<string, unknown>> {
    const { session, record } = runtime;
    const stored = await this.#records.getBusinessData(
      record.transactionId,
      session.np.subscriber_url,
    );

    return {
      ...this.#seedIdentity(session, record.transactionId, stored),
      ...(inputs !== undefined ? { user_inputs: inputs } : {}),
    };
  }

  /**
   * Identity, **in the shape a config's `generate` actually reads it**.
   *
   * Every other value in `sessionData` arrives through `saveData`, which runs
   * `jsonpath.query` and therefore always yields a *list*: `bppId` is
   * `["bpp.example.com"]`, never `"bpp.example.com"`. Published configs are
   * written against exactly that and index it in place —
   * `context.bpp_id = sessionData?.bppId[0]` is the live TRV11 shape.
   *
   * Seeding a bare string here does not throw, which is precisely the problem:
   * `[0]` on a string is its first *character*, so `"bpp.example.com"` reaches
   * a third party's wire as `"b"`. It bites hardest on a flow's **first**
   * action, when nothing has been saved yet and all four of these are seeds
   * rather than saves — and on any field the participant simply omits, because
   * an omitted field saves as `[]` and falls through to the seed.
   *
   * `transactionId` below has been a list for this same reason since forms
   * landed; these four were missed.
   */
  #seedIdentity(
    session: Session,
    transactionId: string,
    stored: Record<string, unknown>,
  ): Record<string, unknown> {
    const ourUri = this.callbackUrl(session);
    const ourId = this.#mockSubscriberId;
    const theirUri = session.np.subscriber_url;
    const theirId = session.np.subscriber_id ?? hostOf(theirUri);

    const ours =
      session.mock_role === "BAP"
        ? { bapId: [ourId], bapUri: [ourUri] }
        : { bppId: [ourId], bppUri: [ourUri] };
    const theirs =
      session.mock_role === "BAP"
        ? { bppId: [theirId], bppUri: [theirUri] }
        : { bapId: [theirId], bapUri: [theirUri] };

    const data: Record<string, unknown> = { ...stored };

    // The participant's own payloads are authoritative about the participant.
    for (const [key, value] of Object.entries(theirs)) {
      if (isEmpty(data[key])) data[key] = value;
    }
    Object.assign(data, ours);

    return {
      ...data,
      // `transaction_id` for generateContext, `transactionId` (an array) for
      // the config helpers — `createFormURL` reads `transactionId[0]`.
      transaction_id: transactionId,
      transactionId: [transactionId],
      sessionId: session.session_id,
      subscriberUrl: theirUri,
      mockBaseUrl: this.#receiverPublicUrl,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Target selection result                                                     */
/* -------------------------------------------------------------------------- */

type Target =
  | { kind: "outcome"; outcome: StepOutcome }
  | { kind: "dispatch"; step: MappedStep }
  | { kind: "listen"; step: MappedStep }
  | { kind: "form"; step: MappedStep };

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One clause about how a payload judged, for a message or a journal line.
 *
 * Empty for a clean pass — a sentence saying nothing went wrong on every
 * successful step is noise the model has to read past. The two states that do
 * speak are the ones with consequences: findings we did not act on, and a
 * payload nobody checked.
 */
function describeVerdict(verdict: ValidationVerdict): string {
  if (verdict.status === "valid") {
    return `It passed ${verdict.checked.join(" + ")} validation.`;
  }

  if (verdict.status === "unavailable") {
    return (
      "It went unvalidated — " +
      (verdict.unchecked[0]?.reason ?? "no layer could be checked") +
      "."
    );
  }

  return (
    `It has ${String(verdict.findings.length)} validation ` +
    `finding${verdict.findings.length === 1 ? "" : "s"}: ` +
    `${summariseFindings(verdict.findings, 2)}.`
  );
}

function blocked(
  reason: string,
  message: string,
  details?: Record<string, unknown>,
): StepOutcome {
  return {
    outcome: "BLOCKED",
    message,
    reason,
    ...(details !== undefined ? { details } : {}),
    ...(typeof details?.["step_key"] === "string"
      ? { step_key: details["step_key"] }
      : {}),
  };
}

/**
 * Whether an `INPUT-REQUIRED` step has what it needs.
 *
 * Three shapes, and they are not interchangeable:
 *
 * - **manual** — the caller must name the step (`{id: "<key>"}`). Naming it
 *   *is* the trigger, and the value is never fed to the generator.
 * - **unsolicited** — the engine gives it an empty input list precisely so it
 *   fires on its own; asking for input would deadlock it.
 * - **declared inputs** — any inputs at all release it; the generator decides
 *   what it can use.
 */
export function inputGate(
  step: MappedStep,
  inputs: Record<string, unknown> | undefined,
): { ready: boolean; message: string } {
  if (step.manual === true) {
    const named = inputs?.["id"] === step.actionId;
    return {
      ready: named,
      message: `Step "${step.actionId}" is manual — it only fires when you name it. Call flow_proceed with inputs {"id": "${step.actionId}"}.`,
    };
  }

  if (step.input !== undefined && step.input.length === 0) {
    // Unsolicited: the empty input list is the auto-fire marker.
    return { ready: true, message: "" };
  }

  return {
    ready: inputs !== undefined && Object.keys(inputs).length > 0,
    message: `Step "${step.actionId}" needs input before it can be sent. Call flow_proceed again with the values under \`inputs\`.`,
  };
}

/** Step key → owner, read off the mock config for `toEngineFlow`'s fallback. */
export function ownerByActionId(
  config: UpstreamMockConfig,
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const step of config.steps) {
    if (step.owner !== undefined) owners.set(step.action_id, step.owner);
  }
  return owners;
}

/**
 * Every flow step must resolve to a config step, or generation fails mid-loop.
 *
 * Checked at `flow_start`, when the caller can still choose another flow.
 */
export function assertStepsAreRunnable(
  flow: EngineFlow,
  config: UpstreamMockConfig,
): void {
  const known = new Set(config.steps.map((step) => step.action_id));
  const missing = [...flow.sequence, ...(flow.extraSequence ?? [])]
    .map((step) => step.key)
    .filter((key) => !known.has(key));

  if (missing.length > 0) {
    throw new ValidationError(
      `Flow "${flow.id}" declares step(s) its mock config does not implement: ${missing.join(", ")}. ` +
        "This flow cannot be driven; pick another one.",
      { flow_id: flow.id, missing_steps: missing },
    );
  }
}

/** The `saveData` map for one step, across main and extra steps. */
export function saveDataFor(
  config: UpstreamMockConfig,
  actionId: string,
): Record<string, string> {
  const step = config.steps.find((entry) => entry.action_id === actionId);
  const saveData = step?.mock?.saveData;
  return isStringMap(saveData) ? saveData : {};
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

/**
 * A generated payload must carry a usable context: the flow is keyed on
 * `message_id` and replayed in `timestamp` order, and a payload without them
 * cannot be matched to its callback.
 */
/** `context.transaction_id` as generated, or undefined if it is unusable. */
export function readTransactionId(
  payload: Record<string, unknown>,
): string | undefined {
  const context = payload["context"];
  if (typeof context !== "object" || context === null) return undefined;
  const value = (context as Record<string, unknown>)["transaction_id"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Put the transaction id the record is keyed on onto the payload.
 *
 * Mutates the generated object in place, before it is stored or sent, so the
 * bytes on the wire and the bytes we record are the same bytes. Creates
 * `context` if the generator produced none — a payload with no context is
 * already broken, but it is the receiver's job to say so, not ours to crash on.
 */
export function writeTransactionId(
  payload: Record<string, unknown>,
  transactionId: string,
): void {
  const context = payload["context"];
  if (typeof context === "object" && context !== null) {
    (context as Record<string, unknown>)["transaction_id"] = transactionId;
    return;
  }
  payload["context"] = { transaction_id: transactionId };
}

function readContext(payload: Record<string, unknown>): {
  message_id: string;
  timestamp: string;
} {
  const context = payload["context"];
  const record =
    typeof context === "object" && context !== null
      ? (context as Record<string, unknown>)
      : {};

  return {
    message_id:
      typeof record["message_id"] === "string"
        ? record["message_id"]
        : randomUUID(),
    timestamp:
      typeof record["timestamp"] === "string"
        ? record["timestamp"]
        : new Date().toISOString(),
  };
}

function synthesiseExtra(step: EngineSequenceStep): MappedStep {
  return {
    status: "RESPONDING",
    actionId: step.key,
    owner: step.owner,
    actionType: step.type,
    input: step.input,
    index: -1,
    unsolicited: step.unsolicited,
    pairActionId: step.pair,
    description: step.description,
    label: step.label,
    isExtraStep: true,
  };
}

/**
 * What a step declares it needs, from both places it can be declared.
 *
 * The mock config's declaration is passed second — it wins, being the one the
 * step's `generate` was authored against.
 */
function specFor(step: MappedStep, config: UpstreamMockConfig): InputSpec {
  return resolveInputSpec(step.input, mockStepInputs(config, step.actionId));
}

/**
 * The two things a validation failure has to be read against.
 *
 * Omitted entirely for a step that declares no inputs — there the payload
 * really is the config's own work, and saying so by silence is honest.
 */
function inputEvidence(
  step: MappedStep,
  config: UpstreamMockConfig,
  inputs: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const spec = specFor(step, config);
  if (spec.fields.length === 0) return {};

  return {
    declared_inputs: describeInputs(spec),
    supplied_inputs: inputs ?? null,
  };
}

function toStepState(
  step: MappedStep,
  mockRole: Session["mock_role"],
  config: UpstreamMockConfig,
): FlowStatusOutput["sequence"][number] {
  const payloadIds =
    step.payloads?.entryType === "API"
      ? step.payloads.payloads.map((entry) => entry.payloadId)
      : [];

  return {
    key: step.actionId,
    action: step.actionType,
    owner: step.owner,
    // `actorFor` answers relative to the mock, which is what the model needs:
    // 'mock' means produce it, 'np' means wait for it.
    actor: actorFor(step.owner, mockRole),
    status: step.status,
    index: step.index,
    ...(step.description !== undefined
      ? { description: step.description }
      : {}),
    ...(step.label !== undefined ? { label: step.label } : {}),
    unsolicited: step.unsolicited,
    pair: step.pairActionId,
    payload_ids: payloadIds,
    ...(step.payloads?.entryType === "API"
      ? { ack: step.payloads.subStatus === "SUCCESS" ? "ACK" : "NACK" }
      : {}),
    ...(step.status === "INPUT-REQUIRED"
      ? { inputs_required: describeInputs(specFor(step, config)) }
      : {}),
    ...(step.awaitingMessageId !== undefined
      ? { awaiting_message_id: step.awaitingMessageId }
      : {}),
  } as const;
}

function toMissedStep(step: MappedStep): MissedStep {
  return {
    action: step.actionType,
    owner: step.owner,
    reason: step.description ?? "did not match the flow",
    expected_at_index: step.index,
    payload_ids:
      step.payloads?.entryType === "API"
        ? step.payloads.payloads.map((entry) => entry.payloadId)
        : [],
  };
}

/** Recorded entry → the event shape `flow_await` reports. */
function toEvent(entry: HistoryEntry): TransactionEvent {
  if (entry.entryType === "FORM") {
    return {
      seq: entry.seq,
      kind: "FORM_SUBMITTED",
      action: entry.formId,
      ...(entry.error !== undefined ? { detail: entry.error } : {}),
    };
  }
  return {
    seq: entry.seq,
    kind: entry.direction === "inbound" ? "INBOUND" : "OUTBOUND",
    action: entry.action,
    payload_id: entry.payloadId,
  };
}

/**
 * Whether this run is expecting the **participant** to do the next thing.
 *
 * The question a run-scoped wait has to ask before it parks, because the answer
 * decides whether parking can succeed at all. Only two outcomes leave the next
 * move with the counterparty: `WAITING` for a protocol call, and a form this
 * mock *hosts*, which they have to submit. Everything else — `READY`,
 * `INPUT_REQUIRED`, a form we have to fill, `COMPLETE`, `BLOCKED` — is the
 * caller's own turn, and a wait on it can only ever run out the clock. Two live
 * runs did exactly that for five minutes each, one on `COMPLETE` and one on
 * `INPUT_REQUIRED`, with the answer already sitting in `next`.
 *
 * The one real exception is deliberately not decided here: a participant may
 * still fire an unsolicited side-channel step after the main sequence is done.
 * That is what an explicit `timeout_ms` is for — it says "wait anyway", and it
 * bypasses this.
 */
export function awaitable(outcome: StepOutcome): boolean {
  if (outcome.outcome === "WAITING") return true;
  return outcome.outcome === "FORM_PENDING" && outcome.form_role === "host";
}

/**
 * Whether an event is one the caller asked to be **woken** for.
 *
 * Not whether it is delivered — everything drained is delivered. An absent
 * filter matches everything, which is what makes the unfiltered wait the
 * simple case it should be.
 */
export function matchesFilter(
  event: SessionEvent,
  filter: {
    kinds?: SessionEventKind[] | undefined;
    flowIds?: string[] | undefined;
  },
): boolean {
  if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) {
    return false;
  }
  if (filter.flowIds !== undefined) {
    if (event.flow_id === undefined) return false;
    if (!filter.flowIds.includes(event.flow_id)) return false;
  }
  return true;
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  return Array.isArray(value) && value.length === 0;
}

/** Registry ids are conventionally the subscriber's host. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
