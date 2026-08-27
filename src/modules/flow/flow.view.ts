import type { MappedStep } from "@/modules/flow/engine/engine-types.js";
import { getFlowCompleteStatus } from "@/modules/flow/engine/flow-mapper.js";
import { actorFor } from "@/modules/catalog/catalog.service.js";
import { describeInputs } from "@/modules/catalog/catalog.inputs.js";
import type { UpstreamMockConfig } from "@/modules/catalog/catalog.schema.js";
import type { Session } from "@/modules/session/session.schema.js";
import { lockId } from "@/modules/flow/flow.load.js";
import { specFor } from "@/modules/flow/flow.step-config.js";
import { extraStatuses } from "@/modules/flow/flow.target.js";
import { load } from "@/modules/flow/flow.load.js";
import type {
  FlowBinding,
  FlowStatusOutput,
  MissedStep,
} from "@/modules/flow/flow.schema.js";
import { describeNext } from "@/modules/flow/flow.turn.js";
import type {
  FlowDeps,
  FlowRef,
  FlowRunView,
  FlowRuntime,
} from "@/modules/flow/flow.types.js";

/**
 * Reading a run without advancing it.
 *
 * `buildView` is the single read both `flow_get_status` and the viewer go
 * through, one step apart: the tool projects it into `FlowStepState`, the
 * viewer takes the engine's own `FlowMap` unmodified. Neither restates the
 * `flow_status` derivation, which is the part that would drift.
 */

export async function status(
  deps: FlowDeps,
  sessionId: string,
  ref: FlowRef,
): Promise<FlowStatusOutput> {
  const runtime = await load(deps, sessionId, ref);
  const view = await buildView(deps, runtime);
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
export function listRuns(
  deps: FlowDeps,
  sessionId: string,
): Promise<FlowBinding[]> {
  return deps.repository.listRuns(sessionId);
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
export async function flowView(
  deps: FlowDeps,
  sessionId: string,
  ref: FlowRef,
): Promise<FlowRunView> {
  return buildView(deps, await load(deps, sessionId, ref));
}

/**
 * Everything both readers need, computed once.
 *
 * Extracted so `status()` and `flowView()` cannot answer differently about
 * the same run — they are two renderings of one read, and a second
 * implementation of the `flow_status` derivation below is a bug waiting for
 * somebody to notice the two disagree.
 */
async function buildView(
  deps: FlowDeps,runtime: FlowRuntime): Promise<FlowRunView> {
  const { session, record, flow } = runtime;
  const transactionId = record.transactionId;

  const flowStatus = await deps.records.getFlowStatus(
    lockId(runtime),
    session.np.subscriber_url,
  );
  const businessData = await deps.records.getBusinessData(
    transactionId,
    session.np.subscriber_url,
  );
  const extraStatusByKey = await extraStatuses(deps, runtime);

  const map = getFlowCompleteStatus(
    record,
    flow,
    flowStatus,
    businessData,
    extraStatusByKey,
  );

  const next = await describeNext(deps, runtime);
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
