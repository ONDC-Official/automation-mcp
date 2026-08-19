import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryCacheStore } from "@/lib/cache/in-memory-cache-store.js";
import { logger } from "@/lib/logger.js";
import { redactEvidence } from "@/modules/feedback/feedback.redact.js";
import { FeedbackRepository } from "@/modules/feedback/feedback.repository.js";
import { FeedbackService } from "@/modules/feedback/feedback.service.js";
import type { Incident } from "@/modules/feedback/feedback.schema.js";
import { NoopSink } from "@/modules/feedback/feedback.sink.js";
import { FlowRepository } from "@/modules/flow/flow.repository.js";
import { RecordRepository } from "@/modules/record/record.repository.js";
import { CacheSessionRepository } from "@/modules/session/session.repository.js";
import { PII_PROSE, expectNoPii } from "@/test/pii-fixtures.js";

/**
 * `TELEMETRY_CORRELATION`, and the promise it must not break.
 *
 * The flag puts two identifiers we minted ourselves in the clear so a dashboard
 * can link a report to its run. Everything about the design is aimed at making
 * that claim checkable rather than asserted:
 *
 * - the ids go under **one nested key**, so "what did the flag change?" is a
 *   destructuring rather than a review;
 * - `feedback.redact.ts` is byte-unchanged and never sees the flag, so a
 *   `transaction_id` inside evidence or quoted inside prose is pseudonymised
 *   exactly as before;
 * - the existing PII canary runs over the flag-on report unchanged.
 *
 * A report therefore carries both a pseudonym and a clear id for one
 * transaction. That is the intended result and not a leak: the pseudonym exists
 * to keep the **participant** unlinkable and the corpus internally consistent,
 * neither of which this touches.
 */

const SESSION = "sess-firstparty";
const FLOW = "flow-1";

/**
 * Deliberately **not** the transaction id in `PII_LITERALS`.
 *
 * That fixture lists `b4f1e2a0-…-000000000001` as a literal that must never
 * survive redaction, and under this flag one transaction id survives on purpose
 * — in `correlation`, and nowhere else. Reusing it would make the canary assert
 * the opposite of the feature. The ids inside `evidence` and inside prose still
 * come from the fixture, which is where the canary has teeth.
 */
const TXN = "11111111-2222-4333-8444-555555555555";

/** A frozen clock, so two renders differ only where the flag makes them. */
const NOW = new Date("2026-08-17T09:00:00.000Z");

function service(correlation: boolean): FeedbackService {
  const cache = new InMemoryCacheStore();
  return new FeedbackService({
    repository: new FeedbackRepository({ cache, sessionTtlMs: 60_000 }),
    flows: new FlowRepository({ cache, transactionTtlMs: 60_000 }),
    records: new RecordRepository({
      cache,
      transactionTtlMs: 60_000,
      flowStatusTtlMs: 60_000,
      expectationTtlMs: 60_000,
      sessionTtlMs: 60_000,
    }),
    sessions: new CacheSessionRepository(cache),
    sink: new NoopSink(),
    journal: () => Promise.resolve(),
    salt: "test-salt",
    enabled: true,
    correlation,
    logger: logger.child({ silent: true }),
    now: () => NOW,
  });
}

function incident(): Incident {
  return {
    id: "inc_firstparty",
    session_id: SESSION,
    flow_id: FLOW,
    attempt: 1,
    transaction_id: TXN,
    trigger: "BLOCKED",
    code: "generation_failed",
    step_key: "select_1",
    action: "select",
    signature: "BLOCKED::select_1::generation_failed",
    occurrences: 2,
    first_seen_at: "2026-08-17T08:59:00.000Z",
    last_seen_at: "2026-08-17T08:59:30.000Z",
    state: "OPEN",
    journal_from: 0,
    evidence: {},
  };
}

