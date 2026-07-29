import { randomUUID } from "node:crypto";
import type { MockRunner } from "@ondc/automation-mock-runner";
import type { MockPlaygroundConfigType } from "@ondc/automation-mock-runner";
import type { Logger } from "pino";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors.js";
import type {
  TransactionEvent,
  TransactionEvents,
} from "@/lib/events/transaction-events.js";
import type { MockEngine } from "@/lib/mock-engine/mock-engine.js";
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
  FlowStatusCode,
  MappedStep,
} from "@/modules/flow/engine/engine-types.js";
import {
  getFlowCompleteStatus,
  getNextActions,
} from "@/modules/flow/engine/flow-mapper.js";
import { toEngineFlow } from "@/modules/flow/engine/to-engine-flow.js";
import type { FlowRepository } from "@/modules/flow/flow.repository.js";
import type {
  FlowBinding,
  FlowStatusOutput,
  MissedStep,
  StepOutcome,
} from "@/modules/flow/flow.schema.js";
import {
  flowRunKey,
  transactionKey,
} from "@/modules/record/record.repository.js";
import {
  emptyTransactionRecord,
  type RecordService,
} from "@/modules/record/record.service.js";
import type {
  HistoryEntry,
  TransactionRecord,
} from "@/modules/record/record.schema.js";
import type { Session } from "@/modules/session/session.schema.js";
import {
  receiverScope,
  type SessionService,
} from "@/modules/session/session.service.js";
import type { SenderService } from "@/modules/transport/sender.service.js";

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

export interface FlowServiceOptions {
  sessions: SessionService;
  catalog: CatalogService;
  records: RecordService;
  /** Flow runs and the transaction ids they eventually bind to. */
  repository: FlowRepository;
  sender: SenderService;
  mockEngine: MockEngine;
  events: TransactionEvents;
  logger: Logger;
  /**
   * Base URL a participant can reach this mock's receiver on. Advertised as
   * `bap_uri`/`bpp_uri`, so a wrong value means callbacks go nowhere.
   */
  receiverPublicUrl: string;
  /** Registry-style id advertised as `bap_id`/`bpp_id`. */
  mockSubscriberId: string;
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

export interface ProceedArgs extends FlowRef {
  sessionId: string;
  inputs?: Record<string, unknown> | undefined;
  triggerExtra?: string | undefined;
  dryRun?: boolean | undefined;
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

export class FlowService {
  readonly #sessions: SessionService;
  readonly #catalog: CatalogService;
  readonly #records: RecordService;
  readonly #repository: FlowRepository;
  readonly #sender: SenderService;
  readonly #mockEngine: MockEngine;
  readonly #events: TransactionEvents;
  readonly #logger: Logger;
  readonly #receiverPublicUrl: string;
  readonly #mockSubscriberId: string;

  constructor(options: FlowServiceOptions) {
    this.#sessions = options.sessions;
    this.#catalog = options.catalog;
    this.#records = options.records;
    this.#repository = options.repository;
    this.#sender = options.sender;
    this.#mockEngine = options.mockEngine;
    this.#events = options.events;
    this.#logger = options.logger;
    this.#receiverPublicUrl = options.receiverPublicUrl.replace(/\/+$/, "");
    this.#mockSubscriberId = options.mockSubscriberId;
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
   * Open a transaction against a flow and report what its first step needs.
   *
   * Everything that can be wrong with a flow is checked **here**, at the one
   * moment the caller can still choose a different one: that the flow exists,
   * that a mock config was published for it, that every step has an owner, and
   * that the two agree on the step keys. Discovering any of these mid-loop
   * would strand a half-run transaction.
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

    const transactionId = args.transactionId ?? randomUUID();
    const autoAdvance = args.autoAdvance ?? session.auto_advance;

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
      flowId: args.flowId,
      // The engine reads this as "the side the participant under test is on".
      subscriberType: session.np.type,
      subscriberUrl: session.np.subscriber_url,
      scope: receiverScope(session),
      autoAdvance,
    });

    // The canned identity in a published config points at bap.example.com.
    // Seeding ours before the first generate is what stops it leaking onto
    // the wire.
    await this.#records.overwriteBusinessData(
      transactionId,
      session.np.subscriber_url,
      this.#seedIdentity(session, transactionId, {}),
    );

