import {
  expandPrivateKey,
  signRequest,
} from "@/modules/signing/signing.crypto.js";
import type { SigningIdentity } from "@/modules/signing/signing.gateway.js";
import type { RequestSigner } from "@/modules/transport/sender.service.js";

/**
 * Signs every call this mock sends, with our registered identity.
 *
 * `SenderService` serialises the payload once and hands this the exact bytes
 * it is about to send, so the signature cannot drift from what goes on the
 * wire. A participant verifies it by looking our `keyId` up in the registry —
 * which is also how it tests its own verification against a real signed call.
 */
export class SdkRequestSigner implements RequestSigner {
  readonly #identity: SigningIdentity;

  constructor(identity: SigningIdentity) {
    // Expanded once, here: it is the same key on every send.
    this.#identity = {
      ...identity,
      privateKey: expandPrivateKey(identity.privateKey),
    };
  }

  sign(bodyBytes: string): Promise<string> {
    return signRequest({
      body: bodyBytes,
      privateKey: this.#identity.privateKey,
      subscriberId: this.#identity.subscriberId,
      uniqueKeyId: this.#identity.uniqueKeyId,
    });
  }
}
