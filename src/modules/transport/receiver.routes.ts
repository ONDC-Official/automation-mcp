import type { FastifyInstance } from "fastify";
import type { Container } from "@/container.js";
import { roleFromSegment } from "@/modules/catalog/catalog.service.js";

/**
 * The mock's wire presence: the routes a real network participant calls.
 *
 * ## The URL is the network's, not ours
 *
 * `{base}/{domain}/{version}/{buyer|seller}/{action}` — the shape the workbench
 * publishes and every ONDC participant already knows how to talk to. We
 * advertise the first four segments as `bap_uri`/`bpp_uri`; the caller appends
 * `/{action}` itself, because a beckn callback is `{callback_uri}/{action}`.
 *
 * `buyer` is the URI of a BAP and `seller` the URI of a BPP, so the segment
 * names **our** role — the endpoint is ours. It follows that the *counterparty*
 * is on the opposite side of the payload's context, which is where the receiver
 * reads it from.
 *
 * Nothing here identifies a session, deliberately: a participant integrates
 * against an endpoint, not against one of our test runs. `ReceiverService`
 * recovers the session from `transaction_id` or from an armed expectation, the
 * way the workbench's own receiver does.
 *
 * ## Route shape
 *
 * One parametric route rather than two static-role ones. Both match, but the
 * static form is case-sensitive and answers `/Buyer` with a bare framework 404;
 * this way the role is normalised and a wrong one gets an answer that says so.
 *
 * A domain like `ONDC:RET10` is a single path segment — a colon is an ordinary
 * path character, and only the *route definition* treats it specially. Fastify
 * decodes params, so a caller that percent-encodes it lands here too.
 *
 * The one collision worth naming: a domain literally called `forms` would be
 * swallowed by the form routes, which lead with a static segment and therefore
 * win. ONDC domains are `ONDC:XXX`, so this cannot happen in practice.
 *
 * ## Unauthenticated, like `/health`
 *
 * These are called by a third-party server that has no MCP credentials and
 * never will. Authenticity here is a *protocol* concern — the ONDC signature —
 * not an MCP one, which is why `verifyAuth` lives in the receiver rather than
 * in the auth plugin.
 */
export function receiverRoutes(container: Container) {
  const { flow } = container.services;
  const inbound = container.inbound;

  return async function register(app: FastifyInstance): Promise<void> {
    app.post<{
      Params: {
        domain: string;
        version: string;
        role: string;
        action: string;
      };
    }>("/:domain/:version/:role/:action", async (request, reply) => {
      const { domain, version, action } = request.params;
      const role = roleFromSegment(request.params.role);

      if (role === undefined) {
        return reply.code(404).send({
          error: {
            code: "UNKNOWN_ROLE",
            message: `"${request.params.role}" is not an endpoint on this mock. Use "buyer" (a BAP) or "seller" (a BPP).`,
          },
        });
      }

      const result = await inbound.handle(
        { domain, version, role, action },
        request.body,
        request.headers,
      );

      // The ACK goes out first, always. Chaining our next step before
      // answering would hold the participant's connection open for the
      // length of our own outbound call, and blow its ACK window.
      await reply.code(result.status).send(result.body);

      if (result.chain) {
        const { sessionId: chainSession, transactionId } = result.chain;
        setImmediate(() => {
          void flow
            .chainNext(chainSession, transactionId)
            .catch((error: unknown) => {
              container.logger.error(
                { err: error, transactionId },
                "auto-advance chain failed",
              );
            });
        });
      } else if (result.complete) {
        // A flow whose last step is the participant's finishes *inside* their
        // callback: no outcome is returned to anyone, so without this the run
        // would simply stop looking busy and nothing would ever say it was
        // done. Only when nothing is chaining — `chainNext` notices for itself.
        const { sessionId: doneSession, transactionId } = result.complete;
        setImmediate(() => {
          void flow.noteCompletion(doneSession, transactionId);
        });
      }

      return reply;
    });

    // Curling the exact URI we handed over should say something. Without this
    // a tester checking their tunnel gets a bare 404 and cannot tell whether
    // the address is wrong or the server is down.
    app.get<{ Params: { domain: string; version: string; role: string } }>(
      "/:domain/:version/:role",
      async (request, reply) => {
        const { domain, version } = request.params;
        const role = roleFromSegment(request.params.role);
        if (role === undefined) return reply.callNotFound();

        return reply.send({
          ok: true,
          domain,
          version,
          role,
          mock_role: role === "buyer" ? "BAP" : "BPP",
          // Rebuilt from the decoded params rather than echoed from the URL, so
          // a caller that percent-encoded the domain's colon is still shown the
          // canonical spelling — the one it should be storing.
          accepts: `POST ${container.receiverRoutePrefix}/${domain}/${version}/${role}/{action}`,
        });
      },
    );
  };
}
