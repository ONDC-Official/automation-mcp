import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UpstreamError } from "@/lib/errors.js";
import { logger } from "@/lib/logger.js";
import { readAck, SenderService } from "@/modules/transport/sender.service.js";
import { requestBody } from "@/test/mock-participant.js";

/**
 * Outbound calls, against undici's own mock dispatcher — a real request through
 * the real client, with the socket intercepted. Stubbing `send` itself would
 * skip exactly the parts worth testing: the URL we build and the bytes we send.
 */

const NP = "https://np.example.com";

let agent: MockAgent;
let sender: SenderService;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  sender = new SenderService({
    logger,
    timeoutMs: 2_000,
    dispatcher: agent,
  });
});

afterEach(async () => {
  await agent.close();
});

describe("SenderService", () => {
  it("POSTs to {subscriber_url}/{action}", async () => {
    let seenPath = "";
    let seenBody = "";
    agent
      .get(NP)
      .intercept({ path: "/search", method: "POST" })
      .reply(200, (options) => {
        seenPath = String(options.path);
        seenBody = requestBody(options);
        return { message: { ack: { status: "ACK" } } };
      });

    const result = await sender.send(NP, "search", {
      context: { action: "search" },
    });

    expect(seenPath).toBe("/search");
    expect(seenBody).toBe('{"context":{"action":"search"}}');
    expect(result).toMatchObject({ httpStatus: 200, ack: "ACK" });
  });

  it("hashes and sends the same bytes, so a signature would stay valid", async () => {
    // The whole reason the body is serialised once: an ONDC signature covers a
    // digest of the literal payload bytes, and a re-stringify between signing
    // and sending silently invalidates every one of them.
    let signed = "";
    let sent = "";
    agent
      .get(NP)
      .intercept({ path: "/select", method: "POST" })
      .reply(200, (options) => {
        sent = requestBody(options);
        return { message: { ack: { status: "ACK" } } };
      });

    const signing = new SenderService({
      logger,
      timeoutMs: 2_000,
      dispatcher: agent,
      signer: {
        sign: (bytes) => {
          signed = bytes;
          return Promise.resolve('Signature keyId="x"');
        },
      },
    });

    const result = await signing.send(NP, "select", { a: 1, b: [2, 3] });

    expect(signed).toBe(sent);
    expect(result.sentBytes).toBe(sent);
  });

  it("sends an Authorization header only when the signer produces one", async () => {
    const headers: (string | undefined)[] = [];
    agent
      .get(NP)
      .intercept({ path: "/search", method: "POST" })
      .reply(200, (options) => {
        const raw = options.headers as Record<string, string> | undefined;
        headers.push(raw?.["authorization"]);
        return { message: { ack: { status: "ACK" } } };
      })
      .times(1);

    await sender.send(NP, "search", {});
    expect(headers[0]).toBeUndefined();
  });

  it("treats a NACK as data, not as a failure", async () => {
    // The participant rejecting the payload is the most informative result a
    // test can produce; throwing here would hide it from the model.
    agent
      .get(NP)
      .intercept({ path: "/search", method: "POST" })
      .reply(200, {
        message: { ack: { status: "NACK" } },
        error: { code: "30000", message: "bad request" },
      });

    const result = await sender.send(NP, "search", {});

    expect(result.ack).toBe("NACK");
    expect(result.body).toMatchObject({ error: { code: "30000" } });
  });

  it("flags an unparseable answer distinctly from a NACK", async () => {
    agent
      .get(NP)
      .intercept({ path: "/search", method: "POST" })
      .reply(502, "<html>Bad Gateway</html>");

    const result = await sender.send(NP, "search", {});

    expect(result.ack).toBe("UNPARSEABLE");
    expect(result.httpStatus).toBe(502);
    expect(result.body).toContain("Bad Gateway");
  });

  it("throws when the exchange never happened", async () => {
    agent
      .get(NP)
      .intercept({ path: "/search", method: "POST" })
      .replyWithError(new Error("ECONNREFUSED"));

    await expect(sender.send(NP, "search", {})).rejects.toThrow(UpstreamError);
  });

  it("strips a trailing slash from the subscriber URL", async () => {
    agent
      .get(NP)
      .intercept({ path: "/on_search", method: "POST" })
      .reply(200, { message: { ack: { status: "ACK" } } });

    await expect(sender.send(`${NP}/`, "on_search", {})).resolves.toMatchObject(
      { ack: "ACK" },
    );
  });
});

describe("readAck", () => {
  it.each([
    [{ message: { ack: { status: "ACK" } } }, "ACK"],
    [{ message: { ack: { status: "NACK" } } }, "NACK"],
    [{ message: { ack: {} } }, "UNPARSEABLE"],
    [{}, "UNPARSEABLE"],
    ["not json", "UNPARSEABLE"],
    [undefined, "UNPARSEABLE"],
  ])("%j → %s", (body, expected) => {
    expect(readAck(body)).toBe(expected);
  });
});
