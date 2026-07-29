import { z } from "zod";
import { NpType, StepActor } from "@/modules/catalog/catalog.schema.js";
import { ValidationVerdict } from "@/modules/validate/validate.schema.js";
import {
  AckStatus,
  EventsField,
  SessionEventKind,
} from "@/modules/record/record.schema.js";

/**
 * The loop's vocabulary.
 *
 * Everything here is written for a model to read and act on, which shapes two
 * decisions:
 *
 * 1. **`StepOutcome` is a tagged union, not a bag of optionals.** Every call to
 *    `flow_proceed` ends in exactly one of seven states, and the tag says which
 *    tool to reach for next. A shape where any field might be present makes the
 *    model guess.
 * 2. **`snake_case` throughout**, matching the ONDC vocabulary already visible
 *    in payloads, so the model reads one language rather than two.
 *
 * Output schemas stay plain (object/array/string/enum/optional) because they
 * are converted to JSON Schema for the wire.
 */

/** Where a step has got to, as the model sees it. */
export const StepStatus = z.enum([
  "COMPLETE",
  "LISTENING",
  "RESPONDING",
  "WAITING",
  "INPUT-REQUIRED",
  "PROCESSING",
  "WAITING-SUBMISSION",
]);
export type StepStatus = z.infer<typeof StepStatus>;

export const FlowStatus = z.enum([
  "IN_PROGRESS",
  "COMPLETE",
  "BLOCKED",
  "NOT_STARTED",
]);
export type FlowStatus = z.infer<typeof FlowStatus>;

/** One step of the derived map. */
export const FlowStepState = z.object({
  key: z.string().describe("Step key, unique within the flow."),
  action: z
    .string()
    .describe("Protocol action (search, on_search) or form type (HTML_FORM)."),
  owner: NpType.describe("BAP or BPP, per the flow definition."),
  actor: StepActor.describe(
    "'mock' if this server must produce the step, 'np' if the participant must.",
  ),
  status: StepStatus,
  index: z.number().int().describe("Position in the sequence; -1 for extras."),
  description: z.string().optional(),
  label: z.string().optional(),
  unsolicited: z.boolean(),
  pair: z
    .string()
    .nullable()
    .describe("Key of the step that answers this one, when paired."),
  payload_ids: z
    .array(z.string())
    .describe("Handles for the payloads recorded against this step."),
  ack: AckStatus.optional().describe(
    "How the counterparty answered, for a completed step.",
  ),
  inputs_required: z
    .array(z.unknown())
    .optional()
    .describe("Input declarations that must be supplied before this can go."),
  awaiting_message_id: z
    .string()
    .optional()
    .describe("For an extras placeholder: the message_id its reply must echo."),
});
export type FlowStepState = z.infer<typeof FlowStepState>;

/* -------------------------------------------------------------------------- */
/* FlowBinding — one flow run, and the id it eventually acquires                */
/* -------------------------------------------------------------------------- */

/**
 * One attempt of a run, written off by `flow_restart`.
 *
 * Kept on the binding rather than only on the transaction because an attempt
 * that never bound has no transaction to be kept on — and a run abandoned
 * before its first action still happened, from the caller's point of view.
 */
export const AbandonedAttempt = z.object({
  attempt: z.number().int(),
  /** Absent when nothing ever crossed the wire, so no id was ever minted. */
  transactionId: z.string().optional(),
  startedAt: z.string(),
  abandonedAt: z.string(),
  reason: z.string().optional(),
});
export type AbandonedAttempt = z.infer<typeof AbandonedAttempt>;

