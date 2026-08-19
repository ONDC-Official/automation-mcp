import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { Metrics } from "@/lib/metrics/metrics.js";
import {
  detectFromError,
  detectFromEvent,
  detectFromOutcome,
  type Candidate,
} from "@/modules/feedback/feedback.detect.js";
import {
  installId,
  redactEvidence,
  scrubProse,
} from "@/modules/feedback/feedback.redact.js";
import type { FeedbackRepository } from "@/modules/feedback/feedback.repository.js";
import {
  isRecovered,
  REPORT_JOURNAL_LIMIT,
  REPORT_SCHEMA_VERSION,
  signatureOf,
  type Incident,
  type IncidentState,
  type IssueReport,
  type Narration,
  type TriggerKind,
} from "@/modules/feedback/feedback.schema.js";
import type { FeedbackSink } from "@/modules/feedback/feedback.sink.js";
import type { FlowRepository } from "@/modules/flow/flow.repository.js";
import type { StepOutcome } from "@/modules/flow/flow.schema.js";
import type { RecordRepository } from "@/modules/record/record.repository.js";
import type { SessionEvent } from "@/modules/record/record.schema.js";
import type { SessionRepository } from "@/modules/session/session.repository.js";
import type {
  JournalEntry,
  SessionEventDiagnostics,
  SessionEventObserver,
} from "@/modules/record/record.service.js";

/**
 * The incident corpus: what went wrong, whether it got fixed, and what the
 * model made of it.
 *
 * Imports nothing from the MCP SDK. Three responsibilities:
 *
 * 1. **Capture**, from two taps — the session journal (via
 *    `SessionEventObserver`) and `FlowService`'s outward path. Everything is
 *    deduplicated by signature, so a model retrying the same wrong guess three
 *    times produces one incident with `occurrences: 3`.
 * 2. **Resolve**, by reading what the run did next. `RECOVERED` is a fact the
 *    engine already computes, never something the model asserts.
 * 3. **Report**, by handing a redacted `IssueReport` to the sink — narrated if
 *    the model got round to it, and with `narration: null` if it did not.
 *
 * ## Why it never throws, anywhere
 *
 * Every entry point is on somebody else's critical path: the receiver after the
 * ACK is decided, `flow_proceed` on its way to answering the model, `dispose`
 * during shutdown. This is the same contract `RecordService#journal` documents
 * and for the same reason — nothing is *derived* from the corpus, so a lost
 * incident costs a report, never a correct answer, whereas a thrown one would
 * turn our telemetry into the participant's recorded non-compliance.
 *
 * ## The dependency knot, and how it is untied
 *
 * `RecordService` calls this (it owns the journal tap), and this needs to write
 * a journal line of its own (`ISSUE_OPEN`). Rather than a mutual import, the
 * one thing needed from the other side arrives as a function — `JournalWriter`
 * — bound in `createContainer` once both exist. That keeps the module graph
 * one-way and makes the dependency exactly as small as it really is.
 */

/** The single call this service needs back from `RecordService`. */
export type JournalWriter = (
  sessionId: string,
  entry: JournalEntry,
) => Promise<void>;

export interface FeedbackServiceOptions {
  repository: FeedbackRepository;
  /** Read-only: an incident needs its run's `attempt` and transaction id. */
  flows: FlowRepository;
  /** Read-only: the journal slice a report attaches. */
  records: RecordRepository;
  /** Read-only: the build coordinates and role a report is grouped by. */
  sessions: SessionRepository;
  sink: FeedbackSink;
  journal: JournalWriter;
  /** Per-install HMAC salt for pseudonyms. Never leaves the machine. */
  salt: string;
  /** Absolute repo root, so in-repo stack frames stay readable. */
  repoRoot?: string;
  /** False under `FEEDBACK_DISABLED`: capture stops at the front door. */
  enabled: boolean;
  /**
   * `TELEMETRY_CORRELATION`: attach clear `session_id` / `transaction_id` to a
   * report, under one key and nowhere else.
   *
   * **It is read here and never passed to `feedback.redact.ts`.** That module
   * is pure, imports no config, and does not know this flag exists — which is
   * what makes "the flag cannot weaken redaction" a property of the module
   * graph rather than of somebody's care.
   */
  correlation?: boolean;
  logger: Logger;
  /** Optional; absent in unit tests. Capture is identical without it. */
  metrics?: Metrics;
  /**
   * Injectable clock, as `SessionService.createSession` and
   * `RecordService.createTransaction` already take one.
   *
   * Rendering a report stamps `generated_at`, so without this two renders of
   * one incident differ on that field alone — which is precisely the
   * difference a differential test needs to be able to rule out.
   */
  now?: () => Date;
}

