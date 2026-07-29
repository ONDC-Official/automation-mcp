import Fastify from "fastify";
import type { Logger } from "pino";
import type { Container } from "@/container.js";
import { UpstreamError } from "@/lib/errors.js";
import { formsRoutes } from "@/modules/forms/forms.routes.js";
import { receiverRoutes } from "@/modules/transport/receiver.routes.js";

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
        ? { port: this.#port }
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
    } catch (error) {
      this.#server = undefined;
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

  const mountOpts = { prefix: container.receiverRoutePrefix || "/" };
  await app.register(receiverRoutes(container), mountOpts);
  await app.register(formsRoutes(container), mountOpts);
  return app;
}
