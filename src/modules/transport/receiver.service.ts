import type { Logger } from "pino";
import { NotFoundError } from "@/lib/errors.js";
import type { Metrics } from "@/lib/metrics/metrics.js";
import type { MockEngine } from "@/lib/mock-engine/mock-engine.js";
import type { MappedStep } from "@/modules/flow/engine/engine-types.js";
import { getFlowCompleteStatus } from "@/modules/flow/engine/flow-mapper.js";
import type { FlowService } from "@/modules/flow/flow.service.js";
import { saveDataFor } from "@/modules/flow/flow.service.js";
import type { FormsService } from "@/modules/forms/forms.service.js";
import type { ReceiverRole } from "@/modules/catalog/catalog.schema.js";
import { normaliseSubscriberUrl } from "@/modules/record/record.repository.js";
import {
  unwrapSaved,
  type AppendResult,
  type RecordService,
} from "@/modules/record/record.service.js";
import type {
  Expectation,
  ExpectationScope,
  TransactionLocation,
  TransactionRecord,
} from "@/modules/record/record.schema.js";
import {
  receiverScope,
  type SessionService,
} from "@/modules/session/session.service.js";
import type { Session } from "@/modules/session/session.schema.js";
import {
  primaryCode,
  summariseFindings,
  type ValidationVerdict,
} from "@/modules/validate/validate.schema.js";
import type { ValidateService } from "@/modules/validate/validate.service.js";
import { readAck } from "@/modules/transport/sender.service.js";

const FORM_TYPES = new Set(["HTML_FORM", "DYNAMIC_FORM", "HTML_FORM_MULTI"]);

/**
 * How many sessions one unattributable refusal is announced to.
 *
 * This path is reachable by anyone who can POST to the endpoint, and the
 * endpoint is deliberately unauthenticated — a third-party server has no MCP
 * credentials and never will. The cap is what keeps a stranger's repeated bad
 * call from being amplified across every session on a busy build.
 */
const UNATTRIBUTED_FANOUT_LIMIT = 10;

/**
 * Ceiling on a refused body kept as evidence.
 *
 * An accepted payload is stored whole, because it is part of a transaction we
 * are answering for. A *refused* one belongs to nobody we can identify, so it
 * is stored only far enough to recognise: a real `on_search` catalog runs to
 * hundreds of kilobytes, and a participant looping on a dead endpoint would
 * otherwise fill the store with them.
 */
const REFUSED_BODY_LIMIT = 32_000;

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

/** The parts of the URL a call arrived on. */
export interface InboundRequest {
  domain: string;
  version: string;
  /** `buyer` or `seller` — **our** role, since the endpoint is ours. */
  role: ReceiverRole;
  /** From the path. `context.action` is what actually decides the step. */
  action: string;
}

/** What the receiver decided, ready to be written to the wire. */
export interface InboundResult {
  status: number;
  body: unknown;
  /** Set when the call was filed against a transaction. */
  transactionId?: string;
  /** Set when auto-advance should run once the ACK has been written. */
  chain?: { sessionId: string; transactionId: string };
  /**
   * Set when this call may have finished the flow, and nothing else is going
   * to notice. Checked after the ACK, like chaining — and mutually exclusive
   * with it, because `chainNext` reaches `COMPLETE` on its own.
   */
  complete?: { sessionId: string; transactionId: string };
}

export interface ReceiverServiceOptions {
  sessions: SessionService;
  records: RecordService;
  flows: FlowService;
  forms: FormsService;
  mockEngine: MockEngine;
  /** L0 + L1 on what arrives, inside the ACK window. */
  validate: ValidateService;
  logger: Logger;
  /** Optional; absent in unit tests. The verdict is the same either way. */
  metrics?: Metrics;
}

interface BecknContext {
  action?: unknown;
  message_id?: unknown;
  transaction_id?: unknown;
  timestamp?: unknown;
  bap_uri?: unknown;
  bpp_uri?: unknown;
}

export class ReceiverService {
  readonly #sessions: SessionService;
  readonly #records: RecordService;
  readonly #flows: FlowService;
  readonly #forms: FormsService;
  readonly #mockEngine: MockEngine;
  readonly #validate: ValidateService;
  readonly #logger: Logger;
  readonly #metrics: Metrics | undefined;

