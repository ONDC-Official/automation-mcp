import { generateKeyPairSync } from "node:crypto";

/** A fresh Ed25519 pair as ONDC hands them out: base64 seed and public key. */
export function keyPair(): { seed: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const { x } = publicKey.export({ format: "jwk" });
  return {
    seed: der.subarray(-32).toString("base64"),
    publicKey: Buffer.from(x ?? "", "base64url").toString("base64"),
  };
}
