import { randomUUID } from "node:crypto";
import { UpstreamError } from "@/lib/errors.js";
import {
  checkInputs,
  describeInputs,
} from "@/modules/catalog/catalog.inputs.js";
import type { UpstreamMockConfig } from "@/modules/catalog/catalog.schema.js";
import type { MappedStep } from "@/modules/flow/engine/engine-types.js";
import {
  applyOverrides,
  suggestOverrides,
} from "@/modules/flow/flow.overrides.js";
import type { ProceedArgs } from "@/modules/flow/flow.types.js";
import {
  blocked,
  inputRequired,
  stamp,
} from "@/modules/flow/flow.outcomes.js";
import { lockId } from "@/modules/flow/flow.load.js";
import type { StepOutcome } from "@/modules/flow/flow.schema.js";
import {
  assertTransactionId,
  bindOutbound,
  buildSessionData,
  readTransactionId,
  writeTransactionId,
} from "@/modules/flow/flow.identity.js";
import { saveDataFor, specFor } from "@/modules/flow/flow.step-config.js";
import type { FlowDeps, FlowRuntime } from "@/modules/flow/flow.types.js";
import {
  summariseFindings,
  type ValidationVerdict,
} from "@/modules/validate/validate.schema.js";
import type { SendResult } from "@/modules/transport/sender.service.js";

/**
 * The outbound path: requirements → generate → patch → validate → bind →
 * record → save → send → settle.
 *
 * Two orderings inside `dispatch` are load-bearing and neither is obvious:
 *
 * 1. **The entry is recorded before the socket write, not after.** The
 *    counterparty is entitled to send its next request before answering ours,
 *    and recording after `send` resolved left our own sent step missing from
 *    `apiList` for a whole round trip — so their legitimate follow-up matched
 *    no pending step and we NACKed it `OUT_OF_SEQUENCE`. Observed live at an
 *    18ms inversion, against a correct participant.
 * 2. **`seq` is stamped when we observe the exchange**, which is what lets
 *    replay order by it instead of by a timestamp the participant controls.
 *
 * `dispatch` is long on purpose. Its fifteen phases share one function scope
 * — `marked`, `txnId`, `bound`, `payload`, `patched`, `context`,
 * `validation` — and the `marked` WORKING-marker set is cleared in a single
 * `finally`. Threading those through `phase1(state) → phase2(state)` would
 * swap a closure the compiler checks for a mutable bag it does not. Move it
 * whole or leave it alone.
 */

/**
 * Generate, then send — and, on the flow's first action, mint the id.
 *
 * The `WORKING` marker around the whole thing is the concurrency guard, and
 * the `finally` that clears it is what stops a crashed generate from wedging
 * the step until its TTL.
 *
 * ## This is where an unbound run acquires its transaction
 *
 * When we send the flow's first action, the `transaction_id` is **ours** to
 * mint — and the honest moment to mint it is the moment a payload exists,
 * not the moment a caller expressed an intention. So the candidate id goes
 * into `sessionData` (the runner's `generateContext` reads
 * `sessionData.transaction_id` first), the config generates against it, and
 * the id that comes back **on the generated payload** is the one the
 * transaction is opened under. That is what actually goes on the wire, and a
 * record keyed on anything else would be a record of a conversation nobody
 * had.
 *
 * Order matters at the bind: create, then send. A participant fast enough to
 * call back before `send` returns must find a record waiting.
 *
 * A `BLOCKED` return before that point — unmet requirements, a generator that
 * threw — persists **nothing**. There was no payload, so there is no
 * transaction, and the run is still free to be started by whichever side
 * moves first.
 */
