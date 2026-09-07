import { describe, expect, it } from "vitest";
import { KNOWLEDGE } from "@/modules/protocol/protocol.knowledge-corpus.js";
import {
  AS_OF,
  searchKnowledge,
  TOPICS,
} from "@/modules/protocol/protocol.knowledge.js";

describe("the network-wide corpus", () => {
  it("covers the topics no per-build endpoint publishes", () => {
    // These are the gap this corpus exists to close. Dropping one silently
    // means a model answers from memory instead.
    expect([...TOPICS].sort()).toEqual([
      "async-contract",
      "flows-vs-reality",
      "identity",
      "registry",
      "signing",
    ]);
  });

  it("stays small enough to be worth bundling", () => {
    const bytes = KNOWLEDGE.reduce((total, doc) => total + doc.body.length, 0);
    expect(bytes).toBeLessThan(60_000);
  });

  it("carries a review date, because a bundled answer can go stale", () => {
    expect(AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it.each([
    ["how do I sign a request", "signing"],
    ["blake2b digest", "signing"],
    ["registry lookup key rotation", "registry"],
    ["gateway fan out", "registry"],
    ["is ack the response", "async-contract"],
    ["duplicate callback idempotency", "async-contract"],
    ["transaction_id message_id", "identity"],
    ["why can I not hardcode a provider id", "flows-vs-reality"],
  ])("answers %j from %s", (query, topic) => {
    const found = searchKnowledge(query, { limit: 3 });
    expect(found.sections.length).toBeGreaterThan(0);
    expect(found.sections.map((s) => s.topic)).toContain(topic);
  });

  it("narrows to one topic when asked", () => {
    const found = searchKnowledge("keys", { topic: "signing", limit: 5 });
    expect(found.sections.every((s) => s.topic === "signing")).toBe(true);
  });

  it("returns sections, not whole documents", () => {
    const found = searchKnowledge("ttl", { limit: 1 });
    const section = found.sections[0];
    expect(section?.heading).toBeTruthy();
    expect(section?.body.length).toBeLessThan(2_000);
  });

  it("treats a contentless query as a request for orientation", () => {
    // An empty answer would read as "this server knows nothing about that".
    const found = searchKnowledge("a of is", { limit: 3 });
    expect(found.sections.length).toBe(3);
  });

  it("reports the true total so a caller knows what it did not see", () => {
    const found = searchKnowledge("ondc", { limit: 1 });
    expect(found.sections).toHaveLength(1);
    expect(found.total).toBeGreaterThan(1);
  });
});
