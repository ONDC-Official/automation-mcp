import { describe, expect, it } from "vitest";
import { HealthService } from "@/modules/health/health.service.js";

describe("HealthService", () => {
  it("uses a check's own time limit over the default", async () => {
    const service = new HealthService(
      [
        {
          name: "slow",
          timeoutMs: 5,
          check: () => new Promise<void>(() => undefined),
        },
      ],
      60_000,
    );

    const report = await service.readiness();

    expect(report.checks[0]?.error).toBe("timed out after 5ms");
  });

  it("reports a disabled check without degrading the verdict", async () => {
    const service = new HealthService([
      { name: "off", check: () => Promise.resolve("disabled" as const) },
    ]);

    const report = await service.readiness();

    expect(report.status).toBe("ready");
    expect(report.checks[0]?.status).toBe("disabled");
  });
});
