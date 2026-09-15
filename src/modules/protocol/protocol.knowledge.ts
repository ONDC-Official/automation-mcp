import {
  AS_OF,
  KNOWLEDGE,
  type KnowledgeDoc,
} from "@/modules/protocol/protocol.knowledge-corpus.js";
import {
  KB_AS_OF,
  KB_KNOWLEDGE,
  KB_SOURCE,
} from "@/modules/protocol/protocol.kb-corpus.generated.js";

/**
 * Searching the network-wide corpus. Pure.
 *
 * Two layers, one index. `KNOWLEDGE` is five hand-written documents — short,
 * blunt, written for a model driving *this* server. `KB_KNOWLEDGE` is the 63
 * documents ONDC publishes, longer and written for somebody implementing a
 * participant. They are searched together because they answer the same kind of
 * question, and a model asked to choose between two near-identical tools will
 * choose wrong.
 *
 * Sections, not whole documents: a document is 1.5-5 KB and a model asking
 * "how does key rotation work" wants the paragraph, not the file. Splitting on
 * `##` gives a unit that is self-contained (each has its own heading) and small
 * enough that three of them fit comfortably in a tool result.
 *
 * ## Why the ranking changed
 *
 * The original scorer — heading +3, topic +2, body +1, additive over terms —
 * was written for five documents and said so. At ~500 sections it breaks in
 * three specific ways, and all three are fixed below rather than papered over:
 *
 * 1. **No coverage requirement.** Additive scoring lets a section that matches
 *    one term three ways outrank a section that matches every term once. So
 *    `COVERAGE` now dominates everything else: matching more distinct query
 *    terms always wins.
 * 2. **Boilerplate headings.** Every kb-doc has `## Objective`, `## Sources`,
 *    `## Deliverable`. Weighting headings rewarded structure, not relevance,
 *    so those headings are excluded from the heading bonus — but not from the
 *    body text, because the prose under `## Protocol nuances` is the most
 *    valuable prose in the corpus.
 * 3. **No rarity.** `ondc` appears in almost every section and `blake2b` in
 *    three; they scored the same. A document-frequency map, built once at load,
 *    separates them.
 *
 * It is still a scoring function anyone can read, and that is deliberate: there
 * is no embedding model here and there should not be.
 */

export { AS_OF, KB_AS_OF, KB_SOURCE };

/** The two layers, in rank-neutral order — core first, so does orientation. */
const ALL_DOCS: readonly KnowledgeDoc[] = [...KNOWLEDGE, ...KB_KNOWLEDGE];

export interface KnowledgeSectionHit {
  topic: string;
  title: string;
  heading: string;
  body: string;
  tier: "core" | "kb";
  category?: string;
  status?: string;
  /** The body was cut to fit the budget; the whole document is a resource. */
  truncated: boolean;
}

interface Section extends KnowledgeSectionHit {
  haystack: string;
  /** The section's own prose, without the id and title the haystack adds. */
  text: string;
  /** Stems of that prose alone — what the `BODY` bonus is allowed to see. */
  bodyStems: ReadonlySet<string>;
  stems: ReadonlySet<string>;
}

/**
 * Headings that say nothing about what a section is about.
 *
 * Every published kb-doc has all of these, so a query term landing in one is
 * noise. Compared lowercased, and by prefix — `Protocol nuances (why this is
 * ONDC-peculiar)` and `Guideline (the 9 steps / session setup)` are the same
 * boilerplate with a parenthetical.
 */
const BOILERPLATE_HEADINGS = [
  "objective",
  "prerequisite",
  "deliverable",
  "guideline",
  "sources",
  "protocol nuances",
];

function isBoilerplate(heading: string): boolean {
  const lower = heading.toLowerCase();
  return BOILERPLATE_HEADINGS.some((entry) => lower.startsWith(entry));
}

/**
 * Words that carry no topic.
 *
 * Length alone is not enough once coverage dominates the score. "how do I sign
 * a request" keeps `how`, and a verbose section that happens to contain it
 * scores a full extra term — which is how a question about signing came back
 * from the registry document instead. Function words only: anything that might
 * name a thing on the network stays, and `idf` handles the merely common.
 */
