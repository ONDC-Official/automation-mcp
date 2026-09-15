/**
 * Turning the published ONDC knowledge base into corpus entries.
 *
 * `ONDC-Official/automation-kb-studio/kb-docs` is 63 markdown documents plus a
 * `README.md` index table. This file is every part of ingesting them that can
 * be wrong: parsing the index, parsing a document, resolving the documents'
 * own cross-references, and escaping markdown into a TypeScript template
 * literal. `scripts/sync-kb-docs.ts` is the shell around it and does nothing
 * but fetch and write.
 *
 * ## Why the logic lives under `src/` and the script does not
 *
 * `tsconfig.json` sets `include: ["src"]` and `rootDir: "src"`, so a file under
 * `scripts/` is outside the program: `npm run typecheck` would not see it and
 * ESLint's type-aware rules would have no program for it. Rather than bend
 * `rootDir` for a script that runs by hand, the part worth checking lives here
 * — typechecked, linted, and with its own tests beside it.
 *
 * ## Why it fails loud
 *
 * Nothing here is on a transaction's path. `realityFor` fails open because
 * NACKing a compliant participant over *our* outage writes our failure into
 * their compliance report; that argument does not reach a generator. A corpus
 * that silently ingests 61 of 63 documents answers "the network has nothing on
 * key rotation" forever, with no error anywhere. So every inconsistency —
 * a file with no index row, an index row with no file, a document without
 * exactly one H1 — throws.
 */

import type { KnowledgeDoc } from "@/modules/protocol/protocol.knowledge-corpus.js";

/** One row of the kb-docs README index table. */
export interface KbIndexRow {
  /** The document number as published, zero-padded: `01`, `66`. */
  readonly number: string;
  readonly title: string;
  readonly category: string;
  /** `source-confirmed`, sometimes with a qualifier; `partial`; `overview`. */
  readonly status: string;
  /** The file the row links to, e.g. `30-key-rotation.md`. */
  readonly file: string;
}

/** Where a generated corpus came from. Stamped into the emitted module. */
export interface KbSource {
  readonly repo: string;
  readonly sha: string;
  readonly path: string;
}

/**
 * A row of the index table.
 *
 * `| 01 | [Signature Verification](01-signature-verification.md) | Security & Auth | source-confirmed |`
 *
 * The leading `\d+` is what excludes the header row and the `|---|` separator
 * without having to recognise them, and the README's prose paragraphs and its
 * `>` note about retired numbers never match at all.
 */
const INDEX_ROW =
  /^\|\s*(\d+)\s*\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/;

/** The index table, keyed by document number. Throws on a duplicate row. */
export function parseIndexTable(readme: string): Map<string, KbIndexRow> {
  const rows = new Map<string, KbIndexRow>();

  for (const line of readme.split("\n")) {
    const match = INDEX_ROW.exec(line.trim());
    if (match === null) continue;

    const [, number, title, file, category, status] = match;
    if (
      number === undefined ||
      title === undefined ||
      file === undefined ||
      category === undefined ||
      status === undefined
    ) {
      continue;
    }
    if (rows.has(number)) {
      throw new Error(`kb index: document ${number} is listed twice`);
    }
    rows.set(number, { number, title, category, status, file });
  }

  if (rows.size === 0) {
    // The table is the only source of category and status. Matching nothing
    // means the README's shape changed, and a corpus with neither facet would
    // still look perfectly healthy.
    throw new Error(
      "kb index: no rows matched — has the README table changed?",
    );
  }
  return rows;
}

/** `30-key-rotation.md` → `30`. Null for anything not numbered. */
export function numberOf(fileName: string): string | null {
  return /^(\d+)-/.exec(fileName)?.[1] ?? null;
}

/** `30-key-rotation.md` → `30-key-rotation`. */
export function topicIdOf(fileName: string): string {
  return fileName.replace(/\.md$/, "");
}

/**
 * The document numbers a document points at.
 *
 * The docs cross-reference each other two ways in the same sentence — ``see
 * `28-authorization-header-creation` `` and ``see `03` `` — so the scrape reads
 * every backticked run that *starts* with digits and keeps the digits. Reading
 * only the long form would drop roughly half the graph.
 */
export function crossReferences(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(/`(\d+)(?:-[a-z0-9_-]+)?`/gi)) {
    const number = match[1];
    if (number !== undefined) found.add(number);
  }
  return [...found].sort();
}

/**
 * The bullet list under `## Sources`, if the document has one.
 *
 * Scanned line by line rather than matched with one regex. The obvious
 * `(?=^## |\Z)` lookahead is a trap: JavaScript has no `\Z` anchor, so it
 * compiles to the literal letter `Z` and the section silently ends at the first
 * capital Z in a citation.
 */
export function sourcesOf(body: string): string[] {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => /^##\s+Sources\s*$/.test(line));
  if (start === -1) return [];

  const sources: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    const bullet = /^[-*]\s+(.*)$/.exec(line.trim())?.[1]?.trim();
    if (bullet !== undefined && bullet !== "") sources.push(bullet);
  }
  return sources;
}

/** The parsed shape, before cross-references are resolved to topic ids. */
interface Parsed {
  readonly doc: KnowledgeDoc;
  readonly refs: readonly string[];
}

