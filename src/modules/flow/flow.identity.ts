import { ConflictError } from "@/lib/errors.js";
import type { MappedStep } from "@/modules/flow/engine/engine-types.js";
import type { FlowDeps, FlowRuntime } from "@/modules/flow/flow.types.js";
import type {
  ExpectationScope,
  TransactionRecord,
} from "@/modules/record/record.schema.js";
import type { Session } from "@/modules/session/session.schema.js";
import { receiverScope } from "@/modules/session/session.service.js";

/**
 * Where a run's `transaction_id` comes from, and the two moments it is fixed.
 *
 * The id is minted by whoever sends the flow's **first** action, so a run
 * exists before it does. There are exactly two bind sites and they live in
 * this file together on purpose: `bindOutbound`, reading the id back off a
 * payload we generated, and `adoptTransaction`, taking the participant's id
 * verbatim off a call they made first. Both must leave identical state —
 * splitting them is how they drift.
 *
 * **`bindOutbound` mutates its `runtime` argument in place.** That is
 * deliberate and the caller depends on it: `dispatch` reads
 * `runtime.bound` again after binding, and the `SENT` outcome is stamped
 * from it. Do not "purify" this into returning a fresh runtime — the DRAFTED
 * and SENT branches would start disagreeing about identity, silently.
 */

/**
 * What the participant must call us back on.
 *
 * Read off the session rather than recomputed, because a session may carry a
 * per-session tunnel override — and the URL we advertise has to be the one
 * the participant was told about at `session_create`.
 */
export function callbackUrl(session: Session): string {
  return session.callback_url;
}

/**
 * Identity, **in the shape a config's `generate` actually reads it**.
 *
 * Every other value in `sessionData` arrives through `saveData`, which runs
 * `jsonpath.query` and therefore always yields a *list*: `bppId` is
 * `["bpp.example.com"]`, never `"bpp.example.com"`. Published configs are
 * written against exactly that and index it in place —
 * `context.bpp_id = sessionData?.bppId[0]` is the live TRV11 shape.
 *
 * Seeding a bare string here does not throw, which is precisely the problem:
 * `[0]` on a string is its first *character*, so `"bpp.example.com"` reaches
 * a third party's wire as `"b"`. It bites hardest on a flow's **first**
 * action, when nothing has been saved yet and all four of these are seeds
 * rather than saves — and on any field the participant simply omits, because
 * an omitted field saves as `[]` and falls through to the seed.
 *
 * `transactionId` below has been a list for this same reason since forms
 * landed; these four were missed.
 */
export function seedIdentity(
  deps: FlowDeps,
  session: Session,
  transactionId: string,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const ourUri = callbackUrl(session);
  const ourId = deps.mockSubscriberId;
  const theirUri = session.np.subscriber_url;
  const theirId = session.np.subscriber_id ?? hostOf(theirUri);

  const ours =
    session.mock_role === "BAP"
      ? { bapId: [ourId], bapUri: [ourUri] }
      : { bppId: [ourId], bppUri: [ourUri] };
  const theirs =
    session.mock_role === "BAP"
      ? { bppId: [theirId], bppUri: [theirUri] }
      : { bapId: [theirId], bapUri: [theirUri] };

  const data: Record<string, unknown> = { ...stored };

  // The participant's own payloads are authoritative about the participant.
  for (const [key, value] of Object.entries(theirs)) {
    if (isEmpty(data[key])) data[key] = value;
  }
  Object.assign(data, ours);

  return {
    ...data,
    // `transaction_id` for generateContext, `transactionId` (an array) for
    // the config helpers — `createFormURL` reads `transactionId[0]`.
    transaction_id: transactionId,
    transactionId: [transactionId],
    sessionId: session.session_id,
    subscriberUrl: theirUri,
    mockBaseUrl: deps.receiverPublicUrl,
  };
}

/**
 * The session data a config's `generate` function sees.
 *
 * Three layers, and the order between them is the whole point:
 *
 * 1. Whatever the flow has saved so far — the provider ids, the order id.
 * 2. **Our** identity, which always wins. We know it definitively, and the
 *    alternative is the config's canned `bap.example.com` going out on the
 *    wire.
 * 3. The participant's identity, only as a **fallback**. Once its own
 *    payloads have told us its real `bpp_id`, that is the authoritative
 *    value and must not be overwritten by our guess.
 */
export async function buildSessionData(
  deps: FlowDeps,
  runtime: FlowRuntime,
  inputs: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  const { session, record } = runtime;
  const stored = await deps.records.getBusinessData(
    record.transactionId,
    session.np.subscriber_url,
  );

  return {
    ...seedIdentity(deps, session, record.transactionId, stored),
    ...(inputs !== undefined ? { user_inputs: inputs } : {}),
  };
}

/**
 * Keep one id for the whole flow instance, and say so when a config does not.
 *
 * `generateContext` reads `sessionData.transaction_id` first, so a divergence
 * here means the step's own `generate` rewrote `context` — a real thing
 * published configs do. Shipping the drifted id would not merely mis-key our
 * record: the participant would file it as a *second* transaction and the
 * flow would come apart on both sides. So it is corrected in place and
 * reported, because a config that does this is itself a finding.
 */
export function assertTransactionId(
  deps: FlowDeps,
  runtime: FlowRuntime,
  step: MappedStep,
  payload: Record<string, unknown>,
): void {
  const expected = runtime.record.transactionId;
  const generated = readTransactionId(payload);
  if (generated === undefined || generated === expected) return;

  deps.logger.warn(
    {
      session_id: runtime.session.session_id,
      transaction_id: expected,
      step_key: step.actionId,
      generated,
    },
    "the step's generate rewrote context.transaction_id; correcting it",
  );
  writeTransactionId(payload, expected);
}

