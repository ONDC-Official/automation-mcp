/**
 * The published ONDC knowledge base — GENERATED, DO NOT EDIT BY HAND.
 *
 * Regenerate with `npm run kb:sync`. The source of truth is
 * ONDC-Official/automation-kb-studio (`kb-docs`), vendored at the commit stamped below.
 *
 * ## Why this is bundled, and why it is vendored rather than fetched
 *
 * The rule that the live config-service is the single source of truth exists
 * because build specs drift and a stale copy is worse than none. These are not
 * build specs: they are network-wide protocol knowledge that no endpoint this
 * server talks to publishes, and the alternative is that a model drives a whole
 * transaction and learns none of it.
 *
 * It is vendored at a pinned commit rather than fetched at runtime so that a
 * content change arrives as a reviewable diff, and so that the knowledge tools
 * do not go dark when a host we do not own is unreachable. Every answer carries
 * `KB_AS_OF` so a reader can weigh its age.
 *
 * ## Why it is TypeScript rather than the markdown files themselves
 *
 * The runtime image copies only `dist/`, and `tsc` emits `.js` from `.ts` —
 * nothing else. A corpus of `.md` files read from disk would work under
 * `npm run dev` and `vitest`, and silently find nothing in the container.
 */

import type { KnowledgeDoc } from "@/modules/protocol/protocol.knowledge-corpus.js";

/** The commit these documents were taken from. */
export const KB_SOURCE = {
  repo: "ONDC-Official/automation-kb-studio",
  sha: "3136a6037b1280f9a4401995d1550ed3e1a1c9dc",
  path: "kb-docs",
} as const;

/** When `npm run kb:sync` last pulled them. */
export const KB_AS_OF = "2026-09-15";

