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
 * One answer, no diagnosis. Every way a signature can be wrong — missing,
 * unparseable, expired, signed by somebody else, unknown key, bad bytes — is
 * the same `rejected`, and the participant is pointed at ONDC's guide rather
 * than told which. `reason` exists for our own logs only.
 *
 * `unavailable` is different in kind: we could not ask the registry, so we
 * cannot say. The receiver lets those calls through, because our outage is not
 * the participant's non-compliance.
 */

export type InboundVerdict =
  | { status: "valid" }
  | { status: "rejected"; reason: string }
  | { status: "unavailable"; reason: string };

export const SIGNATURE_GUIDE_URL =
  "https://dev-workbench.ondc.tech/developer-guide/auth-tools";

/** The ONDC error code for an invalid signature, as the workbench sends it. */
export const SIGNATURE_ERROR_CODE = "10001";

export const SIGNATURE_ERROR_MESSAGE = `Invalid signature. See ${SIGNATURE_GUIDE_URL} for how to sign a request.`;

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
    if (header === undefined) return rejected("missing or unparseable header");
    if (args.rawBody === undefined) return rejected("no raw body to verify");
    if (!isWithinValidity(header, args.nowSeconds)) {
      return rejected("outside created/expires");
    }
    // A valid signature only proves *some* registered participant signed the
    // call. It must be the one the payload says it is from.
    if (header.subscriberId !== args.claimedSubscriberId) {
      return rejected("keyId subscriber is not the payload's sender");
    }

    const key = await this.#keys.lookup(
      header.subscriberId,
      header.uniqueKeyId,
    );
    if (key.status === "unavailable") return key;
    if (key.status === "not_found") return rejected("no key for keyId");

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
    return rejected("signature does not verify");
  }
}

function rejected(reason: string): InboundVerdict {
  return { status: "rejected", reason };
}
