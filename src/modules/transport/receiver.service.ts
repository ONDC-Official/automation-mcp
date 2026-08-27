import { getFlowCompleteStatus } from "@/modules/flow/engine/flow-mapper.js";
import { saveDataFor } from "@/modules/flow/flow.step-config.js";
import type { ExpectationScope } from "@/modules/record/record.schema.js";
import { receiverScope } from "@/modules/session/session.service.js";
import {
  primaryCode,
  summariseFindings,
} from "@/modules/validate/validate.schema.js";
import { readAck } from "@/modules/transport/sender.service.js";
import {
  ack,
  nack,
  refuseAbandoned,
  refuseMalformed,
} from "@/modules/transport/receiver.refuse.js";
import {
  readContext,
  resolve,
} from "@/modules/transport/receiver.attribute.js";
import {
  describeInbound,
  journalInbound,
  matchStep,
  record,
  resolveUpcomingForm,
} from "@/modules/transport/receiver.persist.js";
import type {
  InboundRequest,
  InboundResult,
  ReceiverDeps,
  ReceiverServiceOptions,
} from "@/modules/transport/receiver.types.js";

/*
 * The pipeline's shapes live in `receiver.types.ts`; re-exported here because
 * `container.ts` and the routes have always imported them from this module.
 */
export type {
  InboundRequest,
  InboundResult,
  ReceiverServiceOptions,
} from "@/modules/transport/receiver.types.js";

/**
 * The inbound half: what happens when the participant under test calls us.
 *
 * Step 3.2 of the runtime contract, in code, in this order:
 * parse → resolve → match → validate → record → ACK. Nothing here asks a model
 * anything, because the ACK window is measured in milliseconds and a model round
 * trip is not. The model's judgement arrives afterwards, through
 * `inbound_review`, and never blocks the answer.
 *
 * ## Nothing in the URL says which session this is
 *
 * The endpoint we advertise is `{base}/{domain}/{version}/{buyer|seller}` —
 * shared by every session on that build, because that is what a participant
 * expects to integrate against. So the session is recovered from the payload,
 * the way the workbench does it (`receiver.go#ReceiveFromNP`):
 *
 * 1. the `transaction_id`, via the index that maps one to its session;
 * 2. failing that, an expectation armed on this endpoint for this action;
 * 3. failing that, 412 — there is nothing to attach the call to.
 *
 * ## HTTP status is decoupled from ACK/NACK
 *
 * | Situation                           | Status | Body |
 * |-------------------------------------|--------|------|
 * | Accepted                            | 200    | `{message:{ack:{status:"ACK"}}}` |
 * | Validation failed                   | **200**| `{message:{ack:{status:"NACK"}}, error}` |
 * | Out of sequence                     | **200**| NACK `OUT_OF_SEQUENCE`, recorded |
 * | `context.action` ≠ the URL's action | **200**| NACK `ACTION_MISMATCH`, recorded |
 * | Wrong `transaction_id` for the flow | **200**| NACK `TRANSACTION_MISMATCH`, recorded |
 * | Its attempt was restarted away      | **200**| NACK `TRANSACTION_ABANDONED`, recorded |
 * | Malformed context                   | 400    | NACK envelope |
 * | Transaction belongs to another build| 412    | NACK `WRONG_ENDPOINT` |
 * | Its session has expired             | 412    | NACK `SESSION_EXPIRED` |
 * | No transaction and no expectation   | 412    | NACK `NO_EXPECTATION` |
 *
 * A rejected-but-well-formed call is a *successful HTTP exchange* that carried
 * a protocol-level refusal. Collapsing the two makes a NACK indistinguishable
 * from a proxy failure.
 *
 * The 400 on a missing `message_id` is a deliberate divergence: the workbench
 * panics with a 500 there. We refuse cleanly and record the attempt.
 */

export class ReceiverService {
  /**
   * Every collaborator, in one object, so the pipeline's phases can be handed
   * it whole. There is no other state: this class holds nothing mutable, which
   * is what lets each phase be a plain function.
   */
  readonly #deps: ReceiverDeps;

  constructor(options: ReceiverServiceOptions) {
    this.#deps = options;
  }

  /**
   * Verify the request's signature.
   *
   * Deliberately a no-op for now, and deliberately a named hook rather than an
   * absence: the place a signature check belongs is a design decision, and
   * leaving the seam visible is what keeps it from being bolted on somewhere
   * that runs after the payload has already been recorded.
   */
  verifyAuth(_headers: Record<string, unknown>): boolean {
    return true;
  }

