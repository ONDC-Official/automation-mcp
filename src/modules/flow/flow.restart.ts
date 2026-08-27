import type { MockPlaygroundConfigType } from "@ondc/automation-mock-runner";
import { NotFoundError } from "@/lib/errors.js";
import { toEngineFlow } from "@/modules/flow/engine/to-engine-flow.js";
import { placeholderRecord } from "@/modules/flow/flow.load.js";
import {
  ATTEMPT_HISTORY_LIMIT,
  type FlowBinding,
} from "@/modules/flow/flow.schema.js";
import {
  assertStepsAreRunnable,
  ownerByActionId,
} from "@/modules/flow/flow.step-config.js";
import { describeAndArm } from "@/modules/flow/flow.turn.js";
import type {
  FlowDeps,
  FlowRuntime,
  RestartArgs,
  RestartResult,
} from "@/modules/flow/flow.types.js";
import { flowRunKey } from "@/modules/record/record.repository.js";
import type { Session } from "@/modules/session/session.schema.js";
import { receiverScope } from "@/modules/session/session.service.js";

/**
 * Abandoning this attempt and opening a fresh one, in the same session.
 *
 * A flow's state is *derived* by replaying what was exchanged, so a NACKed
 * step is part of the history from then on and `flow_start` deliberately
 * resumes. This is the escape hatch, and it destroys nothing: the abandoned
 * attempt keeps its record, payloads and business data and is **sealed**
 * rather than deleted, because `txn_index` still resolves the old id and an
 * unsealed attempt could be advanced — putting fresh payloads on a third
 * party's wire for a run that was written off.
 */

export async function restart(
  deps: FlowDeps,
  args: RestartArgs,
): Promise<RestartResult> {
  const session = await deps.sessions.requireSession(args.sessionId);
  const upstreamFlow = await deps.catalog.requireFlow(
    session.build,
    args.flowId,
  );
  const { key, config } = await deps.catalog.requireMockConfig(
    session.build,
    args.flowId,
  );

  // Validated before anything is touched, exactly as `start` does: a flow
  // that cannot be driven must not first cost the caller their old attempt.
  const flow = toEngineFlow(upstreamFlow, {
    ownerByKey: ownerByActionId(config),
  });
  assertStepsAreRunnable(flow, config);

  const existing = await deps.repository.findBinding(
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
    await seal(deps, session, existing, now, args.reason);

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
  await deps.records.clearExpectationsForFlow(
    receiverScope(session),
    session.session_id,
    args.flowId,
  );

  // The one marker key the next attempt inherits: an unbound run contends on
  // the run itself (`#lockId`), so a dispatch that died mid-flight during the
  // old attempt would otherwise read as WORKING for the new one. Everything
  // else — business data, per-transaction and per-extra markers — is keyed on
  // a transaction id the new attempt does not have yet.
  await deps.records.setFlowStatus(
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
  await deps.repository.saveBinding(binding);

  const runtime: FlowRuntime = {
    session,
    record: placeholderRecord(session, binding),
    binding,
    bound: false,
    upstreamFlow,
    flow,
    config,
    runner: deps.mockEngine.getRunner(
      key,
      config as unknown as MockPlaygroundConfigType,
    ),
  };

  await deps.records.journal(session.session_id, {
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

  deps.logger.info(
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
    outcome: await describeAndArm(deps, runtime),
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
async function seal(
  deps: FlowDeps,
  session: Session,
  binding: FlowBinding,
  at: string,
  reason: string | undefined,
): Promise<void> {
  const transactionId = binding.transactionId as string;
  try {
    await deps.records.abandonTransaction(
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
    deps.logger.warn(
      {
        session_id: session.session_id,
        flow_id: binding.flowId,
        transaction_id: transactionId,
      },
      "restarted a run whose transaction had already expired; nothing to seal",
    );
  }
}
