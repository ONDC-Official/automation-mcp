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

    AUTH_MODE: z.enum(["none", "jwt"]).default("none"),
    AUTH_ISSUER: z.url().optional(),
    AUTH_AUDIENCE: z.string().min(1).optional(),
    AUTH_JWKS_URL: z.url().optional(),
    AUTH_REQUIRED_SCOPES: csv.default([]),

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
  // Refuse to run an unauthenticated MCP server in production. This is the
  // failure mode that quietly exposes every tool to the open internet.
  .refine(
    (env) => !(env.NODE_ENV === "production" && env.AUTH_MODE === "none"),
    {
      message:
        "AUTH_MODE=none is refused when NODE_ENV=production — configure AUTH_MODE=jwt",
      path: ["AUTH_MODE"],
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
