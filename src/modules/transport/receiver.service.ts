import type { Logger } from "pino";
import { NotFoundError } from "@/lib/errors.js";
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
  type RecordService,
} from "@/modules/record/record.service.js";
import type {
  ExpectationScope,
  TransactionLocation,
} from "@/modules/record/record.schema.js";
import {
  receiverScope,
  type SessionService,
} from "@/modules/session/session.service.js";
import type { Session } from "@/modules/session/session.schema.js";

const FORM_TYPES = new Set(["HTML_FORM", "DYNAMIC_FORM", "HTML_FORM_MULTI"]);

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
}

export interface ReceiverServiceOptions {
  sessions: SessionService;
  records: RecordService;
  flows: FlowService;
  forms: FormsService;
  mockEngine: MockEngine;
  logger: Logger;
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
  readonly #logger: Logger;

  constructor(options: ReceiverServiceOptions) {
    this.#sessions = options.sessions;
    this.#records = options.records;
    this.#flows = options.flows;
    this.#forms = options.forms;
    this.#mockEngine = options.mockEngine;
    this.#logger = options.logger;
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
    try {
      return await this.#handle(request, body, headers);
    } catch (error) {
      this.#logger.error({ err: error, ...request }, "inbound request failed");
      return {
        status: 500,
        body: nack(
          "INTERNAL_ERROR",
          "The mock failed to process this request.",
        ),
      };
    }
  }

