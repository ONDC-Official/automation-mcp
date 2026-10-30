import { describe, expect, it } from "vitest";
import { InMemoryCacheStore } from "@/lib/cache/in-memory-cache-store.js";
import { logger } from "@/lib/logger.js";
import { signRequest } from "@/modules/signing/signing.crypto.js";
import type {
  LookupResult,
  RegistryGateway,
} from "@/modules/signing/signing.gateway.js";
import { KeyProvider } from "@/modules/signing/signing.keys.js";
import {
  SIGNING_TOPICS,
  SigningService,
} from "@/modules/signing/signing.service.js";
import { hasTopic } from "@/modules/protocol/protocol.knowledge.js";
import { keyPair } from "@/test/signing-keys.js";

const BODY = '{"context":{"action":"on_search"}}';

function registry(
  answers: LookupResult[],
): RegistryGateway & { calls: number } {
  const fake = {
    calls: 0,
    lookup(): Promise<LookupResult> {
      const answer = answers[Math.min(fake.calls, answers.length - 1)];
      fake.calls += 1;
      return Promise.resolve(answer ?? { status: "not_found" });
    },
  };
  return fake;
}

function service(gateway: RegistryGateway): SigningService {
  return new SigningService({
    keys: new KeyProvider({
      registry: gateway,
      cache: new InMemoryCacheStore(),
      ttlMs: 60_000,
    }),
    realm: "mock.example",
    logger,
  });
}

async function verify(signing: SigningService, seed: string) {
  const header = await signRequest({
    body: BODY,
    privateKey: seed,
    subscriberId: "np.example",
    uniqueKeyId: "k1",
  });
  return signing.verifyInbound({
    header,
    rawBody: BODY,
    claimedSubscriberId: "np.example",
  });
}

describe("SigningService — a rotated key", () => {
  it("accepts a participant that rotated after its old key was cached", async () => {
    const oldKey = keyPair();
    const newKey = keyPair();
    const gateway = registry([
      { status: "found", publicKey: oldKey.publicKey },
      { status: "found", publicKey: newKey.publicKey },
    ]);
    const signing = service(gateway);

    expect(await verify(signing, oldKey.seed)).toEqual({ status: "valid" });
    // Now signing with the new key, while the cache still holds the old one.
    expect(await verify(signing, newKey.seed)).toEqual({ status: "valid" });
    expect(gateway.calls).toBe(2);
  });

  it("rejects a bad signature at the cost of exactly one extra lookup", async () => {
    const real = keyPair();
    const gateway = registry([{ status: "found", publicKey: real.publicKey }]);
    const signing = service(gateway);
    await verify(signing, real.seed);

    expect((await verify(signing, keyPair().seed)).status).toBe("rejected");
    expect(gateway.calls).toBe(2);
  });

  it("does not refetch a key the registry just returned", async () => {
    const gateway = registry([
      { status: "found", publicKey: keyPair().publicKey },
    ]);

    expect((await verify(service(gateway), keyPair().seed)).status).toBe(
      "rejected",
    );
    expect(gateway.calls).toBe(1);
  });
});

describe("SIGNING_TOPICS", () => {
  it("names documents that exist in the knowledge corpus", () => {
    // A KB re-sync that renames one fails here, not in front of a participant.
    for (const topic of SIGNING_TOPICS) {
      expect(hasTopic(topic), topic).toBe(true);
    }
  });
});
