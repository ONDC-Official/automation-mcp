import { afterEach, describe, expect, it } from "vitest";
import { logger } from "@/lib/logger.js";
import { MockEngine } from "@/lib/mock-engine/mock-engine.js";
import type { MockPlaygroundConfigType } from "@ondc/automation-mock-runner";
import { MockRunner } from "@ondc/automation-mock-runner";
import {
  buildRunnableMockConfig,
  RUNNABLE_FLOW_ID,
} from "@/test/runnable-config.js";

/**
 * The mock engine is the one place where **untrusted config JavaScript
 * actually runs**, in a worker thread, and every test here does a real round
 * trip through that worker. Stubbing the runner would test nothing worth
 * testing: the failure modes that matter (a function that throws, a function
 * that returns the wrong shape, a pool that never shuts down) only exist on the
 * real path.
 */

const CONFIG = buildRunnableMockConfig(
  RUNNABLE_FLOW_ID,
) as unknown as MockPlaygroundConfigType;

const engines: MockEngine[] = [];

function createEngine(now?: () => number): MockEngine {
  const engine = new MockEngine({
    logger,
    allowedFetchBaseUrls: [],
    idleTtlMs: 300_000,
    ...(now ? { now } : {}),
  });
  engines.push(engine);
  return engine;
}

afterEach(() => {
  // A leaked worker pool keeps the whole vitest process alive.
  while (engines.length > 0) engines.pop()?.dispose();
});

describe("MockEngine", () => {
  it("runs a step's generate function against session data", async () => {
    const engine = createEngine();
    const runner = engine.getRunner("cfg", CONFIG);

    const outcome = await engine.runGenerate(runner, "search_1", {
      transaction_id: "txn-42",
      bapId: "mock.local",
      bapUri: "http://127.0.0.1:3001/ONDC:RET10/2.0.2/buyer",
      user_inputs: { query: "personal loan" },
    });

    expect(outcome.ok).toBe(true);
    const payload = outcome.result as {
      context: Record<string, string>;
      message: { intent: { descriptor: { name: string } } };
    };
    expect(payload.message.intent.descriptor.name).toBe("personal loan");

    // Identity must come from the session, not the config's canned fixture —
    // otherwise every generated payload claims to be bap.example.com.
    expect(payload.context.transaction_id).toBe("txn-42");
    expect(payload.context.bap_uri).toBe(
      "http://127.0.0.1:3001/ONDC:RET10/2.0.2/buyer",
    );
    expect(payload.context.action).toBe("search");
  });

  it("returns a step's validate verdict", async () => {
    const engine = createEngine();
    const runner = engine.getRunner("cfg", CONFIG);

    const good = await engine.runValidate(
      runner,
      "on_search_1",
      { message: { catalog: { providers: [] } } },
      {},
    );
    expect(good.ok).toBe(true);
    expect(good.result?.valid).toBe(true);

    const bad = await engine.runValidate(
      runner,
      "on_search_1",
      { message: {} },
      {},
    );
    expect(bad.ok).toBe(true);
    expect(bad.result?.valid).toBe(false);
    expect(bad.result?.description).toContain("catalog");
  });

  it("reports a blocking requirements verdict", async () => {
    const engine = createEngine();
    const runner = engine.getRunner("cfg", CONFIG);

    const blocked = await engine.runRequirements(runner, "select_1", {});
    expect(blocked.result?.valid).toBe(false);

    const ready = await engine.runRequirements(runner, "select_1", {
      providerId: ["provider-1"],
    });
    expect(ready.result?.valid).toBe(true);
  });

  it("surfaces a thrown config function as ok:false rather than throwing", async () => {
    const engine = createEngine();
    const broken = {
      ...CONFIG,
      steps: [
        {
          ...CONFIG.steps[0],
          mock: {
            ...CONFIG.steps[0]?.mock,
            generate: MockRunner.encodeBase64(
              `async function generate(defaultPayload, sessionData) {
                 throw new Error("the config author made a mistake");
               }`,
            ),
          },
        },
      ],
    } as MockPlaygroundConfigType;

    const runner = engine.getRunner("broken", broken);
    const outcome = await engine.runGenerate(runner, "search_1", {});

    expect(outcome.ok).toBe(false);
    expect(outcome.error?.message).toContain(
      "the config author made a mistake",
    );
  });

  it("treats a contract-violating return as a failure too", async () => {
    // `validate` must answer {valid, code, description}. A config that returns
    // only `valid` is a bug the caller has to see, not silently accept.
    const engine = createEngine();
    const sloppy = {
      ...CONFIG,
      steps: [
        {
          ...CONFIG.steps[0],
          mock: {
            ...CONFIG.steps[0]?.mock,
            validate: MockRunner.encodeBase64(
              `function validate(targetPayload, sessionData) {
                 return { valid: true };
               }`,
            ),
          },
        },
      ],
    } as MockPlaygroundConfigType;

    const runner = engine.getRunner("sloppy", sloppy);
    const outcome = await engine.runValidate(runner, "search_1", {}, {});

    expect(outcome.ok).toBe(false);
    expect(outcome.error?.message).toMatch(/code|description/);
  });

  it("evaluates an EVAL# save expression", async () => {
    const engine = createEngine();
    const outcome = await engine.runGetSave(
      { message: { order: { items: [{ id: "a" }, { id: "b" }] } } },
      MockRunner.encodeBase64(
        `function getSave(payload) {
           return payload.message.order.items.map(function (i) { return i.id; });
         }`,
      ),
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual(["a", "b"]);
  });

  it("reuses one runner per config and evicts it once idle", () => {
    let clock = 1_000;
    const engine = new MockEngine({
      logger,
      allowedFetchBaseUrls: [],
      idleTtlMs: 60_000,
      now: () => clock,
    });
    engines.push(engine);

    const first = engine.getRunner("cfg", CONFIG);
    expect(engine.getRunner("cfg", CONFIG)).toBe(first);
    expect(engine.size()).toBe(1);

    clock += 60_001;
    // The sweep runs on access; a fresh instance is built for the same key.
    expect(engine.getRunner("cfg", CONFIG)).not.toBe(first);
    expect(engine.size()).toBe(1);
  });

  it("refuses to run after dispose", () => {
    const engine = createEngine();
    engine.getRunner("cfg", CONFIG);
    engine.dispose();

    expect(() => engine.getRunner("cfg", CONFIG)).toThrow(/shut down/);
    // Disposing twice must not throw — it runs on every shutdown path.
    expect(() => {
      engine.dispose();
    }).not.toThrow();
  });
});
