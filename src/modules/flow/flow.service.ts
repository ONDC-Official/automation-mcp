import {
  type FlowBinding,
  type FlowStatusOutput,
  type StepOutcome,
} from "@/modules/flow/flow.schema.js";
import { flowRunKey } from "@/modules/record/record.repository.js";
import {
  abandonedOutcome,
  blocked,
  listening,
  stamp,
} from "@/modules/flow/flow.outcomes.js";
import { awaitEvent } from "@/modules/flow/flow.await-run.js";
import {
  chainNext,
  noteCompletion,
  scheduleChain,
} from "@/modules/flow/flow.chain.js";
import { restart } from "@/modules/flow/flow.restart.js";
import { start } from "@/modules/flow/flow.start.js";
import { flowView, listRuns, status } from "@/modules/flow/flow.view.js";
import { dispatch } from "@/modules/flow/flow.dispatch.js";
import {
  adoptTransaction,
  callbackUrl,
} from "@/modules/flow/flow.identity.js";
import {
  armExpectation,
  describeNext,
  formOutcome,
} from "@/modules/flow/flow.turn.js";
import { selectTarget } from "@/modules/flow/flow.target.js";
import {
  load,
  lockId,
  runSeq,
} from "@/modules/flow/flow.load.js";
import {
  type FlowDeps,
  type FlowLoop,
  type FlowRef,
  type FlowRunView,
  type FlowRuntime,
  type FlowServiceOptions,
  type ProceedArgs,
  type RestartArgs,
  type RestartResult,
  type StartFlowArgs,
  toFlowDeps,
} from "@/modules/flow/flow.types.js";
import type { Session } from "@/modules/session/session.schema.js";

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


/*
 * The loop's shapes live in `flow.types.ts` so the loop's own files can share
 * them without importing each other. Re-exported here because this module's
 * public face has always been `flow.service.js` — `forms.service.ts` imports
 * `FlowRuntime` from it, and nothing outside this directory should have to
 * learn that the file was split.
 */
export type {
  AwaitResult,
  FeedbackObserver,
  FlowDeps,
  FlowLoop,
  FlowRef,
  FlowRunView,
  FlowRuntime,
  FlowServiceOptions,
  ProceedArgs,
  RestartArgs,
  RestartResult,
  RunMirror,
  StartFlowArgs,
} from "@/modules/flow/flow.types.js";

export class FlowService {
  /**
   * Every collaborator, in one object, so the loop's own files can be handed
   * it whole. `toFlowDeps` normalises `receiverPublicUrl` — the one member
   * whose meaning differs from what the constructor was given.
   */
  readonly #deps: FlowDeps;

  /**
   * One in-flight `flow_proceed` per run, in this process.
   *
   * Same shape and the same limit as `RecordService#expectationLocks`: it
   * serialises this process, not the cluster. Two processes sharing a Redis
   * still race, and closing that needs the store to grow a compare-and-set —
   * which is where it belongs, not here.
   *
   * The only mutable state in the loop, and the reason `FlowService` stays a
   * class while everything it delegates to is a free function.
   */
  readonly #runLocks = new Map<string, Promise<unknown>>();

