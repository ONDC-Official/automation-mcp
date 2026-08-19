import { z } from "zod";
import { EventsField } from "@/modules/record/record.schema.js";
import { ValidationFinding } from "@/modules/validate/validate.schema.js";

/**
 * The vocabulary of the incident corpus.
 *
 * Two shapes, and the distinction between them is the whole design:
 *
 * - **`Incident`** is internal. It lives in the state store, it is keyed by a
 *   dedupe signature, and it holds *pointers* — a session, a run, a step, a seq
 *   — rather than a snapshot. Everything rich is read back from the durable
 *   transaction record at flush time, which is what lets a report describe the
 *   *recovery* and not only the failure.
 * - **`IssueReport`** is what leaves the machine. It is assembled from an
 *   `Incident` plus that record, and every value in it has been through
 *   `feedback.redact.ts` first.
 *
 * The one exception to "pointers, not snapshots" is `Incident.evidence`: the
 * mock-runner's logs and stack, the derived sequence map, the cause chain of a
 * send failure. Those are not durable anywhere — they exist for the length of
 * one call and are otherwise `logger.debug`'d away — so they are captured at
 * `note()` time. They are redacted *before* they are stored, never at flush,
 * because unredacted personal data should not sit in the store at all.
 */

/* -------------------------------------------------------------------------- */
/* Triggers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What opened the incident.
 *
 * These are families, not codes. The specific code — the `blocked()` reason, the
 * NACK code, the primary finding — goes in `Incident.code`, so a query can ask
 * either "how often does generation fail" (trigger) or "how often does
 * `VEHICLE_CATEGORY_REQUIRED` fail" (code).
 *
 * | Trigger                  | Opened by                                                     |
 * | ------------------------ | ------------------------------------------------------------- |
 * | `BLOCKED`                | any `BLOCKED` outcome — the 11 `blocked()` reasons            |
 * | `INBOUND_NACK`           | any NACK the receiver emits                                   |
 * | `OUTBOUND_NACK`          | the participant NACKed something we sent                       |
 * | `SEND_FAILED`            | `UpstreamError` from the sender, chained or direct            |
 * | `VALIDATION_FINDINGS`    | a verdict with findings, in `advisory` as well as `enforce`   |
 * | `VALIDATION_UNAVAILABLE` | no verdict was reached and both gates failed open             |
 * | `CONFIG_DEFECT`          | the flow's own config did something it should not             |
 * | `AWAIT_TIMEOUT`          | a bounded wait lapsed with the run still on the same step     |
 * | `RUN_ABANDONED`          | `flow_restart` — the loudest "could not fix it" in the system |
 * | `INFRA_ERROR`            | one of ours: a store blip, a check that threw, a sweep that failed |
 */
export const TriggerKind = z.enum([
  "BLOCKED",
  "INBOUND_NACK",
  "OUTBOUND_NACK",
  "SEND_FAILED",
  "VALIDATION_FINDINGS",
  "VALIDATION_UNAVAILABLE",
  "CONFIG_DEFECT",
  "AWAIT_TIMEOUT",
  "RUN_ABANDONED",
  "INFRA_ERROR",
]);
export type TriggerKind = z.infer<typeof TriggerKind>;

/**
 * Where the incident ended up — **derived, never claimed**.
 *
 * A model asked whether it fixed something will say yes. The run either advanced
 * past the step or it did not, and that is a fact the engine already computes.
 * `Narration.outcome` records what the model *believed*; where the two disagree,
 * the disagreement is itself worth having.
 */
export const IncidentState = z.enum([
  /** Still on the step. Nothing has resolved it yet. */
  "OPEN",
  /** The run later advanced past `step_key`. */
  "RECOVERED",
  /**
   * The run advanced past `step_key`, but only with `payload_overrides`.
   *
   * A different row in the corpus from `RECOVERED`, and deliberately so: "the
   * model worked around a defect in a **published config**" and "the model
   * fixed its own mistake" are opposite findings. Collapsing them would make
   * the most valuable column mean less, and would hide the thing that is
   * actually actionable — an upstream config someone else has to repair.
   */
  "RECOVERED_WITH_OVERRIDE",
  /** `flow_restart`, or the flow finished with this step still not done. */
  "ABANDONED",
  /** The session ended, or was disposed, with the run still parked. */
  "UNRESOLVED",
]);
export type IncidentState = z.infer<typeof IncidentState>;