/**
 * One run of one flow inside one session, and the `transaction_id` it is bound
 * to once one exists.
 *
 * ## Why a flow run is not just its transaction
 *
 * In ONDC the `transaction_id` belongs to **whoever sends the flow's first
 * action**. When that is the participant — a mock BPP waiting for `search` —
 * the id is theirs to choose and we do not learn it until their call lands.
 * Minting one up front and filing a record under it produces an id that was
 * never on the wire: the participant's call opens a *second* record under
 * *their* id, and the one the caller is holding is dead.
 *
 * So a run starts **unbound**. `transactionId` is absent until the first
 * payload crosses the wire in either direction, and `(session_id, flow_id)` is
 * what the caller holds in the meantime. This is our port of the workbench's
 * `session.flowMap[flowId]`, which its own UI polls for exactly this reason
 * rather than remembering the uuid it generated.
 *
 * `autoAdvance` lives here because a `flow_start` override has to survive the
 * gap between starting the run and the first dispatch — there is no transaction
 * record to carry it yet.
 *
 * ## A run may span several attempts
 *
 * `flow_restart` abandons the current attempt and returns the run to the
 * unbound state, so `(session_id, flow_id)` names the *run* while
 * `transaction_id` names one attempt of it. `attempt` and `previousAttempts`
 * are what keep the two distinguishable: without them a restarted run looks
 * exactly like one that never started, and a compliance report could not say
 * which transaction was the third try.
 */
export const FlowBinding = z.object({
  sessionId: z.string(),
  flowId: z.string(),
  autoAdvance: z.boolean().default(false),
  /** Absent until the flow's first action crosses the wire. */
  transactionId: z.string().optional(),
  startedAt: z.string(),
  /** 1-based, and only advanced by a restart that had something to abandon. */
  attempt: z.number().int().default(1),
  /** Newest last, capped — see `ATTEMPT_HISTORY_LIMIT`. */
  previousAttempts: z.array(AbandonedAttempt).default([]),
});
export type FlowBinding = z.infer<typeof FlowBinding>;

/**
 * How many abandoned attempts a binding carries.
 *
 * A binding is read on every `flow_proceed` and every inbound callback, so it
 * cannot be allowed to grow without bound — a model in a restart loop would
 * otherwise widen the hottest read in the server. The oldest entries are
 * dropped; `attempt` keeps counting truthfully, so the number of tries is never
 * lost even when the early ones are.
 */
export const ATTEMPT_HISTORY_LIMIT = 20;

/** An exchange that did not fit where the flow was — a compliance finding. */
export const MissedStep = z.object({
  action: z.string(),
  owner: NpType,
  reason: z
    .string()
    .describe("Why it did not fit: out of order, unknown, or past the end."),
  expected_at_index: z.number().int(),
  payload_ids: z.array(z.string()),
});
export type MissedStep = z.infer<typeof MissedStep>;

/* -------------------------------------------------------------------------- */
/* StepOutcome — what one turn of the loop produced                            */
/* -------------------------------------------------------------------------- */

/**
 * How a turn of the loop ended, and what each ending asks of the model.
 *
 * | `outcome`         | What happened                          | What to do next |
 * |-------------------|----------------------------------------|-----------------|
 * | `SENT`            | payload generated and POSTed           | `flow_await` for the reply |
 * | `DRAFTED`         | dry run — generated, not sent          | inspect, then re-run without `dry_run` |
 * | `READY`           | a step is ours and needs nothing       | `flow_proceed` |
 * | `INPUT_REQUIRED`  | the step needs values                  | call again with `inputs` |
 * | `FORM_PENDING`    | a form stands between here and there   | `form_fetch` / `form_submit`, or wait |
 * | `WAITING`         | the participant's move                 | `flow_await` |
 * | `COMPLETE`        | the flow is finished                   | `report_generate` |
 * | `BLOCKED`         | preconditions unmet, or an error       | read `details`, fix, retry |
 *
 * `READY` only ever comes back from the *describing* calls — `flow_get_status`
 * and `flow_await` — which report what the loop needs without doing it.
 * `flow_proceed` would have dispatched it, so it never answers `READY`.
 */
export const OutcomeKind = z.enum([
  "SENT",
  "DRAFTED",
  "READY",
  "INPUT_REQUIRED",
  "FORM_PENDING",
  "WAITING",
  "COMPLETE",
  "BLOCKED",
]);
export type OutcomeKind = z.infer<typeof OutcomeKind>;

