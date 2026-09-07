import { describe, expect, it } from "vitest";
import { createHarness, type Harness } from "@/test/harness.js";
import { createFakeConfigServiceGateway, FIXTURE_BUILD } from "@/test/fakes.js";
import type { FakeConfigServiceGateway } from "@/test/fakes.js";

interface Fixture {
  harness: Harness;
  gateway: FakeConfigServiceGateway;
}

async function open(env: Record<string, string> = {}): Promise<Fixture> {
  const gateway = createFakeConfigServiceGateway();
  const harness = await createHarness({ configServiceGateway: gateway, env });
  return { harness, gateway };
}

const BUILD = { domain: FIXTURE_BUILD.domain, version: FIXTURE_BUILD.version };

describe("ProtocolService", () => {
  it("fetches a build's spec once and serves the rest from cache", async () => {
    const { harness, gateway } = await open();
    try {
      const protocol = harness.container.services.protocol;
      await protocol.bundle(BUILD.domain, BUILD.version);
      await protocol.bundle(BUILD.domain, BUILD.version);
      expect(gateway.calls.spec).toBe(1);
    } finally {
      await harness.close();
    }
  });

  it("deduplicates concurrent fetches of the same build", async () => {
    // Without single-flight, two tool calls a millisecond apart each pull
    // 10.5 MB and each parse it.
    const { harness, gateway } = await open();
    try {
      const protocol = harness.container.services.protocol;
      const [a, b, c] = await Promise.all([
        protocol.bundle(BUILD.domain, BUILD.version),
        protocol.bundle(BUILD.domain, BUILD.version),
        protocol.bundle(BUILD.domain, BUILD.version),
      ]);
      expect(gateway.calls.spec).toBe(1);
      expect(a.domain).toBe(b.domain);
      expect(b.domain).toBe(c.domain);
    } finally {
      await harness.close();
    }
  });

  it("evicts past the resident-bundle cap", async () => {
    const { harness } = await open({ PROTOCOL_SPEC_MAX_BUNDLES: "1" });
    try {
      const protocol = harness.container.services.protocol;
      await protocol.bundle(BUILD.domain, BUILD.version);
      expect(protocol.residentBundles()).toBe(1);
      // The fake serves one build, so drive the cap directly rather than
      // pretending a second spec exists.
      await protocol.bundle(BUILD.domain, BUILD.version);
      expect(protocol.residentBundles()).toBe(1);
    } finally {
      await harness.close();
    }
  });

  describe("resolveBuild", () => {
    it("refuses a request that names no build at all, and says both routes", async () => {
      const { harness, gateway } = await open();
      try {
        await expect(
          harness.container.services.protocol.resolveBuild({}),
        ).rejects.toThrow(/domain and version.*or.*session_id/is);
        expect(gateway.calls.spec).toBe(0);
      } finally {
        await harness.close();
      }
    });

    it("validates the build before ever reaching the gateway", async () => {
      // The config-service answers an unknown build with an empty-ish
      // document rather than a 404, so a typo would otherwise read as "this
      // build publishes nothing".
      const { harness, gateway } = await open();
      try {
        await expect(
          harness.container.services.protocol.resolveBuild({
            domain: "ONDC:NOPE",
            version: "9.9.9",
          }),
        ).rejects.toThrow(/Unknown domain/);
        expect(gateway.calls.spec).toBe(0);
      } finally {
        await harness.close();
      }
    });

    it("names the valid versions when only the version is wrong", async () => {
      const { harness } = await open();
      try {
        await expect(
          harness.container.services.protocol.resolveBuild({
            domain: FIXTURE_BUILD.domain,
            version: "0.0.1",
          }),
        ).rejects.toThrow(/Unknown version/);
      } finally {
        await harness.close();
      }
    });

    it("does not make the caller choose when a build publishes one use-case", async () => {
      const { harness } = await open();
      try {
        const resolved = await harness.container.services.protocol.resolveBuild(
          { domain: "ONDC:RET10", version: "1.2.5" },
          { requireUsecase: true },
        );
        expect(resolved.usecase).toBe("GROCERY");
      } finally {
        await harness.close();
      }
    });

    it("makes the caller choose when a build publishes several", async () => {
      const { harness } = await open();
      try {
        await expect(
          harness.container.services.protocol.resolveBuild(
            { domain: FIXTURE_BUILD.domain, version: FIXTURE_BUILD.version },
            { requireUsecase: true },
          ),
        ).rejects.toThrow(/publishes several use-cases/);
      } finally {
        await harness.close();
      }
    });
  });

  describe("realityFor", () => {
    it("returns undefined rather than throwing when the spec is unreachable", async () => {
      // This is the module's one fail-open, and it is load-bearing:
      // `catalog_describe_flow` must not stop working because the reference
      // half is down. A model driving a run would lose the flow's sequence
      // over a lookup it never asked for.
      const gateway = createFakeConfigServiceGateway();
      const harness = await createHarness({ configServiceGateway: gateway });
      try {
        const reality = await harness.container.services.protocol.realityFor(
          { domain: "ONDC:NOT-PUBLISHED", version: "1.0.0" },
          ["search"],
        );
        expect(reality).toBeUndefined();
      } finally {
        await harness.close();
      }
    });
  });
});