/* -------------------------------------------------------------------------- */
/* Evidence                                                                    */
/* -------------------------------------------------------------------------- */

/** Cap on retained mock-runner log lines. Enough to see a throw in context. */
export const RUNNER_LOG_LIMIT = 40;
/** Cap on any single retained string, after scrubbing. */
export const EVIDENCE_STRING_LIMIT = 2_000;
/** Cap on retained journal lines per report. */
export const REPORT_JOURNAL_LIMIT = 40;
/** Cap on retained findings per report. */
export const REPORT_FINDING_LIMIT = 20;

/**
 * The diagnostic detail that exists nowhere else.
 *
 * Every field here was, before this module, either `logger.debug`'d or discarded
 * outright — see FEEDBACK-PLAN.md's "Evidence the code already has and currently
 * discards". All of it is bounded, and all of it is redacted before it is
 * stored.
 */
export const IncidentEvidence = z.object({
  message: z
    .string()
    .optional()
    .describe("The failure in the producer's own words, scrubbed."),
  runner_logs: z
    .array(z.string())
    .optional()
    .describe(
      "`console` output from the flow's own sandboxed generate/validate. " +
        "Collected by the mock engine and, until now, never surfaced.",
    ),
  runner_stack: z
    .string()
    .optional()
    .describe(
      "Stack from the sandbox, with absolute paths outside the repo stripped.",
    ),
  sequence: z
    .object({
      expected_action: z.string().optional(),
      expected_step_key: z.string().optional(),
      received_action: z.string().optional(),
      missed_steps: z.array(z.string()).optional(),
    })
    .optional()
    .describe(
      "The derived map at the moment of an OUT_OF_SEQUENCE. In scope at the " +
        "NACK site today; only `action` ever reached the wire.",
    ),
  delivery: z
    .string()
    .optional()
    .describe(
      "`unreachable` or `uncertain`, from the sender's classification.",
    ),
  error_codes: z
    .array(z.string())
    .optional()
    .describe(
      "The underlying `code` chain (`ECONNRESET`, `UND_ERR_HEADERS_TIMEOUT`). " +
        "`UpstreamError` keeps only the message, so timeout and reset are " +
        "otherwise indistinguishable after the fact.",
    ),
  http_status: z.number().int().optional(),
  ack: z.string().optional().describe("ACK / NACK / UNPARSEABLE."),
  findings: z
    .array(ValidationFinding)
    .optional()
    .describe(
      "Full findings, not the `summariseFindings()` prose the wire carries. " +
        "Messages are scrubbed; layer, code and json_path are kept verbatim.",
    ),
  unchecked: z
    .array(z.object({ layer: z.string(), reason: z.string() }))
    .optional()
    .describe("Why a layer produced no verdict — the `unavailable` detail."),
  payload_shape: z
    .unknown()
    .optional()
    .describe(
      "The payload with every leaf value replaced by a type token. Key names, " +
        "types and array lengths survive; no value does, outside the allowlist.",
    ),
});
export type IncidentEvidence = z.infer<typeof IncidentEvidence>;

/* -------------------------------------------------------------------------- */
/* Narration — the model's half                                                */
/* -------------------------------------------------------------------------- */

export const NarrationOutcome = z.enum(["fixed", "worked_around", "gave_up"]);
export type NarrationOutcome = z.infer<typeof NarrationOutcome>;

export const SuspectedCause = z.enum([
  "our_tooling",
  "flow_config",
  "participant",
  "unknown",
]);
export type SuspectedCause = z.infer<typeof SuspectedCause>;

export const Narration = z.object({
  diagnosis: z
    .string()
    .min(1)
    .describe("What you concluded was actually wrong."),
  attempted: z
    .array(z.string())
    .describe(
      "What you tried, in order, including the things that did not work.",
    ),
  outcome: NarrationOutcome.describe("Whether you got past it."),
  suspected_cause: SuspectedCause.describe("Whose defect you think this is."),
  tooling_gap: z
    .string()
    .optional()
    .describe(
      "What would have let you resolve this faster — a tool that does not " +
        "exist, a field a result should carry, a message that misled you.",
    ),
  at: z.string().describe("When it was submitted, ISO 8601."),
});
export type Narration = z.infer<typeof Narration>;

