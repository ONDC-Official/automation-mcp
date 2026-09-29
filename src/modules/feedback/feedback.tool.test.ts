import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "@/test/harness.js";
import { NoopSink } from "@/modules/feedback/feedback.sink.js";
import { RUNNABLE_BUILD } from "@/test/runnable-config.js";
import { PII_PROSE, expectNoPii } from "@/test/pii-fixtures.js";
import type {
  ListReportsOutput,
  SubmitReportOutput,
} from "@/modules/feedback/feedback.schema.js";

/**
 * The tools, over the real client ↔ server transport.
 *
 * The service tests already cover capture and lifecycle; what these add is the
 * protocol edge — that a bad id lands on the tool channel rather than as a
 * thrown rejection, and that the preview a user would be shown really is the
 * redacted report and not a second rendering of it.
 */

const BUILD = RUNNABLE_BUILD;

describe("feedback tools", () => {
  let harness: Harness;
  let sink: NoopSink;
  let sessionId: string;

  beforeEach(async () => {
    sink = new NoopSink();
    harness = await createHarness({ feedbackSink: sink });

    const created = await harness.client.callTool({
      name: "session_create",
      arguments: {
        subscriber_url: "https://np.example.com",
        np_type: "BPP",
        domain: BUILD.domain,
        version: BUILD.version,
        usecase: BUILD.usecase,
      },
    });
    sessionId = (
      created.structuredContent as { session: { session_id: string } }
    ).session.session_id;
  });

  afterEach(async () => {
    await harness.close();
  });

  /** Open one incident through the service, the way the loop would. */
  async function openIncident(): Promise<string> {
    const feedback = harness.container.services.feedback;
    feedback.noteOutcome(sessionId, "flow-1", {
      outcome: "BLOCKED",
      message: 'Step "select" is not ready: no provider chosen yet',
      reason: "requirements_not_met",
      step_key: "select",
    });
    await feedback.settled();

    const [incident] = await feedback.list(sessionId);
    return incident?.id ?? "";
  }

  it("lists an open incident and says it needs an account", async () => {
    const incidentId = await openIncident();

    const result = await harness.client.callTool({
      name: "feedback_list_reports",
      arguments: { session_id: sessionId },
    });
    const output = result.structuredContent as ListReportsOutput;

    expect(output.incidents).toHaveLength(1);
    expect(output.incidents[0]?.incident_id).toBe(incidentId);
    expect(output.incidents[0]?.narrated).toBe(false);
    expect(output.incidents[0]?.code).toBe("requirements_not_met");
    // The sharing notice is on every answer, so it can be repeated to a user
    // who asks without a second tool call.
    expect(output.sharing).toContain("pseudonymised");
  });

  it("shows the exact redacted body on request", async () => {
    await openIncident();

    const result = await harness.client.callTool({
      name: "feedback_list_reports",
      arguments: { session_id: sessionId, include_body: true },
    });
    const output = result.structuredContent as ListReportsOutput;
    const report = output.incidents[0]?.report;

    expect(report?.schema_version).toBe(1);
    expect(report?.build).toMatchObject({ domain: BUILD.domain });
    expect(report?.narration).toBeNull();
    expect(report?.install_id).toMatch(/^inst_/);
  });

  it("records a narration and ships the report", async () => {
    const incidentId = await openIncident();

    const result = await harness.client.callTool({
      name: "feedback_submit_report",
      arguments: {
        session_id: sessionId,
        incident_id: incidentId,
        diagnosis: "the flow needed a provider id from on_search",
        attempted: ["re-ran flow_proceed", "read record_get_data"],
        outcome: "fixed",
        suspected_cause: "our_tooling",
        tooling_gap: "BLOCKED should name which saved key was missing",
      },
    });

    const output = result.structuredContent as SubmitReportOutput;
    expect(output.accepted).toBe(true);
    expect(sink.delivered).toHaveLength(1);
    expect(sink.delivered[0]?.narration?.tooling_gap).toContain(
      "which saved key was missing",
    );
  });

  it("scrubs a narration that quotes a value anyway", async () => {
    // The tool description tells the model not to paste payload values. This is
    // what makes that advice rather than an assumption.
    const incidentId = await openIncident();

    await harness.client.callTool({
      name: "feedback_submit_report",
      arguments: {
        session_id: sessionId,
        incident_id: incidentId,
        diagnosis: "billing.phone was 9876543210, which failed the regex",
        attempted: [],
        outcome: "gave_up",
        suspected_cause: "participant",
      },
    });

    const delivered = JSON.stringify(sink.delivered[0]);
    expect(delivered).not.toContain("9876543210");
    expect(delivered).toContain("<phone>");
  });

  it("claims nothing about an open incident's verdict", async () => {
    // Narration almost always arrives while the incident is still OPEN — the
    // model explains itself and moves on — so there is no verdict yet to agree
    // or disagree with. This used to compare `gave_up` against ABANDONED, which
    // nothing produces any more, so every `gave_up` read as a mismatch.
    const incidentId = await openIncident();

    const result = await harness.client.callTool({
      name: "feedback_submit_report",
      arguments: {
        session_id: sessionId,
        incident_id: incidentId,
        diagnosis: "could not work out what the config wanted",
        attempted: ["three different inputs"],
        outcome: "gave_up",
        suspected_cause: "flow_config",
      },
    });

    const output = result.structuredContent as SubmitReportOutput;
    expect(output.state).toBe("OPEN");
    expect(output.message).not.toContain("does not match");
  });

  it("says so when the model's claim disagrees with the run", async () => {
    // The model says it gave up; the run had in fact got past it. Both are
    // kept, and the disagreement is itself the finding.
    const incidentId = await openIncident();
    const feedback = harness.container.services.feedback;

    feedback.onSessionEvent(sessionId, {
      seq: 1,
      at: "2026-07-30T11:00:00.000Z",
      kind: "INBOUND_ACK",
      flow_id: "flow-1",
      action: "select",
      summary: "accepted",
    });
    await feedback.settled();

    const result = await harness.client.callTool({
      name: "feedback_submit_report",
      arguments: {
        session_id: sessionId,
        incident_id: incidentId,
        diagnosis: "could not work out what the config wanted",
        attempted: ["three different inputs"],
        outcome: "gave_up",
        suspected_cause: "flow_config",
      },
    });

    const output = result.structuredContent as SubmitReportOutput;
    expect(output.state).toBe("RECOVERED");
    expect(output.message).toContain("does not match");
  });

  it("answers an unknown incident on the tool channel, not as a throw", async () => {
    const result = await harness.client.callTool({
      name: "feedback_submit_report",
      arguments: {
        session_id: sessionId,
        incident_id: "inc_does-not-exist",
        diagnosis: "x",
        attempted: [],
        outcome: "fixed",
        suspected_cause: "unknown",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("refuses an unknown session before touching an incident", async () => {
    const result = await harness.client.callTool({
      name: "feedback_list_reports",
      arguments: { session_id: "sess-does-not-exist" },
    });

    expect(result.isError).toBe(true);
  });

  describe("a report with no incident behind it", () => {
    /**
     * The failure that produced this branch: `protocol_describe_action`
     * answered, the *client* rejected the answer against the published output
     * schema, and nothing on this side saw anything go wrong. No incident, no
     * session either — `protocol_*` takes a build triple — so the one witness
     * had nothing to quote and no way to say so.
     */
    const REPRO = {
      problem: "tool_result_rejected",
      tool: "protocol_describe_action",
      observed:
        "Structured content does not match the tool's output schema: " +
        "data/fields/items/0 must NOT have additional properties",
      diagnosis: "the result carried a key the published schema forbids",
      attempted: ["retried with a narrower path_prefix", "tried a lower limit"],
      outcome: "gave_up",
      suspected_cause: "our_tooling",
      tooling_gap: "no way to report this at all",
    };

    it("accepts one with neither a session nor an incident", async () => {
      const result = await harness.client.callTool({
        name: "feedback_submit_report",
        arguments: REPRO,
      });

      expect(result.isError).toBeFalsy();
      const out = result.structuredContent as SubmitReportOutput;
      expect(out.accepted).toBe(true);
      expect(out.state).toBe("REPORTED");
      expect(out.incident_id).toMatch(/^inc_/);
      // No session, so no journal to drain and no events block to carry.
      expect(out.events).toBeUndefined();

      expect(sink.delivered).toHaveLength(1);
      expect(sink.delivered[0]?.incident.trigger).toBe("MODEL_REPORTED");
      expect(sink.delivered[0]?.incident.tool).toBe("protocol_describe_action");
    });

    it("lists it back with no session named, body and all", async () => {
      await harness.client.callTool({
        name: "feedback_submit_report",
        arguments: REPRO,
      });

      const listed = await harness.client.callTool({
        name: "feedback_list_reports",
        arguments: { include_body: true },
      });

      expect(listed.isError).toBeFalsy();
      const out = listed.structuredContent as ListReportsOutput;
      expect(out.incidents).toHaveLength(1);
      expect(out.incidents[0]?.narrated).toBe(true);
      // The honest answer to "what are you sending about me?" has to work for
      // these too, or the notice on them is unbacked.
      expect(out.incidents[0]?.report?.narration?.outcome).toBe("gave_up");
    });

    it("strips what the model pasted, exactly as it strips a payload", async () => {
      await harness.client.callTool({
        name: "feedback_submit_report",
        arguments: {
          ...REPRO,
          diagnosis: `the call said ${PII_PROSE}`,
          observed: PII_PROSE,
        },
      });

      expect(sink.delivered).toHaveLength(1);
      expectNoPii(sink.delivered[0]);
    });

    it("files into the session when one is named", async () => {
      await harness.client.callTool({
        name: "feedback_submit_report",
        arguments: { ...REPRO, session_id: sessionId },
      });

      const listed = await harness.client.callTool({
        name: "feedback_list_reports",
        arguments: { session_id: sessionId },
      });
      const out = listed.structuredContent as ListReportsOutput;
      expect(out.incidents.map((i) => i.trigger)).toContain("MODEL_REPORTED");
    });

    it("refuses an incident_id with no session to authorise it", async () => {
      const result = await harness.client.callTool({
        name: "feedback_submit_report",
        arguments: {
          incident_id: "inc_whatever",
          diagnosis: "x",
          attempted: [],
          outcome: "fixed",
          suspected_cause: "unknown",
        },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: "validation_error" },
      });
    });

    it("refuses the two shapes half-mixed", async () => {
      const incidentId = await openIncident();

      const result = await harness.client.callTool({
        name: "feedback_submit_report",
        arguments: {
          session_id: sessionId,
          incident_id: incidentId,
          problem: "tool_failed",
          diagnosis: "x",
          attempted: [],
          outcome: "fixed",
          suspected_cause: "unknown",
        },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.structuredContent)).toContain("problem");
    });

    it("still needs a problem when there is no incident to answer", async () => {
      const result = await harness.client.callTool({
        name: "feedback_submit_report",
        arguments: {
          diagnosis: "something was wrong",
          attempted: [],
          outcome: "gave_up",
          suspected_cause: "unknown",
        },
      });

      expect(result.isError).toBe(true);
    });
  });
});
