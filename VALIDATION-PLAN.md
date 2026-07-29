# VALIDATION-PLAN.md — L0 + L1 by delegation

Phase 8 of the build order (`validate`), delivered by **calling the workbench's
own api-service as a validation oracle** rather than re-implementing L0 and L1
natively.

> **Status: shipped**, 2026-07-29. Everything in §4–§9 is built and tested —
> gateway, parser, `ValidationCheck` pipeline, `payload_validate`, and both
> gates. The side-effect question in §10 was **resolved at source**: the route
> proxies nothing, stores nothing and creates no session, so it is safe to
> default to `enforce` rather than easing in through `advisory`.
>
> Two things this document called for did not survive contact and are worth
> naming. The `context` layer is **not** part of this milestone — the oracle
> cannot answer session-relative questions, so it stays ours, and it is now one
> more `ValidationCheck` rather than a rewrite. And the health probe had to grow
> an `optional` flag: registering the oracle as an ordinary dependency would
> have made `/ready` answer 503 when it was unreachable, pulling the instance
> out of rotation over a dependency the server is designed to survive without.

---

## 1. Why delegate

The native path in CLAUDE.md §7 item 8 reads "schemas and L1 rules come from the
config-service (`/protocol/spec/{domain}/{version}`)". Measured, that endpoint
returns **10.7 MB** for `ONDC:TRV11/2.0.1` alone. Consuming it means extracting a
per-action JSON Schema *and* compiling the `x-validations` DSL — which upstream is
an entire service (`validation-compiler` / xval) plus `validationpkg.PerformL1validations`
in Go. It would be the largest module in this repo and it would drift from the
network's own rules the moment upstream changed.

The oracle is **the same code the network runs**. That is the same argument that
made us execute the flow's published `generate` instead of having the model draft
payloads (CLAUDE.md §1): the code the network is actually calibrated against
cannot drift from the spec the way our re-implementation would.

The cost, stated plainly: a network dependency on a path that currently has none,
and a 0.3–1.1 s round trip, part of which lands inside the ACK window. §5 and §6
are about paying that honestly.

**The door stays open.** `ValidationGateway` is an interface. A native
implementation can replace the HTTP one later with no change above the seam.

---

## 2. The endpoint — verified contract

Runtime-verified 2026-07-29 against `https://workbench.ondc.tech/api-service`.

```
POST {base}/{domain}/{version}/test/{action}
Content-Type: text/plain          (application/json parses identically)
body: the raw payload
```

| Probe | Result |
| --- | --- |
| Valid TRV11 `search` | `200` `{"message":{"ack":{"status":"ACK"}}}`, ~0.33 s |
| L1 failures | `200` NACK, `error.code:"Bad Request"`, `error.message` = **markdown**, every failure aggregated |
| L0 failures (wrong types) | `200` NACK, `error.message` = **plain text**: `at '/context/timestamp': got number, want string;` |
| L0 present | L1 does **not** run — schema failures short-circuit, so the two grammars never mix |
| Unparseable body | `400` NACK `failed to parse JSON payload: …` |
| `context.domain` absent | `400` NACK `missing field Domain in context` |
| `context.version` ≠ URL version | `400` NACK `schema not found for domain: ondc_trv11` |
| Unknown action segment | `400` NACK `schema not found …` |
| Unknown domain/version | `404` `api route not configured` — plain text, **not** a NACK envelope |
| Any segment but `test` | `404 page not found` — `test` is a literal, not a session id |
| `context.action` ≠ URL action | `200` NACK, L1 rule `REQUIRED_CONTEXT_ACTION_9` |
| `on_search` (callback leg) | validated identically — both directions work |
| **`context.transaction_id` absent** | **`500`** `Internal server error, MessageID: %!s(<nil>)` — a Go nil-format artifact, not a designed answer |
| 394 KB payload | `200`, ~1.06 s; 4000 bad items collapse to **one** finding with a `[*]` path |
| 1.6 MB payload | `200`, ~1.39 s — **no size ceiling observed** on the hosted instance |
| 8 calls back to back | no throttling; 0.32–0.51 s, ~0.08 s of it TCP connect (keep-alive saves it) |
| Timestamp 4 months stale | **ACKed** — no freshness or TTL checking at all |

Five consequences worth carrying forward:

1. **The layer is inferable from the grammar.** `layer: "L0" | "L1"` is free.
2. **Findings are bounded.** Wildcard collapsing means a 4000-item catalog yields
   one line, not 4000 — safe to put in a tool result without a cap.