/**
 * Open the transaction this run just minted, and bind the run to it.
 *
 * The identity seed goes in here rather than at `flow_start` because there
 * was no transaction to seed until now. It matters: a published config's
 * canned identity points at `bap.example.com`, and without ours in place
 * before the *next* generate that is what would go out.
 */
export async function bindOutbound(
  deps: FlowDeps,
  runtime: FlowRuntime,
  transactionId: string,
) {
  const { session, binding } = runtime;

  const existing = await deps.records.findTransaction(
    transactionId,
    session.np.subscriber_url,
  );
  if (existing) {
    throw new ConflictError(
      `Transaction "${transactionId}" is already running flow "${existing.flowId}" against this participant.`,
      { transaction_id: transactionId, flow_id: existing.flowId },
    );
  }

  const record = await deps.records.createTransaction({
    transactionId,
    sessionId: session.session_id,
    flowId: binding.flowId,
    // The engine reads this as "the side the participant under test is on".
    subscriberType: session.np.type,
    subscriberUrl: session.np.subscriber_url,
    scope: receiverScope(session),
    autoAdvance: binding.autoAdvance,
  });

  await deps.records.overwriteBusinessData(
    transactionId,
    session.np.subscriber_url,
    seedIdentity(deps, session, transactionId, {}),
  );

  await deps.repository.saveBinding({ ...binding, transactionId });

  // The caller is holding a runtime built before any of this existed.
  runtime.record = record;
  runtime.bound = true;
  runtime.binding = { ...binding, transactionId };

  await deps.records.journal(session.session_id, {
    kind: "TRANSACTION_BOUND",
    flow_id: binding.flowId,
    transaction_id: transactionId,
    summary: `Flow "${binding.flowId}" minted transaction ${transactionId} for its first action.`,
  });

  deps.logger.info(
    {
      session_id: session.session_id,
      flow_id: binding.flowId,
      transaction_id: transactionId,
    },
    "minted the transaction id for this flow's first action",
  );
}

/**
 * Open the transaction the **participant** chose, and bind the run to it.
 *
 * The inbound twin of `#bindOutbound`, called by the receiver when an armed
 * expectation catches a flow's first call. The participant sent that action,
 * so the `transaction_id` on it is the real one by definition — there is
 * nothing to reconcile and nothing of ours to prefer.
 *
 * Both bind sites must leave identical state, which is why this is here and
 * not inlined in the receiver: a transaction opened one way and a transaction
 * opened the other are the same transaction to every read that follows.
 */
export async function adoptTransaction(
  deps: FlowDeps,
  args: {
  session: Session;
  flowId: string;
  transactionId: string;
  autoAdvance: boolean;
  scope: ExpectationScope;
}): Promise<TransactionRecord> {
  const { session, flowId, transactionId } = args;

  const record = await deps.records.createTransaction({
    transactionId,
    sessionId: session.session_id,
    flowId,
    subscriberType: session.np.type,
    // The registered URL, never the advertised one — see CreateTransactionInput.
    subscriberUrl: session.np.subscriber_url,
    scope: args.scope,
    autoAdvance: args.autoAdvance,
  });

  // Same reason as the outbound path: without our identity in place, the
  // config's canned `bap.example.com` is what the next generate would send.
  await deps.records.overwriteBusinessData(
    transactionId,
    session.np.subscriber_url,
    seedIdentity(deps, session, transactionId, {}),
  );

  const existing = await deps.repository.findBinding(
    session.session_id,
    flowId,
  );
  await deps.repository.saveBinding({
    sessionId: session.session_id,
    flowId,
    autoAdvance: args.autoAdvance,
    transactionId,
    startedAt: existing?.startedAt ?? record.createdAt,
    // Carried through, not reset: this is how a *restarted* run binds when
    // the participant sends the flow's first action, and the new transaction
    // is attempt N, not attempt 1.
    attempt: existing?.attempt ?? 1,
    previousAttempts: existing?.previousAttempts ?? [],
  });

  // The other half of the identity model, and the more surprising one to
  // read about after the fact: this id was the participant's to choose, so
  // the journal is where a model driving by `flow_id` learns it.
  await deps.records.journal(session.session_id, {
    kind: "TRANSACTION_BOUND",
    flow_id: flowId,
    transaction_id: transactionId,
    summary: `The participant opened flow "${flowId}" with transaction ${transactionId}.`,
  });

  return record;
}

/** `context.transaction_id` as generated, or undefined if it is unusable. */
export function readTransactionId(
  payload: Record<string, unknown>,
): string | undefined {
  const context = payload["context"];
  if (typeof context !== "object" || context === null) return undefined;
  const value = (context as Record<string, unknown>)["transaction_id"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Put the transaction id the record is keyed on onto the payload.
 *
 * Mutates the generated object in place, before it is stored or sent, so the
 * bytes on the wire and the bytes we record are the same bytes. Creates
 * `context` if the generator produced none — a payload with no context is
 * already broken, but it is the receiver's job to say so, not ours to crash on.
 */
export function writeTransactionId(
  payload: Record<string, unknown>,
  transactionId: string,
): void {
  const context = payload["context"];
  if (typeof context === "object" && context !== null) {
    (context as Record<string, unknown>)["transaction_id"] = transactionId;
    return;
  }
  payload["context"] = { transaction_id: transactionId };
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  return Array.isArray(value) && value.length === 0;
}

/** Registry ids are conventionally the subscriber's host. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