/**
 * Triggers a later success can retract.
 *
 * Everything here means "this step would not go". A `VALIDATION_FINDINGS` does
 * not: the payload carried those findings whether or not the participant
 * accepted it, and marking it recovered because the next call worked would
 * quietly overstate how clean a run was.
 */
const STEP_RECOVERABLE = new Set<TriggerKind>([
  "BLOCKED",
  "SEND_FAILED",
  "INBOUND_NACK",
  "OUTBOUND_NACK",
]);

/** What a journal line, if anything, says about incidents already open. */
function resolutionFor(
  event: SessionEvent,
): { state: IncidentState; scope: "action" | "flow" } | undefined {
  // A completed flow got past everything, including whatever it stumbled on.
  if (event.kind === "FLOW_COMPLETE") {
    return { state: "RECOVERED", scope: "flow" };
  }
  // The loudest give-up signal in the system. Whatever was open when the model
  // reached for `flow_restart` is precisely what it could not fix.
  if (event.kind === "FLOW_RESTARTED") {
    return { state: "ABANDONED", scope: "flow" };
  }
  if (event.kind === "INBOUND_ACK") {
    return { state: "RECOVERED", scope: "action" };
  }
  if (
    (event.kind === "OUTBOUND_SENT" || event.kind === "CHAIN_SENT") &&
    event.ack === "ACK"
  ) {
    // A send that only worked because the model patched the payload is not the
    // same finding as one that started working. The first says a **published
    // config** is broken and someone else has to repair it; the second says the
    // model was wrong and then was not. Reporting both as `RECOVERED` would
    // hide the only one of the two that is actionable outside this repo.
    return {
      state:
        event.overrides !== undefined && event.overrides.length > 0
          ? "RECOVERED_WITH_OVERRIDE"
          : "RECOVERED",
      scope: "action",
    };
  }
  return undefined;
}

/**
 * Whether this incident is about the action that just succeeded.
 *
 * Matched on either field because the two vocabularies overlap without being
 * identical: a `blocked()` outcome names the step key, an inbound NACK names
 * the action, and for most steps they are the same string.
 */
function matchesAction(
  incident: Incident,
  action: string | undefined,
): boolean {
  if (action === undefined) return false;
  return incident.step_key === action || incident.action === action;
}

export class FeedbackService implements SessionEventObserver {
  readonly #repository: FeedbackRepository;
  readonly #flows: FlowRepository;
  readonly #records: RecordRepository;
  readonly #sessions: SessionRepository;
  readonly #sink: FeedbackSink;
  readonly #journal: JournalWriter;
  readonly #salt: string;
  readonly #repoRoot: string | undefined;
  readonly #enabled: boolean;
  readonly #correlation: boolean;
  readonly #logger: Logger;
  readonly #metrics: Metrics | undefined;
  readonly #now: () => Date;

  /**
   * Serialises `note()` per signature.
   *
   * The body of an incident is a load-modify-save, and the two paths that reach
   * it are genuinely concurrent — the HTTP receiver journaling a NACK while
   * auto-advance is observing the outcome that caused it. Losing that race
   * would drop an occurrence, which is precisely the number that says how hard
   * something was fought.
   *
   * In-process only, like the three locks in `RecordService`. The occurrence
   * *count* does not depend on it: that lives on its own key and is incremented
   * atomically, so it stays right even across processes.
   */
  readonly #locks = new Map<string, Promise<unknown>>();

  /**
   * Work started and not yet finished, so `dispose` can wait for it.
   *
   * Capture is fire-and-forget by design — nothing may block the receiver — but
   * "fire and forget" during shutdown means a report that was being written
   * when the process ended simply vanishes.
   */
  readonly #inFlight = new Set<Promise<unknown>>();

  /**
   * Sessions this process has opened an incident for.
   *
   * In-memory on purpose. `drain` needs somewhere to look for incidents that
   * never resolved, and the only sessions it can be responsible for are the
   * ones it saw — a sibling replica's stuck runs are that replica's to report,
   * and scanning the store for them would have every instance ship every other
   * instance's reports.
   */
  readonly #touched = new Set<string>();

