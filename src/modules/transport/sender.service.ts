import type { Dispatcher } from "undici";
import { request } from "undici";
import type { Logger } from "pino";
import { UpstreamError } from "@/lib/errors.js";
import type { AckStatus } from "@/modules/record/record.schema.js";

/**
 * Putting a payload on the wire.
 *
 * A beckn call is `POST {subscriber_url}/{action}` with a JSON body, answered
 * synchronously with an ACK or a NACK. That is the whole protocol here; the
 * interesting work is in what counts as a failure.
 *
 * ## A NACK is data, not an exception
 *
 * The participant rejecting our payload is a **result** — very often the most
 * informative one a test produces. It is recorded, returned, and shown to the
 * model so it can fix the payload. Only a failure to *complete the exchange* —
 * connection refused, timeout, TLS error — is thrown, because there is nothing
 * to record and nothing the model can learn from the body.
 *
 * ## The signing seam
 *
 * The body is serialised **once** and both hashed and sent as those exact
 * bytes. ONDC signatures are over a BLAKE2b-512 digest of the literal payload,
 * so a re-`stringify` between signing and sending silently invalidates every
 * signature. Signing is deferred, but the shape that makes it correct is not.
 */

/** Signs the exact bytes about to be sent. */
export interface RequestSigner {
  /** Header value for `Authorization`, or `undefined` to send unsigned. */
  sign(bodyBytes: string, action: string): Promise<string | undefined>;
}

/**
 * The no-op signer this milestone ships.
 *
 * Participants with header validation switched on will answer 401 — that is
 * expected and visible, not silent.
 */
export class NoopSigner implements RequestSigner {
  sign(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }
}

export interface SendResult {
  httpStatus: number;
  ack: AckStatus;
  /** The response body, parsed when it was JSON, raw text otherwise. */
  body: unknown;
  /** The exact bytes sent — what a signature would have covered. */
  sentBytes: string;
  url: string;
}

export interface SenderServiceOptions {
  logger: Logger;
  timeoutMs: number;
  signer?: RequestSigner;
  /** Shared undici agent. Injected in tests as a `MockAgent`. */
  dispatcher?: Dispatcher;
}

export class SenderService {
  readonly #logger: Logger;
  readonly #timeoutMs: number;
  readonly #signer: RequestSigner;
  readonly #dispatcher: Dispatcher | undefined;

  constructor(options: SenderServiceOptions) {
    this.#logger = options.logger;
    this.#timeoutMs = options.timeoutMs;
    this.#signer = options.signer ?? new NoopSigner();
    this.#dispatcher = options.dispatcher;
  }

  async send(
    subscriberUrl: string,
    action: string,
    payload: unknown,
  ): Promise<SendResult> {
    const url = `${subscriberUrl.replace(/\/+$/, "")}/${action}`;
    const sentBytes = JSON.stringify(payload);
    const authorization = await this.#signer.sign(sentBytes, action);

    let response: Dispatcher.ResponseData;
    try {
      response = await request(url, {
        method: "POST",
        body: sentBytes,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(authorization !== undefined ? { authorization } : {}),
        },
        headersTimeout: this.#timeoutMs,
        bodyTimeout: this.#timeoutMs,
        ...(this.#dispatcher ? { dispatcher: this.#dispatcher } : {}),
      });
    } catch (error) {
      // No exchange happened, so there is nothing to record and nothing the
      // model can fix in the payload. This is the one throwing case.
      throw new UpstreamError(
        "network-participant",
        `could not reach ${url}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { url, action },
      );
    }

    const text = await response.body.text();
    const body = parseBody(text);
    const ack = readAck(body);

    this.#logger.info(
      { url, action, status: response.statusCode, ack },
      "sent protocol call",
    );

    return { httpStatus: response.statusCode, ack, body, sentBytes, url };
  }
}

function parseBody(text: string): unknown {
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A non-JSON body is itself a finding — a proxy error page, a plain 500.
    return text;
  }
}

/**
 * Read the ACK out of a response.
 *
 * `UNPARSEABLE` is deliberately distinct from `NACK`: "the participant rejected
 * this" and "the participant answered something that is not a beckn response"
 * are different compliance findings, and collapsing them hides a real defect.
 */
export function readAck(body: unknown): AckStatus {
  if (typeof body !== "object" || body === null) return "UNPARSEABLE";

  const status = (body as { message?: { ack?: { status?: unknown } } }).message
    ?.ack?.status;

  if (status === "ACK") return "ACK";
  if (status === "NACK") return "NACK";
  return "UNPARSEABLE";
}