export const StepOutcome = z.object({
  outcome: OutcomeKind,
  /** Human-facing sentence. Always present; the tag carries the meaning. */
  message: z.string(),
  step_key: z.string().optional().describe("The step this outcome is about."),
  action: z.string().optional().describe("Its protocol action or form type."),
  transaction_id: z
    .string()
    .optional()
    .describe(
      "This flow run's transaction id. Absent until the flow's first action " +
        "crosses the wire — it belongs to whoever sends that action, so when " +
        "the participant moves first it is theirs to choose and unknowable " +
        "until their call lands. Address the run by flow_id until then.",
    ),

  /* SENT / DRAFTED */
  payload_id: z
    .string()
    .optional()
    .describe(
      "Handle for the payload produced. Read it with record_get_payload.",
    ),
  ack: AckStatus.optional().describe(
    "How the participant answered a SENT step.",
  ),
  http_status: z.number().int().optional(),
  ack_body: z
    .unknown()
    .optional()
    .describe("The participant's synchronous response, verbatim."),

  /* INPUT_REQUIRED */
  inputs_required: z
    .array(z.unknown())
    .optional()
    .describe(
      "What the step declares it needs. Pass values back as flow_proceed's `inputs`.",
    ),

  /* FORM_PENDING */
  form_role: z
    .enum(["fill", "host"])
    .optional()
    .describe(
      "'fill' — the participant hosts the form and this mock must submit it. " +
        "'host' — this mock serves the form and the participant must submit it.",
    ),
  form_url: z
    .string()
    .optional()
    .describe("Where the form lives, for whichever side has to open it."),

  /* WAITING */
  expected_action: z
    .string()
    .optional()
    .describe("The action now expected from the participant."),

  /* BLOCKED */
  reason: z.string().optional().describe("Machine-readable cause of a block."),
  details: z
    .unknown()
    .optional()
    .describe("Everything known about the block — requirement codes, errors."),

  /* Any outcome that generated a payload */
  validation: ValidationVerdict.optional().describe(
    "How the generated payload judged against the spec. Present whenever a " +
      "payload was produced, including one that was blocked or drafted rather " +
      "than sent. `status: \"unavailable\"` means it went unchecked — the " +
      "payload was still sent, because refusing to act on our own outage " +
      "would strand the run.",
  ),
});
export type StepOutcome = z.infer<typeof StepOutcome>;

/* -------------------------------------------------------------------------- */
/* Tool input / output                                                         */
/* -------------------------------------------------------------------------- */

export const StartFlowInput = z.object({
  session_id: z.string().min(1).describe("Session returned by session_create."),
  flow_id: z
    .string()
    .min(1)
    .describe("Flow to run, as listed by catalog_list_flows."),
  transaction_id: z
    .string()
    .optional()
    .describe(
      "Resume a transaction that already exists. Omit it — a new run does not " +
        "have an id yet, and inventing one here would be wrong whenever the " +
        "participant sends the flow's first action, because then the id is " +
        "theirs to choose.",
    ),
  auto_advance: z
    .boolean()
    .optional()
    .describe(
      "Override the session default. When on, the receiver chains this mock's " +
        "own steps as soon as the participant answers, pausing only for inputs, " +
        "forms and errors.",
    ),
});
export type StartFlowInput = z.infer<typeof StartFlowInput>;

export const StartFlowOutput = z.object({
  session_id: z.string(),
  transaction_id: z
    .string()
    .nullable()
    .describe(
      "Null for a new run: the transaction id belongs to whoever sends the " +
        "flow's first action, so it does not exist until that action crosses " +
        "the wire. Drive the run with flow_id until then; every loop answer " +
        "reports the id once it is known.",
    ),
  flow_id: z
    .string()
    .describe("Address this run by (session_id, flow_id) from here on."),
  mock_role: NpType.describe("The role this server plays in this flow."),
  callback_url: z
    .string()
    .describe(
      "What the participant must call back on. Advertised as bap_uri/bpp_uri " +
        "in every payload this mock sends.",
    ),
  auto_advance: z.boolean(),
  attempt: z
    .number()
    .int()
    .describe(
      "Which try this is. 1 unless the run has been restarted; every attempt " +
        "gets its own transaction_id.",
    ),
  outcome: StepOutcome.describe("What the first step of the flow needs."),
  ...EventsField,
});
export type StartFlowOutput = z.infer<typeof StartFlowOutput>;