3. **The schema is keyed off the payload's own `context.version`**, not the URL's.
   The URL only routes (404 when the build is not configured). They must agree.
4. **HTTP status is decoupled from ACK/NACK**, exactly as in our own receiver —
   `200` alone means nothing. Read `message.ack.status`.
5. **The context layer stays ours.** Freshness, TTL and session-relative identity
   are not checked upstream and cannot be — see §4.

### It is side-effect free, and this is confirmed at source

The route is the ONIX `standaloneValidator` adapter module, whose step list is
exactly `[validateSchema, validateOndcPayload]`. Three independent reasons
nothing leaves the process:

- **No forwarding.** The proxy path in ONIX's `stdHandler` only runs when
  `ctx.Route` is populated, and `ctx.Route` is only ever set by an `addRoute`
  step. This module has none, so the handler falls through to "send the ACK and
  return". No `router` plugin is even loaded.
- **No store write.** The persisting step (`validateOndcCallSave`) is absent, the
  module declares no `cache` plugin at all, and `stateFullValidations` is `false`.
- **No session, transaction or audit.** The module declares no middleware —
  unlike the `buyer` / `seller` / `mock` sibling modules, which each carry the
  network-observability and encryption middleware that emit to recorder-service.

`test` is a literal module name, not a mode toggle and not a session id; there is
no `live` counterpart. `{domain}` and `{version}` are **baked into each
api-service instance at build time**, which is why an unserved build answers
`404 api route not configured` rather than a NACK. The observable residue of a
call is a stdout log line and an in-process metric counter.

### Two ways to get a silently wrong answer

Both are avoidable, and both belong in the gateway rather than in a comment:

- **`context.transaction_id` is mandatory.** Without it the request 500s (table
  above) — the L1 validator dereferences it while building its internal payload.
  The gateway must refuse to call out without one and report `unavailable`.
- **Never send a `protocol_validation` cookie.** ONIX reads it, and the literal
  value `"false"` makes it **skip L1 entirely and answer ACK** — a false negative,
  the worst failure mode an oracle has. Absent means `"true"`. We send no cookies
  and must keep it that way; the live test should assert a known-bad payload still
  NACKs, which is what would catch this regressing.

`error.code` is always the literal string `"Bad Request"` (it is
`http.StatusText(400)`), so it carries no information. Every code we report comes
from parsing `error.message` — see §3.

---

## 3. Response grammar (what the parser must handle)

**L0** — plain text, entries joined by `;\n `:

```
at '/context/timestamp': got number, want string;
 at '/message/intent': got string, want object
```

Split on `;\n`, match `at '(?<pointer>[^']+)': (?<detail>.+)`, convert the JSON
Pointer to a JSONPath (`/context/timestamp` → `$.context.timestamp`).

**L1** — markdown, one block per rule code:

```
#### **REQUIRED_CONTEXT_CODE_1**

**All of the following must be true:**
  - $.context.location.country.code must be present in the payload
  - All elements of $.context.location.country.code must be in ["IND"];
 #### **VALID_ENUM_MESSAGE_TYPE_1**

- All elements of $.message.intent.fulfillment.type must be in ["ROUTE", "TRIP"]

> **Skip if:**
>
>     - $.message.intent.fulfillment.type is not in the payload;
 #### **VEHICLE_CATEGORY_REQUIRED**

- $.message.intent.fulfillment.vehicle.category must be present in the payload;
 for full list of validations refer https://workbench.ondc.tech/validations/developer-guide/ONDC:TRV11/2.0.1
```

Split on `#### **`; the code is the bolded header; the first `$.…` token in the
block is the JSONPath; the `> **Skip if:**` block is captured separately as
`skip_if`; the trailing "for full list of validations refer …" line is lifted out
as `docs_url` rather than left dangling on the last finding.

**The parser never throws and never loses information.** Anything it cannot
recognise becomes a single finding carrying the raw message verbatim. This is
prose, not a versioned API — it can change without notice, and a parser that
throws would turn an upstream copy-edit into a 500 inside our ACK window.

There is no structured alternative to fall back on. ONIX's error model does carry
an `error.paths` field of `;`-joined JSONPaths, but it is omitted when empty and
**it was empty on every response captured here**, L0 and L1 alike — checked
explicitly, because a populated `paths` would have removed the need for most of
this parser. Read it opportunistically if it ever appears; do not depend on it.

---

## 4. Shape

New module `src/modules/validate/`, layered per CLAUDE.md §5:

