import { describe, expect, it } from "vitest";
import {
  KB_AS_OF,
  KB_KNOWLEDGE,
  KB_SOURCE,
} from "@/modules/protocol/protocol.kb-corpus.generated.js";

/**
 * The generated corpus is data, and data that goes missing goes missing
 * quietly: a dropped document turns into "the network has nothing on key
 * rotation", with no error anywhere. These are the assertions that make an
 * upstream rename, a failed fetch or a botched regeneration fail the build
 * instead.
 */
describe("the published ONDC knowledge base", () => {
  it("carries all 63 documents", () => {
    expect(KB_KNOWLEDGE).toHaveLength(63);
  });

  it("pins the exact document set", () => {
    // Pinned rather than counted, so an upstream *rename* fails too — a
    // renamed file keeps the count and silently breaks every cross-reference
    // and every `ondc://knowledge/{id}` link that pointed at the old id.
    expect(KB_KNOWLEDGE.map((doc) => doc.id)).toEqual([
      "01-signature-verification",
      "02-onboarding-subscribe",
      "03-lookup",
      "04-registry-interaction",
      "05-gateway-interaction",
      "06-p2p-communication",
      "07-search-on_search",
      "08-confirm-on_confirm",
      "09-payload-encryption-fis",
      "10-ack-nack",
      "11-async-request-callback",
      "12-ttl-handling",
      "13-idempotency-retries",
      "14-schema-validation",
      "15-error-codes",
      "16-validation-rules",
      "17-reason-codes",
      "18-action-catalogue-lifecycle",
      "19-select-on_select",
      "20-init-on_init",
      "21-status-on_status",
      "22-cancel-on_cancel",
      "23-update-on_update",
      "24-track-on_track",
      "25-rating-support",
      "26-key-generation",
      "27-digest-generation",
      "28-authorization-header-creation",
      "29-registry-caching",
      "30-key-rotation",
      "31-gcr-global-catalog-repository",
      "32-environment-matrix",
      "33-domain-version-enablement",
      "34-transaction-id",
      "35-message-id",
      "36-catalog-object-model",
      "37-catalog-refresh",
      "38-item-variants-customizations",
      "39-serviceability",
      "40-catalog-store-rejection",
      "41-static-terms",
      "42-taxonomy-codes",
      "43-quote-price-breakup",
      "44-order-state-machine",
      "45-payment-terms",
      "46-cancellation-force-cancellation",
      "47-returns-rto-rts",
      "48-fulfillment-states-tat",
      "49-logistics-linkage",
      "50-fulfillment-types",
      "51-awb-shipping-label",
      "59-workbench-overview",
      "60-schema-validation-tool",
      "61-flow-testing-suite",
      "62-workbench-local-setup",
      "63-mock-server-sandbox",
      "65-interpreting-error-reports",
      "66-network-observability-api",
      "67-versioning-spec-migration",
      "68-release-calendar",
      "69-city-state-codes",
      "70-async-implementation-skill",
      "71-signature-verification-skill",
    ]);
  });

  it("stays small enough to be worth bundling", () => {
    // Not a limit on usefulness — the whole corpus is 136 KB and never reaches
    // a model whole. It is the tripwire for somebody ingesting a second repo
    // into the same file without anyone noticing the image doubled.
    const bytes = KB_KNOWLEDGE.reduce(
      (total, doc) => total + doc.body.length,
      0,
    );
    expect(bytes).toBeGreaterThan(80_000);
    expect(bytes).toBeLessThan(250_000);
  });

  it("tags every document with a tier, a category and a status", () => {
    // These three are the whole reason the README index is parsed. A document
    // missing one is unfacetable and unattributable, and search would still
    // return it looking perfectly normal.
    for (const doc of KB_KNOWLEDGE) {
      expect(doc.tier, doc.id).toBe("kb");
      expect(doc.category, doc.id).toBeTruthy();
      expect(doc.status, doc.id).toBeTruthy();
      expect(doc.title, doc.id).toBeTruthy();
    }
  });

  it("publishes the twelve categories the index defines", () => {
    const categories = [
      ...new Set(KB_KNOWLEDGE.map((doc) => doc.category ?? "")),
    ].sort();
    expect(categories).toEqual([
      "API Actions",
      "Catalog & Discovery",
      "Engineering Skills",
      "Errors & Codes",
      "Fulfillment & Logistics",
      "Message Mechanics",
      "Network Policy",
      "Observability & Ops",
      "Order Lifecycle",
      "Registry & Subscription",
      "Security & Auth",
      "Workbench & Testing",
    ]);
  });

  it("survived escaping — no stray markers in any body", () => {
    // If the escaper ever emits `\\\`` where the source had a plain backtick,
    // the module still typechecks and the corpus ships corrupt. The source
    // documents contain no backslashes at all, so any backslash-backtick pair
    // here is this repo's doing.
    for (const doc of KB_KNOWLEDGE) {
      expect(doc.body, doc.id).not.toContain("\\`");
      expect(doc.body, doc.id).not.toContain("\\${");
    }
  });

  it("starts every body at a section heading, not at the title", () => {
    // `sectionsOf` splits on `##`. A body that still carried its H1 would file
    // the whole document under one section named after the title.
    for (const doc of KB_KNOWLEDGE) {
      expect(doc.body.startsWith("#"), doc.id).toBe(true);
      expect(doc.body.startsWith("# "), doc.id).toBe(false);
    }
  });

  it("resolves cross-references to ids that exist", () => {
    const ids = new Set(KB_KNOWLEDGE.map((doc) => doc.id));
    for (const doc of KB_KNOWLEDGE) {
      for (const ref of doc.see_also ?? []) {
        expect(ids.has(ref), `${doc.id} → ${ref}`).toBe(true);
      }
    }
  });

  it("names the commit it was taken from, so an answer can be traced", () => {
    expect(KB_SOURCE.repo).toBe("ONDC-Official/automation-kb-studio");
    expect(KB_SOURCE.path).toBe("kb-docs");
    expect(KB_SOURCE.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(KB_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
