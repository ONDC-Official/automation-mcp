import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "@/test/harness.js";

/**
 * What the model can actually see, per profile.
 *
 * This is the test for the gap `config/features.ts` was written to close: the
 * optional modules were always *constructed* and merely made inert, so
 * `FEEDBACK_DISABLED=1` left `feedback_submit_report` advertised to the model
 * while doing nothing. A tool that is present and inert is worse than absent —
 * the model calls it and reasons about the silence.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function toolNames(env?: Record<string, string>): Promise<string[]> {
  harness = await createHarness(env ? { env } : {});
  const { tools } = await harness.client.listTools();
  return tools.map((tool) => tool.name).sort();
}

describe("the default profile", () => {
  it("advertises every tool, so nothing changed for existing deployments", async () => {
    const names = await toolNames();
    expect(names).toEqual([
      "catalog_describe_flow",
      "catalog_list_builds",
      "catalog_list_flows",
      "catalog_load_flow_config",
      "feedback_list_reports",
      "feedback_submit_report",
      "flow_await",
      "flow_get_status",
      "flow_proceed",
      "flow_restart",
      "flow_start",
      "form_fetch",
      "form_submit",
      "payload_validate",
      "protocol_describe_action",
      "protocol_describe_build",
      "protocol_explain_rule",
      "protocol_list_error_codes",
      "protocol_next_actions",
      "protocol_search_fields",
      "protocol_search_knowledge",
      "receiver_start",
      "receiver_stop",
      "record_get_data",
      "record_get_events",
      "record_get_payload",
      "session_create",
      "session_get",
    ]);
  });
});

describe("PROFILE=minimal", () => {
  it("drops the feedback tools and keeps the loop", async () => {
    const names = await toolNames({ PROFILE: "minimal" });

    expect(names).not.toContain("feedback_submit_report");
    expect(names).not.toContain("feedback_list_reports");

    // The loop itself is untouched — a narrowed profile still drives a flow.
    expect(names).toEqual(
      expect.arrayContaining([
        "session_create",
        "flow_start",
        "flow_proceed",
        "flow_await",
        "record_get_events",
      ]),
    );
  });
});

describe("the existing flags now reach the tool list", () => {
  it("FEEDBACK_DISABLED removes the feedback tools", async () => {
    const names = await toolNames({ FEEDBACK_DISABLED: "1" });
    expect(names).not.toContain("feedback_submit_report");
    expect(names).not.toContain("feedback_list_reports");
    expect(names).toContain("flow_proceed");
  });

  it("MODULES_DISABLED removes one module's tools and nothing else", async () => {
    const names = await toolNames({ MODULES_DISABLED: "validate" });
    expect(names).not.toContain("payload_validate");
    expect(names).toContain("flow_proceed");
    expect(names).toContain("session_create");
  });
});

describe("the model is never told about a tool that is not there", () => {
  it("omits the feedback sentence when feedback is off", async () => {
    harness = await createHarness({ env: { PROFILE: "minimal" } });
    const instructions = harness.client.getInstructions();
    expect(instructions).not.toMatch(/feedback_submit_report/);
    // The persona survives — only the tool-naming sentences are gated.
    expect(instructions).toMatch(/mock ONDC network participant/);
  });

  it("keeps it on the default profile", async () => {
    harness = await createHarness();
    expect(harness.client.getInstructions()).toMatch(/feedback_submit_report/);
  });

  /*
   * The viewer paragraph is the only always-on channel that tells the model to
   * hand the link over — a prompt is opt-in and a tool description is read
   * once. It is gated on exactly the condition under which `viewerUrl` returns
   * a URL, so the preamble can never instruct a model to state a field that
   * will not be there.
   */
  it("tells the model to hand out viewer_url when the viewer is on", async () => {
    harness = await createHarness();
    const instructions = harness.client.getInstructions();
    expect(instructions).toMatch(/viewer_url/);
    expect(instructions).toMatch(/before your turn ends/);
  });

  it("omits the viewer sentence when the viewer is off", async () => {
    harness = await createHarness({ env: { UI_ENABLED: "0" } });
    const instructions = harness.client.getInstructions();
    expect(instructions).not.toMatch(/viewer_url/);
    // The persona survives — only the viewer sentences are gated.
    expect(instructions).toMatch(/mock ONDC network participant/);
  });
});
