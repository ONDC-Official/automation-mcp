import type { Logger } from "pino";
import { cacheKey, type CacheStore } from "@/lib/cache/cache-store.js";
import { NotFoundError, ValidationError } from "@/lib/errors.js";
import type { ConfigServiceGateway } from "@/modules/catalog/catalog.gateway.js";
import type { CatalogService } from "@/modules/catalog/catalog.service.js";
import type { SessionService } from "@/modules/session/session.service.js";
import {
  buildSpecBundle,
  type SpecBundle,
} from "@/modules/protocol/protocol.bundle.js";
import {
  compareRanked,
  filterFields,
  rankFields,
  type FieldNode,
  type RankedField,
} from "@/modules/protocol/protocol.attributes.js";
import {
  answers as answersOf,
  entryActions,
  mustEcho,
  realityFor,
  REALITY_NOTE,
  successorsOf,
} from "@/modules/protocol/protocol.graph.js";
import {
  indexRows,
  lookupRules,
  pseudoCodeNote,
} from "@/modules/protocol/protocol.rules.js";
import {
  AS_OF,
  CATEGORIES,
  hasTopic,
  KB_AS_OF,
  KB_SOURCE,
  knowledgeDoc,
  knowledgeIndex,
  searchKnowledge as searchCorpus,
  TOPICS,
} from "@/modules/protocol/protocol.knowledge.js";
import type {
  BuildSelector,
  DescribeActionInput,
  DescribeActionOutput,
  DescribeBuildOutput,
  ExplainRuleInput,
  ExplainRuleOutput,
  FlowReality,
  ListErrorCodesInput,
  ListErrorCodesOutput,
  NextActionsOutput,
  SearchFieldsInput,
  SearchFieldsOutput,
  SearchKnowledgeInput,
  SearchKnowledgeOutput,
} from "@/modules/protocol/protocol.schema.js";

/**
 * The published protocol spec, sliced for a model. Imports nothing from the
 * MCP SDK.
 *
 * ## Why this is a class with mutable state
 *
 * `#inflight` deduplicates concurrent fetches of the same build. Without it,
 * two tool calls a millisecond apart each pull 10.5 MB and each parse it. That
 * is the same sanctioned exception `FlowService#runLocks` is — an in-process
 * lock, not a distributed one, held for the length of one operation and
 * released in a `finally`.
 *
 * `#recent` is the LRU that enforces `maxBundles`. `CacheStore` has no size
 * accounting and should not grow any: it is a shared port, and adding eviction
 * for one module's need would oblige `RedisCacheStore` to answer a semantic it
 * cannot cheaply provide.
 *
 * ## Where the bundles live, and where they do not
 *
 * `catalogCache` — the in-process, TTL'd store for derived data — never
 * `stateStore`. A bundle is re-fetchable on a miss and nothing is lost by
 * dropping it, which is precisely the distinction `createContainer` already
 * draws for mock configs. Round-tripping ~2 MB through Redis per read would be
 * strictly worse than re-fetching.
 *
 * ## Failure posture: loud, with exactly one exception
 *
 * Everything here throws `UpstreamError` / `ValidationError` on failure — the
 * tool channel, which a model reads and retries. This module does **not** fail
 * open the way `validate/` does: `validate` swallows an unavailable oracle
 * because NACKing a compliant participant over our own outage would write our
 * infrastructure failure into their compliance report. Nothing here is on a
 * transaction's path, and "this action has no fields" is a worse answer than an
 * error.
 *
 * The exception is `realityFor`, which rides along on `catalog_describe_flow`.
 * See its own note.
 */

export interface ProtocolServiceOptions {
  gateway: ConfigServiceGateway;
  catalog: CatalogService;
  sessions: SessionService;
  /** Always `catalogCache` — derived data, in-process. */
  cache: CacheStore;
  cacheTtlMs: number;
  maxBundles: number;
  maxSpecBytes: number;
  logger: Logger;
}

/** A build named well enough to fetch a spec for. `usecase` is often optional. */
export interface ResolvedBuild {
  domain: string;
  version: string;
  usecase?: string;
}

