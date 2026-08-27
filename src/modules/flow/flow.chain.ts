import { load } from "@/modules/flow/flow.load.js";
import type { StepOutcome } from "@/modules/flow/flow.schema.js";
import { describeNext } from "@/modules/flow/flow.turn.js";
import type {
  FlowDeps,
  FlowLoop,
  FlowRuntime,
  ProceedArgs,
} from "@/modules/flow/flow.types.js";

/**
 * Auto-advance: keep sending this mock's own steps until something needs the
 * caller again.
 *
 * The re-entry is a **parameter**, not an import. `chainNext` advances the run
 * by calling `proceed` again, and `proceed` is the run lock, which lives on
 * `FlowService` — so taking a `FlowLoop` keeps the import graph one-way and
 * puts the recursion in a signature instead of behind `this`.
 *
 * It must be bound to the *public* `proceed`: that is the single outward
 * observation point the incident corpus counts on, and binding past it would
 * stop a chained step being observed at all.
 *
 * Chaining is scheduled, never awaited — the outcome is already the caller's
 * answer — which is exactly why every send here journals `CHAIN_SENT`. That
 * line is the only thing that reaches a model for traffic it did not ask for,
 * and it is what makes auto-advance safe to have on by default.
 */

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
export async function chainNext(
  deps: FlowDeps,
  loop: FlowLoop,
  sessionId: string,
  transactionId: string,
  maxSteps = 20,
): Promise<void> {
  for (let step = 0; step < maxSteps; step++) {
    const outcome = await loop.proceed({
      sessionId,
      transactionId,
      chained: true,
    });

    if (outcome.outcome === "SENT") {
      const runtime = await load(deps, sessionId, { transactionId });
      deps.records.publishEvent(runtime.record, {
        kind: "CHAIN_SENT",
        ...(outcome.action !== undefined ? { action: outcome.action } : {}),
        ...(outcome.payload_id !== undefined
          ? { payload_id: outcome.payload_id }
          : {}),
      });
      continue;
    }

    await pauseChain(deps, sessionId, transactionId, outcome);
    return;
  }

  await pauseChain(deps, sessionId, transactionId, {
    outcome: "BLOCKED",
    message: `Auto-advance stopped after ${String(maxSteps)} consecutive sends. This flow may be looping.`,
    reason: "chain_limit",
  });
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
export function scheduleChain(
  deps: FlowDeps,
  loop: FlowLoop,
  args: ProceedArgs,
  outcome: StepOutcome,
): void {
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
        const record = await deps.records.findTransaction(
          transactionId,
          (await deps.sessions.requireSession(args.sessionId)).np
            .subscriber_url,
        );
        if (!record?.autoAdvance || record.abandoned) return;
        await chainNext(deps, loop, args.sessionId, transactionId);
      } catch (error) {
        deps.logger.error(
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
        await deps.records.journal(args.sessionId, {
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

async function pauseChain(
  deps: FlowDeps,
  sessionId: string,
  transactionId: string,
  outcome: StepOutcome,
): Promise<void> {
  const runtime = await load(deps, sessionId, { transactionId });
  const subscriberUrl = runtime.session.np.subscriber_url;

  // WAITING is not a pause worth flagging — it is the loop working correctly.
  const noteworthy =
    outcome.outcome !== "WAITING" && outcome.outcome !== "COMPLETE";

  if (noteworthy) {
    await deps.records.setAttention(transactionId, subscriberUrl, {
      kind: outcome.outcome,
      message: outcome.message,
      ...(outcome.step_key !== undefined
        ? { step_key: outcome.step_key }
        : {}),
      at: new Date().toISOString(),
    });
  }

  deps.records.publishEvent(runtime.record, {
    kind: "CHAIN_PAUSED",
    ...(outcome.action !== undefined ? { action: outcome.action } : {}),
    detail: outcome.message,
  });

  // One journal line, not two. A pause already sets `attention` with the same
  // message, so also journaling `ATTENTION` would say the same thing twice —
  // and `CHAIN_PAUSED` is the more specific of the pair, because it names the
  // thing the model has to act on *and* the fact that nobody was watching.
  if (outcome.outcome === "COMPLETE") {
    await journalCompletion(deps, runtime);
    return;
  }

  await deps.records.journal(sessionId, {
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
async function journalCompletion(
  deps: FlowDeps,
  runtime: FlowRuntime,
): Promise<void> {
  if (!runtime.bound) return;
  const transactionId = runtime.record.transactionId;

  const first = await deps.records.claimFirst(`complete::${transactionId}`);
  if (!first) return;

  await deps.records.journal(runtime.session.session_id, {
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
export async function noteCompletion(
  deps: FlowDeps,
  sessionId: string,
  transactionId: string,
): Promise<void> {
  try {
    const runtime = await load(deps, sessionId, { transactionId });
    if (runtime.record.abandoned) return;
    const next = await describeNext(deps, runtime);
    if (next.outcome !== "COMPLETE") return;
    await journalCompletion(deps, runtime);
  } catch (error) {
    deps.logger.warn(
      { err: error, session_id: sessionId, transaction_id: transactionId },
      "could not check whether the flow had completed",
    );
  }
}
