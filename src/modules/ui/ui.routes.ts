import { PassThrough } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Config } from "@/config/env.js";
import type { Container } from "@/container.js";
import { isAppError } from "@/lib/errors.js";
import { journalKey } from "@/modules/record/record.repository.js";
import {
  UiDataResponse,
  UiEventsResponse,
  UiFlowResponse,
  UiPayloadResponse,
  UiSessionListResponse,
  UiSessionResponse,
} from "@/modules/ui/ui.schema.js";
import { presentedToken } from "@/modules/ui/ui.token.js";

/**
 * The viewer's HTTP surface: read-only JSON, plus one event stream.
 *
 * Shaped after `metrics.routes.ts`, and for the same reasons — a curried
 * factory, `if (!enabled) return` so a disabled viewer 404s from the app's
 * ordinary not-found handler rather than 403ing and confirming there is
 * something here, and its own constant-time bearer check because
 * `app.authenticate` answers with an RFC 9728 discovery pointer that a browser
 * `fetch` cannot follow.
 *
 * Four things here are deliberate:
 *
 * 1. **Root-mounted, not under `receiverRoutePrefix`.** This is an operator's
 *    surface like `/health` and `/metrics`, not a URL we advertise to a
 *    counterparty. The cost is that `ui` is now reserved as a first path
 *    segment — the same caveat `receiver.routes.ts` already records for
 *    `forms`, and for the same reason: a static segment beats the receiver's
 *    parametric `/:domain`.
 * 2. **CORS is decided in `plugins/security.ts`, not here.** `@fastify/cors` is
 *    registered once, app-wide, and it owns the `OPTIONS` wildcard; a second
 *    registration in this scope would collide on that route. It reads the path
 *    to decide, so the allow-list for this prefix lives beside the app-wide
 *    one instead of being split across two files.
 * 3. **`rateLimit: false`.** The app-wide 120/min is shared with receiver
 *    traffic, and a page rendering a flow makes one call per run plus one per
 *    payload the human clicks. Letting a human reading a screen eat the
 *    participant's budget mid-transaction is not a trade worth making.
 * 4. **The stream declares no response schema**, the one exception here. It is
 *    a `text/event-stream` body, and handing a stream to the zod serialiser
 *    would serialise the object rather than pipe it.
 */

/** Where every viewer route lives. Both hosts read this. */
export const UI_ROUTE_PREFIX = "/ui/api";

/**
 * Origins allowed to read the viewer surface, or `false` when it is off.
 *
 * Defaulted from `UI_BASE_URL` rather than requiring a second variable that
 * almost always restates the first — the page is served from there, so that is
 * the origin that will be asking.
 */
export function uiCorsOrigins(config: Config): string[] | false {
  if (!config.UI_ENABLED) return false;
  return config.UI_ALLOWED_ORIGINS ?? [new URL(config.UI_BASE_URL).origin];
}

/**
 * Chrome's Private Network Access preflight.
 *
 * A page on a public origin fetching `http://127.0.0.1` — the viewer reading a
 * locally-run engine, which is the ordinary case on a laptop — is refused
 * unless the preflight answers this header. It has to be added **before**
 * `@fastify/cors`, because cors answers preflights inside its own hook and
 * never reaches a later one. Harmless in browsers that do not enforce it.
 *
 * Lives here rather than in either host so the two cannot disagree about which
 * paths it covers.
 */

/**
 * Narrower than `FastifyInstance` deliberately.
 *
 * The two hosts specialise Fastify's generics differently — the standalone
 * receiver pins the logger type by passing a pino instance, which is the same
 * reason `app.ts` infers `App` rather than annotating it — so a parameter typed
 * as a plain `FastifyInstance` rejects one of them. This only ever adds a hook.
 */
export interface PreflightHost {
  addHook(
    name: "onRequest",
    hook: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  ): unknown;
}
export function addPrivateNetworkPreflight(
  app: PreflightHost,
  config: Config,
): void {
  if (!config.UI_ENABLED) return;

  app.addHook("onRequest", async (request, reply) => {
    if (
      request.method === "OPTIONS" &&
      request.headers["access-control-request-private-network"] === "true" &&
      request.url.startsWith(UI_ROUTE_PREFIX)
    ) {
      reply.header("access-control-allow-private-network", "true");
    }
  });
}

/** How long one park lasts before the stream emits a comment and parks again. */
const STREAM_HEARTBEAT_MS = 25_000;

/** What the browser waits before reconnecting a dropped stream. */
const STREAM_RETRY_MS = 2_000;