export class ProtocolService {
  readonly #gateway: ConfigServiceGateway;
  readonly #catalog: CatalogService;
  readonly #sessions: SessionService;
  readonly #cache: CacheStore;
  readonly #ttl: number;
  readonly #maxBundles: number;
  readonly #maxSpecBytes: number;
  readonly #logger: Logger;
  readonly #inflight = new Map<string, Promise<SpecBundle>>();
  /** Cache keys, most-recently-used last. */
  #recent: string[] = [];

  constructor(options: ProtocolServiceOptions) {
    this.#gateway = options.gateway;
    this.#catalog = options.catalog;
    this.#sessions = options.sessions;
    this.#cache = options.cache;
    this.#ttl = options.cacheTtlMs;
    this.#maxBundles = options.maxBundles;
    this.#maxSpecBytes = options.maxSpecBytes;
    this.#logger = options.logger;
  }

  /** How many bundles this process is holding. Read by the metrics gauge. */
  residentBundles(): number {
    return this.#recent.length;
  }

  /**
   * Turn "however the caller named a build" into a build.
   *
   * One function rather than four tool handlers, because the rule is a single
   * decision and four copies of it drift. The shape mirrors `flow_await`'s
   * existing "either this or that or neither" resolution.
   */
  async resolveBuild(
    selector: BuildSelector,
    options: { requireUsecase?: boolean } = {},
  ): Promise<ResolvedBuild> {
    if (selector.session_id !== undefined) {
      const session = await this.#sessions.requireSession(selector.session_id);
      return {
        domain: session.build.domain,
        version: session.build.version,
        usecase: session.build.usecase,
      };
    }

    if (selector.domain === undefined || selector.version === undefined) {
      throw new ValidationError(
        "Name the build: give domain and version (and usecase where a field " +
          "dictionary is needed), or give session_id to use that session's build.",
        {
          given: {
            domain: selector.domain ?? null,
            version: selector.version ?? null,
            session_id: null,
          },
        },
      );
    }

    // Validate before fetching. The config-service answers an unknown build
    // with an empty-ish document rather than a 404, so without this a typo
    // reads as "this build publishes nothing" — the same trap `assertBuild`
    // exists to close for flows.
    const builds = await this.#catalog.listBuilds(selector.domain);
    const domain = builds.find((entry) => entry.domain === selector.domain);
    if (domain === undefined) {
      throw new ValidationError(
        `Unknown domain "${selector.domain}". Call catalog_list_builds to see what is published.`,
        { domain: selector.domain },
      );
    }
    const version = domain.versions.find(
      (entry) => entry.version === selector.version,
    );
    if (version === undefined) {
      throw new ValidationError(
        `Unknown version "${selector.version}" for ${selector.domain}.`,
        {
          domain: selector.domain,
          version: selector.version,
          valid_versions: domain.versions.map((entry) => entry.version),
        },
      );
    }

    let usecase = selector.usecase;
    if (usecase !== undefined && !version.usecases.includes(usecase)) {
      throw new ValidationError(
        `Unknown use-case "${usecase}" for ${selector.domain} ${selector.version}. ` +
          "Use-case names are case- and space-sensitive.",
        { valid_usecases: version.usecases },
      );
    }
    if (usecase === undefined && options.requireUsecase === true) {
      // One published use-case is not a choice, so do not make the caller make it.
      if (version.usecases.length === 1) {
        usecase = version.usecases[0];
      } else {
        throw new ValidationError(
          `${selector.domain} ${selector.version} publishes several use-cases; name one.`,
          { valid_usecases: version.usecases },
        );
      }
    }

    return {
      domain: selector.domain,
      version: selector.version,
      ...(usecase !== undefined ? { usecase } : {}),
    };
  }

  /** The bundle for a build: cached, deduplicated, capped. */
  async bundle(domain: string, version: string): Promise<SpecBundle> {
    // The domain carries a single `:` and the joiner is `::` — close enough to
    // a collision to be worth naming, far enough to be safe: no domain code
    // ends in `:` and no version begins with one.
    const key = cacheKey("spec", domain, version);

    const cached = await this.#cache.get<SpecBundle>(key);
    if (cached) {
      this.#touch(key);
      return cached;
    }

    const existing = this.#inflight.get(key);
    if (existing) return existing;

    const pending = this.#fetchBundle(domain, version, key);
    this.#inflight.set(key, pending);
    try {
      return await pending;
    } finally {
      this.#inflight.delete(key);
    }
  }

