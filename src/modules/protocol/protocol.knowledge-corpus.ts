/**
 * The network-wide corpus — the half of ONDC no per-build endpoint publishes.
 *
 * `/protocol/spec/{domain}/{version}` answers everything that varies by build:
 * fields, rules, error codes, the action graph. It says nothing about the
 * network *around* a transaction — the registry, the gateway, signing, TTL and
 * retry semantics, the two-leg async contract — because those do not vary by
 * build and nothing serves them.
 *
 * ## Why this is bundled, when nothing else is
 *
 * The rule that the live config-service is the single source of truth exists
 * because **build specs drift, and a stale copy is worse than none**. That
 * argument does not reach here: these are network-wide invariants, no endpoint
 * publishes them, and the alternative is that a model never learns them at all.
 * The corpus is small, versioned in git, and every answer carries `AS_OF` so a
 * reader can weigh its age.
 *
 * ## Why it is TypeScript rather than markdown files
 *
 * The runtime image copies only `dist/`, and `tsc` emits `.js` from `.ts` —
 * nothing else. A corpus of `.md` files read from disk would work in `npm run
 * dev` and under `vitest`, and silently find nothing in the container. That is
 * the exact failure mode this repo already recorded for MCP notifications:
 * *"it would have worked over HTTP and silently not over stdio."* So the
 * documents live here, as escaped template literals, and there is one source
 * of truth for each.
 *
 * ## The second corpus
 *
 * `protocol.kb-corpus.generated.ts` holds the published ONDC knowledge base
 * (`ONDC-Official/automation-kb-studio/kb-docs`) under the same argument and
 * the same shape. It is vendored at a pinned commit rather than fetched,
 * because a content change should arrive as a reviewable diff rather than as a
 * silent difference between two deployments of the same image. The five
 * documents below are *not* superseded by it: they are the orientation layer,
 * and `protocol.knowledge.ts` reserves a result slot for them.
 */

/** When this corpus was last reviewed against the published ONDC docs. */
export const AS_OF = "2026-09-03";

export interface KnowledgeDoc {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /**
   * Which layer this document belongs to.
   *
   * `core` is the hand-written orientation layer below — short, blunt, written
   * for a model driving *this* server. `kb` is the published ONDC knowledge
   * base (`protocol.kb-corpus.generated.ts`), longer and written for somebody
   * implementing a participant. Absent means `core`: the five documents in
   * this file predate the split and restating it on each would be noise.
   */
  readonly tier?: "core" | "kb";
  /** One of the twelve kb-docs categories. Absent on the core layer. */
  readonly category?: string;
  /** `source-confirmed` | `partial` | `overview`, verbatim from the index. */
  readonly status?: string;
  /** What the document cites, so an answer can be traced past this server. */
  readonly sources?: readonly string[];
  /** Ids this document cross-references, resolved from its own `see` notes. */
  readonly see_also?: readonly string[];
}

