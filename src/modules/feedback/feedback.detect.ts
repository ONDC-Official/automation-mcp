import { AppError, UpstreamError } from "@/lib/errors.js";
import type {
  IncidentEvidence,
  TriggerKind,
} from "@/modules/feedback/feedback.schema.js";
import type { StepOutcome } from "@/modules/flow/flow.schema.js";
import type { SessionEvent } from "@/modules/record/record.schema.js";
import type { SessionEventDiagnostics } from "@/modules/record/record.service.js";

/**
 * What counts as an incident, stated as data.
 *
 * Pure: nothing here reads a store, writes a store or knows what a session is.
 * The whole module is a set of total functions from "something that happened"
 * to "an incident candidate, or none", which is what makes the guarantee in
 * `feedback.detect.test.ts` possible — that test enumerates every
 * `blocked()` reason and every NACK code the receiver can emit and asserts each
 * one lands somewhere. A new failure mode that nobody wires up shows as a
 * failing test rather than as silence in the corpus.
 *
 * ## Detection happens in exactly two places, and they must not overlap
 *
 * `detectFromOutcome` / `detectFromError` run on what `flow_proceed` returns or
 * throws. `detectFromEvent` runs on the session journal. Several things are
 * visible to *both*, and where they are, the journal side deliberately declines:
 *
 * | Also on the journal as | Why the journal side skips it                       |
 * | ---------------------- | --------------------------------------------------- |
 * | `OUTBOUND_SENT` (NACK) | the outcome carries `ack_body`; the journal line does not |
 * | `CHAIN_PAUSED`         | `chainNext` re-enters `proceed`, so the outcome was already observed |
 *
 * Getting that wrong does not lose data — it double-counts it, which is worse:
 * `occurrences` is the field that says how hard a model fought something.
 *
 * The same rule binds *within* `detectFromOutcome`: the outbound gate and
 * `dry_run` describe one defect through two different outcome shapes, so a
 * findings-bearing `BLOCKED` is normalised onto `VALIDATION_FINDINGS` to give
 * them one signature. See the comment on that branch.
 */

/** An incident before it has been given an identity or merged with its twin. */
export interface Candidate {
  readonly trigger: TriggerKind;
  readonly code: string;
  readonly stepKey?: string;
  readonly action?: string;
  readonly evidence: IncidentEvidence;
}

/** Journal kinds that describe a failure this session owns. */
const FAILING_KINDS = new Set(["INBOUND_NACK", "ATTENTION", "FLOW_RESTARTED"]);