  async #fetchBundle(
    domain: string,
    version: string,
    key: string,
  ): Promise<SpecBundle> {
    const started = performance.now();
    const raw = await this.#gateway.fetchSpec(
      domain,
      version,
      this.#maxSpecBytes,
    );
    const bundle = buildSpecBundle({ domain, version, raw });
    this.#logger.debug(
      {
        domain,
        version,
        retained_bytes: bundle.bytes,
        ms: Math.round(performance.now() - started),
      },
      "built protocol spec bundle",
    );
    await this.#cache.set(key, bundle, this.#ttl);
    await this.#admit(key);
    return bundle;
  }

  #touch(key: string): void {
    this.#recent = [...this.#recent.filter((entry) => entry !== key), key];
  }

  async #admit(key: string): Promise<void> {
    this.#touch(key);
    while (this.#recent.length > this.#maxBundles) {
      const evicted = this.#recent.shift();
      if (evicted === undefined) break;
      await this.#cache.delete(evicted);
      this.#logger.debug({ key: evicted }, "evicted a protocol spec bundle");
    }
  }

  /** Orientation: what this build is, what it defines, where a transaction starts. */
  async describeBuild(
    selector: BuildSelector,
    include: readonly string[],
  ): Promise<DescribeBuildOutput> {
    const build = await this.resolveBuild(selector);
    const bundle = await this.bundle(build.domain, build.version);
    const wants = new Set(include);

    const ruleCount = Object.values(bundle.rule_counts).reduce(
      (total, count) => total + count,
      0,
    );

    return {
      domain: bundle.domain,
      version: bundle.version,
      ...(bundle.title !== undefined ? { title: bundle.title } : {}),
      ...(wants.has("overview") && bundle.docs.overview !== undefined
        ? { overview: bundle.docs.overview }
        : {}),
      usecases: [...bundle.usecases],
      actions: [...bundle.actions],
      may_start_with: entryActions(bundle.graph),
      error_code_count: bundle.error_codes.length,
      rule_count: ruleCount,
      flows: wants.has("flows")
        ? bundle.flows.map((flow) => ({ ...flow, tags: [...flow.tags] }))
        : [],
      mandatory_flow_count: bundle.flows.filter((flow) =>
        flow.tags.includes("MANDATORY"),
      ).length,
      ...(bundle.build_hash !== undefined
        ? { build_hash: bundle.build_hash }
        : {}),
      ...(bundle.ingested_at !== undefined
        ? { ingested_at: bundle.ingested_at }
        : {}),
      ...(wants.has("error_codes")
        ? { error_codes: [...bundle.error_codes] }
        : {}),
      ...(wants.has("recent_changes")
        ? { recent_changes: [...bundle.recent_changes] }
        : {}),
      note: REALITY_NOTE,
    };
  }

  /** What the spec permits after a given action. */
  async nextActions(
    selector: BuildSelector,
    after: string | null,
  ): Promise<NextActionsOutput> {
    const build = await this.resolveBuild(selector);
    const bundle = await this.bundle(build.domain, build.version);

    if (after !== null && !bundle.actions.includes(after)) {
      throw new ValidationError(
        `${bundle.domain} ${bundle.version} does not define an action "${after}".`,
        { valid_actions: [...bundle.actions] },
      );
    }

    const next = successorsOf(bundle.graph, after);
    return {
      domain: bundle.domain,
      version: bundle.version,
      after,
      next,
      terminal: next.length === 0,
      note: REALITY_NOTE,
    };
  }

  /**
   * The field dictionary for one use-case and action.
   *
   * `NotFoundError` rather than an empty list when a use-case publishes no
   * dictionary: "this action has no fields" is a wrong answer that a model
   * cannot tell from a true one.
   */
  #fieldsFor(
    bundle: SpecBundle,
    usecase: string,
    action: string,
  ): readonly FieldNode[] {
    const byAction = bundle.fields[usecase];
    if (byAction === undefined) {
      throw new NotFoundError("field dictionary", usecase, {
        published_for: Object.keys(bundle.fields),
      });
    }
    return byAction[action] ?? [];
  }

  #assertAction(bundle: SpecBundle, action: string): void {
    if (bundle.actions.includes(action)) return;
    throw new ValidationError(
      `${bundle.domain} ${bundle.version} does not define an action "${action}".`,
      { valid_actions: [...bundle.actions] },
    );
  }

  /** One action: its fields, its rules, who sends it and what it must echo. */
  async describeAction(
    input: DescribeActionInput,
  ): Promise<DescribeActionOutput> {
    const wants = new Set(input.include ?? ["fields"]);
    const needsUsecase = wants.has("fields");
    const build = await this.resolveBuild(input, {
      requireUsecase: needsUsecase,
    });
    const bundle = await this.bundle(build.domain, build.version);
    this.#assertAction(bundle, input.action);

    const limit = input.limit ?? 30;
    const out: DescribeActionOutput = {
      domain: bundle.domain,
      version: bundle.version,
      ...(build.usecase !== undefined ? { usecase: build.usecase } : {}),
      action: input.action,
      ...(answersOf(bundle.graph, input.action) !== undefined
        ? { answers: answersOf(bundle.graph, input.action) }
        : {}),
      must_echo: mustEcho(bundle.graph, input.action),
      legal_next: successorsOf(bundle.graph, input.action).map((e) => e.action),
      note: REALITY_NOTE,
    };

    if (needsUsecase && build.usecase !== undefined) {
      const all = this.#fieldsFor(bundle, build.usecase, input.action);
      const narrowed = filterFields(all, {
        path_prefix: input.path_prefix,
        // A default depth is what makes this tool usable at all: RET11's
        // `on_search` publishes 179 fields and its rules run to 387 rows.
        max_depth: input.max_depth ?? 4,
        required_only: input.required_only,
        owner: input.owner,
      });
      out.fields = {
        total: narrowed.length,
        returned: Math.min(narrowed.length, limit),
        truncated: narrowed.length > limit,
        items: narrowed.slice(0, limit),
      };
      // The most common owner across the action's fields is the side that
      // sends it. Derived rather than asserted, and omitted when the fields
      // disagree too much to be worth a claim.
      // Derived from the whole action, never the narrowed view: a
      // `path_prefix` of `$.context` would otherwise report the requester as
      // the author of a callback.
      out.owner = dominantOwner(all);
    }

    if (wants.has("rules")) {
      const rows = bundle.rules.filter((row) => row.action === input.action);
      out.rules = {
        total: rows.length,
        returned: Math.min(rows.length, limit),
        truncated: rows.length > limit,
        items: rows.slice(0, limit),
      };
    }

    if (wants.has("error_codes")) {
      out.error_codes = [...bundle.error_codes];
    }

    if (wants.has("schema")) {
      const schema = bundle.schemas[input.action];
      if (schema !== undefined) {
        // Never inlined: 0.8-6.8 KB of OpenAPI would swamp the answer, and a
        // resource is pulled deliberately rather than landing in context on a
        // call the model did not intend. `catalog_load_flow_config`'s pattern.
        out.schema = {
          bytes: JSON.stringify(schema).length,
          resource_uri: `ondc://schema/${bundle.domain}/${bundle.version}/${input.action}`,
        };
      }
    }

    return out;
  }

  /** Free-text search over the field dictionary, across actions. */
  async searchFields(input: SearchFieldsInput): Promise<SearchFieldsOutput> {
    const build = await this.resolveBuild(input, { requireUsecase: true });
    const bundle = await this.bundle(build.domain, build.version);
    const usecase = build.usecase as string;
    const limit = input.limit ?? 25;

    const actions =
      input.actions ?? Object.keys(bundle.fields[usecase] ?? {}).sort();
    // Ranked across the merged set, not per action. Concatenating each
    // action's ranking and then truncating drops the best hit whenever an
    // earlier action has enough weak ones — see `compareRanked`.
    const ranked: (RankedField & { action: string })[] = [];
    for (const action of actions) {
      const fields = filterFields(this.#fieldsFor(bundle, usecase, action), {
        required_only: input.required_only,
      });
      for (const entry of rankFields(fields, input.query)) {
        ranked.push({ ...entry, action });
      }
    }
    ranked.sort(compareRanked);
    const hits: (FieldNode & { action: string })[] = ranked.map((entry) => ({
      ...entry.field,
      action: entry.action,
    }));

    return {
      domain: bundle.domain,
      version: bundle.version,
      usecase,
      query: input.query,
      total: hits.length,
      returned: Math.min(hits.length, limit),
      truncated: hits.length > limit,
      hits: hits.slice(0, limit),
    };
  }

  /**
   * A rule name, an error code, a JSONPath, or a finding's code — explained.
   *
   * This is the loop `validate/` left open: it scrapes rule codes out of a
   * rejection's prose and lifts a `docs_url` it never fetches, while the same
   * rules are published structurally.
   */
  async explainRule(input: ExplainRuleInput): Promise<ExplainRuleOutput> {
    const build = await this.resolveBuild(input);
    const bundle = await this.bundle(build.domain, build.version);
    const index = indexRows(bundle.rules);
    const found = lookupRules(index, input.query, {
      action: input.action,
      limit: input.limit ?? 20,
    });

    const note =
      found.kind === "pseudo_code"
        ? pseudoCodeNote(input.query)
        : found.total === 0
          ? `Nothing published under "${input.query}". If it came from a validator, ` +
            "try the finding's json_path instead — rule names differ by build."
          : undefined;

    const errorCode =
      found.kind === "error_code"
        ? bundle.error_codes.find((entry) => entry.code === input.query.trim())
        : undefined;

    return {
      domain: bundle.domain,
      version: bundle.version,
      query: input.query,
      query_kind: found.kind,
      total: found.total,
      returned: found.matches.length,
      truncated: found.total > found.matches.length,
      matches: found.matches,
      per_action: found.per_action,
      ...(errorCode !== undefined ? { error_code: errorCode } : {}),
      ...(note !== undefined ? { note } : {}),
    };
  }

  /** The build's error-code catalogue, optionally narrowed. */
  async listErrorCodes(
    input: ListErrorCodesInput,
  ): Promise<ListErrorCodesOutput> {
    const build = await this.resolveBuild(input);
    const bundle = await this.bundle(build.domain, build.version);

    const codes = bundle.error_codes.filter((entry) => {
      if (
        input.sent_by !== undefined &&
        entry.sent_by.toLowerCase() !== input.sent_by.toLowerCase()
      ) {
        return false;
      }
      if (input.used_in !== undefined && entry.used_in !== input.used_in) {
        return false;
      }
      return true;
    });

    return {
      domain: bundle.domain,
      version: bundle.version,
      total: bundle.error_codes.length,
      returned: codes.length,
      truncated: false,
      codes,
    };
  }

  /**
   * The network-wide corpus. No build, because none of it varies by build —
   * that is exactly why it is bundled rather than fetched.
   *
   * Two layers behind one query: this server's five orientation notes and the
   * 63 documents ONDC publishes. The model is not asked to choose between
   * them, because a model asked to pick between two near-identical tools picks
   * wrong.
   */
  searchKnowledge(input: SearchKnowledgeInput): SearchKnowledgeOutput {
    if (input.topic !== undefined && !hasTopic(input.topic)) {
      // With five topics a typo was obvious. With sixty-eight, an empty answer
      // reads as "the network has nothing on this" — which is a different and
      // much more expensive thing to believe.
      throw new NotFoundError("knowledge topic", input.topic, {
        categories: [...CATEGORIES],
        nearest: nearestTopics(input.topic),
      });
    }

    const limit = input.limit ?? 3;
    const found = searchCorpus(input.query, {
      topic: input.topic,
      category: input.category,
      limit,
    });
    const narrowed = input.topic !== undefined || input.category !== undefined;

    return {
      query: input.query,
      total: found.total,
      returned: found.sections.length,
      truncated: found.total > found.sections.length,
      elided: found.elided,
      sections: found.sections,
      categories: [...CATEGORIES],
      // Sixty-eight ids on every answer is noise, and tool output reaches a
      // model twice — once rendered, once as structured content. They are
      // worth the space only when the caller has nothing else to go on.
      ...(found.sections.length === 0 || narrowed
        ? { topics: [...TOPICS] }
        : {}),
      as_of: AS_OF,
      kb: {
        repo: KB_SOURCE.repo,
        sha: KB_SOURCE.sha,
        path: KB_SOURCE.path,
        docs: knowledgeIndex().filter((entry) => entry.tier === "kb").length,
        as_of: KB_AS_OF,
      },
      note:
        "This is written down in this server rather than fetched from the " +
        "network, so weigh its age. Anything build-specific — fields, rules, " +
        "error codes — comes from protocol_describe_action instead. Whole " +
        "documents are at ondc://knowledge/{topic}.",
    };
  }

  /** The knowledge index, for `ondc://knowledge`. */
  knowledgeIndex(): ReturnType<typeof knowledgeIndex> {
    return knowledgeIndex();
  }

  /** One whole knowledge document, for `ondc://knowledge/{topicId}`. */
  knowledgeDoc(id: string): NonNullable<ReturnType<typeof knowledgeDoc>> {
    const doc = knowledgeDoc(id);
    if (doc === undefined) {
      throw new NotFoundError("knowledge topic", id, {
        nearest: nearestTopics(id),
      });
    }
    return doc;
  }

  /** One action's request schema, for the resource. */
  async schemaFor(
    selector: BuildSelector,
    action: string,
  ): Promise<{
    domain: string;
    version: string;
    action: string;
    schema: unknown;
  }> {
    const build = await this.resolveBuild(selector);
    const bundle = await this.bundle(build.domain, build.version);
    this.#assertAction(bundle, action);
    const schema = bundle.schemas[action];
    if (schema === undefined) {
      throw new NotFoundError("schema", action, {
        domain: bundle.domain,
        version: bundle.version,
        published_for: Object.keys(bundle.schemas),
      });
    }
    return {
      domain: bundle.domain,
      version: bundle.version,
      action,
      schema,
    };
  }

  /**
   * The reality block that rides on `catalog_describe_flow`.
   *
   * **The one place this module fails open.** It is an annotation on somebody
   * else's answer, and `catalog_describe_flow` must not start failing because
   * the reference half is unreachable — a model driving a run would lose the
   * flow's sequence over a lookup it never asked for. Absent is a fine outcome;
   * broken is not.
   */
  async realityFor(
    build: { domain: string; version: string },
    sequenceActions: readonly string[],
  ): Promise<FlowReality | undefined> {
    try {
      const bundle = await this.bundle(build.domain, build.version);
      if (bundle.actions.length === 0) return undefined;
      return realityFor(bundle.graph, sequenceActions);
    } catch (error) {
      // Named, never bare: a swallowed store or upstream error here must still
      // be traceable, because the symptom is a block that silently stops
      // appearing.
      this.#logger.debug(
        { err: error, ...build },
        "no reality block: the protocol spec was unavailable",
      );
      return undefined;
    }
  }
}