  /**
   * Handle one inbound protocol call.
   *
   * Never throws: this is an HTTP handler for a third party, and an unhandled
   * error would answer 500 with no record of what arrived. Everything becomes a
   * status plus a body.
   */
  async handle(
    request: InboundRequest,
    body: unknown,
    headers: Record<string, unknown> = {},
  ): Promise<InboundResult> {
    // The ACK window, measured end to end: everything between the participant's
    // request landing and this mock deciding. It is the number their timeouts
    // are set against, and the one thing the journal cannot reconstruct — a
    // line says a call was ACKed, never how long their socket was held.
    const started = performance.now();
    try {
      const result = await this.#handle(request, body, headers);
      this.#timeAck(request.action, result, started);
      return result;
    } catch (error) {
      this.#deps.logger.error({ err: error, ...request }, "inbound request failed");
      const failure: InboundResult = {
        status: 500,
        body: nack(
          "INTERNAL_ERROR",
          "The mock failed to process this request.",
        ),
      };
      // Timed too. A 500 is the slowest and most interesting shape this
      // endpoint has, and leaving it out of the histogram would make the tail
      // look better exactly when it is worst.
      this.#timeAck(request.action, failure, started);
      return failure;
    }
  }

  /**
   * Record how long one inbound call held the participant's connection.
   *
   * The `ack` label is read back off the body we are about to write rather than
   * threaded down from wherever the decision was made — there are a dozen
   * refusal branches and every one of them would otherwise have to remember to
   * report itself, which is the kind of obligation that holds until someone
   * adds the thirteenth.
   *
   * Only the histogram. `ondc_inbound_calls_total` comes off the journal, which
   * carries the `nack_code` this cannot see.
   */
  #timeAck(action: string, result: InboundResult, startedAt: number): void {
    const metrics = this.#deps.metrics;
    if (metrics === undefined) return;
    metrics.inboundDuration.observe(
      // `action` is a free path segment on an unauthenticated endpoint, so it
      // is bounded rather than trusted. See `Metrics.action`.
      { action: metrics.action(action), ack: readAck(result.body) },
      (performance.now() - startedAt) / 1_000,
    );
  }

  async #handle(
    request: InboundRequest,
    body: unknown,
    headers: Record<string, unknown>,
  ): Promise<InboundResult> {
    const scope: ExpectationScope = {
      domain: request.domain,
      version: request.version,
      role: request.role,
    };

    /* 1. Parse. A context we cannot key on is unusable. */
    const context = readContext(body);
    if (typeof context.message_id !== "string" || context.message_id === "") {
      return refuseMalformed(this.#deps, scope, request, body, {
        detail: "context.message_id is required and must be a string.",
      });
    }
    const messageId = context.message_id;
    // The body's action decides the step, not the path — the workbench matches
    // on `context.action` too. The path is checked against it below.
    if (typeof context.action !== "string" || context.action === "") {
      return refuseMalformed(this.#deps, scope, request, body, {
        messageId,
        detail: "context.action is required and must be a string.",
      });
    }
    const action = context.action;
    const timestamp =
      typeof context.timestamp === "string"
        ? context.timestamp
        : new Date().toISOString();

    /*
     * 2. Whose call is this? The endpoint's role is ours, so the counterparty
     *    is on the other side of the context — and it has to identify itself
     *    there, because nothing in the URL does it for them.
     */
    const counterpartyField = request.role === "buyer" ? "bpp_uri" : "bap_uri";
    const advertisedUri = context[counterpartyField];
    if (typeof advertisedUri !== "string" || advertisedUri === "") {
      return refuseMalformed(this.#deps, scope, request, body, {
        messageId,
        action,
        timestamp,
        detail:
          `context.${counterpartyField} is required: this endpoint is a ${
            request.role === "buyer" ? "BAP" : "BPP"
          }, so the ${counterpartyField} identifies the caller.`,
      });
    }

    if (!this.verifyAuth(headers)) {
      return { status: 401, body: undefined };
    }

    /* 3. Resolve the transaction, or create it from an armed expectation. */
    const resolved = await resolve(this.#deps, 
      request,
      scope,
      context,
      action,
      advertisedUri,
      { body, messageId, timestamp },
    );
    if ("failure" in resolved) return resolved.failure;
    const { session, transactionId } = resolved;
    const sessionId = session.session_id;

    /*
     * 3a. The attempt this call belongs to was written off by `flow_restart`.
     *     Checked before anything else about the call, because a run we have
     *     abandoned is not a run whose step sequence is worth assessing.
     */
    if (resolved.record.abandoned) {
      return refuseAbandoned(this.#deps, session, resolved.record, action, {
        body,
        messageId,
        timestamp,
      });
    }

    /*
     * 3b. The path said one action, the payload another. Resolve first so the
     *     evidence lands on a record — the call did arrive, and a compliance
     *     run wants it — then refuse.
     */
    if (request.action !== action) {
      const ackBody = nack(
        "ACTION_MISMATCH",
        `This call arrived on the "${request.action}" endpoint but its context.action is "${action}".`,
      );
      const appended = await record(this.#deps, 
        session,
        transactionId,
        action,
        messageId,
        timestamp,
        body,
        ackBody,
      );
      await journalInbound(this.#deps, session, {
        flowId: resolved.record.flowId,
        transactionId,
        action,
        nackCode: "ACTION_MISMATCH",
        ...(appended.payloadId !== undefined
          ? { payloadId: appended.payloadId }
          : {}),
        summary: `NACKed ${action}: it arrived on the "${request.action}" endpoint. Recorded as a finding.`,
      });
      this.#deps.logger.warn(
        {
          session_id: sessionId,
          transaction_id: transactionId,
          pathAction: request.action,
          action,
        },
        "inbound action does not match the endpoint it arrived on",
      );
      return { status: 200, body: ackBody, transactionId };
    }

    /* 4. Match the call to a step the flow is actually waiting for. */
    const runtime = await this.#deps.flows.load(sessionId, { transactionId });
    const flowStatus = await this.#deps.records.getFlowStatus(
      transactionId,
      session.np.subscriber_url,
    );
    const businessData = await this.#deps.records.getBusinessData(
      transactionId,
      session.np.subscriber_url,
    );
    const map = getFlowCompleteStatus(
      runtime.record,
      runtime.flow,
      flowStatus,
      businessData,
      await this.#deps.records.getExtraFlowStatuses(
        transactionId,
        session.np.subscriber_url,
        (runtime.flow.extraSequence ?? []).map((step) => step.key),
      ),
    );

    const step = matchStep(
      [...map.sequence, ...(map.extraSteps ?? [])],
      action,
      messageId,
    );

    if (!step) {
      const ackBody = nack(
        "OUT_OF_SEQUENCE",
        `This mock is not expecting "${action}" at this point in the flow.`,
      );
      // Recorded anyway. An unexpected call is one of the most valuable things
      // a compliance run can catch, and dropping it would erase the evidence —
      // the mapper classifies it as out-of-sequence on the next read.
      const appended = await record(this.#deps, 
        session,
        transactionId,
        action,
        messageId,
        timestamp,
        body,
        ackBody,
      );
      await journalInbound(this.#deps, session, {
        flowId: runtime.record.flowId,
        transactionId,
        action,
        nackCode: "OUT_OF_SEQUENCE",
        ...(appended.payloadId !== undefined
          ? { payloadId: appended.payloadId }
          : {}),
        summary: `NACKed an unexpected ${action} — the flow is not waiting for it. Recorded as a finding.`,
      });
      this.#deps.logger.warn(
        { session_id: sessionId, transaction_id: transactionId, action },
        "inbound request matched no pending step",
      );
      return { status: 200, body: ackBody, transactionId };
    }

    /*
     * 5. Judge it. Two independent validators, run concurrently.
     *
     * The flow's own `validate` decides whether this payload is right *for this
     * step*; protocol validation decides whether it is a legal ONDC message at
     * all. Neither subsumes the other, and they share no state — so they run
     * together and the ACK costs the slower of the two rather than the sum.
     * That matters here and nowhere else: this is the one path with a
     * counterparty's socket held open while we think.
     */
    const [verdict, protocol] = await Promise.all([
      this.#deps.mockEngine.runValidate(
        runtime.runner,
        step.actionId,
        body,
        businessData,
      ),
      this.#deps.validate.validate({
        domain: request.domain,
        version: request.version,
        action,
        payload: body,
        direction: "inbound",
        session,
        transactionId,
      }),
    ]);

    if (!verdict.ok) {
      // The config's validator crashed, or broke its return contract. That is
      // the config author's defect — but the participant still gets a clean
      // answer rather than a 500.
      const ackBody = nack(
        "VALIDATION_FUNCTION_ERROR",
        verdict.error?.message ?? "The validation function failed to run.",
      );
      const appended = await record(this.#deps, 
        session,
        transactionId,
        action,
        messageId,
        timestamp,
        body,
        ackBody,
      );
      await journalInbound(this.#deps, session, {
        flowId: runtime.record.flowId,
        transactionId,
        action,
        nackCode: "VALIDATION_FUNCTION_ERROR",
        ...(appended.payloadId !== undefined
          ? { payloadId: appended.payloadId }
          : {}),
        summary: `NACKed ${action}: this flow's own validator failed to run. That is a config defect, not the participant's.`,
      });
      return { status: 200, body: ackBody, transactionId };
    }

    if (verdict.result?.valid === false) {
      const code = String(verdict.result.code ?? "VALIDATION_ERROR");
      const ackBody = nack(
        code,
        verdict.result.description ?? "Validation failed.",
      );
      const appended = await record(this.#deps, 
        session,
        transactionId,
        action,
        messageId,
        timestamp,
        body,
        ackBody,
      );
      await journalInbound(this.#deps, session, {
        flowId: runtime.record.flowId,
        transactionId,
        action,
        nackCode: code,
        ...(appended.payloadId !== undefined
          ? { payloadId: appended.payloadId }
          : {}),
        summary: `NACKed ${action} (${code}): ${verdict.result.description ?? "validation failed"}`,
      });
      return { status: 200, body: ackBody, transactionId };
    }

    /*
     * 5b. The step accepted it, but it is not a legal message.
     *
     * Second, deliberately: the flow's own validator is step-specific and its
     * code names the thing the integrator got wrong, so when both refuse, the
     * more actionable answer should be the one on the wire. This branch is what
     * catches the payloads a permissive step validator would wave through — a
     * missing required field, a value outside its enum, a malformed context.
     */
    if (protocol.status === "invalid" && this.#deps.validate.enforces) {
      const code = primaryCode(protocol.findings);
      const ackBody = nack(code, summariseFindings(protocol.findings));
      const appended = await record(this.#deps, 
        session,
        transactionId,
        action,
        messageId,
        timestamp,
        body,
        ackBody,
      );
      await journalInbound(this.#deps, session, {
        flowId: runtime.record.flowId,
        transactionId,
        action,
        nackCode: code,
        ...(appended.payloadId !== undefined
          ? { payloadId: appended.payloadId }
          : {}),
        summary:
          `NACKed ${action}: it is not spec-compliant (${String(protocol.findings.length)} ` +
          `finding${protocol.findings.length === 1 ? "" : "s"}). ${summariseFindings(protocol.findings, 2)}`,
      });
      this.#deps.logger.info(
        {
          session_id: sessionId,
          transaction_id: transactionId,
          action,
          findings: protocol.findings.length,
          code,
        },
        "inbound payload failed protocol validation",
      );
      return { status: 200, body: ackBody, transactionId };
    }

    /* 6-7. Accepted: record it, then fold it into the business data. */
    const ackBody = ack();
    const appended = await record(this.#deps, 
      session,
      transactionId,
      action,
      messageId,
      timestamp,
      body,
      ackBody,
    );
    await journalInbound(this.#deps, session, {
      flowId: runtime.record.flowId,
      transactionId,
      action,
      ...(appended.payloadId !== undefined
        ? { payloadId: appended.payloadId }
        : {}),
      summary:
        `ACKed ${action} from the participant, completing step "${step.actionId}".` +
        // The ACK is the only thing the participant sees, so anything we
        // noticed and did not act on has to be said here — this journal line is
        // the only channel that reaches the model for an inbound call it was
        // not parked on.
        describeInbound(protocol),
    });
    await this.#deps.records.saveBusinessData(
      transactionId,
      session.np.subscriber_url,
      body,
      saveDataFor(runtime.config, step.actionId),
    );

    // The expectation has done its job; leaving it armed would let an unrelated
    // call land in this transaction.
    await this.#deps.records.clearExpectationsForSession(
      receiverScope(session),
      sessionId,
    );

    /* 7b. If a participant-hosted form comes next, resolve it now. */
    await resolveUpcomingForm(this.#deps, session, transactionId, map, step);

    /* 8. ACK first. Chaining happens after the answer is on the wire. */
    return {
      status: 200,
      body: ackBody,
      transactionId,
      ...(runtime.record.autoAdvance
        ? { chain: { sessionId, transactionId } }
        : { complete: { sessionId, transactionId } }),
    };
  }

  /**
   * Tell whoever might care about a call we refused without knowing whose it was.
   *
   * ## The gap this fills
   *
   * `NO_EXPECTATION` and `SESSION_EXPIRED` are refusals made *before* a session
   * is in hand — that is the definition of them — so there is no session to
   * journal against and, until now, no trace of them anywhere but the log. Yet
   * they are among the most diagnostic things this server sees: a participant
   * calling back late, or on a transaction we never opened, or after its test
   * session lapsed. A model driving a flow that has gone quiet has no other way
   * to discover that its counterparty *is* calling — just not acceptably.
   *
   * So the entry goes to **every session armed on this endpoint**, and its kind
   * says exactly what it is worth: `POSSIBLY_RELATED`. The endpoint is shared
   * by every session on a build, and the wire genuinely cannot say more than
   * that. Naming one session would be a guess presented as a fact.
   *
   * ## Bounded, because this path is reachable by an unauthenticated stranger
   *
   * The body is stored out of line and size-capped, the fan-out is capped, and
   * the journal trims itself — so a participant hammering a dead endpoint costs
   * a bounded amount of storage rather than an unbounded one. Best-effort
   * throughout: this runs on a request that is already being refused, and
   * nothing here may turn a clean 412 into a 500.
   */
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */
