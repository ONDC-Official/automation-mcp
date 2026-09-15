import { describe, expect, it } from "vitest";
import {
  buildKbCorpus,
  crossReferences,
  escapeTemplateLiteral,
  numberOf,
  parseIndexTable,
  renderKbCorpusModule,
  sourcesOf,
  topicIdOf,
} from "@/modules/protocol/protocol.kb-ingest.js";

const README = `# Protocol-Lens Docs

Some prose that is not a table.

| # | Doc | Category | Status |
|---|---|---|---|
| 01 | [Signature Verification](01-signature-verification.md) | Security & Auth | source-confirmed |
| 03 | [Lookup (/v2.0/lookup)](03-lookup.md) | Security & Auth | source-confirmed |
| 30 | [Key Rotation](30-key-rotation.md) | Security & Auth | partial |

> RSF (52-55) was removed as out of scope; those numbers are retired.
`;

const SIGNING = `# Signature Verification

## Objective

How a receiver verifies an inbound request. Does NOT cover key generation
(see \`30-key-rotation\`) or the lookup call (see \`03\`).

## Sources

- ONDC developer-docs \`registry/signing-verification.md\`
- ONDC \`ondc-crypto-sdk-go\`
`;

const LOOKUP = `# Lookup (/v2.0/lookup)

## Objective

Finding a counterparty's public key (see \`01\`).

## Sources

- ONDC registry docs
`;

const ROTATION = `# Key Rotation

## Objective

Rolling a signing key without downtime. Referenced from \`56\`, which is retired.

## Sources

- ONDC registry docs
`;

function files(overrides: Record<string, string> = {}): Map<string, string> {
  return new Map(
    Object.entries({
      "01-signature-verification.md": SIGNING,
      "03-lookup.md": LOOKUP,
      "30-key-rotation.md": ROTATION,
      ...overrides,
    }),
  );
}

describe("the kb-docs README index", () => {
  it("reads number, title, category and status off each row", () => {
    const index = parseIndexTable(README);
    expect(index.size).toBe(3);
    expect(index.get("30")).toEqual({
      number: "30",
      title: "Key Rotation",
      category: "Security & Auth",
      status: "partial",
      file: "30-key-rotation.md",
    });
  });

  it("ignores the header row, the separator and surrounding prose", () => {
    expect([...parseIndexTable(README).keys()]).toEqual(["01", "03", "30"]);
  });

  it("refuses a README whose table matched nothing", () => {
    // The table is the only source of category and status. Silently matching
    // nothing would leave every document unfaceted and still look healthy.
    expect(() => parseIndexTable("# Docs\n\nno table here\n")).toThrow(
      /no rows matched/,
    );
  });

  it("refuses a duplicated row", () => {
    const doubled = `${README}| 30 | [Key Rotation](30-key-rotation.md) | Other | overview |\n`;
    expect(() => parseIndexTable(doubled)).toThrow(/listed twice/);
  });
});

describe("parsing one document", () => {
  it("derives the topic id and number from the filename", () => {
    expect(topicIdOf("30-key-rotation.md")).toBe("30-key-rotation");
    expect(numberOf("30-key-rotation.md")).toBe("30");
    expect(numberOf("README.md")).toBeNull();
  });

  it("reads both cross-reference spellings, long and bare", () => {
    // The docs use `see \`03\`` and `see \`30-key-rotation\`` in the same
    // sentence. Reading only the long form drops about half the graph.
    expect(crossReferences(SIGNING)).toEqual(["03", "30"]);
  });

  it("stops the Sources section at the next heading, not at a letter Z", () => {
    // JavaScript has no `\\Z` anchor — the obvious lookahead compiles to the
    // literal letter and truncates the list at the first capital Z.
    const body = `## Sources

- A source naming Zurich
- ONDC developer-docs

## Appendix

- not a source
`;
    expect(sourcesOf(body)).toEqual([
      "A source naming Zurich",
      "ONDC developer-docs",
    ]);
  });

  it("returns no sources when the document has no Sources section", () => {
    expect(sourcesOf("## Objective\n\nnothing else\n")).toEqual([]);
  });
});

describe("building the corpus", () => {
  it("tags every document with its tier, category and status", () => {
    const docs = buildKbCorpus(files(), README);
    expect(docs).toHaveLength(3);
    expect(docs.map((doc) => doc.id)).toEqual([
      "01-signature-verification",
      "03-lookup",
      "30-key-rotation",
    ]);
    expect(docs.every((doc) => doc.tier === "kb")).toBe(true);
    expect(docs[2]?.status).toBe("partial");
    expect(docs[0]?.category).toBe("Security & Auth");
  });

  it("takes the title from the H1 and drops it from the body", () => {
    const doc = buildKbCorpus(files(), README)[0];
    expect(doc?.title).toBe("Signature Verification");
    expect(doc?.body.startsWith("## Objective")).toBe(true);
  });

  it("resolves cross-references to topic ids", () => {
    const doc = buildKbCorpus(files(), README)[0];
    expect(doc?.see_also).toEqual(["03-lookup", "30-key-rotation"]);
  });

  it("drops a reference to a retired number rather than throwing", () => {
    // The README retires 52-58 and 64 on purpose, so a dangling `see 56` is
    // upstream prose, not a broken ingest.
    const doc = buildKbCorpus(files(), README)[2];
    expect(doc?.see_also).toEqual([]);
  });

  it("keeps the Sources bullets", () => {
    const doc = buildKbCorpus(files(), README)[0];
    expect(doc?.sources).toEqual([
      "ONDC developer-docs `registry/signing-verification.md`",
      "ONDC `ondc-crypto-sdk-go`",
    ]);
  });

  it.each([
    [
      "a file with no row in the index",
      () =>
        buildKbCorpus(
          files({ "99-mystery.md": "# Mystery\n\n## Objective\n\nhi\n" }),
          README,
        ),
      /no row for it in the README index/,
    ],
    [
      "a row in the index with no file",
      () => {
        const partial = files();
        partial.delete("30-key-rotation.md");
        return buildKbCorpus(partial, README);
      },
      /row 30 \(30-key-rotation\.md\) has no file/,
    ],
    [
      "a document with two H1s",
      () =>
        buildKbCorpus(
          files({ "03-lookup.md": `${LOOKUP}\n# A second title\n` }),
          README,
        ),
      /expected exactly one H1, found 2/,
    ],
    [
      "a document with no H1",
      () =>
        buildKbCorpus(
          files({ "03-lookup.md": "## Objective\n\nhi\n" }),
          README,
        ),
      /expected exactly one H1, found 0/,
    ],
    [
      "a filename that is not NN-slug.md",
      () =>
        buildKbCorpus(files({ "notes.md": "# Notes\n\n## X\n\nhi\n" }), README),
      /filename is not/,
    ],
  ])("refuses %s", (_label, build, message) => {
    expect(build).toThrow(message);
  });
});

describe("escaping markdown into a template literal", () => {
  it.each([
    ["a backtick", "use `ttl`", "use \\`ttl\\`"],
    ["an interpolation", "cost ${x}", "cost \\${x}"],
    ["a backslash", "a\\b", "a\\\\b"],
    ["a lone dollar", "costs $5", "costs $5"],
  ])("escapes %s", (_label, input, expected) => {
    expect(escapeTemplateLiteral(input)).toBe(expected);
  });

  it("escapes the backslash before the characters it would then double", () => {
    // Reverse the order and `\\` + a backtick emits `\\\\\\`` — a literal
    // backslash followed by an unescaped backtick, which ends the string.
    expect(escapeTemplateLiteral("\\`")).toBe("\\\\\\`");
  });

  it.each([
    ["backticks", "use `ttl` and `${x}` together"],
    ["an interpolation", "cost ${x} and $ alone"],
    ["a backslash before a backtick", "a \\` b"],
    ["a fenced block", '```json\n{"a": 1}\n```'],
    ["the real hazards at once", "`a` ${b} \\ ```"],
  ])("round-trips %s through a real template literal", async (_label, raw) => {
    // The property that matters: what the generator emits, evaluated the way
    // `tsc` will evaluate it, is byte-identical to what it was handed. Nothing
    // downstream catches a wrong answer here — the corpus simply ships corrupt.
    const { runInNewContext } = await import("node:vm");
    const evaluated = runInNewContext(
      `\`${escapeTemplateLiteral(raw)}\``,
    ) as string;
    expect(evaluated).toBe(raw);
  });

  it("stamps the commit it was taken from", () => {
    const module = renderKbCorpusModule(
      buildKbCorpus(files(), README),
      {
        repo: "ONDC-Official/automation-kb-studio",
        sha: "3136a603",
        path: "kb-docs",
      },
      "2026-09-15",
    );
    expect(module).toContain('sha: "3136a603"');
    expect(module).toContain('export const KB_AS_OF = "2026-09-15"');
    expect(module).toContain("DO NOT EDIT BY HAND");
  });
});
