import type {
  SessionEvent,
  SessionEventKind,
} from "@/modules/record/record.schema.js";
import { journalKey } from "@/modules/record/record.repository.js";
import type { Session } from "@/modules/session/session.schema.js";
import { load } from "@/modules/flow/flow.load.js";
import type {
  FlowBinding,
  RunSummary,
} from "@/modules/flow/flow.schema.js";
import { describeNext } from "@/modules/flow/flow.turn.js";
import { rearmIfLapsed } from "@/modules/flow/flow.await-run.js";
import type { AwaitResult, FlowDeps } from "@/modules/flow/flow.types.js";

/**
 * Waiting on a whole session, rather than on one run.
 *
 * Naming neither `flow_id` nor `transaction_id` blocks on everything at once.
 * It is a **blocking drain**: the delivery cursor is both the "anything new?"
 * test and the answer, so no second seq is ever exposed. The loop re-drains at
 * the top *including after a timeout*, because an entry appended between a
 * drain that found nothing and the park that follows it would notify nobody
 * and the caller would sit out the full budget with its answer already stored.
 *
 * Filters decide what **ends** the wait, never what is delivered — the cursor
 * has already moved past a filtered event, so withholding it would lose it.
 */

/**
 * How many of a session's runs one session-scope wait will touch.
 *
 * Both the re-arm sweep and the `runs` summary load a flow per run, so this
 * bounds the work a single `flow_await` can do. A session with more runs than
 * this has bigger problems than an unswept expectation.
 */
const REARM_SWEEP_LIMIT = 20;

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
export async function awaitSession(
  deps: FlowDeps,
  args: {
  sessionId: string;
  timeoutMs: number;
  kinds?: SessionEventKind[] | undefined;
  flowIds?: string[] | undefined;
}): Promise<AwaitResult> {
  const session = await deps.sessions.requireSession(args.sessionId);
  const deadline = Date.now() + args.timeoutMs;

  const collected: SessionEvent[] = [];
  let more = 0;
  let cursor = await deps.records.eventCursor(args.sessionId);
  let matched = false;
  let swept = false;

  for (;;) {
    const delta = await deps.records.drainEvents(args.sessionId);
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
      await rearmSessionExpectations(deps, session);
      cursor = await deps.records.eventCursor(args.sessionId);
    }

    await deps.events.waitFor(journalKey(args.sessionId), {
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
    runs: await summariseRuns(deps, session),
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
async function rearmSessionExpectations(
  deps: FlowDeps,
  session: Session,
): Promise<void> {
  let bindings: FlowBinding[];
  try {
    bindings = await deps.repository.listRuns(session.session_id);
  } catch (error) {
    deps.logger.warn(
      { err: error, session_id: session.session_id },
      "could not list this session's runs; skipping the re-arm sweep",
    );
    return;
  }

  for (const binding of bindings.slice(0, REARM_SWEEP_LIMIT)) {
    try {
      const runtime = await load(deps, session.session_id, {
        flowId: binding.flowId,
      });
      if (runtime.record.abandoned) continue;
      await rearmIfLapsed(deps, runtime);
    } catch (error) {
      deps.logger.warn(
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
async function summariseRuns(
  deps: FlowDeps,
  session: Session,
): Promise<RunSummary[]> {
  let bindings: FlowBinding[];
  try {
    bindings = await deps.repository.listRuns(session.session_id);
  } catch {
    return [];
  }

  const summaries: RunSummary[] = [];
  for (const binding of bindings.slice(0, REARM_SWEEP_LIMIT)) {
    try {
      const runtime = await load(deps, session.session_id, {
        flowId: binding.flowId,
      });
      const next = await describeNext(deps, runtime);
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