/**
 * Which side authors an action's body, inferred from who owns its fields.
 *
 * Upstream states `owner` per field, never per action, so this is derived — and
 * it is derived from **`$.message` only**. Counting every field made it
 * unanswerable in practice: an action's `$.context` block is largely the
 * requester's identity echoed back, so `on_status` came out at neither side's
 * majority and reported nothing at all, on every build. The body is the part
 * the sender actually authors, and it is unanimous.
 *
 * Still a claim only on a clear majority, and silence otherwise: "probably the
 * BPP" is not something a model should act on.
 */
function dominantOwner(fields: readonly FieldNode[]): string | undefined {
  const counts = new Map<string, number>();
  for (const field of fields) {
    if (field.owner === undefined) continue;
    if (!field.path.startsWith("$.message")) continue;
    counts.set(field.owner, (counts.get(field.owner) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  if (total === 0) return undefined;
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (top === undefined) return undefined;
  return top[1] / total >= 0.6 ? top[0] : undefined;
}

/**
 * Ids worth suggesting for one that does not exist.
 *
 * A bare "no such topic" leaves a model guessing at a list of sixty-eight it
 * cannot see; the ids share long slugs, so a shared token is almost always the
 * right hint.
 */
function nearestTopics(id: string): string[] {
  const parts = id
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length > 2);
  return TOPICS.filter((topic) =>
    parts.some((part) => topic.toLowerCase().includes(part)),
  ).slice(0, 5);
}