describe("TELEMETRY_CORRELATION", () => {
  let off: FeedbackService;
  let on: FeedbackService;

  beforeEach(() => {
    off = service(false);
    on = service(true);
  });

  it("adds exactly one key and changes nothing else", async () => {
    // The differential test, and the reason `correlation` is nested rather than
    // two flat fields: this assertion cannot be written at all against a flat
    // shape without listing what is expected to differ — which is the same as
    // trusting the reader to have noticed.
    const base = incident();
    const withoutFlag = await off.buildReport(base);
    const withFlag = await on.buildReport(base);

    expect(withoutFlag).toBeDefined();
    expect(withFlag).toBeDefined();
    if (withoutFlag === undefined || withFlag === undefined) return;

    const { correlation, ...rest } = withFlag;
    expect(rest).toEqual(withoutFlag);
    expect(withoutFlag).not.toHaveProperty("correlation");
    expect(Object.keys(correlation ?? {}).sort()).toEqual([
      "session_id",
      "transaction_id",
    ]);
    expect(correlation).toEqual({ session_id: SESSION, transaction_id: TXN });

    // A pure addition, so the ingest can read a spool file from either side of
    // this change without special-casing a version.
    expect(withFlag.schema_version).toBe(withoutFlag.schema_version);
  });

  it("omits transaction_id when the run never bound one", async () => {
    const unbound = incident();
    delete unbound.transaction_id;

    const report = await on.buildReport(unbound);
    expect(report?.correlation).toEqual({ session_id: SESSION });
  });

  it("still pseudonymises a transaction id inside the payload shape", async () => {
    // The structural path. `feedback.redact.ts` does not know this flag exists,
    // which is what makes this hold by construction rather than by care.
    //
    // Note the two transaction ids in play, and that the difference is the
    // whole point: the *incident's* id is ours and is the one `correlation`
    // reports in the clear; the one **inside a payload the participant sent**
    // is evidence, and stays pseudonymised.
    const report = await on.buildReport({
      ...incident(),
      // Redacted at capture, exactly as `#note` does it.
      evidence: redactEvidence(
        {
          payload_shape: {
            context: {
              transaction_id: "b4f1e2a0-0000-4000-8000-000000000001",
              bap_id: "buyer.example.com",
            },
          },
        },
        { salt: "test-salt" },
      ),
    });

    const shape = report?.evidence.payload_shape as {
      context: { transaction_id: string; bap_id: string };
    };
    expect(shape.context.transaction_id).toMatch(/^txn_/);
    expect(shape.context.bap_id).toMatch(/^np_/);
    expectNoPii(report);
  });

  it("still scrubs ids and values quoted inside a journal summary", async () => {
    // The prose path — the one structural redaction cannot reach, and the one
    // an operator is most likely to assume is safe because "it is only a
    // summary".
    const cache = new InMemoryCacheStore();
    const records = new RecordRepository({
      cache,
      transactionTtlMs: 60_000,
      flowStatusTtlMs: 60_000,
      expectationTtlMs: 60_000,
      sessionTtlMs: 60_000,
    });
    const seq = await records.nextJournalSeq(SESSION);
    await records.appendJournal(SESSION, {
      seq,
      at: NOW.toISOString(),
      kind: "INBOUND_NACK",
      flow_id: FLOW,
      summary:
        `NACKed select for transaction b4f1e2a0-0000-4000-8000-000000000001: ` +
        PII_PROSE,
    });

    const withJournal = new FeedbackService({
      repository: new FeedbackRepository({ cache, sessionTtlMs: 60_000 }),
      flows: new FlowRepository({ cache, transactionTtlMs: 60_000 }),
      records,
      sessions: new CacheSessionRepository(cache),
      sink: new NoopSink(),
      journal: () => Promise.resolve(),
      salt: "test-salt",
      enabled: true,
      correlation: true,
      logger: logger.child({ silent: true }),
      now: () => NOW,
    });

    const report = await withJournal.buildReport(incident());
    const line = report?.journal[0];

    expect(line?.summary).not.toContain(
      "b4f1e2a0-0000-4000-8000-000000000001",
    );
    expect(line?.summary).toContain("id_");
    expect(line?.summary).toContain("<email>");

    // And the whole flag-on report against the existing canary, unchanged. The
    // clear id in `correlation` is ours, not the fixture's, precisely so this
    // assertion still means what it meant before the flag.
    expectNoPii(report);
  });
});