  constructor(options: ReceiverServiceOptions) {
    this.#sessions = options.sessions;
    this.#records = options.records;
    this.#flows = options.flows;
    this.#forms = options.forms;
    this.#mockEngine = options.mockEngine;
    this.#validate = options.validate;
    this.#logger = options.logger;
    this.#metrics = options.metrics;
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
      this.#logger.error({ err: error, ...request }, "inbound request failed");
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
    const metrics = this.#metrics;
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
      return this.#refuseMalformed(scope, request, body, {
        detail: "context.message_id is required and must be a string.",
      });
    }
    const messageId = context.message_id;
    // The body's action decides the step, not the path — the workbench matches
    // on `context.action` too. The path is checked against it below.
    if (typeof context.action !== "string" || context.action === "") {
      return this.#refuseMalformed(scope, request, body, {
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
      return this.#refuseMalformed(scope, request, body, {
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
    const resolved = await this.#resolve(
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
      return this.#refuseAbandoned(session, resolved.record, action, {
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
      const appended = await this.#record(
        session,
        transactionId,
        action,
        messageId,
        timestamp,
        body,
        ackBody,
      );
      await this.#journalInbound(session, {
        flowId: resolved.record.flowId,
        transactionId,
        action,
        nackCode: "ACTION_MISMATCH",
        ...(appended.payloadId !== undefined
          ? { payloadId: appended.payloadId }
          : {}),
        summary: `NACKed ${action}: it arrived on the "${request.action}" endpoint. Recorded as a finding.`,
      });
      this.#logger.warn(
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
    const runtime = await this.#flows.load(sessionId, { transactionId });
    const flowStatus = await this.#records.getFlowStatus(
      transactionId,
      session.np.subscriber_url,
    );
    const businessData = await this.#records.getBusinessData(
      transactionId,
      session.np.subscriber_url,
    );
    const map = getFlowCompleteStatus(
      runtime.record,
      runtime.flow,
      flowStatus,
      businessData,
      await this.#records.getExtraFlowStatuses(
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
      const appended = await this.#record(
        session,
        transactionId,
        action,
        messageId,
        timestamp,
        body,
        ackBody,
      );
      await this.#journalInbound(session, {
        flowId: runtime.record.flowId,
        transactionId,
        action,
        nackCode: "OUT_OF_SEQUENCE",
        ...(appended.payloadId !== undefined
          ? { payloadId: appended.payloadId }
          : {}),
        summary: `NACKed an unexpected ${action} — the flow is not waiting for it. Recorded as a finding.`,
      });
      this.#logger.warn(
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
      this.#mockEngine.runValidate(
        runtime.runner,
        step.actionId,
        body,
        businessData,
      ),
      this.#validate.validate({
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
      const appended = await this.#record(
        session,
        transactionId,
        action,
        messageId,
        timestamp,
        body,
        ackBody,
      );
      await this.#journalInbound(session, {
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
      const appended = await this.#record(
        session,
        transactionId,
        action,
        messageId,
        timestamp,
        body,
        ackBody,
      );
      await this.#journalInbound(session, {
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
    if (protocol.status === "invalid" && this.#validate.enforces) {
      const code = primaryCode(protocol.findings);
      const ackBody = nack(code, summariseFindings(protocol.findings));
      const appended = await this.#record(
        session,
        transactionId,
        action,
        messageId,
        timestamp,
        body,
        ackBody,
      );
      await this.#journalInbound(session, {
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
      this.#logger.info(
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
    const appended = await this.#record(
      session,
      transactionId,
      action,
      messageId,
      timestamp,
      body,
      ackBody,
    );
    await this.#journalInbound(session, {
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
    await this.#records.saveBusinessData(
      transactionId,
      session.np.subscriber_url,
      body,
      saveDataFor(runtime.config, step.actionId),
    );

    // The expectation has done its job; leaving it armed would let an unrelated
    // call land in this transaction.
    await this.#records.clearExpectationsForSession(
      receiverScope(session),
      sessionId,
    );

    /* 7b. If a participant-hosted form comes next, resolve it now. */
    await this.#resolveUpcomingForm(session, transactionId, map, step);

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
   * Fetch and screen a form the participant is about to require, if this call
   * just supplied its URL.
   *
   * Ported from the workbench's `processHtmlFormStep`, and worth the
   * complication for one reason: the payload that carries a form URL is the
   * same payload that makes the form step current. Fetching it here means the
   * page has already been retrieved, screened and had its relative actions
   * resolved by the time anyone asks for it — so `form_fetch` answers from
   * memory and a page that turns out to be hostile is discovered before it is
   * ever offered to a human.
   *
   * Best-effort throughout: this runs after the payload has been accepted, and
   * a form we could not pre-fetch is simply fetched later on demand. Nothing
   * here may turn a good ACK into a failure.
   */
  async #resolveUpcomingForm(
    session: Session,
    transactionId: string,
    map: { sequence: MappedStep[] },
    completedStep: MappedStep,
  ): Promise<void> {
    if (completedStep.isExtraStep === true) return;

    const index = map.sequence.findIndex(
      (step) => step.actionId === completedStep.actionId,
    );
    const next = index >= 0 ? map.sequence[index + 1] : undefined;
    if (!next || !FORM_TYPES.has(next.actionType)) return;

    // A form we host has no page to fetch — the participant opens ours.
    if (next.owner !== session.np.type) return;

    try {
      const data = await this.#records.getBusinessData(
        transactionId,
        session.np.subscriber_url,
      );
      const url = unwrapSaved(data[next.actionId]);
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;

      const html = await this.#forms.prefetchForm(url);
      if (html === undefined) return;

      data[next.actionId] = html;
      await this.#records.overwriteBusinessData(
        transactionId,
        session.np.subscriber_url,
        data,
      );

      this.#logger.info(
        { transaction_id: transactionId, step_key: next.actionId },
        "pre-fetched the participant's form",
      );
    } catch (error) {
      this.#logger.warn(
        { err: error, transaction_id: transactionId, step_key: next.actionId },
        "could not pre-fetch the participant's form; it will be fetched on demand",
      );
    }
  }

  /**
   * Find the session and transaction this call belongs to.
   *
   * Two ways in, tried in that order:
   *
   * 1. **By `transaction_id`.** Anything after the first exchange resolves
   *    here — including a counterparty whose advertised URI has drifted from
   *    the one it registered, which the pair key alone would miss. Missing it
   *    would not merely 412: it would fall through to (2) and open a *second*
   *    record under a second key, leaving the receiver writing to one half of
   *    the transaction while every read tool looks at the other.
   * 2. **By armed expectation.** A flow whose first step is the participant's
   *    — a mock BPP waiting for `search` — has no record yet, and its
   *    `transaction_id` is theirs to choose. The expectation is the standing
   *    permission to create one, and this is the *only* place a transaction is
   *    opened from inbound traffic. Nothing was minted in advance: `flow_start`
   *    deliberately persists nothing, precisely so the id that ends up on the
   *    books is the id that was on the wire.
   *
   * Neither ⇒ 412, which is what the workbench answers and says why.
   */
  async #resolve(
    request: InboundRequest,
    scope: ExpectationScope,
    context: BecknContext,
    action: string,
    advertisedUri: string,
    /** Enough to file the call as evidence when resolution itself refuses it. */
    call: { body: unknown; messageId: string; timestamp: string },
  ): Promise<
    | { session: Session; transactionId: string; record: TransactionRecord }
    | { failure: InboundResult }
  > {
    const transactionId =
      typeof context.transaction_id === "string" &&
      context.transaction_id.length > 0
        ? context.transaction_id
        : undefined;

    if (transactionId === undefined) {
      return {
        failure: await this.#refuseMalformed(scope, request, call.body, {
          messageId: call.messageId,
          action,
          timestamp: call.timestamp,
          advertisedUri,
          detail: "context.transaction_id is required and must be a string.",
        }),
      };
    }

    /* 1. Known transaction. */
    const located = await this.#records.findTransactionLocations(transactionId);
    const onThisEndpoint = located.filter((entry) =>
      sameEndpoint(entry, scope),
    );

    for (const candidate of rankLocations(onThisEndpoint, advertisedUri)) {
      const session = await this.#loadSession(candidate.sessionId);
      if (!session) continue;
      const record = await this.#records.findTransaction(
        transactionId,
        candidate.subscriberUrl,
      );
      if (!record) continue;
      this.#warnOnUriDrift(session, advertisedUri, transactionId);
      return { session, transactionId, record };
    }

    /*
     * The id is known, but on a different build or role. Worth its own answer:
     * "no expectation" would send the integrator looking in the wrong place.
     */
    const elsewhere = located[0];
    if (elsewhere !== undefined && onThisEndpoint.length === 0) {
      const message = `Transaction "${transactionId}" belongs to ${elsewhere.domain}/${elsewhere.version}/${elsewhere.role}, not ${request.domain}/${request.version}/${request.role}.`;
      // The one refusal of the three where a session *is* known: the index says
      // whose transaction this is. Told to that session alone rather than
      // broadcast — it is their participant that is calling the wrong door, and
      // every other session on this endpoint is a bystander.
      await this.#journalUnattributable({
        scope,
        sessionId: elsewhere.sessionId,
        transactionId,
        action,
        advertisedUri,
        code: "WRONG_ENDPOINT",
        summary: `Refused ${action}: the participant called ${request.domain}/${request.version}/${request.role}, but this transaction lives on ${elsewhere.domain}/${elsewhere.version}/${elsewhere.role}.`,
        call,
      });
      return { failure: { status: 412, body: nack("WRONG_ENDPOINT", message) } };
    }

    /* 2. An armed expectation. */
    const expectation = await this.#records.consumeExpectation(scope, {
      action,
      transactionId,
      subscriberUrl: advertisedUri,
    });

    if (!expectation) {
      // Nobody was listening for this action — but somebody on this endpoint is
      // listening for *something*, and a participant calling an action we are
      // not expecting is exactly what they would want to know about.
      await this.#journalUnattributable({
        scope,
        transactionId,
        action,
        advertisedUri,
        code: "NO_EXPECTATION",
        summary:
          `Refused ${action} from ${advertisedUri} quoting transaction ${transactionId}: ` +
          "nothing on this endpoint was expecting it. It may belong to your run.",
        call,
      });
      return {
        failure: {
          status: 412,
          body: nack(
            "NO_EXPECTATION",
            `No active expectation found for transaction ID: ${transactionId} and Subscriber URL: ${advertisedUri}. ` +
              "Start a flow with flow_start before sending to this mock.",
          ),
        },
      };
    }

    const session = await this.#loadSession(expectation.sessionId);
    if (!session) {
      // The expectation named a session that is gone, so there is nobody left
      // to tell — except whichever other sessions share this endpoint, one of
      // which may be the participant's real intended target.
      await this.#journalUnattributable({
        scope,
        transactionId,
        action,
        advertisedUri,
        code: "SESSION_EXPIRED",
        summary:
          `Refused ${action}: it matched an expectation belonging to session ` +
          `"${expectation.sessionId}", which has expired.`,
        call,
      });
      return {
        failure: {
          status: 412,
          body: nack(
            "SESSION_EXPIRED",
            `An expectation for "${action}" named session "${expectation.sessionId}", which has expired. Call session_create and start the flow again.`,
          ),
        },
      };
    }

    this.#warnOnUriDrift(session, advertisedUri, transactionId);

    /*
     * An expectation carries a `transactionId` only once its run is bound —
     * that is, once the flow's first action has already crossed the wire and
     * fixed the id for the rest of the flow. Arriving here with a *different*
     * one means the participant changed transaction mid-flow: branch 1 could
     * not find their id because it belongs to no transaction of ours.
     *
     * Adopting it would open a second record for a flow that already has one
     * and split the transaction in half — the receiver writing to one, every
     * read tool looking at the other. So it is refused and filed against the
     * transaction it should have quoted, where a compliance run will find it.
     */
    if (
      expectation.transactionId !== undefined &&
      expectation.transactionId !== transactionId
    ) {
      return {
        failure: await this.#refuseMismatch(
          session,
          scope,
          expectation,
          transactionId,
          action,
          call,
        ),
      };
    }

    const record = await this.#flows.adoptTransaction({
      session,
      flowId: expectation.flowId,
      transactionId,
      autoAdvance: expectation.autoAdvance,
      scope,
    });

    this.#logger.info(
      {
        session_id: session.session_id,
        transaction_id: transactionId,
        flow_id: expectation.flowId,
        action,
      },
      "opened a transaction from an armed expectation; the participant chose the id",
    );

    return { session, transactionId, record };
  }

  /**
   * Refuse a call that quotes the wrong transaction, and keep listening.
   *
   * Three things have to happen besides the NACK.
   *
   * The expectation is **put back** — `consumeExpectation` already took it, and
   * a stray call must not be able to stop us listening for the real one.
   *
   * The body is stored **out of line**, not appended to the transaction. This
   * call typically carries the action the flow is waiting for, so appending it
   * would match the pending step and mark it `COMPLETE` — the flow would
   * advance on a call we just refused. It is also, by its own `context`, part
   * of a different transaction: replaying it as history of this one would be a
   * lie about what this transaction contains.
   *
   * And the reason is written to `attention`, because a payload nothing points
   * at is not evidence. That is what puts it in front of the caller on the next
   * `flow_get_status`, alongside the handle to read it.
   */
  async #refuseMismatch(
    session: Session,
    scope: ExpectationScope,
    expectation: Expectation,
    quoted: string,
    action: string,
    call: { body: unknown; messageId: string; timestamp: string },
  ): Promise<InboundResult> {
    const expected = expectation.transactionId as string;

    await this.#records.armExpectation(scope, {
      sessionId: expectation.sessionId,
      flowId: expectation.flowId,
      transactionId: expected,
      expectedAction: expectation.expectedAction,
      subscriberUrl: expectation.subscriberUrl,
      autoAdvance: expectation.autoAdvance,
    });

    const message =
      `This flow is transaction "${expected}", but "${action}" quoted "${quoted}". ` +
      "Every call after a flow's first action must carry the same transaction_id.";
    const ackBody = nack("TRANSACTION_MISMATCH", message);

    const payloadId = await this.#records.storePayload({
      transactionId: expected,
      subscriberUrl: session.np.subscriber_url,
      direction: "inbound",
      action,
      messageId: call.messageId,
      timestamp: call.timestamp,
      body: call.body,
      ackBody,
    });

    await this.#records.setAttention(expected, session.np.subscriber_url, {
      kind: "TRANSACTION_MISMATCH",
      message: `${message} Refused; read the payload with record_get_payload (${payloadId}).`,
      at: new Date().toISOString(),
    });

    await this.#journalInbound(session, {
      flowId: expectation.flowId,
      transactionId: expected,
      action,
      nackCode: "TRANSACTION_MISMATCH",
      payloadId,
      // Attention rather than a plain NACK: the body is stored out of line, so
      // it appears in no transaction's history and this line is the only thing
      // that points at it.
      attention: true,
      summary: `Refused ${action}: it quoted transaction ${quoted}, but this flow is ${expected}. Body kept out of line.`,
    });

    this.#logger.warn(
      {
        session_id: session.session_id,
        transaction_id: expected,
        quoted,
        action,
        payload_id: payloadId,
      },
      "inbound call quotes a different transaction_id than the flow it belongs to",
    );

    return { status: 200, body: ackBody, transactionId: expected };
  }

  /**
   * Refuse a call for an attempt `flow_restart` wrote off.
   *
   * The id is still resolvable on purpose — `txn_index` outlives the restart so
   * late traffic can be filed rather than bounced at the transport — so this is
   * the branch that decides what "filed" means for a run we have abandoned.
   *
   * Recorded **out of line**, not appended, for both of `#refuseMismatch`'s
   * reasons and one more. Appending would advance the abandoned attempt's
   * derived map, marking a step complete on a run we just refused; it would
   * also publish an event on `flow_run::{session}::{flow}`, which is the key a
   * `flow_await` on the *current* attempt is parked on — waking it with a
   * callback that belongs to the previous try is precisely the confusion the
   * restart existed to clear up.
   *
   * The NACK is honest about what happened: the participant is calling about a
   * test run that has been superseded, and ACKing it would say the opposite.
   */
  async #refuseAbandoned(
    session: Session,
    record: TransactionRecord,
    action: string,
    call: { body: unknown; messageId: string; timestamp: string },
  ): Promise<InboundResult> {
    const { transactionId, flowId } = record;
    const attempt = record.abandoned?.attempt ?? 1;

    const message =
      `Transaction "${transactionId}" was attempt ${String(attempt)} of flow ` +
      `"${flowId}" and has been abandoned. That run has been restarted; a new ` +
      "attempt carries a new transaction_id.";
    const ackBody = nack("TRANSACTION_ABANDONED", message);

    const payloadId = await this.#records.storePayload({
      transactionId,
      subscriberUrl: session.np.subscriber_url,
      direction: "inbound",
      action,
      messageId: call.messageId,
      timestamp: call.timestamp,
      body: call.body,
      ackBody,
    });

    await this.#records.setAttention(
      transactionId,
      session.np.subscriber_url,
      {
        kind: "TRANSACTION_ABANDONED",
        message: `${message} Refused; read the payload with record_get_payload (${payloadId}).`,
        at: new Date().toISOString(),
      },
    );

    await this.#journalInbound(session, {
      flowId,
      transactionId,
      action,
      nackCode: "TRANSACTION_ABANDONED",
      payloadId,
      attention: true,
      summary:
        `Refused ${action}: it belongs to attempt ${String(attempt)} of "${flowId}", which was restarted away. ` +
        "The participant may still be driving the old run.",
    });

    this.#logger.warn(
      {
        session_id: session.session_id,
        transaction_id: transactionId,
        flow_id: flowId,
        attempt,
        action,
        payload_id: payloadId,
      },
      "inbound call arrived for an attempt that has been abandoned",
    );

    return { status: 200, body: ackBody, transactionId };
  }

  /**
   * A session that has expired is ordinary, not exceptional.
   *
   * A state store that is *down* is neither, which is why this catch names the
   * error it is willing to swallow. Left bare, a Redis outage would arrive here
   * as "no such session" and we would answer the counterparty that their
   * callback URL is stale — recording our own infrastructure failure as their
   * non-compliance, in a compliance report. Anything that is not a genuine
   * miss propagates and surfaces as a 5xx, which is what it is.
   */
  async #loadSession(sessionId: string): Promise<Session | undefined> {
    try {
      return await this.#sessions.requireSession(sessionId);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      return undefined;
    }
  }

  /**
   * The counterparty advertises one URI and registered another.
   *
   * Not fatal — we resolved by transaction id — but it is a genuine
   * misconfiguration on the participant's side and exactly the sort of thing a
   * compliance run exists to surface.
   */
  #warnOnUriDrift(
    session: Session,
    advertisedUri: string,
    transactionId: string,
  ): void {
    if (
      normaliseSubscriberUrl(advertisedUri) ===
      normaliseSubscriberUrl(session.np.subscriber_url)
    ) {
      return;
    }
    this.#logger.warn(
      {
        session_id: session.session_id,
        transaction_id: transactionId,
        advertised: advertisedUri,
        registered: session.np.subscriber_url,
      },
      "counterparty advertises a different subscriber URL than it registered",
    );
  }

  #record(
    session: Session,
    transactionId: string,
    action: string,
    messageId: string,
    timestamp: string,
    body: unknown,
    ackBody: unknown,
  ): Promise<AppendResult> {
    return this.#records.appendApiEntry({
      transactionId,
      subscriberUrl: session.np.subscriber_url,
      action,
      messageId,
      direction: "inbound",
      timestamp,
      body,
      ackBody,
    });
  }

  /**
   * Note an inbound call in the session journal.
   *
   * Every call this endpoint takes a view on gets a line, because an inbound
   * call is the one thing that happens entirely outside the model's control:
   * unless it is parked in `flow_await` on precisely the right run at precisely
   * the right moment, this is the only way it ever learns the call happened.
   *
   * Ordinary refusals are `INBOUND_NACK`; the two that leave a body the model
   * should read are `ATTENTION`, so a busy journal still distinguishes "we
   * refused it and the flow is unaffected" from "we refused it and there is
   * something here for you". Never both for one call.
   */
  #journalInbound(
    session: Session,
    entry: {
      flowId?: string;
      transactionId: string;
      action: string;
      nackCode?: string;
      payloadId?: string;
      attention?: boolean;
      summary: string;
    },
  ): Promise<void> {
    return this.#records.journal(session.session_id, {
      kind:
        entry.attention === true
          ? "ATTENTION"
          : entry.nackCode === undefined
            ? "INBOUND_ACK"
            : "INBOUND_NACK",
      ...(entry.flowId !== undefined ? { flow_id: entry.flowId } : {}),
      transaction_id: entry.transactionId,
      action: entry.action,
      ack: entry.nackCode === undefined ? "ACK" : "NACK",
      ...(entry.nackCode !== undefined ? { nack_code: entry.nackCode } : {}),
      ...(entry.payloadId !== undefined ? { payload_id: entry.payloadId } : {}),
      summary: entry.summary,
    });
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
  /**
   * Refuse a call whose context we cannot key on — and say so out loud.
   *
   * These four branches used to `return` a 400 and nothing else: no record (by
   * definition — there is no id to file it under), no journal line, no log the
   * model could read. A participant calling with a missing `bap_uri` was
   * therefore **completely invisible**. The operator saw a run sitting in
   * `flow_await` reporting that nothing had arrived, which is exactly what a
   * silent participant looks like, and the two are the opposite problem: one is
   * "they never called", the other is "they called and we would not take it".
   *
   * So it is journaled to every live session on the endpoint, the same audience
   * and the same reasoning as `#journalUnattributable` — a malformed call names
   * no session, and the sessions sharing this endpoint are precisely the ones it
   * might have been for. The body is kept, capped, because "what did they
   * actually send?" is the only question worth asking next.
   *
   * Best-effort throughout: a call we are already refusing must not turn into a
   * 500 because the journal was unavailable.
   */
  async #refuseMalformed(
    scope: ExpectationScope,
    request: InboundRequest,
    body: unknown,
    call: {
      messageId?: string;
      action?: string;
      timestamp?: string;
      advertisedUri?: string;
      detail: string;
    },
  ): Promise<InboundResult> {
    const ackBody = nack("MALFORMED_CONTEXT", call.detail);

    try {
      const audience = await this.#sessions.sessionsOnEndpoint(
        scope,
        UNATTRIBUTED_FANOUT_LIMIT,
      );
      if (audience.length > 0) {
        const payloadId = await this.#records.storePayload({
          // No transaction and possibly no caller: the endpoint is the only
          // true thing about this call, so that is what it is filed under. The
          // handle is what makes it readable, not the key.
          transactionId: `MALFORMED::${scope.domain}/${scope.version}/${scope.role}`,
          subscriberUrl: call.advertisedUri ?? "unknown",
          direction: "inbound",
          action: call.action ?? request.action,
          messageId: call.messageId ?? "unknown",
          timestamp: call.timestamp ?? new Date().toISOString(),
          body: capBody(body),
          ackBody,
        });

        for (const sessionId of audience) {
          await this.#records.journal(sessionId, {
            kind: "POSSIBLY_RELATED",
            action: call.action ?? request.action,
            ack: "NACK",
            nack_code: "MALFORMED_CONTEXT",
            payload_id: payloadId,
            summary:
              `Refused a ${request.action} call on ${scope.domain}/${scope.version}/${scope.role} ` +
              `with 400: ${call.detail} It could not be attributed to any run, so it may be yours. ` +
              `Read what arrived with record_get_payload (${payloadId}).`,
          });
        }
      }
    } catch (error) {
      this.#logger.warn(
        { err: error, ...scope, action: request.action },
        "could not journal a malformed inbound call",
      );
    }

    this.#logger.warn(
      { ...scope, action: request.action, detail: call.detail },
      "refused an inbound call whose context could not be keyed on",
    );

    return { status: 400, body: ackBody };
  }

  async #journalUnattributable(args: {
    /** The endpoint the call arrived on; its armed sessions are the audience. */
    scope: ExpectationScope;
    /** Journal to exactly this session instead, when the call named one. */
    sessionId?: string;
    transactionId: string;
    action: string;
    advertisedUri: string;
    code: string;
    summary: string;
    call: { body: unknown; messageId: string; timestamp: string };
  }): Promise<void> {
    try {
      // Every live session on the endpoint, not just the ones with an armed
      // expectation. A run that has *sent* its request and is waiting for the
      // callback arms nothing at all — the receiver files that callback by
      // `transaction_id` — and it is precisely the run whose participant is
      // most likely to be the one calling badly.
      const audience =
        args.sessionId !== undefined
          ? [args.sessionId]
          : await this.#sessions.sessionsOnEndpoint(
              args.scope,
              UNATTRIBUTED_FANOUT_LIMIT,
            );
      if (audience.length === 0) return;

      const payloadId = await this.#records.storePayload({
        transactionId: args.transactionId,
        // The URI it advertised, not one we registered — we do not know which
        // participant this is, and pretending otherwise would mis-key it.
        subscriberUrl: args.advertisedUri,
        direction: "inbound",
        action: args.action,
        messageId: args.call.messageId,
        timestamp: args.call.timestamp,
        body: capBody(args.call.body),
        ackBody: nack(args.code, args.summary),
      });

      for (const sessionId of audience) {
        await this.#records.journal(sessionId, {
          kind: "POSSIBLY_RELATED",
          transaction_id: args.transactionId,
          action: args.action,
          ack: "NACK",
          nack_code: args.code,
          payload_id: payloadId,
          summary: args.summary,
        });
      }
    } catch (error) {
      this.#logger.warn(
        { err: error, ...args.scope, action: args.action },
        "could not journal an unattributable refusal",
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

export function ack(): unknown {
  return { message: { ack: { status: "ACK" } } };
}

/**
 * What to add to an ACK's journal line about protocol validation.
 *
 * Empty when the payload passed cleanly — the overwhelmingly common case, and
 * one where a sentence saying so on every callback would bury the lines that
 * matter. The two states that speak are the ones the model would otherwise
 * never learn: findings we chose not to act on (`advisory`), and a payload
 * nobody checked (`unavailable`).
 *
 * Note that an ACK carrying findings is *not* a contradiction. Under `advisory`
 * we accept the call and record what was wrong with it; the compliance report is
 * where that lands. Refusing would be the alternative, and it is exactly what
 * `enforce` does.
 */
export function describeInbound(verdict: ValidationVerdict): string {
  if (verdict.status === "valid") return "";

  if (verdict.status === "unavailable") {
    return (
      " Protocol validation did not run: " +
      (verdict.unchecked[0]?.reason ?? "no layer could be checked") +
      "."
    );
  }

  return (
    ` It has ${String(verdict.findings.length)} validation ` +
    `finding${verdict.findings.length === 1 ? "" : "s"}, recorded but not enforced: ` +
    `${summariseFindings(verdict.findings, 2)}.`
  );
}

export function nack(code: string, message: string): unknown {
  return {
    message: { ack: { status: "NACK" } },
    error: { code, message },
  };
}

/**
 * A refused body, trimmed to what is worth keeping.
 *
 * Returns the body untouched when it is small enough — the common case, and the
 * one where the model wants the whole thing. Over the limit it is replaced by a
 * description plus a prefix: enough to see the context and recognise the call,
 * without storing a catalog for a transaction that is not ours.
 */
export function capBody(body: unknown): unknown {
  const serialised = JSON.stringify(body ?? null);
  if (serialised === undefined) return null;

  const bytes = Buffer.byteLength(serialised, "utf8");
  if (bytes <= REFUSED_BODY_LIMIT) return body;

  return {
    _truncated: true,
    _bytes: bytes,
    _note: `This call was refused and its body exceeded ${String(REFUSED_BODY_LIMIT)} bytes, so only a prefix was kept.`,
    _prefix: serialised.slice(0, REFUSED_BODY_LIMIT),
  };
}

/** Whether a located transaction belongs to the endpoint a call arrived on. */
export function sameEndpoint(
  location: TransactionLocation,
  scope: ExpectationScope,
): boolean {
  return (
    location.domain.trim().toLowerCase() ===
      scope.domain.trim().toLowerCase() &&
    location.version.trim() === scope.version.trim() &&
    location.role === scope.role
  );
}

/**
 * Candidates for one `transaction_id`, best first.
 *
 * Only reachable when the same id is live against two participants at once, so
 * the tie-break is deliberately simple: the one whose registered URL matches
 * what the caller advertises, else the most recent.
 */
export function rankLocations(
  locations: readonly TransactionLocation[],
  advertisedUri: string,
): TransactionLocation[] {
  const advertised = normaliseSubscriberUrl(advertisedUri);
  return [...locations].sort((a, b) => {
    const aMatch = normaliseSubscriberUrl(a.subscriberUrl) === advertised;
    const bMatch = normaliseSubscriberUrl(b.subscriberUrl) === advertised;
    if (aMatch !== bMatch) return aMatch ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

function readContext(body: unknown): BecknContext {
  if (typeof body !== "object" || body === null) return {};
  const context = (body as { context?: unknown }).context;
  if (typeof context !== "object" || context === null) return {};
  return context;
}

/**
 * Which pending step, if any, this call satisfies.
 *
 * Matching is by **action type**, plus a `message_id` echo where the flow
 * declared one. The workbench matches on the triplet
 * `action::message_id::timestamp` against an already-recorded payload, which
 * only works because it records the expected call before it arrives; matching
 * a live call that way would require us to predict its timestamp.
 *
 * The `awaitingMessageId` check is the part that matters for extras: side-channel
 * steps repeat, so without it a reply would attach to whichever instance came
 * first rather than the one that prompted it.
 */
export function matchStep(
  steps: MappedStep[],
  action: string,
  messageId: string,
): MappedStep | undefined {
  const pending = steps.filter(
    (step) =>
      step.status === "LISTENING" ||
      step.status === "WAITING-SUBMISSION" ||
      step.status === "PROCESSING",
  );

  const echoed = pending.find(
    (step) =>
      step.actionType === action && step.awaitingMessageId === messageId,
  );
  if (echoed) return echoed;

  return pending.find(
    (step) =>
      step.actionType === action && step.awaitingMessageId === undefined,
  );
}
