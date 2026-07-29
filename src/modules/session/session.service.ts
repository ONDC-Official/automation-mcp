import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { NotFoundError, ValidationError } from "@/lib/errors.js";
import type { BuildRef, NpType } from "@/modules/catalog/catalog.schema.js";
import {
  oppositeRole,
  receiverRole,
  type CatalogService,
} from "@/modules/catalog/catalog.service.js";
import type { ExpectationScope } from "@/modules/record/record.schema.js";
import type { SessionRepository } from "@/modules/session/session.repository.js";
import type {
  CreateSessionInput,
  CreateSessionOutput,
  Session,
} from "@/modules/session/session.schema.js";

/**
 * Business logic for sessions. Imports nothing from the MCP SDK.
 *
 * Creating a session does three things, in this order, and the order matters:
 *
 * 1. **Validate the build.** The config-service answers an unknown domain or
 *    use-case with an empty flow list rather than an error, so the build is
 *    checked against the published catalog first. A typo has to fail loudly
 *    here or it surfaces later as an inexplicably empty session.
 * 2. **Invert the role.** The participant's type decides ours: a BAP under test
 *    is answered by a mock BPP. Callers never supply this.
 * 3. **List the flows.** A session is only useful once the model can see what
 *    it can drive, so the flow summaries come back from the same call.
 */

export interface SessionServiceOptions {
  repository: SessionRepository;
  catalog: CatalogService;
  logger: Logger;
  /** How long a session stays resolvable. */
  sessionTtlMs: number;
  /**
   * Default base URL a participant reaches this server's receiver on.
   * Per-session override comes in on `receiver_public_url`.
   */
  receiverPublicUrl: string;
  /**
   * Path the receiver routes are actually mounted under. A per-session
   * `receiver_public_url` may move the host but not this, because routes are
   * registered once at boot and cannot vary per session.
   */
  receiverRoutePrefix: string;
}

export class SessionService {
  readonly #repository: SessionRepository;
  readonly #catalog: CatalogService;
  readonly #logger: Logger;
  readonly #ttl: number;
  readonly #receiverPublicUrl: string;
  readonly #routePrefix: string;

  constructor(options: SessionServiceOptions) {
    this.#repository = options.repository;
    this.#catalog = options.catalog;
    this.#logger = options.logger;
    this.#ttl = options.sessionTtlMs;
    this.#receiverPublicUrl = options.receiverPublicUrl.replace(/\/+$/, "");
    this.#routePrefix = options.receiverRoutePrefix.replace(/\/+$/, "");
  }

  async createSession(
    input: CreateSessionInput,
    now: Date = new Date(),
  ): Promise<CreateSessionOutput> {
    const build: BuildRef = {
      domain: input.domain,
      version: input.version,
      usecase: input.usecase,
    };

    // Fail loudly on a bad build before anything else is derived from it.
    await this.#catalog.assertBuild(build);

    const mockRole = oppositeRole(input.np_type);
    const sessionId = randomUUID();
    const interactionMode = input.interaction_mode ?? "llm_auto";
    if (input.receiver_public_url !== undefined) {
      this.#assertOverrideKeepsPrefix(input.receiver_public_url);
    }
    const base = (input.receiver_public_url ?? this.#receiverPublicUrl).replace(
      /\/+$/,
      "",
    );

    const session: Session = {
      session_id: sessionId,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + this.#ttl).toISOString(),
      np: {
        subscriber_url: input.subscriber_url,
        ...(input.subscriber_id !== undefined
          ? { subscriber_id: input.subscriber_id }
          : {}),
        type: input.np_type,
      },
      mock_role: mockRole,
      build,
      interaction_mode: interactionMode,
      // Follows the interaction mode unless the caller says otherwise. An
      // `llm_auto` session is one where the caller has said it will supply
      // everything itself, so making it ask permission to send a step that
      // needs nothing is ceremony: it can only answer yes. `manual` means a
      // human is in the loop, and stepping through is the whole point.
      //
      // This is safe only because the session journal exists. Auto-advance
      // sends payloads to a third party with nobody watching, and until every
      // tool result carried a `CHAIN_SENT` line saying so, defaulting it on
      // would have meant silent traffic on a real participant's wire.
      auto_advance: input.auto_advance ?? interactionMode === "llm_auto",
      callback_url: advertisedUri(base, build, mockRole),
    };

    await this.#repository.save(session, this.#ttl);
    const flows = await this.#catalog.listFlows(build, mockRole);

    this.#logger.info(
      {
        sessionId: session.session_id,
        npType: input.np_type,
        mockRole,
        ...build,
        flowCount: flows.length,
      },
      "session created",
    );