/**
 * `AppError.code` → HTTP status, for the one surface that needs one.
 *
 * Anything not named here falls through to the app-wide handler and its 500,
 * which is the right default: an error this table does not know about is one
 * nobody has decided the browser should be told about.
 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  not_found: 404,
  validation_error: 400,
  conflict: 409,
  unauthorized: 401,
  forbidden: 403,
  // The config-service or the validation oracle, not this process. `502` says
  // "try again", which is true, where `500` invites somebody to read our logs.
  upstream_error: 502,
};

const SessionParams = z.object({ sessionId: z.string().min(1) });
const FlowParams = SessionParams.extend({ flowId: z.string().min(1) });
const PayloadParams = SessionParams.extend({ payloadId: z.string().min(1) });
const DataQuery = z.object({ transaction_id: z.string().min(1) });
const EventsQuery = z.object({
  after_seq: z.coerce.number().int().min(0).default(0),
});

export function uiRoutes(container: Container) {
  const { config, logger } = container;

  return async function register(app: FastifyInstance): Promise<void> {
    if (!config.UI_ENABLED) return;

    const ui = container.ui;
    const token = container.uiToken;
    const open = new Set<PassThrough>();

    app.addHook("onRequest", async (request, reply) => {
      // A preflight carries no Authorization header by definition. Refusing it
      // would fail the request the browser sends *before* the one that could
      // have authenticated. CORS already decided whether this origin may ask.
      if (request.method === "OPTIONS") return;

      // Helmet sets `same-origin` app-wide, which is right for everything else
      // this process serves and wrong for the one surface whose whole purpose
      // is to be read from another origin. A CORS-mode `fetch` is not supposed
      // to be subject to CORP at all — but the two have interacted in browsers
      // before, the failure mode is a blocked read with no useful console
      // message, and saying `cross-origin` explicitly costs nothing. What may
      // actually *read* the response is still decided by CORS and the token.
      reply.header("cross-origin-resource-policy", "cross-origin");

      // The token rides in the link, so it is in the browser's history and in
      // anything that reads a URL. Say plainly that this page is not to be
      // cached or referred onward.
      reply.header("cache-control", "no-store");
      reply.header("referrer-policy", "no-referrer");

      if (
        token.accepts(
          presentedToken(
            request.headers,
            request.query as Record<string, unknown>,
          ),
        )
      ) {
        return;
      }

      return reply
        .code(401)
        .header("www-authenticate", 'Bearer realm="viewer"')
        .send({
          error: {
            code: "unauthorized",
            message:
              "The viewer requires the token from the link session_create handed over — " +
              "as `Authorization: Bearer <UI_TOKEN>` or `?k=<UI_TOKEN>`.",
          },
        });
    });

    // Every open stream is parked on a waiter and will not notice a shutdown on
    // its own. Without this a stdio process hangs on exit and an HTTP one waits
    // out `close-with-grace`.
    app.addHook("onClose", async () => {
      for (const stream of open) stream.destroy();
      open.clear();
    });

    /**
     * `AppError` carries a *channel*, not a status.
     *
     * That is right for the rest of this server: every other caller is an MCP
     * client, where "no session with that id" is a tool result the model reads
     * and acts on, and the app-wide handler correctly refuses to invent HTTP
     * semantics for it. The viewer is the one REST surface that calls services
     * directly, so it is the one place that has to translate — and a browser
     * genuinely needs the difference, because a page rendering "that session
     * has expired" and a page rendering "something broke" are different pages.
     *
     * Scoped to this plugin, so nothing else changes shape.
     */
    app.setErrorHandler((error, request, reply) => {
      if (isAppError(error)) {
        const status = STATUS_BY_CODE[error.code] ?? 500;
        if (status < 500) {
          request.log.info({ err: error }, "viewer: request refused");
          return reply
            .code(status)
            .send({ error: { code: error.code, message: error.message } });
        }
      }
      throw error;
    });

    const typed = app.withTypeProvider<ZodTypeProvider>();
    const readOnly = { rateLimit: false } as const;

    typed.route({
      method: "GET",
      url: `${UI_ROUTE_PREFIX}/sessions`,
      config: readOnly,
      schema: {
        description:
          "Live sessions on this instance, newest first. Candidates that no longer resolve are dropped.",
        response: { 200: UiSessionListResponse },
      },
      handler: () => ui.listSessions(),
    });

    typed.route({
      method: "GET",
      url: `${UI_ROUTE_PREFIX}/sessions/:sessionId`,
      config: readOnly,
      schema: {
        description:
          "One session: the participant under test, the build, every published flow, and a row per run.",
        params: SessionParams,
        response: { 200: UiSessionResponse },
      },
      handler: (request) => ui.session(request.params.sessionId),
    });

    typed.route({
      method: "GET",
      url: `${UI_ROUTE_PREFIX}/sessions/:sessionId/flows/:flowId`,
      config: readOnly,
      schema: {
        description:
          "One run's derived step map, unprojected — the same read flow_get_status renders.",
        params: FlowParams,
        response: { 200: UiFlowResponse },
      },
      handler: (request) =>
        ui.flow(request.params.sessionId, request.params.flowId),
    });

    typed.route({
      method: "GET",
      url: `${UI_ROUTE_PREFIX}/sessions/:sessionId/payloads/:payloadId`,
      config: readOnly,
      schema: {
        description:
          "One stored payload and the ACK/NACK exchanged for it. Uncapped: a browser has no context budget.",
        params: PayloadParams,
        response: { 200: UiPayloadResponse },
      },
      handler: (request) =>
        ui.payload(request.params.sessionId, request.params.payloadId),
    });

    typed.route({
      method: "GET",
      url: `${UI_ROUTE_PREFIX}/sessions/:sessionId/data`,
      config: readOnly,
      schema: {
        description: "Business data accumulated on one transaction.",
        params: SessionParams,
        querystring: DataQuery,
        response: { 200: UiDataResponse },
      },
      handler: (request) =>
        ui.businessData(request.params.sessionId, request.query.transaction_id),
    });

    typed.route({
      method: "GET",
      url: `${UI_ROUTE_PREFIX}/sessions/:sessionId/events`,
      config: readOnly,
      schema: {
        description:
          "The session journal since `after_seq`. Cursor-neutral: reading here never consumes what the model has not been shown.",
        params: SessionParams,
        querystring: EventsQuery,
        response: { 200: UiEventsResponse },
      },
      handler: (request) =>
        ui.events(request.params.sessionId, request.query.after_seq),
    });

    /**
     * The journal, as it happens.
     *
     * Parks on the same wake-up primitive `flow_await` uses rather than polling,
     * and re-reads the store at the top of every iteration — an entry appended
     * between a read and the park that follows it would notify nobody, and the
     * stream would sit out the heartbeat with its answer already durable. That
     * ordering is the whole reason `TransactionEvents` is safe to build on: an
     * event is a hint, never the change.
     *
     * `id:` is the journal seq, so a dropped connection resumes from
     * `last-event-id` instead of replaying from zero.
     */
    app.route<{
      Params: { sessionId: string };
      Querystring: { after_seq?: string };
    }>({
      method: "GET",
      url: `${UI_ROUTE_PREFIX}/sessions/:sessionId/stream`,
      config: readOnly,
      handler: async (request, reply) => {
        const { sessionId } = request.params;
        // Before anything is committed to, so an unknown session is a 404 the
        // page can render rather than an empty stream it waits on forever.
        const start = await ui.events(sessionId, cursorFrom(request));

        const stream = new PassThrough();
        open.add(stream);

        const finish = (): void => {
          open.delete(stream);
          stream.destroy();
        };
        // The **reply**, not the request. Node emits `close` on an
        // `IncomingMessage` once the request has been fully handled, which for
        // a bodyless GET is immediately — so watching the request here tore the
        // stream down before it had delivered anything, and the symptom was a
        // connection that stayed open and never spoke.
        reply.raw.on("close", finish);

        void pump(stream, sessionId, start.seq).catch((error: unknown) => {
          logger.warn(
            { session_id: sessionId, err: String(error) },
            "viewer: stream ended on error",
          );
          finish();
        });

        // Written before anything else, and never skipped: Node holds the
        // response headers until the first byte, so a stream opened on a quiet
        // session would leave the browser waiting on `fetch` — not on an event
        // — until something finally happened. `retry` is the reconnect delay
        // the browser should use, which is the useful thing to spend the first
        // frame on.
        stream.write(`retry: ${String(STREAM_RETRY_MS)}\n\n`);

        for (const event of start.events) {
          stream.write(frame(event.seq, event));
        }

        return (
          reply
            .header("content-type", "text/event-stream; charset=utf-8")
            .header("cache-control", "no-store")
            .header("connection", "keep-alive")
            // Nginx buffers a proxied response by default, which turns a live
            // stream into one delivered all at once when it ends.
            .header("x-accel-buffering", "no")
            .send(stream)
        );
      },
    });

    async function pump(
      stream: PassThrough,
      sessionId: string,
      from: number,
    ): Promise<void> {
      let cursor = from;

      while (!stream.destroyed) {
        const woke = await container.events.waitFor(journalKey(sessionId), {
          afterSeq: cursor,
          timeoutMs: STREAM_HEARTBEAT_MS,
        });
        if (stream.destroyed) return;

        // Read regardless of why we woke: a timeout still has to check, because
        // an append can land between the previous read and the park.
        const { events } = await ui.events(sessionId, cursor);
        for (const event of events) {
          if (stream.destroyed) return;
          stream.write(frame(event.seq, event));
          cursor = event.seq;
        }

        if (!woke && events.length === 0) stream.write(": keep-alive\n\n");
      }
    }

    app.log.info(
      { configured_token: token.configured },
      `viewer: read-only surface served under GET ${UI_ROUTE_PREFIX}`,
    );
  };
}

/** Where a reconnecting stream resumes: the SSE header first, then the query. */
function cursorFrom(request: {
  headers: Record<string, unknown>;
  query: { after_seq?: string };
}): number {
  const header = request.headers["last-event-id"];
  const raw = typeof header === "string" ? header : request.query.after_seq;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function frame(id: number, event: unknown): string {
  return `id: ${String(id)}\ndata: ${JSON.stringify(event)}\n\n`;
}
