import { describe, expect, it } from "vitest";
import { buildSpecBundle } from "@/modules/protocol/protocol.bundle.js";
import { SPEC_RESPONSE } from "@/test/protocol-fixtures.js";

const BUILD = { domain: "ONDC:FIS12", version: "2.0.3" };

function build(raw: unknown = SPEC_RESPONSE) {
  return buildSpecBundle({ ...BUILD, raw });
}

describe("buildSpecBundle", () => {
  it("never lets a flow's config into the bundle", () => {
    // `flows[].config` is 8-9 MB of the 10.5 MB response and is the same
    // artefact `catalog_load_flow_config` already caches. The fixture keeps a
    // stub precisely so this can be asserted rather than assumed.
    expect(SPEC_RESPONSE.flows[0]).toHaveProperty("config");

    const bundle = build();
    expect(bundle.flows.length).toBeGreaterThan(0);
    for (const flow of bundle.flows) {
      expect(flow).not.toHaveProperty("config");
    }
    expect(JSON.stringify(bundle)).not.toContain("must never survive ingest");
  });

  it("normalises a numeric error code to a string", () => {
    // TRV11 2.0.1 publishes `code: 30001`; RET11 1.2.5 publishes `"60001"`.
    // Both are live. A lookup keyed on the raw value misses half the network.
    expect(typeof SPEC_RESPONSE.meta.errorCodes[0]?.code).toBe("number");
    for (const entry of build().error_codes) {
      expect(typeof entry.code).toBe("string");
    }
  });

  it("normalises a string error code identically", () => {
    const bundle = build({
      meta: {
        errorCodes: [
          // The RET11 spelling, verbatim.
          {
            code: "60005",
            From: "BPP",
            Event: "Invalid Signature",
            Description: "Cannot verify signature for request - Used in NACK",
          },
        ],
      },
    });
    expect(bundle.error_codes[0]).toMatchObject({
      code: "60005",
      sent_by: "BPP",
      used_in: "nack",
    });
  });

  it("reads where a code belongs only when upstream says so", () => {
    const bundle = build({
      meta: {
        errorCodes: [
          {
            code: 1,
            Description: "Pickup not serviceable - Used in error object",
          },
          { code: 2, Description: "no description provided" },
        ],
      },
    });
    expect(bundle.error_codes[0]?.used_in).toBe("error_object");
    // Guessing would be worse than silence: a model cannot tell a guess from
    // a fact, and NACK-versus-callback is a real behavioural difference.
    expect(bundle.error_codes[1]?.used_in).toBeUndefined();
  });

  it("counts only leaf rows as rules", () => {
    // A `group` row is a heading over other rows; counting it would inflate
    // every total by the shape of the tree rather than the number of checks.
    const bundle = build({
      validationTable: {
        table: {
          search: {
            rows: [
              { rowType: "group", name: "G", description: "Sub-tests: A, B" },
              { rowType: "leaf", name: "A" },
              { rowType: "leaf", name: "B" },
            ],
          },
        },
      },
    });
    expect(bundle.rule_counts.search).toBe(2);
  });

  it("carries the graph and the correlation contract through", () => {
    const bundle = build();
    expect(bundle.graph.edges.null).toEqual(
      SPEC_RESPONSE.meta.supportedActions.null,
    );
    expect(bundle.actions.length).toBeGreaterThan(0);
    expect(bundle.actions).not.toContain("null");
  });

  it("pairs every declared use-case with a status", () => {
    const bundle = build();
    expect(bundle.usecases).toEqual(
      expect.arrayContaining([
        { usecase: "PERSONAL LOAN", status: expect.any(String) },
      ]),
    );
  });

  it("degrades an absent section to empty rather than throwing", () => {
    // The document is authored elsewhere. A build that ships no validation
    // table must not take the module out.
    const bundle = build({});
    expect(bundle.actions).toEqual([]);
    expect(bundle.error_codes).toEqual([]);
    expect(bundle.rule_counts).toEqual({});
    expect(bundle.flows).toEqual([]);
    expect(bundle.domain).toBe("ONDC:FIS12");
  });

  it("reports its retained size, and it is a small fraction of the source", () => {
    const bundle = build();
    expect(bundle.bytes).toBeGreaterThan(0);
    expect(bundle.bytes).toBeLessThan(JSON.stringify(SPEC_RESPONSE).length);
  });

  it("records that `validations` nests one level deeper than it reads", () => {
    // Not consumed yet, but the shape invites exactly one wrong guess and the
    // fixture is the record of which spelling is right.
    expect(SPEC_RESPONSE.validations).toHaveProperty("validations._TESTS_");
    expect(SPEC_RESPONSE.validations).not.toHaveProperty("_TESTS_");
  });

  it("keeps the changelog as *recent changes*, not a migration guide", () => {
    // Verified across ten published builds: every changelog upstream ships has
    // fromVersion === toVersion on a draft-* branch, and two builds ship none.
    // A `protocol_diff_versions` built on this would promise what the data
    // cannot keep — so it is named for what it is and the blobs are dropped.
    const bundle = build({
      changelog: [
        {
          fromVersion: "1.2.5",
          toVersion: "1.2.5",
          sections: [
            {
              section: "flows",
              entries: [
                {
                  kind: "added",
                  path: "x-flows.SOME_FLOW.tags",
                  summary: 'Flow "SOME_FLOW" tag added: "OPTIONAL"',
                  before: { a: 1 },
                  after: { a: 2 },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(bundle.recent_changes).toEqual([
      {
        kind: "added",
        path: "x-flows.SOME_FLOW.tags",
        summary: 'Flow "SOME_FLOW" tag added: "OPTIONAL"',
      },
    ]);
    // The before/after blobs are whole spec nodes; the summary already says it.
    expect(JSON.stringify(bundle.recent_changes)).not.toContain("before");
  });

  it("tolerates a build that ships no changelog at all", () => {
    expect(build({}).recent_changes).toEqual([]);
  });
});