export async function dispatch(
  deps: FlowDeps,
  runtime: FlowRuntime,
  step: MappedStep,
  args: ProceedArgs,
): Promise<StepOutcome> {
  const { session } = runtime;
  const subscriberUrl = session.np.subscriber_url;
  const isExtra = step.isExtraStep === true;
  const statusKey = isExtra ? step.actionId : undefined;

  // Every key this dispatch marked WORKING, so the `finally` clears all of
  // them. One for a bound run; two for an unbound one, which contends on the
  // run until it has a transaction and on the transaction afterwards.
  const marked = new Set<string>();
  let txnId = runtime.record.transactionId;
  const bound = runtime.bound;

  const mark = async (key: string): Promise<void> => {
    marked.add(key);
    await deps.records.setFlowStatus(
      key,
      subscriberUrl,
      "WORKING",
      statusKey,
    );
  };

  await mark(lockId(runtime));

  try {
    // Inputs first, ahead of requirements — whose own view of the world *is*
    // `sessionData`, and would be answering about the wrong one.
    //
    // A wrong-shaped `inputs` object reaches `generate` as an absent value,
    // and a generator that assigns it (`payload.x = user_inputs?.y`) deletes
    // the field the default payload already had right. Nothing downstream
    // ties the L1 failure that follows back to the input, so this is the last
    // point at which the real cause is still visible.
    const inputCheck = checkInputs(
      specFor(step, runtime.config),
      args.inputs,
    );
    if (!inputCheck.ok) {
      return inputRequired(
        runtime,
        step,
        `Step "${step.actionId}" was not sent — the values supplied are not ` +
          `the shape its generator reads. ${inputCheck.message}`,
        inputCheck.problems,
      );
    }

    const sessionData = await buildSessionData(deps, runtime, args.inputs);

    const requirements = await deps.mockEngine.runRequirements(
      runtime.runner,
      step.actionId,
      sessionData,
    );
    if (!requirements.ok) {
      return blocked(
        "requirements_error",
        `The requirements check for "${step.actionId}" failed to run: ${requirements.error?.message ?? "unknown error"}`,
        { step_key: step.actionId, error: requirements.error },
      );
    }
    if (requirements.result?.valid === false) {
      // Surfaced to the caller instead of the workbench's "send an error
      // payload at the counterparty" — an unmet precondition is ours to fix,
      // and telling the participant about it teaches it nothing.
      return blocked(
        "requirements_not_met",
        `Step "${step.actionId}" is not ready: ${requirements.result.description ?? "requirements not met"}`,
        {
          step_key: step.actionId,
          code: requirements.result.code,
          description: requirements.result.description,
          hint: "Read record_get_data to see what the flow has saved so far.",
        },
      );
    }

    const generated = await deps.mockEngine.runGenerate(
      runtime.runner,
      step.actionId,
      sessionData,
    );
    if (!generated.ok || generated.result === undefined) {
      return blocked(
        "generation_error",
        `Could not generate the payload for "${step.actionId}": ${generated.error?.message ?? "the config returned nothing"}`,
        { step_key: step.actionId, error: generated.error },
      );
    }

    const payload = generated.result;

    /*
     * ## The escape hatch, applied here and nowhere else
     *
     * After `generate`, so it patches the bytes the config actually
     * produced; before the id is settled and before the gate, so the
     * transaction stays ours to key on and the patched payload is what gets
     * judged. An override is not a validation bypass — it exists so a run
     * blocked by a **defect in a published config** can continue with a
     * *correct* payload rather than be abandoned.
     *
     * All-or-nothing: a refusal leaves `payload` exactly as generated, so
     * fixing the paths and calling again costs the run nothing.
     */
    let overridden: readonly string[] = [];
    if (args.payloadOverrides !== undefined) {
      const result = applyOverrides(payload, args.payloadOverrides);
      if (result.problems.length > 0) {
        // Top level, like `input_problems`: it is the thing to act on, and
        // burying it in `details` makes it something to go looking for.
        return {
          ...blocked(
            "overrides_refused",
            `The payload_overrides for "${step.actionId}" were refused, so nothing ` +
              "was patched, recorded or sent — the payload is exactly as the " +
              `config generated it. ${result.problems
                .map((problem) => `${problem.path} — ${problem.reason}`)
                .join("; ")}`,
            { step_key: step.actionId },
          ),
          action: step.actionType,
          override_problems: result.problems.map((problem) => ({
            path: problem.path,
            reason: problem.reason,
          })),
        };
      }
      overridden = result.applied.map((entry) => entry.path);

      deps.logger.warn(
        {
          session_id: session.session_id,
          transaction_id: txnId,
          step_key: step.actionId,
          paths: overridden,
        },
        "outbound payload patched by payload_overrides; this step is not a clean step",
      );
    }
    const patched =
      overridden.length > 0 ? { overrides: [...overridden] } : {};

    if (bound) {
      // A run that already has an id keeps it for the rest of the flow.
      assertTransactionId(deps, runtime, step, payload);
    } else {
      txnId = readTransactionId(payload) ?? txnId;
      writeTransactionId(payload, txnId);
    }

    const context = readContext(payload);

    /*
     * ## The gate
     *
     * L0 + L1 on the payload the flow's own `generate` produced, before it
     * reaches a third party's wire. It runs here — after the transaction id
     * is settled, before anything is bound, recorded or sent — because those
     * are the last bytes: validating earlier would judge a payload that is
     * not the one we send.
     *
     * Note what this actually catches. The payload is generated by the
     * config's published JavaScript, not drafted by a model, so a failure
     * here is a **defect in the flow config** far more often than anything
     * else. That is golden rule `fm-001` running one step earlier than usual:
     * an `on_X` NACK is usually a generation symptom, and this is the gate
     * that says so before the counterparty has to.
     */
    const validation = await deps.validate.validate({
      domain: session.build.domain,
      version: session.build.version,
      action: step.actionType,
      payload,
      direction: "outbound",
      session,
      transactionId: txnId,
    });

    if (args.dryRun === true) {
      // A drafted payload was never on the wire, so it mints nothing: the
      // run stays unbound and the flow's first action is still unspoken for.
      // Deliberately *not* gated: a draft exists to be inspected, and one
      // that fails validation is the most useful kind to look at.
      const payloadId = await deps.records.storePayload({
        transactionId: txnId,
        subscriberUrl,
        direction: "outbound",
        action: step.actionType,
        messageId: context.message_id,
        timestamp: context.timestamp,
        body: payload,
      });
      return stamp(runtime, {
        outcome: "DRAFTED",
        message:
          `Generated ${step.actionType} but did not send it. ` +
          `${describeVerdict(validation)} ` +
          (overridden.length > 0
            ? `Patched ${String(overridden.length)} path(s) first — re-send the same ` +
              "payload_overrides on the call that dispatches it, because they " +
              "apply to one call only. "
            : "") +
          "Inspect it with record_get_payload, then call flow_proceed again without dry_run.",
        step_key: step.actionId,
        action: step.actionType,
        payload_id: payloadId,
        ...patched,
        validation,
      });
    }

    if (validation.status === "invalid" && deps.validate.enforces) {
      // Nothing has been bound, recorded or sent, so this costs the run
      // nothing but the attempt — exactly like `requirements_not_met` above.
      // An unbound run stays unbound, and the flow's first action is still
      // unspoken for.
      deps.logger.warn(
        {
          session_id: session.session_id,
          transaction_id: txnId,
          step_key: step.actionId,
          findings: validation.findings.length,
        },
        "outbound payload failed protocol validation; not sending it",
      );
      return blocked(
        "validation_failed",
        `The ${step.actionType} payload this flow generated is not spec-compliant, so it was not sent: ` +
          summariseFindings(validation.findings),
        {
          step_key: step.actionId,
          findings: validation.findings,
          ...(validation.docs_url !== undefined
            ? { docs_url: validation.docs_url }
            : {}),
          // What the step declares, and what it was given, sit beside the
          // findings on purpose. The generated payload is a function of the
          // two, and a reader holding only the findings has no way to tell a
          // config defect from a value it chose — an earlier version of this
          // hint asserted "usually a config defect", and was believed.
          ...inputEvidence(step, runtime.config, args.inputs),
          ...patched,
          hint:
            "The payload is produced by the flow config's own generate " +
            "function from the inputs supplied. Compare the findings against " +
            "`declared_inputs` and `supplied_inputs` below: a field that is " +
            "empty or missing is usually one the generator read off " +
            "`user_inputs` and did not find. Inspect the payload with " +
            "flow_proceed dry_run to confirm before concluding the config is " +
            "at fault.",
          // Naming the way out, beside the reason it is needed. Before this,
          // a model that correctly diagnosed a defect in a *published* config
          // had nothing left to do but give up — which is exactly what the
          // 2026-07-31 runs did, twice.
          ...(suggestOverrides(validation.findings) !== undefined
            ? { recovery: suggestOverrides(validation.findings) }
            : {}),
        },
      );
    }

    if (!bound) {
      // From here the step is in flight against a real transaction, so the
      // marker has to exist there too — the next call will resolve the run
      // to the transaction and look for it under that key.
      await mark(txnId);
      await bindOutbound(deps, runtime, txnId);
    }

    // ## Recorded before it is sent, and this ordering is the whole point
    //
    // The counterparty is entitled to send its next request before it answers
    // ours — the ACK's return leg and their next call's forward leg are
    // independent connections and neither ordering is guaranteed. Recording
    // after `send` resolved meant our own sent step was absent from `apiList`
    // for the length of a round trip, so replay left the cursor on the step we
    // had already sent, their legitimate follow-up matched no pending step,
    // and we NACKed it `OUT_OF_SEQUENCE` — a false finding against a correct
    // implementation.
    //
    // It also fixes the replay order. `seq` is assigned here, and
    // `sortForReplay` prefers it over `context.timestamp` precisely because no
    // counterparty can influence it — but that only holds if it is stamped
    // when we *observe* the exchange. Stamped at ACK-return time, an inbound
    // call that arrived during our send took a lower `seq` than the send it
    // was answering, and replay ran them backwards.
    //
    // Over-recording is the safe direction here: the entry exists for a moment
    // before the bytes leave, but the participant cannot answer a call it has
    // not received, so nothing can match against it early.
    const { payloadId, seq } = await deps.records.appendApiEntry({
      transactionId: txnId,
      subscriberUrl,
      action: step.actionType,
      messageId: context.message_id,
      direction: "outbound",
      // Ordering replay by the payload's own timestamp, not by arrival, is
      // what keeps a request and its callback in the right order.
      timestamp: context.timestamp,
      body: payload,
      sendState: "in_flight",
      // A patched step is not a clean step, and the record is what the
      // compliance report reads. Absent when nothing was patched.
      ...patched,
      // Published once, by `settleApiEntry`, when the ACK is actually known.
      silent: true,
    });

    // Ahead of the send for the same reason: the receiver feeds business data
    // to the inbound validator, so anything this step saves has to be there
    // before their next call can be judged against it. It is derived from the
    // generated payload, which exists already, so moving it costs nothing.
    await deps.records.saveBusinessData(
      txnId,
      subscriberUrl,
      payload,
      saveDataFor(runtime.config, step.actionId),
    );

    const sent = await dispatchSend(deps, 
      { transactionId: txnId, subscriberUrl, seq, payloadId },
      step.actionType,
      payload,
    );

    await deps.records.journal(session.session_id, {
      // A chained send is the one the model did not ask for, so it is the one
      // the journal exists to surface.
      kind: args.chained === true ? "CHAIN_SENT" : "OUTBOUND_SENT",
      flow_id: runtime.binding.flowId,
      transaction_id: txnId,
      action: step.actionType,
      ack: sent.ack,
      payload_id: payloadId,
      ...patched,
      summary:
        `${args.chained === true ? "Auto-sent" : "Sent"} ${step.actionType} — ` +
        `the participant answered ${sent.ack}.` +
        (overridden.length > 0
          ? ` Patched first: ${overridden.join(", ")}.`
          : "") +
        // Folded into the existing line rather than journaled separately.
        // For a chained send the journal is the *only* channel back to the
        // model, so a payload that went out unvalidated — or known-bad under
        // `advisory` — has to say so here or it is never said at all.
        (validation.status === "valid"
          ? ""
          : ` ${describeVerdict(validation)}`),
    });

    return {
      outcome: "SENT",
      message:
        (sent.ack === "ACK"
          ? `Sent ${step.actionType}; the participant ACKed it. Call flow_await for the callback.`
          : `Sent ${step.actionType}; the participant answered ${sent.ack}. Read ack_body — this is a finding, not a transport failure.`) +
        (overridden.length > 0
          ? ` Note: ${String(overridden.length)} path(s) were patched by ` +
            "payload_overrides, so this step was not generated purely by the " +
            "flow's own config and the compliance report will say so."
          : ""),
      step_key: step.actionId,
      action: step.actionType,
      transaction_id: txnId,
      payload_id: payloadId,
      ack: sent.ack,
      http_status: sent.httpStatus,
      ack_body: sent.body,
      ...patched,
      validation,
    };
  } finally {
    for (const id of marked) {
      await deps.records.setFlowStatus(
        id,
        subscriberUrl,
        "AVAILABLE",
        statusKey,
      );
    }
  }
}

