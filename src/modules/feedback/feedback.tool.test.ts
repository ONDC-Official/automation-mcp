import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "@/test/harness.js";
import { NoopSink } from "@/modules/feedback/feedback.sink.js";
import { RUNNABLE_BUILD } from "@/test/runnable-config.js";
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

  it("says so when the model's claim disagrees with the run", async () => {
    // The model says it gave up; the run is still open. Both are kept, and the
    // disagreement is itself the finding.
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
});
