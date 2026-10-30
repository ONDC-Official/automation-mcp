import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keepRawJsonBody } from "@/modules/transport/receiver.routes.js";

/**
 * The raw body is what an ONDC signature covers, so the receiver must hand the
 * signature check the bytes the participant sent — not a re-serialisation of
 * what Fastify parsed.
 */

let app: FastifyInstance;

beforeEach(async () => {
  app = Fastify();
  // The receiver's scope, with the parser…
  await app.register((scope, _options, done) => {
    keepRawJsonBody(scope);
    scope.post("/receiver", (request, reply) =>
      reply.send({ raw: request.rawBody, parsed: request.body }),
    );
    done();
  });
  // …and a sibling scope, which must keep Fastify's default.
  await app.register((scope, _options, done) => {
    scope.post("/other", (request, reply) =>
      reply.send({ raw: request.rawBody ?? null }),
    );
    done();
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function post(url: string, payload: string) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json" },
    payload,
  });
}

describe("keepRawJsonBody", () => {
  it.each([
    ["minified", '{"context":{"action":"search"}}'],
    ["pretty-printed", '{\n  "context": {\n    "action": "search"\n  }\n}'],
    ["with a trailing newline", '{"context":{"action":"search"}}\n'],
    ["with escapes JSON.stringify would not write", '{"name":"caf\\u00e9"}'],
    ["non-ASCII", '{"name":"चाय ☕"}'],
  ])("keeps a %s body byte for byte", async (_label, payload) => {
    const response = await post("/receiver", payload);

    expect(response.statusCode).toBe(200);
    const { raw, parsed } = response.json<{ raw: string; parsed: unknown }>();
    expect(raw).toBe(payload);
    expect(parsed).toEqual(JSON.parse(payload));
  });

  it.each([
    ["malformed JSON", "{not json", "FST_ERR_CTP_INVALID_JSON_BODY"],
    ["an empty body", "", "FST_ERR_CTP_EMPTY_JSON_BODY"],
  ])(
    "answers %s with the same 400 as before",
    async (_label, payload, code) => {
      const receiver = await post("/receiver", payload);
      const other = await post("/other", payload);

      expect(receiver.statusCode).toBe(400);
      expect(receiver.json()).toMatchObject({ code });
      expect(receiver.json()).toEqual(other.json());
    },
  );

  it("still refuses prototype poisoning", async () => {
    const response = await post("/receiver", '{"__proto__":{"admin":true}}');
    expect(response.statusCode).toBe(400);
  });

  it("does not leak into sibling scopes", async () => {
    const response = await post("/other", '{"a":1}');
    expect(response.json()).toEqual({ raw: null });
  });
});