/**
 * Put the payload on the wire and close the entry that was opened for it.
 *
 * Every exit from here leaves the record consistent, which is what lets the
 * append happen before the send at all:
 *
 * | Outcome | Entry |
 * | --- | --- |
 * | Answered (ACK **or** NACK) | settled with the answer |
 * | Threw, `delivery: unreachable` | withdrawn — nothing crossed, the step is still owed |
 * | Threw, anything else | kept, `sendState: "failed"` — it may have been delivered |
 *
 * The last row is the one that matters. A timeout is not evidence of
 * non-delivery, and treating it as such would let the next `flow_proceed`
 * re-send a call the participant had already processed. A stuck run is
 * recoverable with `flow_restart`; a duplicate on someone else's wire is not.
 */
async function dispatchSend(
  deps: FlowDeps,
  entry: {
    transactionId: string;
    subscriberUrl: string;
    seq: number;
    payloadId: string;
  },
  action: string,
  payload: unknown,
): Promise<SendResult> {
  try {
    const sent = await deps.sender.send(
      entry.subscriberUrl,
      action,
      payload,
    );
    await deps.records.settleApiEntry({
      ...entry,
      ackBody: sent.body,
      httpStatus: sent.httpStatus,
    });
    return sent;
  } catch (error) {
    const delivery =
      error instanceof UpstreamError ? error.details?.delivery : undefined;

    if (delivery === "unreachable") {
      await deps.records.discardApiEntry(entry);
    } else {
      await deps.records.settleApiEntry({
        ...entry,
        sendState: "failed",
        sendError: error instanceof Error ? error.message : "the send failed",
      });
    }
    throw error;
  }
}

