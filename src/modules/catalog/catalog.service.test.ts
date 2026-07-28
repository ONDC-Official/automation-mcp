import { describe, expect, it } from "vitest";
import { InMemoryCacheStore } from "@/lib/cache/in-memory-cache-store.js";
import { logger } from "@/lib/logger.js";
import { CatalogService } from "@/modules/catalog/catalog.service.js";
import {
  actorFor,
  oppositeRole,
  summarizeFlow,
} from "@/modules/catalog/catalog.service.js";
import type { UpstreamFlow } from "@/modules/catalog/catalog.schema.js";
import {
  createFakeConfigServiceGateway,
  FIXTURE_BUILD,
  FIXTURE_FLOW_ID,
  type FakeConfigServiceGateway,
} from "@/test/fakes.js";

/**
 * Service-level tests: no MCP, no network. The gateway is a fake backed by
 * real captured config-service responses, so the shapes under test are the
 * shapes production sees.
 */

function subject(gateway?: FakeConfigServiceGateway): {
  service: CatalogService;
  gateway: FakeConfigServiceGateway;
} {
  const resolved = gateway ?? createFakeConfigServiceGateway();
  return {
    service: new CatalogService({
      gateway: resolved,
      cache: new InMemoryCacheStore({ sweepIntervalMs: 0 }),
      cacheTtlMs: 60_000,
      logger,
    }),
    gateway: resolved,
  };
}

describe("build validation", () => {
  it("accepts a published domain, version and use-case", async () => {
    const { service } = subject();
    await expect(service.assertBuild(FIXTURE_BUILD)).resolves.toBeUndefined();
  });

  /**
   * The trap this whole check exists for: the config-service answers an unknown
   * domain or use-case with `200 {"data":{"flows":[]}}`. Without validating
   * first, a typo is indistinguishable from a build that genuinely has no
   * flows, and the model has no way to recover.
   */
  it("rejects an unknown domain and names the valid ones", async () => {
    const { service } = subject();

    await expect(
      service.assertBuild({ ...FIXTURE_BUILD, domain: "ONDC:NOPE" }),
    ).rejects.toMatchObject({
      code: "validation_error",
      details: { valid_domains: expect.arrayContaining(["ONDC:FIS12"]) },
    });
  });

  it("rejects an unknown version and names the valid ones", async () => {
    const { service } = subject();

    await expect(
      service.assertBuild({ ...FIXTURE_BUILD, version: "9.9.9" }),
    ).rejects.toMatchObject({
      code: "validation_error",
      details: { valid_versions: expect.arrayContaining(["2.0.3"]) },
    });
  });

  it("rejects a use-case that differs only in case or spacing", async () => {
    const { service } = subject();

    await expect(
      service.assertBuild({ ...FIXTURE_BUILD, usecase: "personal loan" }),
    ).rejects.toMatchObject({
      code: "validation_error",
      details: { valid_usecases: expect.arrayContaining(["PERSONAL LOAN"]) },
    });
  });

  it("fetches the catalog once and serves the rest from cache", async () => {
    const { service, gateway } = subject();

    await service.assertBuild(FIXTURE_BUILD);
    await service.assertBuild(FIXTURE_BUILD);
    await service.listBuilds();

    expect(gateway.calls.builds).toBe(1);
  });
});

describe("flow listing", () => {
  it("counts steps by actor from the mock's point of view", async () => {
    const { service } = subject();

    const asBpp = await service.listFlows(FIXTURE_BUILD, "BPP");
    const asBap = await service.listFlows(FIXTURE_BUILD, "BAP");

    const bpp = asBpp.find((flow) => flow.flow_id === FIXTURE_FLOW_ID);
    const bap = asBap.find((flow) => flow.flow_id === FIXTURE_FLOW_ID);

    expect(bpp).toBeDefined();
    expect(bap).toBeDefined();
    // Ownership is a mirror: what one role must send, the other awaits.
    expect(bpp?.mock_steps).toBe(bap?.np_steps);
    expect(bpp?.np_steps).toBe(bap?.mock_steps);
    expect(bpp?.mock_steps).toBeGreaterThan(0);
  });

  it("summarises a flow with its action shape and form count", async () => {
    const { service } = subject();
    const flows = await service.listFlows(FIXTURE_BUILD, "BPP");
    const flow = flows.find((entry) => entry.flow_id === FIXTURE_FLOW_ID);

    expect(flow?.actions[0]).toBe("search");
    expect(flow?.step_count).toBe(flow?.actions.length);
    expect(flow?.form_steps).toBeGreaterThan(0);
  });

  it("caches flows per build", async () => {
    const { service, gateway } = subject();

    await service.listFlows(FIXTURE_BUILD, "BPP");
    await service.listFlows(FIXTURE_BUILD, "BPP");

    expect(gateway.calls.flows).toBe(1);
  });
});

