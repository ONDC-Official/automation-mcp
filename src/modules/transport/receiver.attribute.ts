import { NotFoundError } from "@/lib/errors.js";
import { normaliseSubscriberUrl } from "@/modules/record/record.repository.js";
import type {
  ExpectationScope,
  TransactionLocation,
  TransactionRecord,
} from "@/modules/record/record.schema.js";
import type { Session } from "@/modules/session/session.schema.js";
import type {
  BecknContext,
  InboundRequest,
  InboundResult,
  ReceiverDeps,
} from "@/modules/transport/receiver.types.js";
import {
  journalUnattributable,
  nack,
  refuseMalformed,
  refuseMismatch,
} from "@/modules/transport/receiver.refuse.js";

/**
 * Working out whose call this is.
 *
 * The URI we advertise is shared by every session on a build — a participant
 * integrates against an endpoint, not against one of our test runs — so the
 * session is recovered from the payload: the transaction-id index first, an
 * expectation armed on the endpoint second, 412 otherwise.
 *
 * **One deliberate divergence from the workbench.** It looks a transaction up
 * under the URI the payload advertises; we index the id on its own, because
 * those two URLs are meant to be identical and routinely are not — a trailing
 * slash, a differing pathname. Under the workbench's rule a drifted URI does
 * not merely 412: it falls through to the expectation branch and opens a
 * *second* record under a second key, leaving the receiver writing to one half
 * of a transaction while the loop tools read the other. The drift is logged
 * instead, and records always key on the registered subscriber URL.
 */

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
export async function resolve(
  deps: ReceiverDeps,
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
      failure: await refuseMalformed(deps, scope, request, call.body, {
        messageId: call.messageId,
        action,
        timestamp: call.timestamp,
        advertisedUri,
        detail: "context.transaction_id is required and must be a string.",
      }),
    };
  }

  /* 1. Known transaction. */
  const located = await deps.records.findTransactionLocations(transactionId);
  const onThisEndpoint = located.filter((entry) =>
    sameEndpoint(entry, scope),
  );

  for (const candidate of rankLocations(onThisEndpoint, advertisedUri)) {
    const session = await loadSession(deps, candidate.sessionId);
    if (!session) continue;
    const record = await deps.records.findTransaction(
      transactionId,
      candidate.subscriberUrl,
    );
    if (!record) continue;
    warnOnUriDrift(deps, session, advertisedUri, transactionId);
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
    await journalUnattributable(deps, {
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
  const expectation = await deps.records.consumeExpectation(scope, {
    action,
    transactionId,
    subscriberUrl: advertisedUri,
  });

  if (!expectation) {
    // Nobody was listening for this action — but somebody on this endpoint is
    // listening for *something*, and a participant calling an action we are
    // not expecting is exactly what they would want to know about.
    await journalUnattributable(deps, {
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

  const session = await loadSession(deps, expectation.sessionId);
  if (!session) {
    // The expectation named a session that is gone, so there is nobody left
    // to tell — except whichever other sessions share this endpoint, one of
    // which may be the participant's real intended target.
    await journalUnattributable(deps, {
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

  warnOnUriDrift(deps, session, advertisedUri, transactionId);

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
      failure: await refuseMismatch(deps, 
        session,
        scope,
        expectation,
        transactionId,
        action,
        call,
      ),
    };
  }

  const record = await deps.flows.adoptTransaction({
    session,
    flowId: expectation.flowId,
    transactionId,
    autoAdvance: expectation.autoAdvance,
    scope,
  });

  deps.logger.info(
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
 * A session that has expired is ordinary, not exceptional.
 *
 * A state store that is *down* is neither, which is why this catch names the
 * error it is willing to swallow. Left bare, a Redis outage would arrive here
 * as "no such session" and we would answer the counterparty that their
 * callback URL is stale — recording our own infrastructure failure as their
 * non-compliance, in a compliance report. Anything that is not a genuine
 * miss propagates and surfaces as a 5xx, which is what it is.
 */
export async function loadSession(
  deps: ReceiverDeps,sessionId: string): Promise<Session | undefined> {
  try {
    return await deps.sessions.requireSession(sessionId);
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
export function warnOnUriDrift(
  deps: ReceiverDeps,
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
  deps.logger.warn(
    {
      session_id: session.session_id,
      transaction_id: transactionId,
      advertised: advertisedUri,
      registered: session.np.subscriber_url,
    },
    "counterparty advertises a different subscriber URL than it registered",
  );
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

export function readContext(body: unknown): BecknContext {
  if (typeof body !== "object" || body === null) return {};
  const context = (body as { context?: unknown }).context;
  if (typeof context !== "object" || context === null) return {};
  return context;
}