/* -------------------------------------------------------------------------- */
/* flow_restart                                                                */
/* -------------------------------------------------------------------------- */

export const RestartFlowInput = z.object({
  session_id: z.string().min(1).describe("Session returned by session_create."),
  flow_id: z
    .string()
    .min(1)
    .describe(
      "The flow to restart. Named by flow, never by transaction: the run is " +
        "what is being restarted, and it may not have a transaction id yet.",
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "Why this attempt is being abandoned. Recorded against it, and worth " +
        "supplying — it is what the compliance report can say about the retry.",
    ),
});
export type RestartFlowInput = z.infer<typeof RestartFlowInput>;

export const RestartFlowOutput = StartFlowOutput.extend({
  abandoned_transaction_id: z
    .string()
    .nullable()
    .describe(
      "The transaction the abandoned attempt was running, or null when it " +
        "never sent anything. Its payloads stay readable with " +
        "record_get_payload — restarting destroys no evidence.",
    ),
});
export type RestartFlowOutput = z.infer<typeof RestartFlowOutput>;

/**
 * How the loop tools name a run.
 *
 * `flow_id` is the durable handle — it works before the transaction exists and
 * after, which `transaction_id` cannot. `transaction_id` stays supported
 * because it is the only way to name one specific run when a session has
 * several, and the only way back into a transaction started elsewhere.
 */
const FlowRefFields = {
  session_id: z.string().min(1).describe("Session returned by session_create."),
  flow_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The flow started with flow_start. Works before the transaction id " +
        "exists, so prefer it.",
    ),
  transaction_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "A specific transaction. Only known once the flow's first action has " +
        "crossed the wire.",
    ),
} as const;

export const FlowStatusInput = z.object(FlowRefFields);
export type FlowStatusInput = z.infer<typeof FlowStatusInput>;

export const FlowStatusOutput = z.object({
  transaction_id: z
    .string()
    .nullable()
    .describe("Null while the flow's first action has not yet crossed."),
  flow_id: z.string(),
  flow_status: FlowStatus,
  mock_role: NpType,
  attempt: z
    .number()
    .int()
    .describe("Which try of this flow the run is on. 1 unless restarted."),
  abandoned: z
    .object({
      at: z.string(),
      attempt: z.number().int(),
      reason: z.string().optional(),
    })
    .optional()
    .describe(
      "Set when reading an attempt that flow_restart wrote off. Its record is " +
        "kept as evidence but it cannot be advanced; the run has moved on.",
    ),
  seq: z
    .number()
    .int()
    .describe("Latest event number. Pass it to flow_await as after_seq."),
  sequence: z.array(FlowStepState).describe("The main sequence, in order."),
  extra_steps: z
    .array(FlowStepState)
    .describe("Side-channel steps — unsolicited updates and their replies."),
  missed_steps: z
    .array(MissedStep)
    .describe("Exchanges that did not fit the flow. Compliance findings."),
  next: StepOutcome.describe("What the loop needs next, without doing it."),
  reference_data_keys: z
    .array(z.string())
    .describe("Form steps with a resolved artefact waiting in business data."),
  attention: z
    .object({
      kind: z.string(),
      message: z.string(),
      step_key: z.string().optional(),
      at: z.string(),
    })
    .optional()
    .describe("Why auto-advance stopped, if it did."),
  ...EventsField,
});
export type FlowStatusOutput = z.infer<typeof FlowStatusOutput>;

