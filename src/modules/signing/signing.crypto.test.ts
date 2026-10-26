import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  expandPrivateKey,
  signRequest,
  verifySignature,
} from "@/modules/signing/signing.crypto.js";
import { parseAuthorizationHeader } from "@/modules/signing/signing.header.js";

/** A fresh Ed25519 pair as ONDC hands them out: base64 seed and public key. */
function keyPair(): { seed: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const { x } = publicKey.export({ format: "jwk" });
  return {
    seed: der.subarray(-32).toString("base64"),
    publicKey: Buffer.from(x ?? "", "base64url").toString("base64"),
  };
}

const keys = keyPair();
const other = keyPair();

const MINIFIED =
  '{"context":{"action":"search","bap_id":"a.example"},"message":{}}';
const FORMATTED = JSON.stringify(JSON.parse(MINIFIED), null, 2);

function sign(body: string, privateKey = keys.seed): Promise<string> {
  return signRequest({
    body,
    privateKey,
    subscriberId: "a.example",
    uniqueKeyId: "k1",
  });
}

function verify(header: string, body: string, publicKey = keys.publicKey) {
  return verifySignature({ header, body, publicKey });
}

describe("payload format — the guide's scenarios", () => {
  it.each([
    ["minified, verified as the same minified", MINIFIED, MINIFIED, true],
    ["formatted, verified as the same formatted", FORMATTED, FORMATTED, true],
    ["minified, verified as formatted", MINIFIED, FORMATTED, false],
    ["formatted, verified as minified", FORMATTED, MINIFIED, false],
    [
      "spaces, verified as tabs",
      FORMATTED,
      JSON.stringify(JSON.parse(MINIFIED), null, "\t"),
      false,
    ],
    [
      "original, verified as re-serialised",
      '{ "context": { "action": "search" } }',
      JSON.stringify(JSON.parse('{ "context": { "action": "search" } }')),
      false,
    ],
  ])("%s", async (_label, signed, received, valid) => {
    expect(await verify(await sign(signed), received)).toBe(valid);
  });
});

describe("keys — the guide's scenarios", () => {
  it("verifies with the matching public key", async () => {
    expect(await verify(await sign(MINIFIED), MINIFIED)).toBe(true);
  });

  it("rejects a different public key", async () => {
    expect(await verify(await sign(MINIFIED), MINIFIED, other.publicKey)).toBe(
      false,
    );
  });

  it("signs with a 32-byte seed and a 64-byte expanded key alike", async () => {
    const expanded = expandPrivateKey(keys.seed);
    expect(Buffer.from(expanded, "base64")).toHaveLength(64);
    expect(await verify(await sign(MINIFIED, expanded), MINIFIED)).toBe(true);
    expect(await verify(await sign(MINIFIED, keys.seed), MINIFIED)).toBe(true);
  });

  it("expands a seed to seed ‖ public key", () => {
    const expanded = Buffer.from(expandPrivateKey(keys.seed), "base64");
    expect(expanded.subarray(0, 32).toString("base64")).toBe(keys.seed);
    expect(expanded.subarray(32).toString("base64")).toBe(keys.publicKey);
  });

  it("refuses a key of any other length", () => {
    expect(() => expandPrivateKey(Buffer.alloc(16).toString("base64"))).toThrow(
      /32 or 64 bytes/,
    );
  });
});

describe("payload modification — the guide's scenarios", () => {
  const body = '{"price":100,"a":1,"b":2,"optional_field":true}';

  it.each([
    ["a value changed", body.replace("100", "200")],
    ["a key added", body.replace("}", ',"extra_field":true}')],
    ["a key removed", body.replace(',"optional_field":true', "")],
    ["key order changed", '{"price":100,"b":2,"a":1,"optional_field":true}'],
    ["a trailing newline", `${body}\n`],
  ])("rejects %s", async (_label, received) => {
    expect(await verify(await sign(body), received)).toBe(false);
  });
});

describe("common issues — the guide's table", () => {
  it("rejects a signature re-encoded as URL-safe base64", async () => {
    // Only meaningful when the signature contains `+` or `/`; try bodies until
    // one does, so the test cannot pass vacuously.
    for (let i = 0; i < 50; i += 1) {
      const body = `{"n":${String(i)}}`;
      const header = await sign(body);
      const signature = parseAuthorizationHeader(header)?.signature ?? "";
      if (!/[+/]/.test(signature)) continue;
      const urlSafe = header.replace(
        signature,
        signature.replaceAll("+", "-").replaceAll("/", "_"),
      );
      expect(await verify(urlSafe, body)).toBe(false);
      return;
    }
    throw new Error("no signature contained + or / in 50 attempts");
  });

  it("verifies a non-ASCII body byte for byte", async () => {
    const body = '{"name":"चाय ☕","city":"Bengaluru"}';
    const received = Buffer.from(body, "utf8").toString("utf8");
    expect(await verify(await sign(body), received)).toBe(true);
  });

  it("produces the guide's header shape", async () => {
    const header = await sign(MINIFIED);
    expect(header).toMatch(
      /^Signature keyId="a\.example\|k1\|ed25519",algorithm="ed25519",created="\d+",expires="\d+",headers="\(created\) \(expires\) digest",signature="[A-Za-z0-9+/]+=*"$/,
    );
    const parsed = parseAuthorizationHeader(header);
    expect(parsed && parsed.expires - parsed.created).toBe(3600);
  });
});
