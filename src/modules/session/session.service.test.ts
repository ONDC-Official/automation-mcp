import { describe, expect, it } from "vitest";
import { InMemoryCacheStore } from "@/lib/cache/in-memory-cache-store.js";
import { logger } from "@/lib/logger.js";
import { CatalogService } from "@/modules/catalog/catalog.service.js";
import { CacheSessionRepository } from "@/modules/session/session.repository.js";
import { SessionService } from "@/modules/session/session.service.js";
import type { CreateSessionInput } from "@/modules/session/session.schema.js";
import { createFakeConfigServiceGateway, FIXTURE_BUILD } from "@/test/fakes.js";

const SESSION_TTL_MS = 48 * 60 * 60 * 1000;

interface Subject {
  service: SessionService;
  clock: { value: number };
}

function subject(sessionTtlMs = SESSION_TTL_MS): Subject {
  const clock = { value: Date.parse("2026-07-27T10:00:00.000Z") };
  const cache = new InMemoryCacheStore({
    sweepIntervalMs: 0,
    now: () => clock.value,
  });
  const catalog = new CatalogService({
    gateway: createFakeConfigServiceGateway(),
    cache,
    cacheTtlMs: 60_000,
    logger,
  });

  return {
    clock,
    service: new SessionService({
      repository: new CacheSessionRepository(cache),
      catalog,
      sessionTtlMs,
      logger,
    }),
  };
}

function input(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    subscriber_url: "https://bap.example.com",
    np_type: "BAP",
    domain: FIXTURE_BUILD.domain,
    version: FIXTURE_BUILD.version,
    usecase: FIXTURE_BUILD.usecase,
    ...overrides,
  };
}

describe("creating a session", () => {
  /**
   * The load-bearing rule of the whole server: you can only test a participant
   * by being its counterparty. Callers never supply this, so it can never drift
   * from the participant's declared type.
   */
  it("makes the mock the opposite role of the participant under test", async () => {
    const { service } = subject();

    const asBap = await service.createSession(input({ np_type: "BAP" }));
    const asBpp = await service.createSession(input({ np_type: "BPP" }));

    expect(asBap.session.mock_role).toBe("BPP");
    expect(asBpp.session.mock_role).toBe("BAP");
  });

  it("returns the flows available for the build", async () => {
    const { service } = subject();
    const { flows, total } = await service.createSession(input());

    expect(total).toBe(flows.length);
    expect(total).toBeGreaterThan(0);
    expect(flows[0]?.flow_id).toBeTypeOf("string");
  });

  it("annotates flows from the mock's perspective, not the participant's", async () => {
    const { service } = subject();

    const againstBap = await service.createSession(input({ np_type: "BAP" }));
    const againstBpp = await service.createSession(input({ np_type: "BPP" }));

    const a = againstBap.flows[0];
    const b = againstBpp.flows.find((flow) => flow.flow_id === a?.flow_id);

    expect(a?.mock_steps).toBe(b?.np_steps);
  });

  it("records the participant and the build", async () => {
    const { service } = subject();
    const { session } = await service.createSession(
      input({ subscriber_id: "bap.example.com" }),
    );

    expect(session.np).toMatchObject({
      subscriber_url: "https://bap.example.com",
      subscriber_id: "bap.example.com",
      type: "BAP",
    });
    expect(session.build).toEqual(FIXTURE_BUILD);
  });

  it("rejects an unpublished build instead of opening an empty session", async () => {
    const { service } = subject();

    await expect(
      service.createSession(input({ usecase: "NOT A USE CASE" })),
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("issues a distinct id per session", async () => {
    const { service } = subject();

    const first = await service.createSession(input());
    const second = await service.createSession(input());

    expect(first.session.session_id).not.toBe(second.session.session_id);
  });
});

describe("resolving a session", () => {
  it("returns a session that is still live", async () => {
    const { service } = subject();
    const { session } = await service.createSession(input());

    await expect(
      service.requireSession(session.session_id),
    ).resolves.toMatchObject({ session_id: session.session_id });
  });

  it("reports an unknown id as not found", async () => {
    const { service } = subject();

    await expect(service.requireSession("nope")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("stops resolving once the session has expired", async () => {
    const { service, clock } = subject(1_000);
    const { session } = await service.createSession(input());

    clock.value += 1_001;

    await expect(
      service.requireSession(session.session_id),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("stamps expiry from the configured TTL", async () => {
    const { service } = subject(60_000);
    const now = new Date("2026-07-27T10:00:00.000Z");

    const { session } = await service.createSession(input(), now);

    expect(session.created_at).toBe("2026-07-27T10:00:00.000Z");
    expect(session.expires_at).toBe("2026-07-27T10:01:00.000Z");
  });
});
