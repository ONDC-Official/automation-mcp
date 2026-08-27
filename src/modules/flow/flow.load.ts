import { randomUUID } from "node:crypto";
import type { MockPlaygroundConfigType } from "@ondc/automation-mock-runner";
import { NotFoundError, ValidationError } from "@/lib/errors.js";
import { toEngineFlow } from "@/modules/flow/engine/to-engine-flow.js";
import type { FlowBinding } from "@/modules/flow/flow.schema.js";
import { ownerByActionId } from "@/modules/flow/flow.step-config.js";
import type {
  FlowDeps,
  FlowRef,
  FlowRuntime,
} from "@/modules/flow/flow.types.js";
import { flowRunKey } from "@/modules/record/record.repository.js";
import { emptyTransactionRecord } from "@/modules/record/record.service.js";
import type { TransactionRecord } from "@/modules/record/record.schema.js";
import type { Session } from "@/modules/session/session.schema.js";
import { receiverScope } from "@/modules/session/session.service.js";

/**
 * Resolving a run, and the two keys it is named by.
 *
 * A run exists before its transaction does, so `load` has to answer for both
 * shapes: a real record once the flow's first action has crossed the wire, and
 * a throwaway one before it. `lockId` is the other half of the same idea —
 * what two concurrent callers contend on when there is no transaction yet.
 */

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
export async function load(
  deps: FlowDeps,
  sessionId: string,
  ref: FlowRef,
): Promise<FlowRuntime> {
  const session = await deps.sessions.requireSession(sessionId);
  const { binding, record, bound } = await resolveRun(deps, session, ref);

  const upstreamFlow = await deps.catalog.requireFlow(
    session.build,
    record.flowId,
  );
  const { key, config } = await deps.catalog.requireMockConfig(
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
    runner: deps.mockEngine.getRunner(
      key,
      config as unknown as MockPlaygroundConfigType,
    ),
  };
}

async function resolveRun(
  deps: FlowDeps,
  session: Session,
  ref: FlowRef,
): Promise<{
  binding: FlowBinding;
  record: TransactionRecord;
  bound: boolean;
}> {
  const subscriberUrl = session.np.subscriber_url;

  if (ref.transactionId !== undefined) {
    const record = await deps.records.requireTransaction(
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
    const stored = await deps.repository.findBinding(
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

  const binding = await deps.repository.findBinding(
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
      record: await deps.records.requireTransaction(
        binding.transactionId,
        subscriberUrl,
      ),
      bound: true,
    };
  }

  return {
    binding,
    record: placeholderRecord(session, binding),
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
export function placeholderRecord(
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
export async function runSeq(
  deps: FlowDeps,
  sessionId: string,
  transactionId: string | undefined,
): Promise<number | undefined> {
  if (transactionId === undefined) return undefined;
  const session = await deps.sessions.requireSession(sessionId);
  const record = await deps.records.findTransaction(
    transactionId,
    session.np.subscriber_url,
  );
  return record?.seq;
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
export function lockId(runtime: FlowRuntime): string {
  return runtime.bound
    ? runtime.record.transactionId
    : flowRunKey(runtime.session.session_id, runtime.binding.flowId);
}
