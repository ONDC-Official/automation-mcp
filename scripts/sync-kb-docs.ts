/**
 * Vendor the published ONDC knowledge base into the protocol corpus.
 *
 *   npm run kb:sync            # pin to the current main
 *   npm run kb:sync -- <sha>   # pin to a specific commit
 *
 * Fetch and write, nothing else — every part of this that can be wrong lives in
 * `src/modules/protocol/protocol.kb-ingest.ts`, which is typechecked, linted
 * and tested. This file is deliberately outside `tsconfig`'s `include`, so keep
 * it that way: logic added here is logic nothing checks.
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildKbCorpus,
  renderKbCorpusModule,
} from "../src/modules/protocol/protocol.kb-ingest.js";

const REPO = "ONDC-Official/automation-kb-studio";
const DIR = "kb-docs";
const OUT = "src/modules/protocol/protocol.kb-corpus.generated.ts";

/** A sanity band on the whole corpus, in bytes. */
const MIN_BYTES = 80_000;
const MAX_BYTES = 400_000;

function say(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} → ${String(response.status)}`);
  }
  return (await response.json()) as T;
}

async function getText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} → ${String(response.status)}`);
  }
  return await response.text();
}

async function main(): Promise<void> {
  // Resolve main to one commit up front, then read every file at that commit.
  // Resolving per file would let the set skew underneath a slow run.
  const pinned = process.argv[2];
  const sha =
    pinned ??
    (
      await getJson<{ sha: string }>(
        `https://api.github.com/repos/${REPO}/commits/main`,
      )
    ).sha;
  say(`pinning ${REPO} @ ${sha}`);

  const listing = await getJson<{ name: string; type: string }[]>(
    `https://api.github.com/repos/${REPO}/contents/${DIR}?ref=${sha}`,
  );
  const names = listing
    .filter((entry) => entry.type === "file" && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();

  const raw = (name: string): string =>
    `https://raw.githubusercontent.com/${REPO}/${sha}/${DIR}/${name}`;

  const bodies = await Promise.all(
    names.map(async (name) => [name, await getText(raw(name))] as const),
  );

  const readme = bodies.find(([name]) => name === "README.md")?.[1];
  if (readme === undefined) throw new Error(`no README.md in ${DIR}/`);

  const files = new Map(bodies.filter(([name]) => name !== "README.md"));
  say(`fetched ${String(files.size)} documents`);

  const docs = buildKbCorpus(files, readme);
  const bytes = docs.reduce((total, doc) => total + doc.body.length, 0);
  if (bytes < MIN_BYTES || bytes > MAX_BYTES) {
    throw new Error(
      `corpus is ${String(bytes)} bytes, outside the ${String(MIN_BYTES)}-${String(MAX_BYTES)} sanity band`,
    );
  }

  const asOf = new Date().toISOString().slice(0, 10);
  const rendered = renderKbCorpusModule(
    docs,
    { repo: REPO, sha, path: DIR },
    asOf,
  );

  // Formatted here rather than in a follow-up npm step, so the round-trip
  // below verifies the bytes that actually land on disk. Prettier never
  // reformats the inside of a template literal, so this cannot touch a body.
  const prettier = await import("prettier");
  const module = await prettier.format(rendered, { parser: "typescript" });

  const out = resolve(process.cwd(), OUT);
  await writeFile(out, module, "utf8");
  say(
    `wrote ${OUT} — ${String(docs.length)} docs, ${String(bytes)} body bytes`,
  );

  // Round-trip: evaluate what was just written and compare it to what went in.
  // Escaping is the one step here that fails silently, and a corrupt corpus
  // typechecks perfectly.
  const written = (await import(`${out}?t=${String(Date.now())}`)) as {
    KB_KNOWLEDGE: { id: string; body: string }[];
  };
  if (written.KB_KNOWLEDGE.length !== docs.length) {
    throw new Error("round-trip: document count changed");
  }
  for (const [index, doc] of docs.entries()) {
    const back = written.KB_KNOWLEDGE[index];
    if (back?.id !== doc.id || back.body !== doc.body) {
      throw new Error(`round-trip: ${doc.id} did not survive escaping`);
    }
  }
  say("round-trip verified");
}

main().catch((error: unknown) => {
  say(
    `kb:sync failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
