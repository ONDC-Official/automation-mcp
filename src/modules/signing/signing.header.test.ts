import { describe, expect, it } from "vitest";
import {
  isWithinValidity,
  parseAuthorizationHeader,
} from "@/modules/signing/signing.header.js";

const VALID =
  'Signature keyId="buyer-app.ondc.org|207|ed25519",algorithm="ed25519",' +
  'created="1641287875",expires="1641291475",' +
  'headers="(created) (expires) digest",signature="fKQWvXhln4UdyZdL87ViXQObdBme0dHnsclD2LvvnHoNxIgcvAwUZOmwAnH5QKi9Upg5tRaxpoGhCFGHD+d+Bw=="';

describe("parseAuthorizationHeader", () => {
  it("reads every part of a well-formed header", () => {
    expect(parseAuthorizationHeader(VALID)).toEqual({
      subscriberId: "buyer-app.ondc.org",
      uniqueKeyId: "207",
      created: 1641287875,
      expires: 1641291475,
      signature:
        "fKQWvXhln4UdyZdL87ViXQObdBme0dHnsclD2LvvnHoNxIgcvAwUZOmwAnH5QKi9Upg5tRaxpoGhCFGHD+d+Bw==",
    });
  });

  it("keeps the base64 padding and the + and / in the signature", () => {
    // `=` inside a quoted value is what a naive `split("=")` parser loses.
    expect(parseAuthorizationHeader(VALID)?.signature).toMatch(/\+.*\/?.*==$/);
  });

  it("tolerates spaces after the commas", () => {
    const spaced = VALID.replaceAll('",', '", ');
    expect(parseAuthorizationHeader(spaced)?.uniqueKeyId).toBe("207");
  });

  it.each([
    ["no header", undefined],
    ["an empty header", ""],
    ["a Bearer token", "Bearer abc"],
    ["no keyId", VALID.replace(/keyId="[^"]*",/, "")],
    ["a keyId with two parts", VALID.replace("|207|ed25519", "|207")],
    ["an empty subscriber id", VALID.replace("buyer-app.ondc.org|", "|")],
    ["a non-ed25519 keyId", VALID.replace("|207|ed25519", "|207|rsa")],
    [
      "algorithm disagreeing with keyId",
      VALID.replace('algorithm="ed25519"', 'algorithm="rsa"'),
    ],
    ["no created", VALID.replace(/created="[^"]*",/, "")],
    ["a non-numeric expires", VALID.replace("1641291475", "soon")],
    ["an empty signature", VALID.replace(/signature="[^"]*"/, 'signature=""')],
  ])("refuses %s", (_label, header) => {
    expect(parseAuthorizationHeader(header)).toBeUndefined();
  });
});

describe("isWithinValidity — the guide's timestamp scenarios", () => {
  const now = 1_700_000_000;
  const minute = 60;
  const hour = 3600;

  it.each([
    ["fresh header", now - 5 * minute, now + 55 * minute, true],
    ["expired header", now - 2 * hour, now - hour, false],
    ["future header", now + hour, now + 2 * hour, false],
  ])("%s", (_label, created, expires, valid) => {
    expect(isWithinValidity({ created, expires }, now)).toBe(valid);
  });

  it("zero TTL is valid only during the second it names", () => {
    // The guide marks this row "marginal". Under `created <= now <= expires`
    // with no skew tolerance it holds for exactly one second.
    expect(isWithinValidity({ created: now, expires: now }, now)).toBe(true);
    expect(isWithinValidity({ created: now, expires: now }, now + 1)).toBe(
      false,
    );
  });

  it("is inclusive at both ends", () => {
    const header = { created: now, expires: now + hour };
    expect(isWithinValidity(header, now)).toBe(true);
    expect(isWithinValidity(header, now + hour)).toBe(true);
    expect(isWithinValidity(header, now - 1)).toBe(false);
    expect(isWithinValidity(header, now + hour + 1)).toBe(false);
  });
});
