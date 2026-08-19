import type { Dispatcher } from "undici";
import { request } from "undici";
import type { Logger } from "pino";
import { UpstreamError } from "@/lib/errors.js";
import type { Metrics } from "@/lib/metrics/metrics.js";
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
 * ## A throw still has to say whether the call was delivered
 *
 * The caller records the outbound entry *before* the send (see
 * `ApiEntry.sendState`), so on a throw it has to decide whether to withdraw that
 * entry or keep it. The two cases are genuinely different and only this module
 * can tell them apart, so every `UpstreamError` from here carries `delivery`:
 *
 * - **`unreachable`** — the connection never came up. Nothing crossed, the step
 *   is still owed, and the entry is withdrawn so the model can retry cleanly.
 * - **`uncertain`** — the request was written and the answer never arrived: a
 *   header or body timeout, a reset mid-flight. It may well have been processed,
 *   so the entry is kept and marked `failed`. **This is the default**, because
 *   guessing "nothing happened" is what would put a duplicate call on a real
 *   participant's wire.
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
  /** Optional; absent in unit tests. A send behaves the same either way. */
  metrics?: Metrics;
}

export class SenderService {
  readonly #logger: Logger;
  readonly #timeoutMs: number;
  readonly #signer: RequestSigner;
  readonly #dispatcher: Dispatcher | undefined;
  readonly #metrics: Metrics | undefined;

  constructor(options: SenderServiceOptions) {
    this.#logger = options.logger;
    this.#timeoutMs = options.timeoutMs;
    this.#signer = options.signer ?? new NoopSigner();
    this.#dispatcher = options.dispatcher;
    this.#metrics = options.metrics;
  }

  async send(
    subscriberUrl: string,
    action: string,
    payload: unknown,
  ): Promise<SendResult> {
    const url = `${subscriberUrl.replace(/\/+$/, "")}/${action}`;
    const sentBytes = JSON.stringify(payload);
    const authorization = await this.#signer.sign(sentBytes, action);
    // The clock starts after signing, so the histogram measures the wire and
    // not our own crypto — the two have different owners and different fixes.
    const started = performance.now();

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
      // The exchange did not complete, so the model has no body to learn from.
      // `delivery` is what tells the caller whether to withdraw the entry it
      // recorded before this call or keep it as "outcome unknown".
      //
      // Counted with the *same* `delivery` classification the caller acts on,
      // not with a generic `error`: "nothing crossed" and "we cannot tell" are
      // the two facts an operator needs, and they are already distinguished
      // here and nowhere else.
      this.#record(action, classifyDelivery(error), started);
      throw new UpstreamError(
        "network-participant",
        `could not reach ${url}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { url, action, delivery: classifyDelivery(error) },
      );
    }

    let text: string;
    try {
      text = await response.body.text();
    } catch (error) {
      // Headers came back, so the request unambiguously crossed — only the
      // answer is lost. Wrapped rather than left raw so the caller sees the same
      // error shape (and the same `delivery` field) it sees for every other
      // transport failure.
      this.#record(action, "uncertain", started);
      throw new UpstreamError(
        "network-participant",
        `${url} answered ${String(response.statusCode)} but the body never arrived: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { url, action, delivery: "uncertain", http_status: response.statusCode },
      );
    }

    const body = parseBody(text);
    const ack = readAck(body);

    this.#logger.info(
      { url, action, status: response.statusCode, ack },
      "sent protocol call",
    );

    this.#record(action, ack, started);
    return { httpStatus: response.statusCode, ack, body, sentBytes, url };
  }

  /**
   * One outbound call, counted and timed.
   *
   * **Only the histogram is here; the counter is not.** `ondc_outbound_sends_total`
   * comes off the journal (`MetricsObserver`), which sees the same sends and
   * already knows which were chained. Counting in both places would double
   * every send, and the histogram is the half the journal genuinely cannot
   * produce.
   *
   * `outcome` deliberately spans two vocabularies — `ACK`/`NACK`/`UNPARSEABLE`
   * from a completed exchange, `unreachable`/`uncertain` from one that threw.
   * Both are bounded enums, and collapsing them into "success/failure" would
   * lose the only distinction that tells an operator whether a duplicate call
   * is possible.
   */
  #record(action: string, outcome: string, startedAt: number): void {
    const metrics = this.#metrics;
    if (metrics === undefined) return;
    const seconds = (performance.now() - startedAt) / 1_000;
    metrics.outboundDuration.observe(
      { action: metrics.action(action), outcome },
      seconds,
    );
  }
}

/**
 * Whether a failed send got as far as the participant.
 *
 * `unreachable` is the **allow-list**, and that direction is deliberate. Every
 * code here describes a connection that was never established, so the request
 * provably never left this process and withdrawing the record of it is safe.
 * Anything unrecognised falls through to `uncertain`, which keeps the entry —
 * the wrong guess there costs a stuck run the model can restart, whereas the
 * wrong guess the other way is a duplicate protocol call on a real
 * participant's wire, which nothing can take back.
 */
export function classifyDelivery(
  error: unknown,
): "unreachable" | "uncertain" {
  const codes = new Set<string>();
  for (let cause: unknown = error, depth = 0; cause && depth < 5; depth++) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string") codes.add(code);
    cause = (cause as { cause?: unknown }).cause;
  }

  const unreachable = [
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
    // TLS: the handshake failed, so no request bytes were ever written.
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "ERR_TLS_CERT_ALTNAME_INVALID",
  ];

  return unreachable.some((code) => codes.has(code))
    ? "unreachable"
    : "uncertain";
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