  async #handle(
    request: InboundRequest,
    body: unknown,
    headers: Record<string, unknown>,
  ): Promise<InboundResult> {
    /* 1. Parse. A context we cannot key on is unusable. */
    const context = readContext(body);
    if (typeof context.message_id !== "string" || context.message_id === "") {
      return {
        status: 400,
        body: nack(
          "MALFORMED_CONTEXT",
          "context.message_id is required and must be a string.",
        ),
      };
    }
    const messageId = context.message_id;
    // The body's action decides the step, not the path — the workbench matches
    // on `context.action` too. The path is checked against it below.
    if (typeof context.action !== "string" || context.action === "") {
      return {
        status: 400,
        body: nack(
          "MALFORMED_CONTEXT",
          "context.action is required and must be a string.",
        ),
      };
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
      return {
        status: 400,
        body: nack(
          "MALFORMED_CONTEXT",
          `context.${counterpartyField} is required: this endpoint is a ${
            request.role === "buyer" ? "BAP" : "BPP"
          }, so the ${counterpartyField} identifies the caller.`,
        ),
      };
    }

    if (!this.verifyAuth(headers)) {
      return { status: 401, body: undefined };
    }

    /* 3. Resolve the transaction, or create it from an armed expectation. */
    const resolved = await this.#resolve(
      request,
      context,
      action,
      advertisedUri,
    );
    if ("failure" in resolved) return resolved.failure;
    const { session, transactionId } = resolved;
    const sessionId = session.session_id;

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
      await this.#record(
        session,
        transactionId,
        action,
        messageId,
        timestamp,
        body,
        ackBody,
      );
      this.#logger.warn(
        { sessionId, transactionId, pathAction: request.action, action },
        "inbound action does not match the endpoint it arrived on",
      );
      return { status: 200, body: ackBody, transactionId };
    }

    /* 4. Match the call to a step the flow is actually waiting for. */
    const runtime = await this.#flows.load(sessionId, transactionId);
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
      // Recorded anyway. An unexpected call is one of the most valuable things
      // a compliance run can catch, and dropping it would erase the evidence —
      // the mapper classifies it as out-of-sequence on the next read.
      await this.#record(
        session,
        transactionId,
        action,
        messageId,
        timestamp,
        body,
        nack(
          "OUT_OF_SEQUENCE",
          `This mock is not expecting "${action}" at this point in the flow.`,
        ),
      );
      this.#logger.warn(
        { sessionId, transactionId, action },
        "inbound request matched no pending step",
      );
      return {
        status: 200,
        body: nack(
          "OUT_OF_SEQUENCE",
          `This mock is not expecting "${action}" at this point in the flow.`,
        ),
        transactionId,
      };
    }

    /* 5. Run the step's own validator. */
    const verdict = await this.#mockEngine.runValidate(
      runtime.runner,
      step.actionId,
      body,
      businessData,
    );

    if (!verdict.ok) {
      // The config's validator crashed, or broke its return contract. That is
      // the config author's defect — but the participant still gets a clean
      // answer rather than a 500.
      const ackBody = nack(
        "VALIDATION_FUNCTION_ERROR",
        verdict.error?.message ?? "The validation function failed to run.",
      );
      await this.#record(
        session,
        transactionId,
        action,
        messageId,
        timestamp,
        body,
        ackBody,
      );
      return { status: 200, body: ackBody, transactionId };
    }

    if (verdict.result?.valid === false) {
      const ackBody = nack(
        String(verdict.result.code ?? "VALIDATION_ERROR"),
        verdict.result.description ?? "Validation failed.",
      );
      await this.#record(
        session,
        transactionId,
        action,
        messageId,
        timestamp,
        body,
        ackBody,
      );
      return { status: 200, body: ackBody, transactionId };
    }

    /* 6-7. Accepted: record it, then fold it into the business data. */
    const ackBody = ack();
    await this.#record(
      session,
      transactionId,
      action,
      messageId,
      timestamp,
      body,
      ackBody,
    );
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
        : {}),
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
        { transactionId, stepKey: next.actionId },
        "pre-fetched the participant's form",
      );
    } catch (error) {
      this.#logger.warn(
        { err: error, transactionId, stepKey: next.actionId },
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
   *    permission to create one.
   *
   * Neither ⇒ 412, which is what the workbench answers and says why.
   */
  async #resolve(
    request: InboundRequest,
    context: BecknContext,
    action: string,
    advertisedUri: string,
  ): Promise<
    { session: Session; transactionId: string } | { failure: InboundResult }
  > {
    const transactionId =
      typeof context.transaction_id === "string" &&
      context.transaction_id.length > 0
        ? context.transaction_id
        : undefined;

    if (transactionId === undefined) {
      return {
        failure: {
          status: 400,
          body: nack(
            "MALFORMED_CONTEXT",
            "context.transaction_id is required and must be a string.",
          ),
        },
      };
    }

    const scope: ExpectationScope = {
      domain: request.domain,
      version: request.version,
      role: request.role,
    };

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
      return { session, transactionId };
    }

    /*
     * The id is known, but on a different build or role. Worth its own answer:
     * "no expectation" would send the integrator looking in the wrong place.
     */
    const elsewhere = located[0];
    if (elsewhere !== undefined && onThisEndpoint.length === 0) {
      return {
        failure: {
          status: 412,
          body: nack(
            "WRONG_ENDPOINT",
            `Transaction "${transactionId}" belongs to ${elsewhere.domain}/${elsewhere.version}/${elsewhere.role}, not ${request.domain}/${request.version}/${request.role}.`,
          ),
        },
      };
    }

    /* 2. An armed expectation. */
    const expectation = await this.#records.consumeExpectation(scope, {
      action,
      transactionId,
      subscriberUrl: advertisedUri,
    });

    if (!expectation) {
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

    await this.#records.createTransaction({
      transactionId,
      sessionId: session.session_id,
      flowId: expectation.flowId,
      subscriberType: session.np.type,
      // The registered URL, never the advertised one — see CreateTransactionInput.
      subscriberUrl: session.np.subscriber_url,
      scope,
      autoAdvance: expectation.autoAdvance,
    });

    this.#logger.info(
      {
        sessionId: session.session_id,
        transactionId,
        flowId: expectation.flowId,
        action,
      },
      "opened a transaction from an armed expectation",
    );

    return { session, transactionId };
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
        sessionId: session.session_id,
        transactionId,
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
  ): Promise<unknown> {
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
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

export function ack(): unknown {
  return { message: { ack: { status: "ACK" } } };
}

export function nack(code: string, message: string): unknown {
  return {
    message: { ack: { status: "NACK" } },
    error: { code, message },
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
