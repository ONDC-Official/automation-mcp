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
workbench solves with sandboxed JS — *what payload comes next, and is the one I got
acceptable* — can be solved by a model instead.

We do, however, consume the workbench's **flow definitions and mock-runner configs**
from its config-service, and a later step will execute the per-step JS through
`@ondc/automation-mock-runner`. So each step ends up with two possible drivers — the
model, or the workbench's own logic — and that is deliberate: they cross-check each
other.

Three decisions fix the shape of the system. Do not relitigate them silently:

| Decision | Choice |
| --- | --- |
| **Spec source** | **The live config-service.** `CONFIG_SERVICE_URL` (default `https://workbench.ondc.tech/config-service`) is the single source of builds, flow definitions and mock-runner configs; responses are cached in-process. Nothing is bundled — if it is unreachable, sessions cannot be created and `/ready` says so. Signing keys still come from env. |
| **Wire ownership** | **Full NP.** The Fastify app hosts real receiver routes (verify → validate → ACK/NACK) and signs and POSTs real outbound calls. We replace api-service + ONIX for the mock side. |
| **ACK/NACK authority** | **Deterministic, plus an LLM override hook.** Code decides the synchronous ACK/NACK; a session-scoped rule set the LLM registers up front can force NACKs (negative / "monkey" testing). No LLM round-trip inside the ACK window. |

### The division of labour (this is the whole idea)

| Deterministic — code, always | Model — via tools |
| --- | --- |
| Auth header sign + verify | Drafting the payload body |
| L0 JSON-schema validation | L2 business/semantic judgement on inbound |
| L1 contextual rule validation | Filling user inputs |
| Context checks (ids, timestamp, TTL) | Choosing which unsolicited/extra action to fire |
| Sequence matching + ACK/NACK | Narrating the compliance report |
| Recording payloads + business data | |
| Computing the report | |

Mapping from the workbench's per-step JS to us (`../automation-mock-runner-lib`):

| mock-runner function | Becomes |
| --- | --- |
| `generate(defaultPayload, sessionData)` | Model drafts the payload; `payload_template` supplies the default + session data + schema + examples; `payload_validate` is the guardrail loop |
| `validate(target, sessionData)` | `inbound_review` — the model's L2 verdict on a received payload |
| `meetsRequirements(sessionData)` | `step_requirements` returns declarative requirements; the model confirms or blocks |
| `saveData` JSONPath / `EVAL#` | `session_data_save` — config-driven where the flow declares it, model-driven otherwise |

The mapping is not a replacement. `catalog_load_flow_config` already fetches each
flow's real mock-runner config and caches it server-side under a `cache_key`; the
execution tools that run it through `@ondc/automation-mock-runner` come later. Treat
the base64 `generate` / `validate` / `requirements` bodies as **executable assets**,
never as reference text — and never let them reach the model's context, since a
single flow's config is ~330KB.

A model that never calls a validation tool must still be unable to put a malformed
payload on the wire: `payload_send` re-runs L0 + L1 + context before signing and
refuses on failure. **Validation is a gate, not a suggestion.**

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

Step 3.2 runs entirely in code, in that order, inside the HTTP receiver. Steps 3.1,
3.3 and 4 are the model's loop, driven by `flow_next`.

---

## 3. Tool surface

Names follow the scaffold convention `module_verb_noun`. Every tool declares
`inputSchema` **and** `outputSchema` (`defineTool` will not compile otherwise).

**Session & catalog** — shipped
- `catalog_list_builds` — every published domain / version / use-case
- `session_create` — participant's subscriber URL + `np_type` (BAP|BPP) + domain/version/usecase → `session_id`, the **derived** `mock_role`, and the available flows. *(difficulty knobs and `nack_rules` land with the receiver)*
- `session_get` — the session: participant, mock role, build, expiry
- `catalog_list_flows` — flow summaries with per-actor step counts
- `catalog_describe_flow` — the full sequence; every step tagged `actor: mock | np | unknown`
- `catalog_load_flow_config` — fetch + cache a flow's mock-runner config; returns a summary and a `cache_key`, never the config

Later: `session_state` — live transactions, step statuses, accumulated business data.

