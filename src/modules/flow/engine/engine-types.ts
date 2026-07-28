/**
 * Types for the flow mapper, ported from the workbench's mock-playground
 * service (`src/types/{flow,cache,mapped-flow,mock-service}-types.ts`).
 *
 * ## Why these are plain interfaces and not zod
 *
 * Everything in `engine/` is a **near-verbatim port** kept deliberately
 * diffable against upstream, so that a fix landing there can be replayed here
 * by eye. Parsing and validation happen at the module boundary — `toEngineFlow`
 * on the way in, `flow.schema.ts` on the way out — and the engine itself stays
 * a set of pure functions over plain data.
 *
 * ## Why the transaction types are structural minimums
 *
 * The engine reads exactly two things off a transaction: which side the
 * participant under test is on, and the list of exchanges. Declaring only that
 * much means `record`'s richer `TransactionCache` satisfies it structurally,
 * with no import in either direction and nothing to keep in sync by hand.
 */

export type Owner = "BAP" | "BPP";

/**
 * Where a step has got to.
 *
 * `LISTENING` — the participant under test owns it; we arm an expectation and
 * wait. `RESPONDING` — ours to send. `INPUT-REQUIRED` — ours, but blocked on a
 * value only the caller can supply. `WAITING-SUBMISSION` — a form we host,
 * waiting for the counterparty to submit it. `PROCESSING` — ours, already
 * in flight. `WAITING` — not yet reached. `COMPLETE` — done.
 */
export type StepStatus =
  | "COMPLETE"
  | "LISTENING"
  | "RESPONDING"
  | "WAITING"
  | "INPUT-REQUIRED"
  | "PROCESSING"
  | "WAITING-SUBMISSION";

/**
 * Per-step concurrency guard.
 *
 * `WORKING` means a dispatch is in flight and a second one must not start;
 * `SUSPENDED` means the flow has been halted. An *absent* status reads as
 * `AVAILABLE`, which is also what an expired one reads as — deliberately, so a
 * crashed dispatch unblocks itself rather than wedging the flow forever.
 */
export type FlowStatusCode = "WORKING" | "AVAILABLE" | "SUSPENDED";

/** A field the caller must fill before a step can be produced. */
export interface StepInputField {
  name?: string;
  label?: string;
  type?: string;
  payloadField?: string;
  values?: string[];
  defaultValue?: string;
  input?: StepInputField[];
  schema?: Record<string, unknown>;
  reference?: string;
  [key: string]: unknown;
}

export type StepInputConfig = StepInputField[];

/** One step of a flow definition, as the config-service publishes it. */
export interface EngineSequenceStep {
  key: string;
  type: string;
  owner: Owner;
  unsolicited: boolean;
  pair: string | null;
  description?: string;
  stackable?: boolean;
  input?: StepInputConfig;
  expect?: boolean;
  label?: string;
  force_proceed?: boolean;
  repeat?: number;
  manual?: boolean;
}

export interface EngineFlow {
  id: string;
  title?: string;
  description?: string;
  sequence: EngineSequenceStep[];
  extraSequence?: EngineSequenceStep[];
}

/* -------------------------------------------------------------------------- */
/* Transaction history — the structural minimum the engine reads               */
/* -------------------------------------------------------------------------- */

export interface EngineApiEntry {
  entryType: "API";
  action: string;
  payloadId: string;
  messageId: string;
  response: unknown;
  timestamp: string;
}

export interface EngineFormEntry {
  entryType: "FORM";
  formType: "HTML_FORM" | "RES_FORM" | "DYNAMIC_FORM";
  formId: string;
  submissionId?: string | undefined;
  timestamp: string;
  error?: string | undefined;
}

export type EngineHistoryEntry = EngineApiEntry | EngineFormEntry;

export interface EngineTransaction {
  /**
   * The **participant under test's** side, not ours.
   *
   * This is the single most misread field in the whole engine. It comes
   * straight from the workbench, where a transaction belongs to the NP being
   * exercised; every `subscriberType === step.owner` comparison below therefore
   * means "the NP owns this step", i.e. *we* wait for it.
   */
  subscriberType: Owner;
  apiList: EngineHistoryEntry[];
}

/** Business data accumulated across a transaction, plus engine extensions. */
export interface EngineSessionData {
  /** Steps appended to the flow at runtime. */
  MORE_SEQUENCE?: EngineSequenceStep[];
  user_inputs?: Record<string, unknown>;
  [key: string]: unknown;
}

/* -------------------------------------------------------------------------- */
/* Reduced history — one entry per logical exchange                            */
/* -------------------------------------------------------------------------- */

export interface ReducedApiData {
  entryType: "API";
  action: string;
  messageId: string;
  timestamp: string;
  subStatus: "SUCCESS" | "ERROR";
  payloads: { payloadId: string; response: unknown }[];
}

export interface ReducedFormData {
  entryType: "FORM";
  formType: "HTML_FORM" | "RES_FORM" | "DYNAMIC_FORM";
  formId: string;
  submissionId?: string | undefined;
  timestamp: string;
  subStatus?: "SUCCESS" | "ERROR";
  error?: string | undefined;
}

export type ApiHistory = ReducedApiData | ReducedFormData;

/* -------------------------------------------------------------------------- */
/* The map itself                                                              */
/* -------------------------------------------------------------------------- */

export interface MappedStep {
  status: StepStatus;
  actionId: string;
  owner: Owner;
  actionType: string;
  input?: StepInputConfig | undefined;
  payloads?: ApiHistory | undefined;
  index: number;
  description?: string | undefined;
  unsolicited: boolean;
  pairActionId: string | null;
  expect?: boolean | undefined;
  missedStep?: boolean;
  label?: string | undefined;
  force_proceed?: boolean | undefined;
  repeat?: number | undefined;
  manual?: boolean | undefined;
  isExtraStep?: boolean;
  /** For an extras placeholder: the message_id its response must echo. */
  awaitingMessageId?: string;
}

export interface FlowMap {
  sequence: MappedStep[];
  missedSteps: MappedStep[];
  extraSteps?: MappedStep[];
  reference_data?: Record<string, unknown>;
}
