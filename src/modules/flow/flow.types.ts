import type { MockRunner } from "@ondc/automation-mock-runner";
import type { Logger } from "pino";
import type {
  TransactionEvent,
  TransactionEvents,
} from "@/lib/events/transaction-events.js";
import type { Metrics } from "@/lib/metrics/metrics.js";
import type { MockEngine } from "@/lib/mock-engine/mock-engine.js";
import type { CatalogService } from "@/modules/catalog/catalog.service.js";
import type {
  UpstreamFlow,
  UpstreamMockConfig,
} from "@/modules/catalog/catalog.schema.js";
import type {
  EngineFlow,
  FlowMap,
  MappedStep,
} from "@/modules/flow/engine/engine-types.js";
import type { FlowRepository } from "@/modules/flow/flow.repository.js";
import type {
  FlowBinding,
  FlowStatusOutput,
  RunSummary,
  StepOutcome,
} from "@/modules/flow/flow.schema.js";
import type { RecordService } from "@/modules/record/record.service.js";
import type {
  EventsDelta,
  TransactionRecord,
} from "@/modules/record/record.schema.js";
import type { Session } from "@/modules/session/session.schema.js";
import type { SessionService } from "@/modules/session/session.service.js";
import type { ValidateService } from "@/modules/validate/validate.service.js";
import type { SenderService } from "@/modules/transport/sender.service.js";

/**
 * The shapes the loop is written in terms of.
 *
 * Split out of `flow.service.ts` so the loop's own files — start, await,
 * dispatch, chain — can share them without importing each other. Nothing here
 * has behaviour; `flow.service.ts` re-exports the lot, so no caller outside
 * this module ever learns this file exists.
 */

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


/**
 * What this turn is about, as a description rather than an action.
 *
 * Returned by `selectTarget` and consumed by both the branch that acts on it
 * and the branch that merely reports it, which is what keeps `flow_proceed`
 * and `flow_get_status` from ever disagreeing about the same run.
 */
export type Target =
  | { kind: "outcome"; outcome: StepOutcome }
  | { kind: "dispatch"; step: MappedStep }
  | { kind: "listen"; step: MappedStep }
  | { kind: "form"; step: MappedStep };

/**
 * What an extracted piece of the loop is handed.
 *
 * Deliberately the constructor's own dependency list rather than a new
 * abstraction over it: the loop's private methods were already stateless
 * functions of `FlowRuntime` plus these collaborators, so passing them
 * explicitly is what makes each one callable on its own. `FlowService` keeps
 * the only mutable thing there is — the run locks.
 *
 * The one member whose meaning differs from the constructor's contract is
 * redeclared, because the difference matters: `receiverPublicUrl` here is
 * **already trailing-slash-normalised**. `toFlowDeps` is the only place
 * allowed to strip it, so `mockBaseUrl` in `seedIdentity` cannot acquire a
 * double slash that a published config's `createFormURL` then bakes into a URL
 * on a third party's wire.
 */
export interface FlowDeps
  extends Readonly<Omit<FlowServiceOptions, "receiverPublicUrl">> {
  readonly receiverPublicUrl: string;
}

export function toFlowDeps(options: FlowServiceOptions): FlowDeps {
  return {
    ...options,
    receiverPublicUrl: options.receiverPublicUrl.replace(/\/+$/, ""),
  };
}

/**
 * Re-entry into the loop, as a port rather than an import.
 *
 * `chainNext` advances the run by calling `proceed` again — and `proceed` is
 * the run lock, which lives on the service. Handing it down as a callback is
 * what keeps the import graph one-way, the same trick `container.ts` uses to
 * untie `feedback` from `record`.
 *
 * It must be bound to the **public** `proceed`, never to the inner advance:
 * the public one is the single outward observation point the incident corpus
 * counts on, and binding past it would stop a chained step being observed at
 * all.
 */
export interface FlowLoop {
  proceed(args: ProceedArgs): Promise<StepOutcome>;
}
