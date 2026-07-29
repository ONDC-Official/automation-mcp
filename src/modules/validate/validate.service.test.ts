import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryCacheStore } from "@/lib/cache/in-memory-cache-store.js";
import { logger } from "@/lib/logger.js";
import type { ValidationLayer } from "@/modules/validate/validate.schema.js";
import {
  ValidateService,
  type CheckOutcome,
  type CheckRequest,
  type ValidationCheck,
  type ValidationMode,
} from "@/modules/validate/validate.service.js";
import {
  createFakeValidationGateway,
  invalidFrom,
  type FakeValidationGateway,
} from "@/test/fakes.js";
import { L0_MULTI_ENTRY, L1_MULTI_RULE } from "@/test/validation-fixtures.js";

let gateway: FakeValidationGateway;

function build(mode: ValidationMode = "enforce"): ValidateService {
  return new ValidateService({
    gateway,
    cache: new InMemoryCacheStore(),
    cacheTtlMs: 60_000,
    mode,
    logger,
  });
}

function payload(overrides: Record<string, unknown> = {}): CheckRequest {
  return {
    domain: "ONDC:TRV11",
    version: "2.0.1",
    action: "search",
    payload: { context: { action: "search", transaction_id: "t1" } },
    direction: "outbound",
    ...overrides,
  };
}

beforeEach(() => {
  gateway = createFakeValidationGateway();
});

describe("merging layers into one verdict", () => {
  it("reports valid, and says which layers that covers", async () => {
    const verdict = await build().validate(payload());

    expect(verdict.status).toBe("valid");
    expect(verdict.checked).toEqual(["L0", "L1"]);
    expect(verdict.findings).toEqual([]);
  });

  it("never lets a `valid` claim cover a layer nobody ran", async () => {
    // Two of the four layers are unbuilt. A verdict that did not say so would
    // read as a clean bill of health for the whole protocol.
    const verdict = await build().validate(payload());

    expect(verdict.unchecked.map((entry) => entry.layer)).toEqual([
      "context",
      "L2",
    ]);
    expect(verdict.unchecked[0]?.reason).toContain("no check is registered");
  });

  it("carries findings and the docs pointer through", async () => {
    gateway.setResult(invalidFrom(L1_MULTI_RULE));
    const verdict = await build().validate(payload());

    expect(verdict.status).toBe("invalid");
    expect(verdict.findings).toHaveLength(5);
    expect(verdict.docs_url).toContain("developer-guide");
  });

  it("answers unavailable — not valid — when nothing could be checked", async () => {
    gateway.setResult({ status: "unavailable", reason: "oracle was down" });
    const verdict = await build().validate(payload());

    expect(verdict.status).toBe("unavailable");
    expect(verdict.checked).toEqual([]);
    expect(verdict.unchecked).toContainEqual({
      layer: "L0",
      reason: "oracle was down",
    });
  });

  it("treats a check that throws as unavailable and keeps going", async () => {
    gateway.setThrows(new Error("boom"));
    const verdict = await build().validate(payload());

    // Not a rejection of the payload, and not an exception either — this runs
    // inside the receiver's ACK window.
    expect(verdict.status).toBe("unavailable");
    expect(verdict.findings).toEqual([]);
  });
});

