import type { Logger } from "pino";
import type { FlowService } from "@/modules/flow/flow.service.js";
import type { RecordService } from "@/modules/record/record.service.js";
import type { SessionService } from "@/modules/session/session.service.js";
import {
  pickStations,
  stationsFromCatalog,
} from "@/modules/batch/batch.catalog-stations.js";
import {
  buildStepInputs,
  needsItem,
  needsStations,
} from "@/modules/batch/batch.step-inputs.js";
import type { UpstreamFlow } from "@/modules/catalog/catalog.schema.js";
import type {
  BatchRole,
  BatchTransactionResult,
  OrderInputs,
} from "@/modules/batch/batch.schema.js";

/**
 * One virtual transaction, driven end to end by calling `SessionService` /
 * `FlowService` / `RecordService` exactly as `session_create` / `flow_start` /
 * `flow_proceed` / `flow_await` / `record_get_data` do — in-process, so there
 * is no MCP protocol overhead per call.
 *
 * **Single-process by construction.** This runs against *this instance's*
 * services only. A two-instance batch (mock BAP ↔ mock BPP) is started once
 * per instance — see `BatchRole` — and the two runs coordinate purely through
 * real wire traffic between the instances, the same way any two independent
 * network participants would. There is no cross-process call here at all.
 */

export interface BatchDriverDeps {
  session: SessionService;
  flow: FlowService;
  record: RecordService;
  logger: Logger;
}

/**
 * What the driver cannot read off a flow definition. Which step is which, and
 * what each declares as input, comes from the flow itself; this is only where
 * to find things in what the *seller* answered.
 */
export interface DriverFlowConfig {
  /**
   * The `saveData` key holding the array of real item ids the seller offered —
   * `RecordService#getBusinessData`'s "values are arrays" quirk applies, so the
   * first entry is used. Never templated: an item id must trace back to what
   * the seller offered.
   */
  itemIdsBusinessDataKey: string;
  /**
   * The `saveData` key (from the seller's first search reply) holding its
   * `fulfillments`, whose stops list the stations it serves. When set,
   * `start_code`/`end_code` are chosen from those — a seller rejects a station
   * it does not list — instead of from this repo's own table.
   */
  stationsBusinessDataKey?: string;
  /**
   * Station codes the seller is known to route between, when its catalog lists
   * more than it will search (see `batch.catalog-stations.ts`). Catalog
   * stations are narrowed to these; if none appear the codes themselves are used.
   */
  serviceableStationCodes?: string[];
}

export interface DriverArgs {
  index: number;
  role: BatchRole;
  domain: string;
  version: string;
  usecase: string;
  flowId: string;
  /** The other instance's receiver base URL — this session's `subscriber_url`. */
  counterpartySubscriberUrl: string;
  /** Present (and used) on `initiator` only; the listener needs none. */
  inputs?: OrderInputs;
  perTransactionTimeoutMs: number;
  /** Polled between waits; returning true abandons the run mid-flight. */
  isCancelled: () => boolean;
  /** The flow to run — its own definition says what each step needs. */
  flow: UpstreamFlow;
  config?: DriverFlowConfig;
  /**
   * Filled in as the run learns them, so a timeout or crash — which unwinds
   * past every local variable — can still say which session and transaction
   * to go and look at. Set by `runOneTransaction`; not for callers.
   */
  trace?: {
    sessionId?: string;
    transactionId?: string | null;
    inputs?: OrderInputs;
  };
  /**
   * `stepKey → JSONPath → value`, applied to that step's generated payload via
   * `flow_proceed`'s `payload_overrides` — repairs for a defect in the
   * published flow config (see `batch.version-presets.ts`).
   */
  stepOverrides?: Record<string, Record<string, unknown>>;
  /** The id this side presents as its own bap_id/bpp_id. Default: the instance's. */
  ownSubscriberId?: string;
  /** The other side's registry id (bpp_id when this is the buyer). Default: its host. */
  counterpartySubscriberId?: string;
  /** Overrides the base this side advertises for callbacks. */
  receiverPublicUrl?: string;
}

