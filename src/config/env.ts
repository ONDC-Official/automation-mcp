import { z } from "zod";

/**
 * The single place in the codebase that reads `process.env`.
 *
 * Parsed once at import time. On invalid or missing configuration the process
 * exits non-zero rather than booting into an undefined state — a server that
 * starts with broken config is worse than one that refuses to start.
 */

const csv = z
  .string()
  .transform((value) =>
    value
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .pipe(z.array(z.string()));

/**
 * An optional URL where blank means "not configured".
 *
 * `FOO=` in a `.env` file, or a compose file interpolating a variable nobody
 * set, is how an unset value usually reaches us — and exiting 1 on an empty
 * line is a hostile way to say "you left it blank". Anything non-empty still
 * has to parse as a URL.
 */
const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.url().optional(),
);

const EnvSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    HOST: z.string().min(1).default("127.0.0.1"),

    MCP_PUBLIC_URL: z.url().default("http://127.0.0.1:3000/mcp"),
    MCP_ALLOWED_HOSTS: csv.optional(),
    MCP_ALLOWED_ORIGINS: csv.optional(),

    AUTH_MODE: z.enum(["none", "jwt", "apikey"]).default("none"),
    AUTH_ISSUER: optionalUrl,
    AUTH_AUDIENCE: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().min(1).optional(),
    ),
    AUTH_JWKS_URL: optionalUrl,
    AUTH_REQUIRED_SCOPES: csv.default([]),
    /**
     * Comma-separated list of valid API keys for `AUTH_MODE=apikey`.
     *
     * Clients send any of these as a bearer token. Keys are compared in
     * constant time to prevent timing attacks.
     */
    AUTH_API_KEYS: csv.default([]),

    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
    RATE_LIMIT_WINDOW: z.string().min(1).default("1 minute"),
    REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

    /* ---- ONDC config-service: the source of every flow and build ---- */

    /**
     * Base URL of the workbench config-service. Every domain/version/usecase,
     * flow definition and mock-runner config is read from here — there is no
     * bundled copy, so a wrong value fails session creation, not startup.
     */
    CONFIG_SERVICE_URL: z
      .url()
      .default("https://workbench.ondc.tech/config-service"),
    CONFIG_SERVICE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(15_000),
    /** TTL for fetched builds/flows/mock configs. Upstream caches ~1h. */
    CATALOG_CACHE_TTL_MS: z.coerce.number().int().positive().default(900_000),
    /** Session lifetime. 48h matches the workbench's own session TTL. */
    SESSION_TTL_MS: z.coerce.number().int().positive().default(172_800_000),

    /* ---- Protocol validation (L0 + L1) ---- */

    /**
     * The api-service instance used as an L0 + L1 oracle.
     *
     * `POST {base}/{domain}/{version}/test/{action}` is ONIX's
     * `standaloneValidator` module: the same JSON Schemas and the same compiled
     * `x-validations` the live network enforces, with no side effects — nothing
     * is proxied onward, nothing is stored, no session or transaction is
     * created. Domain and version are baked into each instance at build time,
     * so an instance that does not serve a build answers 404 and validation
     * reports `unavailable` rather than failing the payload.
     */
    VALIDATION_SERVICE_URL: z
      .url()
      .default("https://workbench.ondc.tech/api-service"),
    /**
     * Ceiling on one validation call.
     *
     * Deliberately far below `SEND_TIMEOUT_MS`, for the same reason
     * `REDIS_COMMAND_TIMEOUT_MS` is small: this runs inside the inbound ACK
     * window, and a dependency that has stopped answering must not hold the
     * participant's connection open. On timeout the verdict is `unavailable`
     * and the call is let through — see `VALIDATION_MODE`.
     */
    VALIDATION_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
    /**
     * How hard a verdict bites.
     *
     * - `enforce` — an invalid payload is NACKed inbound and blocked outbound.
     * - `advisory` — findings are recorded and journaled, nothing is blocked.
     *   The honest setting while confirming the oracle agrees with the network.
     * - `off` — no call is made at all.
     *
     * None of these change the *verdict*, only what the gates do with it, so a
     * transaction's recorded findings never depend on a deployment flag.
     */
    VALIDATION_MODE: z.enum(["off", "advisory", "enforce"]).default("enforce"),
    /** TTL for a cached verdict. Keyed on the payload's own bytes. */
    VALIDATION_CACHE_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(900_000),

    /* ---- Prometheus ---- */

    /**
     * Whether `GET /metrics` is registered at all.
     *
     * False does not answer 403; it registers no route, so the endpoint 404s
     * like any other path this app does not serve. "There is nothing here" and
     * "there is something here you may not have" are different disclosures, and
     * only one of them is true.
     */
    METRICS_ENABLED: z
      .stringbool({
        truthy: ["1", "true", "yes"],
        falsy: ["0", "false", "no", ""],
      })
      .default(true),
    /**
     * Bearer token a scraper must present.
     *
     * Not `app.authenticate`: that answers with an RFC 9728 discovery pointer,
     * and a Prometheus scraper cannot do discovery — it can send one static
     * header. Compared with `timingSafeEqual`.
     */
    METRICS_TOKEN: z.string().min(1).optional(),

    /* ---- The live viewer (a read-only JSON surface for a hosted page) ---- */

    /**
     * Whether the `/ui/api` routes are registered at all.
     *
     * Same reasoning as `METRICS_ENABLED`: off registers no route, so a probe
     * gets the app's ordinary 404 rather than a 403 confirming there is
     * something here worth asking for.
     */
    UI_ENABLED: z
      .stringbool({
        truthy: ["1", "true", "yes"],
        falsy: ["0", "false", "no", ""],
      })
      .default(true),
    /**
     * Token the viewer must present, minted per process when unset.
     *
     * Minted rather than absent, because this surface serves **payload bodies** —
     * the participant's real transaction data — and under stdio it rides the
     * standalone receiver, which binds `0.0.0.0` on purpose so a third party can
     * reach it. An unset token must therefore mean "a token you did not choose",
     * never "no token". Set it explicitly when the process restarts often enough
     * that a changing link is a nuisance, or when several replicas share one URL.
     */
    UI_TOKEN: z.string().min(1).optional(),
    /**
     * Where the viewer page is hosted — the origin of the link handed to the
     * human. The page is ours; the data never passes through it.
     */
    UI_BASE_URL: z.url().default("https://workbench.ondc.tech"),
    /**
     * How the **browser** reaches this engine. Defaults at container build to
     * `RECEIVER_PUBLIC_URL`, which is already the address this process is known
     * to be reachable on. Set it separately only when the viewer and the
     * participant should reach us by different routes.
     */
    UI_ENGINE_URL: optionalUrl,
    /**
     * Origins allowed to call `/ui/api`. Defaults at container build to the
     * origin of `UI_BASE_URL`, so the common case needs no configuration.
     */
    UI_ALLOWED_ORIGINS: csv.optional(),

    /* ---- Live mirror (telemetry to a sibling service) ---- */

    /**
     * Where mirror records are POSTed. **Unset means mirroring is off.**
     *
     * Deliberately the only switch: a second `MIRROR_ENABLED` flag would let an
     * operator turn it "on" with nowhere to send, which is a setting that reads
     * as configured and does nothing.
     */
    MIRROR_ENDPOINT_URL: optionalUrl,
    /** Bearer token for the mirror ingest, if it wants one. */
    MIRROR_API_KEY: z.string().min(1).optional(),
    /**
     * Ceiling on one batch POST. Small, and never on the ACK path — but it
     * shares the process-wide agent with protocol calls, so a hung mirror
     * request holds a connection slot they are also using.
     */
    MIRROR_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    /** How often a partial batch is flushed. The timer is `unref`'d. */
    MIRROR_FLUSH_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
    /** Records that trigger an immediate (still off-thread) flush. */
    MIRROR_BATCH_SIZE: z.coerce.number().int().positive().default(100),
    /**
     * Queue ceiling. Full means the **oldest** record is dropped, and the count
     * of drops rides the next batch — a gap in the corpus that says so beats a
     * gap that does not.
     */
    MIRROR_QUEUE_MAX: z.coerce.number().int().positive().default(1_000),

    /* ---- Issue reporting (the incident corpus) ---- */

    /**
     * Turn capture and reporting off entirely.
     *
     * On by default, because the whole point is that a stuck run reports itself
     * without anybody remembering to ask. What "on" means with nothing else
     * configured is deliberately modest: incidents are captured and written to a
     * local spool directory, and **nothing leaves the machine** until
     * `FEEDBACK_ENDPOINT_URL` is set. Boot logs which way this went, and where.
     */
    FEEDBACK_DISABLED: z
      .stringbool({
        truthy: ["1", "true", "yes"],
        falsy: ["0", "false", "no", ""],
      })
      .default(false),
    /**
     * Where reports are POSTed, in addition to the spool.
     *
     * Unset — the default — means spool-only. `optionalUrl`, so a blank line in
     * a `.env` reads as "not configured" rather than exiting 1.
     */
    FEEDBACK_ENDPOINT_URL: optionalUrl,
    /** Bearer token for the ingest, if it wants one. */
    FEEDBACK_API_KEY: z.string().min(1).optional(),
    /**
     * Where reports are written before, and regardless of, any upload.
     *
     * The spool is the trust surface: it is how an operator answers "what did
     * this send about my participant?" by reading a file rather than by taking
     * our word for it. It is also what makes an upload failure survivable.
     */
    FEEDBACK_SPOOL_DIR: z.string().min(1).optional(),
    /**
     * Ceiling on one upload. Small, and never on the ACK path — a report is
     * worth nothing next to a protocol call, so it must not be able to hold one
     * up even indirectly through the shared agent's connection pool.
     */
    FEEDBACK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    /** Spool entries kept before the oldest are pruned. An offline laptop must
     * not grow an unbounded directory. */
    FEEDBACK_SPOOL_MAX_FILES: z.coerce.number().int().positive().default(500),
    /**
     * HMAC salt for identifier pseudonyms.
     *
     * Unset, one is generated and persisted beside the spool on first use. Set
     * it explicitly to make pseudonyms stable across machines — which is only
     * ever what you want when several deployments are meant to look like one
     * installation in the corpus.
     */
    FEEDBACK_SALT: z.string().min(1).optional(),

    /**
     * Carry `session_id` and `transaction_id` in the clear on telemetry.
     *
     * Off by default. On, an issue report and a mirror record gain **exactly
     * one key** — `correlation`, holding those two ids — so a dashboard can
     * deep-link a report back to the run that produced it. Nothing else
     * changes: `{...report}` minus `correlation` is byte-identical to the
     * flag-off report, which `feedback.firstparty.test.ts` asserts rather than
     * merely claims.
     *
     * It does **not** relax redaction. Payload leaves are still type tokens,
     * the participant is still pseudonymised, and ids quoted inside prose are
     * still scrubbed — the flag is not passed to `feedback.redact.ts` at all,
     * which is what makes that guarantee structural rather than a promise.
     *
     * The result is a report carrying both a pseudonym and a clear id for one
     * transaction, and that is fine: the pseudonym's job was never to protect a
     * UUID we minted ourselves, it was to keep the *participant* unlinkable and
     * the corpus internally consistent. Both still hold. Only turn this on for
     * telemetry about your own installation.
     */
    TELEMETRY_CORRELATION: z
      .stringbool({
        truthy: ["1", "true", "yes"],
        falsy: ["0", "false", "no", ""],
      })
      .default(false),

    /* ---- Shared state store ---- */

    /**
     * Where sessions, transactions, payloads and business data live.
     *
     * **Unset is the default, and that is the point**: the in-process store
     * ships with the server so it runs with zero infrastructure. Set this and
     * the same state survives a restart — including the `tsx watch` reload that
     * fires on every file save mid-flow. `docker-compose.dev.yml` brings up
     * something for it to talk to.
     *
     * The flow catalog is deliberately *not* stored here; `createContainer`
     * explains why.
     */
    REDIS_URL: optionalUrl,
    /**
     * Prepended to every key with `::`, so several projects can share one local
     * Redis without collision. Set it empty to write the workbench's literal
     * key layout (`session::{id}`, `{txn}::{sub}`) into a Redis it also uses.
     */
    REDIS_KEY_PREFIX: z.string().default("ondc-mcp"),
    /**
     * Hard ceiling on a single Redis command, applied before it is even queued.
     * Deliberately below `/ready`'s own 2s probe timeout, so a degraded report
     * carries Redis's error rather than "timed out". It also bounds the ACK
     * window: the receiver reads state before answering, and a dead store must
     * not hold the participant's connection open.
     */
    REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(1_500),

    /* ---- The mock NP's own wire presence ---- */

    /**
     * Port the standalone inbound receiver binds when running on **stdio**.
     * Under the HTTP transport the receiver is mounted on the main app instead
     * and this is ignored.
     */
    RECEIVER_PORT: z.coerce.number().int().min(0).max(65535).default(3001),
    /**
     * The URL a counterparty can reach our receiver on — what we advertise as
     * `bap_uri` / `bpp_uri`. Override it with a tunnel address (ngrok, cloudflared)
     * when testing against a participant that is not on this machine, otherwise
     * the NP's callbacks go nowhere. Defaults per transport at container build.
     */
    RECEIVER_PUBLIC_URL: z.url().optional(),
    /**
     * Path the receiver and form routes are mounted under.
     *
     * Defaults to the pathname of `RECEIVER_PUBLIC_URL`, so a deployment behind
     * `https://host/api-service` works without further configuration. Set it to
     * the empty string when a proxy strips the prefix before the request
     * reaches this process.
     */
    RECEIVER_ROUTE_PREFIX: z.string().optional(),
    /** Registry-style id we present as `bap_id` / `bpp_id`. */
    MOCK_SUBSCRIBER_ID: z.string().min(1).default("mock.ondc-mcp.local"),

    /* ---- Flow loop timings ---- */

    /** Budget for one outbound protocol call to the participant. */
    SEND_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    /**
     * Ceiling on a single `flow_await` block. 5 minutes: a human-driven
     * participant under test takes minutes to answer, and every timeout costs
     * the model a round trip that tells it nothing.
     *
     * It is **not** bounded by `REQUEST_TIMEOUT_MS`, despite what the pairing
     * of the two names suggests. Node's `requestTimeout` bounds *receiving* a
     * request, not running its handler — it is cleared once the body has
     * arrived, so a parked handler is never killed by it (verified on the
     * Fastify options this app is built with).
     *
     * The real ceiling is the **client's** tool-call timeout, which is why
     * `flow_await` emits progress notifications while it is parked: clients
     * that asked for progress reset their timer on each one. A client that
     * does not should pass a smaller `timeout_ms` and long-poll instead.
     */
    AWAIT_MAX_WAIT_MS: z.coerce.number().int().positive().default(300_000),
    /** Lifetime of a per-step WORKING/AVAILABLE marker. 5h, as the workbench. */
    FLOW_STATUS_TTL_MS: z.coerce.number().int().positive().default(18_000_000),
    /** How long an idle mock-runner instance (and its workers) is kept. */
    RUNNER_CACHE_TTL_MS: z.coerce.number().int().positive().default(300_000),
    /**
     * Base URLs a sandboxed `generate` function may `fetch`. Empty — the
     * default — means fetch is never injected into the sandbox at all.
     */
    RUNNER_FETCH_ALLOWLIST: csv.default([]),
    /** Budget for fetching a counterparty-hosted form. */
    FORM_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    /** Lifetime of a transaction record and its payloads. 48h, as the workbench. */
    TRANSACTION_TTL_MS: z.coerce.number().int().positive().default(172_800_000),
    /**
     * How long an armed expectation stands. 5 minutes matches the workbench;
     * longer risks a stale one catching an unrelated call.
     */
    EXPECTATION_TTL_MS: z.coerce.number().int().positive().default(300_000),
  })
  // `jwt` mode is useless without somewhere to fetch keys and something to
  // check them against. Catch it at boot, not on the first 401.
  .refine(
    (env) =>
      env.AUTH_MODE !== "jwt" ||
      (env.AUTH_ISSUER !== undefined &&
        env.AUTH_AUDIENCE !== undefined &&
        env.AUTH_JWKS_URL !== undefined),
    {
      message:
        "AUTH_MODE=jwt requires AUTH_ISSUER, AUTH_AUDIENCE and AUTH_JWKS_URL",
      path: ["AUTH_MODE"],
    },
  )
  .refine((env) => env.AUTH_MODE !== "apikey" || env.AUTH_API_KEYS.length > 0, {
    message: "AUTH_MODE=apikey requires at least one key in AUTH_API_KEYS",
    path: ["AUTH_API_KEYS"],
  })
  // Refuse to run an unauthenticated MCP server in production. This is the
  // failure mode that quietly exposes every tool to the open internet.
  .refine(
    (env) => !(env.NODE_ENV === "production" && env.AUTH_MODE === "none"),
    {
      message:
        "AUTH_MODE=none is refused when NODE_ENV=production — configure AUTH_MODE=jwt or AUTH_MODE=apikey",
      path: ["AUTH_MODE"],
    },
  )
  // The same refusal as `AUTH_MODE=none`, for the same reason. This process is
  // built to be internet-reachable — `RECEIVER_PUBLIC_URL` exists precisely so a
  // third-party participant can call it — and an unauthenticated `/metrics`
  // publishes a map of what is being tested: every flow, every build, every
  // participant's failure rate. Catch it at boot, not on the first scrape by
  // somebody who was not meant to see it.
  .refine(
    (env) =>
      !(
        env.NODE_ENV === "production" &&
        env.METRICS_ENABLED &&
        env.METRICS_TOKEN === undefined
      ),
    {
      message:
        "METRICS_TOKEN is required when NODE_ENV=production and METRICS_ENABLED " +
        "is on — set a token, or set METRICS_ENABLED=0 to serve no endpoint at all",
      path: ["METRICS_TOKEN"],
    },
  )
  // The `METRICS_TOKEN` refusal again, and for a stronger reason. A minted
  // token is safe on a laptop, where the link and the process live and die
  // together. In production the process outlives any one link, replicas each
  // mint their own so a link works only against whichever answered, and what is
  // behind the token is not a counter but the participant's payloads. Say so at
  // boot rather than shipping a viewer nobody can open reliably.
  .refine(
    (env) =>
      !(
        env.NODE_ENV === "production" &&
        env.UI_ENABLED &&
        env.UI_TOKEN === undefined
      ),
    {
      message:
        "UI_TOKEN is required when NODE_ENV=production and UI_ENABLED is on — " +
        "set a token, or set UI_ENABLED=0 to serve no viewer at all",
      path: ["UI_TOKEN"],
    },
  );

export type Config = z.infer<typeof EnvSchema>;

export function parseConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(source);

  if (!result.success) {
    // Deliberately process.stderr, not console.* and not the pino logger:
    // config parsing happens before a logger exists, and on stdio transports
    // stdout is the protocol channel.
    const issues = result.error.issues
      .map(
        (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
      )
      .join("\n");
    process.stderr.write(`Invalid environment configuration:\n${issues}\n`);
    process.exit(1);
  }

  return result.data;
}

export const config: Config = parseConfig();
