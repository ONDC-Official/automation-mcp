/**
 * Reading an ONDC `Authorization` header, and the validity checks the SDK
 * leaves to its caller.
 *
 * ## Why this file is the one with the tests
 *
 * `ondc-crypto-sdk-nodejs` does the digest and the Ed25519 verify, and answers
 * a bare boolean. Everything else that decides whether a signature is valid
 * happens here, and nothing downstream would notice it going wrong:
 *
 * - **which key to fetch** comes from `keyId`. Misread it and the registry is
 *   asked for a key that does not exist, which reads as the participant's fault.
 * - **the `created` / `expires` window** is not checked by the SDK at all —
 *   verified against 2.1.1, where a header that expired yesterday answers
 *   `true`. ONDC's guide puts the check in every one of its verify snippets
 *   (dev-workbench.ondc.tech/developer-guide/auth-tools).
 *
 * Header shape, from the guide:
 *
 * ```
 * Signature keyId="{subscriber_id}|{unique_key_id}|ed25519",algorithm="ed25519",
 *   created="{unix}",expires="{unix}",headers="(created) (expires) digest",
 *   signature="{base64}"
 * ```
 */

export interface AuthorizationHeader {
  subscriberId: string;
  uniqueKeyId: string;
  /** Unix seconds. */
  created: number;
  /** Unix seconds. */
  expires: number;
  signature: string;
}

const PARAM = /([A-Za-z]+)="([^"]*)"/g;
const UNIX_SECONDS = /^\d+$/;

/**
 * Parse an `Authorization` header, or `undefined` when it is not a usable ONDC
 * signature header. Never throws: the caller turns `undefined` into the same
 * rejection as any other invalid signature.
 */
export function parseAuthorizationHeader(
  header: string | undefined,
): AuthorizationHeader | undefined {
  if (header === undefined) return undefined;
  const trimmed = header.trim();
  if (!trimmed.startsWith("Signature ")) return undefined;

  const params = new Map<string, string>();
  for (const [, key, value] of trimmed.matchAll(PARAM)) {
    if (key !== undefined && value !== undefined) params.set(key, value);
  }

  const keyId = params.get("keyId")?.split("|");
  if (keyId?.length !== 3) return undefined;
  const [subscriberId, uniqueKeyId, keyAlgorithm] = keyId;
  if (!subscriberId || !uniqueKeyId) return undefined;
  // ONDC's verification steps: the algorithm named in `keyId` must be the one
  // the header declares, and ONDC signs with Ed25519 only.
  if (keyAlgorithm !== "ed25519" || params.get("algorithm") !== "ed25519") {
    return undefined;
  }

  const created = params.get("created");
  const expires = params.get("expires");
  const signature = params.get("signature");
  if (
    created === undefined ||
    expires === undefined ||
    !UNIX_SECONDS.test(created) ||
    !UNIX_SECONDS.test(expires) ||
    !signature
  ) {
    return undefined;
  }

  return {
    subscriberId,
    uniqueKeyId,
    created: Number(created),
    expires: Number(expires),
    signature,
  };
}

/**
 * `created <= now <= expires`, inclusive at both ends, with no skew tolerance —
 * the rule in ONDC's guide and in CLAUDE.md §4.
 */
export function isWithinValidity(
  header: Pick<AuthorizationHeader, "created" | "expires">,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  return header.created <= nowSeconds && nowSeconds <= header.expires;
}