function pick(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Lift the `error` object a `blocked()` detail carries into evidence.
 *
 * `requirements_error` and `generation_error` both put the sandbox's
 * `{name, message, stack}` there. The stack is the useful half and, until this
 * module, went nowhere at all.
 */
function sandboxEvidence(details: unknown): IncidentEvidence {
  const error = pick(details, "error");
  const stack = asString(pick(error, "stack"));
  const message = asString(pick(error, "message"));
  const logs = pick(details, "logs");

  return {
    ...(message !== undefined ? { message } : {}),
    ...(stack !== undefined ? { runner_stack: stack } : {}),
    ...(Array.isArray(logs)
      ? {
          runner_logs: logs.filter(
            (line): line is string => typeof line === "string",
          ),
        }
      : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* From a StepOutcome                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Everything worth reporting about one outcome.
 *
 * A list rather than a single candidate, because one `SENT` can be two findings
 * at once: the participant NACKed it *and* our own gate had already flagged it.
 * Those are different lessons — one is about the flow config, the other about
 * the participant — and collapsing them would lose whichever came second.
 */
export function detectFromOutcome(outcome: StepOutcome): Candidate[] {
  const candidates: Candidate[] = [];
  const base = {
    ...(outcome.step_key !== undefined ? { stepKey: outcome.step_key } : {}),
    ...(outcome.action !== undefined ? { action: outcome.action } : {}),
  };

  if (outcome.outcome === "BLOCKED") {
    const details = outcome.details;
    const raw = pick(details, "findings");
    const findings = (
      Array.isArray(raw) ? raw : []
    ) as NonNullable<IncidentEvidence["findings"]>;

    /*
     * A block the outbound gate caused is the *same lesson* the dry-run path
     * reports, and it must carry the same signature or the corpus counts one
     * defect twice.
     *
     * The two paths disagree by construction: the gate answers `BLOCKED` with
     * `details.findings` and no `validation` (`blocked()` does not set it),
     * while `dry_run` answers `DRAFTED` and carries the verdict — so the
     * findings-bearing block lands as `BLOCKED::step::validation_failed` and
     * the dry run as `VALIDATION_FINDINGS::step::L0_SCHEMA`. Different
     * signatures, no dedup, two reports.
     *
     * That is not a rare interleaving: the gate's own message tells the model
     * to "inspect the payload with flow_proceed dry_run to confirm", so the
     * surface actively walks it into the second incident. Both TRV11 runs on
     * 2026-07-31 spooled the pair, and one of the four reports was a model
     * explaining that it had just filed a duplicate.
     *
     * So a findings-bearing block *is* a `VALIDATION_FINDINGS`, and the two
     * merge into one incident whose `occurrences` says it was hit twice —
     * which is the number that was wanted in the first place. A block with no
     * findings (every other `blocked()` reason) is untouched.
     */
    const verdictCode = findings[0]?.code;
    candidates.push({
      ...(verdictCode !== undefined
        ? { trigger: "VALIDATION_FINDINGS" as const, code: verdictCode }
        : { trigger: "BLOCKED" as const, code: outcome.reason ?? "unknown" }),
      ...base,
      evidence: {
        message: outcome.message,
        ...sandboxEvidence(details),
        ...(findings.length > 0 ? { findings } : {}),
      },
    });
  }

  // A NACK is `SENT`, not `BLOCKED` (`flow.service.ts:2131`) — the exchange
  // completed, and the refusal is the result. It is also the single most
  // informative thing a compliance run produces, so it is emphatically an
  // incident even though nothing failed.
  if (
    outcome.outcome === "SENT" &&
    outcome.ack !== undefined &&
    outcome.ack !== "ACK"
  ) {
    const errorBlock = pick(outcome.ack_body, "error");
    candidates.push({
      trigger: "OUTBOUND_NACK",
      code: asString(pick(errorBlock, "code")) ?? outcome.ack,
      ...base,
      evidence: {
        ack: outcome.ack,
        ...(asString(pick(errorBlock, "message")) !== undefined
          ? { message: asString(pick(errorBlock, "message")) }
          : {}),
        ...(outcome.http_status !== undefined
          ? { http_status: outcome.http_status }
          : {}),
      },
    });
  }

  const verdict = outcome.validation;
  if (verdict !== undefined && verdict.status === "invalid") {
    // Never twice for one outcome. The block above may already have raised
    // this exact trigger from `details.findings`, and an outcome that carried
    // both would report the same verdict as two incidents — the failure this
    // whole normalisation exists to remove.
    const alreadyRaised = candidates.some(
      (candidate) => candidate.trigger === "VALIDATION_FINDINGS",
    );
    if (!alreadyRaised) {
      candidates.push({
        trigger: "VALIDATION_FINDINGS",
        code: verdict.findings[0]?.code ?? "VALIDATION_ERROR",
        ...base,
        evidence: { findings: verdict.findings },
      });
    }
  }

  // Not a synonym for `valid`, here either. Both gates fail open on it, so how
  // often it happens is a fact about our own infrastructure that nothing else
  // records — and a run full of `unavailable` produced a compliance report that
  // covered less than it appeared to.
  if (verdict !== undefined && verdict.status === "unavailable") {
    candidates.push({
      trigger: "VALIDATION_UNAVAILABLE",
      code: verdict.unchecked[0]?.reason ?? "no layer could be checked",
      ...base,
      evidence: { unchecked: verdict.unchecked },
    });
  }

  return candidates;
}

/* -------------------------------------------------------------------------- */
/* From a throw                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Walk `.cause` collecting `code` properties.
 *
 * `SenderService#classifyDelivery` does this to decide `unreachable` vs
 * `uncertain` and then throws the answer away, so a report cannot tell a
 * connection reset from a headers timeout. Keeping the chain costs nothing and
 * is the difference between "the participant was flaky" and "our timeout is too
 * short".
 */
function causeCodes(error: unknown, depth = 5): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (
    let i = 0;
    i < depth && current !== undefined && current !== null;
    i += 1
  ) {
    const code = pick(current, "code");
    if (typeof code === "string") codes.push(code);
    current = pick(current, "cause");
  }
  return codes;
}

/**
 * A thrown failure, which is the case with no `StepOutcome` at all.
 *
 * `#dispatchSend` settles the entry and rethrows: there is no `BLOCKED`, no
 * `attention` and no journal line, and inside `chainNext` the throw was
 * previously swallowed with a `logger.error`. That combination is how a chained
 * run stalls in complete silence, and it is the reason this function exists.
 */
export function detectFromError(
  error: unknown,
  context: { stepKey?: string; action?: string } = {},
): Candidate | undefined {
  const base = {
    ...(context.stepKey !== undefined ? { stepKey: context.stepKey } : {}),
    ...(context.action !== undefined ? { action: context.action } : {}),
  };

  if (error instanceof UpstreamError) {
    const delivery = asString(pick(error.details, "delivery"));
    const status = pick(error.details, "http_status");
    return {
      trigger: "SEND_FAILED",
      code: delivery ?? "uncertain",
      ...base,
      evidence: {
        message: error.message,
        ...(delivery !== undefined ? { delivery } : {}),
        ...(typeof status === "number" ? { http_status: status } : {}),
        ...(causeCodes(error).length > 0
          ? { error_codes: causeCodes(error) }
          : {}),
      },
    };
  }

  // A `ValidationError` or `NotFoundError` out of the loop is the model calling
  // a tool wrongly, not a defect — it is already an `isError` result it can read
  // and retry from, and recording every one would drown the corpus in typos.
  if (error instanceof AppError && error.code !== "internal_error") {
    return undefined;
  }

  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  return {
    trigger: "INFRA_ERROR",
    code: error instanceof Error ? error.name : "UnknownError",
    ...base,
    evidence: {
      message,
      ...(stack !== undefined ? { runner_stack: stack } : {}),
      ...(causeCodes(error).length > 0
        ? { error_codes: causeCodes(error) }
        : {}),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* From a journal line                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The tap.
 *
 * Returns `undefined` for the great majority of lines — an ACK, a bound
 * transaction, a completed flow — because the journal is a record of everything
 * that happened, not of everything that went wrong.
 *
 * `POSSIBLY_RELATED` is the one kind that needs the caller's help. It is fanned
 * out to every live session on a shared endpoint (up to ten), so opening an
 * incident on each would write nine misleading reports about a call that had
 * nothing to do with them. It is therefore reported only when the producer
 * passes `diagnostics`, which the receiver does exactly where the call *is*
 * attributable to one session.
 */
export function detectFromEvent(
  event: SessionEvent,
  diagnostics?: SessionEventDiagnostics,
): Candidate | undefined {
  const evidence = (diagnostics?.evidence ?? {}) as IncidentEvidence;
  const base = {
    ...(diagnostics?.stepKey !== undefined
      ? { stepKey: diagnostics.stepKey }
      : {}),
    ...(event.action !== undefined ? { action: event.action } : {}),
  };

  if (event.kind === "POSSIBLY_RELATED") {
    if (diagnostics === undefined) return undefined;
    return {
      trigger: "INBOUND_NACK",
      code: event.nack_code ?? "UNATTRIBUTED",
      ...base,
      evidence: { message: event.summary, ...evidence },
    };
  }

  if (!FAILING_KINDS.has(event.kind)) return undefined;

  if (event.kind === "FLOW_RESTARTED") {
    return {
      trigger: "RUN_ABANDONED",
      code: "flow_restart",
      ...base,
      evidence: { message: event.summary, ...evidence },
    };
  }

  return {
    trigger: "INBOUND_NACK",
    code: event.nack_code ?? "UNKNOWN",
    ...base,
    evidence: { message: event.summary, ...evidence },
  };
}
