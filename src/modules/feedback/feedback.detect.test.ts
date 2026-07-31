import { describe, expect, it } from "vitest";
import { NotFoundError, UpstreamError, ValidationError } from "@/lib/errors.js";
import {
  detectFromError,
  detectFromEvent,
  detectFromOutcome,
} from "@/modules/feedback/feedback.detect.js";
import type { SessionEvent } from "@/modules/record/record.schema.js";
import { SessionEventKind } from "@/modules/record/record.schema.js";
import type { StepOutcome } from "@/modules/flow/flow.schema.js";

/**
 * Every `blocked()` reason in `flow.service.ts`.
 *
 * This list is the guarantee. `flow_proceed` refusing for a reason nobody
 * enumerated here is a failure the corpus would never see, and the only way to
 * notice is to state the reasons as data and assert over them — the same shape
 * as `flow/engine/pending-step.ts`'s truth table.
 */
const BLOCKED_REASONS = [
  "flow_suspended",
  "attempt_abandoned",
  "already_processing",
  "not_actionable",
  "unknown_extra",
  "not_ours_to_send",
  "requirements_error",
  "requirements_not_met",
  "generation_error",
  "validation_failed",
  "chain_limit",
] as const;

/** Every code the receiver can put on a NACK. */
const NACK_CODES = [
  "OUT_OF_SEQUENCE",
  "ACTION_MISMATCH",
  "TRANSACTION_MISMATCH",
  "TRANSACTION_ABANDONED",
  "VALIDATION_FUNCTION_ERROR",
  "NO_EXPECTATION",
  "SESSION_EXPIRED",
  "WRONG_ENDPOINT",
  "MALFORMED_CONTEXT",
  "INTERNAL_ERROR",
] as const;

function event(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    seq: 1,
    at: "2026-07-30T11:00:00.000Z",
    kind: "INBOUND_NACK",
    summary: "something was refused",
    ...overrides,
  };
}

describe("detectFromOutcome — every blocked() reason lands", () => {
  it.each(BLOCKED_REASONS)("opens an incident for %s", (reason) => {
    const outcome: StepOutcome = {
      outcome: "BLOCKED",
      message: `blocked: ${reason}`,
      reason,
      step_key: "select",
    };

    const [candidate] = detectFromOutcome(outcome);

    expect(candidate?.trigger).toBe("BLOCKED");
    expect(candidate?.code).toBe(reason);
    expect(candidate?.stepKey).toBe("select");
  });

  it("lifts the sandbox stack a generation_error carries", () => {
    // `RunOutcome.error.stack` reaches `blocked().details.error` and, before
    // this module, went no further than a `logger.debug`.
    const [candidate] = detectFromOutcome({
      outcome: "BLOCKED",
      message: "could not generate",
      reason: "generation_error",
      step_key: "confirm",
      details: {
        step_key: "confirm",
        error: {
          name: "TypeError",
          message: "no provider",
          stack: "at gen (x.js:1:1)",
        },
      },
    });

    expect(candidate?.evidence.runner_stack).toBe("at gen (x.js:1:1)");
  });
});