    return { session, flows, total: flows.length };
  }

  /**
   * Resolve a session.
   *
   * @throws {NotFoundError} when the id is unknown or the session has expired —
   * a tool-channel failure, so the model can create a new session and continue.
   */
  async requireSession(sessionId: string): Promise<Session> {
    const session = await this.#repository.find(sessionId);
    if (!session) {
      throw new NotFoundError("session", sessionId, {
        hint: "Sessions expire. Call session_create to start a new one.",
      });
    }
    return session;
  }

  /**
   * The live sessions a call arriving on this endpoint could have belonged to.
   *
   * Every session on a build shares one endpoint — a participant integrates
   * against an endpoint, not against one of our test runs — so when the
   * receiver refuses a call it cannot attribute, this is the honest answer to
   * "whose might this have been?". Ids that no longer resolve are dropped here
   * rather than by the caller: an expired session is not a candidate.
   *
   * Newest first, because a stray call is far likelier to belong to a run that
   * is still going than to one created two days ago.
   */
  async sessionsOnEndpoint(
    scope: ExpectationScope,
    limit = 20,
  ): Promise<string[]> {
    const candidates = await this.#repository.listByEndpoint(scope);

    const live: string[] = [];
    for (const sessionId of [...candidates].reverse()) {
      if (live.length >= limit) break;
      if (await this.#repository.find(sessionId)) live.push(sessionId);
    }
    return live;
  }

  /**
   * A tunnel may change the host we advertise; it cannot change the path.
   *
   * Routes are registered once at boot under one prefix, so a session that
   * advertised a different one would hand the participant a URL this server
   * does not serve — and the failure would arrive as a 404 on the callback,
   * long after the mistake.
   */
  #assertOverrideKeepsPrefix(override: string): void {
    const path = new URL(override).pathname.replace(/\/+$/, "");
    if (path === "" || path === this.#routePrefix) return;
    throw new ValidationError(
      `receiver_public_url may override the host but not the path: this server ` +
        `serves its receiver at "${this.#routePrefix || "/"}", not "${path}".`,
      {
        received: path,
        mounted_at: this.#routePrefix || "/",
        hint: "Drop the path, or set RECEIVER_ROUTE_PREFIX if it is intentional.",
      },
    );
  }
}

/**
 * The URI this mock advertises as `bap_uri` / `bpp_uri`.
 *
 * `{base}/{domain}/{version}/{buyer|seller}` — the network's own shape, and
 * deliberately **not** per-session: a participant is integrating against an
 * endpoint, not against one of our test runs. The action is appended by the
 * caller, because a beckn callback is `{callback_uri}/{action}`.
 *
 * The domain is emitted raw, `ONDC:RET10` and not `ONDC%3ARET10`: this string
 * is what the counterparty stores and echoes back to us, and matching it
 * byte-for-byte is the point. A colon is a legal path character.
 */
export function advertisedUri(
  base: string,
  build: BuildRef,
  mockRole: NpType,
): string {
  const domain = build.domain.trim();
  const version = build.version.trim();
  for (const [field, value] of [
    ["domain", domain],
    ["version", version],
  ] as const) {
    if (value === "" || /[/\s]/.test(value)) {
      throw new ValidationError(
        `build.${field} cannot be empty or contain "/" or whitespace: it becomes a path segment of the URI this mock advertises.`,
        { [field]: value },
      );
    }
  }
  return `${base.replace(/\/+$/, "")}/${domain}/${version}/${receiverRole(
    mockRole,
  )}`;
}

/** The endpoint bucket this session's inbound calls arrive on. */
export function receiverScope(session: Session): ExpectationScope {
  return {
    domain: session.build.domain,
    version: session.build.version,
    role: receiverRole(session.mock_role),
  };
}
