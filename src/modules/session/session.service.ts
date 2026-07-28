import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { NotFoundError } from "@/lib/errors.js";
import type { BuildRef } from "@/modules/catalog/catalog.schema.js";
import {
  oppositeRole,
  type CatalogService,
} from "@/modules/catalog/catalog.service.js";
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
}

export class SessionService {
  readonly #repository: SessionRepository;
  readonly #catalog: CatalogService;
  readonly #logger: Logger;
  readonly #ttl: number;

  constructor(options: SessionServiceOptions) {
    this.#repository = options.repository;
    this.#catalog = options.catalog;
    this.#logger = options.logger;
    this.#ttl = options.sessionTtlMs;
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
    const session: Session = {
      session_id: randomUUID(),
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
}
