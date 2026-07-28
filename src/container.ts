import { Agent } from "undici";
import type { Logger } from "pino";
import type { Config } from "@/config/env.js";
import type { CacheStore } from "@/lib/cache/cache-store.js";
import { InMemoryCacheStore } from "@/lib/cache/in-memory-cache-store.js";
import { TransactionEvents } from "@/lib/events/transaction-events.js";
import { logger as rootLogger } from "@/lib/logger.js";
import { MockEngine } from "@/lib/mock-engine/mock-engine.js";
import type { ConfigServiceGateway } from "@/modules/catalog/catalog.gateway.js";
import { HttpConfigServiceGateway } from "@/modules/catalog/catalog.gateway.js";
import { CatalogService } from "@/modules/catalog/catalog.service.js";
import { CacheSessionRepository } from "@/modules/session/session.repository.js";
import { SessionService } from "@/modules/session/session.service.js";

/**
 * Boot-once singletons.
 *
 * ## Why this exists
 *
 * Under the HTTP transport the MCP server factory is invoked **once per
 * request** (that is what makes the 2026-07-28 transport stateless and
 * horizontally scalable). Anything expensive built inside the factory would
 * therefore be rebuilt on every single call — a new connection pool, a new
 * HTTP agent, a cold cache, per request.
 *
 * So: expensive, long-lived things are constructed **here**, once, at boot.
 * The factory closes over the result and stays cheap. `src/mcp/server.test.ts`
 * asserts this property so it cannot silently regress.
 *
 * It is also where cross-request *state* lives. A mock network participant is
 * inherently stateful — sessions and transactions outlive requests — and a
 * module-scope `Map` would make the factory's statelessness a lie. State goes
 * in the `CacheStore` built here and reached through a repository.
 *
 * Two things here hold **live resources rather than data** and so legitimately
 * sit outside `CacheStore`: the mock engine's worker pool, and the waiters
 * parked on `TransactionEvents`. Both are released in `dispose`.
 */

/** A named liveness/readiness probe for one dependency. */
export interface HealthCheck {
  readonly name: string;
  /** Resolve for healthy; throw or resolve `false` for unhealthy. */
  check(): Promise<boolean | void>;
}

export interface Container {
  readonly config: Config;
  readonly logger: Logger;
  readonly services: {
    readonly catalog: CatalogService;
    readonly session: SessionService;
  };
  /** Sandbox for the config-service's per-step JavaScript. */
  readonly mockEngine: MockEngine;
  /** Wake-ups for `flow_await`. */
  readonly events: TransactionEvents;
  /** Probes run by `/ready`. Register one per external dependency. */
  readonly healthChecks: readonly HealthCheck[];
  /** Release every resource acquired at boot. Must be idempotent. */
  dispose(): Promise<void>;
}

export interface CreateContainerOptions {
  /**
   * Override the config-service client. **Tests must always pass one** — the
   * default reaches the real service over the network.
   */
  configServiceGateway?: ConfigServiceGateway;
  /** Override the state store, e.g. to control TTL expiry in tests. */
  cacheStore?: CacheStore;
  logger?: Logger;
}

export async function createContainer(
  config: Config,
  options: CreateContainerOptions = {},
): Promise<Container> {
  const logger = options.logger ?? rootLogger;

  // ---- Expensive singletons go here -------------------------------------
  // One HTTP agent for the process. Built per request it would open a fresh
  // connection pool on every call — the symptom is a capacity cliff under
  // load, not a failing test.
  const httpAgent = new Agent({
    connect: { timeout: 10_000 },
    headersTimeout: config.CONFIG_SERVICE_TIMEOUT_MS,
    bodyTimeout: config.CONFIG_SERVICE_TIMEOUT_MS,
  });

  const cacheStore = options.cacheStore ?? new InMemoryCacheStore();

  const configServiceGateway =
    options.configServiceGateway ??
    new HttpConfigServiceGateway({
      baseUrl: config.CONFIG_SERVICE_URL,
      timeoutMs: config.CONFIG_SERVICE_TIMEOUT_MS,
      dispatcher: httpAgent,
      logger,
    });

  const sessionRepository = new CacheSessionRepository(cacheStore);

  const catalog = new CatalogService({
    gateway: configServiceGateway,
    cache: cacheStore,
    cacheTtlMs: config.CATALOG_CACHE_TTL_MS,
    logger,
  });

  // Worker threads for the config-service's per-step JavaScript. Nothing is
  // spawned until a flow actually runs.
  const mockEngine = new MockEngine({
    logger,
    allowedFetchBaseUrls: config.RUNNER_FETCH_ALLOWLIST,
    idleTtlMs: config.RUNNER_CACHE_TTL_MS,
  });

  const events = new TransactionEvents();

  const services = {
    catalog,
    session: new SessionService({
      repository: sessionRepository,
      catalog,
      sessionTtlMs: config.SESSION_TTL_MS,
      logger,
    }),
  } as const;

  const healthChecks: HealthCheck[] = [
    {
      // Every flow this server can drive comes from the config-service. If it
      // is unreachable, sessions cannot be created — so this instance is not
      // ready, and a load balancer should route elsewhere.
      name: "config-service",
      check: () => configServiceGateway.ping(),
    },
    {
      name: "cache-store",
      check: () => cacheStore.ping(),
    },
  ];

  let disposed = false;

  return {
    config,
    logger,
    services,
    mockEngine,
    events,
    healthChecks,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      // Release in reverse order of acquisition. The mock engine first and
      // unconditionally: its workers are live threads, and a process that
      // leaves them running never exits.
      mockEngine.dispose();
      events.close();
      await cacheStore.close();
      await httpAgent.close();
      logger.debug("container disposed");
    },
  };
}
