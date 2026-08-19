import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Container } from "@/container.js";

/**
 * The Prometheus scrape endpoint.
 *
 * Four decisions here are deliberate and each of them looks like an oversight
 * to someone tidying up:
 *
 * 1. **No response schema, and this is the one un-schema'd 200 in the app.**
 *    Every other route declares one, because `serializerCompiler` uses it to
 *    serialise. The exposition format is a `text/plain` document, not an
 *    object; handing it to the zod serialiser mangles it into a JSON string,
 *    complete with escaped newlines, and Prometheus rejects the scrape. There
 *    is nothing to describe here that a schema would describe.
 * 2. **`rateLimit: false`.** The app-wide 120/min is shared with receiver
 *    traffic behind the same proxy, and a scraper polling every 15s alongside
 *    a participant mid-transaction would either lose scrapes or eat the
 *    participant's budget. Neither is acceptable and the endpoint is cheap.
 * 3. **`app.authenticate` is the wrong tool.** It answers a 401 carrying an
 *    RFC 9728 `resource_metadata` pointer, which assumes the caller can do
 *    OAuth discovery. A Prometheus scraper cannot; it can send one static
 *    bearer token. So `METRICS_TOKEN` is checked here, in constant time.
 * 4. **`METRICS_ENABLED=false` registers no route at all**, so the answer is a
 *    404 from the app's normal not-found handler rather than a 403 that
 *    confirms there is something here to find.
 *
 * The reason any of this matters: `RECEIVER_PUBLIC_URL` exists precisely so
 * this process is reachable from the internet by a third party. An open
 * `/metrics` on such a process publishes a map of what is being tested — every
 * `flow_id`, every build, every participant's failure rate. `env.ts` refuses to
 * boot a production instance that leaves it unauthenticated, mirroring the
 * refusal of `AUTH_MODE=none`.
 */

export function metricsRoutes(container: Container) {
  const { config, metrics } = container;

  return async function register(app: FastifyInstance): Promise<void> {
    if (!config.METRICS_ENABLED) return;

    const token = config.METRICS_TOKEN;

    app.route({
      method: "GET",
      url: "/metrics",
      config: { rateLimit: false },
      handler: async (request, reply) => {
        if (token !== undefined && !presentsToken(request, token)) {
          return reply
            .code(401)
            .header("www-authenticate", 'Bearer realm="metrics"')
            .send({
              error: {
                code: "unauthorized",
                message:
                  "GET /metrics requires `Authorization: Bearer <METRICS_TOKEN>`.",
              },
            });
        }

        return reply
          .type(metrics.registry.contentType)
          .send(await metrics.registry.metrics());
      },
    });

    app.log.info(
      { authenticated: token !== undefined },
      "metrics: exposition served at GET /metrics",
    );
  };
}

/**
 * Constant-time bearer comparison.
 *
 * **The length guard is not an optimisation.** `timingSafeEqual` *throws* on
 * buffers of different lengths, so without it a token of the wrong length
 * would leave the handler as a 500 rather than a 401 — which both fails the
 * caller confusingly and leaks the correct length through the status code.
 */
function presentsToken(request: FastifyRequest, expected: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== "string") return false;

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const presented = match?.[1];
  if (presented === undefined) return false;

  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
