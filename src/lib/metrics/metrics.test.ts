import { describe, expect, it } from "vitest";
import { boundedLabel, createMetrics } from "@/lib/metrics/metrics.js";

/**
 * Three properties, and each of them is a regression that has a shape.
 *
 * 1. **Two registries in one process do not collide.** prom-client's default
 *    `register` is process-wide, and the second `new Counter` against it throws
 *    `A metric with the name … has already been registered`. Vitest builds many
 *    containers per file, so the failure would land on the second test rather
 *    than the guilty one.
 * 2. **`boundedLabel` folds.** The cap is what stands between a participant with
 *    a novel rule code and a scrape that times out.
 * 3. **No instrument carries an unbounded identifier as a label.** This one is
 *    the guard rail, not the unit test: it reads the whole registry rather than
 *    the instruments this file happens to remember, so a metric added next year
 *    with `transaction_id` on it fails here on the day it is written.
 */

/**
 * Labels that must never exist, on any instrument, ever.
 *
 * Every one is per-transaction or per-participant, so each distinct value is a
 * new time series that lives forever in the scrape. A single flow run would mint
 * a handful; a day of runs would mint thousands.
 */
const FORBIDDEN_LABELS = [
  "transaction_id",
  "session_id",
  "message_id",
  "payload_id",
  "subscriber_url",
  "report_id",
];

describe("createMetrics", () => {
  it("builds two independent registries in one process", async () => {
    // The global-registry regression, reproduced as directly as it can be: if
    // either call reached prom-client's default `register`, the second would
    // throw on the first duplicate name.
    const first = createMetrics();
    const second = createMetrics();

    first.sessionsCreated.inc({
      domain: "ONDC:TRV11",
      version: "2.0.0",
      mock_role: "BPP",
    });

    // Independent, not merely non-throwing: the second registry has not seen
    // the first's observation.
    expect(await first.registry.metrics()).toContain(
      "ondc_sessions_created_total",
    );
    const secondText = await second.registry.metrics();
    expect(secondText).not.toContain('domain="ONDC:TRV11"');

    first.dispose();
    second.dispose();
  });

  it("keeps default process metrics on its own registry", async () => {
    const metrics = createMetrics();
    expect(await metrics.registry.metrics()).toContain("process_cpu");
    metrics.dispose();
  });

  it("carries no identifier that would grow a series per transaction", async () => {
    const metrics = createMetrics();

    // Read off the registry rather than off a list maintained by hand — the
    // point is to catch the instrument nobody thought to add to the list.
    const declared = await metrics.registry.getMetricsAsJSON();
    expect(declared.length).toBeGreaterThan(0);

    const offenders = declared.flatMap((metric) => {
      const labelNames =
        (metric as { labelNames?: string[] }).labelNames ?? [];
      return FORBIDDEN_LABELS.filter((label) =>
        labelNames.includes(label),
      ).map((label) => `${metric.name}{${label}}`);
    });

    expect(
      offenders,
      "these instruments carry a per-transaction identifier as a label",
    ).toEqual([]);

    metrics.dispose();
  });

  it("bounds a finding code and leaves our own enums alone", () => {
    const metrics = createMetrics();

    // The first hundred survive; the tail folds. Same set across instruments,
    // because the hazard is the total series count.
    for (let i = 0; i < 100; i++) metrics.findingCode(`RULE_${String(i)}`);
    expect(metrics.findingCode("RULE_7")).toBe("RULE_7");
    expect(metrics.findingCode("RULE_NEVER_SEEN")).toBe("other");

    metrics.dispose();
  });

  it("bounds an action, which arrives from an unauthenticated endpoint", () => {
    const metrics = createMetrics();

    for (let i = 0; i < 50; i++) metrics.action(`action_${String(i)}`);
    expect(metrics.action("action_3")).toBe("action_3");
    expect(metrics.action("../../etc/passwd")).toBe("other");

    metrics.dispose();
  });
});

describe("boundedLabel", () => {
  it("keeps the first `max` distinct values", () => {
    const seen = new Set<string>();
    expect(boundedLabel(seen, "a", 2)).toBe("a");
    expect(boundedLabel(seen, "b", 2)).toBe("b");
    // Already seen: still itself, even though the set is full.
    expect(boundedLabel(seen, "a", 2)).toBe("a");
  });

  it("folds everything past the cap into `other`", () => {
    const seen = new Set<string>();
    boundedLabel(seen, "a", 1);
    expect(boundedLabel(seen, "b", 1)).toBe("other");
    expect(boundedLabel(seen, "c", 1)).toBe("other");
    // And `other` did not itself take a slot, so `a` still resolves.
    expect(boundedLabel(seen, "a", 1)).toBe("a");
    expect(seen.size).toBe(1);
  });

  it("is first-seen-wins, not most-frequent", () => {
    // Stated as a test because the alternative is tempting and wrong: ranking
    // by frequency needs a counter per candidate value, which is the
    // cardinality problem again with a different name.
    const seen = new Set<string>();
    boundedLabel(seen, "rare", 1);
    for (let i = 0; i < 100; i++) boundedLabel(seen, "common", 1);
    expect(boundedLabel(seen, "common", 1)).toBe("other");
    expect(boundedLabel(seen, "rare", 1)).toBe("rare");
  });
});
