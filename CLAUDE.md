# CLAUDE.md — ondc-mcp (LLM-driven mock NP)

Guidance for Claude Code when working in `automation-mcp/`. **Only this directory is
under development.** Everything else in `../` is reference material — read it, never
edit it.

---

## 1. What we are building

An MCP server that lets an **LLM act as a mock ONDC network participant** — a mock
buyer (BAP) or mock seller (BPP) — for one full transaction flow, end to end, and
then report how protocol-compliant that transaction was.

The ONDC Protocol Workbench (`../automation-framework/`) already does this with
compiled Go plugins, a Redis-backed flow engine, and per-step base64 JavaScript
executed in a VM sandbox. **We are not wrapping those services.** We re-implement the
protocol logic natively in this repo and expose it as MCP tools, so the piece the
workbench solves with sandboxed JS — _what payload comes next, and is the one I got
acceptable_ — can be solved by a model instead.

We consume the workbench's **flow definitions and mock-runner configs** from its
config-service, and we **execute** the per-step JS through
`@ondc/automation-mock-runner` — same assets, same sandbox. That is what makes
this a faithful mock rather than an approximation of one.

Three decisions fix the shape of the system. Do not relitigate them silently:

| Decision               | Choice                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Spec source**        | **The live config-service.** `CONFIG_SERVICE_URL` (default `https://workbench.ondc.tech/config-service`) is the single source of builds, flow definitions and mock-runner configs; responses are cached in-process. Nothing is bundled — if it is unreachable, sessions cannot be created and `/ready` says so. Signing keys still come from env. |
| **Wire ownership**     | **Full NP.** The Fastify app hosts real receiver routes (verify → validate → ACK/NACK) and signs and POSTs real outbound calls. We replace api-service + ONIX for the mock side.                                                                                                                                                                  |
| **ACK/NACK authority** | **Deterministic, plus an LLM override hook.** Code decides the synchronous ACK/NACK; a session-scoped rule set the LLM registers up front can force NACKs (negative / "monkey" testing). No LLM round-trip inside the ACK window.                                                                                                                 |

### The division of labour (this is the whole idea)