const STOPWORDS = new Set([
  "about",
  "and",
  "any",
  "are",
  "been",
  "being",
  "but",
  "can",
  "could",
  "did",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "into",
  "its",
  "may",
  "must",
  "not",
  "over",
  "should",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "upon",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

/**
 * Terms worth matching on.
 *
 * Two characters or fewer are dropped — "is", "a", "of" match everything and
 * would flatten the ranking into document order.
 */
function terms(query: string): string[] {
  return tokens(query.toLowerCase()).filter((token) => !STOPWORDS.has(token));
}

function tokens(text: string): string[] {
  return text.split(/[^a-z0-9_]+/).filter((token) => token.length > 2);
}

/**
 * Enough stemming to join a query to the prose, and no more.
 *
 * Substring matching cannot connect "rotate" to "rotation" — they share a
 * prefix but neither contains the other — so a query about rotating a key
 * missed the document called Key Rotation entirely. Suffixes are stripped only
 * when four characters survive, which keeps "codes" → "code" while leaving
 * "states" and "terms" recognisable and never touching "ttl" or "blake2b".
 */
const SUFFIXES = [
  "ations",
  "ation",
  "ions",
  "ing",
  "ion",
  "ies",
  "ers",
  "er",
  "es",
  "ed",
  "s",
  "e",
];

function stem(word: string): string {
  for (const suffix of SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

/** Split one document into its `##` sections, keeping the preamble. */
function sectionsOf(doc: KnowledgeDoc): Section[] {
  const lines = doc.body.split("\n");
  const sections: Section[] = [];
  let heading = doc.title;
  let buffer: string[] = [];

  const flush = (): void => {
    const body = buffer.join("\n").trim();
    if (body === "") return;
    const haystack = `${doc.id} ${doc.title} ${heading} ${body}`.toLowerCase();
    sections.push({
      topic: doc.id,
      title: doc.title,
      heading,
      body,
      tier: doc.tier ?? "core",
      ...(doc.category !== undefined ? { category: doc.category } : {}),
      ...(doc.status !== undefined ? { status: doc.status } : {}),
      truncated: false,
      haystack,
      text: body.toLowerCase(),
      bodyStems: new Set(tokens(body.toLowerCase()).map(stem)),
      stems: new Set(tokens(haystack).map(stem)),
    });
  };

  for (const line of lines) {
    const match = /^##\s+(.*)$/.exec(line);
    if (match) {
      flush();
      heading = match[1] ?? doc.title;
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

/** Built once at module load: the corpus is a constant. */
const SECTIONS: readonly Section[] = ALL_DOCS.flatMap(sectionsOf);

const BY_ID = new Map(ALL_DOCS.map((doc) => [doc.id, doc] as const));

export const TOPICS: readonly string[] = ALL_DOCS.map((doc) => doc.id);
export const CORE_TOPICS: readonly string[] = KNOWLEDGE.map((doc) => doc.id);
export const CATEGORIES: readonly string[] = [
  ...new Set(
    ALL_DOCS.map((doc) => doc.category).filter(
      (entry): entry is string => entry !== undefined,
    ),
  ),
].sort();

/** The whole document, for `ondc://knowledge/{topicId}`. */
export function knowledgeDoc(id: string): KnowledgeDoc | undefined {
  return BY_ID.get(id);
}

export function hasTopic(id: string): boolean {
  return BY_ID.has(id);
}

export interface KnowledgeEntry {
  id: string;
  title: string;
  tier: "core" | "kb";
  category?: string;
  status?: string;
}

/** The index, for `ondc://knowledge`. */
export function knowledgeIndex(): KnowledgeEntry[] {
  return ALL_DOCS.map((doc) => ({
    id: doc.id,
    title: doc.title,
    tier: doc.tier ?? "core",
    ...(doc.category !== undefined ? { category: doc.category } : {}),
    ...(doc.status !== undefined ? { status: doc.status } : {}),
  }));
}

/**
 * Rarity, from the corpus itself.
 *
 * `ondc` is in nearly every section and `blake2b` in three. Without this they
 * score identically, and a two-word query where one word is ubiquitous ranks
 * by the ubiquitous half — which is how "how do I sign a request" came back
 * from the async-contract document: `request` is in half the corpus and was
 * worth exactly as much as `sign`.
 */
const DOC_FREQUENCY = ((): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const section of SECTIONS) {
    for (const word of section.stems) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return counts;
})();

/** What one section could possibly be worth: a term nothing else uses. */
const MAX_IDF = Math.log(SECTIONS.length);

/**
 * How much matching this term is worth, in (0, 1].
 *
 * Floored rather than allowed to reach zero: a term in every section still
 * says the section is on the right subject, and a zero would make coverage
 * blind to it. Capped at 1 so no single rare term can outweigh covering the
 * whole query.
 */
function weight(term: string): number {
  const df = DOC_FREQUENCY.get(stem(term)) ?? 0;
  const raw = Math.log(SECTIONS.length / (1 + df)) / MAX_IDF;
  return Math.min(1, Math.max(0.05, raw));
}

/**
 * Weights.
 *
 * `COVERAGE` is well above the rest on purpose: covering more of the query
 * beats matching part of it harder. The rest only order sections that cover
 * the query equally well.
 *
 * **Every one of them is multiplied by the term's own `weight`** — see `score`.
 * Flat bonuses reintroduce exactly the bug that weighting coverage fixed: with
 * them, `async-contract` tied the `signing` document for "how do I sign a
 * request", because its title contains `request` and a title hit on a word in
 * half the corpus counted for as much as one on `sign`.
 */
const COVERAGE = 100;
/**
 * A term in the section's own prose, rather than only in the document id and
 * title the haystack prepends.
 *
 * Without this every section of `30-key-rotation` matches "rotation" equally —
 * the word is in the id — so they tie on coverage and the answer falls back to
 * document order, which puts `## Prerequisite` first. It is the largest of the
 * tiebreaks because it is the only one that says the section itself, and not
 * merely the document it is filed under, is about the thing being asked.
 */
const BODY = 20;
const TITLE = 25;
const ID = 25;
const HEADING = 15;

/**
 * A one-sentence section is an index entry, not an answer.
 *
 * This replaced a penalty on *long* sections, which was the wrong instrument
 * twice over: once coverage is weighted by rarity a long section no longer
 * gets free matches, and penalising length actively promoted the published
 * documents' `## Deliverable` — a single sentence, in all sixty-three of them.
 * "How do I sign a request" came back from a one-line Deliverable while the
 * document that actually explains the signing string ranked below it.
 *
 * Note this is not a demotion of boilerplate headings as such:
 * `## Protocol nuances` carries the best prose in the corpus and is nowhere
 * near the threshold. Only thinness is penalised, and it decays to nothing.
 */
const SUBSTANTIAL = 400;
const THIN = 8;

function thinness(section: Section): number {
  const length = section.body.length;
  if (length >= SUBSTANTIAL) return 0;
  return (1 - length / SUBSTANTIAL) * THIN;
}

/**
 * Does this section use this term?
 *
 * Substring first, because it is what connects `blake2b`, `transaction_id` and
 * `x-errorcodes` to prose that spells them the same way; stem second, for the
 * inflections substring matching cannot reach.
 */
function matches(section: Section, needle: string): boolean {
  return section.haystack.includes(needle) || section.stems.has(stem(needle));
}

function score(section: Section, needles: readonly string[]): number {
  const matched = needles.filter((needle) => matches(section, needle));
  if (matched.length === 0) return 0;

  const heading = section.heading.toLowerCase();
  const title = section.title.toLowerCase();
  const boilerplate = isBoilerplate(section.heading);

  let total = 0;
  for (const needle of matched) {
    let term = COVERAGE;
    if (section.text.includes(needle) || section.bodyStems.has(stem(needle)))
      term += BODY;
    if (title.includes(needle)) term += TITLE;
    if (section.topic.includes(needle)) term += ID;
    if (!boilerplate && heading.includes(needle)) term += HEADING;
    // Scaled by rarity, like coverage itself: what a match is worth depends on
    // which word matched, not only on where in the section it landed.
    total += term * weight(needle);
  }
  return total - thinness(section);
}

/** Per returned section body. The whole document is a resource away. */
export const MAX_SECTION_BYTES = 1_200;
/** Across the whole answer. Tool output reaches the model twice over. */
export const MAX_RESULT_BYTES = 8_000;

function clip(section: Section): KnowledgeSectionHit {
  const { topic, title, heading, body, tier, category, status } = section;
  const base = {
    topic,
    title,
    heading,
    tier,
    ...(category !== undefined ? { category } : {}),
    ...(status !== undefined ? { status } : {}),
  };
  if (body.length <= MAX_SECTION_BYTES) {
    return { ...base, body, truncated: false };
  }
  // Cut at a line boundary: half a markdown table row reads as data.
  const cut = body.slice(0, MAX_SECTION_BYTES);
  const at = cut.lastIndexOf("\n");
  return {
    ...base,
    body: (at > MAX_SECTION_BYTES / 2 ? cut.slice(0, at) : cut).trimEnd(),
    truncated: true,
  };
}

export interface KnowledgeSearch {
  sections: KnowledgeSectionHit[];
  total: number;
  /** Matched, selected, then dropped by the byte budget. */
  elided: number;
}

interface Scored {
  section: Section;
  value: number;
}

/**
 * Which sections make the answer.
 *
 * Two rules on top of the score, both structural rather than tuned:
 *
 * - **At most `perDoc` sections from one document.** Without it a signing
 *   query returns three slices of `01-signature-verification` and the model
 *   never learns that 26, 27, 28 and 30 exist.
 * - **One slot reserved for the orientation layer.** The tempting alternative
 *   is a score bonus for `tier: "core"`, tuned until the existing routing
 *   assertions go green — at which point those tests pass by coincidence, and
 *   the next well-scoring upstream document silently pushes `signing` out
 *   again. Reserving a slot states the intent in one branch a test can assert.
 *   Skipped at `limit: 1`, where the caller asked for the single best answer,
 *   and moot under a filter, which has already narrowed the scope.
 */
function select(scored: readonly Scored[], limit: number): Section[] {
  const perDoc = Math.max(1, Math.floor(limit / 3));
  const picked: Scored[] = [];
  const used = new Map<string, number>();

  for (const entry of scored) {
    if (picked.length >= limit) break;
    const seen = used.get(entry.section.topic) ?? 0;
    if (seen >= perDoc) continue;
    used.set(entry.section.topic, seen + 1);
    picked.push(entry);
  }

  if (limit > 1 && !picked.some((entry) => entry.section.tier === "core")) {
    const core = scored.find((entry) => entry.section.tier === "core");
    if (core !== undefined) picked[picked.length - 1] = core;
  }

  return picked.map((entry) => entry.section);
}

/** Apply the whole-answer budget, reporting what it cost. */
function budget(sections: readonly Section[]): {
  hits: KnowledgeSectionHit[];
  elided: number;
} {
  const hits: KnowledgeSectionHit[] = [];
  let spent = 0;

  for (const section of sections) {
    const hit = clip(section);
    if (hits.length > 0 && spent + hit.body.length > MAX_RESULT_BYTES) break;
    hits.push(hit);
    spent += hit.body.length;
  }
  return { hits, elided: sections.length - hits.length };
}

export interface KnowledgeQuery {
  topic?: string | undefined;
  category?: string | undefined;
  limit: number;
}

export function searchKnowledge(
  query: string,
  options: KnowledgeQuery,
): KnowledgeSearch {
  let scope: readonly Section[] = SECTIONS;
  if (options.topic !== undefined) {
    scope = scope.filter((section) => section.topic === options.topic);
  }
  if (options.category !== undefined) {
    const wanted = options.category.toLowerCase();
    scope = scope.filter(
      (section) => (section.category ?? "").toLowerCase() === wanted,
    );
  }

  const needles = terms(query);
  if (needles.length === 0) {
    // An empty or all-stopword query is a request for orientation, not a
    // failure — hand back the openings rather than nothing. `ALL_DOCS` puts
    // the core layer first, so orientation is what arrives.
    const { hits, elided } = budget(scope.slice(0, options.limit));
    return { sections: hits, total: scope.length, elided };
  }

  const scored = scope
    .map((section) => ({ section, value: score(section, needles) }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value);

  const { hits, elided } = budget(select(scored, options.limit));
  return { sections: hits, total: scored.length, elided };
}