/* -------------------------------------------------------------------------- */
/* The incident                                                                */
/* -------------------------------------------------------------------------- */

export const Incident = z.object({
  id: z.string(),
  session_id: z.string(),
  flow_id: z.string(),
  attempt: z.number().int(),
  transaction_id: z.string().optional(),

  trigger: TriggerKind,
  code: z
    .string()
    .describe(
      "The blocked() reason, the NACK code, or the primary finding code.",
    ),
  step_key: z.string().optional(),
  action: z.string().optional(),

  /**
   * The dedupe key: `{trigger}::{step_key}::{code}`. Three retries of the same
   * wrong guess are one incident with `occurrences: 3`, not three reports.
   */
  signature: z.string(),
  occurrences: z.number().int().positive(),
  first_seen_at: z.string(),
  last_seen_at: z.string(),

  state: IncidentState,
  resolved_at: z.string().optional(),
  /**
   * The session journal seq when this opened. Names the slice of history the
   * report attaches, so the corpus sees what led in rather than the whole run.
   */
  journal_from: z.number().int(),

  evidence: IncidentEvidence,
  narration: Narration.optional(),
  /** Set once the report has been handed to the sink, so it ships exactly once. */
  flushed_at: z.string().optional(),
});
export type Incident = z.infer<typeof Incident>;

/* -------------------------------------------------------------------------- */
/* The report — what actually leaves                                           */
/* -------------------------------------------------------------------------- */

/**
 * Bumped when a field changes meaning, not when one is added. The ingest has to
 * be able to read a spool file written by a version it has never seen.
 */
export const REPORT_SCHEMA_VERSION = 1;

/**
 * Clear identifiers, present only under `TELEMETRY_CORRELATION`.
 *
 * ## Why this is a nested object rather than two flat fields
 *
 * **The flag's entire blast radius has to be one key.** Nested, the difference
 * between a flag-off report and a flag-on one is exactly `correlation` — which
 * a test can state as `const {correlation, ...rest} = on; expect(rest).toEqual(off)`
 * and have the assertion fail the moment the flag starts touching anything
 * else. Two flat fields cannot express that: the test would have to list what
 * it expects to differ, which is the same as trusting the reader to have
 * noticed.
 *
 * ## What it is not
 *
 * It is not a redaction bypass. `feedback.redact.ts` never sees this flag, does
 * not import `@/config/env.js`, and is byte-unchanged by its introduction. A
 * `transaction_id` inside `evidence.payload_shape` is still pseudonymised, and
 * one quoted inside a journal summary still goes through `scrubProse`. The
 * report therefore carries both a pseudonym and a clear id for the same
 * transaction, which is the intended result: the pseudonym exists to keep the
 * **participant** unlinkable and the corpus internally consistent, not to
 * protect a UUID this server minted.
 *
 * `flow_id` and `attempt` are already in the clear on `IssueReport` — a flow id
 * is a public catalog coordinate — and are deliberately **not** duplicated
 * here.
 */
export const Correlation = z.object({
  session_id: z.string(),
  transaction_id: z.string().optional(),
});
export type Correlation = z.infer<typeof Correlation>;

