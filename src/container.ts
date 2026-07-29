import { Agent } from "undici";
import type { Logger } from "pino";
import type { Config } from "@/config/env.js";
import type { CacheStore } from "@/lib/cache/cache-store.js";
import { InMemoryCacheStore } from "@/lib/cache/in-memory-cache-store.js";
import { RedisCacheStore } from "@/lib/cache/redis-cache-store.js";
import { TransactionEvents } from "@/lib/events/transaction-events.js";
import { logger as rootLogger } from "@/lib/logger.js";
import { MockEngine } from "@/lib/mock-engine/mock-engine.js";
import type { ConfigServiceGateway } from "@/modules/catalog/catalog.gateway.js";
import { HttpConfigServiceGateway } from "@/modules/catalog/catalog.gateway.js";
import { CatalogService } from "@/modules/catalog/catalog.service.js";
import { FlowRepository } from "@/modules/flow/flow.repository.js";
import { FlowService } from "@/modules/flow/flow.service.js";
import { FormsService } from "@/modules/forms/forms.service.js";
import { RecordRepository } from "@/modules/record/record.repository.js";
import { RecordService } from "@/modules/record/record.service.js";
import { CacheSessionRepository } from "@/modules/session/session.repository.js";
import { SessionService } from "@/modules/session/session.service.js";
import { ReceiverLifecycle } from "@/modules/transport/receiver.lifecycle.js";
import { ReceiverService } from "@/modules/transport/receiver.service.js";
import {
  SenderService,
  type RequestSigner,
} from "@/modules/transport/sender.service.js";

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
 * There are **two** `CacheStore` instances, and the split is deliberate rather
 * than accidental: `stateStore` holds what must survive a restart (and is Redis
 * when `REDIS_URL` is set), while `catalogCache` holds large derived data that
 * is always cheaper to re-fetch than to ship over a socket. The comments at
 * each construction site say why; that is the decision a future reader is most
 * likely to try to "simplify" back into one.
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
    readonly record: RecordService;
    readonly flow: FlowService;
    readonly forms: FormsService;
  };
  /** Where a participant reaches this server's inbound receiver. */
  readonly receiverPublicUrl: string;
  /**
   * Path the receiver and form routes mount under — `""` unless the public URL
   * carries one. Both hosts register with it, so what we advertise resolves.
   */
  readonly receiverRoutePrefix: string;
  /** The pipeline the participant's callbacks run through. */
  readonly inbound: ReceiverService;
  /** Where that pipeline listens, and how to bring it up. */
  readonly receiver: ReceiverLifecycle;
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
  /**
   * Override the **state** store — sessions, transactions, payloads — e.g. to
   * control TTL expiry in tests. Takes precedence over `REDIS_URL`.
   */
  cacheStore?: CacheStore;
  /**
   * Override the catalog's derived-data cache. Rarely needed: it is always
   * in-process, so tests get a fresh one for free.
   */
  catalogCacheStore?: CacheStore;
  logger?: Logger;
  /**
   * Which entrypoint is booting.
   *
   * It decides where the inbound receiver lives, and therefore what URL we
   * advertise for callbacks: mounted on the main HTTP app, or a listener of its
   * own that `receiver_start` brings up. Advertising the wrong one means the
   * participant's callbacks never arrive.
   */
  transport?: "http" | "stdio";
  /** Override the outbound HTTP dispatcher, e.g. undici's `MockAgent`. */
  senderDispatcher?: ConstructorParameters<
    typeof SenderService
  >[0]["dispatcher"];
  /** Signs outbound payloads. Defaults to the no-op signer. */
  signer?: RequestSigner;
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

  // ---- State: what has to survive a restart ------------------------------
  // Sessions, transactions, payloads, business data, expectations. Redis when
  // REDIS_URL is set; otherwise the in-process map that has always been the
  // default, so the server still runs with zero infrastructure.
  const stateStore =
    options.cacheStore ??
    (config.REDIS_URL !== undefined
      ? new RedisCacheStore({
          url: config.REDIS_URL,
          keyPrefix: config.REDIS_KEY_PREFIX,
          commandTimeoutMs: config.REDIS_COMMAND_TIMEOUT_MS,
          logger,
        })
      : new InMemoryCacheStore());

  // ---- Derived: the flow catalog -----------------------------------------
  // Always in-process, deliberately. `FlowService.load()` reads a flow's
  // ~330KB mock-runner config on every `flow_proceed` *and* every inbound
  // callback; through Redis that would be a 330KB transfer plus a JSON.parse
  // per loop iteration, one of them inside the ACK window while the
  // participant's socket is open. And it would buy nothing: catalog entries
  // are derived from the config-service, TTL'd at ~15 minutes, and re-fetched
  // transparently on a miss — while the `MockRunner` built from each config
  // already lives in this process (see mock-engine.ts). Putting the source
  // config in Redis while its derived runner stays local is the worst of both.
  //
  // The cost, stated plainly: `catalog_load_flow_config` hands back a
  // `cache_key` that a *different* replica will not have. Self-healing,
  // because `requireMockConfig` re-fetches on a miss.
  const catalogCache = options.catalogCacheStore ?? new InMemoryCacheStore();

  if (config.NODE_ENV === "production" && config.REDIS_URL === undefined) {
    logger.warn(
      "no REDIS_URL: session and transaction state is in-process. It will not " +
        "survive a restart, and replicas will not agree with each other.",
    );
  }

  const configServiceGateway =
    options.configServiceGateway ??
    new HttpConfigServiceGateway({
      baseUrl: config.CONFIG_SERVICE_URL,
      timeoutMs: config.CONFIG_SERVICE_TIMEOUT_MS,
      dispatcher: httpAgent,
      logger,
    });

  const sessionRepository = new CacheSessionRepository(stateStore);

  const catalog = new CatalogService({
    gateway: configServiceGateway,
    cache: catalogCache,
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

  const recordRepository = new RecordRepository({
    cache: stateStore,
    transactionTtlMs: config.TRANSACTION_TTL_MS,
    flowStatusTtlMs: config.FLOW_STATUS_TTL_MS,
    expectationTtlMs: config.EXPECTATION_TTL_MS,
  });

  const flowRepository = new FlowRepository({
    cache: stateStore,
    transactionTtlMs: config.TRANSACTION_TTL_MS,
  });

  // What we tell participants to call back on. Under HTTP the receiver is
  // mounted on the main app's port; on stdio it gets a listener of its own.
  const receiverPublicUrl =
    config.RECEIVER_PUBLIC_URL ??
    `http://${config.HOST}:${String(
      options.transport === "stdio" ? config.RECEIVER_PORT : config.PORT,
    )}`;

  // A public URL may carry a path (`https://host/api-service`) when something
  // fronts this process. The routes have to be mounted under the same path or
  // every URL we advertise — receiver and hosted forms alike — 404s.
  const receiverRoutePrefix = (
    config.RECEIVER_ROUTE_PREFIX ?? new URL(receiverPublicUrl).pathname
  ).replace(/\/+$/, "");

  const session = new SessionService({
    repository: sessionRepository,
    catalog,
    sessionTtlMs: config.SESSION_TTL_MS,
    receiverPublicUrl,
    receiverRoutePrefix,
    logger,
  });

  const record = new RecordService({
    repository: recordRepository,
    events,
    mockEngine,
    expectationTtlMs: config.EXPECTATION_TTL_MS,
    logger,
  });

  const sender = new SenderService({
    logger,
    timeoutMs: config.SEND_TIMEOUT_MS,
    ...(options.senderDispatcher
      ? { dispatcher: options.senderDispatcher }
      : {}),
    ...(options.signer ? { signer: options.signer } : {}),
  });

  const flow = new FlowService({
    sessions: session,
    catalog,
    records: record,
    repository: flowRepository,
    sender,
    mockEngine,
    events,
    logger,
    receiverPublicUrl,
    mockSubscriberId: config.MOCK_SUBSCRIBER_ID,
  });

  const forms = new FormsService({
    flows: flow,
    records: record,
    logger,
    fetchTimeoutMs: config.FORM_FETCH_TIMEOUT_MS,
    publicBaseUrl: receiverPublicUrl,
    ...(options.senderDispatcher
      ? { dispatcher: options.senderDispatcher }
      : {}),
  });

  const services = { catalog, session, record, flow, forms } as const;

  const inbound = new ReceiverService({
    sessions: session,
    records: record,
    flows: flow,
    forms,
    mockEngine,
    logger,
  });

  const receiver = new ReceiverLifecycle({
    // Under HTTP the receiver rides on the app that is already listening; on
    // stdio nothing is listening at all until `receiver_start` binds a port.
    mode: options.transport === "stdio" ? "standalone" : "mounted",
    baseUrl: receiverPublicUrl,
    port: options.transport === "stdio" ? config.RECEIVER_PORT : config.PORT,
    requestTimeoutMs: config.REQUEST_TIMEOUT_MS,
    logger,
  });

  const healthChecks: HealthCheck[] = [
    {
      // Every flow this server can drive comes from the config-service. If it
      // is unreachable, sessions cannot be created — so this instance is not
      // ready, and a load balancer should route elsewhere.
      name: "config-service",
      check: () => configServiceGateway.ping(),
    },
    {
      // The state store. Kept second because `app.test.ts` asserts on
      // `checks[0]` being the config-service. Only this one can be remote —
      // the catalog cache is always in-process, so probing it would assert
      // nothing.
      name: "cache-store",
      check: () => stateStore.ping(),
    },
  ];

  let disposed = false;

  return {
    config,
    logger,
    services,
    mockEngine,
    events,
    inbound,
    receiver,
    receiverPublicUrl,
    receiverRoutePrefix,
    healthChecks,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      // Release in reverse order of acquisition. The mock engine and the
      // standalone listener are the two that hold the event loop open — a
      // process that leaves either running never exits.
      await receiver.dispose();
      mockEngine.dispose();
      events.close();
      await stateStore.close();
      await catalogCache.close();
      await httpAgent.close();
      logger.debug("container disposed");
    },
  };
}