| Deterministic — code, always                       | Model — via tools                               |
| -------------------------------------------------- | ----------------------------------------------- |
| Generating the payload (the flow's own `generate`) | Deciding **when** a step goes                   |
| Auth header sign + verify                          | Filling the inputs a step declares              |
| L0 JSON-schema validation                          | Choosing which unsolicited/extra action to fire |
| L1 contextual rule validation                      | L2 business/semantic judgement on inbound       |
| Context checks (ids, timestamp, TTL)               | Filling a counterparty's form                   |
| Sequence matching + ACK/NACK                       | Narrating the compliance report                 |
| Recording payloads + business data                 |                                                 |
| Computing the report                               |                                                 |

**This changed during the flow-loop milestone, deliberately.** The original plan
had the model _drafting payload bodies_, with `payload_template` and
`payload_validate` as a guardrail loop. Executing the flow's own published
`generate` instead is strictly better: it is the code the network is actually
calibrated against, it cannot drift from the spec the way a model's draft can,
and it frees the model for the parts that genuinely need judgement. The
guardrail tools are still worth building — as a _gate_ on the generated payload,
not as a drafting aid.

### How the workbench's per-step JS is actually used

**Shipped: we execute it, we do not re-implement it.** Each step of a published
flow carries three base64 JavaScript functions authored against the workbench's
contract, and `src/lib/mock-engine/` runs them in `@ondc/automation-mock-runner`'s
worker sandbox — the same assets the workbench executes, fetched from the same
config-service.

| mock-runner function                    | Where it runs                                                                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `generate(defaultPayload, sessionData)` | `flow_proceed` — produces the outbound payload before signing and sending                                                                 |
| `validate(target, sessionData)`         | The receiver, inside the ACK window — its verdict _is_ the ACK/NACK                                                                       |
| `meetsRequirements(sessionData)`        | `flow_proceed`, before generating — an unmet precondition returns `BLOCKED` to the model rather than an error payload to the counterparty |
| `saveData` JSONPath / `EVAL#`           | `record.saveBusinessData`, after every accepted exchange in both directions                                                               |

This is why the division of labour above reads the way it does: the model's job
is **inputs and judgement**, not JSON. It decides _when_ a step goes, supplies
the values the flow declares, and reads what comes back — the payload itself is
generated by the flow's own published code.

Treat the base64 `generate` / `validate` / `requirements` bodies as **executable
assets, never as reference text** — a single flow's config is ~330KB, so it is
fetched server-side, cached under a handle, and never allowed into the model's
context.

Still to come: L0/L1 schema validation as a _gate_ on the outbound path, and the
model's own L2 verdict on inbound (`inbound_review`). Today the guard on outbound
is the config's own `meetsRequirements` plus whatever the counterparty NACKs.

---

## 2. The runtime contract (`../workbench-steps.md`)

Every tool exists to serve one of these steps. If a proposed tool does not, question it.

1. **Create session** — fetch flows and NP information.
2. **Start flow.**
3. **Flow loop:**
   1. wait for, send, or supply input for the latest request
   2. **on receive** → verify header (public-key lookup) → L0 + L1 → context → **ACK/NACK** → L2
   3. **on respond** → check requirements → generate payload → sign with own keys → respond
   4. persist payload **and** business data, for both received and sent
4. **Generate a report** on how compliant the transaction flow was.

Step 3.2 runs entirely in code, in that order, inside the HTTP receiver
(`transport/receiver.service.ts`). Steps 3.1 and 3.3 are the model's loop, driven
by `flow_proceed` / `flow_await`; step 4 is not built yet.

---

## 3. Tool surface

Names follow the scaffold convention `module_verb_noun`. Every tool declares
`inputSchema` **and** `outputSchema` (`defineTool` will not compile otherwise).

**Transport** — ✅ shipped

- `receiver_start` — ensure the inbound endpoint is live; returns the callback URL (`{base}/{domain}/{version}/{buyer|seller}`, which the participant registers as our subscriber URL and appends `/{action}` to) and whether the participant can plausibly reach it
- `receiver_stop` — close the standalone listener (stdio only; explains itself under HTTP)

**Session & catalog** — ✅ shipped

- `catalog_list_builds` — every published domain / version / use-case
- `session_create` — participant's subscriber URL + `np_type` (BAP|BPP) + domain/version/usecase → `session_id`, the **derived** `mock_role`, `callback_url`, and the available flows. Optional `interaction_mode` (`llm_auto`|`manual`), `auto_advance`, `receiver_public_url` (may override the host but **not** the path — routes are mounted once at boot). _(difficulty knobs and `nack_rules` still to come)_
- `session_get` — the session: participant, mock role, build, callback URL, expiry
- `catalog_list_flows` — flow summaries with per-actor step counts
- `catalog_describe_flow` — the full sequence; every step tagged `actor: mock | np | unknown`
- `catalog_load_flow_config` — fetch + cache a flow's mock-runner config; returns a summary and a `cache_key`, never the config

**Flow loop** — ✅ shipped

- `flow_start` — session_id, flow_id → transaction_id, callback_url, and the first `StepOutcome`. Validates the flow _before_ anything is sent: it must have a mock config, every step an owner, and every step key a config entry
- `flow_proceed` — **the loop driver.** Requirements → generate → send → record → save, for the next mock-owned step. Optional `inputs`, `trigger_extra`, `dry_run`
- `flow_await` — bounded blocking wait for the participant; reads the record first so a callback that already landed is never missed
- `flow_get_status` — the derived flow map: every step's status and owner, off-sequence exchanges, and what the loop needs next
- `form_fetch` / `form_submit` — a form the participant hosts: fetch, screen, parse, fill, post. A form _we_ host needs no tool — the participant opens the URL we already sent

`StepOutcome` is the tagged union every loop call ends in: `SENT` · `DRAFTED` ·
`READY` · `INPUT_REQUIRED` · `FORM_PENDING` · `WAITING` · `COMPLETE` · `BLOCKED`.
The tag says which tool to reach for next; `flow_proceed` never answers `READY`
because it would have dispatched it.

**Record** — ✅ shipped

- `record_get_payload` — a stored payload by handle, with optional JSONPath slice and a byte cap
- `record_get_data` — accumulated business data; oversized values are named, not returned

**Still to come**

- `session_state` — live transactions, step statuses, accumulated business data
- `inbound_review` — the model's L2 verdict, recorded against an exchange
- `payload_validate` — dry-run L0 + L1 + context on a draft, with per-failure JSONPath + rule code
- `header_sign` / `header_verify` — ed25519 + BLAKE2b-512, and the outbound signer behind the `RequestSigner` seam
- `report_generate` — per-step compliance over the recorded transaction

**Resources** — read-only grounding, no side effects. Shipped: `ondc://builds` ·
`ondc://session/{sessionId}` · `ondc://txn/{sessionId}/{transactionId}` (slim) ·
`ondc://payload/{payloadId}` (full body). Planned:
`ondc://schema/{domain}/{version}/{action}`.

**Prompts** — ✅ `mock_buyer`, `mock_seller`: the persona + loop discipline that makes a
model alternate `flow_proceed` / `flow_await` correctly instead of polling.

---

## 4. Protocol facts to implement exactly

These are runtime-verified against the live workbench. Do not "improve" them —
divergence from ONDC is a bug even when it looks cleaner.

### Signing (`signing/`)

- Ed25519 signature over a **BLAKE2b-512** (64-byte) digest. BLAKE2b, **not** BLAKE2s.
- Hash the **exact payload bytes received**. Never parse → re-stringify.
- Standard base64 (not URL-safe). LF newlines.
- Signing string, exactly: `(created): {ts}\n(expires): {ts}\ndigest: BLAKE-512={digest}`
- Header: `Signature keyId="{subscriber_id}|{unique_key_id}|ed25519",algorithm="ed25519",created="{unix}",expires="{unix}",headers="(created) (expires) digest",signature="{b64}"`
- Private key may be 32 bytes (seed) or 64 bytes (expanded) — handle both.
- Verify: parse → `created <= now <= expires` → digest → verify. No skew tolerance.
- Reference implementations in five languages: `../header-guide/code-snippets.ts`;
  the normative prose is `../header-guide/AlgorithmDocs.tsx`.

Counterparty public keys come from a local keystore (file or env map) behind a
`KeyProvider` interface. A registry-lookup provider can slot in later; v1 has no
registry dependency.

### Validation layers (`validate/`)

- **L0** — JSON Schema for `ONDC_{DOMAIN}_{VERSION}_{action}`: structure, types, required, formats.
- **L1** — contextual rules from the bundle's `x-validations`: required context fields, enums, regex (TTL pattern), conditionals (`bpp_id` required on `on_search`, not on `search`), state deps. Every failure carries a code **and** a JSONPath.
- **Context** — bap/bpp id match, message_id format, timestamp window, TTL.
- **L2** — business/semantic. Post-ACK, model-supplied, never blocks the ACK.

### The endpoint, and how a call is matched to a session

The URI we advertise as `bap_uri` / `bpp_uri` is
**`{base}/{domain}/{version}/{buyer|seller}`** — the shape the workbench
publishes (`config-cache.ts:210-211`), with no action suffix and no session id.
The caller appends `/{action}` itself. `buyer` is the URI of a BAP and `seller`
the URI of a BPP, so the segment names **our** role; it follows that the
counterparty is on the opposite side of the payload's context, which is where
the receiver reads it from (`bpp_uri` when we are the BAP, `bap_uri` when we
are the BPP). Absent ⇒ 400: nothing else on the wire says who is calling.

The URI is therefore **shared by every session on a build** — a participant
integrates against an endpoint, not against one of our test runs — and the
session is recovered from the payload, in this order:

1. a `transaction_id → {sessionId, subscriberUrl}` index (`txn_index::{id}`);
2. an expectation armed on that endpoint for that action
   (`expect::{DOMAIN}::{version}::{role}`, holding a list);
3. neither ⇒ 412.

**One deliberate divergence.** The workbench looks the transaction up under the
URI the payload advertises. We index the id on its own, because those two URLs
are meant to be identical and routinely are not — a trailing slash, a differing
pathname. Under the workbench's rule a drifted URI does not merely 412: it falls
through to the expectation branch and opens a _second_ record under a second
key, leaving the receiver writing to one half of a transaction while
`flow_get_status`, `flow_await` and `record_get_payload` read the other. The
mismatch is logged; records always key on the registered
`session.np.subscriber_url`, never on the advertised one.

Two sessions on one endpoint armed for the same action are separated by a
ranking ladder — quoted `transaction_id`, then registered URL, then host, then
oldest armed — because the wire genuinely cannot tell them apart.

### ACK/NACK and HTTP status (receiver)

HTTP status is **decoupled** from ACK/NACK:

| Situation                                                                            | Status  | Body                                                                                                               |
| ------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------ |
| Accepted                                                                             | 200     | `{message:{ack:{status:"ACK"}}}`                                                                                   |
| Step validator rejected it                                                           | **200** | `{message:{ack:{status:"NACK"}}, error:{code, message}}`                                                           |
| Validator crashed / broke its contract                                               | **200** | NACK, code `VALIDATION_FUNCTION_ERROR`                                                                             |
| Not a step the flow is waiting for                                                   | **200** | NACK, code `OUT_OF_SEQUENCE` — recorded anyway, as evidence                                                        |
| `context.action` ≠ the URL's action segment                                          | **200** | NACK, code `ACTION_MISMATCH` — resolved and recorded first; the call did arrive                                    |
| Signature invalid / expired                                                          | 401     | — _(seam only; `verifyAuth` is a no-op today)_                                                                     |
| Malformed context (no `message_id`, `action`, `transaction_id`, or counterparty URI) | **400** | _Deliberate divergence: the workbench panics with 500 on a missing `message_id`. We refuse cleanly and record it._ |
| Transaction belongs to another domain/version/role                                   | 412     | NACK `WRONG_ENDPOINT`, naming the endpoint it does belong to                                                       |
| An expectation named a session that has expired                                      | 412     | NACK `SESSION_EXPIRED`                                                                                             |
| Unknown transaction, no expectation                                                  | 412     | NACK `NO_EXPECTATION` — `No active expectation found for transaction ID: … and Subscriber URL: …`                  |

`context.action` is authoritative for step matching, as in `receiver.go:118`.
The path's action segment is for routing, and for the consistency check above.

Inbound requests match a pending step by **action type**, plus a `message_id`
echo where the flow declared a `pair` (`awaitingMessageId`). The workbench
matches on the triplet `action::message_id::timestamp` against an
already-recorded payload; that only works because it records the expected call
before it arrives, and matching a _live_ call that way would mean predicting its
timestamp. No match ⇒ NACK `OUT_OF_SEQUENCE`, **record it anyway**, do not
advance the flow — the mapper classifies it as a missed step on the next read,
and an unexpected call is one of the most valuable things a compliance run
catches.

The ACK is written **before** any auto-advance chaining (`setImmediate` after
`reply.send`). Chaining inside the ACK window would hold the participant's
connection open for the length of our own outbound call.

### Identity model

- `session_id` — one mock-NP session, many transactions
- `transaction_id` — one flow instance; **new** id for a flow's first action, **same** id for the rest
- `message_id` — unique per call
- Records are keyed `{transaction_id}::{subscriber_url}` — the same transaction against a different counterparty is a separate record. Business data lives under `MOCK_DATA::{transaction_id}::{subscriber_url}`. The URL half is normalised (`normaliseSubscriberUrl`: trailing slash, host case, default port), because half these URLs are the one registered at `session_create` and half are whatever the participant advertises. **The path is preserved** — `https://np.example.com/ondc` is a different participant from `https://np.example.com`.
- A session's `callback_url` is **not** an identifier. It is the endpoint, and every session on the same build and role shares it.

### Step statuses (from the workbench state machine)

`COMPLETE` · `LISTENING` · `RESPONDING` · `WAITING` · `INPUT-REQUIRED` ·
`WAITING-SUBMISSION` · `PROCESSING`. Actionable =
`{LISTENING, RESPONDING, INPUT-REQUIRED, WAITING-SUBMISSION}`; `LISTENING` only
arms an expectation. The full truth table is
`flow/engine/pending-step.ts`, stated as data in its test.

State is **derived**, never stored as a pointer: replay the recorded exchange
list to compute the current step, exactly as the workbench does. That is what
makes concurrent reads agree and a crashed dispatch leave nothing stale.

**One deliberate divergence in the replay.** The workbench orders exchanges by
`context.timestamp`; we order by our own append counter (`seq`) whenever both
entries have one, falling back to timestamp otherwise. The timestamp is written
by whoever produced the payload — for half the exchanges, the participant under
test. A participant whose clock runs a second fast stamps its `on_search` later
than the `select` we send in response, and a timestamp sort replays them
backwards: `select` matches no pending step, is filed as out-of-order, and the
flow never completes. A correct implementation reads as non-compliant, for a
reason nothing in the trace points at. See `engine/reduce-history.ts`.

Form steps (`HTML_FORM`, `DYNAMIC_FORM`) are **shipped**, in both directions —
see `modules/forms/`. `HTML_FORM_MULTI` is still rejected at index time.

### Difficulty knobs

Implement: `sensitiveTTL`, `timeValidations`, `protocolValidations` (gates L1),
`headerValidation` (gates signature verify), `stopAfterFirstNack`.
Out of scope (they are workbench routing concerns): `useGateway`, `useCare`,
`useTunnelForFIS`, `useGzip`, `encryptionValidation`.

**LLM override hook:** `session_create` accepts `nack_rules` — declarative predicates
(action, JSONPath, condition, error code) evaluated by the deterministic path. This
is how the model runs negative testing without sitting in the ACK window.

---

## 5. Code conventions (inherited — see `README.md`)

The scaffold's rules are load-bearing. `README.md` explains why; this is the summary.

- **Layering `tool → service → repository`, one way, never skipped.** A service imports nothing from the MCP SDK. A tool holds no business rule. When the backing store is a remote HTTP service the repository slot is named `*.gateway.ts` (see `catalog.gateway.ts`) — same contract, clearer name.
- **Schemas first.** `*.schema.ts` with zod; types come from `z.infer<>`.
- **One line per module in `src/mcp/capabilities.ts`** — nothing else wires up.
- **Two error channels.** Model-fixable failure (bad payload, not found, upstream down) ⇒ `{isError:true}` tool result. Client-fixable (auth, unknown method) ⇒ JSON-RPC error. A validation NACK is _always_ the tool channel — the model must read it and retry differently.
- **stdout is the protocol.** pino writes to stderr; `no-console` is an error; a test spawns the real stdio entrypoint and fails on one stray byte.
- **`buildMcpServer` stays cheap** — it runs once per HTTP request. Expensive or shared things go in `createContainer` and are closed over.
- **No module-level mutable state.** Our NP has genuinely cross-request state (sessions, transactions, expectations). It lives behind the `CacheStore` port (`src/lib/cache/`), reached through a repository and injected via the container. Never a module-scope `Map`. There are **two instances of that port**, and the split is load-bearing: `stateStore` (Redis when `REDIS_URL` is set, in-process otherwise) holds what must outlive a restart; `catalogCache` is _always_ in-process because `FlowService.load()` reads a ~330KB mock config on every `flow_proceed` and every inbound callback, and that data is derived, TTL'd at 15min, and re-fetched transparently on a miss. Do not "simplify" them back into one — `createContainer` explains the reasoning in place.
- **A store read is not a cache read.** `RedisCacheStore` throws `UpstreamError` when Redis is unreachable rather than answering `undefined`, because `undefined` means "no such session" and the model responds to that by starting a **second transaction on a real participant's wire**. Any `catch` around a store read must name the error it swallows (`receiver.service.ts#loadSession` is the pattern); a bare `catch {}` there turns our outage into their recorded non-compliance.
- **`get` returns a copy, not a reference.** Redis round-trips through JSON, so mutating a fetched object updates nothing and an explicit `undefined` property is dropped. Build stored shapes with the `...(x !== undefined ? { x } : {})` idiom and always write back explicitly.
- **Nothing large reaches the model.** Tool results are context. Fetch big artefacts server-side, cache them, and return a summary plus a handle — `catalog_load_flow_config` is the pattern.
- **Tests never touch the network.** `createHarness` injects a fixture-backed config-service gateway by default; outbound calls go through an injected undici `MockAgent` (`senderDispatcher`). `src/test/ondc-fixtures.ts` holds real captured responses — faithful to the wire but _not executable_, because their base64 is truncated. `src/test/runnable-config.ts` holds a small invented config that genuinely runs, so loop tests exercise a real worker round trip. Live tests are opt-in via `RUN_LIVE_TESTS=1` (`catalog.live`, `flow.live`).
- **Set `annotations` honestly** — clients auto-approve on them. `flow_proceed` and `form_submit` are _not_ read-only and _not_ idempotent: re-running either puts a second call on a third party's wire.
- Both transports are built from the same factory; anything registered works on stdio and HTTP alike.

`src/modules/example/` is the reference pattern: copy it, do not extend it. Delete it
once `session` and `catalog` are real.

---

## 6. Layout

```
src/lib/
  cache/           CacheStore port + in-memory and Redis implementations
  events/          TransactionEvents — the wake-up primitive behind flow_await
  mock-engine/     the @ondc/automation-mock-runner adapter; worker pool lifetime
  stdout-guard.ts  rebinds console onto stderr before anything else loads (stdio)

src/modules/
  catalog/     ✅ config-service client, builds/flows/mock configs, actor annotation
  session/     ✅ sessions, NP identity, role inversion, interaction mode  (later: difficulty knobs, nack_rules)
  flow/        ✅ engine/ (ported mapper) + the loop: start · proceed · await · status, prompts
  record/      ✅ exchanges + payloads + business data, all CacheStore access
  transport/   ✅ inbound receiver (pipeline + routes + lifecycle) + outbound sender
  forms/       ✅ forms this mock hosts, and forms it has to fetch and fill
  validate/    L0 · L1 · context · L2 intake            (not built)
  signing/     ed25519 + blake2b-512, KeyProvider       (not built)
  report/      compliance report                        (not built)

src/test/
  harness.ts         in-process client ↔ server; injects the fake gateway by default
  fakes.ts           fixture-backed ConfigServiceGateway
  ondc-fixtures.ts   real captured config-service responses — faithful, NOT executable
  runnable-config.ts a small invented config that genuinely runs, for loop tests
  mock-participant.ts scripted counterparty over undici's MockAgent
```

**`flow/engine/` is a near-verbatim port** of the workbench's mapper
(`../automation-mock-playground-service/src/service/flows/`), together with its
1500-line test suite. Keep it diffable: a fix landing upstream should be
replayable here by eye. The two deliberate divergences are documented in place
(`seq` ordering in `reduce-history.ts`, the `toEngineFlow` adapter).

Env (extend `src/config/env.ts`, keep the fail-fast-at-boot property). Live today:
`CONFIG_SERVICE_URL`, `CONFIG_SERVICE_TIMEOUT_MS`, `CATALOG_CACHE_TTL_MS`,
`SESSION_TTL_MS`, `RECEIVER_PORT`, `RECEIVER_PUBLIC_URL`,
`RECEIVER_ROUTE_PREFIX`, `MOCK_SUBSCRIBER_ID`,
`SEND_TIMEOUT_MS`, `AWAIT_MAX_WAIT_MS`, `FLOW_STATUS_TTL_MS`,
`RUNNER_CACHE_TTL_MS`, `RUNNER_FETCH_ALLOWLIST`, `FORM_FETCH_TIMEOUT_MS`,
`TRANSACTION_TTL_MS`, `EXPECTATION_TTL_MS`, `REDIS_URL`, `REDIS_KEY_PREFIX`,
`REDIS_COMMAND_TIMEOUT_MS`. Arriving with signing: `ONDC_SUBSCRIBER_ID`,
`ONDC_UNIQUE_KEY_ID`, `ONDC_SIGNING_PRIVATE_KEY`, `ONDC_SIGNING_PUBLIC_KEY`,
`ONDC_COUNTERPARTY_KEYS`.

`.env` is read by `npm run dev` / `dev:stdio` via Node's
`--env-file-if-exists` (hence `engines.node >= 22.9`); `npm start` and the
container take the real environment.

**State persistence.** `REDIS_URL` unset — the default — keeps everything
in-process, which is what makes the server runnable with no infrastructure.
Set it and sessions and transactions survive a restart, including the
`tsx watch` reload that fires on every file save:

```bash
docker compose -f docker-compose.dev.yml up -d   # redis:8-alpine, loopback, appendonly
echo 'REDIS_URL=redis://127.0.0.1:6379' >> .env
RUN_REDIS_TESTS=1 npm test -- redis-cache-store  # opt-in; needs the container
```

Three read-modify-write sites are **known lost-update races**, widened but not
introduced by Redis: `record.repository.ts#addTransactionLocation`,
`#indexTransaction`, and `#saveExpectations`. The window is sub-microsecond
in-process and milliseconds over a socket, so two concurrent flows in one
session can drop an entry. The fix is to widen the port with a set-append
primitive (`SADD`) rather than to retry here; until then, do not add a fourth.

---

## 7. Build order

Each phase lands with tests before the next starts.

0. ✅ `catalog` — config-service gateway, `catalog_list_builds` / `catalog_list_flows` / `catalog_describe_flow` / `catalog_load_flow_config`, `ondc://builds`.
1. ✅ `session` — `session_create` / `session_get`, role inversion, `ondc://session/{id}`, interaction mode + auto-advance + callback URL.
2. ✅ `flow/engine` — the ported mapper and its ported test suite.
3. ✅ `record` — exchanges, out-of-line payloads, business data (`getUpdatedData` port), `record_get_payload` / `record_get_data`, `ondc://txn` / `ondc://payload`.
4. ✅ `mock-engine` + `transport/sender` + the outbound loop — `flow_start` / `flow_get_status` / `flow_proceed`.
5. ✅ `transport/receiver` — both entrypoints, the inbound pipeline, ACK/NACK, expectations, 400/412, `flow_await`, `receiver_start` / `receiver_stop`.
6. ✅ `forms` + auto-advance chaining + `mock_buyer` / `mock_seller` prompts.

**Still to build**, in this order:

7. `validate` — L0 + L1 + context as pure functions; `payload_validate`, and the gate inside `flow_proceed` so a malformed payload cannot reach the wire even if the model never calls it. Table-driven tests are the priority; this is the module everything else trusts. Schemas and L1 rules come from the config-service (`/protocol/spec/{domain}/{version}`).
8. `signing` — `header_sign` / `header_verify`, cross-checked against the header-guide vectors, then dropped into the `RequestSigner` seam on `SenderService` and the `verifyAuth` hook on the receiver. Both seams already exist and ship no-ops.
9. `report` + L2 — `inbound_review`, `report_generate`, `session_state`, and the difficulty knobs / `nack_rules` on `session_create`.

**Testing** — service logic: plain unit tests. Tools/resources/prompts:
`src/test/harness.ts` (real client ↔ real server over in-memory transport).
HTTP and the receiver: `app.inject()`. Outbound: an injected undici `MockAgent`.
stdio: a real subprocess, asserting stdout carries only protocol bytes — the
mock-runner writes `console.log` under `NODE_ENV=development`, so
`lib/stdout-guard.ts` and that test are load-bearing together.

The end-to-end loop test (`flow/flow.loop.test.ts`) is the one that matters:
both directions real, payloads generated by config JavaScript in a worker,
callbacks arriving through the actual routes.

```bash
npm run dev        # HTTP on :3000        npm run dev:stdio
npm run inspect    # MCP Inspector        npm test
npm run typecheck && npm run lint && npm test    # before declaring anything done
```

---

## 8. Reference map (read-only siblings)

Never modify anything outside `automation-mcp/`.

| Need                                                 | Look at                                                                                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Flow engine, statuses, resolver chain, jobs          | `../automation-framework/knowledge/protocol-workbench/frames/flow-state-machine.md`, `scripts/flow-execution.md`                        |
| Which layer catches what, path-dependent enforcement | `frames/validation-layers.md`                                                                                                           |
| Signing algorithm, header format, live capture       | `frames/signing-security.md` + `../header-guide/`                                                                                       |
| Receiver step order, HTTP status semantics           | `scripts/onix-request-lifecycle.md`                                                                                                     |
| Session / transaction / message identity, key shapes | `frames/transaction-session.md`                                                                                                         |
| Difficulty knobs (all 10, with defaults)             | `frames/session-difficulty.md`                                                                                                          |
| Generator / validator / requirements contract        | `frames/mock-runner-lib.md`, `../automation-mock-runner-lib/src/lib/`                                                                   |
| Endpoint + state-machine reference for the mock      | `../automation-mock-playground-service/docs/decision-flows.md`, its `CLAUDE.md`                                                         |
| ACK/NACK body shapes, error payloads                 | `../automation-mock-playground-service/src/utils/{ackUtils,build-error-payload,create-generic-context}.ts`                              |
| Symptom → cause → fix patterns                       | `.../knowledge/protocol-workbench/patterns/` (golden rule `fm-001`: an `on_X` NACK is usually a generation symptom, not a protocol bug) |
| Whole-system orientation                             | `.../knowledge/protocol-workbench/INDEX.md`, `LOCATOR.md`                                                                               |

The knowledge book is written to be scanned before it is read: hit `LOCATOR.md` or
`INDEX.md`, narrow to two or three frames, then open only those.