    const runner = this.#mockEngine.getRunner(
      key,
      config as unknown as MockPlaygroundConfigType,
    );
    const runtime: FlowRuntime = {
      session,
      record,
      upstreamFlow,
      flow,
      config,
      runner,
    };

    this.#logger.info(
      {
        sessionId: session.session_id,
        transactionId,
        flowId: args.flowId,
        mockRole: session.mock_role,
        autoAdvance,
      },
      "flow started",
    );

    return {
      runtime,
      outcome: await this.describeNext(runtime),
      autoAdvance,
    };
  }

  /* -------------------------------- status -------------------------------- */

  async status(
    sessionId: string,
    transactionId: string,
  ): Promise<FlowStatusOutput> {
    const runtime = await this.load(sessionId, transactionId);
    const { session, record, flow } = runtime;

    const flowStatus = await this.#records.getFlowStatus(
      transactionId,
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
      transaction_id: transactionId,
      flow_id: record.flowId,
      flow_status:
        flowStatus === "SUSPENDED"
          ? "BLOCKED"
          : complete
            ? "COMPLETE"
            : record.apiList.length === 0
              ? "NOT_STARTED"
              : "IN_PROGRESS",
      mock_role: session.mock_role,
      seq: record.seq,
      sequence: map.sequence.map((step) =>
        toStepState(step, session.mock_role),
      ),
      extra_steps: (map.extraSteps ?? []).map((step) =>
        toStepState(step, session.mock_role),
      ),
      missed_steps: map.missedSteps.map(toMissedStep),
      next,
      reference_data_keys: Object.entries(map.reference_data ?? {})
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key]) => key),
      ...(record.attention ? { attention: record.attention } : {}),
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
    const runtime = await this.load(args.sessionId, args.transactionId);
    const { session } = runtime;
    const subscriberUrl = session.np.subscriber_url;

    const flowStatus = await this.#records.getFlowStatus(
      args.transactionId,
      subscriberUrl,
    );
    if (flowStatus === "SUSPENDED") {
      return blocked(
        "flow_suspended",
        "This flow has been suspended and cannot be advanced.",
      );
    }

    const target = await this.#selectTarget(runtime, flowStatus, args);

    switch (target.kind) {
      case "outcome":
        return target.outcome;

      case "listen":
        await this.#armExpectation(runtime, target.step);
        return {
          outcome: "WAITING",
          message: `Waiting for the participant to send ${target.step.actionType}. Call flow_await.`,
          step_key: target.step.actionId,
          action: target.step.actionType,
          expected_action: target.step.actionType,
        };

      case "form":
        return this.#formOutcome(runtime, target.step, args.inputs);

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
   */
  async awaitEvent(args: {
    sessionId: string;
    transactionId: string;
    afterSeq?: number | undefined;
    timeoutMs: number;
  }): Promise<{
    timedOut: boolean;
    seq: number;
    event?: TransactionEvent | undefined;
    next: StepOutcome;
  }> {
    const runtime = await this.load(args.sessionId, args.transactionId);
    const afterSeq = args.afterSeq ?? 0;

    // 1. Anything already recorded wins, with no waiting at all.
    const recorded = runtime.record.apiList
      .filter((entry) => entry.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)[0];

    if (recorded) {
      return {
        timedOut: false,
        seq: runtime.record.seq,
        event: toEvent(recorded),
        next: await this.describeNext(runtime),
      };
    }

    // 2. Nothing yet: park.
    const event = await this.#events.waitFor(
      transactionKey(args.transactionId, runtime.session.np.subscriber_url),
      { afterSeq, timeoutMs: args.timeoutMs },
    );

    // Re-load: the record moved while we were parked, and `next` has to be
    // computed from what is true now.
    const after = await this.load(args.sessionId, args.transactionId);

    return {
      timedOut: event === undefined,
      seq: after.record.seq,
      event,
      next: await this.describeNext(after),
    };
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
      const outcome = await this.proceed({ sessionId, transactionId });

      if (outcome.outcome === "SENT") {
        const runtime = await this.load(sessionId, transactionId);
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
    const runtime = await this.load(sessionId, transactionId);
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
      // principle — but a transaction opened before this run's binding was
      // written (or one adopted from an expectation on a restarted process)
      // may have none stored. Derive it from the record rather than failing:
      // the record is the more authoritative of the two.
      const stored = await this.#repository.findBinding(
        session.session_id,
        record.flowId,
      );
      return {
        binding: stored ?? {
          sessionId: session.session_id,
          flowId: record.flowId,
          autoAdvance: record.autoAdvance,
          transactionId: record.transactionId,
          startedAt: record.createdAt,
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
  #placeholderRecord(session: Session, binding: FlowBinding): TransactionRecord {
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
    const flowStatus = await this.#records.getFlowStatus(
      runtime.record.transactionId,
      runtime.session.np.subscriber_url,
    );
    if (flowStatus === "SUSPENDED") {
      return blocked("flow_suspended", "This flow has been suspended.");
    }

    // No inputs and no trigger: describe what would happen to a bare call.
    const target = await this.#selectTarget(runtime, flowStatus, {});

    switch (target.kind) {
      case "outcome":
        return target.outcome;
      case "listen":
        return {
          outcome: "WAITING",
          message: `Waiting for the participant to send ${target.step.actionType}. Call flow_await.`,
          step_key: target.step.actionId,
          action: target.step.actionType,
          expected_action: target.step.actionType,
        };
      case "form":
        return this.#formOutcome(runtime, target.step, undefined);
      case "dispatch":
        return {
          outcome: "READY",
          message: `Step "${target.step.actionId}" (${target.step.actionType}) is this mock's to send. Call flow_proceed.`,
          step_key: target.step.actionId,
          action: target.step.actionType,
        };
    }
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
                outcome: {
                  outcome: "INPUT_REQUIRED",
                  message: gate.message,
                  step_key: sequenceNext.actionId,
                  action: sequenceNext.actionType,
                  inputs_required: sequenceNext.input ?? [],
                },
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
   * Generate, then send.
   *
   * The `WORKING` marker around the whole thing is the concurrency guard, and
   * the `finally` that clears it is what stops a crashed generate from wedging
   * the step until its TTL.
   */
  async #dispatch(
    runtime: FlowRuntime,
    step: MappedStep,
    args: ProceedArgs,
  ): Promise<StepOutcome> {
    const { session, record } = runtime;
    const subscriberUrl = session.np.subscriber_url;
    const isExtra = step.isExtraStep === true;
    const statusKey = isExtra ? step.actionId : undefined;

    await this.#records.setFlowStatus(
      record.transactionId,
      subscriberUrl,
      "WORKING",
      statusKey,
    );

    try {
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
      const context = readContext(payload);

      if (args.dryRun === true) {
        const payloadId = await this.#records.storePayload({
          transactionId: record.transactionId,
          subscriberUrl,
          direction: "outbound",
          action: step.actionType,
          messageId: context.message_id,
          timestamp: context.timestamp,
          body: payload,
        });
        return {
          outcome: "DRAFTED",
          message: `Generated ${step.actionType} but did not send it. Inspect it with record_get_payload, then call flow_proceed again without dry_run.`,
          step_key: step.actionId,
          action: step.actionType,
          payload_id: payloadId,
        };
      }

      const sent = await this.#sender.send(
        subscriberUrl,
        step.actionType,
        payload,
      );

      const { payloadId } = await this.#records.appendApiEntry({
        transactionId: record.transactionId,
        subscriberUrl,
        action: step.actionType,
        messageId: context.message_id,
        direction: "outbound",
        // Ordering replay by the payload's own timestamp, not by arrival, is
        // what keeps a request and its callback in the right order.
        timestamp: context.timestamp,
        body: payload,
        ackBody: sent.body,
        httpStatus: sent.httpStatus,
      });

      await this.#records.saveBusinessData(
        record.transactionId,
        subscriberUrl,
        payload,
        saveDataFor(runtime.config, step.actionId),
      );

      return {
        outcome: "SENT",
        message:
          sent.ack === "ACK"
            ? `Sent ${step.actionType}; the participant ACKed it. Call flow_await for the callback.`
            : `Sent ${step.actionType}; the participant answered ${sent.ack}. Read ack_body — this is a finding, not a transport failure.`,
        step_key: step.actionId,
        action: step.actionType,
        payload_id: payloadId,
        ack: sent.ack,
        http_status: sent.httpStatus,
        ack_body: sent.body,
      };
    } finally {
      await this.#records.setFlowStatus(
        record.transactionId,
        subscriberUrl,
        "AVAILABLE",
        statusKey,
      );
    }
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

  async #armExpectation(runtime: FlowRuntime, step: MappedStep): Promise<void> {
    await this.#records.armExpectation(receiverScope(runtime.session), {
      sessionId: runtime.session.session_id,
      flowId: runtime.record.flowId,
      transactionId: runtime.record.transactionId,
      expectedAction: step.actionType,
      subscriberUrl: runtime.session.np.subscriber_url,
      autoAdvance: runtime.record.autoAdvance,
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
        ? { bapId: ourId, bapUri: ourUri }
        : { bppId: ourId, bppUri: ourUri };
    const theirs =
      session.mock_role === "BAP"
        ? { bppId: theirId, bppUri: theirUri }
        : { bapId: theirId, bapUri: theirUri };

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

function toStepState(
  step: MappedStep,
  mockRole: Session["mock_role"],
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
      ? { inputs_required: step.input ?? [] }
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
