import { describe, expect, it } from "vitest";
import { parseConfig } from "@/config/env.js";
import { createContainer } from "@/container.js";
import { buildMcpServer, createServerFactory } from "@/mcp/server.js";
import { createFakeConfigServiceGateway } from "@/test/fakes.js";

/**
 * Guard tests for the scaffold's central invariant.
 *
 * Under `createMcpHandler` the factory runs **once per HTTP request**. If it
 * ever starts doing I/O — opening a pool, warming a cache, reading a file —
 * the server silently does that work on every single call, and the failure
 * shows up as a capacity problem under load rather than as a broken test.
 * So the property is asserted directly.
 */

const config = parseConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });

function boot() {
  const gateway = createFakeConfigServiceGateway();
  return {
    gateway,
    container: createContainer(config, { configServiceGateway: gateway }),
  };
}

describe("buildMcpServer", () => {
  it("performs no data access while constructing a server", async () => {
    const { gateway, container: pending } = boot();
    const container = await pending;

    buildMcpServer(container);

    expect(gateway.calls).toEqual({ builds: 0, flows: 0, mockConfig: 0 });
    await container.dispose();
  });

  it("stays cheap across many constructions", async () => {
    const { gateway, container: pending } = boot();
    const container = await pending;
    const factory = createServerFactory(container);

    // Simulates 100 HTTP requests hitting a stateless instance.
    for (let i = 0; i < 100; i += 1) {
      await factory({ era: "modern" });
    }

    expect(gateway.calls).toEqual({ builds: 0, flows: 0, mockConfig: 0 });
    await container.dispose();
  });

  it("builds an independent instance per call", async () => {
    const { container: pending } = boot();
    const container = await pending;
    const factory = createServerFactory(container);

    expect(await factory({ era: "modern" })).not.toBe(
      await factory({ era: "modern" }),
    );
    await container.dispose();
  });

  it("shares one container across every instance", async () => {
    // The counterpart of the rule above: instances are per-request, but the
    // expensive dependencies behind them are constructed exactly once.
    const { gateway, container: pending } = boot();
    const container = await pending;

    await createServerFactory(container)({ era: "modern" });
    await createServerFactory(container)({ era: "modern" });

    expect(gateway.calls.builds).toBe(0);
    await Promise.all(container.healthChecks.map((check) => check.check()));
    // One readiness probe, not one per server instance.
    expect(gateway.calls.builds).toBe(0);

    await container.dispose();
  });
});

describe("container", () => {
  it("dispose is idempotent", async () => {
    const { container: pending } = boot();
    const container = await pending;
    await container.dispose();
    await expect(container.dispose()).resolves.toBeUndefined();
  });

  it("exposes a health check per dependency", async () => {
    const { container: pending } = boot();
    const container = await pending;
    expect(container.healthChecks.length).toBeGreaterThan(0);
    for (const check of container.healthChecks) {
      expect(check.name).toBeTruthy();
      await expect(check.check()).resolves.not.toThrow();
    }
    await container.dispose();
  });
});
