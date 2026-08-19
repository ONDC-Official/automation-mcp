import { z } from "zod";
import { Correlation } from "@/modules/feedback/feedback.schema.js";
import { AckStatus, SessionEventKind } from "@/modules/record/record.schema.js";

/**
 * What a live mirror record looks like on the wire.
 *
 * The mirror answers a different question from the incident corpus, for a
 * different audience, and the two must not be conflated:
 *
 * | | `feedback` | `mirror` |
 * | --- | --- | --- |
 * | Question | "what went wrong, and did the model fix it?" | "what is this mock doing, right now?" |
 * | Shape | one document per incident, at the end | a stream of small records, as they happen |
 * | Audience | whoever improves this tool surface | a sibling service showing a live view |
 *
 * It is **invisible to the model**: no tool, no resource, no line in
 * `capabilities.ts`. A model that could see the mirror would start reasoning
 * about it, and the mirror is not part of the transaction.
 *
 * ## Redaction, and the one hole
 *
 * Almost everything here is safe by construction. `payload_id` is a handle and
 * not a body. `overrides` are JSONPaths, and a path says *where* a value is,
 * never what it was — which is why `feedback.redact.ts` keeps `json_path`
 * verbatim for the same reason. `action`, `ack` and `nack_code` are protocol
 * vocabulary. `flow_id` is a public catalog coordinate, in the clear on
 * `IssueReport` today.
 *
 * **`summary` is the exception, and the biggest correctness risk in this
 * module.** It is free prose: it quotes a participant's NACK messages verbatim
 * and mints transaction ids in plain text ("Flow X minted transaction
 * f5473454-…"). `FeedbackService#renderReport` already runs
 * `scrubProse(summary, salt, 500)` over exactly these strings before they leave
 * the machine, and the mirror carries the same strings to the same kind of
 * destination. It does the same thing, and has its own test saying so.
 */

/** Bumped when a field changes meaning, not when one is added. */
export const MIRROR_SCHEMA_VERSION = 1;

export const MirrorKind = z.enum([
  /** A session was created. Carries the build and, crucially, `expires_at`. */
  "SESSION_CREATED",
  /**
   * A flow run opened.
   *
   * Not a journal kind, and deliberately so — see `mirror.service.ts`. Nothing
   * journals a run's existence, and a run that starts and is immediately
   * `BLOCKED` is the most interesting row in a triage corpus while producing no
   * journal line at all.
   */
  "RUN_STARTED",
  /** One session-journal line, essentially verbatim. */
  "JOURNAL",
]);
export type MirrorKind = z.infer<typeof MirrorKind>;

/** Cap on a scrubbed summary, matching `#renderReport`'s. */
export const MIRROR_SUMMARY_LIMIT = 500;

export const MirrorSession = z.object({
  domain: z.string(),
  version: z.string(),
  usecase: z.string().optional(),
  /** Which side this mock played. */
  mock_role: z.string(),
  /** The participant's own type — the inverse of `mock_role`. */
  np_type: z.string(),
  /**
   * The participant, pseudonymised with the same key `PSEUDONYM_KEYS` uses for
   * `subscriber_url`, so a mirror document and an issue report about the same
   * participant join without either naming them.
   */
  subscriber_ref: z.string(),
  /** The URI we advertise. Ours, not theirs, and shared by every session. */
  callback_url: z.string(),
  interaction_mode: z.string(),
  auto_advance: z.boolean(),
  created_at: z.string(),
  /**
   * When this session stops resolving.
   *
   * Carried because **session expiry is not observable**. `CacheStore` TTL
   * expiry is silent by design and there is no eviction callback, so a sibling
   * that wanted to show live sessions would otherwise have to keep them
   * forever or guess. Given this, it can derive the end itself.
   */
  expires_at: z.string(),
});
export type MirrorSession = z.infer<typeof MirrorSession>;

export const MirrorRun = z.object({
  flow_id: z.string(),
  /** Which attempt of this run, as `FlowBinding.attempt` counts them. */
  attempt: z.number().int(),
  auto_advance: z.boolean(),
  started_at: z.string(),
});
export type MirrorRun = z.infer<typeof MirrorRun>;

/** One journal line, with its prose scrubbed and everything else verbatim. */
export const MirrorEvent = z.object({
  seq: z.number().int(),
  at: z.string(),
  kind: SessionEventKind,
  flow_id: z.string().optional(),
  transaction_id: z.string().optional(),
  action: z.string().optional(),
  ack: AckStatus.optional(),
  nack_code: z.string().optional(),
  payload_id: z.string().optional(),
  overrides: z.array(z.string()).optional(),
  /** Scrubbed. See this file's header — it is the one free-text field. */
  summary: z.string(),
});
export type MirrorEvent = z.infer<typeof MirrorEvent>;

export const MirrorRecord = z.object({
  schema_version: z.literal(MIRROR_SCHEMA_VERSION),
  emitted_at: z.string(),
  /** The same install pseudonym `IssueReport` carries, from the same salt. */
  install_id: z.string(),
  /**
   * This process, so replicas are distinguishable.
   *
   * Minted per process rather than derived from a hostname: two replicas on one
   * host are two processes, and the question a mirror answers ("which instance
   * is doing this?") is about the process.
   */
  instance_id: z.string(),
  /** Always present, always pseudonymised: the join key for a session's records. */
  session_ref: z.string(),
  /**
   * Clear ids, only under `TELEMETRY_CORRELATION`.
   *
   * The same key, the same shape and the same flag as `IssueReport.correlation`
   * — reused rather than redefined so a consumer joining a mirror record to a
   * report is reading one contract, not two that happen to agree today.
   */
  correlation: Correlation.optional(),
  kind: MirrorKind,
  session: MirrorSession.optional(),
  run: MirrorRun.optional(),
  event: MirrorEvent.optional(),
});
export type MirrorRecord = z.infer<typeof MirrorRecord>;

/**
 * What one POST carries.
 *
 * `dropped_since_last_batch` is the point of the envelope. A bounded queue
 * means records *will* be lost under pressure, and a corpus with an unmarked
 * gap is worse than one with a marked gap — a consumer reading a run with a
 * step missing cannot otherwise tell "the mock skipped it" from "the mirror
 * dropped it", and those are opposite findings.
 */
export const MirrorBatch = z.object({
  schema_version: z.literal(MIRROR_SCHEMA_VERSION),
  instance_id: z.string(),
  sent_at: z.string(),
  dropped_since_last_batch: z.number().int(),
  records: z.array(MirrorRecord),
});
export type MirrorBatch = z.infer<typeof MirrorBatch>;
