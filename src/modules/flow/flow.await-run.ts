import type { SessionEventKind } from "@/modules/record/record.schema.js";
import type { TransactionEvent } from "@/lib/events/transaction-events.js";
import type {
  HistoryEntry,
  SessionEvent,
} from "@/modules/record/record.schema.js";
import {
  flowRunKey,
  journalKey,
  transactionKey,
} from "@/modules/record/record.repository.js";
import { load, lockId } from "@/modules/flow/flow.load.js";
import { receiverScope } from "@/modules/session/session.service.js";
import type { StepOutcome } from "@/modules/flow/flow.schema.js";
import { selectTarget } from "@/modules/flow/flow.target.js";
import { armExpectation, describeNext } from "@/modules/flow/flow.turn.js";
import { awaitSession } from "@/modules/flow/flow.await-session.js";
import type {
  AwaitResult,
  FlowDeps,
  FlowRuntime,
} from "@/modules/flow/flow.types.js";

/**
 * Waiting on one run, and the four ways that used to never end.
 *
 * Three live runs once spent five minutes each parked here with the callback
 * they were waiting for already on the record, and every cause produced the
 * same symptom: **a participant that did exactly the right thing became
 * indistinguishable from one that never called**, which is a compliance
 * report blaming the wrong side. The guards are, in order:
 *
 * - `after_seq` above `record.seq` is **discarded, not clamped**, and the
 *   answer says so — a larger cursor is the *journal's* counter, which is
 *   always further along, and taking it at face value went deaf to every
 *   future event rather than merely the recorded one.
 * - a run-scoped wait does not park when `next` is not `WAITING`, unless an
 *   explicit `timeout_ms` says to; both observed stalls were on `COMPLETE`
 *   and `INPUT_REQUIRED`, where parking can only run out the clock.
 * - the park races the session journal for `POSSIBLY_RELATED` and
 *   `ATTENTION` only, because those are the two kinds no transaction owns
 *   and therefore the two that publish no run event.
 * - `timeout_ms` defaults to 60s; the 300s cap is only a cap.
 */

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
export async function awaitEvent(
  deps: FlowDeps,
  args: {
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
    return awaitSession(deps, args);
  }

  const runtime = await load(deps, args.sessionId, args);
  const { cursor, adjusted } = effectiveAfterSeq(deps, runtime, args);

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
      next: await describeNext(deps, runtime),
      ...(adjusted !== undefined ? { afterSeqAdjusted: adjusted } : {}),
    };
  }

  // 2. Is there anything to wait *for*? A run whose next step is ours to send
  //    — or which is finished, or blocked — is not going to be moved by the
  //    participant, so parking on it buys nothing and costs the whole budget.
  const pending = await describeNext(deps, runtime);
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

  if (!runtime.bound) await rearmIfLapsed(deps, runtime);

  // 3. Nothing yet: park. A caller with no usable cursor is caught up by
  //    definition — step 1 just showed it the newest exchange, or there were
  //    none — so it waits from here rather than from the beginning.
  const event = await park(deps, 
    runtime,
    cursor ?? runtime.record.seq,
    args.timeoutMs,
  );

  // Re-load by the same ref: the record moved while we were parked, the run
  // may have acquired an id, and `next` has to be computed from what is true
  // now. Re-loading by `args.transactionId` alone would miss the binding.
  const after = await load(deps, args.sessionId, args);

  return {
    timedOut: event === undefined,
    scope: "run",
    waited: true,
    transactionId: after.bound ? after.record.transactionId : null,
    seq: after.record.seq,
    event,
    next: await describeNext(deps, after),
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
function effectiveAfterSeq(
  deps: FlowDeps,
  runtime: FlowRuntime,
  args: { afterSeq?: number | undefined; sessionId: string },
): { cursor?: number; adjusted?: number } {
  if (args.afterSeq === undefined) return {};

  const highWater = runtime.record.seq;
  if (args.afterSeq <= highWater) return { cursor: args.afterSeq };

  deps.logger.warn(
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
async function park(
  deps: FlowDeps,
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
  let journalSeq = await deps.records.eventCursor(sessionId);

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;

    // `waitFor` resolves `undefined` on its own timeout, so the loser of this
    // race settles harmlessly on the same deadline rather than leaking.
    const winner = await Promise.race([
      deps.events
        .waitFor(runKey, { afterSeq, timeoutMs: remaining })
        .then((event) => ({ from: "run" as const, event })),
      deps.events
        .waitFor(journalKey(sessionId), {
          afterSeq: journalSeq,
          timeoutMs: remaining,
        })
        .then((event) => ({ from: "journal" as const, event })),
    ]);

    if (winner.from === "run") return winner.event;
    if (winner.event === undefined) return undefined;

    const lines = await relevantJournalLines(deps, sessionId, journalSeq);
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
async function relevantJournalLines(
  deps: FlowDeps,
  sessionId: string,
  afterSeq: number,
): Promise<SessionEvent[]> {
  let lines: SessionEvent[];
  try {
    lines = await deps.records.readEvents(sessionId, afterSeq);
  } catch (error) {
    deps.logger.warn(
      { err: error, session_id: sessionId },
      "could not read the session journal while parked; staying parked",
    );
    return [];
  }

  return lines.filter((line) => DEAD_END_JOURNAL_KINDS.has(line.kind));
}

/**
 * Re-arm an unbound run's expectation if it has lapsed, before a long park.
 *
 * Only re-arms what is genuinely missing: `armExpectation` upserts on
 * `(sessionId, expectedAction)`, so re-arming an entry that is still live
 * would only push its `armedAt` forward and lose it the oldest-first
 * tie-break against another session on the same endpoint.
 */
export async function rearmIfLapsed(
  deps: FlowDeps,
  runtime: FlowRuntime,
): Promise<void> {
  const flowStatus = await deps.records.getFlowStatus(
    lockId(runtime),
    runtime.session.np.subscriber_url,
  );
  const target = await selectTarget(deps, runtime, flowStatus, {});
  if (target.kind !== "listen") return;

  const armed = await deps.records.expectationsForSession(
    receiverScope(runtime.session),
    runtime.session.session_id,
  );
  const live = armed.some(
    (entry) => entry.expectedAction === target.step.actionType,
  );
  if (live) return;

  deps.logger.info(
    {
      session_id: runtime.session.session_id,
      flow_id: runtime.binding.flowId,
      action: target.step.actionType,
    },
    "re-arming a lapsed expectation before a long wait",
  );
  await armExpectation(deps, runtime, target.step);

  // Worth a line: a lapsed expectation means the participant took longer than
  // the window to answer, and a callback that arrived in the gap was refused
  // 412. The model cannot see either of those from anywhere else.
  await deps.records.journal(runtime.session.session_id, {
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