describe("detectFromOutcome — the non-BLOCKED failures", () => {
  it("reports a NACKed send, which arrives as SENT", () => {
    // The exchange completed; the refusal is the result. If this were keyed on
    // `BLOCKED` the most informative event in a compliance run would be invisible.
    const [candidate] = detectFromOutcome({
      outcome: "SENT",
      message: "sent",
      action: "select",
      ack: "NACK",
      http_status: 200,
      ack_body: { error: { code: "30001", message: "provider not found" } },
    });

    expect(candidate?.trigger).toBe("OUTBOUND_NACK");
    expect(candidate?.code).toBe("30001");
    expect(candidate?.evidence.ack).toBe("NACK");
  });

  it("says nothing about a clean ACK", () => {
    expect(
      detectFromOutcome({ outcome: "SENT", message: "sent", ack: "ACK" }),
    ).toEqual([]);
  });

  it("reports an UNPARSEABLE ack, which is its own kind of finding", () => {
    const [candidate] = detectFromOutcome({
      outcome: "SENT",
      message: "sent",
      ack: "UNPARSEABLE",
    });

    expect(candidate?.trigger).toBe("OUTBOUND_NACK");
  });

  it("reports validation findings and the NACK separately", () => {
    // Two lessons, not one: the config produced a bad payload *and* the
    // participant refused it. Collapsing them loses whichever came second.
    const candidates = detectFromOutcome({
      outcome: "SENT",
      message: "sent",
      ack: "NACK",
      ack_body: { error: { code: "30001" } },
      validation: {
        status: "invalid",
        findings: [
          {
            layer: "L1",
            code: "TTL_REQUIRED",
            json_path: "$.context.ttl",
            message: "missing",
          },
        ],
        checked: ["L0", "L1"],
        unchecked: [],
      },
    });

    expect(candidates.map((c) => c.trigger)).toEqual([
      "OUTBOUND_NACK",
      "VALIDATION_FINDINGS",
    ]);
  });

  it("gives the gate and dry_run one signature for one defect", () => {
    /*
     * Regression: one blocked step produced two incidents.
     *
     * The outbound gate answers `BLOCKED` carrying `details.findings` and no
     * verdict — `blocked()` does not set `validation` — while the same step
     * under `dry_run` answers `DRAFTED` carrying the verdict. That gave
     * `BLOCKED::step::validation_failed` and
     * `VALIDATION_FINDINGS::step::L0_SCHEMA`: different signatures, so dedup
     * could not merge them and the corpus counted one config defect twice.
     *
     * It is not a rare interleaving either — the gate's own message tells the
     * model to inspect the payload with `dry_run`, so the surface walks it
     * into the second incident. Both TRV11 runs on 2026-07-31 spooled the
     * pair, and one of the four reports was a model explaining that it had
     * just filed a duplicate.
     */
    const findings = [
      {
        layer: "L0" as const,
        code: "L0_SCHEMA",
        json_path: "$.context.bpp_uri",
        message: "got array, want string",
      },
    ];

    const [fromGate] = detectFromOutcome({
      outcome: "BLOCKED",
      message: "not spec-compliant, so it was not sent",
      reason: "validation_failed",
      step_key: "search2",
      details: { step_key: "search2", findings },
    });

    const [fromDryRun] = detectFromOutcome({
      outcome: "DRAFTED",
      message: "generated but did not send it",
      step_key: "search2",
      validation: {
        status: "invalid",
        findings,
        checked: ["L0", "L1"],
        unchecked: [],
      },
    });

    expect(fromGate?.trigger).toBe("VALIDATION_FINDINGS");
    expect(fromGate?.code).toBe("L0_SCHEMA");
    expect(fromGate?.evidence.findings).toEqual(findings);
    // The signature is (trigger, stepKey, code) — equal on all three, so the
    // second lands on the first as an occurrence rather than a new incident.
    expect([fromDryRun?.trigger, fromDryRun?.code, fromDryRun?.stepKey]).toEqual(
      [fromGate?.trigger, fromGate?.code, fromGate?.stepKey],
    );
  });

  it("leaves a block with no findings as BLOCKED", () => {
    // Only a *findings-bearing* block is a validation incident. Every other
    // `blocked()` reason keeps its own trigger, which is what the enumeration
    // above guarantees.
    const [candidate] = detectFromOutcome({
      outcome: "BLOCKED",
      message: "requirements not met",
      reason: "requirements_not_met",
      step_key: "confirm",
      details: { step_key: "confirm" },
    });

    expect(candidate?.trigger).toBe("BLOCKED");
    expect(candidate?.code).toBe("requirements_not_met");
  });

  it("raises one VALIDATION_FINDINGS when an outcome carries both", () => {
    // Defensive: `blocked()` does not set `validation` today, but an outcome
    // that carried findings *and* a verdict must still be one incident.
    const findings = [
      {
        layer: "L1" as const,
        code: "TTL_REQUIRED",
        json_path: "$.context.ttl",
        message: "missing",
      },
    ];

    const candidates = detectFromOutcome({
      outcome: "BLOCKED",
      message: "blocked",
      reason: "validation_failed",
      step_key: "search",
      details: { step_key: "search", findings },
      validation: {
        status: "invalid",
        findings,
        checked: ["L0", "L1"],
        unchecked: [],
      },
    });

    expect(
      candidates.filter((c) => c.trigger === "VALIDATION_FINDINGS"),
    ).toHaveLength(1);
  });

  it("reports `unavailable`, which is not a synonym for valid", () => {
    // Both gates fail open on it. How often that happens is a fact about our
    // own infrastructure that nothing else in the system records.
    const [candidate] = detectFromOutcome({
      outcome: "SENT",
      message: "sent",
      ack: "ACK",
      validation: {
        status: "unavailable",
        findings: [],
        checked: [],
        unchecked: [{ layer: "L0", reason: "the oracle timed out" }],
      },
    });

    expect(candidate?.trigger).toBe("VALIDATION_UNAVAILABLE");
    expect(candidate?.code).toBe("the oracle timed out");
  });
});

