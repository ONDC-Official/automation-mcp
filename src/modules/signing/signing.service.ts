import type { Logger } from "pino";
import { verifySignature } from "@/modules/signing/signing.crypto.js";
import {
  isWithinValidity,
  parseAuthorizationHeader,
} from "@/modules/signing/signing.header.js";
import type { KeyProvider } from "@/modules/signing/signing.keys.js";

/**
 * Is this inbound call signed by the participant it claims to come from?
 *
 * Every way a signature can be wrong — missing, unparseable, expired, signed
 * by somebody else, unknown key, bad bytes — is `rejected`, and `reason` says
 * which, in words the participant is sent.
 *
 * `unavailable` is different in kind: we could not ask the registry, so we
 * cannot say. The receiver still refuses those calls when checking is on — an
 * ACK would claim a signature passed that nobody checked — but says the lookup
 * failed rather than that the signature is wrong.
 */

export type InboundVerdict =
  | { status: "valid" }
  | { status: "rejected"; reason: string }
  | { status: "unavailable"; reason: string };

export const SIGNATURE_GUIDE_URL =
  "https://dev-workbench.ondc.tech/developer-guide/auth-tools";

/** The ONDC error code for an invalid signature, as the workbench sends it. */
export const SIGNATURE_ERROR_CODE = "10001";

/**
 * Sent to the participant: which check failed, as ONIX does. The guide goes to
 * the model, which is who helps them act on it.
 */
export function signatureErrorMessage(reason: string): string {
  return `Invalid signature: ${reason}.`;
}

/** Sent when the registry gave us no key: the signature may be fine. */
export const REGISTRY_ERROR_MESSAGE =
  "Could not verify signature: the registry lookup for your keyId failed.";

/**
 * Where the model reads how signing works. The guide page is rendered in the
 * browser, so a model fetching it gets an empty shell; these are ONDC's own KB
 * documents, already in the knowledge corpus.
 */
export const SIGNING_TOPICS = [
  "28-authorization-header-creation",
  "27-digest-generation",
] as const;

/** The same, for a participant whose *verification* refused our call. */
export const VERIFICATION_TOPIC = "01-signature-verification";

/**
 * What an HTTP 401 to one of our calls means, for the model. Empty for any
 * other status.
 *
 * Signed, it is the participant's verification that refused a valid signature
 * — or our identity is not in the registry they query. Unsigned, it is ours:
 * they want a signature and this server has no identity to sign with.
 */
export function unauthorizedNote(httpStatus: number, signed: boolean): string {
  if (httpStatus !== 401) return "";
  return signed
    ? ` HTTP 401: the participant refused our signature. Our signature follows ONDC's guide (${SIGNATURE_GUIDE_URL}); ` +
        `to help them check their verification, read ${VERIFICATION_TOPIC} with protocol_search_knowledge.`
    : " HTTP 401: the participant requires a signature, and this server does not sign — it has no ONDC identity configured.";
}

export interface SigningServiceOptions {
  keys: KeyProvider;
  /** Our subscriber id, named in the `WWW-Authenticate` realm. */
  realm: string;
  logger: Logger;
}

export class SigningService {
  readonly #keys: KeyProvider;
  readonly #realm: string;
  readonly #logger: Logger;

  constructor(options: SigningServiceOptions) {
    this.#keys = options.keys;
    this.#realm = options.realm;
    this.#logger = options.logger;
  }

  /**
   * Whether this server can verify anything. Without a registry there is no
   * key to verify with, so every session has `header_validation` off.
   */
  get canVerify(): boolean {
    return this.#keys.hasSource;
  }

  /** What a 401 tells the caller about how to authenticate. */
  get challenge(): string {
    return `Signature realm="${this.#realm}",headers="(created) (expires) digest"`;
  }

  async verifyInbound(args: {
    /** The `Authorization` header as received. */
    header: string | undefined;
    /** The body exactly as received. */
    rawBody: string | undefined;
    /** `context.bap_id` or `context.bpp_id` — whoever the call says it is from. */
    claimedSubscriberId: string | undefined;
    nowSeconds?: number;
  }): Promise<InboundVerdict> {
    const verdict = await this.#verify(args);
    if (verdict.status !== "valid") {
      this.#logger.debug(
        { claimed: args.claimedSubscriberId, ...verdict },
        "inbound signature not accepted",
      );
    }
    return verdict;
  }

  async #verify(args: {
    header: string | undefined;
    rawBody: string | undefined;
    claimedSubscriberId: string | undefined;
    nowSeconds?: number;
  }): Promise<InboundVerdict> {
    const header = parseAuthorizationHeader(args.header);
    if (header === undefined) {
      return rejected("the Authorization header is missing or malformed");
    }
    if (args.rawBody === undefined) {
      return rejected("the request body could not be read");
    }
    if (!isWithinValidity(header, args.nowSeconds)) {
      return rejected("the header is expired or not yet valid");
    }
    // A valid signature only proves *some* registered participant signed the
    // call. It must be the one the payload says it is from.
    if (header.subscriberId !== args.claimedSubscriberId) {
      return rejected("the keyId's subscriber is not the payload's sender");
    }

    const key = await this.#keys.lookup(
      header.subscriberId,
      header.uniqueKeyId,
    );
    if (key.status === "unavailable") return key;
    if (key.status === "not_found") {
      return rejected("the registry has no key for this keyId");
    }

    const input = { header: args.header ?? "", body: args.rawBody };
    if (await verifySignature({ ...input, publicKey: key.publicKey })) {
      return { status: "valid" };
    }

    // A cached key may be one the participant has since rotated away from.
    // Ask the registry once more before calling a correct signer wrong.
    if (key.source === "cache") {
      const fresh = await this.#keys.lookup(
        header.subscriberId,
        header.uniqueKeyId,
        { fresh: true },
      );
      if (
        fresh.status === "found" &&
        fresh.publicKey !== key.publicKey &&
        (await verifySignature({ ...input, publicKey: fresh.publicKey }))
      ) {
        return { status: "valid" };
      }
    }
    return rejected("the signature does not verify against the registered key");
  }
}

/** Sent to the participant, so its wording is theirs to act on. */
function rejected(reason: string): InboundVerdict {
  return { status: "rejected", reason };
}