```
validate.schema.ts    zod: ValidationFinding, ValidationVerdict, tool IO
validate.gateway.ts   ValidationGateway iface + HttpValidationGateway (undici, shared agent)
validate.parse.ts     pure: message → ValidationFinding[]   ← the table-driven test target
validate.service.ts   layering, policy, caching, and the local context layer
validate.tool.ts      payload_validate
```

```ts
interface ValidationFinding {
  layer: "L0" | "L1" | "context";
  code: string;        // the L1 rule code, or L0_SCHEMA, or a context code
  json_path: string;   // $.context.location.country.code
  message: string;
  skip_if?: string;
}

interface ValidationVerdict {
  status: "valid" | "invalid" | "unavailable";
  findings: ValidationFinding[];
  checked: ("L0" | "L1" | "context")[];   // what actually ran
  docs_url?: string;
}
```

`"unavailable"` is a **third state, not a synonym for valid**. Same rule as
`RedisCacheStore` throwing instead of answering `undefined` (§5): collapsing "we
could not check" into "it passed" is how our own outage becomes a clean bill of
health in somebody else's compliance report.

### The gateway's whole contract, as a table

Everything the HTTP layer has to decide, in one place — the split between
`invalid` and `unavailable` is the part that matters, because getting it wrong in
either direction produces a false finding:

| Observed | Verdict |
| --- | --- |
| `200`, `ack.status: "ACK"` | `valid` |
| `200`, `ack.status: "NACK"` | `invalid` — parse `error.message` into findings |
| `400` (unparseable, no domain, no schema for this action/version) | `invalid`, one finding, `layer: "L0"` — these *are* payload defects |
| `500` | `unavailable` — the missing-`transaction_id` artifact, not a verdict |
| `404 api route not configured` | `unavailable` — this oracle does not serve this build |
| `413`, timeout, connection failure | `unavailable` |
| `context.transaction_id` absent locally | `unavailable`, **without calling out** — we know it 500s |

### The context layer stays ours

The oracle does not check freshness — verified: a four-month-old timestamp ACKed —
and cannot check session-relative facts. So `validate.service.ts` keeps a small
local `context` layer per §4: bap/bpp id match against the session, `message_id`
format, timestamp window, TTL. Pure functions, table-driven, gated by the
`timeValidations` / `sensitiveTTL` knobs §4a already reserves.

---

## 5. Where it runs

### (a) Inbound — the receiver, inside the ACK window

`receiver.service.ts#handle` step 5, **beside** the config's own validator rather
than before it:

```ts
const [protocol, verdict] = await Promise.all([
  this.#validation.check(...),        // remote L0+L1 + local context
  this.#mockEngine.runValidate(...),  // the flow's own validator
]);
```

Concurrent, not sequential: the two are independent, so the ACK pays `max(…)`
instead of the sum. When both fail, the config's validator wins the NACK code —
it is flow-specific and more actionable — and the protocol findings are attached
to the exchange either way.

| Verdict | Answer |
| --- | --- |
| `invalid` | **200 NACK**, code = first finding's code, recorded as evidence, flow does not advance — the existing NACK path with one more reason |
| `unavailable` | **ACK on the config validator alone**, and journal the skip |

Fail-open on `unavailable` is deliberate. NACKing a compliant participant because
*workbench* was unreachable writes our infrastructure failure into their
compliance report — precisely the failure mode §5 names when it forbids a bare
`catch {}` around a store read.

Budget: `VALIDATION_TIMEOUT_MS` default **2000 ms**, in the same spirit as
`REDIS_COMMAND_TIMEOUT_MS` — a dead dependency must not hold the participant's
socket open. Timeout ⇒ `unavailable` ⇒ fail-open.

**The latency cost, stated plainly:** a 394 KB `on_search` adds ~1 s to the ACK.
Mitigations, in order of effect: run it concurrently with the config validator
(above), share the container's keep-alive `Agent` (−80 ms/call), and the
`protocolValidations` knob §4a already reserves for exactly this.

### (b) Outbound — the gate in `flow_proceed`

`flow.service.ts#dispatch`, between `runGenerate` (`flow.service.ts:1924`) and
`appendApiEntry` (`flow.service.ts:1999`) — after the transaction id is settled
(`:1945`), before anything is bound, recorded or sent. CLAUDE.md §7 item 8 asks
for exactly this: "a malformed payload cannot reach the wire even if the model
never calls it."

- `invalid` ⇒ `BLOCKED`, reason `validation_failed`, findings in `details`.
  Nothing bound, recorded or sent — copy the existing `requirements_not_met`
  branch (`:1908`), which is the precedent for a blocked dispatch persisting
  nothing.
