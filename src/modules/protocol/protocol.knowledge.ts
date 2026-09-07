import {
  AS_OF,
  KNOWLEDGE,
  type KnowledgeDoc,
} from "@/modules/protocol/protocol.knowledge-corpus.js";

/**
 * Searching the network-wide corpus. Pure.
 *
 * Sections, not whole documents: a document is 1.5-3 KB and a model asking
 * "how does key rotation work" wants the paragraph, not the file. Splitting on
 * `##` gives a unit that is self-contained (each has its own heading) and small
 * enough that three of them fit comfortably in a tool result.
 *
 * The ranking is deliberately dumb — term overlap, heading weighted above body.
 * There is no embedding model here and there should not be: the corpus is five
 * documents, the queries are keyword-shaped ("signing", "ttl", "registry"), and
 * a scoring function anyone can read beats one nobody can debug.
 */

export { AS_OF };

export interface KnowledgeSectionHit {
  topic: string;
  title: string;
  heading: string;
  body: string;
}

interface Section extends KnowledgeSectionHit {
  haystack: string;
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
    sections.push({
      topic: doc.id,
      title: doc.title,
      heading,
      body,
      haystack: `${doc.id} ${doc.title} ${heading} ${body}`.toLowerCase(),
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
const SECTIONS: readonly Section[] = KNOWLEDGE.flatMap(sectionsOf);

export const TOPICS: readonly string[] = KNOWLEDGE.map((doc) => doc.id);

/**
 * Terms worth matching on.
 *
 * Two characters or fewer are dropped — "is", "a", "of" match everything and
 * would flatten the ranking into document order.
 */
function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((term) => term.length > 2);
}

export interface KnowledgeSearch {
  sections: KnowledgeSectionHit[];
  total: number;
}

export function searchKnowledge(
  query: string,
  options: { topic?: string | undefined; limit: number },
): KnowledgeSearch {
  const scope =
    options.topic === undefined
      ? SECTIONS
      : SECTIONS.filter((section) => section.topic === options.topic);

  const needles = terms(query);
  if (needles.length === 0) {
    // An empty or all-stopword query is a request for orientation, not a
    // failure — hand back the openings rather than nothing.
    const opening = scope.slice(0, options.limit);
    return { sections: opening.map(strip), total: scope.length };
  }

  const scored = scope
    .map((section) => {
      let score = 0;
      for (const needle of needles) {
        if (section.heading.toLowerCase().includes(needle)) score += 3;
        if (section.topic.includes(needle)) score += 2;
        if (section.haystack.includes(needle)) score += 1;
      }
      return { section, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return {
    sections: scored
      .slice(0, options.limit)
      .map((entry) => strip(entry.section)),
    total: scored.length,
  };
}

function strip(section: Section): KnowledgeSectionHit {
  const { topic, title, heading, body } = section;
  return { topic, title, heading, body };
}