export const KB_KNOWLEDGE: readonly KnowledgeDoc[] = [
  {
    id: "01-signature-verification",
    title: "Signature Verification",
    tier: "kb",
    category: "Security & Auth",
    status: "source-confirmed",
    sources: [
      "ONDC developer-docs `registry/signing-verification.md`",
      "ONDC `ondc-crypto-sdk-go` (code-confirmed byte-exact digest + signing-string spacing discrepancy)",
    ],
    see_also: [
      "03-lookup",
      "05-gateway-interaction",
      "26-key-generation",
      "27-digest-generation",
      "28-authorization-header-creation",
      "29-registry-caching",
      "30-key-rotation",
    ],
    body: `## Objective

Explain how a receiving Network Participant (NP) **verifies the authenticity of an inbound request** on the ONDC network — the exact steps, the header it parses, the string it reconstructs, and when it must reject. Does NOT cover how the sender builds the signature (see \`28-authorization-header-creation\`) or key generation (see \`26\`).

## Prerequisite

- The request carries an \`Authorization\` header (and an \`X-Gateway-Authorization\` header when routed via the Beckn Gateway).
- The receiver can reach the registry \`/v2.0/lookup\` (see \`03\`) or a valid public-key cache (see \`29\`).
- Signing keys are **Ed25519**; the digest is **BLAKE-512** over the request body.

## Deliverable

A receiver-side verification path that returns **ACK** on a valid signature and **NACK (Unauthorised)** on any failure, applied to the originator header and — on gateway-routed calls — the gateway header too.

## Guideline (verification steps — from the ONDC spec)

1. **Extract \`keyId\`** from the \`Authorization\` (or \`X-Gateway-Authorization\`) header.
2. **Split \`keyId\`** on the pipe \`|\` → \`subscriber_id\`, \`unique_key_id\`, \`algorithm\`.
3. **Algorithm check** — if the split algorithm ≠ the header's \`algorithm\` param → **NACK** (enforced by the receiver).
4. **Fetch the public key** — query the registry \`/v2.0/lookup\` by \`subscriber_id\` + \`unique_key_id\`, or use the cache. No valid key → **NACK Unauthorised**.
5. **Reconstruct the signing string** from the header's \`created\` / \`expires\` and the recomputed body \`digest\`.
6. **Verify** the base64-decoded **Ed25519** signature against the reconstructed signing string.
7. **Validity window** — reject if \`created\` is in the future or \`expires\` is in the past (see rules below).
8. **Gateway-routed** — repeat 1–7 for \`X-Gateway-Authorization\`; **both** must pass.

## The Authorization header (what you parse)

\`\`\`
Signature keyId="buyer-app.ondc.org|207|ed25519",algorithm="ed25519",created="1641287875",expires="1641291475",headers="(created) (expires) digest",signature="fKQWvXhln4UdyZdL87ViXQObdBme0dHnsclD2LvvnHoNxIgcvAwUZOmwAnH5QKi9Upg5tRaxpoGhCFGHD+d+Bw=="
\`\`\`

- **\`keyId\`** = \`{subscriber_id}|{unique_key_id}|{algorithm}\` → e.g. \`buyer-app.ondc.org\` · \`207\` · \`ed25519\`. The \`unique_key_id\` lets one domain run multiple subscriber types / multiple registered keys (see \`30\`).
- **\`created\` / \`expires\`** = Unix timestamps. **\`headers\`** = \`"(created) (expires) digest"\` (spaces between the three, single-space) — this spaced form is the authoritative byte form (see nuances). **\`signature\`** = base64 Ed25519.

## The signing string (what you reconstruct)

Three \`\\n\`-separated lines, byte-exact:

\`\`\`
(created): 1641287875
(expires): 1641291475
digest: BLAKE-512=b6lf6lRgOweajukcvcLsagQ2T60+85kRh/Rd2bdS+TG/5ALebOEgDJfyCrre/1+BMu5nA94o4DT3pTFXuUg7sw==
\`\`\`

The **\`digest\`** is **BLAKE-512 over the complete JSON request body**, base64-encoded. Example: the body

\`\`\`json
{"context":{"domain":"nic2004:60212","country":"IND","city":"Kochi","action":"search",...},
 "message":{"intent":{"fulfillment":{"start":{"location":{"gps":"10.108768, 76.347517"}}, ...}}}}
\`\`\`

hashes to the \`BLAKE-512=b6lf6lRg…7sw==\` digest above. Recompute it over the **received** bytes and compare — see \`27\` for the byte-exact rule.

## Validity window (exact rules)

- A signature whose **\`created\` is in the past MUST be processed** → reject only if \`created\` is in the **future**.
- A signature whose **\`expires\` is in the future MUST be processed** → reject only if \`expires\` is in the **past** (expired).
- The spec defines **no absolute drift / clock-skew tolerance** (so no separate open question on skew).

## Gateway-routed requests (two signatures)

1. NP1 builds \`Authorization\` and sends to the **BG**.
2. BG **verifies** NP1's \`Authorization\`.
3. BG builds its own **\`X-Gateway-Authorization\`** with the BG private key.
4. BG **forwards** to NP2 carrying **both** headers.
5. NP2 **verifies both** — same algorithm, identical header format, different signer (see \`05\`).

## Failure → response

| Failure | Response |
|---|---|
| keyId/algorithm mismatch | NACK Unauthorised |
| No public key found | NACK Unauthorised |
| Signature does not verify | NACK Unauthorised |
| \`created\` in the future / \`expires\` in the past | NACK (invalid window) |

> The spec mandates a **NACK with Unauthorised** on failure but does **not** define the exact error JSON payload/HTTP mapping.

## Protocol nuances (why this is ONDC-peculiar)

- **Digest is byte-exact over the payload as-passed** — no canonicalization before hashing; re-serializing breaks it (see \`27\`).
- **Two signatures on gateway hops** — verify both \`Authorization\` and \`X-Gateway-Authorization\` independently.
- **Signing-string spacing — use the spaced form.** Production verifiers accept the **spaced** byte form: signing string \`(created): <ts>\\n(expires): <ts>\\ndigest: BLAKE-512=<b64>\` and \`headers="(created) (expires) digest"\` (single spaces). The older no-space registry-doc form (\` (created)(expires)digest\`) is wrong. A byte difference here fails an otherwise-valid signature (see \`28\`).

## Sources

- ONDC developer-docs \`registry/signing-verification.md\`
- ONDC \`ondc-crypto-sdk-go\` (code-confirmed byte-exact digest + signing-string spacing discrepancy)`,
  },
  {
    id: "02-onboarding-subscribe",
    title: "NP Onboarding (Subscribe v1.1)",
    tier: "kb",
    category: "Registry & Subscription",
    status: "source-confirmed",
    sources: [
      "ONDC developer-docs `registry/Onboarding of Participants.md`",
      "ONDC developer-docs `registry/encryption_and_decryption.md` (DH + AES-256-GCM scheme)",
      "ONDC developer-docs `registry/api_payload_encryption.md`",
      "ONDC-Registry-Specifications",
    ],
    see_also: [
      "01-signature-verification",
      "03-lookup",
      "09-payload-encryption-fis",
    ],
    body: `## Objective

Explain how a Network Participant onboards onto ONDC and publishes its cryptographic credentials — the **Subscribe v1.1** process. **Subscribe v1.0 is deprecated; v1.1 is the active version.** Onboarding is portal-driven: keys are generated in the NP Portal and domain ownership is proven via **DNS** (Production only). Covers the challenge (encrypt/decrypt of \`ondc-challenge\`) as one step of this flow. Does NOT cover request signing (see \`01-signature-verification\`) or key resolution at runtime (see \`03-lookup\`).

## Prerequisite

- A valid **FQDN** to use as \`subscriber_id\`.
- A valid **SSL certificate** (for OCSP validation).
- Registration on the **Network Participant Portal** with an **Environment Access Request** to whitelist the \`subscriber_id\`.
- Key pairs generated **in the portal**: signing **Ed25519**, encryption **X25519 (ASN.1 DER)**.

## Deliverable

A registered NP whose public keys are discoverable in the registry, allowing it to transact and to be verified by counterparties.

## Guideline (Subscribe v1.1 flow)

1. **Portal onboarding** — register on the NP Portal, raise an Environment Access Request to whitelist the \`subscriber_id\`, and generate the Ed25519 + X25519 key pairs.
2. **Request ID** — the portal generates a **\`request_id\`** (UUID v4), the reference identifier for the subscription.
3. **DNS TXT verification — Production only.** Publish two records at the base-domain root:
   - **\`ondc-signature\`** = the \`request_id\` signed with the Ed25519 signing private key (without hashing).
   - **\`ondc-challenge\`** = the \`request_id\` encrypted with the NP's X25519 encryption private key + ONDC's public key (see Crypto detail below).
4. **Subscribe** — POST \`/v1.1/subscribe\` with \`request_id\`, \`entity\` (GST/PAN/contact), \`key_pair\` (public keys + validity), and \`network_participant\` (\`subscriber_url\`, \`domain\`, \`type\`).
5. **Registry validation** — schema, SSL OCSP, and (Production) DNS TXT check + **ONDC decrypts \`ondc-challenge\`** to confirm the NP holds the registered encryption key.

## Crypto detail (per registry encryption docs)

- **Shared key** — X25519 **Diffie-Hellman** between the NP's encryption **private** key and **ONDC's public** key (keys base64 / DER).
- **Cipher** — **AES-256-GCM** with a random **12-byte IV/nonce** and a **16-byte auth tag** (authenticated encryption).
- **Encoding** — the challenge value is **base64** (\`iv + ciphertext + authTag\`); the decrypted \`request_id\` is UTF-8.
- This is the same DH + AES-256-GCM scheme used for API payload encryption (see \`09-payload-encryption-fis\`); onboarding applies it to the \`request_id\` challenge.

## Environment difference (important)

- **Production** — the challenge is mandatory: the DNS TXT records (\`ondc-signature\` + \`ondc-challenge\`) must be published and are validated.
- **Pre-Prod** — **no DNS TXT records needed**; the **portal journey alone is enough** for a direct subscription. There is no challenge step to satisfy here.

## Protocol nuances (why this is ONDC-peculiar)

- **v1.1 changes vs v1.0:** DNS TXT validation replaces the old HTML site-verification; the \`/on_subscribe\` challenge-callback is gone (decryption is now ONDC-side); \`ops_no\` is deprecated (role is derived from \`type\`); the subscription schema is simplified.
- **Decryption is ONDC-side.** The NP only **encrypts** \`request_id\` into \`ondc-challenge\`; ONDC **decrypts** it to verify. The NP no longer hosts an endpoint to decrypt a pushed challenge.
- **Two different keys, easy to swap.** \`ondc-signature\` uses **Ed25519**; \`ondc-challenge\` uses **X25519**. Mixing them fails.
- **The ONDC public key is environment-specific** — using the wrong environment's key yields a wrong shared key and a failed challenge.

## Failure → effect

| Error | Meaning | Action |
|---|---|---|
| 137 | TXT record not found (Prod) | Verify \`ondc-signature\` and \`ondc-challenge\` TXT records are published |
| 123 | OCSP validation failed | Confirm SSL certificate validity/expiry |
| 135 / 136 | Signature or decryption failed | Ensure the keys in the request match those used to generate the DNS records |

## Sources

- ONDC developer-docs \`registry/Onboarding of Participants.md\`
- ONDC developer-docs \`registry/encryption_and_decryption.md\` (DH + AES-256-GCM scheme)
- ONDC developer-docs \`registry/api_payload_encryption.md\`
- ONDC-Registry-Specifications`,
  },
  {
    id: "03-lookup",
    title: "Lookup (Registry /v2.0/lookup)",
    tier: "kb",
    category: "Security & Auth",
    status: "source-confirmed",
    sources: [
      "ONDC developer-docs `registry/Onboarding of Participants.md` (point 13 — lookup 2.0 recommended; `/lookup` and `/vlookup` deprecated)",
      "ONDC developer-docs `registry/signing-verification.md`; ONDC-Registry-Specifications",
      "ONDC Registry Onboarding 2.1.0 API (SwaggerHub) — field-level request/response schema",
      "ONDC-Official profile README — Gateway and Registry Endpoints (environment URLs)",
    ],
    see_also: ["01-signature-verification", "02-onboarding-subscribe"],
    body: `## Objective

Explain how an NP **resolves another NP's current public key** from the registry so it can verify a signature. Covers the current **lookup 2.0** (\`/v2.0/lookup\`), its request/response, and when caching applies. Does NOT cover the onboarding flow (see \`02-onboarding-subscribe\`) or the signature math (see \`01-signature-verification\`).

## Prerequisite

- A \`keyId\` from an inbound header, split into \`subscriber_id\` + \`unique_key_id\` + \`algorithm\`.
- The NP's own Ed25519 signing credentials (lookup 2.0 requires a signed request — see below).
- Registry reachability for the target environment (Pre-Prod / Prod).

## Deliverable

The verifying NP obtains the correct Ed25519 public key for \`subscriber_id + unique_key_id\` to feed into verification.

## Current version: lookup 2.0

\`/v2.0/lookup\` is the **current, recommended** endpoint. \`/lookup\` and \`/vlookup\` are both **deprecated** and should not be used for new implementations.

- **Secure by Authorization header.** lookup 2.0 authenticates via a standard **Authorization header** with an Ed25519 signature (e.g. \`keyId="example-bap.com|bap1234|ed25519", algorithm="ed25519"\`), rather than the embedded request-body signature the old \`/vlookup\` required.
- It supersedes both older endpoints — the signed-response mechanism of \`/vlookup\` and the basic \`/lookup\` are folded into this one secure, header-authenticated call.

## Request & response

**Request** — \`POST /v2.0/lookup\` with a **signed Authorization header** (Ed25519, same format as any request):

\`\`\`
POST https://prod.registry.ondc.org/v2.0/lookup
Authorization: Signature keyId="example-bap.com|bap1234|ed25519",algorithm="ed25519",
  created="…",expires="…",headers="(created)(expires)digest",signature="…"
Content-Type: application/json

{ "country": "IND", "domain": "ONDC:RET10" }
\`\`\`

**Searchable/filter fields** in the body — the request is a filter over: \`subscriber_id\`, \`unique_key_id\` (ukId), \`domain\`, \`type\` (BAP | BPP | BG), \`country\`, \`city\`. **At least two of these must be sent** (e.g. \`country\` + \`domain\`, as in the example). To resolve one specific key for verification, filter by **\`subscriber_id\` + \`unique_key_id\`**.

**Response** — an **array of matching subscriber records**; each record carries the fields the registry stores per NP:

- \`subscriber_id\` (FQDN), \`subscriber_url\`
- \`type\` (BAP | BPP | BG), \`domain\`, \`city\`, \`country\`
- \`signing_public_key\` (Ed25519), \`encr_public_key\` (X25519)
- \`unique_key_id\` (ukId)
- \`valid_from\`, \`valid_until\` (key validity window)
- \`status\` (e.g. SUBSCRIBED)

> The exact field-level JSON schema is published in the **ONDC Registry Onboarding 2.1.0** API (SwaggerHub) / ONDC-Registry-Specifications — the field list above matches the registry's stored subscriber record.

## Guideline (lookup path)

1. From the inbound header's \`keyId\`, take \`subscriber_id\` and \`unique_key_id\`.
2. Query the registry \`/v2.0/lookup\` (or the cache) for that pair, signing the request with your own Ed25519 credentials in the Authorization header.
3. Use the returned public key in \`verify-request\`.
4. On verification failure, **re-fetch** (the key may have rotated) rather than trusting a stale cache entry.

## Protocol nuances (why this is ONDC-peculiar)

- **Keyed by \`subscriber_id + unique_key_id\`, not just subscriber.** An NP can have multiple registered keys (for rotation); the \`unique_key_id\` selects the right one.
- **The lookup call is itself authenticated.** lookup 2.0 requires a signed Authorization header — resolving a key is a signed request, not an anonymous GET.
- **At least two filter parameters are required** — a single-field lookup is rejected; combine two or more of subscriber_id / ukId / domain / type / country / city.
- **Environment-specific endpoints** — two live environments, each with its own registry host, both using the standard \`/v2.0/lookup\` path (no \`/ondc/\` prefix):
  - Pre-Prod: \`https://preprod.registry.ondc.org/v2.0/lookup\`
  - Production: \`https://prod.registry.ondc.org/v2.0/lookup\`
  - (Staging is **deprecated** — only Pre-Prod and Prod are in use.)
- **Cache, but invalidate on failure.** Caching public keys avoids a lookup per request; a verification failure is the signal to invalidate and re-fetch (rotation).

## Sources

- ONDC developer-docs \`registry/Onboarding of Participants.md\` (point 13 — lookup 2.0 recommended; \`/lookup\` and \`/vlookup\` deprecated)
- ONDC developer-docs \`registry/signing-verification.md\`; ONDC-Registry-Specifications
- ONDC Registry Onboarding 2.1.0 API (SwaggerHub) — field-level request/response schema
- ONDC-Official profile README — Gateway and Registry Endpoints (environment URLs)`,
  },
  {
    id: "04-registry-interaction",
    title: "Registry Interaction",
    tier: "kb",
    category: "Registry & Subscription",
    status: "source-confirmed",
    sources: [
      "ONDC developer-docs `registry/Onboarding of Participants.md`",
      "ONDC developer-docs `registry/signing-verification.md`; ONDC-Registry-Specifications",
    ],
    see_also: [
      "01-signature-verification",
      "02-onboarding-subscribe",
      "03-lookup",
    ],
    body: `## Objective

Explain the registry as the network's **trust & identity anchor** and the interactions an NP has with it — onboarding via the NP Portal (Subscribe **v1.1**), \`/v1.1/subscribe\`, lookup, vlookup. Frames "when and why an NP talks to the registry" from a protocol lens. Does NOT re-explain the signature algorithm (see \`01\`), the challenge decrypt (see \`02-onboarding-subscribe\`), or the lookup key-resolution detail (see \`03-lookup\`).

## Prerequisite

- Registration on the **NP Portal** with an **Environment Access Request** to whitelist the \`subscriber_id\` (FQDN).
- Ed25519 signing + X25519 encryption key pairs generated **in the portal**.
- A valid SSL certificate (for OCSP validation).

## Deliverable

An NP that is registered (public keys discoverable) and can resolve any counterparty's keys at verification time.

## The registry, in one line

ONDC-operated **"DNS + public-key directory"** — NPs never build it; they register into it and query it. It is the single source of truth for who is on the network and what their keys are.

## What the registry stores per NP

\`subscriber_id\` (FQDN) · \`subscriber_url\` · \`signing_public_key\` (Ed25519) · \`encr_public_key\` (X25519) · \`unique_key_id\` · \`type\` (BAP | BPP | BG) · \`domain\` · \`status\` · \`city\`.

## Guideline (the interactions)

1. **Portal onboarding** — register on the NP Portal, raise an Environment Access Request to whitelist the \`subscriber_id\`, and generate the key pairs. The portal issues a **\`request_id\`** (UUID v4).
2. **DNS verification (Production only)** — publish \`ondc-signature\` (Ed25519-signed \`request_id\`) and \`ondc-challenge\` (encrypted \`request_id\`) as **DNS TXT records** at the domain root. Pre-Prod skips this.
3. **\`/v1.1/subscribe\`** — POST \`request_id\`, \`entity\`, \`key_pair\`, \`network_participant\` to register keys + metadata. Triggers registry validation (schema, SSL OCSP, DNS TXT check + challenge decrypt in Production).
4. **\`/v2.0/lookup\`** (lookup 2.0) — resolve a counterparty's public key at verification time, via a signed Authorization header. \`/lookup\` and \`/vlookup\` are deprecated. See \`03-lookup\`.

## Protocol nuances (why this is ONDC-peculiar)

- **Onboarding moved to the portal (v1.1).** Keys are generated in the NP Portal and domain ownership is proven via **DNS TXT records**, replacing the older HTML site-verification and the \`/on_subscribe\` challenge-callback (deprecated).
- **DNS validation is Production-only.** Pre-Prod supports direct subscription without DNS records.
- **Two live environments** — Pre-Prod and Prod, each with its own registry host (\`preprod.registry.ondc.org\`, \`prod.registry.ondc.org\`), both using the standard \`/v2.0/lookup\` path (no \`/ondc/\` prefix). **Staging is deprecated.**
- **Whitelisting precedes subscribe** — the \`subscriber_id\` must be whitelisted via an Environment Access Request before \`/v1.1/subscribe\` succeeds.
- **The registry is read on the hot path** — every inbound verification may hit \`/lookup\`; caching (invalidated on failure) keeps this from becoming a per-request round trip.

## Sources

- ONDC developer-docs \`registry/Onboarding of Participants.md\`
- ONDC developer-docs \`registry/signing-verification.md\`; ONDC-Registry-Specifications`,
  },
  {
    id: "05-gateway-interaction",
    title: "Gateway Interaction (Beckn Gateway)",
    tier: "kb",
    category: "Message Mechanics",
    status: "source-confirmed",
    sources: [
      "ONDC developer-docs `registry/signing-verification.md`",
      "ONDC developer-docs `protocol-network-extension`",
    ],
    see_also: ["01-signature-verification", "06-p2p-communication"],
    body: `## Objective

Explain the **Beckn Gateway (BG)** — a search-multicast router — and exactly what happens to a request when it goes through the gateway (verify + re-sign + forward with two headers). Does NOT cover peer-to-peer routing (see \`06-p2p-communication\`) or the signature math (see \`01\`).

## Prerequisite

- The originator NP signs its request (\`Authorization\` header).
- The receiver can verify both an \`Authorization\` and an \`X-Gateway-Authorization\` header.

## Deliverable

A \`search\` that reaches all relevant BPPs, each able to cryptographically trust both the originating BAP and the forwarding gateway.

## The gateway, in one line

ONDC-operated **search multicast router** — it fans a BAP's \`search\` out to all relevant BPPs (by domain + city). It touches **only the outbound \`search\`**; \`on_search\` returns **directly** to the BAP, and everything from \`select\` onward is peer-to-peer.

## Guideline (gateway-forward path)

1. **BAP signs** the \`search\` → \`Authorization\` header.
2. **BG verifies** the BAP's \`Authorization\`.
3. **BG re-signs** the forwarded request with its own key → \`X-Gateway-Authorization\` header.
4. **BG forwards** to each relevant BPP, carrying **both** headers.
5. **BPP verifies both** — the BAP's \`Authorization\` and the BG's \`X-Gateway-Authorization\`.

## Protocol nuances (why this is ONDC-peculiar)

- **Two signatures on the gateway hop.** A BG-forwarded \`search\` carries the originator's header *and* the gateway's; the BPP verifies both independently.
- **The gateway does NOT route \`on_search\`.** The BPP replies **directly** to \`bap_uri\`, not back through the BG. The gateway is one-directional for the fan-out only.
- **The gateway stores nothing** — no catalog cache, no payment/fulfillment/grievance involvement.
- **Fan-in on the BAP side** — a single \`search\` can produce many \`on_search\` responses from different BPPs; the BAP accumulates them over the context \`ttl\` window.

## Sources

- ONDC developer-docs \`registry/signing-verification.md\`
- ONDC developer-docs \`protocol-network-extension\``,
  },
  {
    id: "06-p2p-communication",
    title: "P2P Communication (Peer-to-Peer NP ↔ NP)",
    tier: "kb",
    category: "Message Mechanics",
    status: "source-confirmed",
    sources: [
      "ONDC developer-docs `registry/signing-verification.md`",
      "ONDC developer-docs `protocol-network-extension`",
    ],
    see_also: ["05-gateway-interaction"],
    body: `## Objective

Explain how NPs talk **directly to each other** (BAP ↔ BPP) for every action after discovery, and how this differs from the gateway-routed \`search\`. Frames the "who signs, who verifies, where does the reply go" of peer-to-peer calls. Does NOT cover the gateway hop (see \`05-gateway-interaction\`).

## Prerequisite

- Both NPs are registered; each can resolve the other's public key via \`/lookup\`.
- \`context.bap_uri\` and \`context.bpp_uri\` are known (established during discovery).

## Deliverable

A direct, signed action → on_action exchange between two NPs with no intermediary.

## The rule, in one line

**Only the \`search\` request goes through the gateway; everything else is peer-to-peer.** The buyer sends \`search\` to the gateway, the gateway broadcasts it to all valid sellers, and each seller sends \`on_search\` **directly back to the buyer** (not through the gateway). From \`select\` onward — select, init, confirm, status, track, cancel, update, rating, support and all their \`on_\` callbacks — the BAP and BPP call each other directly. So \`on_search\` is already a direct call; the gateway touches only the outbound \`search\`.

## Guideline (a peer-to-peer action)

1. Sender signs the request with its own key → **only** the \`Authorization\` header travels (no \`X-Gateway-Authorization\`).
2. Sender POSTs directly to the counterparty's URI (\`bpp_uri\` for BAP→BPP, \`bap_uri\` for the callback).
3. Receiver verifies the single \`Authorization\` header (resolve key via \`/lookup\`).
4. Receiver returns a synchronous **ACK / NACK**, then later sends the async **\`on_action\`** callback to the sender's URI.

## Protocol nuances (why this is ONDC-peculiar)

- **One header, not two.** Peer-to-peer calls skip the BG, so only the originator's \`Authorization\` is present — there is no gateway signature to verify.
- **Both directions are signed calls.** The \`on_action\` callback is itself a signed request from the BPP to the BAP's \`bap_uri\`; the BAP verifies it the same way.
- **Routing is by URI in \`context\`.** \`bap_uri\` / \`bpp_uri\` (same domain as their respective ids) determine where each message goes — there is no central router on this path.
- **Correlation is by \`message_id\`** (shared between a request and its \`on_\` callback) within a \`transaction_id\` journey.

## Sources

- ONDC developer-docs \`registry/signing-verification.md\`
- ONDC developer-docs \`protocol-network-extension\``,
  },
  {
    id: "07-search-on_search",
    title: "search / on_search (Protocol Lens)",
    tier: "kb",
    category: "API Actions",
    status: "source-confirmed (routing; payloads in 36–48)",
    sources: [
      "ONDC developer-docs `protocol-network-extension`",
      "ONDC-RET-Specifications; ONDC-Protocol-Specs core API contract (`protocol-specifications/core/v0/api/core.yaml`)",
    ],
    see_also: ["05-gateway-interaction"],
    body: `## Objective

Explain **what \`search\` is, how it is routed, and what \`on_search\` carries** — from a protocol lens (routing, handshake, correlation), not a field-by-field payload spec. \`search\` is the network's discovery action and the **only** gateway-routed action. Does NOT cover catalog modelling detail or order actions (\`select\` onward, see P2P).

## Prerequisite

- Registered BAP with a valid \`Authorization\` signature.
- A \`context\` with \`domain\`, \`city\`, \`action: search\`, \`bap_id\`/\`bap_uri\`, \`transaction_id\`, \`message_id\`, \`timestamp\`, \`ttl\`.

## Deliverable

A discovery round trip: one signed \`search\` fanned out by the gateway → multiple \`on_search\` catalog responses accumulated by the BAP.

## The action, in one line

\`search\` = the BAP's **discovery intent**, broadcast by the Beckn Gateway to all relevant BPPs; each BPP answers with its catalog in \`on_search\`.

## Guideline (the round trip)

1. **BAP signs** \`search\` and sends it **to the gateway** (not to a BPP).
2. **Gateway verifies + re-signs + fans out** to relevant BPPs by \`domain\` + \`city\` (see \`05-gateway-interaction\`).
3. Each **BPP returns a synchronous ACK/NACK**, then sends its **\`on_search\`** (catalog) **directly to \`bap_uri\`** — not back through the gateway.
4. **BAP accumulates** \`on_search\` responses over the \`ttl\` window (fan-in from many BPPs).

## Protocol nuances (why this is ONDC-peculiar)

- **Only gateway-routed action.** Everything from \`select\` onward is peer-to-peer.
- **Asymmetric routing.** \`search\` goes *through* the BG; \`on_search\` comes back *direct* to the BAP. The gateway does not route callbacks.
- **Many-to-one callback.** One \`search\` → many \`on_search\`; the BAP correlates by \`transaction_id\`/\`message_id\` and stops accumulating at \`ttl\` expiry.
- **\`on_search\` after \`ttl\` is invalid** and should be ignored.

## Payload (high level — verify against RET contract before asserting)

- \`search.message.intent\` expresses what the buyer wants (item/category/fulfillment/location filters).
- \`on_search.message.catalog\` returns providers, items, categories, fulfillments.

## Sources

- ONDC developer-docs \`protocol-network-extension\`
- ONDC-RET-Specifications; ONDC-Protocol-Specs core API contract (\`protocol-specifications/core/v0/api/core.yaml\`)`,
  },
  {
    id: "08-confirm-on_confirm",
    title: "confirm / on_confirm (Protocol Lens)",
    tier: "kb",
    category: "API Actions",
    status: "source-confirmed (routing; payloads in 36–48)",
    sources: [
      "ONDC developer-docs `protocol-network-extension`",
      "ONDC-RET-Specifications; ONDC-Protocol-Specs core API contract (`protocol-specifications/core/v0/api/core.yaml`)",
    ],
    see_also: ["07-search-on_search"],
    body: `## Objective

Explain **what \`confirm\` is, how it is routed, and what \`on_confirm\` carries** — from a protocol lens (peer-to-peer routing, handshake, correlation), not a field-by-field payload spec. \`confirm\` places the order. Does NOT cover discovery (\`search\`, see \`07\`) or post-order actions (\`status\`, \`update\`, \`cancel\`).

## Prerequisite

- A completed \`select\` → \`init\` sequence (cart + quote + billing/payment terms established).
- Registered BAP and BPP that can resolve each other's keys and URIs.

## Deliverable

A placed order: a signed \`confirm\` from BAP → BPP, answered by \`on_confirm\` carrying the confirmed order object.

## The action, in one line

\`confirm\` = the BAP's **order placement**; \`on_confirm\` = the BPP's **confirmed order** (order id, final state, agreed terms). It is **peer-to-peer** — no gateway.

## Guideline (the round trip)

1. **BAP signs** \`confirm\` and POSTs it **directly to \`bpp_uri\`** (peer-to-peer; single \`Authorization\` header).
2. **BPP verifies** the \`Authorization\`, returns a synchronous **ACK/NACK**.
3. **BPP sends** the async **\`on_confirm\`** (confirmed order) **directly to \`bap_uri\`**, itself signed.
4. **BAP verifies** \`on_confirm\` and correlates by \`message_id\` within the \`transaction_id\` journey.

## Protocol nuances (why this is ONDC-peculiar)

- **Peer-to-peer, one header.** Unlike \`search\`, \`confirm\` never touches the gateway; only the originator's \`Authorization\` travels.
- **The callback is a signed call too.** \`on_confirm\` is a signed request from BPP → \`bap_uri\`, verified like any inbound request.
- **\`transaction_id\` is constant** across the whole select → init → confirm → on_confirm journey; \`message_id\` pairs each request with its callback.
- **\`on_confirm\` after \`ttl\`** is invalid and should be ignored.

## Payload (high level — verify against RET contract before asserting)

- \`confirm.message.order\` echoes the agreed cart, quote, billing, fulfillment and payment terms from \`init\`.
- \`on_confirm.message.order\` returns the same order with a confirmed \`id\` and order/fulfillment \`state\`.

## Sources

- ONDC developer-docs \`protocol-network-extension\`
- ONDC-RET-Specifications; ONDC-Protocol-Specs core API contract (\`protocol-specifications/core/v0/api/core.yaml\`)`,
  },
  {
    id: "09-payload-encryption-fis",
    title: "Payload Encryption & Decryption (FIS)",
    tier: "kb",
    category: "Security & Auth",
    status: "source-confirmed (FIS-only)",
    sources: [
      "ONDC developer-docs `registry/api_payload_encryption.md`",
      "ONDC developer-docs `registry/encryption_and_decryption.md`",
      "ONDC developer-docs `registry/form_encryption_and_signing.md`",
    ],
    see_also: ["02-onboarding-subscribe"],
    body: `## Objective

Explain ONDC's **API payload encryption** — encrypting the transaction \`message\` body between NPs, beyond the onboarding challenge. This is **currently active only for FIS (Financial Services)** domains (e.g. \`ONDC:FIS…\`) and **inactive for all other domains**. Covers payload encryption, the encrypt/decrypt scheme, and the form-encryption-and-signing variant. The onboarding challenge (see \`02-onboarding-subscribe\`) uses the same DH + AES-256-GCM scheme, applied to the \`request_id\` instead of the \`message\` body.

## Prerequisite

- Both NPs onboarded, each with an **X25519 encryption key pair** (\`enc_private_key\` / \`enc_public_key\`); the registry distributes each NP's \`enc_public_key\`.
- Ed25519 signing keys (for the form-signing variant).
- A domain where payload encryption is enabled (FIS today).

## Deliverable

A \`message\` body (or form) that is encrypted end-to-end between NP1 and NP2 so only the intended recipient can read it, while \`context\` stays in the clear for routing.

## Guideline — API payload encryption

**What is encrypted:** the entire **\`message\`** body, as one unit. **\`context\` stays plaintext** (needed for routing and audit).

**Encrypt (sender):**
1. Fetch the recipient's \`enc_public_key\` from the registry.
2. Derive the shared key: \`diffieHellman(NP1_enc_private_key, NP2_enc_public_key)\` (X25519).
3. Generate a random **12-byte IV**.
4. Encrypt with **AES-256-GCM** → ciphertext + 16-byte authTag.
5. Concatenate \`iv + ciphertext + authTag\`, **base64**-encode, and send as the \`message\` value.

**Decrypt (receiver):**
1. Base64-decode the \`message\` value.
2. Split: **IV (12 bytes)**, **authTag (16 bytes)**, ciphertext (remainder).
3. Derive the same shared key and run **AES-256-GCM** decrypt **with authTag verification**.
4. Parse the JSON and validate schema before ACK/NACK.

## Guideline — form encryption & signing (FIS forms)

1. Derive the shared key (X25519 DH, as above).
2. Generate a 12-byte nonce; encrypt the JSON-serialized form with **AES-256-GCM**.
3. Base64-encode ciphertext + authTag + nonce → package as **\`encrypted_payload\`**.
4. **Sign** the encrypted payload: **BLAKE-512** digest → signing string with timestamps + digest → **Ed25519** signature in the **\`Authorization\`** header (\`Signature keyId=…\`).
5. Transmit plaintext \`context\` + \`encrypted_payload\` in the body.
6. **Receiver:** verify the Ed25519 signature **first**, then derive the shared key and AES-256-GCM-decrypt using the carried nonce + authTag.

## Protocol nuances (why this is ONDC-peculiar)

- **FIS-only today.** The mechanism is defined network-wide but **currently active only for Financial Services**; other domains transact with plaintext \`message\`.
- **Same scheme as the onboarding challenge.** Both use X25519 DH + **AES-256-GCM** (12-byte IV/nonce + 16-byte authTag); onboarding applies it to the \`request_id\` challenge (see \`02\`), payload encryption to the \`message\` body.
- **\`context\` is never encrypted** — only \`message\` / the form is. Routing and audit rely on plaintext \`context\`.
- **Same X25519 keys throughout.** The \`enc_private_key\` / \`enc_public_key\` pair (from onboarding) is reused for payload/form encryption.
- **Encrypt-then-sign on forms.** Signature is computed over the encrypted payload and verified before decryption.

## Sources

- ONDC developer-docs \`registry/api_payload_encryption.md\`
- ONDC developer-docs \`registry/encryption_and_decryption.md\`
- ONDC developer-docs \`registry/form_encryption_and_signing.md\``,
  },
  {
    id: "10-ack-nack",
    title: "ACK / NACK Handshake",
    tier: "kb",
    category: "Message Mechanics",
    status: "source-confirmed",
    sources: [
      "ONDC developer-docs `protocol-network-extension`",
      "ONDC-Protocol-Specs core API contract (`protocol-specifications/core/v0/api/core.yaml`)",
    ],
    see_also: ["11-async-request-callback", "15-error-codes"],
    body: `## Objective

Explain the **synchronous ACK/NACK response** returned for every ONDC API call — the immediate accept/reject that is separate from the later async \`on_action\` callback. Covers what ACK and NACK mean and when to NACK. Does NOT cover the async callback (see \`11-async-request-callback\`) or specific error codes (see \`15-error-codes\`).

## Prerequisite

- An inbound \`action\` request (\`search\`, \`select\`, \`init\`, \`confirm\`, …) or an \`on_action\` callback.
- The receiver can verify the signature and validate the payload before responding.

## Deliverable

An immediate, synchronous response to the caller: **ACK** (accepted for async processing) or **NACK** (rejected, with an error object).

## The handshake, in one line

Every call gets an **immediate synchronous response** — \`ACK\` if the message is accepted for processing, \`NACK\` if it is rejected. The actual business result comes **later**, asynchronously, in the \`on_action\` callback.

## Guideline

1. On receipt, verify the signature and validate \`context\` + schema.
2. If it passes, return **ACK** synchronously (\`message.ack.status = "ACK"\`) and continue processing asynchronously.
3. If it fails, return **NACK** (\`message.ack.status = "NACK"\`) with an **error object** (\`error.code\`, \`error.type\`, \`error.message\`).
4. Later, send the async \`on_action\` with the actual outcome.

## Protocol nuances (why this is ONDC-peculiar)

- **ACK ≠ success.** ACK means "accepted for processing," not "the request succeeded." The outcome arrives in the \`on_action\` callback. Treating ACK as a business success is a common mistake.
- **NACK carries an error object** — \`code\`, \`type\`, \`message\` — telling the caller why it was rejected (bad signature, schema error, unsupported domain/version, context error).
- **The handshake is per-hop.** Both the \`action\` request and its \`on_action\` callback each get their own synchronous ACK/NACK.
- **NACK stops the async flow** — a NACK means no \`on_action\` will follow for that message; ACK means one will.

## Sources

- ONDC developer-docs \`protocol-network-extension\`
- ONDC-Protocol-Specs core API contract (\`protocol-specifications/core/v0/api/core.yaml\`)`,
  },
  {
    id: "11-async-request-callback",
    title: "Async Request → Callback Pattern",
    tier: "kb",
    category: "Message Mechanics",
    status: "source-confirmed",
    sources: [
      "ONDC developer-docs `protocol-network-extension`",
      "ONDC-Protocol-Specs core API contract (`protocol-specifications/core/v0/api/core.yaml`)",
    ],
    see_also: ["10-ack-nack", "12-ttl-handling", "13-idempotency-retries"],
    body: `## Objective

Explain ONDC's **asynchronous \`action\` → \`on_action\` model** and how a request is correlated to its callback. This is the backbone of every ONDC interaction. Does NOT cover the synchronous ACK/NACK (see \`10-ack-nack\`) or TTL bounds (see \`12-ttl-handling\`).

## Prerequisite

- Both NPs registered; \`context.bap_uri\` / \`context.bpp_uri\` known.
- A \`context\` carrying \`transaction_id\`, \`message_id\`, \`timestamp\`, \`ttl\`.

## Deliverable

A non-blocking exchange: sender fires \`action\`, gets an immediate ACK, and later receives the result in a separate \`on_action\` call.

## The pattern, in one line

Every ONDC action is **asynchronous**: the sender POSTs \`action\`, receives a synchronous **ACK**, and the receiver later POSTs **\`on_action\`** back to the sender's callback URI as a **separate signed request**.

## Guideline

1. Sender signs and POSTs \`action\` (e.g. \`select\`) to the counterparty.
2. Receiver returns synchronous **ACK** (see \`10\`), then processes.
3. Receiver signs and POSTs **\`on_action\`** (e.g. \`on_select\`) to the sender's callback URI (\`bap_uri\` / \`bpp_uri\`).
4. Sender verifies the callback and correlates it to the original request.

## Correlation (how request and callback are matched)

- **\`message_id\`** — a request and its \`on_\` callback **share the same \`message_id\`**. This is how the sender matches \`on_select\` to its \`select\`.
- **\`transaction_id\`** — constant across the **whole order journey** (search → … → confirm → post-order), so all messages of one order are groupable.

## Protocol nuances (why this is ONDC-peculiar)

- **The callback is itself a signed request**, not an HTTP response body. \`on_action\` is a fresh POST to the caller's URI, verified like any inbound request.
- **Don't block on the callback.** The sender returns after the ACK and handles \`on_action\` when it arrives (which may be seconds later).
- **Correlate by \`message_id\`, group by \`transaction_id\`.** Never assume ordering by arrival time.
- **A callback can arrive more than once** — see idempotency (\`13-idempotency-retries\`).

## Sources

- ONDC developer-docs \`protocol-network-extension\`
- ONDC-Protocol-Specs core API contract (\`protocol-specifications/core/v0/api/core.yaml\`)`,
  },
  {
    id: "12-ttl-handling",
    title: "TTL Handling",
    tier: "kb",
    category: "Message Mechanics",
    status: "source-confirmed",
    sources: [
      "ONDC developer-docs `protocol-network-extension`",
      "ONDC-Protocol-Specs core API contract (`protocol-specifications/core/v0/api/core.yaml`)",
    ],
    see_also: ["13-idempotency-retries"],
    body: `## Objective

Explain how **\`context.ttl\`** bounds the validity of a request/callback and how to treat late messages. Covers the ISO8601 duration format and the "expired callback" rule. Does NOT cover retries (see \`13-idempotency-retries\`).

## Prerequisite

- A \`context\` carrying \`timestamp\` (RFC3339) and \`ttl\` (ISO8601 duration, e.g. \`PT30S\`).

## Deliverable

Correct treatment of the validity window: acting on in-window messages and ignoring expired ones.

## The rule, in one line

\`context.ttl\` is a **validity window**; a message (especially an \`on_action\` callback) received **after its TTL has expired is invalid and should be ignored**.

## Guideline

1. Read \`timestamp\` (RFC3339) and \`ttl\` (ISO8601 duration) from \`context\`.
2. Compute expiry = \`timestamp + ttl\`.
3. If a message arrives after expiry, treat it as **invalid / ignore** it.
4. For \`search\`, the \`ttl\` bounds how long the BAP **accumulates \`on_search\`** responses — stop collecting after it lapses.

## Protocol nuances (why this is ONDC-peculiar)

- **TTL is a duration, not a timestamp** — ISO8601 (\`PT30S\` = 30 seconds, \`PT1M\` = 1 minute). Expiry is derived from \`timestamp + ttl\`.
- **Late \`on_action\` is invalid.** A callback that lands after the window is dropped, not processed — this prevents acting on stale quotes/state.
- **TTL drives the search fan-in window** — the BAP collects multiple \`on_search\` responses only until the \`search\` TTL expires.
- **TTL is protocol-level validity, not a business deadline** (e.g. not a delivery SLA).

## Sources

- ONDC developer-docs \`protocol-network-extension\`
- ONDC-Protocol-Specs core API contract (\`protocol-specifications/core/v0/api/core.yaml\`)`,
  },
  {
    id: "13-idempotency-retries",
    title: "Idempotency & Retries",
    tier: "kb",
    category: "Message Mechanics",
    status: "source-confirmed",
    sources: [
      "ONDC developer-docs `protocol-network-extension`",
      "ONDC-Protocol-Specs core API contract (`protocol-specifications/core/v0/api/core.yaml`)",
    ],
    see_also: ["11-async-request-callback", "12-ttl-handling"],
    body: `## Objective

Explain how to handle **duplicate callbacks and safe retries** on the ONDC network — keyed on \`message_id\`. Covers why duplicates happen and how to stay correct. Does NOT cover TTL (see \`12-ttl-handling\`) or transport security.

## Prerequisite

- The async \`action\` → \`on_action\` model (see \`11\`) with \`message_id\` / \`transaction_id\` correlation.

## Deliverable

Processing that produces the same result whether a callback arrives once or several times, and retries that don't create duplicate side effects.

## The rule, in one line

Treat every \`on_action\` as **possibly-duplicate**: make processing **idempotent, keyed on \`message_id\`** (within \`transaction_id\`), so re-delivery is harmless.

## Guideline

1. On receiving \`on_action\`, check whether that \`message_id\` has already been processed.
2. If yes, **ACK and no-op** (do not re-apply side effects).
3. If no, process, record the \`message_id\` as handled, then ACK.
4. When **retrying** an outbound call (e.g. no ACK received), reuse the **same \`message_id\`** so the receiver can dedupe.

## Protocol nuances (why this is ONDC-peculiar)

- **Callbacks can be delivered more than once** — network retries mean \`on_action\` may repeat; the receiver, not the sender, guarantees idempotency.
- **Dedupe key = \`message_id\`** (scoped to its \`transaction_id\`). Never dedupe on arrival time or payload equality alone.
- **Retry with the same \`message_id\`**, not a new one — a new id would look like a distinct request and break correlation/dedup.
- **Idempotency is a guideline layer**, not a wire field — the protocol gives you \`message_id\`; enforcing exactly-once effects is the implementer's responsibility.

## Sources

- ONDC developer-docs \`protocol-network-extension\`
- ONDC-Protocol-Specs core API contract (\`protocol-specifications/core/v0/api/core.yaml\`)`,
  },
  {
    id: "14-schema-validation",
    title: "Schema Validation",
    tier: "kb",
    category: "Message Mechanics",
    status: "source-confirmed",
    sources: [
      "ONDC automation-specifications (JSON schemas per domain/version)",
      "ONDC automation-framework (Workbench schema-validation tool)",
    ],
    see_also: ["15-error-codes", "16-validation-rules"],
    body: `## Objective

Explain validating a payload against the **ONDC JSON schema** for its domain + version, before sending and on receipt. Covers where the schemas live and how validation fits the flow. Does NOT cover cross-field/business rules (see \`16-validation-rules\`) or error codes (see \`15-error-codes\`).

## Prerequisite

- The message \`domain\` and \`core_version\` (from \`context\`) to select the right schema.
- Access to the ONDC schema for that domain/version (Workbench or the spec repos).

## Deliverable

Payloads that conform to the domain/version JSON schema before they go on the wire, and inbound payloads validated before ACK.

## The rule, in one line

Validate every payload against the **ONDC JSON schema for its \`domain\` + \`core_version\`** — sender-side before sending, receiver-side before ACK.

## Guideline

1. Pick the schema by \`domain\` + \`core_version\`.
2. Validate structure, required fields, datatypes and enums.
3. On a schema failure, **NACK** with a schema error (\`JSON-SCHEMA-ERROR\`); do not process.
4. Use the **ONDC Workbench** schema-validation tool during development; the schemas ship in \`automation-specifications\`.

## Protocol nuances (why this is ONDC-peculiar)

- **Schema is versioned per domain.** RET, LOG, FIS etc. and each \`core_version\` have their own schema — validating against the wrong version yields false failures.
- **Schema validation ≠ business validation.** A schema-valid payload can still fail cross-field \`x-validations\` (see \`16\`). Schema is structure/type/enum only.
- **Validate on both ends.** Sender validates to avoid a NACK; receiver validates before ACK to reject malformed input early.
- **Enums matter.** Many failures are enum mismatches (codes, states) rather than missing fields.

## Sources

- ONDC automation-specifications (JSON schemas per domain/version)
- ONDC automation-framework (Workbench schema-validation tool)`,
  },
  {
    id: "15-error-codes",
    title: "Error Codes (x-errorcodes)",
    tier: "kb",
    category: "Errors & Codes",
    status: "source-confirmed (RET11)",
    sources: [
      "ONDC automation-specifications `config/errors/index.yaml` (branch `draft-RET11-1.2.5`)",
      "ONDC-Protocol-Specs docs (Error Codes)",
    ],
    see_also: ["10-ack-nack", "16-validation-rules", "17-reason-codes"],
    body: `## Objective

Explain the **enumerated protocol error codes** returned in a NACK's error object, and how they're categorized. Does NOT cover business reason codes for cancel/return (see \`17-reason-codes\`) or cross-field validations (see \`16-validation-rules\`).

## Prerequisite

- The ACK/NACK handshake (see \`10\`) — errors ride on a NACK.

## Deliverable

Correct NACK responses that carry the right error \`code\` + \`type\` so the caller can act on the failure.

## The error object

An error is returned as a \`code\` plus a descriptive event, carried either **in a NACK** (rejecting the message) or **in an \`error\` object inside an \`on_\` callback** (business error on an accepted message). Each entry in \`errors/index.yaml\` records: \`code\`, \`Event\` (what it means), \`From\` (BAP or BPP), and where it's used (NACK vs error object).

## Actual code structure (RET, \`draft-RET11-1.2.5\`)

Codes are **5-digit strings** in the \`6xxxx\` space, grouped by originator and concern. Representative set from \`config/errors/index.yaml\`:

| Code | From | Meaning | Used in |
|---|---|---|---|
| 60005 | BPP | Invalid Signature — cannot verify request signature | **NACK** |
| 60006 | BPP | Invalid request — not compliant with API contract | **NACK** |
| 60001 / 60002 | BPP | Location serviceability (pickup / dropoff not serviceable) | error object |
| 60004 | BPP | Delivery partners not available | error object |
| 60007 / 60009 / 60010 | BPP | Cancellation policy / invalid reason / TAT-not-breached | — |
| 60012 | BPP | Tracking not enabled | — |
| 61001 / 64001 | BPP / BAP | Feature not supported | — |
| 625xx | BAP | Terms / quote / authorization errors (e.g. 62508 quote difference, 62510 expired auth) | — |
| 63001 / 63002 | BAP | Internal error / order validation failure | — |
| 65001–65004 | BPP | Order confirm / terms / stale request | — |
| 66001–66005 | BPP | Internal / order validation / not found / quote unavailable | — |

## Guideline

1. On a failure, pick the enumerated \`code\` from \`errors/index.yaml\` for the domain/version.
2. If the message itself is rejected (bad signature \`60005\`, non-compliant \`60006\`), return it in a **NACK**.
3. If the message is accepted but a business error occurs, return the \`code\` in the **\`error\` object of the \`on_\` callback**.

## Protocol nuances (why this is ONDC-peculiar)

- **Protocol/NACK codes ≠ business reason codes.** Error codes describe *why a message was rejected or failed*; cancel/return reason codes describe *a business decision* (see \`17\`). Keep them separate.
- **Codes are per domain + version.** These \`6xxxx\` codes are the RET set (\`draft-RET11-1.2.5\`); other domains (FIS, LOG, TRV) ship their own \`errors/index.yaml\` on their branch.
- **Two placements.** The same registry drives both NACK rejections and in-callback error objects — the \`Used in\` field tells you which.
- **Don't invent codes** — read them from \`errors/index.yaml\` on the target branch.

## Sources

- ONDC automation-specifications \`config/errors/index.yaml\` (branch \`draft-RET11-1.2.5\`)
- ONDC-Protocol-Specs docs (Error Codes)`,
  },
  {
    id: "16-validation-rules",
    title: "Validation Rules (x-validations)",
    tier: "kb",
    category: "Errors & Codes",
    status: "source-confirmed (RET11)",
    sources: [
      "ONDC automation-specifications `config/validations/index.yaml` (branch `draft-RET11-1.2.5`)",
      "ONDC automation-framework (Workbench flow testing)",
    ],
    see_also: [
      "14-schema-validation",
      "15-error-codes",
      "65-interpreting-error-reports",
    ],
    body: `## Objective

Explain the **cross-field / conditional validations** ONDC enforces **beyond raw JSON schema** — the \`x-validations\`. Covers what they are and why a schema-valid payload can still fail. Does NOT cover structural schema checks (see \`14-schema-validation\`) or error codes (see \`15\`).

## Prerequisite

- A schema-valid payload (structure/type/enum already passed — see \`14\`).

## Deliverable

Payloads that satisfy not just the schema but the conditional/business-rule validations the network enforces.

## The idea, in one line

\`x-validations\` are **named, per-action rules over JSONPath-addressed fields** — including conditional ones JSON schema can't express — that a payload must satisfy beyond its schema.

## Actual structure (\`config/validations/index.yaml\`, RET11)

The file is a tree under \`_TESTS_\`, keyed by action. Each test has a \`_NAME_\`, targets a field by JSONPath (\`attr\`, e.g. \`$.context.domain\`), states its expectation in \`_RETURN_\` (e.g. "attr are present"), and can be **conditional** via \`_CONTINUE_\` (e.g. \`(action equal to search)\`). Tests nest, so a group like \`CONTEXT_REQUIRED\` holds child checks (\`CONTEXT_REQUIRED_DOMAIN\`, \`_ACTION\`, \`_CITY\`, \`_BAP_ID\`, …). Example:

\`\`\`yaml
_TESTS_:
  search:
    - _NAME_: SEARCH_CONTEXT
      action: [search]
      _RETURN_:
        - _NAME_: CONTEXT_REQUIRED
          _RETURN_:
            - _NAME_: CONTEXT_REQUIRED_DOMAIN
              attr: $.context.domain
              _RETURN_: attr are present
            - _NAME_: CONTEXT_REQUIRED_BPP_ID
              attr: $.context.bap_id
              _CONTINUE_: (action equal to search)
              _RETURN_: attr are present
\`\`\`

## Guideline

1. After schema validation, apply the action's \`_TESTS_\` from \`validations/index.yaml\`.
2. Each test asserts a JSONPath \`attr\` against a \`_RETURN_\` expectation; \`_CONTINUE_\` gates it on a condition.
3. Typical checks: required context/message fields, conditional-required fields, value/enum consistency, and cross-field reconciliation.
4. Failures surface via the Workbench flow tests and map to an error (see \`15\`).

## Protocol nuances (why this is ONDC-peculiar)

- **Schema-valid ≠ protocol-valid.** A structurally correct payload can still fail an \`x-validation\`. Frequent source of "but my JSON is valid" confusion.
- **Rules are conditional** — \`_CONTINUE_\` makes many "apply only when action/context is X".
- **JSONPath-addressed and named** — every check has a stable \`_NAME_\` and a precise \`attr\` target, so failures are pinpointable.
- **Versioned per domain** (\`validations/index.yaml\` on the domain branch) — validate against the matching version; enforced by the Workbench, so they gate go-live.
- **Compiled by JVAL.** The \`automation-validation-compiler\` (JVAL) turns these YAML/JSON \`x-validations\` into executable (TypeScript) validators — \`comp.generateCode(x_validations, "L1-validations")\` — each test becoming a function that returns \`{code, valid, description}\`. JVAL operators include \`are present\`, \`all in\`, \`follow regex\`, and boolean combinations. That output is what the Workbench error report shows (see \`65\`).

## Sources

- ONDC automation-specifications \`config/validations/index.yaml\` (branch \`draft-RET11-1.2.5\`)
- ONDC automation-framework (Workbench flow testing)`,
  },
  {
    id: "17-reason-codes",
    title: "Reason Codes (Cancel / Return)",
    tier: "kb",
    category: "Errors & Codes",
    status: "source-confirmed (RET11)",
    sources: [
      "ONDC Retail Cancellation Reason Codes sheet (authoritative code list)",
      "ONDC automation-specifications `config/attributes/F_B.yaml` + `config/flows/F&B/*` (branch `draft-RET11-1.2.5`)",
    ],
    see_also: ["15-error-codes", "22-cancel-on_cancel", "23-update-on_update"],
    body: `## Objective

Explain the **business reason codes** used in cancellation and return flows — the authoritative enumerations that say *why* an order is cancelled or returned. Does NOT cover protocol error codes (see \`15-error-codes\`).

## Prerequisite

- A \`cancel\` / \`update\` (return) flow (see \`22-cancel-on_cancel\`, \`23-update-on_update\`).

## Deliverable

Cancel/return messages that carry a valid reason code so the counterparty (and settlement/grievance) can process them correctly.

## The idea, in one line

Reason codes are a **3-digit string enumeration** (e.g. \`"001"\`, \`"002"\`, \`"016"\`) carried in the cancel/return flow that identify the specific business reason; the field is \`cancellation_reason_id\`.

## The field (RET11, \`config/attributes/F_B.yaml\`)

- **\`cancellation_reason_id\`** — \`type: string\`, **required**, owner **BAP**. Example values seen in flows: \`"001"\`, \`"002"\`, \`"006"\`, \`"016"\`, \`"052"\`.
- The BAP sets it from the **buyer's explicit selection** in a buyer-initiated cancel, or from a **system-assigned** identifier in a **force-cancel**.
- **Absent → the cancel request is rejected with a 400** (mandatory to process).
- The value is **persisted and carried forward** so the BPP references it when composing \`on_cancel\`.

## The retail reason-code list (authoritative)

3-digit string codes; \`Who\` = initiator (BNP = buyer app, SNP = seller app, LSP = logistics); \`Phase\` = pre-/post-pickup:

| Code | Meaning | Who | Phase |
|---|---|---|---|
| 001 | Price of item(s) changed; buyer asked to pay more | BNP | Pre-pickup |
| 002 | One or more items not available (part-fill option; settles per last quote) | SNP | Either |
| 003 | Product available at lower than order price | BNP | Either |
| 004 / 051 | Store is not accepting order | BNP | Pre-pickup |
| 005 | Store rejected the order (may use 021–024) | SNP | Pre-pickup |
| 006 / 052 | Order not received per O2D TAT (timing breach by SNP) | BNP | Post-pickup |
| 009 | Wrong product delivered (settles per last quote) | BNP | Post-pickup |
| 010 / 053 | Buyer wants to modify address/order details | BNP | Pre-delivery |
| 011 | Retail buyer not found / uncontactable | SNP | Post-pickup |
| 013 | Buyer can't / won't accept delivery | SNP | Post-pickup |
| 014 | Delivery address incorrect or not found | SNP | Post-pickup |
| 016 | Force majeure (accident / strike / law & order) | SNP | Post-pickup |
| 017 | Order delivery delayed or not possible (vehicle/logistics) | LSP | Post-pickup |
| 018 | Order not serviceable | SNP | Post-pickup |
| 020 | Order lost or damaged in transit (cost to LSP) | SNP | Post-pickup |
| 021 | Store not responsive (auto-accepted, no response) | SNP | Pre-pickup |
| 022 | Technical issue in merchant device | SNP | Pre-pickup |
| 023 | Order received during non-operational hours | SNP | Pre-pickup |
| 024 | Order received during store rush | SNP | Pre-pickup |
| 998 | Order confirmation failure | SNP | Pre-pickup |
| 999 | Order confirmation failure | BNP | Pre-pickup |

Note the paired codes (\`004/051\`, \`006/052\`, \`010/053\`) — the newer 05x codes coexist with the legacy 3-digit ones.

## Guideline

1. On a \`cancel\` (or return \`update\`), set \`cancellation_reason_id\` from the table above — never free-text it.
2. Buyer-initiated → the buyer's selected code; force-cancel → a system-assigned code.
3. The code carries into \`on_cancel\` and feeds **settlement** and **grievance** handling, so it must be accurate.

## Protocol nuances (why this is ONDC-peculiar)

- **Reason codes (business) ≠ error codes (protocol).** Reason codes explain a business decision inside a valid flow; error codes explain a rejected/failed message. See \`15\`.
- **Mandatory and gating** — a missing \`cancellation_reason_id\` is a hard 400, not a soft warning.
- **Initiator matters** — buyer-selected vs system-assigned (force-cancel) use the same field with different sourcing.
- **Codes encode initiator + phase + effect** — the same field carries who raised it (BNP/SNP/LSP), when (pre-/post-pickup), and downstream impact (part-fill, RTO, settle-per-last-quote).
- **Legacy + new codes coexist** — \`004/051\`, \`006/052\`, \`010/053\` are equivalent pairs; accept both.

## Sources

- ONDC Retail Cancellation Reason Codes sheet (authoritative code list)
- ONDC automation-specifications \`config/attributes/F_B.yaml\` + \`config/flows/F&B/*\` (branch \`draft-RET11-1.2.5\`)`,
  },
  {
    id: "18-action-catalogue-lifecycle",
    title: "API Action Catalogue & Lifecycle",
    tier: "kb",
    category: "API Actions",
    status: "source-confirmed",
    sources: [
      "ONDC automation-specifications `config/actions/index.yaml` (branch `draft-RET11-1.2.5`)",
      "ONDC developer-docs `protocol-network-extension`; ONDC-Protocol-Specs core API contract",
    ],
    see_also: [
      "07-search-on_search",
      "08-confirm-on_confirm",
      "10-ack-nack",
      "11-async-request-callback",
      "19-select-on_select",
      "20-init-on_init",
      "21-status-on_status",
      "22-cancel-on_cancel",
      "23-update-on_update",
      "24-track-on_track",
      "25-rating-support",
    ],
    body: `## Objective

Index **every ONDC action and its \`on_\` callback**, and the order they fire across an order journey. A map, not a payload spec. Does NOT detail each payload (see the per-action docs).

## Prerequisite

- The async \`action\` → \`on_action\` model (see \`11\`) and ACK/NACK (see \`10\`).

## Deliverable

A single view of the actions, their callbacks, and the typical sequence.

## The lifecycle, in order

| Phase | Action → callback | Routing |
|---|---|---|
| Discovery | \`search\` → \`on_search\` | \`search\` via gateway; \`on_search\` direct (see \`07\`) |
| Cart / quote | \`select\` → \`on_select\` | peer-to-peer (see \`19\`) |
| Order draft | \`init\` → \`on_init\` | peer-to-peer (see \`20\`) |
| Order placement | \`confirm\` → \`on_confirm\` | peer-to-peer (see \`08\`) |
| Order state | \`status\` → \`on_status\` | peer-to-peer (see \`21\`) |
| Tracking | \`track\` → \`on_track\` | peer-to-peer (see \`24\`) |
| Cancellation | \`cancel\` → \`on_cancel\` | peer-to-peer (see \`22\`) |
| Post-order change | \`update\` → \`on_update\` | peer-to-peer (see \`23\`) |
| Feedback / help | \`rating\` → \`on_rating\`, \`support\` → \`on_support\` | peer-to-peer (see \`25\`) |

## Allowed transitions (\`config/actions/index.yaml\`, RET11)

The config encodes a **state machine** (\`supportedActions\`: what may legally follow each action) and **\`apiProperties\`** (\`async_predecessor\`, \`transaction_partner\`). Key facts read from it:

- \`search → on_search\`; \`on_search →\` \`search\` / \`select\` / \`init\`.
- \`select → on_select\`; \`on_select →\` \`init\` / \`select\`.
- \`init → on_init\`; \`on_init →\` \`confirm\` / \`init\`.
- \`confirm → on_confirm\`; \`on_confirm →\` \`status\` / \`cancel\` / \`track\` / \`update\` / \`on_status\` …
- Post-order: \`status ↔ on_status\`, \`track ↔ on_track\`, \`cancel ↔ on_cancel\`, \`update ↔ on_update\`, plus **\`issue\` / \`on_issue\` / \`on_issue_status\`** (IGM).
- **\`async_predecessor\`** — e.g. \`on_select.async_predecessor = select\`, \`on_init = init\`, \`on_confirm = confirm\` (each callback is bound to its request).
- **\`transaction_partner\`** — e.g. \`confirm\` and post-order actions carry \`init\` / \`on_init\` / \`confirm\` as partners, tying them to the order.

## Guideline

1. Every action follows the same shape: **\`action\` → synchronous ACK → async \`on_action\`**.
2. **Only \`search\` uses the gateway**; every other action (and \`on_search\`) is peer-to-peer.
3. **\`transaction_id\`** stays constant across the whole journey; **\`message_id\`** pairs each action with its callback (\`async_predecessor\` links the pair in config).
4. Follow only the transitions in \`supportedActions\` — an out-of-sequence action is invalid.

## Protocol nuances (why this is ONDC-peculiar)

- **Uniform shape, one exception.** All actions share the request→ACK→callback pattern; the only routing exception is the outbound \`search\` through the gateway.
- **Legal-transition set is explicit.** \`supportedActions\` defines exactly what may follow each action — it's a state machine, not a free-for-all.
- **IGM is part of the same graph.** \`issue\` / \`on_issue\` / \`on_issue_status\` are reachable from \`on_confirm\` / \`on_status\` / \`on_update\`.
- **Callbacks are separate signed calls**, correlated by \`message_id\` and bound via \`async_predecessor\`.

## Sources

- ONDC automation-specifications \`config/actions/index.yaml\` (branch \`draft-RET11-1.2.5\`)
- ONDC developer-docs \`protocol-network-extension\`; ONDC-Protocol-Specs core API contract`,
  },
  {
    id: "19-select-on_select",
    title: "select / on_select (Protocol Lens)",
    tier: "kb",
    category: "API Actions",
    status: "source-confirmed (routing; payloads in 36–48)",
    sources: [
      "ONDC-RET-Specifications; ONDC-Protocol-Specs core API contract (`protocol-specifications/core/v0/api/core.yaml`)",
      "ONDC developer-docs `protocol-network-extension`",
    ],
    see_also: ["07-search-on_search", "10-ack-nack", "20-init-on_init"],
    body: `## Objective

Explain **\`select\` / \`on_select\`** from a protocol lens — cart build and quote — covering routing, handshake and correlation, not a field-by-field payload spec. Does NOT cover discovery (\`07\`) or order draft (\`20\`).

## Prerequisite

- A completed \`search\` → \`on_search\` (a chosen provider + items).
- Registered BAP and BPP that can resolve each other's keys/URIs.

## Deliverable

A quote: the buyer selects items into a cart and the seller returns pricing in \`on_select\`.

## The action, in one line

\`select\` = the BAP's **cart / quote request** (chosen provider + items); \`on_select\` = the BPP's **quote** (price breakup, availability). It is **peer-to-peer** — no gateway.

## Guideline (the round trip)

1. **BAP signs** \`select\` and POSTs it **directly to \`bpp_uri\`** (single \`Authorization\` header).
2. **BPP verifies**, returns synchronous **ACK/NACK** (see \`10\`).
3. **BPP sends** async **\`on_select\`** (quote) **directly to \`bap_uri\`**, itself signed.
4. **BAP verifies** and correlates by \`message_id\` within the \`transaction_id\` journey.

## Protocol nuances (why this is ONDC-peculiar)

- **Peer-to-peer, one header** — like every non-\`search\` action, \`select\` never touches the gateway.
- **Quote is not an order.** \`on_select\` prices the cart; nothing is committed until \`confirm\`.
- **\`transaction_id\` continues** from discovery; \`message_id\` pairs this \`select\` with its \`on_select\`.
- **Serviceability can be rejected here** — a provider out of area can decline via NACK / an empty quote.

## Sources

- ONDC-RET-Specifications; ONDC-Protocol-Specs core API contract (\`protocol-specifications/core/v0/api/core.yaml\`)
- ONDC developer-docs \`protocol-network-extension\``,
  },
  {
    id: "20-init-on_init",
    title: "init / on_init (Protocol Lens)",
    tier: "kb",
    category: "API Actions",
    status: "source-confirmed (routing; payloads in 36–48)",
    sources: [
      "ONDC-RET-Specifications; ONDC-Protocol-Specs core API contract (`protocol-specifications/core/v0/api/core.yaml`)",
      "ONDC developer-docs `protocol-network-extension`",
    ],
    see_also: ["08-confirm-on_confirm", "19-select-on_select"],
    body: `## Objective

Explain **\`init\` / \`on_init\`** from a protocol lens — draft order with billing/shipping and payment terms — covering routing, handshake and correlation, not a field-by-field payload spec. Does NOT cover the quote (\`19\`) or final placement (\`08\`).

## Prerequisite

- A completed \`select\` → \`on_select\` (an agreed quote).

## Deliverable

A draft order: billing/shipping submitted, payment terms and a firm quote returned in \`on_init\`.

## The action, in one line

\`init\` = the BAP's **draft order** (billing + shipping + selected quote); \`on_init\` = the BPP's **draft confirmation** with payment terms. **Peer-to-peer** — no gateway.

## Guideline (the round trip)

1. **BAP signs** \`init\` and POSTs it **directly to \`bpp_uri\`**.
2. **BPP verifies**, returns synchronous **ACK/NACK**.
3. **BPP sends** async **\`on_init\`** (draft order + payment terms) **directly to \`bap_uri\`**, signed.
4. **BAP verifies** and correlates by \`message_id\` within the \`transaction_id\`.

## Protocol nuances (why this is ONDC-peculiar)

- **Still not placed.** \`init\` establishes billing/shipping and payment terms; the order is created only at \`confirm\`.
- **Payment terms surface here** — who collects (BAP vs BPP), prepaid/COD — carried into \`confirm\`.
- **Peer-to-peer, one header**; \`transaction_id\` continues, \`message_id\` pairs \`init\`/\`on_init\`.

## Sources

- ONDC-RET-Specifications; ONDC-Protocol-Specs core API contract (\`protocol-specifications/core/v0/api/core.yaml\`)
- ONDC developer-docs \`protocol-network-extension\``,
  },
  {
    id: "21-status-on_status",
    title: "status / on_status (Protocol Lens)",
    tier: "kb",
    category: "API Actions",
    status: "source-confirmed (routing; payloads in 36–48)",
    sources: [
      "ONDC-RET-Specifications; ONDC-Protocol-Specs core API contract (`protocol-specifications/core/v0/api/core.yaml`)",
      "ONDC developer-docs `protocol-network-extension`",
    ],
    see_also: ["08-confirm-on_confirm", "24-track-on_track"],
    body: `## Objective

Explain **\`status\` / \`on_status\`** from a protocol lens — polling or pushing order & fulfillment state — covering routing, handshake and correlation. Does NOT cover tracking coordinates (see \`24-track-on_track\`).

## Prerequisite

- A confirmed order (see \`08\`) with an order id.

## Deliverable

Current order/fulfillment state returned to the buyer.

## The action, in one line

\`status\` = the BAP's **state query** for a confirmed order; \`on_status\` = the BPP's **current order + fulfillment state**. **Peer-to-peer** — no gateway.

## Guideline (the round trip)

1. **BAP signs** \`status\` (referencing the order id) and POSTs it **directly to \`bpp_uri\`**.
2. **BPP verifies**, returns synchronous **ACK/NACK**.
3. **BPP sends** async **\`on_status\`** (order + fulfillment state) **directly to \`bap_uri\`**, signed.
4. **BAP** correlates by \`message_id\` within the \`transaction_id\`.

## Protocol nuances (why this is ONDC-peculiar)

- **Two shapes: pull and push.** The BAP can request \`status\`, and the BPP can also send an **unsolicited \`on_status\`** when state changes.
- **State, not location.** \`on_status\` reports order/fulfillment *state*; live location is \`track\` (see \`24\`).
- **Peer-to-peer, one header**; \`transaction_id\` continues.

## Sources

- ONDC-RET-Specifications; ONDC-Protocol-Specs core API contract (\`protocol-specifications/core/v0/api/core.yaml\`)
- ONDC developer-docs \`protocol-network-extension\``,
  },
  {
    id: "22-cancel-on_cancel",
    title: "cancel / on_cancel (Protocol Lens)",
    tier: "kb",
    category: "API Actions",
    status: "source-confirmed (routing; payloads in 36–48)",
    sources: [
      "ONDC-RET-Specifications (cancellation, reason codes); ONDC-Protocol-Specs core API contract",
      "ONDC developer-docs `protocol-network-extension`",
    ],
    see_also: [
      "08-confirm-on_confirm",
      "17-reason-codes",
      "23-update-on_update",
    ],
    body: `## Objective

Explain **\`cancel\` / \`on_cancel\`** from a protocol lens — buyer/seller cancellation with reason codes — covering routing, handshake and correlation. Does NOT cover returns/part-cancel (see \`23-update-on_update\`) or the reason-code list itself (see \`17-reason-codes\`).

## Prerequisite

- A confirmed order (see \`08\`) and a valid cancellation **reason code** (see \`17\`).

## Deliverable

A cancelled order with the reason recorded, reflected in \`on_cancel\`.

## The action, in one line

\`cancel\` = a **cancellation request** carrying a reason code; \`on_cancel\` = the **updated (cancelled) order**. **Peer-to-peer** — no gateway.

## Guideline (the round trip)

1. **Initiator signs** \`cancel\` (order id + **reason code**) and POSTs **directly** to the counterparty.
2. **Receiver verifies**, returns synchronous **ACK/NACK**.
3. **Receiver sends** async **\`on_cancel\`** (cancelled order state) **directly** back, signed.
4. Correlate by \`message_id\` within the \`transaction_id\`.

## Protocol nuances (why this is ONDC-peculiar)

- **Reason code is mandatory** and drives refund/settlement — free-text won't do (see \`17\`).
- **Either side can initiate** — buyer or seller cancel; force-cancellation is a distinct, controlled path.
- **Cancel vs update.** Full cancellation is \`cancel\`; partial cancellation / returns go through \`update\` (see \`23\`).
- **Peer-to-peer, one header**; \`transaction_id\` continues.

## Sources

- ONDC-RET-Specifications (cancellation, reason codes); ONDC-Protocol-Specs core API contract
- ONDC developer-docs \`protocol-network-extension\``,
  },
  {
    id: "23-update-on_update",
    title: "update / on_update (Protocol Lens)",
    tier: "kb",
    category: "API Actions",
    status: "source-confirmed (routing; payloads in 36–48)",
    sources: [
      "ONDC-RET-Specifications (returns, RTO/RTS); ONDC-Protocol-Specs core API contract",
      "ONDC developer-docs `protocol-network-extension`",
    ],
    see_also: [
      "08-confirm-on_confirm",
      "17-reason-codes",
      "22-cancel-on_cancel",
    ],
    body: `## Objective

Explain **\`update\` / \`on_update\`** from a protocol lens — post-order changes such as returns, part-cancellation and fulfillment edits — covering routing, handshake and correlation. Does NOT cover full cancellation (see \`22\`) or initial placement (\`08\`).

## Prerequisite

- A confirmed order (see \`08\`); for returns, a valid return **reason code** (see \`17\`).

## Deliverable

An amended order reflecting the requested post-order change, returned in \`on_update\`.

## The action, in one line

\`update\` = a **post-order change request** (return, part-cancel, fulfillment edit); \`on_update\` = the **amended order**. **Peer-to-peer** — no gateway.

## Guideline (the round trip)

1. **Initiator signs** \`update\` (what changes + any reason code) and POSTs **directly** to the counterparty.
2. **Receiver verifies**, returns synchronous **ACK/NACK**.
3. **Receiver sends** async **\`on_update\`** (amended order) **directly** back, signed.
4. Correlate by \`message_id\` within the \`transaction_id\`.

## Protocol nuances (why this is ONDC-peculiar)

- **\`update\` is the catch-all for post-order mutation** — returns, replacements, part-cancellations, fulfillment/detail edits all flow through it.
- **Returns carry reason codes** (see \`17\`) and feed settlement/RTO.
- **Targeted change.** \`update\` specifies *what* changes on an existing order; it does not re-place the order.
- **Peer-to-peer, one header**; \`transaction_id\` continues.

## Sources

- ONDC-RET-Specifications (returns, RTO/RTS); ONDC-Protocol-Specs core API contract
- ONDC developer-docs \`protocol-network-extension\``,
  },
  {
    id: "24-track-on_track",
    title: "track / on_track (Protocol Lens)",
    tier: "kb",
    category: "API Actions",
    status: "source-confirmed (routing; payloads in 36–48)",
    sources: [
      "ONDC-RET-Specifications; ONDC-LOG-Specifications; ONDC-Protocol-Specs core API contract",
      "ONDC developer-docs `protocol-network-extension`",
    ],
    see_also: ["08-confirm-on_confirm", "21-status-on_status"],
    body: `## Objective

Explain **\`track\` / \`on_track\`** from a protocol lens — requesting a tracking URL or coordinates — covering routing, handshake and correlation. Does NOT cover order-state semantics (see \`21-status-on_status\`).

## Prerequisite

- A confirmed order (see \`08\`) with a trackable fulfillment.

## Deliverable

A tracking reference (URL or coordinates) returned to the buyer.

## The action, in one line

\`track\` = the BAP's **tracking request** for a fulfillment; \`on_track\` = the BPP's **tracking URL / coordinates**. **Peer-to-peer** — no gateway.

## Guideline (the round trip)

1. **BAP signs** \`track\` (order/fulfillment reference) and POSTs **directly to \`bpp_uri\`**.
2. **BPP verifies**, returns synchronous **ACK/NACK**.
3. **BPP sends** async **\`on_track\`** (tracking URL/coordinates) **directly to \`bap_uri\`**, signed.
4. Correlate by \`message_id\` within the \`transaction_id\`.

## Protocol nuances (why this is ONDC-peculiar)

- **Tracking, not state.** \`on_track\` returns *where* (URL/coordinates); order/fulfillment *state* is \`status\` (see \`21\`).
- **Availability varies.** Not every fulfillment type supports live tracking; the BPP may return a URL rather than coordinates.
- **Peer-to-peer, one header**; \`transaction_id\` continues.

## Sources

- ONDC-RET-Specifications; ONDC-LOG-Specifications; ONDC-Protocol-Specs core API contract
- ONDC developer-docs \`protocol-network-extension\``,
  },
  {
    id: "25-rating-support",
    title: "rating / support (Protocol Lens)",
    tier: "kb",
    category: "API Actions",
    status: "source-confirmed (routing; payloads in 36–48)",
    sources: [
      "ONDC-RET-Specifications; ONDC-Protocol-Specs core API contract (`protocol-specifications/core/v0/api/core.yaml`)",
      "ONDC developer-docs `protocol-network-extension`",
    ],
    see_also: ["08-confirm-on_confirm"],
    body: `## Objective

Explain **\`rating\` / \`on_rating\`** and **\`support\` / \`on_support\`** from a protocol lens — post-fulfillment feedback and support-contact exchange — covering routing and handshake. Does NOT cover formal disputes (IGM issue/grievance).

## Prerequisite

- A confirmed / fulfilled order (see \`08\`).

## Deliverable

A submitted rating (acknowledged) and/or support contact details returned to the buyer.

## The actions, in one line

\`rating\` = the BAP submits **feedback** (rating value + category); \`support\` = the BAP requests **support-contact details**; each has an \`on_\` callback. **Peer-to-peer** — no gateway.

## Guideline (each round trip)

1. **BAP signs** \`rating\` / \`support\` and POSTs **directly to \`bpp_uri\`**.
2. **BPP verifies**, returns synchronous **ACK/NACK**.
3. **BPP sends** async **\`on_rating\`** (ack / feedback form) or **\`on_support\`** (contact details) **directly to \`bap_uri\`**, signed.
4. Correlate by \`message_id\` within the \`transaction_id\`.

## Protocol nuances (why this is ONDC-peculiar)

- **Feedback / help, not disputes.** \`rating\` and \`support\` are lightweight; a formal complaint is Issue & Grievance Management (IGM), a separate flow.
- **\`on_rating\` may return a form** — some implementations respond with a rating form/category rather than a bare ack.
- **Peer-to-peer, one header**; \`transaction_id\` continues.

## Sources

- ONDC-RET-Specifications; ONDC-Protocol-Specs core API contract (\`protocol-specifications/core/v0/api/core.yaml\`)
- ONDC developer-docs \`protocol-network-extension\``,
  },
  {
    id: "26-key-generation",
    title: "Key Generation",
    tier: "kb",
    category: "Security & Auth",
    status: "source-confirmed",
    sources: [
      "ONDC developer-docs `registry/Onboarding of Participants.md`",
      "ONDC reference-implementations `utilities/signing_and_verification`",
    ],
    see_also: [
      "02-onboarding-subscribe",
      "27-digest-generation",
      "28-authorization-header-creation",
      "30-key-rotation",
    ],
    body: `## Objective

Explain generating an NP's **two key pairs** — Ed25519 for signing and X25519 for encryption. Covers what each is for and how they differ. Does NOT cover registering them (see \`02-onboarding-subscribe\`) or signing a request (see \`28-authorization-header-creation\`).

## Prerequisite

- An NP preparing to onboard, with access to the NP Portal (keys are generated in the portal for v1.1) or libsodium / Node.js \`crypto\`.

## Deliverable

A **signing key pair** (Ed25519) and an **encryption key pair** (X25519), plus a \`unique_key_id\` tying them to the subscriber.

## The two key pairs

| | Signing | Encryption |
|---|---|---|
| Algorithm | **Ed25519** | **X25519** |
| Public | \`signing_public_key\` (base64) | \`encr_public_key\` (ASN.1 DER → base64) |
| Private | \`signing_private_key\` (base64) | base64 |
| Used for | Sign the signing string + the onboarding \`request_id\` (**without hashing**) | Derive a shared key for the onboarding challenge / payload encryption |

## Guideline

1. Generate the **Ed25519** signing pair → \`signing_public_key\` / \`signing_private_key\`.
2. Generate the **X25519** encryption pair → public as **ASN.1 DER** then base64, private base64.
3. Assign a **\`unique_key_id\`** to the pair (identifies this key set in \`keyId\` and at lookup).
4. Register the public keys via onboarding (see \`02\`).

## Protocol nuances (why this is ONDC-peculiar)

- **Two distinct algorithms, two distinct jobs.** Ed25519 = signing; X25519 = encryption. They are not interchangeable, and swapping them is a common onboarding failure.
- **Encryption public key is ASN.1 DER-encoded** (then base64) — not raw bytes like the signing key.
- **Signing signs the string directly** — no pre-hash of the signing string (the digest step hashes the *body*, not the signing string; see \`27\` / \`28\`).
- **\`unique_key_id\` lets one NP hold multiple keys** — the basis for rotation (see \`30\`) and multiple subscriber types.

## Sources

- ONDC developer-docs \`registry/Onboarding of Participants.md\`
- ONDC reference-implementations \`utilities/signing_and_verification\``,
  },
  {
    id: "27-digest-generation",
    title: "Digest Generation — BLAKE-512",
    tier: "kb",
    category: "Security & Auth",
    status: "source-confirmed",
    sources: [
      "ONDC developer-docs `registry/signing-verification.md`",
      "ONDC `ondc-crypto-sdk-go` (byte-exact BLAKE-512, no canonicalization)",
    ],
    see_also: ["01-signature-verification", "28-authorization-header-creation"],
    body: `## Objective

Explain hashing the request **body** with **BLAKE-512** to produce the \`digest\` that goes into the signing string. Does NOT cover building the header/signature (see \`28\`) or verification (see \`01\`).

## Prerequisite

- The exact request body bytes to be sent.

## Deliverable

A base64 \`digest\` over the request body, ready to place in the signing string.

## The rule, in one line

Hash the request body with **BLAKE-512** (\`blake2b\`, 64-byte output) and base64-encode it — over the payload **exactly as passed**, with **no canonicalization**.

## Guideline

1. Take the request body **exactly as it will be sent** (byte-for-byte).
2. Compute **BLAKE-512** over those bytes (\`blake2b.New(64, nil)\` in the Go SDK).
3. Base64-encode (standard encoding) → the \`digest\` value.
4. Place it in the signing string as \`digest: BLAKE-512=<base64>\` (see \`28\`).

## Protocol nuances (why this is ONDC-peculiar)

- **Byte-exact, no canonicalization.** The digest is over the payload as-passed; the SDK does no JSON parse/re-serialize. Re-serializing before hashing breaks the digest.
- **"Minified" is a convention, not an algorithm step.** Both sides must hash the *identical* byte string; minifying is just the agreed way to guarantee that. A serialization mismatch = verification fails.
- **Digest hashes the body, not the signing string.** The signing string (with \`created\`/\`expires\`/\`digest\`) is later signed **without** its own hash step.
- **BLAKE-512, not SHA.** Using the wrong hash is a silent interop failure.

## Sources

- ONDC developer-docs \`registry/signing-verification.md\`
- ONDC \`ondc-crypto-sdk-go\` (byte-exact BLAKE-512, no canonicalization)`,
  },
  {
    id: "28-authorization-header-creation",
    title: "Authorization Header Creation",
    tier: "kb",
    category: "Security & Auth",
    status: "source-confirmed",
    sources: [
      "ONDC developer-docs `registry/signing-verification.md`",
      "ONDC `ondc-crypto-sdk-go`; reference-implementations `utilities/signing_and_verification`",
    ],
    see_also: [
      "01-signature-verification",
      "03-lookup",
      "05-gateway-interaction",
      "26-key-generation",
      "27-digest-generation",
    ],
    body: `## Objective

Explain building the **\`Authorization\` header** on an outbound request — assembling \`created\`, \`expires\`, \`digest\`, the Ed25519 \`signature\`, and \`keyId\`. This is the sender side of signing. Does NOT cover the gateway header (see \`05\`) or verification (see \`01\`).

## Prerequisite

- A registered Ed25519 signing key pair and its \`unique_key_id\` (see \`26\`).
- The request body and its BLAKE-512 \`digest\` (see \`27\`).

## Deliverable

A request carrying a valid \`Authorization: Signature …\` header, ready to send peer-to-peer or via the gateway.

## Guideline (build order)

1. **Digest** the body (BLAKE-512, base64 — see \`27\`).
2. **Timestamps** — \`created\` = now (unix), \`expires\` = now + validity (unix; SDK default \`created + 3600s\`).
3. **Build the signing string** — three newline-separated lines:
   \`\`\`
   (created): <unix>
   (expires): <unix>
   digest: BLAKE-512=<base64>
   \`\`\`
4. **Sign** the byte-exact signing string with **Ed25519** (\`crypto_sign_detached\`) → base64 \`signature\`. No extra hashing of this string.
5. **Assemble the header** (note the single spaces in \`headers\`):
   \`\`\`
   Signature keyId="<subscriber_id>|<unique_key_id>|ed25519",algorithm="ed25519",created="<unix>",expires="<unix>",headers="(created) (expires) digest",signature="<base64>"
   \`\`\`

## Protocol nuances (why this is ONDC-peculiar)

- **The signing string is signed byte-exact — use the spaced form.** Production verifiers accept the **spaced** byte form: \`(created): <ts>\\n(expires): <ts>\\ndigest: BLAKE-512=<b64>\` and \`headers="(created) (expires) digest"\` (single spaces between the three). The older no-space registry-doc form is wrong; a byte difference fails an otherwise-valid signature. Confirmed authoritative header, e.g.:
  \`\`\`
  Signature keyId="buyer-app.ondc.org|207|ed25519",algorithm="ed25519",created="1641287875",expires="1641291475",headers="(created) (expires) digest",signature="fKQW…+Bw=="
  \`\`\`
- **Ed25519 signs the string directly** — no pre-hash of the signing string (only the body is hashed, into \`digest\`).
- **\`keyId\` = \`subscriber_id|unique_key_id|ed25519\`** — the receiver splits it to fetch your key (see \`03\`).
- **\`expires\` bounds validity** — SDK default is \`created + 3600s\`; a receiver rejects \`created\` in the future or \`now > expires\`.

## Sources

- ONDC developer-docs \`registry/signing-verification.md\`
- ONDC \`ondc-crypto-sdk-go\`; reference-implementations \`utilities/signing_and_verification\``,
  },
  {
    id: "29-registry-caching",
    title: "Registry Caching of Public Keys",
    tier: "kb",
    category: "Security & Auth",
    status: "source-confirmed",
    sources: [
      "ONDC developer-docs `registry/signing-verification.md` (cached-copy note)",
      "ONDC developer-docs `registry/Onboarding of Participants.md`",
    ],
    see_also: ["03-lookup", "30-key-rotation"],
    body: `## Objective

Explain caching subscriber **public keys** to avoid a registry \`/lookup\` on every inbound request, and when to invalidate. Does NOT cover the lookup call itself (see \`03-lookup\`) or rotation (see \`30-key-rotation\`).

## Prerequisite

- A working \`/v2.0/lookup\` path (see \`03\`) and inbound requests to verify.

## Deliverable

A local cache of public keys keyed by \`subscriber_id + unique_key_id\`, kept correct across rotation.

## The idea, in one line

Cache each subscriber's public key **by \`subscriber_id + unique_key_id\`** so verification doesn't hit \`/lookup\` per request — and **re-fetch on a verification failure**, since the key may have rotated.

## Guideline

1. On first need, resolve the key via \`/v2.0/lookup\` and cache it under \`subscriber_id + unique_key_id\`.
2. Serve subsequent verifications from the cache.
3. On a **verification failure**, invalidate that entry and **re-fetch** (the key may have rotated).
4. Apply a TTL to bound staleness.

## Protocol nuances (why this is ONDC-peculiar)

- **Cache key must include \`unique_key_id\`.** An NP can hold multiple keys; caching by \`subscriber_id\` alone returns the wrong key after rotation.
- **Failure is the invalidation signal.** A previously-valid signature that now fails is the cue to drop the cache entry and re-lookup — not to NACK outright.
- **Freshness vs load trade-off.** Longer TTL = fewer lookups but slower to see a rotated key; the failure-triggered re-fetch is the safety net.

## Sources

- ONDC developer-docs \`registry/signing-verification.md\` (cached-copy note)
- ONDC developer-docs \`registry/Onboarding of Participants.md\``,
  },
  {
    id: "30-key-rotation",
    title: "Key Rotation",
    tier: "kb",
    category: "Security & Auth",
    status: "source-confirmed",
    sources: [
      "ONDC developer-docs `registry/signing-verification.md` (`keyId` / `unique_key_id` usage)",
      "ONDC developer-docs `registry/Onboarding of Participants.md`",
    ],
    see_also: ["26-key-generation", "29-registry-caching"],
    body: `## Objective

Explain rotating an NP's signing/encryption keys **without downtime**, using \`unique_key_id\` and multiple registered keys. Does NOT cover initial key generation (see \`26\`) or caching mechanics (see \`29\`).

## Prerequisite

- An onboarded NP with at least one registered key pair and its \`unique_key_id\`.

## Deliverable

A new active key registered and in use, with in-flight requests signed by the old key still verifiable during the overlap.

## The idea, in one line

Rotate by **registering a new key with a new \`unique_key_id\`** and running both keys in parallel during an overlap window, so nothing signed with the old key fails mid-flight.

## Guideline

1. Generate a new key pair (see \`26\`) and a new **\`unique_key_id\`**.
2. Register it (the registry holds **multiple keys** per NP, distinguished by \`unique_key_id\`).
3. Start signing new requests with the new key (its \`keyId\` carries the new \`unique_key_id\`).
4. Keep the old key valid during an **overlap window** so receivers can still verify in-flight requests signed with it (they resolve by \`subscriber_id + unique_key_id\`).
5. Retire the old key after the window.

## Protocol nuances (why this is ONDC-peculiar)

- **\`unique_key_id\` is what makes zero-downtime rotation possible** — each key is independently resolvable, so old and new can coexist.
- **Receivers resolve by \`subscriber_id + unique_key_id\`** — a rotated request just points at the new key; caches invalidate on failure and re-fetch (see \`29\`).
- **Overlap, don't cut over hard.** Retiring the old key before in-flight requests drain will fail their verification.

## Sources

- ONDC developer-docs \`registry/signing-verification.md\` (\`keyId\` / \`unique_key_id\` usage)
- ONDC developer-docs \`registry/Onboarding of Participants.md\``,
  },
  {
    id: "31-gcr-global-catalog-repository",
    title: "GCR — Global Catalog Repository",
    tier: "kb",
    category: "Catalog & Discovery",
    status: "source-confirmed (GCR PRD)",
    sources: [
      "ONDC GCR PRD (Global Catalog Repository) + GCR SwaggerHub API",
      "ONDC `catalog-rejection` spec (`ondc-official.github.io/catalog-rejection`)",
    ],
    see_also: [
      "07-search-on_search",
      "36-catalog-object-model",
      "37-catalog-refresh",
      "40-catalog-store-rejection",
    ],
    body: `## Objective

Explain the **Global Catalog Repository (GCR)** — an ONDC 2.0 infrastructure component that centralizes, standardizes, validates and distributes catalog data — and how it changes the \`search\` / \`on_search\` flow for Buyer and Seller Apps. Does NOT cover the catalog object model itself (see \`36\`) or the rejection payload schema (see \`40\`).

## Prerequisite

- Familiarity with the normal discovery flow (\`search\` via gateway → sellers reply \`on_search\` direct — see \`07\`, \`36\`, \`37\`).

## Deliverable

Buyer and Seller Apps integrated with GCR: sellers push their catalog **once** to GCR; buyers pull a validated, enriched catalog **from** GCR instead of from every seller.

## What GCR is, in one line

GCR is the network's **single source of truth for catalog data** — sellers publish once to GCR, GCR validates/enriches/caches it, and buyers pull from GCR — replacing the decentralized model where every buyer ingests from every seller.

## Why it exists (the M×N problem)

With **M** Buyer Apps and **N** Seller Apps, the current model costs **M×N** \`on_search\` exchanges for a full catalog, repeated daily. GCR collapses this:
- **Sellers:** push **M×N → N** (publish once to GCR); after the first full ingest, daily full pushes drop to **0** (only incremental updates thereafter).
- **Buyers:** the daily full pull eventually **diminishes to 0** — everything arrives as incremental updates from GCR.
- Plus: consolidated catalog rejection, unified search, Gzip-compressed payloads, lower ingestion cost.

## How NPs interact with GCR

NPs use the **same \`/search\` + \`/on_search\` construct** — GCR sits in the middle. Pre-Prod details:

| Role | GCR detail | Endpoint / id |
|---|---|---|
| Seller Apps | GCR subscriber_id (GCR → seller search, seller → GCR on_search) | \`pre-prod.gcr.ondc.org\` |
| Buyer Apps | send \`search\` to GCR | \`https://preprod.gateway.ondc.org/search\` |
| Seller Apps | respond with \`on_search\` to GCR | \`https://pre-prod.gcr.ondc.org/on_search\` |
| Seller Apps | trigger on-demand full-catalog pull | \`http://pre-prod.gcr.ondc.org/mgmt/api/v1/catalog/pull\` |

## Generic vs buyer-specific catalog (the key distinction)

GCR tells them apart by the **\`bap_id\`** in the seller's \`on_search\`:
- **Generic catalog** — same for all buyers → seller uses the **GCR subscriber_id as \`bap_id\`**. GCR fans it to all permitted buyers.
- **Buyer-specific catalog** — different price/attributes per buyer (e.g. price Pr1 to B1, Pr2 to B2) → seller uses the **specific Buyer App's subscriber_id as \`bap_id\`**; GCR shares it only with that buyer.

## Seller App Authorization

The equivalent of a seller's ACK/NACK choice in the current construct: the seller controls **whether GCR may share its \`on_search\` catalog with a given Buyer App**, and can update these access policies. GCR honours it before distributing.

## Phase 1 features

Catalog repository (GCR pulls/refreshes from sellers) · buyer full-catalog pull (current search construct) · seller on-demand full pull · incremental catalog pull (buyers subscribe) · incremental push (generic + buyer-specific) · **protocol validation** (static schema checks) · **catalog rejection** (static + dynamic, relayed both ways) · caching · **seller authorization** · buyer-app deeplinks in the rejection report · **Gzip** compression (GCR → buyer always Gzip; seller → GCR json or Gzip, Gzip recommended).

## Changes required

**Buyer Apps:** still send \`search\` to the gateway (Must); stop the daily full-catalog cron (Recommended, on-demand instead); **consume \`on_search\` from GCR** (Must); **subscribe to GCR** for incremental updates (Must); send catalog rejection to **GCR** (which forwards to sellers) with the added success-provider + deeplink details (Must).

**Seller Apps:** **whitelist the GCR subscriber_id** and recognize search from GCR (Must); if \`bap_id\` = GCR → ACK and send \`on_search\` to GCR; if \`bap_id\` = a Buyer App → ACK/NACK only, do **not** send \`on_search\` (GCR serves the buyer) (Must); during ingestion send **generic full catalog first** (bap_id = GCR), then buyer-specific full/incremental (bap_id = buyer) (Must if buyer-specific exists); send incremental updates to GCR (Must).

## Protocol nuances (why this is ONDC-peculiar)

- **\`bap_id\` is the routing switch** — it's how GCR classifies generic vs buyer-specific and how a seller knows whether a search is from GCR or a buyer.
- **Two rejection paths** — one **from GCR** at ingestion (rejections + successful providers, no deeplink), and one **from a Buyer App forwarded through GCR** (identified by an \`x-gateway-authorization\` header carrying the **GCR signature**, and a **different transaction_id** from GCR's original search).
- **\`on_search\` no longer comes from sellers to buyers directly** — GCR becomes the buyer's \`on_search\` source. This is a real change from the peer-to-peer \`on_search\` in the base construct (see \`07\`).
- **Pre-Prod only today** — GCR is available in Pre-Prod for NP testing.

## Sources

- ONDC GCR PRD (Global Catalog Repository) + GCR SwaggerHub API
- ONDC \`catalog-rejection\` spec (\`ondc-official.github.io/catalog-rejection\`)`,
  },
  {
    id: "32-environment-matrix",
    title: "Environment Matrix — Pre-Prod / Prod",
    tier: "kb",
    category: "Network Policy",
    status: "source-confirmed",
    sources: [
      "ONDC-Official profile README — Gateway and Registry Endpoints",
      "ONDC developer-docs `registry/Onboarding of Participants.md`",
    ],
    see_also: ["02-onboarding-subscribe"],
    body: `## Objective

State the ONDC **environments** and their gateway/registry endpoints and behavioural differences. Does NOT cover onboarding steps (see \`02\`).

## Prerequisite

- Knowing which environment you are targeting.

## The environments

**Two live environments: Pre-Prod and Prod. Staging is deprecated.**

| | Registry (lookup 2.0) | Gateway |
|---|---|---|
| Pre-Prod | \`https://preprod.registry.ondc.org/v2.0/lookup\` | \`https://preprod.gateway.ondc.org/search\` |
| Production | \`https://prod.registry.ondc.org/v2.0/lookup\` | \`https://prod.gateway.ondc.org/search\` |

## Behavioural differences

- **DNS challenge is Production-only.** Pre-Prod subscribes directly via the portal journey; Prod additionally requires the \`ondc-signature\` + \`ondc-challenge\` DNS TXT records (see \`02\`).
- **Isolation.** Each environment is a separate registry host; a subscriber in one is not visible in the other.
- **No \`/ondc/\` path prefix** on lookup 2.0 in either environment.

## Guideline

1. Pick endpoints by environment from the table above.
2. In Pre-Prod, complete onboarding via the portal only; in Prod, also publish the DNS TXT records.
3. Never mix environment keys/hosts — the ONDC public key and hosts differ per environment.

## Protocol nuances (why this is ONDC-peculiar)

- **Staging is gone** — only Pre-Prod and Prod remain; older docs listing three environments are stale.
- **Endpoints are time-bound** — verify against the ONDC-Official "Gateway and Registry Endpoints" list before use.

## Sources

- ONDC-Official profile README — Gateway and Registry Endpoints
- ONDC developer-docs \`registry/Onboarding of Participants.md\``,
  },
  {
    id: "33-domain-version-enablement",
    title: "Domain & Version Enablement",
    tier: "kb",
    category: "Network Policy",
    status: "source-confirmed",
    sources: [
      "ONDC developer-docs (enabled domains / versions)",
      "ONDC automation-specifications (per-domain-version branches)",
    ],
    see_also: [
      "14-schema-validation",
      "16-validation-rules",
      "48-fulfillment-states-tat",
    ],
    body: `## Objective

Explain which **domains / use-cases** and **contract versions** are live on ONDC and how they're identified. Does NOT define item attributes (see \`48-taxonomy\`).

## Prerequisite

- A \`context\` carrying \`domain\` and \`core_version\`.

## Deliverable

Correct \`domain\` + \`core_version\` values so messages route and validate against the right enabled contract.

## The idea, in one line

Only specific **\`domain\` codes** (e.g. \`ONDC:RET11\`, \`ONDC:LOG11\`, \`ONDC:FIS12\`) and **\`core_version\`s** are enabled at any time; both must be set in \`context\` and both must be currently supported.

## Guideline

1. Set \`context.domain\` to an enabled domain code and \`context.core_version\` to a supported version.
2. Validate payloads against the schema/config for **that** domain+version (see \`14\`, \`16\`).
3. Track enablement — the live set changes as domains/versions are added or deprecated.

## Protocol nuances (why this is ONDC-peculiar)

- **Domain code drives everything downstream** — schema, validations, error codes and gateway routing are all per domain+version.
- **Version matters for validation** — the automation-specifications config lives on per-domain-version branches (e.g. \`draft-RET11-1.2.5\`); use the matching one.
- **The enabled list is external** — maintained by ONDC (Enabled Domains sheet), not derivable from the payload.

## Sources

- ONDC developer-docs (enabled domains / versions)
- ONDC automation-specifications (per-domain-version branches)`,
  },
  {
    id: "34-transaction-id",
    title: "transaction_id",
    tier: "kb",
    category: "Message Mechanics",
    status: "source-confirmed",
    sources: [
      "ONDC developer-docs `protocol-network-extension`",
      "ONDC-Protocol-Specs core API contract (context object)",
    ],
    see_also: ["35-message-id"],
    body: `## Objective

Explain generating and preserving **\`transaction_id\`** across one order journey. Does NOT cover \`message_id\` (see \`35\`).

## Prerequisite

- A \`context\` block on every message.

## Deliverable

A single \`transaction_id\` that ties every message of one order journey together.

## The rule, in one line

\`transaction_id\` is generated once (by the BAP, at \`search\`) and **stays constant across the whole journey** — search → select → init → confirm → all post-order actions and callbacks.

## Guideline

1. The BAP generates a \`transaction_id\` (UUID) at the start of a journey (\`search\`).
2. Every subsequent \`action\` and \`on_action\` for that order **reuses the same** \`transaction_id\`.
3. Use it to group/trace all messages of one order.

## Protocol nuances (why this is ONDC-peculiar)

- **One journey = one \`transaction_id\`.** It does not change per step; only \`message_id\` changes per request/callback pair.
- **It's the grouping key** for logs, settlement and grievance — a wrong/rotated \`transaction_id\` breaks correlation across the order.
- **Constant across roles** — BAP, BPP and gateway all carry the same value for that journey.

## Sources

- ONDC developer-docs \`protocol-network-extension\`
- ONDC-Protocol-Specs core API contract (context object)`,
  },
  {
    id: "35-message-id",
    title: "message_id",
    tier: "kb",
    category: "Message Mechanics",
    status: "source-confirmed",
    sources: [
      "ONDC developer-docs `protocol-network-extension`",
      "ONDC-Protocol-Specs core API contract (context object)",
    ],
    see_also: ["13-idempotency-retries", "34-transaction-id"],
    body: `## Objective

Explain **\`message_id\`** uniqueness per request and how it matches a request to its callback. Does NOT cover \`transaction_id\` (see \`34\`).

## Prerequisite

- A \`context\` block on every message.

## Deliverable

A \`message_id\` scheme that lets each \`action\` be correlated to its \`on_action\`.

## The rule, in one line

\`message_id\` is **unique per request**, and a request and its \`on_\` callback **share the same \`message_id\`** — that's how \`on_select\` is matched to its \`select\`.

## Guideline

1. Generate a new \`message_id\` (UUID) for each **new** \`action\` request.
2. The receiver echoes the **same** \`message_id\` in the corresponding \`on_action\`.
3. Correlate request↔callback by \`message_id\`; dedupe repeated callbacks by it (see \`13\`).

## Protocol nuances (why this is ONDC-peculiar)

- **Pair key, not journey key.** \`message_id\` pairs one request with its callback; \`transaction_id\` spans the whole order (see \`34\`).
- **Shared across the pair** — the callback deliberately reuses the request's \`message_id\`, unlike a fresh request which gets a new one.
- **Reuse it on retries** of the same request (see \`13\`) so the receiver can dedupe; a new id would look like a new request.

## Sources

- ONDC developer-docs \`protocol-network-extension\`
- ONDC-Protocol-Specs core API contract (context object)`,
  },
  {
    id: "36-catalog-object-model",
    title: "Catalog Object Model",
    tier: "kb",
    category: "Catalog & Discovery",
    status: "source-confirmed (RET11)",
    sources: [
      "ONDC-RET-Specifications; ONDC-Protocol-Specs core API contract",
      "ONDC automation-specifications `config/attributes` (branch `draft-RET11-1.2.5`)",
    ],
    see_also: [
      "07-search-on_search",
      "37-catalog-refresh",
      "38-item-variants-customizations",
      "39-serviceability",
    ],
    body: `## Objective

Explain how a catalog is structured in \`on_search\` — providers, items, categories, fulfillments. Does NOT cover incremental refresh (see \`37\`) or item variants (see \`38\`).

## Prerequisite

- A \`search\` → \`on_search\` exchange (see \`07\`).

## Deliverable

A well-formed \`catalog\` in \`on_search\` that a BAP can render and select from.

## The structure, in one line

\`on_search.message.catalog\` = a **BPP descriptor** holding **providers**, each with **items**, **categories**, **fulfillments**, **locations**, and **offers** — the item is the sellable unit.

## Guideline (the nesting)

1. **Catalog** → \`bpp/descriptor\` + \`bpp/providers[]\` (+ \`bpp/fulfillments\`).
2. **Provider** → \`descriptor\`, \`locations[]\`, \`categories[]\`, \`items[]\`, \`fulfillments[]\`, \`offers[]\`, \`tags\`.
3. **Item** → \`descriptor\`, \`price\`, \`category_id\`, \`fulfillment_id\`, \`location_id\`, quantity/availability, \`tags\`.
4. **Category / Fulfillment / Location** are referenced by id from items.

## Real fields (RET11 F&B attributes)

- **Item ids/links:** \`category_id\`, \`category_ids\` (colon-separated \`category:subcategory\`), \`fulfillment_id\`, \`location_id\`, \`parent_item_id\` (links a customization/child item to its base item — see \`38\`).
- **Item \`@ondc/org\` tags:** \`returnable\`, \`cancellable\`, \`available_on_cod\`, \`return_window\` (ISO8601), \`seller_pickup_return\`, \`time_to_ship\` (ISO8601), \`contact_details_consumer_care\`, \`statutory_reqs_packaged_commodities\`, \`statutory_reqs_prepackaged_food\`, \`fssai_license_no\`.
- **Provider:** \`locations[]\` (each with \`gps\` + a \`circle\` serviceability zone — see \`39\`), \`categories[]\` (\`id\` + \`descriptor.name\`, e.g. \`"Toppings (up to 2 options)"\` — used as customization groups), \`parent_category_id\` (category hierarchy), provider-level \`tags\` (timings, serviceability rules).
- **Price range:** items can carry lower/upper price-range tags spanning variants/offers.

## Protocol nuances (why this is ONDC-peculiar)

- **Id references, not nesting.** Items point at \`category_id\` / \`fulfillment_id\` / \`location_id\`; the referenced objects live alongside, not inside, the item.
- **\`tags\` carry the protocol detail.** Much ONDC-specific behaviour (serviceability, attributes, offers) rides in \`tags\` blocks, not first-class fields.
- **The item is the unit of selection** — \`select\` references item ids from this catalog.

## Sources

- ONDC-RET-Specifications; ONDC-Protocol-Specs core API contract
- ONDC automation-specifications \`config/attributes\` (branch \`draft-RET11-1.2.5\`)`,
  },
  {
    id: "37-catalog-refresh",
    title: "Full vs Incremental Catalog Refresh",
    tier: "kb",
    category: "Catalog & Discovery",
    status: "source-confirmed (RET11)",
    sources: [
      "ONDC-RET-Specifications",
      "ONDC automation-specifications `config/flows/F&B/FULL_CATALOG.yaml`, `INCREMENTAL_CATALOG*.yaml` (branch `draft-RET11-1.2.5`)",
    ],
    see_also: ["31-gcr-global-catalog-repository", "36-catalog-object-model"],
    body: `## Objective

Explain when to send a **full** catalog vs an **incremental** update in \`on_search\`, and the tags that drive it. Does NOT cover item modelling (see \`36\`).

## Prerequisite

- A catalog to publish (see \`36\`).

## Deliverable

A refresh strategy that keeps the BAP's catalog current without resending everything each time.

## The idea, in one line

A \`search\` can request the **full** catalog or an **incremental** delta; the mode and window are signalled via **tags** in the \`search\` intent and honoured in \`on_search\`.

## Real structure (RET11 F&B attributes)

The mode is declared in the **\`intent.tags\`** of the \`search\`: a tag group whose \`code\` names the catalog mode (e.g. **\`catalog_full\`** / **\`catalog_inc\`**) with a \`list\` entry \`code: mode\` and its value. The BPP reads this to decide whether to return the whole catalog or a delta. GCR uses the same construct (see \`31\`).

## Guideline

1. **Full** — return the complete catalog (initial pull or periodic full sync); intent tag = catalog-full.
2. **Incremental** — return only items/prices changed in the window; intent tag = catalog-incremental (\`catalog_inc\` + \`mode\`), buyer subscribed to updates.
3. Match the \`on_search\` mode to what the \`search\` requested.

## Protocol nuances (why this is ONDC-peculiar)

- **The mode is tag-driven.** Whether a search wants full or incremental (and the time window) is expressed in \`intent\` tags, not a top-level field.
- **Incremental cuts payload size** for large catalogs, but the BAP must merge deltas onto its held copy.
- **RET-specific flows exist** — the automation-specifications ship dedicated \`FULL_CATALOG\`, \`INCREMENTAL_CATALOG\`, and \`INCREMENTAL_CATALOG_PULL\` flows.

## Sources

- ONDC-RET-Specifications
- ONDC automation-specifications \`config/flows/F&B/FULL_CATALOG.yaml\`, \`INCREMENTAL_CATALOG*.yaml\` (branch \`draft-RET11-1.2.5\`)`,
  },
  {
    id: "38-item-variants-customizations",
    title: "Item Variants & Customizations",
    tier: "kb",
    category: "Catalog & Discovery",
    status: "source-confirmed (RET11)",
    sources: [
      "ONDC-RET-Specifications",
      "ONDC automation-specifications `config/attributes` (branch `draft-RET11-1.2.5`)",
    ],
    see_also: [
      "36-catalog-object-model",
      "42-taxonomy-codes",
      "43-quote-price-breakup",
    ],
    body: `## Objective

Explain modelling **variant groups**, **customizations** and attributes on catalog items. Does NOT cover price breakup (see \`43\`).

## Prerequisite

- A catalog with items (see \`36\`).

## Deliverable

Items whose variants (e.g. size/colour) and customizations (e.g. add-ons) are expressed so a BAP can present choices and a BPP can price them.

## The idea, in one line

**Variants** are alternate forms of an item grouped by a **variant group** (attribute-driven), and **customizations** are optional add-ons/choices — both modelled via item relationships and **tags**, not free-form fields.

## Real structure (RET11 F&B attributes)

- **Customization groups = provider \`categories\`.** A category \`id\` + \`descriptor.name\` names the group, e.g. \`"Toppings (up to 2 options)"\`, \`"Size"\`. Items reference the group via \`category_ids\` (\`category:subcategory\`).
- **\`parent_item_id\`** links a customization / child item back to its **base item**, expressing the item hierarchy (add-ons/variants nested under a base product). This \`items\` array is anchored in session as \`selected_items\` and replayed through \`select\` → \`init\` → \`confirm\`.
- **\`customization\` tag** on a selected item distinguishes a **base item** from a **customization** belonging to a specific customization group.
- **Variant grouping keys off defined item attributes** (from the taxonomy — see \`42\`), with lower/upper price-range tags spanning the variants.

## Guideline

1. Define the **customization/variant group** as a provider \`category\` (\`id\` + \`descriptor.name\`).
2. Mark customizations with the \`customization\` tag and link them to the base item via \`parent_item_id\`.
3. The BAP renders choices; the BPP prices the selected base+customization combination at \`select\`.

## Protocol nuances (why this is ONDC-peculiar)

- **Attribute-driven variants.** Variant grouping keys off defined item attributes (from the taxonomy — see \`42\`), not arbitrary labels.
- **Customizations carry their own ids and pricing** — they appear in the quote breakup at \`select\`/\`init\`.
- **Modelled in \`tags\` / related objects** — like most ONDC item detail, this rides in structured tag groups.

## Sources

- ONDC-RET-Specifications
- ONDC automation-specifications \`config/attributes\` (branch \`draft-RET11-1.2.5\`)`,
  },
  {
    id: "39-serviceability",
    title: "Serviceability (Geo / Pincode / Radius)",
    tier: "kb",
    category: "Catalog & Discovery",
    status: "source-confirmed (RET11)",
    sources: [
      "ONDC-RET-Specifications",
      "ONDC automation-specifications `config/attributes`, `config/errors/index.yaml` (branch `draft-RET11-1.2.5`)",
    ],
    see_also: [
      "15-error-codes",
      "36-catalog-object-model",
      "49-logistics-linkage",
    ],
    body: `## Objective

Explain how a provider expresses **where it serves** and rejects out-of-area requests. Does NOT cover logistics (see \`49\`).

## Prerequisite

- A catalog with provider locations (see \`36\`).

## Deliverable

Serviceability declarations that let a BAP filter, and a BPP correctly accept or reject by area.

## The idea, in one line

A provider declares its serviceable area — most commonly a **circle** (\`gps\` centre + \`radius\`) around a location, or by **pincode / geo-polygon** via serviceability tags — and requests outside it are rejected.

## Real structure (RET11 F&B attributes)

Each provider \`location\` carries:
- **\`gps\`** — the location's physical coordinates (\`"77.2045,28.5697"\`).
- **\`circle\`** — the serviceable zone: **\`circle.gps\`** (centre) + **\`circle.radius\`** = \`{ value: "3", unit: "km" }\`.

The BAP checks whether the buyer's delivery point falls inside the circle. Pincode-list and polygon serviceability are expressed via **\`@ondc/org/serviceability\` tags** on the location/fulfillment (tag types distinguish hyperlocal-circle vs pincode vs pan-India).

## Guideline

1. Declare serviceability per location — a \`circle\` (gps + radius value/unit), or a pincode/polygon serviceability tag.
2. On \`search\`/\`select\`, evaluate the buyer's delivery location against it.
3. If out of area, **reject** (NACK / serviceability error — see \`15\`, e.g. \`60001\`/\`60002\`).

## Protocol nuances (why this is ONDC-peculiar)

- **Multiple serviceability models** — pincode, geo-polygon, and radius all exist; a provider picks per location.
- **Out-of-area is an error, not an empty result** — the BPP signals it explicitly (serviceability error codes \`60001\`/\`60002\` in the logistics/RET error set — see \`15\`).
- **Expressed in tags** tied to locations/fulfillments.

## Sources

- ONDC-RET-Specifications
- ONDC automation-specifications \`config/attributes\`, \`config/errors/index.yaml\` (branch \`draft-RET11-1.2.5\`)`,
  },
  {
    id: "40-catalog-store-rejection",
    title: "Catalog & Store Rejection Framework",
    tier: "kb",
    category: "Catalog & Discovery",
    status: "source-confirmed (GCR + spec)",
    sources: [
      "ONDC `catalog-rejection` (framework doc + swagger)",
      "ONDC-RET-Specifications",
    ],
    see_also: ["22-cancel-on_cancel", "31-gcr-global-catalog-repository"],
    body: `## Objective

Explain reporting **rejected catalogs / stores** per the ONDC framework (Retail B2C). Does NOT cover order rejection (see \`22\`).

## Prerequisite

- A published catalog whose items/stores may be rejected by the BAP.

## Deliverable

Structured feedback on which catalog items or stores were rejected and why, per the framework's schema.

## The idea, in one line

When a BAP cannot list a seller's catalog item or store, it reports the **rejection with a reason** back to the BPP using the Catalog/Store Rejection framework, so sellers can fix and re-publish.

## Real structure (catalog-rejection spec + GCR)

- **Endpoint:** the BPP-side \`POST /catalog_rejection\` (per the \`catalog-rejection\` swagger, \`post_catalog_rejection\`).
- **Payload carries:**
  - **Rejection details** for the rejected **bpp / provider / item** (what was rejected and why).
  - (With GCR) **successful provider** details **plus the provider deeplink** — the URL where that provider can be accessed on the buyer app.
  - Additional **error scenarios and codes** beyond the base set (extended for the GCR flow).
- **Two report paths under GCR (see \`31\`):** one **from GCR** at ingestion (rejections + successful providers, no deeplink); one **from a Buyer App forwarded through GCR** (rejections + successful providers **with** deeplink), identifiable by the \`x-gateway-authorization\` GCR signature and a **different transaction_id** from GCR's ingestion search.

## Guideline

1. Evaluate incoming catalog items/stores against listing rules.
2. For each rejected bpp/provider/item, record the **reason** per the framework's schema; include successful providers + deeplinks where required.
3. \`POST /catalog_rejection\` back to the seller (directly, or via GCR which forwards it).

## Protocol nuances (why this is ONDC-peculiar)

- **Rejection is structured feedback, not silence.** The framework defines a schema/swagger for reporting, so rejections are actionable.
- **Catalog/store level, not order level** — this is about what can be *listed*, distinct from rejecting an *order* (see \`22\`).
- **Retail B2C scoped.**

## Sources

- ONDC \`catalog-rejection\` (framework doc + swagger)
- ONDC-RET-Specifications`,
  },
  {
    id: "41-static-terms",
    title: "Static Terms",
    tier: "kb",
    category: "Catalog & Discovery",
    status: "source-confirmed (repo)",
    sources: ["ONDC `static-terms`", "ONDC-RET-Specifications"],
    see_also: ["36-catalog-object-model"],
    body: `## Objective

Explain the **static terms** a domain requires NPs to host/publish. Does NOT cover the dynamic catalog (see \`36\`).

## Prerequisite

- An onboarded NP for the domain.

## Deliverable

Hosted static terms (the domain-mandated policy/terms content) referenced correctly on the network.

## The idea, in one line

Some domain terms are **static** — fixed policy/terms content NPs must publish (per the \`static-terms\` repo) — as opposed to the dynamic, per-transaction catalog.

## Real structure (\`static-terms\` repo)

- Static terms are **PDF files** hosted per NP, submitted to the ONDC \`static-terms\` repo by **fork + pull request** (maintainer-approved).
- **Path convention:** \`[DOMAIN]/[NP-Name]/[Version]/static_terms.pdf\` — e.g. \`RET/BNP/0.1.0/static_terms.pdf\`, \`LOG/LSP/0.1.0/static_terms.pdf\`.
- **Domains present:** \`RET\` (Retail), \`LOG\` (Logistics), \`FIS12\` (Financial Services), \`SRV\` (Services), \`TRV\` (Travel), \`ONEST\`.
- NP names use **hyphens, no spaces**; version folders hold successive iterations.

## Guideline

1. Author the domain's static terms as a **PDF**.
2. Submit via fork + PR under \`[DOMAIN]/[NP-Name]/[Version]/static_terms.pdf\`.
3. Reference the published terms where the contract expects (terms links in the order/catalog).

## Protocol nuances (why this is ONDC-peculiar)

- **Static ≠ catalog.** These are fixed terms/policies, not per-order data; they change rarely and are centrally defined.
- **Domain-specific** — the required set is per domain, maintained in \`static-terms\`.

## Sources

- ONDC \`static-terms\`
- ONDC-RET-Specifications`,
  },
  {
    id: "42-taxonomy-codes",
    title: "Taxonomy & Category / Domain Codes",
    tier: "kb",
    category: "Catalog & Discovery",
    status: "source-confirmed (Taxonomy v1.2)",
    sources: [
      "ONDC Category Taxonomy v1.2 (retail domain sheets RET10–RET18 + eB2B) + EB2B Category Taxonomy",
      "ONDC `Common-Taxonomy-Project`; developer-docs (Enabled Domains)",
    ],
    see_also: [
      "33-domain-version-enablement",
      "36-catalog-object-model",
      "38-item-variants-customizations",
    ],
    body: `## Objective

Explain the authoritative **category codes** (e.g. \`RET10\`, \`RET11\`, …) and **domain codes** used across ONDC. Does NOT define item attributes in detail (see \`38\`).

## Prerequisite

- A message needing a \`domain\` and item \`category_id\`.

## Deliverable

Correct, authoritative domain and category codes on catalog and context.

## The idea, in one line

Domains and categories are **enumerated codes** from the ONDC taxonomy — \`context.domain\` uses codes like \`ONDC:RET11\`; items use category codes from the Category Taxonomy — and only listed codes are valid.

## Retail domain codes (Category Taxonomy v1.2)

| Code | Domain | | Code | Domain |
|---|---|---|---|---|
| RET10 | Grocery | | RET15 | Appliances |
| RET11 | F&B | | RET16 | Home & Kitchen |
| RET12 | Fashion | | RET18 | Health & Wellness |
| RET13 | BPC (Beauty & Personal Care) | | RETeB2B | eB2B |
| RET14 | Electronics | | | |

Used as \`ONDC:RET10\` … in \`context.domain\`. Other verticals follow the same pattern: \`LOG\` (logistics), \`FIS\` (financial services), \`TRV\` (travel), \`SRV\` (services), \`ONEST\`.

## Category structure

- Each domain has its own **category list** with a \`category id\` and a \`parent_category_id\`. E.g. **F&B (RET11)** has ~72 categories (\`Biryani\`, \`Burger\`, \`Cakes\`, \`Dosa\`, \`Chaat\`, …) under parent \`F&B\`; **Grocery (RET10)** has ~39 (\`Fruits and Vegetables\`, \`Masala & Seasoning\`, \`Oil & Ghee\`, …).
- The taxonomy also defines, **per category, the mandatory (M) vs optional (O) item attributes** — e.g. Fashion \`Shirts\` require Gender/Colour/Size/Brand/Fabric; Electronics \`Mobile Phone\` requires Brand/Model/Colour/RAM. Items set \`category_id\` / \`category_ids\` from this list (see \`36\`, \`38\`).
- The taxonomy is **versioned** (v1.2, with a Changelog sheet).

## Guideline

1. Set \`context.domain\` to an enabled domain code (see \`33\`).
2. Set item \`category_id\` from the authoritative category taxonomy for that domain.
3. Keep to the enumerated codes — custom codes fail validation.

## Protocol nuances (why this is ONDC-peculiar)

- **Codes are authoritative and centrally maintained** (Common Taxonomy Project + Enabled Domains). Don't invent category/domain codes.
- **Domain code shapes routing + schema** (see \`33\`), category code shapes discovery/attributes.
- **Versioned** — taxonomy evolves; use the current set for the domain/version.

## Sources

- ONDC Category Taxonomy v1.2 (retail domain sheets RET10–RET18 + eB2B) + EB2B Category Taxonomy
- ONDC \`Common-Taxonomy-Project\`; developer-docs (Enabled Domains)`,
  },
  {
    id: "43-quote-price-breakup",
    title: "Quote & Price Breakup",
    tier: "kb",
    category: "Order Lifecycle",
    status: "source-confirmed (RET11)",
    sources: [
      "ONDC-RET-Specifications; ONDC-Protocol-Specs core API contract",
      "ONDC automation-specifications `config/validations/index.yaml` (branch `draft-RET11-1.2.5`)",
    ],
    see_also: ["12-ttl-handling", "16-validation-rules", "19-select-on_select"],
    body: `## Objective

Explain the structure of \`quote.breakup\`, totals and the quote TTL. Does NOT cover settlement/reconciliation (out of scope).

## Prerequisite

- A \`select\` → \`on_select\` (or \`init\`) that returns a quote (see \`19\`).

## Deliverable

A quote whose line items sum to its total and whose validity is bounded.

## The idea, in one line

\`quote\` = a **\`price\` total** plus a **\`breakup[]\`** of line items, where the breakup **must reconcile to the total**.

## Real breakup titles (RET11)

Each breakup line carries a title/type, a price, and (for item lines) the item reference. Confirmed title values include: **item**, **Tax**, **Delivery**, **Discount** (\`discount\`), **Packing**, **Convenience Fee**. Delivery charges and taxes appear as their own titled lines; discounts are negative lines.

## Guideline

1. Build \`quote.breakup[]\` with a titled line per charge (item, tax, delivery, discount, …).
2. Set \`quote.price\` = the sum of the breakup.
3. Bind validity with the quote's TTL; a stale quote must be re-fetched.

## Protocol nuances (why this is ONDC-peculiar)

- **Breakup must sum to total** — a cross-field \`x-validation\` (see \`16\`); a mismatch is rejected.
- **Titled line items** — each breakup entry is typed/titled, not free-form, so BAP and settlement can interpret it.
- **Quote has a TTL** — act within it; \`on_confirm\` after expiry is invalid (see \`12\`).

## Sources

- ONDC-RET-Specifications; ONDC-Protocol-Specs core API contract
- ONDC automation-specifications \`config/validations/index.yaml\` (branch \`draft-RET11-1.2.5\`)`,
  },
  {
    id: "44-order-state-machine",
    title: "Order State Machine",
    tier: "kb",
    category: "Order Lifecycle",
    status: "source-confirmed (RET11)",
    sources: [
      "ONDC-RET-Specifications; ONDC-Protocol-Specs core API contract",
      "ONDC automation-specifications `config/actions/index.yaml` (branch `draft-RET11-1.2.5`)",
    ],
    see_also: [
      "08-confirm-on_confirm",
      "18-action-catalogue-lifecycle",
      "21-status-on_status",
      "24-track-on_track",
      "45-payment-terms",
    ],
    body: `## Objective

Explain the valid **order / fulfillment state transitions**. Does NOT cover payment states (see \`45\`).

## Prerequisite

- A confirmed order (see \`08\`).

## Deliverable

Order and fulfillment states that only move along allowed transitions.

## The idea, in one line

An order has an **order state** and each **fulfillment** has its own state; both advance only through defined transitions, surfaced via \`on_status\` / \`on_update\`.

## Real states (RET11)

- **Fulfillment state** (delivery milestones, in order): **Pending → Packed → Agent-assigned → Order-picked-up → Out-for-delivery → Order-delivered**; terminal **Cancelled**. The BPP rebuilds the fulfillment state array at each milestone. RTO / partial-cancel legs are appended as separate \`Cancel\`-type fulfillment entries.
- **Order state:** advances to terminal **Completed** or **Cancelled** (\`on_cancel\` sets \`Cancelled\`). The BAP validator asserts the returned state is a recognized post-action value.
- **Payment state:** **Pending → Paid** (declared by the BPP from \`on_init\` onward, carried verbatim into \`confirm\`).

## Guideline

1. Set \`order.state\` and each \`fulfillment.state\` from the allowed enum.
2. Advance only along valid transitions; report changes via \`on_status\` (see \`21\`).
3. Terminal states (Completed, Cancelled) end the lifecycle.

## Protocol nuances (why this is ONDC-peculiar)

- **Two levels of state** — order-level and fulfillment-level, which move semi-independently.
- **Transitions are constrained** — see the action state machine in \`config/actions/index.yaml\` (\`supportedActions\`) for which actions are valid at each point (\`18\`).
- **State ≠ location** — tracking coordinates are \`track\` (see \`24\`), not a state value.

## Sources

- ONDC-RET-Specifications; ONDC-Protocol-Specs core API contract
- ONDC automation-specifications \`config/actions/index.yaml\` (branch \`draft-RET11-1.2.5\`)`,
  },
  {
    id: "45-payment-terms",
    title: "Payment Terms (Collector, Prepaid / COD)",
    tier: "kb",
    category: "Order Lifecycle",
    status: "source-confirmed (RET11)",
    sources: [
      "ONDC-RET-Specifications; ONDC-Protocol-Specs core API contract",
      "ONDC automation-specifications `config/attributes` (branch `draft-RET11-1.2.5`)",
    ],
    see_also: ["20-init-on_init"],
    body: `## Objective

Explain **who collects payment** (BAP vs BPP) and prepaid/COD handling. Does NOT cover settlement/reconciliation (out of scope).

## Prerequisite

- An \`init\` → \`on_init\` establishing payment terms (see \`20\`).

## Deliverable

A \`payment\` block that states the collector, type and status unambiguously for both sides.

## The idea, in one line

The \`payment\` object declares the **collector** (BAP-collected or BPP-collected), the **type** (prepaid / on-fulfillment / COD), and status — set during \`init\`/\`on_init\` and carried into \`confirm\`.

## Guideline

1. In \`init\`/\`on_init\`, agree the **collector** and terms via: \`payment.collected_by\` (BAP | BPP), \`payment.type\`, \`payment.status\` (**Pending → Paid**), \`@ondc/org/collection_amount\`, and the finder-fee tags **\`@ondc/org/buyer_app_finder_fee_type\`** + **\`@ondc/org/buyer_app_finder_fee_amount\`**.
2. Set the payment **type** (prepaid, COD/on-fulfillment).
3. Carry the agreed terms into \`confirm\`; they establish the settlement basis (collector + finder fee).

## Protocol nuances (why this is ONDC-peculiar)

- **Collector can be either side.** BAP-collected vs BPP-collected changes the money flow and the settlement responsibility.
- **COD vs prepaid changes the fulfillment/settlement path.**
- **Payment terms establish the settlement basis** — collector + finder fee determine who owes whom.

## Sources

- ONDC-RET-Specifications; ONDC-Protocol-Specs core API contract
- ONDC automation-specifications \`config/attributes\` (branch \`draft-RET11-1.2.5\`)`,
  },
  {
    id: "46-cancellation-force-cancellation",
    title: "Cancellation & Force Cancellation",
    tier: "kb",
    category: "Order Lifecycle",
    status: "source-confirmed (RET11)",
    sources: [
      "ONDC-RET-Specifications; ONDC-Protocol-Specs docs (Cancellation)",
      "ONDC automation-specifications `config/flows/F&B/FORCE_CANCEL.yaml` (branch `draft-RET11-1.2.5`)",
    ],
    see_also: [
      "08-confirm-on_confirm",
      "15-error-codes",
      "17-reason-codes",
      "22-cancel-on_cancel",
      "47-returns-rto-rts",
    ],
    body: `## Objective

Explain buyer/seller **cancellation** and **force cancellation** with required reason codes. Does NOT cover returns (see \`47\`) or the reason-code list itself (see \`17\`).

## Prerequisite

- A confirmed order (see \`08\`) and a valid \`cancellation_reason_id\` (see \`17\`).

## Deliverable

A cancelled order with a valid reason, or a force-cancel where policy requires it.

## The idea, in one line

**Cancellation** is the normal \`cancel\` → \`on_cancel\` flow with a reason code; **force cancellation** is a controlled path (often system/seller-initiated) when the normal flow cannot complete.

## Guideline

1. **Cancel** — initiator sends \`cancel\` with \`cancellation_reason_id\` (see \`22\`, \`17\`).
2. **Force cancel** — used when the standard cancel is blocked; the reason is often system-assigned.
3. \`on_cancel\` returns the cancelled order; the reason drives refund/settlement.

## Protocol nuances (why this is ONDC-peculiar)

- **Reason code is mandatory** — missing \`cancellation_reason_id\` is a hard 400 (see \`17\`).
- **Force cancel is distinct** — a separate, controlled flow (the automation-specifications ship a dedicated \`FORCE_CANCEL\` flow), not the everyday cancel.
- **Policy can block cancellation** — e.g. TAT-not-breached rejects (error \`60010\`, see \`15\`).

## Sources

- ONDC-RET-Specifications; ONDC-Protocol-Specs docs (Cancellation)
- ONDC automation-specifications \`config/flows/F&B/FORCE_CANCEL.yaml\` (branch \`draft-RET11-1.2.5\`)`,
  },
  {
    id: "47-returns-rto-rts",
    title: "Returns, RTO & RTS",
    tier: "kb",
    category: "Order Lifecycle",
    status: "source-confirmed (RET11)",
    sources: [
      "ONDC-RET-Specifications",
      "ONDC automation-specifications `config/flows/F&B/RETURN_FLOW.yaml`, `RTO_PLUS_PART_CANCELLATION.yaml` (branch `draft-RET11-1.2.5`)",
    ],
    see_also: [
      "08-confirm-on_confirm",
      "17-reason-codes",
      "22-cancel-on_cancel",
      "23-update-on_update",
      "48-fulfillment-states-tat",
    ],
    body: `## Objective

Explain **return / replacement**, **return-to-origin (RTO)** and **ready-to-ship (RTS)** flows. Does NOT cover forward fulfillment (see \`48\`).

## Prerequisite

- A confirmed/fulfilled order (see \`08\`); returns carry a reason code (see \`17\`).

## Deliverable

Correctly modelled return / RTO / RTS transitions via \`update\` and fulfillment state.

## The idea, in one line

**Return** = buyer sends items back (via \`update\`, with a reason); **RTO** = undelivered shipment returns to the seller/origin; **RTS** = an order is packed and ready to ship — each is a fulfillment-state path.

## Guideline

1. **Return** — buyer initiates via \`update\` with a return reason; a return fulfillment tracks it (see \`23\`).
2. **RTO** — when delivery fails, the fulfillment moves to a return-to-origin path.
3. **RTS** — the seller marks the order ready-to-ship before handover to logistics.

## Real structure (RET11 flows)

- **RTO / partial cancel append a separate \`Cancel\`-type fulfillment leg** to the fulfillments array (the original delivery leg's state is overwritten from session data). The \`RTO_PLUS_PART_CANCELLATION\` flow correlates the cancelled leg with its resulting RTO leg via fulfillment \`state\` tags (RTO reference, cancellation reason code, logistics partner id).
- **RTS** is a fulfillment state ahead of handover; **returns** run through \`update\` with a return reason (see \`17\`).

## Protocol nuances (why this is ONDC-peculiar)

- **Returns go through \`update\`, not \`cancel\`** — cancellation ends an order; a return amends a delivered one (see \`22\` vs \`23\`).
- **RTO is a fulfillment path**, driven by delivery failure, distinct from a buyer return — modelled as an appended \`Cancel\`-type leg, not a state flip on the delivery leg.
- **Reason codes apply to returns** (see \`17\`) and feed settlement.

## Sources

- ONDC-RET-Specifications
- ONDC automation-specifications \`config/flows/F&B/RETURN_FLOW.yaml\`, \`RTO_PLUS_PART_CANCELLATION.yaml\` (branch \`draft-RET11-1.2.5\`)`,
  },
  {
    id: "48-fulfillment-states-tat",
    title: "Fulfillment States & TAT",
    tier: "kb",
    category: "Order Lifecycle",
    status: "source-confirmed (RET11)",
    sources: [
      "ONDC-RET-Specifications; ONDC-LOG-Specifications",
      "ONDC automation-specifications `config/errors/index.yaml` (branch `draft-RET11-1.2.5`)",
    ],
    see_also: [
      "08-confirm-on_confirm",
      "15-error-codes",
      "21-status-on_status",
      "36-catalog-object-model",
      "44-order-state-machine",
      "49-logistics-linkage",
    ],
    body: `## Objective

Explain **fulfillment status values** and **turnaround-time (TAT)** expectations. Does NOT cover the catalog (see \`36\`).

## Prerequisite

- A confirmed order with fulfillments (see \`08\`).

## Deliverable

Fulfillment states and TATs that are set and honoured consistently across the order.

## The idea, in one line

Each fulfillment has a **state** and a **TAT** (promised turnaround) that both sides quote and track.

## Real fulfillment states (RET11)

Delivery milestones, in order: **Pending → Packed → Agent-assigned → Order-picked-up → Out-for-delivery → Order-delivered** (terminal); **Cancelled** (terminal). The BPP rebuilds the state array at each milestone (persisted as \`on_status_fulfillments\`) so each \`on_status\` push carries the current state. TAT is quoted via **\`@ondc/org/TAT\`** (fulfillment) and **\`@ondc/org/time_to_ship\`** (item), both ISO8601 durations.

## Guideline

1. Quote **TAT** on the catalog/quote (ISO8601 duration).
2. Advance \`fulfillment.state\` along the allowed values; report via \`on_status\` (see \`21\`).
3. A TAT that changes from what was quoted is an error (e.g. invalid-TAT codes — see \`15\`).

## Protocol nuances (why this is ONDC-peculiar)

- **TAT is a promised duration**, quoted upfront and enforced — a mismatch raises invalid-TAT errors (\`60008\`/\`62506\`, see \`15\`).
- **Fulfillment state ≠ order state** — they advance semi-independently (see \`44\`).
- **State drives logistics linkage** (see \`49\`) and settlement timing.

## Sources

- ONDC-RET-Specifications; ONDC-LOG-Specifications
- ONDC automation-specifications \`config/errors/index.yaml\` (branch \`draft-RET11-1.2.5\`)`,
  },
  {
    id: "49-logistics-linkage",
    title: "Logistics Linkage (Retail ↔ LSP)",
    tier: "kb",
    category: "Fulfillment & Logistics",
    status: "source-confirmed (LOG11)",
    sources: [
      "ONDC-LOG-Specifications (B2C Logistics developer guide)",
      "ONDC-RET-Specifications",
    ],
    see_also: [
      "08-confirm-on_confirm",
      "15-error-codes",
      "36-catalog-object-model",
    ],
    body: `## Objective

Explain how a seller app procures **on-network logistics** from a Logistics Service Provider (LSP). Does NOT cover the retail catalog (see \`36\`).

## Prerequisite

- A confirmed retail order needing delivery (see \`08\`).

## Deliverable

A retail order fulfilled by an on-network LSP via a parallel logistics transaction.

## The idea, in one line

The seller app (retail BPP) acts as a **logistics BAP** and runs a **separate Beckn transaction** (its own search → confirm) against an LSP (logistics BPP) to move the shipment — two linked transactions, one shipment.

## Real structure (LOG11 — P2H2P)

- The logistics transaction carries the retail order via **\`@ondc/org/linked_order\`** — a persisted block with the provider location (shop name, building), item, weight and dimensions, seeded at order generation and carried through \`confirm\`.
- Fulfillment tags classify the linkage/constraints: **\`linked_provider\`**, **\`linked_order\`**, **\`linked_order_item\`**, **\`special_req\`** (set in the logistics \`search\`).
- **Payment** is staged (\`advance\` / \`balance\`) with cost types \`base\` / \`cod\` / \`surge\` / \`rider\` / \`order\`.
- **RTO** is quoted separately (\`RTO quote\`).
- Same \`6xxxx\` error set as retail (e.g. \`60001\`/\`60002\` pickup/dropoff serviceability — see \`15\`).

## Guideline

1. Retail order is confirmed (retail domain, e.g. \`ONDC:RET11\`).
2. The seller app runs a **logistics** transaction (domain **\`ONDC:LOG11\`**, P2H2P) as the logistics buyer against an LSP, passing the retail order in \`@ondc/org/linked_order\`.
3. Fulfillment status flows from the LSP back through the seller to the retail buyer.

## Protocol nuances (why this is ONDC-peculiar)

- **Two domains, two transactions, linked.** Retail and logistics are separate Beckn flows with their own \`transaction_id\`s, bridged by the seller app.
- **Role inversion** — the retail *seller* is the logistics *buyer* (BAP) in the logistics leg.
- **Logistics has its own specs** (LOG domain) — distinct schema/actions from retail.

## Sources

- ONDC-LOG-Specifications (B2C Logistics developer guide)
- ONDC-RET-Specifications`,
  },
  {
    id: "50-fulfillment-types",
    title: "Fulfillment Types",
    tier: "kb",
    category: "Fulfillment & Logistics",
    status: "source-confirmed (RET11)",
    sources: [
      "ONDC-RET-Specifications; ONDC-LOG-Specifications",
      "ONDC automation-specifications `config/flows/F&B/SELF_PICKUP.yaml`, `SLOTTED_DELIVERY.yaml`, `MULTI_OPTION_FULFILLMENT_FLOW.yaml` (branch `draft-RET11-1.2.5`)",
    ],
    see_also: [
      "24-track-on_track",
      "36-catalog-object-model",
      "39-serviceability",
      "48-fulfillment-states-tat",
      "49-logistics-linkage",
      "51-awb-shipping-label",
    ],
    body: `## Objective

Enumerate the **fulfillment types** and when each applies. Does NOT cover AWB handling (see \`51\`).

## Prerequisite

- An order with one or more fulfillments (see \`36\`, \`48\`).

## Deliverable

Each fulfillment tagged with the correct type so routing and expectations match.

## The idea, in one line

A fulfillment has a **type** — e.g. **Delivery**, **Buyer-Delivery**, **Self-Pickup** — that determines how the item reaches the buyer.

## Real values (RET11)

- The BPP declares a provider-level **\`fulfillments[]\`** container listing the fulfillment types it supports (asserted in \`on_search\` validation).
- Confirmed \`type\` values: **\`Delivery\`** (seller/network-arranged), **\`Buyer-Delivery\`** (buyer arranges logistics), **\`Self-Pickup\`**. Flow variants: \`SELF_PICKUP\`, \`SLOTTED_DELIVERY\` (carries a time slot), \`MULTI_OPTION_FULFILLMENT\` (multiple options offered).
- Each fulfillment carries a \`tracking\` flag (whether live tracking is enabled — see \`24\`).

## Guideline

1. Set \`fulfillment.type\` per the domain's allowed types.
2. Match the flow to the type — e.g. self-pickup skips delivery logistics; slotted delivery carries a time slot.
3. Reflect the type in serviceability and TAT (see \`39\`, \`48\`).

## Protocol nuances (why this is ONDC-peculiar)

- **Type drives the flow** — self-pickup vs delivery vs slotted delivery each has a distinct fulfillment path (the automation-specifications ship \`SELF_PICKUP\`, \`SLOTTED_DELIVERY\`, \`MULTI_OPTION_FULFILLMENT\` flows).
- **Buyer- vs seller-arranged logistics** changes who runs the logistics leg (see \`49\`).

## Sources

- ONDC-RET-Specifications; ONDC-LOG-Specifications
- ONDC automation-specifications \`config/flows/F&B/SELF_PICKUP.yaml\`, \`SLOTTED_DELIVERY.yaml\`, \`MULTI_OPTION_FULFILLMENT_FLOW.yaml\` (branch \`draft-RET11-1.2.5\`)`,
  },
  {
    id: "51-awb-shipping-label",
    title: "AWB & Shipping Label Handling",
    tier: "kb",
    category: "Fulfillment & Logistics",
    status: "source-confirmed (LOG11)",
    sources: ["ONDC-LOG-Specifications", "ONDC-RET-Specifications"],
    see_also: ["49-logistics-linkage"],
    body: `## Objective

Explain exchanging **AWB numbers** and **shipping labels** between NPs. Does NOT cover rate cards.

## Prerequisite

- A logistics fulfillment in progress (see \`49\`).

## Deliverable

AWB and shipping-label data exchanged so the shipment can be handed over and tracked.

## The idea, in one line

For shipped fulfillments, the LSP provides an **AWB (Air Waybill) number** and a **shipping label** which the seller prints/affixes — exchanged via fulfillment tags/documents in the logistics flow.

## Real fields (LOG11)

- **\`@ondc/org/awb_no\`** — the AWB (Air Waybill) number, a string (e.g. \`"1227262193237777"\`).
- **\`shipping_label\`** — a fulfillment tag: \`code: shipping_label\`, \`value: <PDF URL>\` (e.g. \`https://shipping_label.com/pdf/url\`) — the printable label.
- Exchanged in the logistics flow (e.g. the \`E-WAY_BILL\` / \`E-POD\` flows).

## Guideline

1. On logistics confirm/update, the LSP returns **\`@ondc/org/awb_no\`** and the **\`shipping_label\`** tag (PDF URL).
2. The seller retrieves and affixes the label before handover.
3. The AWB is used for tracking and reconciliation across the shipment.

## Protocol nuances (why this is ONDC-peculiar)

- **AWB is the shipment key** for tracking and settlement across the logistics leg.
- **Label is a document reference** — commonly a URL to a printable label, carried in fulfillment tags.
- **Logistics-domain concern** — appears in the LOG flow, surfaced to retail via linkage (see \`49\`).

## Sources

- ONDC-LOG-Specifications
- ONDC-RET-Specifications`,
  },
  {
    id: "59-workbench-overview",
    title: "Workbench — Overview & Access",
    tier: "kb",
    category: "Workbench & Testing",
    status: "source-confirmed (UI + repo)",
    sources: [
      "ONDC `automation-framework` (README); hosted `workbench.ondc.tech/home`",
      "Workbench UI (Home / Schema Validation / Scenario Testing / Tools & SDK)",
    ],
    see_also: [
      "60-schema-validation-tool",
      "61-flow-testing-suite",
      "62-workbench-local-setup",
      "65-interpreting-error-reports",
    ],
    body: `## Objective

Explain what the **ONDC Protocol Workbench** is, how it's structured, and how to access it. Does NOT cover specific tool mechanics (see \`60\`, \`61\`, \`65\`).

## Prerequisite

- An NP building/testing an ONDC integration; a GitHub account (login is via GitHub).

## Deliverable

Access to the Workbench and an understanding of the tools it offers and the build→certify journey.

## What it is, in one line

The Workbench is ONDC's **"universal, intelligent framework to enable and facilitate the implementation of ONDC open network protocols"** — an all-in-one toolkit to **Validate, Debug, Deploy** an integration before go-live.

## Access

- Hosted at **\`workbench.ondc.tech/home\`**; **Login with GitHub**. Support: \`PW-support@ondc.org\`.
- Runnable locally via the \`automation-framework\` repo (Docker — see \`62\`).

## Navigation / tools

| Nav item | What it does |
|---|---|
| **Schema Validation** | Per-payload schema/type/enum checks (see \`60\`) |
| **Scenario Testing** | End-to-end NP-to-NP flow testing with a report (see \`61\`) |
| **Tools & SDK → Seller Onboarding** | Build a provider/catalog (domain, logo, provider name, descriptions, product images) |
| **Tools & SDK → Protocol Playground** | Configure/test flows — tabs **Tools · Flow Converter · Schema Generator**; *Load Saved* / *Import from GitHub*; fields Domain, Version, Flow ID, Use Case ID (\`UCS-001\`) |
| **Support** | Help / contact |

## The build → certify journey (the 3 steps on the home page)

1. **Validate Schemas** — per-payload checks (see \`60\`).
2. **Run Scenarios** — end-to-end testing (see \`61\`).
3. **Go Live** — production ready.

## Protocol nuances (why this is ONDC-peculiar)

- **One portal, several tools** — schema, scenario, seller-onboarding and a protocol playground under one login.
- **GitHub-centric** — login and flow import are via GitHub.
- **Hosted or local** — same toolkit runs from \`automation-framework\` locally (Docker).
- **Precedes go-live certification** — the Workbench is for building/debugging ahead of the separate certification step.

## Sources

- ONDC \`automation-framework\` (README); hosted \`workbench.ondc.tech/home\`
- Workbench UI (Home / Schema Validation / Scenario Testing / Tools & SDK)`,
  },
  {
    id: "60-schema-validation-tool",
    title: "Schema Validation Tool — Usage",
    tier: "kb",
    category: "Workbench & Testing",
    status: "source-confirmed (UI + repo)",
    sources: [
      "ONDC `automation-framework` (Core Tools — Schema Validation)",
      "Workbench UI (Schema Validation) — `workbench.ondc.tech`",
    ],
    see_also: [
      "14-schema-validation",
      "16-validation-rules",
      "61-flow-testing-suite",
      "65-interpreting-error-reports",
    ],
    body: `## Objective

Explain using the Workbench **Schema Validation** tool to check a single payload. Does NOT cover end-to-end flow testing (see \`61\`) or cross-field validations (see \`16\`).

## Prerequisite

- A payload and its \`domain\` + \`core_version\`.

## Deliverable

A payload validated against the domain/version JSON schema, with errors localized and resolved.

## What it checks

Paste/upload a payload, pick **domain + version**, and the tool validates **schema correctness, data types, required fields, and enums**, reporting each error in a panel below the editor.

## Guideline (the 7 steps, from the UI)

1. Confirm the tool supports your **domain** (a domain list is shown).
2. **Paste / upload** your API JSON payload (e.g. a \`search\` payload).
3. Set **domain + version compliance** (the version, e.g. ONDC v2.0.2).
4. Click **Validate** to check for errors.
5. **Review** the validation errors in the panel below the editor.
6. **Resolve** errors and validate again.
7. Get the **successful validation** message.

## CLI form

The same check runs as a CLI, e.g.:

\`\`\`
workbench validate --domain ONDC:RET11 --action search
// parsing payload against ONDC v2.0.2 schema...
✓ context.domain     valid
✓ context.action     valid
✓ context.bap_id     resolved
! message.intent.fulfillment  missing gps
\`\`\`

## Protocol nuances (why this is ONDC-peculiar)

- **Single-payload, not flow.** It validates one message in isolation (structure/type/enum); sequencing and cross-field \`x-validations\` are the scenario suite's job (see \`61\`, \`16\`).
- **Domain + version selection matters** — validating against the wrong version yields false errors (see \`14\`).
- **Errors are field-localized** — each error points at the JSON path (e.g. \`message.intent.fulfillment missing gps\`), matching the \`attr\` targets in the validation config (see \`16\`, \`65\`).

## Sources

- ONDC \`automation-framework\` (Core Tools — Schema Validation)
- Workbench UI (Schema Validation) — \`workbench.ondc.tech\``,
  },
  {
    id: "61-flow-testing-suite",
    title: "Flow / Scenario Testing — Usage",
    tier: "kb",
    category: "Workbench & Testing",
    status: "source-confirmed (UI + repo)",
    sources: [
      "ONDC `automation-framework` (Core Tools — Flow Testing Suite)",
      "ONDC automation-specifications `config/flows/index.yaml` (branch `draft-RET11-1.2.5`)",
      "Workbench UI (Scenario Testing) — `workbench.ondc.tech/scenario`",
    ],
    see_also: [
      "16-validation-rules",
      "18-action-catalogue-lifecycle",
      "60-schema-validation-tool",
      "63-mock-server-sandbox",
    ],
    body: `## Objective

Explain running **end-to-end simulated NP-to-NP flows** in the Workbench (the "Scenario Testing" tool). Does NOT cover single-payload checks (see \`60\`).

## Prerequisite

- A working, reachable NP endpoint (subscriber URL) to drive through a flow.
- Pop-ups allowed in the browser (required to open the report tabs).

## Deliverable

A use-case flow run to completion, producing a report you can view, download and share.

## What it is, in one line

Scenario Testing runs a **whole use-case sequence** against your NP — checking each step's payload, validations and transitions — and generates a certification-style report.

## Guideline (the 9 steps / session setup)

Create a new **Session** ("fill the details to begin flow testing"), or *Create profile config*:

1. **Enter Subscriber URL** (e.g. \`https://example.com\`).
2. **Select Domain**.
3. **Select Version**.
4. **Select Usecase**.
5. **Select Your Role** (e.g. Buyer App (BAP) / Seller App (BPP)).
6. **Select Environment** (e.g. **PRE-PRODUCTION**).
7. **Generate Report**.
8. **View Report**.
9. **Download / Share Report**.

## Protocol nuances (why this is ONDC-peculiar)

- **Sequence-aware.** Unlike the schema tool, it enforces action ordering (see \`18\`) and cross-field \`x-validations\` (see \`16\`) across the flow.
- **Role + environment scoped** — you test as a specific role (BAP/BPP) against a chosen environment (Pre-Prod).
- **Flows come from versioned config** — the use-cases map to \`automation-specifications\` \`config/flows\` on the domain branch (tagged WORKBENCH / MANDATORY / REPORTABLE).
- **Mock counterparty** — a Mock Service + Domain API Services simulate the other NP (see \`63\`).
- **Pop-ups required** — reports open in new tabs.

## Sources

- ONDC \`automation-framework\` (Core Tools — Flow Testing Suite)
- ONDC automation-specifications \`config/flows/index.yaml\` (branch \`draft-RET11-1.2.5\`)
- Workbench UI (Scenario Testing) — \`workbench.ondc.tech/scenario\``,
  },
  {
    id: "62-workbench-local-setup",
    title: "Workbench — Local Setup (Docker)",
    tier: "kb",
    category: "Workbench & Testing",
    status: "source-confirmed (repo)",
    sources: [
      "ONDC `automation-framework` (README — local development setup, `build-api-service.sh`)",
    ],
    see_also: [
      "16-validation-rules",
      "59-workbench-overview",
      "61-flow-testing-suite",
    ],
    body: `## Objective

Explain running the Workbench and a domain API service **locally** via Docker. Does NOT cover the hosted portal (see \`59\`).

## Prerequisite

- **Docker, Docker Compose, and Git** installed.

## Deliverable

A locally running Workbench (UI + backend + mock + domain API service) for offline testing.

## Guideline (real setup, from the repo)

\`\`\`bash
git clone <automation-framework repo>
cd automation-framework
git submodule update --init            # pulls the specs/services submodules

docker compose build ui-frontend backoffice-frontend
docker compose up -d
\`\`\`

## Services & ports

| Service | Port |
|---|---|
| UI Frontend | 3035 |
| UI Backend | 3034 |
| Domain API Service | 3032 |
| Mock Service | 3031 |
| DB Service | 5001 |

- **Domain API services are generated from spec branches** by \`build-api-service.sh\` — it clones the specs locally and generates Docker-composable services per domain/version.

## Protocol nuances (why this is ONDC-peculiar)

- **Submodules matter** — \`git submodule update --init\` pulls the specs/services; skipping it breaks the build.
- **Domain services are code-generated** from the \`automation-specifications\` branches (same config the hosted Workbench uses — see \`16\`, \`61\`).
- **Local mirrors hosted** — same tools as \`workbench.ondc.tech\`, offline.

## Sources

- ONDC \`automation-framework\` (README — local development setup, \`build-api-service.sh\`)`,
  },
  {
    id: "63-mock-server-sandbox",
    title: "Mock Service / Sandbox Usage",
    tier: "kb",
    category: "Workbench & Testing",
    status: "source-confirmed (repo)",
    sources: [
      "ONDC `automation-mock-service`",
      "ONDC `automation-framework` (Mock Service & Domain API Services)",
    ],
    see_also: [
      "10-ack-nack",
      "11-async-request-callback",
      "62-workbench-local-setup",
    ],
    body: `## Objective

Explain using the **mock counterparty** (Mock Service + Domain API Services) to test your side in isolation. Does NOT cover production traffic.

## Prerequisite

- Your NP (BAP or BPP) under development; the Workbench (hosted or local — see \`62\`).

## Deliverable

Your side exercised against a mock counterparty without a live partner.

## What it is, in one line

The **Mock Service & Domain API Services** simulate the **counterparty** NP (and its domain behaviour) so you can test your side alone across domains (e.g. \`RET10\`, \`FIS12\`, \`TRV11\`).

## Guideline

1. Point your NP at the mock service as its counterparty (local port **3031**, or via the hosted Workbench).
2. Send actions; the mock returns protocol-correct \`on_action\` callbacks.
3. Validate your ACK/NACK + callback handling (see \`10\`, \`11\`).

## Protocol nuances (why this is ONDC-peculiar)

- **Domain-aware mock** — the Domain API Services are generated per domain/version from the specs (see \`62\`), so the mock behaves like a real NP in that domain.
- **Isolation testing** — no live partner needed; deterministic.
- **Not production** — mock responses are for development, not certification or live traffic.

## Sources

- ONDC \`automation-mock-service\`
- ONDC \`automation-framework\` (Mock Service & Domain API Services)`,
  },
  {
    id: "65-interpreting-error-reports",
    title: "Interpreting Validation Error Reports",
    tier: "kb",
    category: "Workbench & Testing",
    status: "source-confirmed (JVAL)",
    sources: [
      "ONDC `automation-validation-compiler` (JVAL — validation code generator)",
      "ONDC `automation-framework` (Workbench reports); automation-specifications `config/validations/index.yaml`",
    ],
    see_also: [
      "15-error-codes",
      "16-validation-rules",
      "60-schema-validation-tool",
      "61-flow-testing-suite",
    ],
    body: `## Objective

Explain reading the Workbench **error report** and triaging fixes. Does NOT list every error code (see \`15\`).

## Prerequisite

- A Workbench schema/scenario run that produced errors (see \`60\`, \`61\`).

## Deliverable

A triaged list of fixes from an error report.

## The report shape

Validation is driven by **JVAL** (the \`automation-validation-compiler\`), which compiles the \`x-validations\` config (see \`16\`) into executable validators. Each check returns:

\`\`\`
[ { code: <number>, valid: <boolean>, description: <string> }, … ]
\`\`\`

So every error in the report carries a **\`code\`**, a **\`valid\` flag**, and a **\`description\`** — plus the JSON path of the offending field (e.g. \`message.intent.fulfillment missing gps\`).

## Guideline

1. For each failing entry, read the **\`description\`** and the **JSON path** to find the offending field.
2. Compare expected vs actual to see what's wrong (missing, wrong type, bad enum, failed condition).
3. Classify: schema/type → structural fix; enum → wrong code; conditional \`x-validation\` (JVAL operators like \`are present\`, \`all in\`, \`follow regex\`) → cross-field fix (see \`16\`).
4. Map the \`code\` to the error registry if it's a protocol error (see \`15\`).
5. Re-run until every entry is \`valid: true\`.

## Protocol nuances (why this is ONDC-peculiar)

- **Path + description + code is the triage key** — every error localizes to a JSONPath matching the \`attr\` targets in \`validations/index.yaml\` (see \`16\`).
- **Two error classes** — structural schema errors vs conditional \`x-validation\` failures; fixed differently.
- **The engine is code-generated** — JVAL turns YAML/JSON validation configs into TypeScript validators (\`comp.generateCode(x_validations, "L1-validations")\`), so report entries map 1:1 to config tests.

## Sources

- ONDC \`automation-validation-compiler\` (JVAL — validation code generator)
- ONDC \`automation-framework\` (Workbench reports); automation-specifications \`config/validations/index.yaml\``,
  },
  {
    id: "66-network-observability-api",
    title: "Network Observability API (Production)",
    tier: "kb",
    category: "Observability & Ops",
    status: "source-confirmed (NO schema)",
    sources: [
      "ONDC `[PROD] Network Observability API Schema & Process` + `[PrePROD] Network Observability API Schema`",
      "ONDC Network Observability notification (14 Jun 2023)",
    ],
    see_also: [],
    body: `## Objective

Explain the **Network Observability (NO)** API — the schema and process by which NPs push transaction logs to ONDC for production observability. Does NOT cover internal application logging.

## Prerequisite

- Subscribed to the **Production Registry**.
- A **bearer token** generated from the NP Portal (Configuration Settings).

## Deliverable

An **automated** feed of transaction logs (requests + responses + ACK/NACK) pushed to the NO API in the mandated schema.

## What NO is, in one line

Network Observability is an ONDC **framework to observe the business and technical health of the network** — improving interoperability, transparency and trust and enabling NPs to self-correct. It is **policy-mandatory** (per the ONDC Network Observability notification, 14 Jun 2023).

## Bearer token

- An **authorization identifier** linked to a **\`subscriber_id\` + NP type**, and **domain-agnostic**.
- **One token per (subscriber_id + NP type)** — an NP that is both a Buyer NP and a Seller NP (or has multiple subscriber_ids) has **multiple tokens**.
- Generated from the **NP Portal → Configuration Settings** after Prod Registry subscription; **valid only for the Prod stage** (Pre-Prod has its own schema/token — see the Pre-Prod schema doc).

## Endpoint

\`\`\`
POST https://analytics-api.aws.ondc.org/v1/api/push-txn-logs
Authorization: Bearer <token>
\`\`\`

## What & when to share

- The **transaction JSON from \`on_search\` onwards** — **both request and response** for each action (\`on_search\`, \`select\`, \`on_select\`, \`init\`, \`on_init\`, …), **including the IGM APIs** (\`issue\`, \`on_issue\`, \`issue_status\`, \`on_issue_status\`), plus **every ACK and NACK**.
- Also share **unsolicited calls** received/sent.
- Must be an **automated push** from the NP — **not** manual Postman submission.
- **Anonymize PII** in each API; **City and Pincode are NOT to be anonymized**.

## Push schema

Each log wraps the actual transaction:

\`\`\`json
{
  "type": "init",              // the action (init / on_init / issue / … ); flag ACK/NACK where applicable
  "data": {
    "context": { "action": "init", "domain": "…", "bap_id": "…", "bpp_id": "…", "transaction_id": "…", "message_id": "…", "timestamp": "…", "ttl": "…", "core_version": "…", "city": "std:080", "country": "IND" },
    "message": { "order": { … } }
  }
}
\`\`\`

- **\`type\`** = the action name (and whether the entry is an ACK/NACK); **\`data\`** = the real \`context\` + \`message\` of that call.
- Covers Retail, Logistics, Financial Services, Gift Cards & Mobility. A Postman collection is provided.

## Protocol nuances (why this is ONDC-peculiar)

- **Distinct from internal logs** — a network-facing, schema-bound, token-authenticated push, not your own logging.
- **Token is per subscriber+type, domain-agnostic** — don't reuse one token across subscriber ids/types.
- **Request *and* response, plus ACK/NACK and unsolicited calls** — NO wants the full picture, not just requests.
- **PII anonymized, but not City/Pincode** — those are needed for network analytics.
- **Automated only** — manual submission is non-compliant.

## Sources

- ONDC \`[PROD] Network Observability API Schema & Process\` + \`[PrePROD] Network Observability API Schema\`
- ONDC Network Observability notification (14 Jun 2023)`,
  },
  {
    id: "67-versioning-spec-migration",
    title: "Versioning & Spec Migration",
    tier: "kb",
    category: "Observability & Ops",
    status: "overview (no further source)",
    sources: [
      "ONDC `automation-specifications` (per-version branches; `config/docs/release-notes.md`)",
    ],
    see_also: [
      "33-domain-version-enablement",
      "61-flow-testing-suite",
      "68-release-calendar",
    ],
    body: `## Objective

Explain reading **version bumps** and migrating between contract versions. Does NOT cover release dates (see \`68\`).

## Prerequisite

- A live integration on a given \`core_version\`.

## Deliverable

A migration from one contract version to the next with schema/validation changes applied.

## The idea, in one line

ONDC contracts are **versioned** (\`core_version\`, and per-domain-version branches like \`draft-RET11-1.2.5\`); migrating means adopting the new schema, validations and error/action changes for that version.

## Guideline

1. Track the target \`core_version\` for your domain.
2. Diff the new version's \`automation-specifications\` config (schema, validations, actions, errors) against your current one.
3. Update payloads/handlers, re-run Workbench (see \`61\`), then cut over.

## Protocol nuances (why this is ONDC-peculiar)

- **Version = branch.** The authoritative config for each version is a dedicated branch; migrate by diffing branches.
- **Multiple things move together** — schema, \`x-validations\`, error codes and action transitions can all change across a version.
- **Set \`context.core_version\` correctly** — it selects the contract (see \`33\`).

## Sources

- ONDC \`automation-specifications\` (per-version branches; \`config/docs/release-notes.md\`)`,
  },
  {
    id: "68-release-calendar",
    title: "Release Calendar & Change Management",
    tier: "kb",
    category: "Observability & Ops",
    status: "overview (no further source)",
    sources: ["ONDC developer-docs (Release Calendar)"],
    see_also: ["67-versioning-spec-migration"],
    body: `## Objective

Explain ONDC's **release cadence** and how updates ship. Does NOT cover version internals (see \`67\`).

## Prerequisite

- An integration that must stay current with releases.

## Deliverable

Awareness of when changes land so you can plan migrations.

## The idea, in one line

ONDC ships on a **regular cadence** — minor releases mid-month (~15th) and major releases around end-of-month — announced via the release calendar.

## Guideline

1. Track the release calendar for your domain.
2. Treat **minor** (~15th) releases as incremental; **major** (end-of-month) as larger contract changes.
3. Plan migration (see \`67\`) around the calendar.

## Protocol nuances (why this is ONDC-peculiar)

- **Predictable cadence** — minor ~15th, major ~end-of-month; plan around it rather than reacting.
- **Calendar is authoritative** for timing; the version branches carry the actual changes.

## Sources

- ONDC developer-docs (Release Calendar)`,
  },
  {
    id: "69-city-state-codes",
    title: "City & State Codes Usage",
    tier: "kb",
    category: "Observability & Ops",
    status: "source-confirmed (std format)",
    sources: ["ONDC developer-docs `City-codes.md`, `State-codes.md`"],
    see_also: ["05-gateway-interaction"],
    body: `## Objective

Explain using ONDC **city / pincode and state codes** inside \`context\`. Does NOT cover GPS coordinates.

## Prerequisite

- A message whose \`context\` needs a city/country.

## Deliverable

Correct city/state codes in \`context\` so routing and serviceability work.

## The idea, in one line

\`context.city\` (and country) use **standardized codes** — city codes are \`std:<STD-code>\` (e.g. \`std:080\` for Bengaluru), with authoritative City-codes / State-codes lists.

## Guideline

1. Set \`context.city\` from the authoritative City-codes list (STD-based).
2. Use state codes where the contract expects them.
3. Match city to serviceability and gateway routing (the BG fans \`search\` by domain + city — see \`05\`).

## Protocol nuances (why this is ONDC-peculiar)

- **Codes, not names.** City is an STD-based code (\`std:080\`), not a free-text name.
- **City drives gateway routing** — \`search\` broadcast is by domain + city (see \`05\`), so a wrong code misroutes discovery.
- **Authoritative lists** — City-codes.md / State-codes.md in developer-docs.

## Sources

- ONDC developer-docs \`City-codes.md\`, \`State-codes.md\``,
  },
  {
    id: "70-async-implementation-skill",
    title: "Async Implementation Skill",
    tier: "kb",
    category: "Engineering Skills",
    status: "partial",
    sources: [
      "ONDC developer-docs `protocol-network-extension`",
      "Derived from Docs 10, 11, 13",
    ],
    see_also: [
      "10-ack-nack",
      "11-async-request-callback",
      "13-idempotency-retries",
    ],
    body: `## Objective

A reusable **coding skill** for non-blocking \`action\` / \`on_action\` handlers (queues, idempotency). Does NOT define the protocol contract (see \`11\`, \`13\`).

## Prerequisite

- Understanding of the async request-callback model (see \`11\`) and idempotency (see \`13\`).

## Deliverable

An NP implementation that ACKs immediately, processes asynchronously, and handles callbacks idempotently.

## The idea, in one line

Implement each endpoint to **ACK fast, work async**: validate + ACK/NACK synchronously, enqueue the work, and emit \`on_action\` when done — with idempotent callback handling.

## Guideline

1. On inbound \`action\`: verify signature + schema, return **ACK/NACK** immediately (see \`10\`).
2. **Enqueue** the work; don't block the request thread.
3. Process, then sign and POST \`on_action\` to the caller's URI.
4. On inbound \`on_action\`: dedupe by \`message_id\` (see \`13\`) before applying effects.

## Protocol nuances (why this is ONDC-peculiar)

- **ACK-fast is mandatory** — the sync response is separate from the result (see \`10\`); slow processing must not delay the ACK.
- **Idempotency is on the receiver** — callbacks can repeat; key effects on \`message_id\` (see \`13\`).
- **Callbacks are outbound signed calls** — the worker signs and POSTs, it's not an HTTP response.

## Sources

- ONDC developer-docs \`protocol-network-extension\`
- Derived from Docs 10, 11, 13`,
  },
  {
    id: "71-signature-verification-skill",
    title: "Signature Verification Skill (Code)",
    tier: "kb",
    category: "Engineering Skills",
    status: "partial",
    sources: [
      "ONDC `reference-implementations` `utilities/signing_and_verification` (py/go/ruby/java)",
      "ONDC `ondc-crypto-sdk-go`",
    ],
    see_also: [
      "01-signature-verification",
      "03-lookup",
      "27-digest-generation",
      "28-authorization-header-creation",
    ],
    body: `## Objective

A code-level **skill wrapping the crypto utility** for signing/verifying requests. Does NOT re-explain the algorithm theory (see \`01\`, \`27\`, \`28\`).

## Prerequisite

- Understanding of digest (see \`27\`), header creation (see \`28\`) and verification (see \`01\`).

## Deliverable

A reusable sign/verify utility an NP can drop into request middleware.

## The idea, in one line

Wrap the ONDC crypto reference (\`signing_and_verification\` utilities) into a sign function (build header) and a verify function (check inbound), so application code never re-implements the crypto.

## Guideline

1. **Sign:** BLAKE-512 digest → signing string → Ed25519 sign → assemble \`Authorization\` (see \`28\`).
2. **Verify:** parse \`keyId\` → lookup key (see \`03\`) → recompute digest + signing string → Ed25519 verify → window check (see \`01\`).
3. Use the reference implementations rather than hand-rolling; keep the signing string **byte-exact** (see \`28\`).

## Protocol nuances (why this is ONDC-peculiar)

- **Reuse the reference utility** — \`reference-implementations/utilities/signing_and_verification\` exists in py/go/ruby/java; hand-rolled crypto risks the byte-exact traps (see \`28\`).
- **Byte-exact signing string** — the doc/SDK spacing discrepancy (see \`28\`) is exactly why a shared utility matters.
- **Skill = wrapper, not new crypto** — it packages the existing algorithm for reuse.

## Sources

- ONDC \`reference-implementations\` \`utilities/signing_and_verification\` (py/go/ruby/java)
- ONDC \`ondc-crypto-sdk-go\``,
  },
];
