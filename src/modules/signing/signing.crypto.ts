import { createPrivateKey } from "node:crypto";
import {
  createAuthorizationHeader,
  isHeaderValid,
} from "ondc-crypto-sdk-nodejs";

/**
 * The crypto, delegated to ONDC's own SDK.
 *
 * We do not maintain an Ed25519 / BLAKE2b implementation. This file only calls
 * the SDK correctly: the body it hashes must be the exact bytes on the wire,
 * and the private key it signs with must be in the form it accepts.
 */

/**
 * Verify a signature over `body` — digest and Ed25519 only.
 *
 * `body` must be the request **exactly as received**, decoded as UTF-8. The SDK
 * re-encodes it with libsodium's `from_string`, which round-trips valid UTF-8
 * byte for byte; a parsed-then-restringified body would not.
 *
 * Timestamps and `keyId` are not checked here — see `signing.header.ts`.
 */
export async function verifySignature(args: {
  header: string;
  body: string;
  publicKey: string;
}): Promise<boolean> {
  return isHeaderValid(args);
}

/** Sign `body` (the exact bytes about to be sent) and return the header value. */
export async function signRequest(args: {
  body: string;
  privateKey: string;
  subscriberId: string;
  uniqueKeyId: string;
}): Promise<string> {
  return createAuthorizationHeader({
    body: args.body,
    privateKey: expandPrivateKey(args.privateKey),
    subscriberId: args.subscriberId,
    subscriberUniqueKeyId: args.uniqueKeyId,
  });
}

/** DER prefix that wraps a raw 32-byte Ed25519 seed as PKCS#8. */
const PKCS8_ED25519_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

/**
 * A private key in the 64-byte form the SDK signs with.
 *
 * ONDC keys are handed out either as the 32-byte seed or as the 64-byte
 * expanded key (seed ‖ public key), and the guide says to accept both. The
 * SDK's `signMessage` passes the key straight to libsodium's
 * `crypto_sign_detached`, which takes only the 64-byte form.
 *
 * Throws on any other length: this runs at boot and on every send, and a key
 * that cannot sign is a configuration error, not a per-call outcome.
 */
export function expandPrivateKey(privateKeyBase64: string): string {
  const raw = Buffer.from(privateKeyBase64, "base64");
  if (raw.length === 64) return privateKeyBase64;
  if (raw.length !== 32) {
    throw new Error(
      `Ed25519 private key must be 32 or 64 bytes, got ${String(raw.length)}`,
    );
  }
  // An Ed25519 private JWK carries the public key as `x`.
  const { x } = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  }).export({ format: "jwk" });
  if (x === undefined) throw new Error("could not derive Ed25519 public key");
  return Buffer.concat([raw, Buffer.from(x, "base64url")]).toString("base64");
}
