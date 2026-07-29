import type { FastifyInstance } from "fastify";
import type { Container } from "@/container.js";

/**
 * The pages a participant opens when this mock hosts a form.
 *
 * ## The URL shape is not ours to choose
 *
 * The mock config's own `createFormURL` helper builds
 * `{mockBaseUrl}/forms/{domain}/{formId}/?transaction_id=…&session_id=…` and
 * bakes it into the payload we already sent. These routes exist to be the other
 * end of that link, so their shape is fixed by the helper, not by us. Changing
 * it means every form URL already on the wire points at nothing.
 *
 * Unauthenticated, like the receiver: the person opening this page is a tester
 * following a link out of a beckn payload, not an MCP client.
 */
export function formsRoutes(container: Container) {
  const forms = container.services.forms;

  return async function register(app: FastifyInstance): Promise<void> {
    // A browser submits `application/x-www-form-urlencoded`, which Fastify
    // does not parse out of the box — without this every real submission is
    // answered 415. Registered on this plugin's scope only, so the MCP and
    // receiver routes keep their JSON-only surface.
    app.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_request, body: string | Buffer, done) => {
        try {
          const params = new URLSearchParams(body.toString());
          done(null, Object.fromEntries(params.entries()));
        } catch (error) {
          done(error as Error, undefined);
        }
      },
    );

    // `createFormURL` emits a trailing slash. The app runs with
    // `ignoreTrailingSlash`, so one declaration covers both spellings —
    // declaring both would now be a duplicate-route error at boot.
    const renderHandler = async (
      request: {
        params: { domain: string; formId: string };
        query: { transaction_id?: string; session_id?: string };
      },
      reply: {
        code: (status: number) => {
          type: (mime: string) => { send: (body: string) => unknown };
        };
      },
    ) => {
      const rendered = await forms.renderHostedForm({
        domain: request.params.domain,
        formId: request.params.formId,
        transactionId: request.query.transaction_id ?? "",
        sessionId: request.query.session_id ?? "",
      });

      return reply
        .code(rendered.status)
        .type("text/html; charset=utf-8")
        .send(rendered.html);
    };

    app.get<{
      Params: { domain: string; formId: string };
      Querystring: { transaction_id?: string; session_id?: string };
    }>("/forms/:domain/:formId", renderHandler);

    app.post<{
      Params: { domain: string; formId: string };
      Querystring: { transaction_id?: string; session_id?: string };
    }>("/forms/:domain/:formId/submit", async (request, reply) => {
      const result = await forms.acceptSubmission({
        domain: request.params.domain,
        formId: request.params.formId,
        transactionId: request.query.transaction_id ?? "",
        sessionId: request.query.session_id ?? "",
        fields: asFields(request.body),
      });

      // Content negotiation matters here: a person submitting from a browser
      // wants a page, an integration wants the submission id.
      const wantsHtml = String(request.headers.accept ?? "").includes(
        "text/html",
      );
      return wantsHtml
        ? reply
            .code(result.status)
            .type("text/html; charset=utf-8")
            .send(result.html)
        : reply.code(result.status).send(result.json);
    });
  };
}

/** A form POST arrives urlencoded; coerce every value to a string. */
function asFields(body: unknown): Record<string, string> {
  if (typeof body !== "object" || body === null) return {};

  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    fields[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return fields;
}
