import cors from "@fastify/cors";
import Fastify, { type FastifyRequest } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { Logger } from "pino";
import type { Container } from "@/container.js";
import { UpstreamError } from "@/lib/errors.js";
import { formsRoutes } from "@/modules/forms/forms.routes.js";
import { receiverRoutes } from "@/modules/transport/receiver.routes.js";
import {
  addPrivateNetworkPreflight,
  UI_ROUTE_PREFIX,
  uiCorsOrigins,
  uiRoutes,
} from "@/modules/ui/ui.routes.js";

/**
 * Where the inbound receiver actually listens, which depends on the transport.
 *
 * - **HTTP** — the receiver is mounted on the same app as `/mcp`, at boot.
 *   There is nothing to start; `receiver_start` only reports the URLs.
 * - **stdio** — there is no HTTP server at all until one is asked for, so
 *   `receiver_start` binds a small Fastify instance of its own on
 *   `RECEIVER_PORT`. A stdio client that never runs a flow never opens a port.
 *
 * The distinction is invisible to the model: `receiver_start` answers the same
 * shape either way, and the callback URL it hands back is the one to give the
 * participant.
 */

export type ReceiverMode = "mounted" | "standalone";

export interface ReceiverStatus {
  running: boolean;
  mode: ReceiverMode;
  baseUrl: string;
  /** Bound port, once something is actually listening. */
  port?: number;
}

export interface ReceiverLifecycleOptions {
  mode: ReceiverMode;
  baseUrl: string;
  port: number;
  logger: Logger;
  requestTimeoutMs: number;
}

export class ReceiverLifecycle {
  readonly #mode: ReceiverMode;
  readonly #baseUrl: string;
  readonly #port: number;
  readonly #logger: Logger;
  readonly #requestTimeoutMs: number;
  #server: Awaited<ReturnType<typeof buildStandalone>> | undefined;
  #mounted = false;
  /**
   * The port actually bound, which is not always the one asked for.
   *
   * `RECEIVER_PORT=0` means "any free port", and reporting the configured `0`
   * back to a caller that has to build a URL out of it is a lie that only
   * shows up when the callback never arrives.
   */
  #boundPort: number | undefined;

  constructor(options: ReceiverLifecycleOptions) {
    this.#mode = options.mode;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#port = options.port;
    this.#logger = options.logger;
    this.#requestTimeoutMs = options.requestTimeoutMs;
  }

  /** Called by `buildHttpApp` once the routes are registered on the main app. */
  markMounted(): void {
    this.#mounted = true;
  }

  status(): ReceiverStatus {
    const running =
      this.#mode === "mounted" ? this.#mounted : Boolean(this.#server);
    return {
      running,
      mode: this.#mode,
      baseUrl: this.#baseUrl,
      ...(this.#mode === "standalone" && this.#server
        ? { port: this.#boundPort ?? this.#port }
        : this.#mode === "mounted" && this.#mounted
          ? { port: this.#port }
          : {}),
    };
  }

  /**
   * Ensure something is listening. Idempotent — the model is expected to call
   * this at the top of every session without tracking whether it already has.
   */
  async start(container: Container): Promise<ReceiverStatus> {
    if (this.#mode === "mounted" || this.#server) return this.status();

    try {
      this.#server = await buildStandalone(container, this.#requestTimeoutMs);
      await this.#server.listen({ port: this.#port, host: "0.0.0.0" });
      const address = this.#server.server.address();
      this.#boundPort =
        address !== null && typeof address !== "string"
          ? address.port
          : undefined;
    } catch (error) {
      this.#server = undefined;
      this.#boundPort = undefined;
      throw new UpstreamError(
        "receiver",
        `could not bind port ${String(this.#port)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { port: this.#port, hint: "Set RECEIVER_PORT to a free port." },
      );
    }

    this.#logger.info(
      { port: this.#port, baseUrl: this.#baseUrl },
      "standalone receiver listening",
    );
    return this.status();
  }

  /** Stop a standalone listener. A no-op when the receiver is mounted. */
  async stop(): Promise<{ stopped: boolean; reason: string }> {
    if (this.#mode === "mounted") {
      return {
        stopped: false,
        reason:
          "The receiver is mounted on this server's own HTTP port and stops with it.",
      };
    }
    if (!this.#server) {
      return { stopped: false, reason: "The receiver was not running." };
    }

    const server = this.#server;
    this.#server = undefined;
    this.#boundPort = undefined;
    await server.close();
    this.#logger.info("standalone receiver stopped");
    return {
      stopped: true,
      reason: "The standalone receiver has been closed.",
    };
  }

  /** Release the listener. Must run on shutdown or a stdio process hangs. */
  async dispose(): Promise<void> {
    await this.stop();
  }
}

/**
 * The standalone listener.
 *
 * Bare on purpose: no auth, no rate limit, no DNS-rebinding guard. This port
 * exists for one third-party server to POST protocol callbacks to, and every
 * one of those plugins is designed for a browser or an MCP client. Adding them
 * here would reject the only traffic the port is for.
 *
 * The viewer is the one exception, and it pays its own way: it needs CORS
 * because its page is hosted elsewhere, and it carries its own token because
 * this port binds `0.0.0.0`. Both are scoped to `/ui/api` by the delegator, so
 * the receiver and form routes are as bare as they ever were. Without this the
 * viewer would work under HTTP and silently not under stdio — which is the
 * transport most likely to be running on somebody's laptop.
 */
async function buildStandalone(container: Container, requestTimeoutMs: number) {
  const app = Fastify({
    loggerInstance: container.logger,
    requestTimeout: requestTimeoutMs,
    genReqId: () => crypto.randomUUID(),
    // Same forgiveness as the mounted app: a counterparty's trailing or
    // doubled slash is the same call, not a 404.
    routerOptions: {
      ignoreTrailingSlash: true,
      ignoreDuplicateSlashes: true,
    },
  });

  // The viewer's routes declare zod schemas, and a schema without a compiler is
  // a boot-time error. Set on both hosts so a route cannot work on one and
  // fail on the other.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  if (container.config.UI_ENABLED) {
    addPrivateNetworkPreflight(app, container.config);

    const uiOrigins = uiCorsOrigins(container.config);
    await app.register(cors, {
      delegator: (request: FastifyRequest) =>
        Promise.resolve({
          // `false` everywhere else: the receiver and form routes are reached
          // by a server and a person following a link, neither of which needs
          // a cross-origin grant from us.
          origin: request.url.startsWith(UI_ROUTE_PREFIX) ? uiOrigins : false,
          credentials: false,
        }),
    });
  }

  const mountOpts = { prefix: container.receiverRoutePrefix || "/" };
  await app.register(receiverRoutes(container), mountOpts);
  await app.register(formsRoutes(container), mountOpts);
  // Root-mounted, like on the main app: the viewer's URL is ours to choose and
  // has nothing to do with the path a counterparty was handed.
  await app.register(uiRoutes(container));
  return app;
}