export const KNOWLEDGE: readonly KnowledgeDoc[] = [
  {
    id: "async-contract",
    title: "ACK is not the answer — the two-leg request/callback contract",
    body: `## Every call has two legs

A beckn/ONDC call is **not** request/response. It is two independent HTTP
requests in opposite directions:

1. You \`POST /search\` to the counterparty. They answer **synchronously** with an
   ACK or a NACK. That answer says only "I received this and it is well-formed
   enough to process" — or "I refuse it". It carries **no business result**.
2. Later, on a **new connection they open to you**, they \`POST /on_search\` to
   your registered subscriber URL. That is the answer.

A participant that waits for business data on the response to its own request
will hang on every call.

## ACK/NACK is decoupled from HTTP status

This is the part most implementations get wrong. A NACK is a **200** with a
NACK body — the request was delivered and understood, and rejected on its
merits:

\`\`\`jsonc
// 200 OK
{ "message": { "ack": { "status": "NACK" } },
  "error": { "code": "60006", "message": "Invalid request, not compliant with API contract" } }
\`\`\`

Non-2xx statuses mean something else entirely: 400 for a malformed context, 401
for a signature that does not verify, 412 for a call that names no transaction
this endpoint is expecting. Treating "not 200" as "rejected" and "200" as
"accepted" gets both halves wrong.

## The callback may overtake its own ACK

The return leg of your ACK and the forward leg of their next call are separate
connections, and nothing orders them. A counterparty may legitimately do
\`receive → process → send the next call → return the ACK\`, so their follow-up
can arrive **before** you have finished answering their previous request.

Record what you send *before* you send it. An implementation that appends to
its own transaction log only after the send resolves will find the
counterparty's legitimate follow-up matching no pending step, and will answer
\`OUT_OF_SEQUENCE\` to a correct participant. This has been observed live at an
18 ms inversion.

## TTL bounds the wait, not a count

\`context.ttl\` is an ISO-8601 duration (\`PT30S\`). It is how long you wait — not
how many callbacks you expect. One \`search\` reaches many sellers through the
gateway, and you have no way to know how many will answer. Aggregate whatever
arrives before the TTL expires and proceed with that.

## Duplicates are expected; be idempotent

Delivery is at-least-once. The same callback can arrive twice — a retry, a
network hiccup, a counterparty that did not see your ACK. Key your processing on
\`context.message_id\` and make a repeat a no-op rather than a second order.
Nothing in the protocol deduplicates for you.`,
  },
  {
    id: "flows-vs-reality",
    title: "A flow is a test script; the protocol is a graph",
    body: `## What a flow is

A **flow** is a scripted path published for testing: an ordered sequence of
steps, one counterparty, a known next step, and a definite end. It exists so a
participant can be exercised repeatably.

It is not how a transaction works, and building against one produces an
implementation that passes tests and fails on the network.

## What a live transaction is

A walk through the build's **action graph** — \`protocol_next_actions\` serves it.
Four differences matter to anyone writing code:

**Fan-out.** One \`search\` reaches every seller in the domain through the
gateway. You receive \`on_search\` from each, separately, over the context TTL.
You do not know how many are coming. A flow has one \`on_search\` step.

**Unsolicited callbacks.** \`on_status\`, \`on_update\` and \`on_cancel\` arrive with
nothing from you prompting them — a fulfilment state changed, an agent cancelled
a leg, a refund settled. This can happen days after \`on_confirm\`. A participant
that only accepts callbacks it asked for is not compliant.

**Branching.** After \`on_confirm\` a real build permits \`status\`, \`cancel\`,
\`update\`, \`issue\` and their callbacks. The counterparty chooses; you must accept
whichever arrives.

**No end.** Flows finish. Orders do not — fulfilment states, returns,
cancellations, RTO and grievances continue long after any sequence a flow
describes.

## Why this produces hardcoding

A flow's payloads are generated for you from values already saved in the run.
Because the path is fixed, nothing ever forces the question *where does this
value legitimately come from?* — a value that worked before works again, and the
test stays green.

On the network it will not. Every identifier in a request must trace to
something the counterparty actually sent you:

- \`provider.id\` and \`items[].id\` come from the \`on_search\` catalogue you
  received — from **that** seller, in **this** transaction.
- \`fulfillment_id\` must be one the seller offered in \`on_select\`.
- \`quote\` must match what came back in \`on_init\`, to the paisa.
- \`bpp_id\` / \`bpp_uri\` come from the seller's own \`on_search\`.

\`protocol_describe_action\` reports each field's \`owner\`, and every action
publishes \`must_echo\` — the earlier actions its payload must stay consistent
with. Use them. A field the counterparty owns is never yours to choose.

## The published examples are not values

The spec publishes an example value per field. They are illustrative and
sometimes simply wrong — \`ONDC:TRV11/2.0.1\` gives \`ONDC:FIS13\` as the example
for \`context.domain\`, and \`ONDC:RET11/1.2.5\` gives \`ONDC:RET10\`. Both are live
today. Never copy one into a payload.`,
  },
  {
    id: "identity",
    title: "Transaction, message and subscriber identity",
    body: `## Four identifiers, and they are not interchangeable

| Identifier | Scope | Who mints it |
| --- | --- | --- |
| \`transaction_id\` | one order, end to end | whoever sends the **first action** of the transaction |
| \`message_id\` | one request/callback pair | the sender of the request |
| \`subscriber_id\` | one participant on the network | assigned at registration |
| \`unique_key_id\` | one signing key of that participant | chosen by the participant |

## The transaction id belongs to whoever moves first

It is minted **once**, by whoever sends the flow's first action, and every
subsequent call in that transaction — in both directions — carries the same
value. A BAP that starts with \`search\` mints it. A BPP answering an unsolicited
flow adopts whatever the BAP sent.

Minting a fresh id mid-transaction silently forks the order: the counterparty
opens a second record and the two halves stop seeing each other's calls.

## \`message_id\` is per pair, not per transaction

A new \`message_id\` for each request; the callback **echoes it back unchanged**.
That echo is how a counterparty correlates \`on_select\` with the \`select\` that
prompted it, and several implementations check it. Reusing a \`message_id\` across
two requests, or minting a fresh one on the callback, breaks that correlation.

## Echo the counterparty's identity fields

\`bap_id\` / \`bap_uri\` identify the buyer app; \`bpp_id\` / \`bpp_uri\` the seller.
Once a BPP has introduced itself in \`on_search\`, every later call from the BAP
must carry that \`bpp_id\` and \`bpp_uri\` — they are how the gateway and the seller
route the call. They are read back from what the counterparty sent, never
configured locally, because a transaction can involve any seller on the network.

## Your subscriber URL takes an action suffix

You register **one** base URL per domain, version and role, of the shape
\`{base}/{domain}/{version}/{buyer|seller}\`. Callers append \`/{action}\`
themselves. There is no session id and no transaction id in the path: the
endpoint is shared by every transaction you will ever run, and you recover the
context from \`context.transaction_id\` in the body.`,
  },
  {
    id: "registry",
    title: "The registry and the gateway — how a call finds its counterparty",
    body: `## The registry is the network's directory

Every participant registers a \`subscriber_id\`, a subscriber URL, a role (BAP,
BPP or gateway), the domains it serves, and its Ed25519 **public** signing and
encryption keys under a \`unique_key_id\`.

\`POST /lookup\` resolves a \`subscriber_id\` (plus \`unique_key_id\`) to that record.
That is where you get the public key to verify an inbound signature, and it is
the only trustworthy source — never trust a key or a URL supplied in the payload
itself.

Cache lookups, but bound the cache: **keys rotate**. A participant publishes a
new \`unique_key_id\` and retires the old one, and the \`keyId\` in the header names
which one to use. An implementation that caches by \`subscriber_id\` alone will
verify against a retired key and reject valid traffic.

## The gateway is in the path for discovery only

\`search\` goes to the **gateway**, which fans it out to every BPP serving that
domain and city. Each BPP answers \`on_search\` **directly to your \`bap_uri\`** —
the gateway is not in the return path.

Every action after discovery is point-to-point: once you have a \`bpp_id\` and
\`bpp_uri\` from an \`on_search\`, \`select\`, \`init\`, \`confirm\` and the rest go
straight to that seller.

This is why one \`search\` yields many \`on_search\` and everything afterwards
yields exactly one callback: the fan-out is the gateway's doing, and it happens
once.

## Onboarding, in order

1. Generate Ed25519 signing and X25519 encryption key pairs.
2. Host \`/ondc-site-verification.html\` containing your signed request id.
3. \`POST /subscribe\` to the registry with your subscriber id, URL, domains and
   public keys.
4. The registry challenges you: it sends an encrypted challenge to your
   \`/on_subscribe\`, which you decrypt with your encryption private key and echo
   back.
5. You move through \`INITIATED\` → \`UNDER_SUBSCRIPTION\` → \`SUBSCRIBED\`.

Staging and production are separate registries with separate onboarding.`,
  },
  {
    id: "signing",
    title: "The authorisation header — Ed25519 over a BLAKE-512 digest",
    body: `## The algorithm

Every ONDC call carries an \`Authorization\` header signed with **Ed25519** over a
**BLAKE2b-512** digest of the request body. Not BLAKE2s, not SHA.

The signing string is exactly three lines, LF-separated:

\`\`\`
(created): {unix_seconds}
(expires): {unix_seconds}
digest: BLAKE-512={base64_of_blake2b512_of_body}
\`\`\`

The header:

\`\`\`
Signature keyId="{subscriber_id}|{unique_key_id}|ed25519",
  algorithm="ed25519",created="{unix}",expires="{unix}",
  headers="(created) (expires) digest",signature="{base64}"
\`\`\`

Standard base64, not URL-safe.

## The mistake that costs a day

**Hash the exact bytes you received.** Never parse the JSON and re-serialise it
before digesting — key order, whitespace and unicode escaping all change, the
digest changes with them, and the signature fails to verify against a payload
that is semantically identical. On the receiving side this means capturing the
raw body before any JSON middleware touches it.

The other common one: private keys come in two lengths. A 32-byte value is a
seed and a 64-byte value is an expanded key. Handle both.

## Verifying

Parse the header, check \`created <= now <= expires\`, digest the raw body,
verify. There is **no clock-skew tolerance** in the specification — if your
clock drifts, your calls are rejected as expired.

The counterparty's public key comes from the registry \`lookup\` for their
\`subscriber_id\` and \`unique_key_id\`. See \`registry\`.

Reference implementations in five languages ship with the workbench's
header-guide.`,
  },
];