  constructor(options: FeedbackServiceOptions) {
    this.#repository = options.repository;
    this.#flows = options.flows;
    this.#records = options.records;
    this.#sessions = options.sessions;
    this.#sink = options.sink;
    this.#journal = options.journal;
    this.#salt = options.salt;
    this.#repoRoot = options.repoRoot;
    this.#enabled = options.enabled;
    this.#correlation = options.correlation ?? false;
    this.#logger = options.logger;
    this.#metrics = options.metrics;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Whether reports carry clear ids (`TELEMETRY_CORRELATION`).
   *
   * Exposed so `sharingNotice()` can say so. `feedback_list_reports` is
   * documented as the honest answer to "what are you sending about me?", and a
   * notice that claimed everything was pseudonymised while `correlation` sat in
   * the body would make that documentation false — quietly, and in the one
   * place a user is explicitly invited to trust it.
   */
  get correlates(): boolean {
    return this.#correlation;
  }

  /* -------------------------------- taps --------------------------------- */

  /**
   * Tap one: the session journal.
   *
   * Synchronous and returning `void`, because it is called from inside
   * `RecordService#journal` on the receiver's path. The real work is scheduled,
   * never awaited.
   */
  onSessionEvent(
    sessionId: string,
    event: SessionEvent,
    diagnostics?: SessionEventDiagnostics,
  ): void {
    if (!this.#enabled) return;

    // The recursion guard. This service writes `ISSUE_OPEN` through the very
    // journal it is observing; without this, opening one incident opens
    // another, forever.
    if (event.kind === "ISSUE_OPEN") return;

    // Resolution first: a line that closes an incident never opens one, and
    // running them in this order keeps that separation obvious rather than
    // implied by which `if` came first.
    this.#schedule(this.#resolveFrom(sessionId, event));

    const candidate = detectFromEvent(event, diagnostics);
    if (candidate === undefined) return;

    this.#schedule(
      this.#note(sessionId, event.flow_id, candidate, event.transaction_id),
    );
  }

  /* ------------------------------ resolution ------------------------------ */

  /**
   * Move incidents out of `OPEN` on the strength of what the run did next.
   *
   * **Nothing here consults the model.** A model asked whether it fixed
   * something says yes; the run either got past the step or it did not, and
   * that is already written down. `Narration.outcome` records the belief and
   * this records the fact, which is what makes the disagreement between them
   * worth having at all.
   *
   * The rule is deliberately narrow: an incident on action A is `RECOVERED`
   * when a *later, successful* exchange for action A is journaled. Not "the
   * flow moved on" — a run can advance past a step that never worked, and
   * calling that a recovery would quietly turn the corpus's most valuable
   * column into noise.
   */
  async #resolveFrom(sessionId: string, event: SessionEvent): Promise<void> {
    const outcome = resolutionFor(event);
    if (outcome === undefined) return;

    try {
      const open = (await this.#repository.list(sessionId)).filter(
        (incident) => incident.state === "OPEN",
      );
      if (open.length === 0) return;

      const at = new Date().toISOString();
      for (const incident of open) {
        if (event.flow_id !== undefined && incident.flow_id !== event.flow_id) {
          continue;
        }
        if (
          outcome.scope === "action" &&
          !matchesAction(incident, event.action)
        ) {
          continue;
        }
        if (
          outcome.scope === "action" &&
          !STEP_RECOVERABLE.has(incident.trigger)
        ) {
          // A validation finding is not undone by the next call succeeding —
          // the payload still carried it. Only the triggers that mean "this
          // step would not go" can be retracted by the step going.
          continue;
        }

        const resolved: Incident = {
          ...incident,
          state: outcome.state,
          resolved_at: at,
        };
        await this.#repository.save(resolved);
        // The **derived** state, never `Narration.outcome`. A dashboard that
        // counted what the model believed about itself would be measuring the
        // model's optimism rather than the run.
        this.#metrics?.incidentsResolved.inc({
          trigger: incident.trigger,
          state: outcome.state,
        });
        // Terminal state is the trigger to report. Narration, if it ever
        // arrives, re-flushes with `flushed_at` cleared — the model usually
        // answers after the run has moved on, and waiting for it would mean a
        // run nobody narrated never shipped at all.
        await this.#flush(resolved);
      }
    } catch (error) {
      this.#logger.warn(
        { err: error, session_id: sessionId },
        "could not resolve feedback incidents; they stay open",
      );
    }
  }

  /**
   * Tap two, part one: what `flow_proceed` answered.
   *
   * Covers every `blocked()` reason, an outbound NACK — which arrives as `SENT`,
   * because the exchange completed — and both validation verdicts.
   */
  noteOutcome(sessionId: string, flowId: string, outcome: StepOutcome): void {
    if (!this.#enabled) return;
    for (const candidate of detectFromOutcome(outcome)) {
      this.#schedule(
        this.#note(sessionId, flowId, candidate, outcome.transaction_id),
      );
    }
  }

  /**
   * Tap two, part two: what `flow_proceed` threw.
   *
   * The case with no outcome at all. A send failure settles the record entry and
   * rethrows, so before this existed a chained run could stall with nothing but
   * a `logger.error` to show for it.
   */
  noteError(
    sessionId: string,
    flowId: string,
    error: unknown,
    context: { stepKey?: string; action?: string; transactionId?: string } = {},
  ): void {
    if (!this.#enabled) return;
    const candidate = detectFromError(error, context);
    if (candidate === undefined) return;
    this.#schedule(
      this.#note(sessionId, flowId, candidate, context.transactionId),
    );
  }

  /* ------------------------------- capture -------------------------------- */

  async #note(
    sessionId: string,
    flowId: string | undefined,
    candidate: Candidate,
    transactionId: string | undefined,
  ): Promise<void> {
    const signature = signatureOf(
      candidate.trigger,
      candidate.stepKey,
      candidate.code,
    );

    this.#touched.add(sessionId);

    try {
      // Atomic, and outside the lock on purpose: it is the one field that stays
      // correct even when two processes share a Redis.
      const occurrences = await this.#repository.countOccurrence(
        sessionId,
        signature,
      );

      await this.#withLock(`${sessionId}::${signature}`, async () => {
        const existing = await this.#repository.find(sessionId, signature);
        const now = new Date().toISOString();

        if (existing !== undefined) {
          await this.#repository.save({
            ...existing,
            occurrences,
            last_seen_at: now,
            // A repeat re-opens a resolution reached prematurely: the run moved
            // on and then hit the same wall again, which is a worse story than
            // either half on its own. Both flavours of recovery re-open — a
            // workaround that stopped working is exactly the case in point.
            state: isRecovered(existing.state) ? "OPEN" : existing.state,
            ...(transactionId !== undefined
              ? { transaction_id: transactionId }
              : {}),
          });
          return;
        }

        const resolvedFlowId = flowId ?? "unknown";
        const binding =
          flowId !== undefined
            ? await this.#flows.findBinding(sessionId, flowId)
            : undefined;

        const incident: Incident = {
          id: `inc_${randomUUID()}`,
          session_id: sessionId,
          flow_id: resolvedFlowId,
          attempt: binding?.attempt ?? 1,
          ...(transactionId !== undefined
            ? { transaction_id: transactionId }
            : binding?.transactionId !== undefined
              ? { transaction_id: binding.transactionId }
              : {}),
          trigger: candidate.trigger,
          code: candidate.code,
          ...(candidate.stepKey !== undefined
            ? { step_key: candidate.stepKey }
            : {}),
          ...(candidate.action !== undefined
            ? { action: candidate.action }
            : {}),
          signature,
          occurrences,
          first_seen_at: now,
          last_seen_at: now,
          state: "OPEN",
          journal_from: 0,
          // Redacted here, at capture, never at flush. A report that is never
          // sent should still not leave personal data sitting in the store.
          evidence: redactEvidence(candidate.evidence, {
            salt: this.#salt,
            ...(this.#repoRoot !== undefined
              ? { repoRoot: this.#repoRoot }
              : {}),
          }),
        };

        await this.#repository.save(incident);
        // Counted on first sighting only — the `existing` branch returns above
        // — so this counts *incidents*, matching `occurrences: 1` at open.
        // `code` may be a validation finding code, whose space upstream owns,
        // so it goes through the same cap `ondc_validation_findings_total` uses.
        this.#metrics?.incidents.inc({
          trigger: incident.trigger,
          code: this.#metrics.findingCode(incident.code),
        });
        this.#logger.debug(
          { session_id: sessionId, signature, incidentId: incident.id },
          "opened a feedback incident",
        );

        // The nudge. Written only on the first sighting — the `existing` branch
        // returns above — so a failure the model retries ten times asks it once,
        // which is the whole reason incidents are deduplicated by signature.
        await this.#journal(sessionId, {
          kind: "ISSUE_OPEN",
          ...(flowId !== undefined ? { flow_id: flowId } : {}),
          ...(transactionId !== undefined
            ? { transaction_id: transactionId }
            : {}),
          ...(candidate.action !== undefined
            ? { action: candidate.action }
            : {}),
          summary:
            `${candidate.trigger} (${candidate.code})` +
            `${candidate.stepKey !== undefined ? ` at ${candidate.stepKey}` : ""}` +
            ` — call feedback_submit_report with incident_id ${incident.id} ` +
            `once you know what happened.`,
        });
      });
    } catch (error) {
      this.#logger.warn(
        { err: error, session_id: sessionId, signature },
        "could not record a feedback incident; nothing else is affected",
      );
    }
  }

  /* -------------------------------- report -------------------------------- */

  /**
   * Assemble the redacted report and hand it to the sink, exactly once.
   *
   * `flushed_at` is the guard. An incident can reach a terminal state more than
   * once — a `FLOW_COMPLETE` after an `INBOUND_ACK` both resolve it — and the
   * corpus is worth much less if the same run appears in it twice.
   *
   * The evidence was redacted at capture; what is added here is the session's
   * public coordinates and a slice of journal summaries, so the scrub runs
   * again over those. Redacting twice is cheap and the alternative is a rule
   * about which fields have already been through it.
   */
  async #flush(incident: Incident): Promise<void> {
    if (incident.flushed_at !== undefined) return;

    const report = await this.#renderReport(incident);
    if (report === undefined) return;

    try {
      await this.#sink.deliver(report);
      await this.#repository.save({
        ...incident,
        flushed_at: report.generated_at,
      });
    } catch (error) {
      this.#logger.warn(
        { err: error, incidentId: incident.id },
        "could not deliver an issue report; the incident is unaffected",
      );
    }
  }

  /**
   * The report, assembled and redacted, without sending it anywhere.
   *
   * Split out from `#flush` so `feedback_list_reports` can show an operator
   * exactly what would be uploaded. A preview that went through a different
   * code path would be worth nothing.
   */
  async #renderReport(incident: Incident): Promise<IssueReport | undefined> {
    try {
      const session = await this.#sessions.find(incident.session_id);
      const journal = await this.#records.journalSince(incident.session_id, 0);

      const resolvedAt = incident.resolved_at;
      const report: IssueReport = {
        schema_version: REPORT_SCHEMA_VERSION,
        report_id: incident.id,
        generated_at: this.#now().toISOString(),
        install_id: installId(this.#salt),
        build: {
          domain: session?.build.domain ?? "unknown",
          version: session?.build.version ?? "unknown",
          ...(session?.build.usecase !== undefined
            ? { usecase: session.build.usecase }
            : {}),
        },
        mock_role: session?.mock_role ?? "unknown",
        flow_id: incident.flow_id,
        attempt: incident.attempt,
        incident: {
          trigger: incident.trigger,
          code: incident.code,
          ...(incident.step_key !== undefined
            ? { step_key: incident.step_key }
            : {}),
          ...(incident.action !== undefined ? { action: incident.action } : {}),
          occurrences: incident.occurrences,
          state: incident.state,
          ...(resolvedAt !== undefined
            ? {
                duration_ms: Math.max(
                  0,
                  Date.parse(resolvedAt) - Date.parse(incident.first_seen_at),
                ),
              }
            : {}),
        },
        evidence: incident.evidence,
        journal: journal.slice(-REPORT_JOURNAL_LIMIT).map((entry) => ({
          seq: entry.seq,
          kind: entry.kind,
          ...(entry.action !== undefined ? { action: entry.action } : {}),
          ...(entry.ack !== undefined ? { ack: entry.ack } : {}),
          ...(entry.nack_code !== undefined
            ? { nack_code: entry.nack_code }
            : {}),
          summary: scrubProse(entry.summary, this.#salt, 500),
        })),
        // `null`, not absent. "The model was asked and never answered" and "the
        // model was never asked" are different facts about the corpus, and a
        // missing key cannot tell them apart.
        narration: incident.narration ?? null,
        /*
         * The flag's whole blast radius: one key, assembled here, from ids the
         * incident already holds in the clear.
         *
         * Deliberately **not** routed through `feedback.redact.ts` — that
         * module never learns this flag exists, so no future edit to it can
         * accidentally widen what the flag does. And deliberately spread as a
         * conditional so a flag-off report has no `correlation` key at all,
         * rather than one set to `undefined`: `JSON.stringify` drops the second
         * on the way to the spool but a differential assertion would not, and
         * the point of the shape is that the assertion is exact.
         */
        ...(this.#correlation
          ? {
              correlation: {
                session_id: incident.session_id,
                ...(incident.transaction_id !== undefined
                  ? { transaction_id: incident.transaction_id }
                  : {}),
              },
            }
          : {}),
      };

      return report;
    } catch (error) {
      this.#logger.warn(
        { err: error, incidentId: incident.id },
        "could not assemble an issue report; the incident is unaffected",
      );
      return undefined;
    }
  }

  /* -------------------------------- reads --------------------------------- */

  async list(sessionId: string): Promise<Incident[]> {
    try {
      return await this.#repository.list(sessionId);
    } catch (error) {
      this.#logger.warn(
        { err: error, session_id: sessionId },
        "could not list incidents",
      );
      return [];
    }
  }

  async find(
    sessionId: string,
    incidentId: string,
  ): Promise<Incident | undefined> {
    const all = await this.list(sessionId);
    return all.find((incident) => incident.id === incidentId);
  }

  /**
   * Attach the model's account of an incident and ship it.
   *
   * Flushes immediately rather than waiting for a terminal state, and clears
   * `flushed_at` first so an incident already reported unnarrated is *replaced*
   * by the narrated one. The order matters: the model almost always answers
   * after the run has moved on, so requiring narration before the first flush
   * would mean a run nobody narrated never shipped — which is the guarantee
   * this whole feature exists to make.
   */
  async narrate(
    sessionId: string,
    incidentId: string,
    narration: Narration,
  ): Promise<Incident | undefined> {
    const incident = await this.find(sessionId, incidentId);
    if (incident === undefined) return undefined;

    const scrubbed: Narration = {
      // The model is told not to paste payload values. This is what makes that
      // instruction advice rather than a load-bearing assumption — it saw
      // whatever it is describing, and prose is the one place structural
      // redaction cannot reach.
      diagnosis: scrubProse(narration.diagnosis, this.#salt),
      attempted: narration.attempted.map((line) =>
        scrubProse(line, this.#salt, 500),
      ),
      outcome: narration.outcome,
      suspected_cause: narration.suspected_cause,
      ...(narration.tooling_gap !== undefined
        ? { tooling_gap: scrubProse(narration.tooling_gap, this.#salt) }
        : {}),
      at: narration.at,
    };

    const updated: Incident = { ...incident, narration: scrubbed };
    delete updated.flushed_at;

    await this.#repository.save(updated);
    await this.#flush(updated);
    return updated;
  }

  /** Render an incident exactly as it would be uploaded. No side effects. */
  buildReport(incident: Incident): Promise<IssueReport | undefined> {
    return this.#renderReport(incident);
  }

  /* ------------------------------- lifecycle ------------------------------ */

  /**
   * Wait for scheduled capture to finish, with no side effects.
   *
   * Capture is fire-and-forget on every path that matters, so anything wanting
   * to observe the result — a test, or `drain` below — needs a way to wait that
   * does not itself change anything.
   */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.#inFlight]);
  }

  /**
   * Wait for scheduled capture to finish, then report what never resolved.
   *
   * This is where the guarantee is actually kept. A run that ends still stuck —
   * the model gave up, the client disconnected, the process is going down — has
   * no terminal event to trigger on, and without this its incident would sit in
   * the store until the session TTL swept it away. **An incident nobody
   * narrated still ships**, with `narration: null`; that is the difference
   * between "reports every time" and "reports whenever the model remembered".
   */
  async drain(): Promise<void> {
    await this.settled();

    for (const sessionId of this.#touched) {
      for (const incident of await this.list(sessionId)) {
        if (incident.flushed_at !== undefined) continue;
        const closed: Incident =
          incident.state === "OPEN"
            ? {
                ...incident,
                state: "UNRESOLVED",
                resolved_at: new Date().toISOString(),
              }
            : incident;
        if (closed !== incident) await this.#repository.save(closed);
        await this.#flush(closed);
      }
    }

    // Anything still spooled and unsent gets one last push.
    await this.#sink.close();
  }

  /* -------------------------------- private ------------------------------- */

  #schedule(work: Promise<unknown>): void {
    const tracked = work.catch((error: unknown) => {
      this.#logger.warn({ err: error }, "a feedback capture failed");
    });
    this.#inFlight.add(tracked);
    void tracked.finally(() => this.#inFlight.delete(tracked));
  }

  /** The same shape as `RecordService`'s locks, for the same reason. */
  async #withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const current = previous.then(work, work);
    this.#locks.set(
      key,
      current.catch(() => undefined),
    );
    try {
      return await current;
    } finally {
      if (this.#locks.get(key) === current) this.#locks.delete(key);
    }
  }
}