**Flow loop**
- `flow_start` — session_id, flow_id, optional transaction_id/inputs → transaction_id + first actionable step
- `flow_next` — **the loop driver.** Returns one of `WAIT` / `RESPOND` / `INPUT_REQUIRED` / `COMPLETE`, with the step contract attached
- `step_requirements` — declarative preconditions for the pending step, checked against session data
- `payload_template` — default payload + prior session data + JSON schema + examples for the step
- `payload_validate` — dry-run L0 + L1 + context on a draft; returns per-failure JSONPath + rule code. **The model is expected to iterate here.**
- `payload_send` — re-validate → sign → POST to counterparty → record
- `inbound_next` — the oldest unreviewed inbound request plus its deterministic verdict
- `inbound_review` — the model's L2 verdict, recorded against that exchange
- `session_data_save` / `session_data_get` — business data carried across steps

**Crypto (also useful standalone)**
- `header_sign` / `header_verify`

**Reporting**
- `report_generate` — per-step compliance over the recorded transaction

**Resources** — read-only grounding, no side effects. Shipped: `ondc://builds` ·
`ondc://session/{sessionId}`. Planned: `ondc://schema/{domain}/{version}/{action}` ·
`ondc://transaction/{transactionId}`.

**Prompts** — `mock_buyer`, `mock_seller`: the persona + loop discipline that makes a
model drive `flow_next` correctly.

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

### ACK/NACK and HTTP status (receiver)
HTTP status is **decoupled** from ACK/NACK:

| Situation | Status | Body |
| --- | --- | --- |
| Accepted | 200 | `{message:{ack:{status:"ACK"}}}` |
| L0 / L1 / context failure | **200** | `{message:{ack:{status:"NACK"}}, error:{code, message}}` |
| Signature invalid / expired | 401 | — |
| Bad request, unresolvable target | 400 | — |
| Unknown transaction, no expectation | 412 | `No active expectation found` |
| Malformed context (missing `message_id`) | **400** | *Deliberate divergence: the workbench panics with 500 here. We refuse the request cleanly and record it.* |

Inbound requests match a pending step on the triplet **`action::message_id::timestamp`**.
No match ⇒ log, record as out-of-sequence, do **not** advance the flow.

### Identity model
- `session_id` — one mock-NP session, many transactions
- `transaction_id` — one flow instance; **new** id for a flow's first action, **same** id for the rest
- `message_id` — unique per call
- Records are keyed `{transaction_id}::{subscriber_url}` — the same transaction against a different counterparty is a separate record. Business data lives under `MOCK_DATA::{transaction_id}::{subscriber_url}`.

### Step statuses (from the workbench state machine)
`COMPLETE` · `LISTENING` · `RESPONDING` · `WAITING` · `INPUT_REQUIRED`.
Actionable = `{RESPONDING, INPUT_REQUIRED}`; `LISTENING` only arms an expectation.
State is **derived**, never stored as a pointer: replay the recorded exchange list to
compute the current step, exactly as the workbench does. Form step types
(`HTML_FORM`, `DYNAMIC_FORM`) are out of scope for v1 — model them in the flow
schema, reject them at dispatch with a clear error.

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
- **Two error channels.** Model-fixable failure (bad payload, not found, upstream down) ⇒ `{isError:true}` tool result. Client-fixable (auth, unknown method) ⇒ JSON-RPC error. A validation NACK is *always* the tool channel — the model must read it and retry differently.
- **stdout is the protocol.** pino writes to stderr; `no-console` is an error; a test spawns the real stdio entrypoint and fails on one stray byte.
- **`buildMcpServer` stays cheap** — it runs once per HTTP request. Expensive or shared things go in `createContainer` and are closed over.
- **No module-level mutable state.** Our NP has genuinely cross-request state (sessions, transactions, expectations). It lives behind the `CacheStore` port (`src/lib/cache/`), reached through a repository and injected via the container: in-memory by default, swappable for Redis by writing one class. Never a module-scope `Map`.
- **Nothing large reaches the model.** Tool results are context. Fetch big artefacts server-side, cache them, and return a summary plus a handle — `catalog_load_flow_config` is the pattern.
- **Tests never touch the network.** `createHarness` injects a fixture-backed config-service gateway by default; `src/test/ondc-fixtures.ts` holds real captured responses. The one live contract test is opt-in via `RUN_LIVE_TESTS=1`.
- **Set `annotations` honestly** — clients auto-approve on them. `payload_send` is *not* read-only and *not* idempotent.
- Both transports are built from the same factory; anything registered works on stdio and HTTP alike.

`src/modules/example/` is the reference pattern: copy it, do not extend it. Delete it
once `session` and `catalog` are real.

---

## 6. Planned layout