export const ProceedInput = z.object({
  ...FlowRefFields,
  inputs: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Values for a step reported as INPUT_REQUIRED. For a manual step pass " +
        "{id: '<step_key>'} — naming it is what triggers it.",
    ),
  trigger_extra: z
    .string()
    .optional()
    .describe(
      "Fire a named side-channel step from the flow's extra sequence instead " +
        "of advancing the main sequence. Only steps this mock owns can be fired.",
    ),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "Generate and record the payload but do not send it, so it can be " +
        "inspected first. Nothing reaches the participant.",
    ),
});
export type ProceedInput = z.infer<typeof ProceedInput>;

/**
 * `StepOutcome` plus the session's backlog.
 *
 * Extended rather than added to `StepOutcome` itself, because that type is also
 * nested inside `flow_start`'s and `flow_await`'s answers — and a delta
 * attached to a nested outcome would either duplicate the one at top level or,
 * worse, consume it there instead.
 */
export const ProceedOutput = StepOutcome.extend(EventsField);
export type ProceedOutput = z.infer<typeof ProceedOutput>;

export const AwaitInput = z.object({
  ...FlowRefFields,
  after_seq: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Run scope only. Only report events newer than this — use the `seq` from " +
        "the last flow_get_status or flow_await so nothing is seen twice. " +
        "Ignored in session scope, which tracks delivery for you.",
    ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("How long to block. Capped server-side; defaults to the cap."),
  kinds: z
    .array(SessionEventKind)
    .optional()
    .describe(
      "Session scope only. Wake only for these kinds. Everything else that " +
        "happens is still reported in `events` — it just does not end the " +
        "wait, so nothing is ever lost by filtering.",
    ),
  flow_ids: z
    .array(z.string())
    .optional()
    .describe(
      "Session scope only. Wake only for these flows. Same rule as `kinds`: " +
        "other flows' events are delivered, they just do not end the wait.",
    ),
});
export type AwaitInput = z.infer<typeof AwaitInput>;

/**
 * Where one run stands, in a line.
 *
 * A session-scope wait cannot answer with a single `next` — that names one run,
 * and the caller deliberately asked about all of them. This is the substitute:
 * enough per run to decide which one to go and drive.
 */
export const RunSummary = z.object({
  flow_id: z.string(),
  transaction_id: z
    .string()
    .nullable()
    .describe("Null while the run's first action has not crossed the wire."),
  attempt: z.number().int(),
  outcome: OutcomeKind.describe("What this run needs, as flow_proceed would."),
  message: z.string(),
});
export type RunSummary = z.infer<typeof RunSummary>;

export const AwaitOutput = z.object({
  timed_out: z
    .boolean()
    .describe("True when nothing arrived. Call again to keep waiting."),
  scope: z
    .enum(["run", "session"])
    .describe(
      "'run' — you named a flow or transaction, and this reports that one. " +
        "'session' — you named neither, and this reports the whole session.",
    ),
  transaction_id: z
    .string()
    .nullable()
    .describe(
      "The run's transaction id. When the participant sent the flow's first " +
        "action, this wait is where you learn it — it was theirs to choose. " +
        "Always null in session scope, which names no single run.",
    ),
  seq: z
    .number()
    .int()
    .describe(
      "Run scope: the run's latest event number, to pass back as after_seq. " +
        "Session scope: the journal seq delivered through, which is tracked " +
        "for you and needs passing nowhere.",
    ),
  event: z
    .object({
      seq: z.number().int(),
      kind: z.string().describe("INBOUND, OUTBOUND, FORM_SUBMITTED, CHAIN_*."),
      action: z.string().optional(),
      payload_id: z.string().optional(),
      detail: z.string().optional(),
    })
    .optional(),
  next: StepOutcome.optional().describe(
    "What the loop needs now the wait is over. Run scope only — a session " +
      "wait covers several runs, so it answers with `runs` instead.",
  ),
  runs: z
    .array(RunSummary)
    .optional()
    .describe(
      "Session scope only: where every run in this session stands, so you " +
        "can pick which to drive next.",
    ),
  ...EventsField,
});
export type AwaitOutput = z.infer<typeof AwaitOutput>;
