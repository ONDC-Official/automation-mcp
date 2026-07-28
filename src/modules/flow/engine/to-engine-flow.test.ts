import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors.js";
import { UpstreamFlow } from "@/modules/catalog/catalog.schema.js";
import { toEngineFlow } from "@/modules/flow/engine/to-engine-flow.js";
import { FLOWS_RESPONSE } from "@/test/ondc-fixtures.js";

/**
 * The boundary between a loosely-parsed published flow and the strict shape the
 * engine replays. Every failure this can catch is one that would otherwise
 * surface mid-transaction as the loop waiting for a step it should have sent.
 */

function flow(overrides: Partial<UpstreamFlow> = {}): UpstreamFlow {
  return UpstreamFlow.parse({
    id: "f1",
    sequence: [{ key: "k1", type: "search", owner: "BAP" }],
    extraSequence: [],
    tags: [],
    ...overrides,
  });
}

describe("toEngineFlow", () => {
  it("fills the defaults upstream routinely omits", () => {
    const engine = toEngineFlow(flow());
    const [step] = engine.sequence;

    // The engine reads both on every step; upstream leaves both off.
    expect(step?.unsolicited).toBe(false);
    expect(step?.pair).toBeNull();
  });

  it("normalises a lower-case owner", () => {
    const engine = toEngineFlow(
      flow({ sequence: [{ key: "k1", type: "search", owner: "bap" }] }),
    );
    expect(engine.sequence[0]?.owner).toBe("BAP");
  });

  it("falls back to the mock config's owner when the flow omits one", () => {
    const engine = toEngineFlow(
      flow({ sequence: [{ key: "k1", type: "search" }] }),
      { ownerByKey: new Map([["k1", "BPP"]]) },
    );
    expect(engine.sequence[0]?.owner).toBe("BPP");
  });

  it("refuses a flow whose step has no owner anywhere", () => {
    // Loudly, at flow_start. An unowned step means the loop cannot tell whether
    // to send it or wait for it, and guessing wrong hangs the transaction.
    expect(() =>
      toEngineFlow(flow({ sequence: [{ key: "k1", type: "search" }] })),
    ).toThrow(ValidationError);

    try {
      toEngineFlow(flow({ sequence: [{ key: "k9", type: "select" }] }));
    } catch (error) {
      expect((error as ValidationError).details).toMatchObject({
        flow_id: "f1",
        step_key: "k9",
      });
    }
  });

  it("refuses an owner that is neither BAP nor BPP", () => {
    expect(() =>
      toEngineFlow(
        flow({ sequence: [{ key: "k1", type: "search", owner: "GATEWAY" }] }),
      ),
    ).toThrow(ValidationError);
  });

  it("carries the fields the engine branches on", () => {
    const engine = toEngineFlow(
      flow({
        sequence: [
          {
            key: "k1",
            type: "on_status",
            owner: "BPP",
            unsolicited: true,
            pair: "k2",
            expect: true,
            label: "Status update",
            force_proceed: true,
            repeat: 3,
            manual: true,
            input: [{ name: "amount" }],
          },
        ],
      }),
    );

    expect(engine.sequence[0]).toMatchObject({
      unsolicited: true,
      pair: "k2",
      expect: true,
      label: "Status update",
      force_proceed: true,
      repeat: 3,
      manual: true,
      input: [{ name: "amount" }],
    });
  });

  it("converts a real published flow end to end", () => {
    const published = UpstreamFlow.parse(FLOWS_RESPONSE.data.flows[0]);
    const engine = toEngineFlow(published);

    expect(engine.id).toBe("Personal_Loan_Offline");
    expect(engine.sequence).toHaveLength(published.sequence.length);
    for (const step of engine.sequence) {
      expect(["BAP", "BPP"]).toContain(step.owner);
      expect(typeof step.unsolicited).toBe("boolean");
    }
    expect(engine.extraSequence).toEqual([]);
  });
});