describe("flow description", () => {
  it("tags every step with the actor responsible for it", async () => {
    const { service } = subject();
    const flow = await service.describeFlow(
      FIXTURE_BUILD,
      FIXTURE_FLOW_ID,
      "BPP",
    );

    const search = flow.sequence.find((step) => step.type === "search");
    const onSearch = flow.sequence.find((step) => step.type === "on_search");

    // A BAP-owned step is awaited by a mock BPP; its own on_search is not.
    expect(search?.actor).toBe("np");
    expect(onSearch?.actor).toBe("mock");
    expect(flow.mock_role).toBe("BPP");
  });

  it("carries the inputs a step needs", async () => {
    const { service } = subject();
    const flow = await service.describeFlow(
      FIXTURE_BUILD,
      FIXTURE_FLOW_ID,
      "BPP",
    );

    const withInputs = flow.sequence.filter((step) => step.inputs.length > 0);
    expect(withInputs.length).toBeGreaterThan(0);
    expect(withInputs[0]?.inputs[0]?.name).toBeTypeOf("string");
  });

  it("reports an unknown flow as not found, listing what exists", async () => {
    const { service } = subject();

    await expect(
      service.describeFlow(FIXTURE_BUILD, "No_Such_Flow", "BPP"),
    ).rejects.toMatchObject({
      code: "not_found",
      details: {
        available_flows: expect.arrayContaining([FIXTURE_FLOW_ID]),
      },
    });
  });
});

describe("mock-runner config", () => {
  it("summarises each step without returning the config itself", async () => {
    const { service } = subject();
    const summary = await service.loadMockConfig(
      FIXTURE_BUILD,
      FIXTURE_FLOW_ID,
      "BPP",
    );

    expect(summary.step_count).toBeGreaterThan(0);
    expect(summary.steps[0]?.has.generate).toBe(true);
    expect(summary.cache_key).toContain(FIXTURE_FLOW_ID);
    // The summary must never smuggle the base64 logic into the model's context.
    expect(JSON.stringify(summary)).not.toContain("function");
  });

  it("reads named inputs out of the nested {oldInputs} shape", async () => {
    const { service } = subject();
    const summary = await service.loadMockConfig(
      FIXTURE_BUILD,
      FIXTURE_FLOW_ID,
      "BPP",
    );

    const named = summary.steps.flatMap((step) => step.input_names);
    expect(named).toContain("form_submission_id");
    expect(named).not.toContain("oldInputs");
  });

  it("keeps the raw config server-side under the returned cache key", async () => {
    const { service, gateway } = subject();
    const summary = await service.loadMockConfig(
      FIXTURE_BUILD,
      FIXTURE_FLOW_ID,
      "BPP",
    );

    const cached = await service.getCachedMockConfig(summary.cache_key);
    expect(cached?.steps.length).toBe(summary.step_count);

    await service.loadMockConfig(FIXTURE_BUILD, FIXTURE_FLOW_ID, "BPP");
    expect(gateway.calls.mockConfig).toBe(1);
  });

  it("reports an unknown flow as not found", async () => {
    const { service } = subject();

    await expect(
      service.loadMockConfig(FIXTURE_BUILD, "No_Such_Flow", "BPP"),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("pure helpers", () => {
  it("inverts roles", () => {
    expect(oppositeRole("BAP")).toBe("BPP");
    expect(oppositeRole("BPP")).toBe("BAP");
  });

  it("classifies ownership, tolerating case and unknown owners", () => {
    expect(actorFor("bpp", "BPP")).toBe("mock");
    expect(actorFor("BAP", "BPP")).toBe("np");
    expect(actorFor(undefined, "BPP")).toBe("unknown");
    // An owner we cannot interpret must not be guessed into a side: guessing
    // wrong makes the model either wait forever or talk over the counterparty.
    expect(actorFor("GATEWAY", "BPP")).toBe("unknown");
  });

  it("summarises a flow with no steps without dividing by zero", () => {
    const empty: UpstreamFlow = {
      id: "empty",
      sequence: [],
      extraSequence: [],
      tags: [],
    };

    expect(summarizeFlow(empty, "BPP")).toMatchObject({
      step_count: 0,
      mock_steps: 0,
      np_steps: 0,
      has_extra_sequence: false,
      description: "",
    });
  });
});