function overridesFor(
  args: DriverArgs,
  stepKey: string | undefined,
): { payloadOverrides: Record<string, unknown> } | Record<string, never> {
  const found =
    stepKey !== undefined ? args.stepOverrides?.[stepKey] : undefined;
  return found !== undefined ? { payloadOverrides: found } : {};
}

/** Longest a driver parks on `flow_await` before re-reading the run. */
const PARK_MS = 1_500;

class TransactionTimeout extends Error {}
class TransactionCancelled extends Error {}

export async function runOneTransaction(
  deps: BatchDriverDeps,
  args: DriverArgs,
): Promise<BatchTransactionResult> {
  const startedAt = new Date();
  const deadline = startedAt.getTime() + args.perTransactionTimeoutMs;
  const traced: DriverArgs = { ...args, trace: {} };

  try {
    const result = await runInner(deps, traced, deadline);
    return finish(args.index, startedAt, result);
  } catch (error) {
    return finish(
      args.index,
      startedAt,
      classifyError(error, traced.trace?.inputs ?? args.inputs, traced.trace),
    );
  }
}

interface InnerResult {
  status: BatchTransactionResult["status"];
  transaction_id: string | null;
  session_id?: string;
  inputs?: OrderInputs;
  item_id?: string;
  message: string;
  reason?: string;
}

function finish(
  index: number,
  startedAt: Date,
  inner: InnerResult,
): BatchTransactionResult {
  const finishedAt = new Date();
  return {
    index,
    status: inner.status,
    transaction_id: inner.transaction_id,
    ...(inner.session_id !== undefined ? { session_id: inner.session_id } : {}),
    ...(inner.inputs !== undefined ? { inputs: inner.inputs } : {}),
    ...(inner.item_id !== undefined ? { item_id: inner.item_id } : {}),
    message: inner.message,
    ...(inner.reason !== undefined ? { reason: inner.reason } : {}),
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
  };
}