function parseOne(fileName: string, markdown: string, row: KbIndexRow): Parsed {
  const lines = markdown.split("\n");
  const headings = lines.filter((line) => /^#\s+\S/.test(line));
  if (headings.length !== 1) {
    // Two H1s means the body would silently keep one of them as prose, and
    // zero means the title falls back to the index and nobody notices.
    throw new Error(
      `kb doc ${fileName}: expected exactly one H1, found ${String(headings.length)}`,
    );
  }

  const at = lines.findIndex((line) => /^#\s+\S/.test(line));
  const title = /^#\s+(.*)$/.exec(lines[at] ?? "")?.[1]?.trim() ?? row.title;
  const body = lines
    .slice(at + 1)
    .join("\n")
    .trim();

  if (body === "") throw new Error(`kb doc ${fileName}: empty body`);

  return {
    doc: {
      id: topicIdOf(fileName),
      title,
      body,
      tier: "kb",
      category: row.category,
      status: row.status,
      sources: sourcesOf(body),
    },
    refs: crossReferences(body),
  };
}

/**
 * Every kb-doc as a corpus entry, ordered by document number.
 *
 * `files` is filename → markdown, README excluded.
 */
export function buildKbCorpus(
  files: ReadonlyMap<string, string>,
  readme: string,
): KnowledgeDoc[] {
  const index = parseIndexTable(readme);
  const parsed = new Map<string, Parsed>();

  for (const [fileName, markdown] of files) {
    const number = numberOf(fileName);
    if (number === null) {
      throw new Error(`kb doc ${fileName}: filename is not \`NN-slug.md\``);
    }
    const row = index.get(number);
    if (row === undefined) {
      throw new Error(`kb doc ${fileName}: no row for it in the README index`);
    }
    if (row.file !== fileName) {
      throw new Error(
        `kb doc ${fileName}: the README index links it as ${row.file}`,
      );
    }
    parsed.set(number, parseOne(fileName, markdown, row));
  }

  for (const [number, row] of index) {
    if (!parsed.has(number)) {
      throw new Error(
        `kb index: row ${number} (${row.file}) has no file in kb-docs/`,
      );
    }
  }

  // Cross-references resolve only now, because a document may point forwards.
  // A reference to a retired number (52-58, 64) is dropped rather than thrown
  // on: the README says those numbers are retired on purpose, so a dangling
  // `see 56` is upstream prose, not a broken ingest.
  const byNumber = new Map(
    [...parsed].map(([number, entry]) => [number, entry.doc.id] as const),
  );

  return [...parsed.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([number, entry]) => ({
      ...entry.doc,
      see_also: entry.refs
        .filter((ref) => ref !== number)
        .map((ref) => byNumber.get(ref))
        .filter((id): id is string => id !== undefined),
    }));
}

/**
 * Markdown → the inside of a TypeScript template literal.
 *
 * Backslash first: escaping it after the others would double the backslashes
 * they just introduced. The kb-docs as published contain 3,228 backticks, no
 * backslashes and no `${`, but all three are handled because the next sync is
 * not obliged to look like this one.
 */
export function escapeTemplateLiteral(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

/** A TS string literal, for the short single-line fields. */
function quote(text: string): string {
  return JSON.stringify(text);
}

function renderDoc(doc: KnowledgeDoc): string {
  const lines = [
    "  {",
    `    id: ${quote(doc.id)},`,
    `    title: ${quote(doc.title)},`,
    `    tier: "kb",`,
    `    category: ${quote(doc.category ?? "")},`,
    `    status: ${quote(doc.status ?? "")},`,
  ];
  const sources = doc.sources ?? [];
  lines.push(
    sources.length === 0
      ? "    sources: [],"
      : `    sources: [\n${sources.map((s) => `      ${quote(s)},`).join("\n")}\n    ],`,
  );
  const seeAlso = doc.see_also ?? [];
  lines.push(
    seeAlso.length === 0
      ? "    see_also: [],"
      : `    see_also: [\n${seeAlso.map((s) => `      ${quote(s)},`).join("\n")}\n    ],`,
  );
  lines.push(`    body: \`${escapeTemplateLiteral(doc.body)}\`,`, "  },");
  return lines.join("\n");
}

/** The whole generated module, as text. */
export function renderKbCorpusModule(
  docs: readonly KnowledgeDoc[],
  source: KbSource,
  asOf: string,
): string {
  const header = `/**
 * The published ONDC knowledge base — GENERATED, DO NOT EDIT BY HAND.
 *
 * Regenerate with \`npm run kb:sync\`. The source of truth is
 * ${source.repo} (\`${source.path}\`), vendored at the commit stamped below.
 *
 * ## Why this is bundled, and why it is vendored rather than fetched
 *
 * The rule that the live config-service is the single source of truth exists
 * because build specs drift and a stale copy is worse than none. These are not
 * build specs: they are network-wide protocol knowledge that no endpoint this
 * server talks to publishes, and the alternative is that a model drives a whole
 * transaction and learns none of it.
 *
 * It is vendored at a pinned commit rather than fetched at runtime so that a
 * content change arrives as a reviewable diff, and so that the knowledge tools
 * do not go dark when a host we do not own is unreachable. Every answer carries
 * \`KB_AS_OF\` so a reader can weigh its age.
 *
 * ## Why it is TypeScript rather than the markdown files themselves
 *
 * The runtime image copies only \`dist/\`, and \`tsc\` emits \`.js\` from \`.ts\` —
 * nothing else. A corpus of \`.md\` files read from disk would work under
 * \`npm run dev\` and \`vitest\`, and silently find nothing in the container.
 */

import type { KnowledgeDoc } from "@/modules/protocol/protocol.knowledge-corpus.js";

/** The commit these documents were taken from. */
export const KB_SOURCE = {
  repo: ${quote(source.repo)},
  sha: ${quote(source.sha)},
  path: ${quote(source.path)},
} as const;

/** When \`npm run kb:sync\` last pulled them. */
export const KB_AS_OF = ${quote(asOf)};

export const KB_KNOWLEDGE: readonly KnowledgeDoc[] = [
`;

  return `${header}${docs.map(renderDoc).join("\n")}\n];\n`;
}