/**
 * One clause about how a payload judged, for a message or a journal line.
 *
 * Empty for a clean pass — a sentence saying nothing went wrong on every
 * successful step is noise the model has to read past. The two states that do
 * speak are the ones with consequences: findings we did not act on, and a
 * payload nobody checked.
 */
function describeVerdict(verdict: ValidationVerdict): string {
  if (verdict.status === "valid") {
    return `It passed ${verdict.checked.join(" + ")} validation.`;
  }

  if (verdict.status === "unavailable") {
    return (
      "It went unvalidated — " +
      (verdict.unchecked[0]?.reason ?? "no layer could be checked") +
      "."
    );
  }

  return (
    `It has ${String(verdict.findings.length)} validation ` +
    `finding${verdict.findings.length === 1 ? "" : "s"}: ` +
    `${summariseFindings(verdict.findings, 2)}.`
  );
}

/**
 * A generated payload must carry a usable context: the flow is keyed on
 * `message_id` and replayed in `timestamp` order, and a payload without them
 * cannot be matched to its callback.
 */
function readContext(payload: Record<string, unknown>): {
  message_id: string;
  timestamp: string;
} {
  const context = payload["context"];
  const record =
    typeof context === "object" && context !== null
      ? (context as Record<string, unknown>)
      : {};

  return {
    message_id:
      typeof record["message_id"] === "string"
        ? record["message_id"]
        : randomUUID(),
    timestamp:
      typeof record["timestamp"] === "string"
        ? record["timestamp"]
        : new Date().toISOString(),
  };
}

/**
 * The two things a validation failure has to be read against.
 *
 * Omitted entirely for a step that declares no inputs — there the payload
 * really is the config's own work, and saying so by silence is honest.
 */
function inputEvidence(
  step: MappedStep,
  config: UpstreamMockConfig,
  inputs: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const spec = specFor(step, config);
  if (spec.fields.length === 0) return {};

  return {
    declared_inputs: describeInputs(spec),
    supplied_inputs: inputs ?? null,
  };
}
