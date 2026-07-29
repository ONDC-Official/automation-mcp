import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "@/config/env.js";
import { createContainer, type Container } from "@/container.js";
import { acceptsAction } from "@/test/mock-participant.js";

/**
 * The loop against a **real** published flow and its **real** mock config.
 * Skipped unless `RUN_LIVE_TESTS=1`, so the normal suite stays hermetic.
 *
 *     RUN_LIVE_TESTS=1 npm test -- flow.live
 *
 * The fixtures prove the loop works against a config we wrote. This proves it
 * works against one the ONDC team wrote — hundreds of kilobytes of real
 * generator JavaScript, with all its actual assumptions about what session data
 * contains. That is the class of failure fixtures structurally cannot catch:
 * a real `generate` reaching for a field our session data never supplies.
 *
 * The participant is still scripted. Only the config is live.
 */

const LIVE = process.env.RUN_LIVE_TESTS === "1";
const NP = "https://np.example.com";
const BUILD = {
  domain: "ONDC:FIS12",
  version: "2.0.3",
  usecase: "PERSONAL LOAN",
};

const config = parseConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });

let container: Container;
let agent: MockAgent;

beforeEach(async () => {
  if (!LIVE) return;
  agent = new MockAgent();
  agent.disableNetConnect();
  // No gateway override: this one really does reach the config-service.
  container = await createContainer(config, { senderDispatcher: agent });
});

afterEach(async () => {
  if (!LIVE) return;
  await container.dispose();
  await agent.close();
});

describe.skipIf(!LIVE)("the flow loop against a live config", () => {
  it("generates and sends a real first step", async () => {
    const created = await container.services.session.createSession({
      subscriber_url: NP,
      np_type: "BPP",
      ...BUILD,
    });
    const sessionId = created.session.session_id;

    // Pick a flow whose first step this mock owns, so one `flow_proceed`
    // exercises the real generator.
    const flow = created.flows.find(
      (candidate) => candidate.mock_steps > 0 && candidate.step_count > 1,
    );
    expect(flow, "no flow with a mock-owned step is published").toBeDefined();

    const started = await container.services.flow.start({
      sessionId,
      flowId: flow?.flow_id ?? "",
    });
    const transactionId = started.runtime.record.transactionId;

    const firstAction = started.runtime.flow.sequence[0]?.type ?? "search";
    const sent = acceptsAction(agent, NP, firstAction);

    const outcome = await container.services.flow.proceed({
      sessionId,
      transactionId,
      inputs: {},
    });

    // WAITING is legitimate — the flow may open with the participant's move.
    if (outcome.outcome === "WAITING") {
      expect(outcome.expected_action).toBe(firstAction);
      return;
    }

    expect(
      outcome.outcome,
      `expected SENT, got ${outcome.outcome}: ${outcome.message}`,
    ).toBe("SENT");

    const payload = sent.seen[0] as {
      context?: Record<string, string | undefined>;
    };
    expect(payload.context).toBeDefined();

    // The whole point: a real generator produced a real context, and none of
    // the config's canned identity survived into it.
    expect(payload.context?.["transaction_id"]).toBe(transactionId);
    expect(payload.context?.["domain"]).toBe(BUILD.domain);
    expect(payload.context?.["bap_uri"] ?? "").not.toContain("bap.example.com");
    expect(payload.context?.["bpp_uri"] ?? "").not.toContain("bpp.example.com");
  }, 60_000);
});
