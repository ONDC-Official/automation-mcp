import type { MockPlaygroundConfigType } from "@ondc/automation-mock-runner";
import { ConflictError } from "@/lib/errors.js";
import type { Session } from "@/modules/session/session.schema.js";
import { toEngineFlow } from "@/modules/flow/engine/to-engine-flow.js";
import { placeholderRecord } from "@/modules/flow/flow.load.js";
import type { FlowBinding, StepOutcome } from "@/modules/flow/flow.schema.js";
import {
  assertStepsAreRunnable,
  ownerByActionId,
} from "@/modules/flow/flow.step-config.js";
import { describeAndArm } from "@/modules/flow/flow.turn.js";
import type {
  FlowDeps,
  FlowRuntime,
  StartFlowArgs,
} from "@/modules/flow/flow.types.js";

/**
 * Opening a run — and deliberately persisting almost nothing.
 *
 * `transaction_id` comes back **null**. The id is minted by whoever sends the
 * flow's first action, so at this point it does not exist; minting one here
 * produced an id that was never on the wire, and the participant's own call
 * then opened a second record under *their* id. All this writes is the
 * binding, plus an expectation when the first step is the participant's —
 * armed here rather than in `proceed`, because a model that obeys a `WAITING`
 * outcome calls `flow_await` and never reaches `proceed` at all.
 */

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
export async function start(
  deps: FlowDeps,
  args: StartFlowArgs,
): Promise<{
  runtime: FlowRuntime;
  outcome: StepOutcome;
  autoAdvance: boolean;
}> {
  const session = await deps.sessions.requireSession(args.sessionId);
  const upstreamFlow = await deps.catalog.requireFlow(
    session.build,
    args.flowId,
  );
  const { key, config } = await deps.catalog.requireMockConfig(
    session.build,
    args.flowId,
  );

  const flow = toEngineFlow(upstreamFlow, {
    ownerByKey: ownerByActionId(config),
  });
  assertStepsAreRunnable(flow, config);

  const existing = await deps.repository.findBinding(
    session.session_id,
    args.flowId,
  );
  const autoAdvance =
    args.autoAdvance ?? existing?.autoAdvance ?? session.auto_advance;

  const binding = await openBinding(deps, session, args, existing, {
    autoAdvance,
  });

  // `started` cannot come off the journal the way the other three statuses do
  // — **nothing journals a run opening**. `flow_start` deliberately persists
  // no transaction, so there is no `TRANSACTION_BOUND` yet and there may
  // never be one: a run that opens and is immediately `BLOCKED` produces no
  // journal line at all. Gated on the binding being new, so resuming a run
  // (which `flow_start` does on purpose) is not counted as a second start.
  if (existing === undefined) {
    deps.metrics?.flowRuns.inc({ flow_id: args.flowId, status: "started" });
    // Tap three of the mirror, and **not optional**: this is the only signal
    // a run ever existed. A run that opens and is immediately `BLOCKED` — the
    // most interesting row in a triage corpus — journals nothing at all.
    deps.mirror?.noteRunStarted(session.session_id, {
      flowId: args.flowId,
      attempt: binding.attempt,
      autoAdvance: binding.autoAdvance,
      startedAt: binding.startedAt,
    });
  }

  const record =
    binding.transactionId === undefined
      ? placeholderRecord(session, binding)
      : await deps.records.requireTransaction(
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
    runner: deps.mockEngine.getRunner(
      key,
      config as unknown as MockPlaygroundConfigType,
    ),
  };

  deps.logger.info(
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
    outcome: await describeAndArm(deps, runtime),
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
async function openBinding(
  deps: FlowDeps,
  session: Session,
  args: StartFlowArgs,
  existing: FlowBinding | undefined,
  options: { autoAdvance: boolean },
): Promise<FlowBinding> {
  if (args.transactionId !== undefined) {
    const record = await deps.records.requireTransaction(
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
    await deps.repository.saveBinding(binding);
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
    await deps.repository.saveBinding(binding);
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
  await deps.repository.saveBinding(binding);
  return binding;
}