function classifyError(
  error: unknown,
  inputs: OrderInputs | undefined,
  trace: DriverArgs["trace"],
): InnerResult {
  const ids = {
    transaction_id: trace?.transactionId ?? null,
    ...(trace?.sessionId !== undefined ? { session_id: trace.sessionId } : {}),
  };
  if (error instanceof TransactionTimeout) {
    return {
      status: "timed_out",
      ...ids,
      ...(inputs !== undefined ? { inputs } : {}),
      message:
        "Did not reach a terminal state within the per-transaction budget.",
      reason: "timeout",
    };
  }
  if (error instanceof TransactionCancelled) {
    return {
      status: "errored",
      ...ids,
      ...(inputs !== undefined ? { inputs } : {}),
      message: "Batch was cancelled before this transaction finished.",
      reason: "cancelled",
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: "errored",
    ...ids,
    ...(inputs !== undefined ? { inputs } : {}),
    message: `Unhandled error driving this transaction: ${message}`,
    reason: "exception",
  };
}

async function runInner(
  deps: BatchDriverDeps,
  args: DriverArgs,
  deadline: number,
): Promise<InnerResult> {
  const created = await deps.session.createSession({
    subscriber_url: args.counterpartySubscriberUrl,
    // The role naming here is the participant under test's role. `initiator`
    // plays a mock BAP counterparty-side session against a real BPP, so the
    // *participant* is a BPP; `listener` mirrors it. `session_create` inverts
    // to get our own mock_role, exactly as it does for a model-driven call.
    np_type: args.role === "initiator" ? "BPP" : "BAP",
    domain: args.domain,
    version: args.version,
    usecase: args.usecase,
    interaction_mode: "llm_auto",
    ...(args.ownSubscriberId !== undefined
      ? { mock_subscriber_id: args.ownSubscriberId }
      : {}),
    ...(args.counterpartySubscriberId !== undefined
      ? { subscriber_id: args.counterpartySubscriberId }
      : {}),
    ...(args.receiverPublicUrl !== undefined
      ? { receiver_public_url: args.receiverPublicUrl }
      : {}),
    // This driver, not auto-advance, sends every one of its own steps — see
    // `advanceToDecisionPoint`. Auto-advance would otherwise race those same
    // explicit calls: both notice a step is ours the instant the participant
    // answers, and only one can win the per-transaction dispatch lock. The
    // loser is harmless (auto-advance backs off cleanly) but noisy — it opens
    // a spurious `already_processing` feedback incident on every race. Off
    // entirely, this driver is the sole, deterministic authority over when
    // this side's steps go out.
    auto_advance: false,
  });
  const sessionId = created.session.session_id;
  if (args.trace) args.trace.sessionId = sessionId;

  await deps.flow.start({ sessionId, flowId: args.flowId });
  return runOrder(deps, args, sessionId, deadline);
}

/**
 * One order, whatever the flow.
 *
 * Wait for the next point this side has to act at, and act: a step that needs
 * nothing is sent as it is (`advanceToDecisionPoint`); a step that declares
 * input gets its inputs built from the declaration (`batch.step-inputs.ts`);
 * `COMPLETE` and `BLOCKED` end the order. Both roles run the same loop — the
 * buyer simply owns the steps that declare input in the flows this is for.
 */
async function runOrder(
  deps: BatchDriverDeps,
  args: DriverArgs,
  sessionId: string,
  deadline: number,
): Promise<InnerResult> {
  const config: DriverFlowConfig = args.config ?? {
    itemIdsBusinessDataKey: "item_ids",
  };
  const ownOwner = args.role === "initiator" ? "BAP" : "BPP";
  const allSteps = [...args.flow.sequence, ...args.flow.extraSequence];

  let transactionId: string | null = null;
  let inputs = args.inputs;
  let itemId: string | undefined;
  let stationsChosen = false;

  const outcome = (
    status: InnerResult["status"],
    message: string,
    reason?: string,
  ): InnerResult => ({
    status,
    transaction_id: transactionId,
    session_id: sessionId,
    ...(inputs !== undefined ? { inputs } : {}),
    ...(itemId !== undefined ? { item_id: itemId } : {}),
    message,
    ...(reason !== undefined ? { reason } : {}),
  });

  const bind = (id: string | null | undefined): void => {
    if (id === null || id === undefined) return;
    transactionId = id;
    if (args.trace) args.trace.transactionId = id;
  };

  for (;;) {
    const turn = await advanceToDecisionPoint(deps, args, sessionId, deadline);
    bind(turn.transactionId);

    if (turn.outcome === "COMPLETE") {
      if (transactionId === null) {
        return outcome(
          "blocked",
          "The flow finished without ever binding a transaction.",
          "no_transaction",
        );
      }
      // Auto-advance never fires an unsolicited step of the extra sequence, and
      // nothing else can, so this side sends its own once the flow is done.
      for (const extra of args.flow.extraSequence) {
        if (extra.owner !== ownOwner || extra.unsolicited !== true) continue;
        const closing = await deps.flow.proceed({
          sessionId,
          transactionId,
          triggerExtra: extra.key,
        });
        if (closing.outcome !== "SENT") {
          return outcome(
            "blocked",
            `Unsolicited step "${extra.key}" did not send: ${closing.message}`,
            closing.reason ?? closing.outcome,
          );
        }
      }
      return outcome("completed", "The flow reached COMPLETE.");
    }

    if (turn.outcome === "BLOCKED") {
      return outcome(
        "blocked",
        `Sequence stalled: ${turn.message}`,
        turn.reason ?? turn.outcome,
      );
    }

    // INPUT_REQUIRED: this side owes the flow some values.
    const step = allSteps.find((candidate) => candidate.key === turn.stepKey);
    if (step === undefined) {
      return outcome(
        "blocked",
        `The flow asks for input at "${turn.stepKey ?? "?"}", which is not in its definition.`,
        "unknown_step",
      );
    }

    if (inputs !== undefined && !stationsChosen && needsStations(step)) {
      stationsChosen = true;
      // A seller only accepts stations it routes. Its catalog is on record
      // once its first reply has landed; before that — a flow whose *first*
      // step is the station search, so nothing has been sent yet and there is
      // no transaction to read business data against — the known serviceable
      // list is all there is to go on. Either way, falling through to the
      // generated placeholder codes is exactly what gets refused.
      const serviceable = config.serviceableStationCodes;
      if (transactionId !== null || serviceable !== undefined) {
        const catalogData =
          transactionId !== null && config.stationsBusinessDataKey !== undefined
            ? await deps.record.getBusinessData(
                transactionId,
                args.counterpartySubscriberUrl,
              )
            : {};
        let stations =
          config.stationsBusinessDataKey !== undefined
            ? stationsFromCatalog(
                catalogData[config.stationsBusinessDataKey],
                serviceable,
              )
            : [];
        if (stations.length < 2 && serviceable !== undefined) {
          stations = serviceable.map((code) => ({ code }));
        }
        const parse = (gps: string): [number, number] => {
          const [lat, lon] = gps.split(",").map(Number);
          return [lat ?? 0, lon ?? 0];
        };
        const picked = pickStations(
          stations,
          parse(inputs.origin_gps),
          parse(inputs.destination_gps),
        );
        if (picked === undefined) {
          return outcome(
            "blocked",
            "The seller's catalog lists fewer than two stations, so there is " +
              "no journey to search for.",
            "no_stations",
          );
        }
        inputs = {
          ...inputs,
          start_code: picked.start.code,
          end_code: picked.end.code,
          ...(picked.originGps !== undefined
            ? { origin_gps: picked.originGps }
            : {}),
          ...(picked.destinationGps !== undefined
            ? { destination_gps: picked.destinationGps }
            : {}),
        };
        if (args.trace) args.trace.inputs = inputs;
      }
    }

    if (needsItem(step) && itemId === undefined) {
      const businessData =
        transactionId !== null
          ? await deps.record.getBusinessData(
              transactionId,
              args.counterpartySubscriberUrl,
            )
          : {};
      const ids = businessData[config.itemIdsBusinessDataKey];
      itemId = Array.isArray(ids) ? (ids[0] as string | undefined) : undefined;
      if (itemId === undefined) {
        return outcome(
          "blocked",
          `"${step.key}" picks an item, but the seller's reply held no item id ` +
            `(${config.itemIdsBusinessDataKey}) — cannot proceed without guessing one.`,
          "no_item_id",
        );
      }
    }

    const sent = await deps.flow.proceed({
      sessionId,
      ...(transactionId !== null ? { transactionId } : { flowId: args.flowId }),
      inputs: buildStepInputs(step, {
        ...(inputs !== undefined ? { order: inputs } : {}),
        ...(itemId !== undefined ? { itemId } : {}),
      }),
      ...overridesFor(args, step.key),
    });
    if (sent.outcome !== "SENT") {
      return outcome(
        "blocked",
        `${step.key} did not send: ${sent.message}`,
        sent.reason ?? sent.outcome,
      );
    }
    bind(sent.transaction_id);
  }
}

/**
 * Advance to the next point this driver has to make a decision at —
 * `COMPLETE`, `BLOCKED`, or `INPUT_REQUIRED` — driving every plain `READY`
 * step (ours, needing nothing) through itself along the way.
 *
 * This is what replaces reliance on auto-advance. Auto-advance is off for
 * every batch-driven session (`auto_advance: false` at `session_create`)
 * precisely so this loop is the *only* thing that ever dispatches this
 * side's steps — see the note there for the race this closes.
 */
async function advanceToDecisionPoint(
  deps: BatchDriverDeps,
  args: DriverArgs,
  sessionId: string,
  deadline: number,
): Promise<WaitOutcome> {
  for (;;) {
    const turn = await waitFor(
      deps,
      args,
      sessionId,
      deadline,
      (outcome) =>
        outcome === "COMPLETE" ||
        outcome === "BLOCKED" ||
        outcome === "INPUT_REQUIRED" ||
        outcome === "READY",
    );

    if (turn.outcome !== "READY") return turn;

    const proceeded = await deps.flow.proceed({
      sessionId,
      ...(turn.transactionId !== null
        ? { transactionId: turn.transactionId }
        : { flowId: args.flowId }),
      ...overridesFor(args, turn.stepKey),
    });
    if (proceeded.outcome !== "SENT") {
      return {
        outcome: "BLOCKED",
        ...(turn.stepKey !== undefined ? { stepKey: turn.stepKey } : {}),
        transactionId: turn.transactionId,
        message: `Step "${turn.stepKey ?? "?"}" did not send: ${proceeded.message}`,
        reason: proceeded.reason ?? proceeded.outcome,
      };
    }
    // Loop back and wait for the next decision point.
  }
}

interface WaitOutcome {
  outcome: string;
  stepKey?: string;
  transactionId: string | null;
  message: string;
  reason?: string;
}

/**
 * Poll `flow_get_status`-equivalent state until `until(outcome)` is true or
 * the transaction's own deadline passes, long-polling via `flow_await` in
 * between so this does not spin. Mirrors the model's own recommended loop
 * (`flow_get_status` once, then `flow_await` — "always prefer this over
 * polling flow_get_status").
 */
async function waitFor(
  deps: BatchDriverDeps,
  args: DriverArgs,
  sessionId: string,
  deadline: number,
  until: (outcome: string) => boolean,
): Promise<WaitOutcome> {
  for (;;) {
    if (args.isCancelled()) throw new TransactionCancelled();
    const now = Date.now();
    if (now >= deadline) throw new TransactionTimeout();

    const status = await deps.flow.status(sessionId, { flowId: args.flowId });
    if (args.trace && status.transaction_id !== null) {
      args.trace.transactionId = status.transaction_id;
    }
    if (until(status.next.outcome)) {
      return {
        outcome: status.next.outcome,
        ...(status.next.step_key !== undefined
          ? { stepKey: status.next.step_key }
          : {}),
        transactionId: status.transaction_id,
        message: status.next.message,
        ...(status.next.reason !== undefined
          ? { reason: status.next.reason }
          : {}),
      };
    }

    const remaining = deadline - now;
    // Short on purpose. A wake-up the park misses is otherwise paid for in
    // full, per step, per order — observed live as ~30s orders that take
    // ~1.5s alone, with the CPU idle. Re-polling every couple of seconds is
    // cheap; sitting out a lost wake-up is not.
    const timeoutMs = Math.max(500, Math.min(remaining, PARK_MS));
    const awaited = await deps.flow.awaitEvent({
      sessionId,
      flowId: args.flowId,
      afterSeq: status.seq,
      timeoutMs,
    });

    // `awaitEvent` answers immediately, with `waited: false`, whenever the
    // run's next step is not the participant's to move (e.g. `READY` — one
    // of our *own* steps is pending auto-advance, scheduled via
    // `setImmediate` from the receiver's callback handler). Looping straight
    // back into another `status`/`awaitEvent` round trip here is a tight
    // chain of already-resolved promises with no real I/O in it — under the
    // in-memory store that starves the Node event loop's macrotask queue
    // outright, so the very `setImmediate` callback this loop is waiting on
    // never gets a turn to run. A short real delay forces a macrotask tick
    // and gives auto-advance the chance to actually execute.
    if (!awaited.waited) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