  /**
   * Re-entry for `chainNext`, bound to the **public** `proceed`.
   *
   * Not the inner advance: `proceed` is the run lock *and* the single outward
   * observation point the incident corpus counts on, so binding past it would
   * both drop the lock and stop a chained step being observed.
   */
  readonly #loop: FlowLoop = {
    proceed: (args: ProceedArgs): Promise<StepOutcome> => this.proceed(args),
  };

  constructor(options: FlowServiceOptions) {
    this.#deps = toFlowDeps(options);
  }

  /** Open a run. See `flow.start.ts`. */
  start(args: StartFlowArgs): ReturnType<typeof start> {
    return start(this.#deps, args);
  }

  /** The derived flow map for one run. See `flow.view.ts`. */
  status(sessionId: string, ref: FlowRef): Promise<FlowStatusOutput> {
    return status(this.#deps, sessionId, ref);
  }

  /** Every run in a session. */
  listRuns(sessionId: string): Promise<FlowBinding[]> {
    return listRuns(this.#deps, sessionId);
  }

  /** The same read `status` does, one step before projection. */
  flowView(sessionId: string, ref: FlowRef): Promise<FlowRunView> {
    return flowView(this.#deps, sessionId, ref);
  }

  /** Auto-advance the run. See `flow.chain.ts`. */
  chainNext(sessionId: string, transactionId: string): Promise<void> {
    return chainNext(this.#deps, this.#loop, sessionId, transactionId);
  }

  /** Journal a completion the model did not observe. */
  noteCompletion(
    ...args: Parameters<typeof noteCompletion> extends [unknown, ...infer R]
      ? R
      : never
  ): ReturnType<typeof noteCompletion> {
    return noteCompletion(this.#deps, ...args);
  }

  /* --------------------------------- start -------------------------------- */

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
      restart(this.#deps, args),
    );
  }

  /* -------------------------------- status -------------------------------- */

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
    scheduleChain(this.#deps, this.#loop, args, outcome);
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
    const feedback = this.#deps.feedback;
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
      this.#deps.logger.warn(
        { err: observerError, session_id: args.sessionId },
        "the feedback observer threw; the flow outcome is unaffected",
      );
    }
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
    const runtime = await load(this.#deps, args.sessionId, args);
    const { session } = runtime;
    const subscriberUrl = session.np.subscriber_url;

    // Reachable only by naming the abandoned attempt's `transaction_id` —
    // by `flow_id` the binding already points at the current one. Two callers
    // do exactly that: a model still holding the old id, and `chainNext`,
    // which advances by id. Left unguarded, a late callback on a written-off
    // attempt would auto-advance it and put fresh payloads on the wire.
    if (runtime.record.abandoned) return abandonedOutcome(runtime);

    const flowStatus = await this.#deps.records.getFlowStatus(
      lockId(runtime),
      subscriberUrl,
    );
    if (flowStatus === "SUSPENDED") {
      return stamp(
        runtime,
        blocked(
          "flow_suspended",
          "This flow has been suspended and cannot be advanced.",
        ),
      );
    }

    const target = await selectTarget(this.#deps, runtime, flowStatus, args);

    /*
     * Overrides only mean something on the branch that generates a payload.
     *
     * Silently dropping them on any other branch is exactly the failure this
     * whole feature exists to answer: a caller states an intent, nothing
     * honours it, and nothing says so. Refusing costs the run nothing —
     * nothing has been generated, recorded or sent at this point.
     */
    if (args.payloadOverrides !== undefined && target.kind !== "dispatch") {
      return stamp(
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
        return stamp(runtime, target.outcome);

      case "listen":
        await armExpectation(this.#deps, runtime, target.step);
        return stamp(runtime, listening(target.step));

      case "form":
        return stamp(
          runtime,
          await formOutcome(this.#deps, runtime, target.step, args.inputs),
        );

      // The one branch that can bind the run, so it stamps its own answer.
      case "dispatch":
        return dispatch(this.#deps, runtime, target.step, args);
    }
  }

  /* --------------------------------- await --------------------------------- */

  /* --------------------------------- chain --------------------------------- */

  /* --------------------------------- shared -------------------------------- */

  /** Resolve everything one turn needs. See `flow.load.ts`. */
  load(sessionId: string, ref: FlowRef): Promise<FlowRuntime> {
    return load(this.#deps, sessionId, ref);
  }

  /**
   * What the participant must call us back on. See `flow.identity.ts`.
   */
  callbackUrl(session: Session): string {
    return callbackUrl(session);
  }

  /** Adopt the transaction the *participant* chose. See `flow.identity.ts`. */
  adoptTransaction(
    args: Parameters<typeof adoptTransaction>[1],
  ): ReturnType<typeof adoptTransaction> {
    return adoptTransaction(this.#deps, args);
  }

  /**
   * Block until the participant does something, or the budget runs out.
   * See `flow.await-run.ts` for the four ways this used to never end.
   */
  awaitEvent(
    args: Parameters<typeof awaitEvent>[1],
  ): ReturnType<typeof awaitEvent> {
    return awaitEvent(this.#deps, args);
  }

  /** What the loop needs next, without doing any of it. See `flow.turn.ts`. */
  describeNext(runtime: FlowRuntime): Promise<StepOutcome> {
    return describeNext(this.#deps, runtime);
  }

  /** This run's latest event number — the cursor `flow_await` takes. */
  runSeq(
    sessionId: string,
    transactionId: string | undefined,
  ): Promise<number | undefined> {
    return runSeq(this.#deps, sessionId, transactionId);
  }

  /* ------------------------------ internals ------------------------------- */

}

/* -------------------------------------------------------------------------- */
/* Target selection result                                                     */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */
