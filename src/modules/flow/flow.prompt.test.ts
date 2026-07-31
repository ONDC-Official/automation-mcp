import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "@/test/harness.js";

/**
 * The prompts are the only place the *discipline* of the loop is written down,
 * so the things they must say are worth pinning. Each assertion here maps to a
 * failure mode seen in practice: polling instead of waiting, pulling whole
 * catalogs into context, and treating a NACK as a crash.
 */

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.close();
});

async function promptText(name: string): Promise<string> {
  const result = await harness.client.getPrompt({ name, arguments: {} });
  const [message] = result.messages;
  if (message?.content.type !== "text") {
    throw new Error("expected a text prompt message");
  }
  return message.content.text;
}

describe("flow prompts", () => {
  it("advertises both personas", async () => {
    const { prompts } = await harness.client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toEqual(
      expect.arrayContaining(["mock_buyer", "mock_seller"]),
    );
  });

  it.each(["mock_buyer", "mock_seller"])(
    "%s teaches the loop order and the tools by name",
    async (name) => {
      const text = await promptText(name);

      for (const tool of [
        "receiver_start",
        "session_create",
        "flow_start",
        "flow_proceed",
        "flow_await",
        "form_fetch",
        "record_get_data",
      ]) {
        expect(text, `${name} mentions ${tool}`).toContain(tool);
      }
    },
  );

  it.each(["mock_buyer", "mock_seller"])(
    "%s warns off the three failure modes",
    async (name) => {
      const text = await promptText(name);

      // Polling burns context and still misses callbacks.
      expect(text).toMatch(/Never poll/i);
      // A whole catalog evicts everything needed to finish the flow.
      expect(text).toContain("jsonpath");
      // The most informative result a compliance run produces.
      expect(text).toMatch(/NACK is a result/i);
    },
  );

  it("tells each persona which side it plays", async () => {
    const buyer = await promptText("mock_buyer");
    const seller = await promptText("mock_seller");

    expect(buyer).toContain("buyer app (BAP)");
    expect(buyer).toContain("You send `search`");
    expect(seller).toContain("seller app (BPP)");
    expect(seller).toContain("You send `on_search`");
  });

  it("explains the manual-step trigger, which is easy to get wrong", async () => {
    const text = await promptText("mock_buyer");
    expect(text).toContain(`inputs: {"id": "<step_key>"}`);
  });

  /**
   * The discipline the session journal made possible. A model that keeps
   * driving every step by hand still produces a correct run — just a far more
   * expensive one — so this has to be taught, not merely made available.
   */
  it.each(["mock_buyer", "mock_seller"])(
    "%s teaches the event-driven loop rather than a hand-driven one",
    async (name) => {
      const text = await promptText(name);

      // Steps that need nothing are already gone by the time you look.
      expect(text).toMatch(/send themselves/i);
      // The delivery channel, and the fact that it is one-shot.
      expect(text).toContain("events");
      expect(text).toMatch(/exactly once/i);
      expect(text).toContain("record_get_events");
      // Session-scope waiting is the idle behaviour, not run-scope polling.
      expect(text).toMatch(/wait on the session/i);
      // And the one event that means "you are now the blocker".
      expect(text).toContain("CHAIN_PAUSED");
      // The reporting loop: a model that never files a report leaves the
      // corpus with facts and no diagnosis, which is the half only it has.
      expect(text).toContain("ISSUE_OPEN");
      expect(text).toContain("feedback_submit_report");
      expect(text).toMatch(/tooling_gap/);
      // `\s+`, not a space: the prompt is hard-wrapped, so any phrase long
      // enough to be worth asserting on may carry a newline through its middle.
      expect(text).toMatch(/do not paste payload\s+values/i);
    },
  );
});