describe("detectFromError", () => {
  it.each(["unreachable", "uncertain"])(
    "reports a %s send failure with its cause chain",
    (delivery) => {
      const cause = Object.assign(new Error("socket hang up"), {
        code: "UND_ERR_SOCKET",
      });
      const error = new UpstreamError(
        "network-participant",
        "could not reach",
        {
          delivery,
          url: "https://np.example.com/select",
        },
      );
      (error as { cause?: unknown }).cause = cause;

      const candidate = detectFromError(error, { stepKey: "select" });

      expect(candidate?.trigger).toBe("SEND_FAILED");
      expect(candidate?.code).toBe(delivery);
      expect(candidate?.evidence.error_codes).toContain("UND_ERR_SOCKET");
    },
  );

  it.each([
    ["a validation error", new ValidationError("bad args")],
    ["a not-found", new NotFoundError("flow run", "nope")],
  ])("ignores %s — that is the model mis-calling a tool", (_label, error) => {
    // These are already an `isError` result the model can read and retry from.
    // Recording each one would drown the corpus in typos.
    expect(detectFromError(error)).toBeUndefined();
  });

  it("reports an unexpected throw as ours", () => {
    const candidate = detectFromError(
      new TypeError("cannot read x of undefined"),
    );

    expect(candidate?.trigger).toBe("INFRA_ERROR");
    expect(candidate?.code).toBe("TypeError");
  });
});

describe("detectFromEvent — every NACK code lands", () => {
  it.each(NACK_CODES)("opens an incident for %s", (code) => {
    const candidate = detectFromEvent(
      event({ kind: "INBOUND_NACK", nack_code: code, action: "on_select" }),
    );

    expect(candidate?.trigger).toBe("INBOUND_NACK");
    expect(candidate?.code).toBe(code);
    expect(candidate?.action).toBe("on_select");
  });

  it("treats an ATTENTION line as the refusal it describes", () => {
    const candidate = detectFromEvent(
      event({ kind: "ATTENTION", nack_code: "TRANSACTION_MISMATCH" }),
    );

    expect(candidate?.code).toBe("TRANSACTION_MISMATCH");
  });

  it("reports a restart as the give-up signal it is", () => {
    const candidate = detectFromEvent(event({ kind: "FLOW_RESTARTED" }));

    expect(candidate?.trigger).toBe("RUN_ABANDONED");
    expect(candidate?.code).toBe("flow_restart");
  });
});

describe("detectFromEvent — what it deliberately ignores", () => {
  it.each([
    "INBOUND_ACK",
    "OUTBOUND_SENT",
    "CHAIN_SENT",
    "TRANSACTION_BOUND",
    "FLOW_COMPLETE",
    "FORM_SUBMITTED",
    "EXPECTATION_REARMED",
  ] as const)("says nothing about %s", (kind) => {
    expect(detectFromEvent(event({ kind }))).toBeUndefined();
  });

  it("never opens an incident from its own ISSUE_OPEN line", () => {
    // The recursion guard, asserted at the detector as well as at the observer:
    // this service journals through the journal it observes.
    expect(detectFromEvent(event({ kind: "ISSUE_OPEN" }))).toBeUndefined();
  });

  it("skips CHAIN_PAUSED, whose outcome was already observed", () => {
    // `chainNext` re-enters `proceed`, so the BLOCKED that caused the pause has
    // been through `detectFromOutcome`. Detecting here too would double-count
    // it, and `occurrences` is the field that says how hard something was fought.
    expect(detectFromEvent(event({ kind: "CHAIN_PAUSED" }))).toBeUndefined();
  });

  it("skips an unattributable call unless the producer vouches for it", () => {
    // POSSIBLY_RELATED fans out to every session on a shared endpoint, so
    // opening one per session would write up to nine misleading reports about a
    // call that had nothing to do with them.
    expect(
      detectFromEvent(
        event({ kind: "POSSIBLY_RELATED", nack_code: "NO_EXPECTATION" }),
      ),
    ).toBeUndefined();

    expect(
      detectFromEvent(
        event({ kind: "POSSIBLY_RELATED", nack_code: "WRONG_ENDPOINT" }),
        { evidence: {} },
      )?.code,
    ).toBe("WRONG_ENDPOINT");
  });

  it("covers every SessionEventKind, so a new one cannot be forgotten", () => {
    // Adding a kind without deciding whether it is a failure is exactly the
    // silent gap this module exists to prevent. Every kind must be named in one
    // of the two lists above.
    const decided = new Set([
      "INBOUND_NACK",
      "ATTENTION",
      "FLOW_RESTARTED",
      "POSSIBLY_RELATED",
      "INBOUND_ACK",
      "OUTBOUND_SENT",
      "CHAIN_SENT",
      "CHAIN_PAUSED",
      "TRANSACTION_BOUND",
      "FLOW_COMPLETE",
      "FORM_SUBMITTED",
      "EXPECTATION_REARMED",
      "ISSUE_OPEN",
    ]);

    expect(
      SessionEventKind.options.filter((kind) => !decided.has(kind)),
    ).toEqual([]);
  });
});