- `unavailable` ⇒ send anyway, journal the skip. There is no gate here today, so
  fail-open is never a regression; fail-closed would let a workbench outage stop
  every run in flight.
- `dry_run` ⇒ validate and **return** the findings without blocking. This is the
  "gate on the generated payload, not a drafting aid" of §1.

Worth noting what this actually catches: config bugs. Golden rule `fm-001` — an
`on_X` NACK is usually a generation symptom, not a protocol bug — and this is the
gate that says so before the payload reaches a third party.

### (c) `payload_validate`

```
in:  { session_id, action, payload, flow_id? }
out: ValidationVerdict
```

Read-only and idempotent, and the `annotations` should say so honestly (§5) —
unlike `flow_proceed` and `form_submit`, re-running this puts nothing on anyone's
wire.

---

## 6. Config

```
VALIDATION_SERVICE_URL   default https://workbench.ondc.tech/api-service
VALIDATION_TIMEOUT_MS    default 2000
VALIDATION_MODE          off | advisory | enforce      (default enforce)
```

`advisory` records findings but never NACKs and never blocks — the honest setting
while we build confidence that the oracle agrees with the network, and the
setting §9 ships first.

Register a third `HealthCheck` named `validation-service`, **non-fatal** for
`/ready`: unlike the config-service, an unreachable oracle degrades this server
rather than disabling it.

---

## 7. Caching

Key on `sha256(domain|version|action|payload)` in `catalogCache` — in-process,
derived, cheap — with a short TTL. It wins on `flow_restart` replays, on the model
calling `payload_validate` and then `flow_proceed` with the same body, and on
retries. It never wins on a genuinely new payload. This is a latency
optimisation and nothing is derived from it; a miss costs a round trip, never a
wrong answer.

---

## 8. Tests

Per §5, **no test touches the network.**

- `validate.parse.test.ts` — table-driven over captured real responses. The
  priority suite: this is the part everything else trusts.
- `src/test/validation-fixtures.ts` — the responses captured in §2's table.
- `FakeValidationGateway` in `fakes.ts`, injected by `createHarness` by default,
  scriptable to `valid` / `invalid` / `throw`.
- Receiver, via `app.inject()`: NACK on `invalid`, and **ACK on `unavailable`** —
  the fail-open test is the one that matters.
- Loop: extend `flow.loop.test.ts` — a `BLOCKED` outbound gate leaves the
  `MockAgent`'s wire empty.
- `validate.live.test.ts` behind `RUN_LIVE_TESTS=1`, alongside `catalog.live` and
  `flow.live`, asserting the real grammar has not drifted. This is the canary for
  the plan's one structural risk.

---

## 9. Sequence

1. `validate.parse.ts` + fixtures + its test. Pure, unwired, highest value.
2. Gateway + schema + container wiring + fake + health check.
3. `payload_validate` — the model-facing surface, exercisable before any gate is armed.
4. Outbound gate in `flow_proceed`. Lands before the inbound one on purpose:
   its failures are ours, not the participant's.
5. Inbound gate in the receiver — `MODE=advisory` first, then `enforce`.
6. Context layer, plus the `protocolValidations` / `timeValidations` /
   `sensitiveTTL` knobs on `session_create`.

---

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| ~~Does `/test/` have side effects?~~ | **Resolved** — none, confirmed at source three ways (§2). No proxying, no store write, no session or audit. |
| **False negative: L1 silently skipped** via a `protocol_validation=false` cookie | send no cookies; the live test asserts a known-bad payload still NACKs |
| The error format is prose, not a versioned API, and `error.paths` is empty | parser degrades to the raw message and never throws; `validate.live.test.ts` is the canary |
| `500` on a missing `context.transaction_id` | guarded before the call; `500` maps to `unavailable`, never to `invalid` |
| Latency inside the ACK window (~1.0 s at 394 KB, ~1.4 s at 1.6 MB) | tight timeout, concurrency with the config validator, keep-alive agent, the knob |
| Oracle unreachable | the third `unavailable` state, fail-open, journal the skip |
| A build the oracle does not serve — domain/version are baked in per instance | `404 api route not configured` ⇒ `unavailable`, never `invalid` |
| Two round trips per exchange (in + out) on a busy run | the §7 cache, and `MODE=off` for latency-sensitive runs |
| No auth and no rate limiting upstream — nothing stops us hammering it | the §7 cache; keep the timeout tight so a stalled call cannot pile up |
