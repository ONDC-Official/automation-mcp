import { request, type Dispatcher } from "undici";
import type { Logger } from "pino";
import { parseValidationMessage } from "@/modules/validate/validate.parse.js";
import {
  UpstreamValidationResponse,
  type ValidationFinding,
} from "@/modules/validate/validate.schema.js";

/**
 * Data access for the protocol validation oracle.
 *
 * The repository slot of the `validate` module; a *gateway* because the store it
 * reads is a remote HTTP service, following `catalog.gateway.ts`. It knows how
 * to ask and how to read the answer. It holds no policy: whether a failure
 * blocks a send or NACKs a callback is `validate.service.ts`'s business.
 *
 * ## What is on the other end
 *
 * `POST {base}/{domain}/{version}/test/{action}` is ONIX's `standaloneValidator`
 * adapter module, whose step list is exactly `[validateSchema,
 * validateOndcPayload]` — L0 then L1, the same plugins and the same compiled
 * `x-validations` the transaction paths use. It has **no side effects**: no
 * `addRoute` step so nothing is proxied onward, no `cache` plugin so nothing is
 * written, and no middleware so no session, transaction or audit record is
 * created. Calling it is free of consequences for the participant under test,
 * which is what makes it usable as an oracle at all.
 *
 * ## Never throws
 *
 * Every failure becomes `unavailable`. This is called from inside the receiver's
 * ACK window, where an exception would answer a participant 500 and be recorded
 * as our non-compliance — and from the outbound gate, where it would strand a
 * run. The distinction that matters is `invalid` (we asked, and the payload is
 * bad) versus `unavailable` (we did not get an answer); collapsing the second
 * into either of the others is the one mistake this file must not make.
 */

const SERVICE = "validation-service";

/** One payload, judged against one build. */
export interface ValidationRequest {
  domain: string;
  version: string;
  /** The action to judge as — decides which schema and rule set applies. */
  action: string;
  payload: unknown;
}

export type GatewayResult =
  | { status: "valid" }
  | { status: "invalid"; findings: ValidationFinding[]; docsUrl?: string }
  /** No verdict was reached. **Not** a synonym for `valid`. */
  | { status: "unavailable"; reason: string };

export interface ValidationGateway {
  /** L0 + L1 for one payload. Never throws. */
  validate(request: ValidationRequest): Promise<GatewayResult>;
  /** Dependency probe surfaced through `/ready`. */
  ping(): Promise<boolean>;
}

export interface HttpValidationGatewayOptions {
  baseUrl: string;
  timeoutMs: number;
  logger: Logger;
  /** Shared undici Agent from the container — worth ~80ms per call. */
  dispatcher?: Dispatcher | undefined;
}

