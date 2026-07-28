import { describe, expect, it } from "vitest";
import type {
  EngineSequenceStep,
  FlowStatusCode,
  Owner,
  StepStatus,
} from "@/modules/flow/engine/engine-types.js";
import { buildPendingStep } from "@/modules/flow/engine/pending-step.js";

/**
 * The status truth table, stated once as data.
 *
 * `flow-mapper.test.ts` exercises these statuses through full replays, which is
 * the right level for behaviour but a poor place to *read* the rule. This table
 * is the rule itself: given a step, who owns it, and whether a dispatch is
 * already in flight, exactly one status follows. If a row here changes, the
 * loop changes.
 */

const NP: Owner = "BPP";

function step(overrides: Partial<EngineSequenceStep> = {}): EngineSequenceStep {
  return {
    key: "k1",
    type: "search",
    owner: "BAP",
    unsolicited: false,
    pair: null,
    ...overrides,
  };
}

interface Row {
  name: string;
  step: EngineSequenceStep;
  isImmediateNext?: boolean;
  flowStatus?: FlowStatusCode;
  expected: StepStatus;
}

// `subscriberType` is the participant under test (BPP here), so a BPP-owned
// step is one we wait for and a BAP-owned step is one we send.
const ROWS: Row[] = [
  {
    name: "a step past the cursor is simply not reached",
    step: step(),
    isImmediateNext: false,
    expected: "WAITING",
  },
  {
    name: "the NP owns it — arm an expectation and listen",
    step: step({ owner: NP, type: "on_search" }),
    expected: "LISTENING",
  },
  {
    name: "ours, plain — send it now",
    step: step(),
    expected: "RESPONDING",
  },
  {
    name: "ours, declares inputs — blocked on a value",
    step: step({ input: [{ name: "amount" }] }),
    expected: "INPUT-REQUIRED",
  },
  {
    name: "ours with inputs, dispatch already in flight — not offered twice",
    step: step({ input: [{ name: "amount" }] }),
    flowStatus: "WORKING",
    expected: "RESPONDING",
  },
  {
    name: "ours, manual — blocked on an explicit trigger",
    step: step({ manual: true }),
    expected: "INPUT-REQUIRED",
  },
  {
    name: "ours, unsolicited — auto-triggered, still gated through an input",
    step: step({ unsolicited: true }),
    expected: "INPUT-REQUIRED",
  },
  {
    name: "manual beats unsolicited — an explicit trigger is still required",
    step: step({ manual: true, unsolicited: true }),
    expected: "INPUT-REQUIRED",
  },
  {
    name: "form the NP hosts — we fetch and submit it",
    step: step({ type: "HTML_FORM", owner: NP }),
    expected: "INPUT-REQUIRED",
  },
  {
    name: "form the NP hosts, submission in flight",
    step: step({ type: "HTML_FORM", owner: NP }),
    flowStatus: "WORKING",
    expected: "PROCESSING",
  },
  {
    name: "form we host — the NP submits it",
    step: step({ type: "DYNAMIC_FORM", owner: "BAP" }),
    expected: "WAITING-SUBMISSION",
  },
  {
    name: "form we host, already being served",
    step: step({ type: "DYNAMIC_FORM", owner: "BAP" }),
    flowStatus: "WORKING",
    expected: "RESPONDING",
  },
];

describe("buildPendingStep truth table", () => {
  it.each(ROWS)("$name → $expected", (row) => {
    const [result, ...rest] = buildPendingStep({
      step: row.step,
      index: 0,
      isImmediateNext: row.isImmediateNext ?? true,
      subscriberType: NP,
      flowStatus: row.flowStatus ?? "AVAILABLE",
    });

    expect(rest).toEqual([]);
    expect(result?.status).toBe(row.expected);
  });

  it("gives a manual step a trigger input naming its own action", () => {
    const [result] = buildPendingStep({
      step: step({ manual: true, key: "confirm_1" }),
      index: 0,
      isImmediateNext: true,
      subscriberType: NP,
      flowStatus: "AVAILABLE",
    });

    // The gate is the point: the caller has to name the step to fire it, so a
    // manual step can never go out as a side effect of a generic "proceed".
    expect(result?.input).toEqual([
      expect.objectContaining({ name: "manual_id", type: "manual_id" }),
    ]);
    const schema = result?.input?.[0]?.schema as {
      properties: { id: { enum: string[] } };
    };
    expect(schema.properties.id.enum).toEqual(["confirm_1"]);
  });

  it("gives an unsolicited step an empty input so it auto-fires", () => {
    const [result] = buildPendingStep({
      step: step({ unsolicited: true }),
      index: 0,
      isImmediateNext: true,
      subscriberType: NP,
      flowStatus: "AVAILABLE",
    });

    expect(result?.input).toEqual([]);
  });

  it("defaults repeat to 1 when the flow omits it", () => {
    const [result] = buildPendingStep({
      step: step(),
      index: 3,
      isImmediateNext: true,
      subscriberType: NP,
      flowStatus: "AVAILABLE",
    });

    expect(result?.repeat).toBe(1);
    expect(result?.index).toBe(3);
  });
});