```
src/lib/cache/     CacheStore port + in-memory implementation — all shared state

src/modules/
  catalog/     ✅ config-service client, builds/flows/mock configs, actor annotation
  session/     ✅ sessions, NP identity, role inversion  (later: difficulty, nack_rules)
  flow/        derived state machine, expectations, step contracts
  validate/    L0 · L1 · context · L2 intake
  signing/     ed25519 + blake2b-512, KeyProvider
  transport/   inbound receiver routes + outbound signed sender
  record/      exchanges + business data + transaction history
  report/      compliance report

src/test/
  harness.ts        in-process client ↔ server; injects the fake gateway by default
  fakes.ts          fixture-backed ConfigServiceGateway
  ondc-fixtures.ts  real captured config-service responses
```

Env (extend `src/config/env.ts`, keep the fail-fast-at-boot property). Live today:
`CONFIG_SERVICE_URL`, `CONFIG_SERVICE_TIMEOUT_MS`, `CATALOG_CACHE_TTL_MS`,
`SESSION_TTL_MS`. Arriving with signing: `ONDC_SUBSCRIBER_ID`, `ONDC_UNIQUE_KEY_ID`,
`ONDC_SIGNING_PRIVATE_KEY`, `ONDC_SIGNING_PUBLIC_KEY`, `ONDC_COUNTERPARTY_KEYS`.

---

## 7. Build order

Each phase lands with tests before the next starts.

0. ✅ `catalog` — config-service gateway, `catalog_list_builds` / `catalog_list_flows` / `catalog_describe_flow` / `catalog_load_flow_config`, `ondc://builds`.
1. ✅ `session` — `session_create` / `session_get`, role inversion, `ondc://session/{id}`. *(Still to come: difficulty knobs and `nack_rules`, which need the receiver to be meaningful.)*
2. `validate` — L0 + L1 + context as pure functions; `payload_validate`. Table-driven tests are the priority here; this is the module everything else trusts. Schemas and L1 rules come from the config-service (`/protocol/spec/{domain}/{version}`).
3. `signing` — `header_sign` / `header_verify`, cross-checked against the header-guide vectors.
4. `flow` + `record` — derived state machine, `flow_start` / `flow_next` / `step_requirements` / `payload_template`, exchange store.
5. `transport` — receiver routes, inbound queue, `payload_send`, `inbound_next`.
6. `report` + L2 — `inbound_review`, `report_generate`, `mock_buyer` / `mock_seller` prompts.

**Testing** — service logic: plain unit tests. Tools/resources/prompts: `src/test/harness.ts`
(real client ↔ real server over in-memory transport). HTTP: `app.inject()`. stdio: real subprocess.

```bash
npm run dev        # HTTP on :3000        npm run dev:stdio
npm run inspect    # MCP Inspector        npm test
npm run typecheck && npm run lint && npm test    # before declaring anything done
```

---

## 8. Reference map (read-only siblings)

Never modify anything outside `automation-mcp/`.

| Need | Look at |
| --- | --- |
| Flow engine, statuses, resolver chain, jobs | `../automation-framework/knowledge/protocol-workbench/frames/flow-state-machine.md`, `scripts/flow-execution.md` |
| Which layer catches what, path-dependent enforcement | `frames/validation-layers.md` |
| Signing algorithm, header format, live capture | `frames/signing-security.md` + `../header-guide/` |
| Receiver step order, HTTP status semantics | `scripts/onix-request-lifecycle.md` |
| Session / transaction / message identity, key shapes | `frames/transaction-session.md` |
| Difficulty knobs (all 10, with defaults) | `frames/session-difficulty.md` |
| Generator / validator / requirements contract | `frames/mock-runner-lib.md`, `../automation-mock-runner-lib/src/lib/` |
| Endpoint + state-machine reference for the mock | `../automation-mock-playground-service/docs/decision-flows.md`, its `CLAUDE.md` |
| ACK/NACK body shapes, error payloads | `../automation-mock-playground-service/src/utils/{ackUtils,build-error-payload,create-generic-context}.ts` |
| Symptom → cause → fix patterns | `.../knowledge/protocol-workbench/patterns/` (golden rule `fm-001`: an `on_X` NACK is usually a generation symptom, not a protocol bug) |
| Whole-system orientation | `.../knowledge/protocol-workbench/INDEX.md`, `LOCATOR.md` |

The knowledge book is written to be scanned before it is read: hit `LOCATOR.md` or
`INDEX.md`, narrow to two or three frames, then open only those.