/**
 * Path segments we will put in a URL.
 *
 * A domain is `ONDC:TRV11` — the colon is legal in a path segment and must stay
 * literal, because percent-encoding it produces a 404 against Go's mux. So
 * rather than encode, this refuses anything outside the shape a build reference
 * actually takes, which also closes the traversal that building a path by
 * concatenation would otherwise open.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9:._-]+$/;

export class HttpValidationGateway implements ValidationGateway {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #logger: Logger;
  readonly #dispatcher: Dispatcher | undefined;

  constructor(options: HttpValidationGatewayOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs;
    this.#logger = options.logger;
    this.#dispatcher = options.dispatcher;
  }

  async validate(input: ValidationRequest): Promise<GatewayResult> {
    const guard = this.#guard(input);
    if (guard !== undefined) return guard;

    const url =
      `${this.#baseUrl}/${input.domain}/${input.version}/test/${input.action}`;

    let body: string;
    try {
      body = JSON.stringify(input.payload);
    } catch (error) {
      // A payload with a cycle or a BigInt cannot go on the wire either, but
      // that is the sender's bug to see, not a protocol verdict.
      return unavailable(
        `the payload could not be serialised: ${messageOf(error)}`,
      );
    }

    let response: Dispatcher.ResponseData;
    try {
      response = await request(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          // No cookie header, and this is load-bearing rather than incidental:
          // ONIX reads a `protocol_validation` cookie and the literal value
          // "false" makes it skip L1 entirely and answer ACK. A false negative
          // from an oracle is worse than no oracle.
        },
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
        ...(this.#dispatcher ? { dispatcher: this.#dispatcher } : {}),
      });
    } catch (error) {
      // Timeout, DNS, refused, TLS. The participant is not at fault for any of
      // these, so the answer must not look like a verdict about their payload.
      this.#logger.warn({ err: error, url }, "validation oracle unreachable");
      return unavailable(`${SERVICE} was unreachable: ${messageOf(error)}`);
    }

    return this.#read(response, url, input);
  }

  async ping(): Promise<boolean> {
    // No health route on the api-service, so liveness is inferred from the mux
    // answering at all. A 404 still proves the service is up — it is the *build*
    // that is unknown — which is exactly the distinction `/ready` wants.
    try {
      const response = await request(this.#baseUrl, {
        method: "GET",
        signal: AbortSignal.timeout(this.#timeoutMs),
        ...(this.#dispatcher ? { dispatcher: this.#dispatcher } : {}),
      });
      await response.body.dump();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * What we refuse to ask.
   *
   * `context.transaction_id` is the one that matters: without it the oracle
   * answers **500** with `Internal server error, MessageID: %!s(<nil>)`, because
   * its L1 stage dereferences the id while building its internal payload and the
   * resulting failure is not one of ONIX's typed errors. Discovering that by
   * calling out would cost a round trip to learn nothing, and the 500 says
   * nothing about protocol validity.
   */
  #guard(input: ValidationRequest): GatewayResult | undefined {
    for (const [name, value] of [
      ["domain", input.domain],
      ["version", input.version],
      ["action", input.action],
    ] as const) {
      if (!SAFE_SEGMENT.test(value)) {
        return unavailable(
          `"${value}" is not a usable ${name} for the validation endpoint`,
        );
      }
    }

    const context = readContext(input.payload);
    const transactionId = context["transaction_id"];
    if (typeof transactionId !== "string" || transactionId === "") {
      return unavailable(
        "the payload has no context.transaction_id, which the oracle requires " +
          "before it will validate anything",
      );
    }

    return undefined;
  }

  async #read(
    response: Dispatcher.ResponseData,
    url: string,
    input: ValidationRequest,
  ): Promise<GatewayResult> {
    const status = response.statusCode;

    let text: string;
    try {
      text = await response.body.text();
    } catch (error) {
      return unavailable(`${SERVICE} sent an unreadable body: ${messageOf(error)}`);
    }

    // The build is not served by this instance — domain and version are baked
    // into each api-service at build time. Not a verdict, and the body is not
    // even JSON ("api route not configured").
    if (status === 404) {
      this.#logger.warn(
        { url, domain: input.domain, version: input.version },
        "validation oracle does not serve this build",
      );
      return unavailable(
        `${SERVICE} does not serve ${input.domain}/${input.version} ` +
          `(or has no "${input.action}" endpoint)`,
      );
    }

    if (status === 413) {
      return unavailable(`the payload was too large for ${SERVICE}`);
    }

    const parsed = parseJson(text);
    if (parsed === undefined) {
      return unavailable(
        `${SERVICE} answered ${String(status)} with a non-JSON body`,
      );
    }

    const envelope = UpstreamValidationResponse.safeParse(parsed);
    if (!envelope.success) {
      return unavailable(
        `${SERVICE} answered ${String(status)} in an unexpected shape`,
      );
    }

    const { message, error } = envelope.data;
    const ack = message?.ack?.status;

    // The missing-transaction_id artifact, and anything else that faulted. The
    // guard above should make this unreachable; it is checked anyway because a
    // 500 read as `invalid` would be a finding against a blameless participant.
    if (status >= 500 || error?.code === "Internal Server Error") {
      this.#logger.warn(
        { url, status, detail: error?.message },
        "validation oracle faulted",
      );
      return unavailable(
        `${SERVICE} answered ${String(status)}: ${error?.message ?? "no detail"}`,
      );
    }

    if (ack === "ACK") return { status: "valid" };

    // Everything left is a rejection: 200 NACK (a layer rejected it) or 400
    // (unparseable JSON, no context.domain, no schema for this action and
    // version). Both are defects in the payload, so both are `invalid` — the
    // difference is only which stage noticed.
    const raw = error?.message ?? "";
    const { findings, docsUrl } = parseValidationMessage(raw);

    return {
      status: "invalid",
      findings,
      ...(docsUrl !== undefined ? { docsUrl } : {}),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

function unavailable(reason: string): GatewayResult {
  return { status: "unavailable", reason };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function readContext(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null) return {};
  const context = (payload as { context?: unknown }).context;
  if (typeof context !== "object" || context === null) return {};
  return context as Record<string, unknown>;
}
