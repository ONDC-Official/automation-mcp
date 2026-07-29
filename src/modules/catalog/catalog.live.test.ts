import { describe, expect, it } from "vitest";
import { parseConfig } from "@/config/env.js";
import { InMemoryCacheStore } from "@/lib/cache/in-memory-cache-store.js";
import { logger } from "@/lib/logger.js";
import { HttpConfigServiceGateway } from "@/modules/catalog/catalog.gateway.js";
import { CatalogService } from "@/modules/catalog/catalog.service.js";

/**
 * Contract test against the **real** config-service. Skipped unless
 * `RUN_LIVE_TESTS=1`, so the normal suite stays hermetic and fast.
 *
 *     RUN_LIVE_TESTS=1 npm test -- catalog.live
 *
 * Its job is to catch the one class of bug the fixtures cannot: the upstream
 * service changing shape underneath us. Assertions stay deliberately loose
 * about data that legitimately moves (which flows exist, how many domains are
 * published) and strict about structure.
 */

const LIVE = process.env.RUN_LIVE_TESTS === "1";
const TIMEOUT_MS = 30_000;

const BUILD = {
  domain: "ONDC:FIS12",
  version: "2.0.3",
  usecase: "PERSONAL LOAN",
};

function liveService(): CatalogService {
  const config = parseConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });
  return new CatalogService({
    gateway: new HttpConfigServiceGateway({
      baseUrl: config.CONFIG_SERVICE_URL,
      timeoutMs: config.CONFIG_SERVICE_TIMEOUT_MS,
      logger,
    }),
    cache: new InMemoryCacheStore({ sweepIntervalMs: 0 }),
    cacheTtlMs: 60_000,
    logger,
  });
}

describe.skipIf(!LIVE)("live config-service", () => {
  it(
    "publishes the domain, version and use-case we build against",
    async () => {
      const service = liveService();

      await expect(service.assertBuild(BUILD)).resolves.toBeUndefined();

      const builds = await service.listBuilds(BUILD.domain);
      expect(builds).toHaveLength(1);
    },
    TIMEOUT_MS,
  );

  it(
    "still rejects an unknown use-case rather than returning an empty list",
    async () => {
      const service = liveService();

      await expect(
        service.assertBuild({ ...BUILD, usecase: "personal loan" }),
      ).rejects.toMatchObject({ code: "validation_error" });
    },
    TIMEOUT_MS,
  );

  it(
    "returns flows whose steps carry the fields we annotate",
    async () => {
      const service = liveService();
      const flows = await service.listFlows(BUILD, "BPP");

      expect(flows.length).toBeGreaterThan(0);
      const flow = flows[0];
      expect(flow?.step_count).toBeGreaterThan(0);
      // If ownership stops arriving, every step would silently become
      // "unknown" and the model could no longer tell send from await.
      expect((flow?.mock_steps ?? 0) + (flow?.np_steps ?? 0)).toBeGreaterThan(
        0,
      );

      const detail = await service.describeFlow(
        BUILD,
        flow?.flow_id ?? "",
        "BPP",
      );
      expect(detail.sequence.every((step) => step.actor !== "unknown")).toBe(
        true,
      );
    },
    TIMEOUT_MS,
  );

  it(
    "serves a mock-runner config carrying executable step logic",
    async () => {
      const service = liveService();
      const flows = await service.listFlows(BUILD, "BPP");
      const flowId = flows[0]?.flow_id ?? "";

      const summary = await service.loadMockConfig(BUILD, flowId, "BPP");

      expect(summary.step_count).toBeGreaterThan(0);
      expect(summary.steps.some((step) => step.has.generate)).toBe(true);
      // These configs are hundreds of KB; that is exactly why tools only ever
      // return this summary.
      expect(summary.total_bytes).toBeGreaterThan(10_000);
    },
    TIMEOUT_MS,
  );
});