export const IssueReport = z.object({
  schema_version: z.literal(REPORT_SCHEMA_VERSION),
  report_id: z.string(),
  generated_at: z.string(),
  /**
   * A stable pseudonym for this installation, derived from the local salt.
   * Groups one operator's reports together without naming them.
   */
  install_id: z.string(),

  build: z
    .object({
      domain: z.string(),
      version: z.string(),
      usecase: z.string().optional(),
    })
    .describe(
      "Public catalog coordinates. Kept verbatim — this is the signal.",
    ),
  mock_role: z.string().describe("Which side this server played."),

  flow_id: z.string(),
  attempt: z.number().int(),

  incident: z.object({
    trigger: TriggerKind,
    code: z.string(),
    step_key: z.string().optional(),
    action: z.string().optional(),
    occurrences: z.number().int(),
    state: IncidentState,
    /** Wall time from first sighting to resolution, when it resolved. */
    duration_ms: z.number().int().optional(),
  }),

  evidence: IncidentEvidence,

  journal: z
    .array(
      z.object({
        seq: z.number().int(),
        kind: z.string(),
        action: z.string().optional(),
        ack: z.string().optional(),
        nack_code: z.string().optional(),
        summary: z.string(),
      }),
    )
    .describe("The run's history around the incident, summaries scrubbed."),

  /** `null`, not absent, when the model never answered. The distinction matters. */
  narration: Narration.nullable(),

  /**
   * Clear ids, **only** under `TELEMETRY_CORRELATION`. Absent otherwise.
   *
   * A pure addition, so `REPORT_SCHEMA_VERSION` is deliberately **not** bumped:
   * the version says "a field changed meaning", and the ingest has to be able
   * to read a spool file written by a version it has never seen. Forcing the
   * consumer to special-case a new version for a key it can ignore breaks that
   * contract from the other direction.
   */
  correlation: Correlation.optional(),
});
export type IssueReport = z.infer<typeof IssueReport>;

/* -------------------------------------------------------------------------- */
/* Tool IO                                                                     */
/* -------------------------------------------------------------------------- */

export const SubmitReportInput = z.object({
  session_id: z.string().min(1),
  incident_id: z
    .string()
    .min(1)
    .describe("From the ISSUE_OPEN event, or from feedback_list_reports."),
  diagnosis: z
    .string()
    .min(1)
    .describe("What you concluded was actually wrong."),
  attempted: z
    .array(z.string())
    .default([])
    .describe("What you tried, in order, including what did not work."),
  outcome: NarrationOutcome,
  suspected_cause: SuspectedCause,
  tooling_gap: z
    .string()
    .optional()
    .describe("What would have let you resolve this faster."),
});
export type SubmitReportInput = z.infer<typeof SubmitReportInput>;

export const SubmitReportOutput = z.object({
  incident_id: z.string(),
  state: IncidentState.describe(
    "The **derived** state. If it disagrees with your `outcome`, the report " +
      "keeps both — that disagreement is itself a finding.",
  ),
  accepted: z.boolean(),
  message: z.string(),
  ...EventsField,
});
export type SubmitReportOutput = z.infer<typeof SubmitReportOutput>;

export const ListReportsInput = z.object({
  session_id: z.string().min(1),
  include_body: z
    .boolean()
    .default(false)
    .describe(
      "Render each incident as the fully-redacted report that would be " +
        "uploaded. This is how you answer 'what are you sending about me?'.",
    ),
  limit: z.number().int().positive().max(50).default(20),
});
export type ListReportsInput = z.infer<typeof ListReportsInput>;

export const ListReportsOutput = z.object({
  incidents: z.array(
    z.object({
      incident_id: z.string(),
      trigger: TriggerKind,
      code: z.string(),
      step_key: z.string().optional(),
      flow_id: z.string(),
      state: IncidentState,
      occurrences: z.number().int(),
      narrated: z.boolean(),
      first_seen_at: z.string(),
      report: IssueReport.optional().describe(
        "Present when include_body was set.",
      ),
    }),
  ),
  sharing: z
    .string()
    .describe(
      "Where these go, in one sentence, so it can be repeated to the user.",
    ),
  ...EventsField,
});
export type ListReportsOutput = z.infer<typeof ListReportsOutput>;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** The dedupe key. Stable across retries of the same failure, by construction. */
export function signatureOf(
  trigger: TriggerKind,
  stepKey: string | undefined,
  code: string,
): string {
  return `${trigger}::${stepKey ?? "-"}::${code}`;
}

/** Whether an incident has reached a state that should be reported and closed. */
export function isTerminal(state: IncidentState): boolean {
  return state !== "OPEN";
}

/**
 * Whether the run got past this — by any means.
 *
 * Named once because the two recoveries must stay distinguishable in the corpus
 * and interchangeable in the control flow. Anywhere that asks "did this
 * resolve?" wants both; only the report wants to know which.
 */
export function isRecovered(state: IncidentState): boolean {
  return state === "RECOVERED" || state === "RECOVERED_WITH_OVERRIDE";
}
