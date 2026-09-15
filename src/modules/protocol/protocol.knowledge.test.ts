import { describe, expect, it } from "vitest";
import { KNOWLEDGE } from "@/modules/protocol/protocol.knowledge-corpus.js";
import { KB_KNOWLEDGE } from "@/modules/protocol/protocol.kb-corpus.generated.js";
import {
  AS_OF,
  CATEGORIES,
  CORE_TOPICS,
  KB_AS_OF,
  MAX_SECTION_BYTES,
  TOPICS,
  hasTopic,
  knowledgeDoc,
  knowledgeIndex,
  searchKnowledge,
} from "@/modules/protocol/protocol.knowledge.js";

describe("the network-wide corpus", () => {
  it("covers the topics no per-build endpoint publishes", () => {
    // These are the gap this corpus exists to close. Dropping one silently
    // means a model answers from memory instead. The published knowledge base
    // is pinned separately, in protocol.kb-corpus.test.ts — this assertion is
    // about the hand-written orientation layer and stays exact.
    expect([...CORE_TOPICS].sort()).toEqual([
      "async-contract",
      "flows-vs-reality",
      "identity",
      "registry",
      "signing",
    ]);
  });

  it("indexes both layers under one set of topics", () => {
    expect(TOPICS).toHaveLength(KNOWLEDGE.length + KB_KNOWLEDGE.length);
    expect(hasTopic("signing")).toBe(true);
    expect(hasTopic("30-key-rotation")).toBe(true);
    expect(hasTopic("not-a-doc")).toBe(false);
  });

  it("stays small enough to be worth bundling", () => {
    const bytes = KNOWLEDGE.reduce((total, doc) => total + doc.body.length, 0);
    expect(bytes).toBeLessThan(60_000);
  });

  it("carries a review date for each layer, because a bundle can go stale", () => {
    expect(AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(KB_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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
    // The original eight. They are now also the regression test for the
    // reserved core slot: if the published layer floods the top three and
    // pushes the orientation layer out, this table goes red.
    const found = searchKnowledge(query, { limit: 3 });
    expect(found.sections.length).toBeGreaterThan(0);
    expect(found.sections.map((s) => s.topic)).toContain(topic);
  });

  it.each([
    ["how do I rotate my signing key", "30-key-rotation"],
    ["subscribe onboarding registry v1.1", "02-onboarding-subscribe"],
    ["what does x-errorcodes contain", "15-error-codes"],
    ["cancellation reason codes", "17-reason-codes"],
    ["order state machine transitions", "44-order-state-machine"],
    ["serviceability pincode radius", "39-serviceability"],
    ["awb shipping label", "51-awb-shipping-label"],
    ["incremental catalog refresh", "37-catalog-refresh"],
    ["item variants and customizations", "38-item-variants-customizations"],
    ["network observability api", "66-network-observability-api"],
    ["global catalog repository gcr", "31-gcr-global-catalog-repository"],
    ["taxonomy category codes", "42-taxonomy-codes"],
  ])("answers %j from %s", (query, topic) => {
    const found = searchKnowledge(query, { limit: 4 });
    expect(found.sections.map((s) => s.topic)).toContain(topic);
  });

  it("narrows to one topic when asked", () => {
    const found = searchKnowledge("keys", { topic: "signing", limit: 5 });
    expect(found.sections.length).toBeGreaterThan(0);
    expect(found.sections.every((s) => s.topic === "signing")).toBe(true);
  });

  it("narrows to one category when asked", () => {
    const found = searchKnowledge("catalog", {
      category: "Catalog & Discovery",
      limit: 5,
    });
    expect(found.sections.length).toBeGreaterThan(0);
    expect(
      found.sections.every((s) => s.category === "Catalog & Discovery"),
    ).toBe(true);
  });

  it("publishes the categories a caller may filter on", () => {
    expect(CATEGORIES).toContain("Security & Auth");
    expect(CATEGORIES).toContain("Order Lifecycle");
    expect(CATEGORIES).toHaveLength(12);
  });

  it("returns sections, not whole documents", () => {
    const found = searchKnowledge("ttl", { limit: 1 });
    const section = found.sections[0];
    expect(section?.heading).toBeTruthy();
    expect(section?.body.length).toBeLessThanOrEqual(MAX_SECTION_BYTES);
  });

  it("says so when it cut a body, rather than trailing off", () => {
    // A silently truncated markdown table reads as the whole table.
    const long = [...KB_KNOWLEDGE, ...KNOWLEDGE].find((doc) =>
      doc.body
        .split(/^## /m)
        .some((section) => section.length > MAX_SECTION_BYTES),
    );
    expect(long).toBeDefined();
    const found = searchKnowledge("", { topic: long?.id ?? "", limit: 20 });
    const cut = found.sections.filter((s) => s.truncated);
    expect(cut.length).toBeGreaterThan(0);
    for (const section of cut) {
      expect(section.body.length).toBeLessThanOrEqual(MAX_SECTION_BYTES);
    }
  });

  it("keeps the whole answer inside the budget, and counts what it dropped", () => {
    const found = searchKnowledge("ondc network participant", { limit: 20 });
    const bytes = found.sections.reduce(
      (total, section) => total + section.body.length,
      0,
    );
    expect(bytes).toBeLessThanOrEqual(8_000 + MAX_SECTION_BYTES);
    expect(found.elided).toBeGreaterThanOrEqual(0);
    expect(found.sections.length + found.elided).toBeLessThanOrEqual(20);
  });

  it("does not let one document fill the answer", () => {
    // Without the per-document cap a signing query returns three slices of
    // 01-signature-verification and the model never learns 26/27/28/30 exist.
    const found = searchKnowledge("signature verification key", { limit: 3 });
    const topics = new Set(found.sections.map((s) => s.topic));
    expect(topics.size).toBe(found.sections.length);
  });

  it("always keeps a slot for the orientation layer when it has something", () => {
    // Stated as a rule rather than bought with a score bonus, so the assertion
    // is about the rule and not about a weight somebody tuned until it passed.
    for (const query of [
      "signature verification digest key",
      "registry lookup subscriber",
      "transaction id across the journey",
    ]) {
      const found = searchKnowledge(query, { limit: 3 });
      expect(
        found.sections.some((s) => s.tier === "core"),
        query,
      ).toBe(true);
    }
  });

  it("gives the single best answer at limit 1, core or not", () => {
    // The reserve is off here: a caller asking for one thing wants the best
    // one, not an orientation section it did not ask for.
    const found = searchKnowledge("awb shipping label manifest", { limit: 1 });
    expect(found.sections).toHaveLength(1);
    expect(found.sections[0]?.topic).toBe("51-awb-shipping-label");
  });

  it("does not rank on boilerplate headings", () => {
    // Every published document has `## Objective`, `## Deliverable` and
    // `## Sources`, so a query term landing in one says nothing about what the
    // section is about. Weighting it would let any of the sixty-three
    // `## Objective` sections outrank the document actually being asked about.
    const found = searchKnowledge("objective of key rotation", { limit: 3 });
    expect(found.sections.map((s) => s.topic)).toContain("30-key-rotation");

    const off = found.sections.filter(
      (s) => s.heading.toLowerCase() === "objective" && s.tier === "kb",
    );
    expect(off.every((s) => s.body.toLowerCase().includes("rotat"))).toBe(true);
  });

  it("ranks a rare term above a ubiquitous one", () => {
    // `ondc` is in nearly every section and `blake` in a handful. Without the
    // document-frequency map these score the same and the rare half is lost.
    const found = searchKnowledge("ondc blake", { limit: 3 });
    const bodies = found.sections.map((s) => s.body.toLowerCase());
    expect(bodies.some((body) => body.includes("blake"))).toBe(true);
  });

  it("weighs where a term matched by how rare the term is", () => {
    // The subtle half of the ranking, and the one that goes wrong silently.
    // Every bonus is multiplied by the matched term's rarity, so a document
    // whose *subject* is the rare word beats one whose title happens to carry
    // the common one. With flat bonuses `async-contract` tied the `signing`
    // document for this query, because its title contains "request".
    const core = searchKnowledge("how do I sign a request", { limit: 20 })
      .sections.filter((s) => s.tier === "core")
      .map((s) => s.topic);
    expect(core[0]).toBe("signing");
  });

  it("treats a contentless query as a request for orientation", () => {
    // An empty answer would read as "this server knows nothing about that",
    // and orientation means the hand-written layer, not whichever published
    // document happens to sort first.
    const found = searchKnowledge("a of is", { limit: 3 });
    expect(found.sections).toHaveLength(3);
    expect(found.sections.every((s) => s.tier === "core")).toBe(true);
  });

  it("reads a whole document in order when given a topic and no query", () => {
    // This is the doc-read path, and why no separate tool exists for it.
    const found = searchKnowledge("", { topic: "30-key-rotation", limit: 20 });
    expect(found.sections.length).toBeGreaterThan(3);
    expect(found.sections[0]?.heading).toBe("Objective");
    expect(found.sections.every((s) => s.topic === "30-key-rotation")).toBe(
      true,
    );
  });

  it("reports the true total so a caller knows what it did not see", () => {
    const found = searchKnowledge("ondc", { limit: 1 });
    expect(found.sections).toHaveLength(1);
    expect(found.total).toBeGreaterThan(1);
  });

  it("hands back a whole document, with its provenance, for the resource", () => {
    const doc = knowledgeDoc("30-key-rotation");
    expect(doc?.title).toBe("Key Rotation");
    expect(doc?.tier).toBe("kb");
    expect(doc?.category).toBe("Security & Auth");
    expect(doc?.sources?.length).toBeGreaterThan(0);
    expect(knowledgeDoc("not-a-doc")).toBeUndefined();
  });

  it("lists both layers in the index, core first", () => {
    const index = knowledgeIndex();
    expect(index).toHaveLength(TOPICS.length);
    expect(index[0]?.tier).toBe("core");
    expect(index.filter((entry) => entry.tier === "kb")).toHaveLength(63);
  });
});
