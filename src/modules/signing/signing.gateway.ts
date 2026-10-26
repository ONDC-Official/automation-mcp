import { request, type Dispatcher } from "undici";
import type { Logger } from "pino";
import { z } from "zod";
import { signRequest } from "@/modules/signing/signing.crypto.js";

/**
 * Data access for the ONDC registry: one participant's signing public key.
 *
 * `POST {registry}/lookup` with `{subscriber_id, ukId}` — the request the
 * workbench's api-service makes (`headerUtils.ts#performLookup`). A v2.0 lookup
 * must itself be signed, so it carries an `Authorization` header made with our
 * own registered identity.
 *
 * ## Never throws
 *
 * Called inside the receiver's ACK window. `not_found` (the registry answered,
 * and has no such key) and `unavailable` (we got no answer) are different
 * verdicts: the first rejects the call, the second lets it through, because
 * our outage is not the participant's non-compliance.
 */

export type LookupResult =
  | { status: "found"; publicKey: string }
  | { status: "not_found" }
  | { status: "unavailable"; reason: string };

export interface RegistryGateway {
  lookup(subscriberId: string, uniqueKeyId: string): Promise<LookupResult>;
}

export interface SigningIdentity {
  subscriberId: string;
  uniqueKeyId: string;
  privateKey: string;
}

export interface HttpRegistryGatewayOptions {
  baseUrl: string;
  identity: SigningIdentity;
  timeoutMs: number;
  logger: Logger;
  dispatcher?: Dispatcher | undefined;
}

/** Only what we read; everything else the registry returns is ignored. */
const LookupResponse = z.array(
  z.object({
    signing_public_key: z.string().min(1),
    ukId: z.string().optional(),
  }),
);

export class HttpRegistryGateway implements RegistryGateway {
  readonly #url: string;
  readonly #identity: SigningIdentity;
  readonly #timeoutMs: number;
  readonly #logger: Logger;
  readonly #dispatcher: Dispatcher | undefined;

  constructor(options: HttpRegistryGatewayOptions) {
    this.#url = `${options.baseUrl.replace(/\/+$/, "")}/lookup`;
    this.#identity = options.identity;
    this.#timeoutMs = options.timeoutMs;
    this.#logger = options.logger;
    this.#dispatcher = options.dispatcher;
  }

  async lookup(
    subscriberId: string,
    uniqueKeyId: string,
  ): Promise<LookupResult> {
    const body = JSON.stringify({
      subscriber_id: subscriberId,
      ukId: uniqueKeyId,
    });

    let response: Dispatcher.ResponseData;
    try {
      const authorization = await signRequest({
        body,
        privateKey: this.#identity.privateKey,
        subscriberId: this.#identity.subscriberId,
        uniqueKeyId: this.#identity.uniqueKeyId,
      });
      response = await request(this.#url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization,
        },
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
        ...(this.#dispatcher ? { dispatcher: this.#dispatcher } : {}),
      });
    } catch (error) {
      this.#logger.warn({ err: error, url: this.#url }, "registry unreachable");
      return unavailable(`registry unreachable: ${messageOf(error)}`);
    }

    let text: string;
    try {
      text = await response.body.text();
    } catch (error) {
      return unavailable(
        `registry sent an unreadable body: ${messageOf(error)}`,
      );
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      // A 401 here means *our* identity was refused, never the participant's.
      this.#logger.warn(
        { url: this.#url, status: response.statusCode },
        "registry lookup refused",
      );
      return unavailable(`registry answered ${String(response.statusCode)}`);
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return unavailable("registry answered with a non-JSON body");
    }
    const parsed = LookupResponse.safeParse(json);
    if (!parsed.success) {
      return unavailable("registry answered in an unexpected shape");
    }

    // The registry is asked for one ukId; prefer the entry that names it.
    const entry =
      parsed.data.find((row) => row.ukId === uniqueKeyId) ?? parsed.data[0];
    return entry === undefined
      ? { status: "not_found" }
      : { status: "found", publicKey: entry.signing_public_key };
  }
}

function unavailable(reason: string): LookupResult {
  return { status: "unavailable", reason };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