describe("adding a layer", () => {
  /** The shape a future context or L2 check will take. */
  class StubCheck implements ValidationCheck {
    constructor(
      readonly name: string,
      readonly layers: readonly ValidationLayer[],
      private readonly outcome: CheckOutcome,
      private readonly skip?: string,
    ) {}
    skipReason(): string | undefined {
      return this.skip;
    }
    run(): Promise<CheckOutcome> {
      return Promise.resolve(this.outcome);
    }
  }

  it("is one register call, and the unchecked notice disappears", async () => {
    const service = build();
    service.register(
      new StubCheck("context", ["context"], { status: "pass" }),
    );

    const verdict = await service.validate(payload());

    expect(verdict.checked).toEqual(["L0", "L1", "context"]);
    // Only L2 is left unaccounted for — derived from the enum, not hardcoded.
    expect(verdict.unchecked.map((entry) => entry.layer)).toEqual(["L2"]);
  });

  it("lets a new layer fail the verdict on its own", async () => {
    const service = build();
    service.register(
      new StubCheck("context", ["context"], {
        status: "fail",
        findings: [
          {
            layer: "context",
            code: "STALE_TIMESTAMP",
            json_path: "$.context.timestamp",
            message: "outside the acceptable window",
          },
        ],
      }),
    );

    const verdict = await service.validate(payload());

    expect(verdict.status).toBe("invalid");
    expect(verdict.findings.map((f) => f.code)).toEqual(["STALE_TIMESTAMP"]);
  });

  it("keeps a known defect invalid even when another layer is unreachable", async () => {
    // A payload with a real fault is not improved by an unrelated outage.
    gateway.setResult({ status: "unavailable", reason: "down" });
    const service = build();
    service.register(
      new StubCheck("context", ["context"], {
        status: "fail",
        findings: [
          {
            layer: "context",
            code: "TTL_EXPIRED",
            json_path: "$.context.ttl",
            message: "expired",
          },
        ],
      }),
    );

    const verdict = await service.validate(payload());

    expect(verdict.status).toBe("invalid");
    expect(verdict.checked).toEqual(["context"]);
    expect(verdict.unchecked.map((e) => e.layer)).toEqual(["L0", "L1", "L2"]);
  });

  it("records a skipped layer as unchecked rather than passed", async () => {
    const service = build();
    service.register(
      new StubCheck(
        "context",
        ["context"],
        { status: "pass" },
        "the sensitiveTTL knob is off",
      ),
    );

    const verdict = await service.validate(payload());

    expect(verdict.checked).not.toContain("context");
    expect(verdict.unchecked).toContainEqual({
      layer: "context",
      reason: "the sensitiveTTL knob is off",
    });
  });
});

describe("mode", () => {
  it("enforce bites; advisory reports the same verdict but does not", async () => {
    gateway.setResult(invalidFrom(L0_MULTI_ENTRY));

    const enforcing = await build("enforce").validate(payload());
    const advising = await build("advisory").validate(payload());

    // The verdict is identical — only `enforces` differs. A transaction's
    // recorded findings must not depend on a deployment flag.
    expect(advising.status).toBe(enforcing.status);
    expect(advising.findings).toEqual(enforcing.findings);
    expect(build("enforce").enforces).toBe(true);
    expect(build("advisory").enforces).toBe(false);
  });

  it("off calls nobody at all", async () => {
    const verdict = await build("off").validate(payload());

    expect(gateway.calls.validate).toBe(0);
    expect(verdict.status).toBe("unavailable");
    expect(verdict.unchecked).toHaveLength(4);
  });
});

describe("caching", () => {
  it("judges identical bytes once", async () => {
    const service = build();
    await service.validate(payload());
    await service.validate(payload());

    expect(gateway.calls.validate).toBe(1);
  });

  it("does not share a verdict between different bodies", async () => {
    const service = build();
    await service.validate(payload());
    await service.validate(
      payload({ payload: { context: { transaction_id: "t2" } } }),
    );

    expect(gateway.calls.validate).toBe(2);
  });

  it("does not share a verdict between actions or directions", async () => {
    const service = build();
    await service.validate(payload());
    await service.validate(payload({ action: "select" }));
    await service.validate(payload({ direction: "inbound" }));

    expect(gateway.calls.validate).toBe(3);
  });

  it("never caches an outage, so it cannot outlive itself", async () => {
    gateway.setResult({ status: "unavailable", reason: "down" });
    const service = build();

    await service.validate(payload());
    gateway.setResult({ status: "valid" });
    const second = await service.validate(payload());

    expect(second.status).toBe("valid");
    expect(gateway.calls.validate).toBe(2);
  });
});
