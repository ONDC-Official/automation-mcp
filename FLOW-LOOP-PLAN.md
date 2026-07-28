# Flow Loop: make automation-mcp a full mock BAP/BPP that completes transactions

> Status: planned, not yet implemented. Written 2026-07-28. Pick up at Milestone M0.

## Context

`automation-mcp` today can create a session (`session_create`) and browse the catalog (flows, mock configs) — it cannot _run_ anything. This milestone adds the **flow loop**: the MCP acts as the mock counterparty (buyer app when the NP under test is a BPP, seller app when it's a BAP) and drives a beckn transaction end to end — sending mock payloads, receiving the NP's calls on a real HTTP endpoint, validating/saving them, and computing the next step until the flow completes.

It is a **compact** re-implementation of what the workbench spreads across four services (mock-playground + api-service + recorder + ui-backend), with the LLM replacing most machinery:

- **Next-step computation** ported from `automation-mock-playground-service/src/service/flows` (replay-based `FlowMapBuilder` + `getNextActions` + the `pending-step` status truth table). No persistent step pointer — state re-derived from transaction history on every read.
- **Payload generation/validation** via npm `@ondc/automation-mock-runner@^1.3.56`, driven by the ~330KB mock config `catalog_load_flow_config` already caches (`mockcfg::…`; the `getCachedMockConfig`/`mockConfigKey` seam at `catalog.service.ts:206/249` was left for exactly this).
- **Receive + save** emulates the essential recorder/playground semantics (append API/FORM entries to a `{txn}::{sub}` transaction cache, ACK/NACK bodies) as in-process Fastify routes — no gRPC, no queues, no external DB, no Redis (everything behind the existing `CacheStore` port).

### User decisions (fixed)

1. **Signing deferred** — outbound unsigned, inbound Authorization ignored. Seam: `RequestSigner { sign(bodyBytes) }` param on SenderService (ship `NoopSigner`), `verifyAuth(req)` no-op hook on the receiver.
2. **Interaction mode per session**: `llm_auto` (LLM fills all inputs and forms, including fetching/filling counterparty-hosted forms) vs `manual` (LLM asks the human for inputs; forms are hosted as real pages and the human gets a link). Form ownership cuts both ways: mock-owned forms are hosted by us; NP-owned forms are fetched from the URL saved out of the counterparty's payload.
3. **Hybrid autonomy**: per-session `auto_advance` flag — off (default) = LLM drives each step with a bounded blocking await tool; on = receiver chains mock-owned steps server-side, pausing on inputs/forms/errors.
4. **Compact**: no queue/jobs, synchronous pipeline, reuse automation-mcp conventions exactly (`defineTool`, module layout, `capabilities.ts` wiring, container singletons, AppError channels, snake_case described schemas).

### Verified conventions the design relies on

- Playground `TransactionCache.subscriberType` = the **NP-under-test's** type; mock is the opposite. Our session already stores `np.type` + `mock_role`.
- `trigger_extra` only dispatches **mock-owned** extras (`process-flow.ts:148` rejects `step.owner === subscriberType`).
- Flow definition source of truth = **catalog `/ui/flow`** (already cached under `flows::{d}::{v}::{u}`) — it carries `expect`/`manual`/`input`/labels that `configHelper.convertToFlowConfig()` only synthesizes lossily. `flow_start` asserts every sequence key resolves to a mock-config `action_id`.
- Hosted-form URL shape is **baked into config generate-JS** via the runner's `createFormURL` helper: `{mockBaseUrl}/forms/{domain}/{formId}/?transaction_id=…&session_id=…` — our routes must match it.
- `generateContext` falls back to the config's canned `transaction_data` (fixture txn ids, `bap.example.com`) — identity + `transaction_id` **must** be seeded into session data at `flow_start`.

---

## Module / file layout

```
src/lib/
  mock-engine/mock-engine.ts        # MockRunner adapter: shared-runner boot/teardown,
                                    # instance cache, sessionData builder, run wrappers, log capture
  events/transaction-events.ts      # waiter/notify primitive for flow_await (container singleton)

src/modules/flow/
  engine/                           # ported playground mapper — near-verbatim, pure functions
    flow-mapper.ts, flow-map-builder.ts, pending-step.ts, reduce-history.ts,
    resolvers/{resolver-types,sequence-resolver,extras-resolver,missed-resolver}.ts,
    missed-step-factory.ts, sequence-lookup.ts, engine-types.ts, flow-mapper.test.ts
  flow.schema.ts                    # StepOutcome, FlowStatus, snake_case tool IO
  flow.service.ts                   # loop orchestrator: start/status/proceed/await/chainNext
  flow.tool.ts                      # flow_start, flow_get_status, flow_proceed, flow_await
  flow.prompt.ts                    # mock_buyer / mock_seller

src/modules/record/
  record.schema.ts                  # TransactionCache, ApiEntry/FormEntry, PayloadRecord (zod)
  record.repository.ts              # all CacheStore access: txn, MOCK_DATA, FLOW_STATUS, payloads,
                                    # session_txns index, expectations
  record.service.ts                 # appendApiEntry/appendFormEntry (+seq +notify),
                                    # saveBusinessData (getUpdatedData port), summaries
  record.tool.ts / record.resource.ts   # record_get_payload, record_get_data; ondc://txn/…, ondc://payload/…

src/modules/transport/
  sender.service.ts                 # undici POST {subscriber_url}/{action}; ACK/NACK/timeout; signer seam
  receiver.service.ts               # lifecycle (http-mounted vs stdio standalone) + inbound pipeline
                                    # + auto-advance hook
  receiver.routes.ts                # POST /rx/:sessionId/:action, GET /forms/:domain/:formId,
                                    # POST /forms/:domain/:formId/submit
  transport.schema.ts / transport.tool.ts   # receiver_start, receiver_stop

src/modules/forms/
  forms.service.ts                  # host side (ejs-render formHtml, mint submission_id)
                                    # + fill side (fetch/sanitize/parse/submit counterparty forms)
  forms.tool.ts / forms.schema.ts   # form_fetch, form_submit
```

Wiring: one line per module in `src/mcp/capabilities.ts`; services built in `src/container.ts`; receiver routes registered in `src/app.ts` after `healthRoutes` (unauthenticated, like `/health`). Delete `src/modules/example/` (already slated). Every module gets `*.test.ts` beside it.

## MCP tool surface (10 new tools, 2 resources, 2 prompts; existing 6 tools unchanged)

| Tool                 | Purpose                                                                                                | In → Out sketch                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `receiver_start`     | Ensure inbound endpoint live; return callback URLs                                                     | `{session_id?}` → `{running, mode: mounted\|standalone, base_url, callback_url?}`                                                                                         |
| `receiver_stop`      | Stop standalone listener (stdio only; explains itself in http mode)                                    | `{}` → `{stopped}`                                                                                                                                                        |
| `flow_start`         | Create transaction for a flow; arm expectation or (mock-first flows) fire step 1                       | `{session_id, flow_id, transaction_id?, inputs?, auto_advance?}` → `{transaction_id, callback_url, outcome}`                                                              |
| `flow_get_status`    | Derived flow map — the loop's eyes                                                                     | `{session_id, transaction_id}` → `{flow_status, sequence[{key,action,owner,actor,status,payload_ids}], extra_steps, missed_steps, next, reference_data_keys, attention?}` |
| `flow_proceed`       | **Loop driver**: next mock-owned step (requirements → generate → send → record), or named extra        | `{session_id, transaction_id, inputs?, trigger_extra?, dry_run?}` → `StepOutcome`                                                                                         |
| `flow_await`         | Bounded blocking wait for inbound activity                                                             | `{session_id, transaction_id?, after_seq?, timeout_ms?}` → `{timed_out}` \| `{event{seq, kind, action?, payload_id?, validation?, next_hint}}`                            |
| `record_get_payload` | Stored payload by handle, optional JSONPath slice + max_bytes                                          | `{session_id, payload_id, jsonpath?, max_bytes?}` → `{action, direction, timestamp, size_bytes, truncated, payload}`                                                      |
| `record_get_data`    | MOCK_DATA view; large values (resolved form HTML) as handles                                           | `{session_id, transaction_id, keys?}` → `{data, omitted[]}`                                                                                                               |
| `form_fetch`         | Counterparty form: fetch/sanitize/parse fields (llm_auto) or link+instructions (manual)                | `{session_id, transaction_id, step_key}` → fields[] \| `{mode:"manual", form_url}`                                                                                        |
| `form_submit`        | Submit LLM-filled fields (llm_auto) or record human-obtained submission_id (manual); then proceed flow | `{…, fields?\|submission_id}` → `{submission_id, outcome}`                                                                                                                |

`StepOutcome` is a discriminated union: `SENT{action,payload_id,ack}` · `DRAFTED{payload_id}` (dry_run preview seam) · `INPUT_REQUIRED{step_key, inputs schema}` · `FORM_PENDING{step_key, role: fill|host, form_url}` · `WAITING{expected_action}` · `COMPLETE` · `BLOCKED{reason, details}`.

`flow_proceed` deliberately merges CLAUDE.md's planned `step_requirements`/`payload_template`/`payload_send` — the runner does generation; the model's job is inputs + judgement. Mock-hosted forms need no submit tool (counterparty hits the hosted route; LLM observes via `flow_await` `FORM_SUBMITTED`).

**Resources**: `ondc://txn/{sessionId}/{transactionId}` (slim record), `ondc://payload/{payloadId}` (full body). **Prompts**: `mock_buyer`/`mock_seller` — loop discipline (receiver_start → session_create → flow_start → alternate flow_await/flow_proceed → forms), mode- and autonomy-aware.

## Service designs

### FlowEngine (port, `src/modules/flow/engine/`)

Copy the eight mapper files near-verbatim (keeps diffability with upstream). Only changes: types merged into `engine-types.ts` + adapter `toEngineFlow(upstreamFlow)` (defaults `unsolicited=false`, `pair ?? null`; missing `owner` falls back to mock-config step owner by key, else `flow_start` errors loudly); drop winston; keep `HTML_FORM_MULTI` rejection; port tiny `getReferenceData` from `utils/flow-utils.ts`. Port the playground's 1528-line `flow-mapper.test.ts` to vitest — free regression suite. Statuses stay exactly the truth table: `LISTENING` (NP owns) / `RESPONDING` (mock owns) / `INPUT-REQUIRED` / `WAITING-SUBMISSION` (mock hosts form) / `WAITING` / `COMPLETE`.

### RecordService (+repository)

Key shapes preserved verbatim in `CacheStore` (workbench prefixes kept literally):

| Key                                                                     | Value                                                        | TTL  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ | ---- |
| `{txn}::{np.subscriber_url}`                                            | `TransactionCache` (playground schema + `seq` per entry)     | 48h  |
| `MOCK_DATA::{txn}::{sub}`                                               | business data                                                | 48h  |
| `FLOW_STATUS_{txn}::{sub}`, `EXTRA_FLOW_STATUS_{txn}::{sub}::{stepKey}` | `{status}`                                                   | 5h   |
| `payload::{payloadId}`                                                  | `{direction, action, message_id, timestamp, body, ack_body}` | 48h  |
| `session_txns::{sessionId}`                                             | txn index for the session                                    | 48h  |
| `expect::{sessionId}`                                                   | `{flow_id, transaction_id, expected_action, expire_at}`      | 5min |

apiList entries stay **slim** (`{entryType, action, payloadId, messageId, response: ackBody, timestamp, seq}`); full bodies live out-of-line under `payload::{id}` — caps apiList growth, mirrors how the playground offloads bodies. `saveBusinessData` ports `getUpdatedData` (`workbench-cache.ts:132-168`) exactly: auto-inject `latestMessage_id/bapUri/bppUri/bppId/bapId` JSONPaths, `APPEND#` concat, `EVAL#` via `MockRunner.runGetSave`, per-key error tolerance.

### MockEngine (`src/lib/mock-engine/`)

- Boot: `MockRunner.initSharedRunner({allowedFetchBaseUrls: env})` once in container; **terminate in `dispose()`** (worker threads otherwise block stdio shutdown). Runner Logger level ERROR.
- Instance cache: container `Map<mockConfigKey, {runner, lastUsed}>` (runner instances hold worker handles — the one legitimately non-`CacheStore` state), 5-min idle sweep.
- `getRunner(build, flowId)`: `catalog.getCachedMockConfig(key)`; on 15-min TTL miss transparently re-fetch via `catalog.loadMockConfig`. `new MockRunner(config)` strict; on ConfigurationError retry `skipValidation: true` + warn.
- `buildSessionData(session, txn)`: MOCK_DATA ∪ identity — NP side from session (`np.subscriber_url/subscriber_id`), mock side from env (`{RECEIVER_PUBLIC_URL}/rx/{sessionId}` as our uri, `MOCK_SUBSCRIBER_ID` as our id), mapped to bap/bpp by `mock_role`; plus `mockBaseUrl`, `user_inputs`, `sessionId`, seeded `transaction_id`.
- Wrappers normalize `ExecutionResult` → `{ok, result?, error?, logs}`; logs → pino debug.

### SenderService

`send(subscriberUrl, action, payload)` → undici POST `{url-no-trailing-slash}/{action}`, body serialized once (future signer signs those exact bytes), shared Agent, `SEND_TIMEOUT_MS`. Returns `{http_status, ack: ACK|NACK|UNPARSEABLE, body}`. Network failure → `UpstreamError`; NACK is data, not an exception.

### FlowService — the loop (dispatch semantics from `process-flow.ts`, synchronous)

1. Flow status (SUSPENDED → BLOCKED), MOCK_DATA, extra statuses → `getNextActions`.
2. Target selection: RESPONDING → dispatch; INPUT-REQUIRED → dispatch iff inputs supplied (manual-gated steps: tool call is the trigger, inputs not fed to runner), else return `INPUT_REQUIRED` with input contract; form steps → `FORM_PENDING{role: host|fill}`; LISTENING+expect → arm `expect::{sessionId}`, return `WAITING`; extras RESPONDING auto-dispatch; `trigger_extra` only mock-owned AVAILABLE extras.
3. Dispatch: WORKING → `runRequirements` (fail → AVAILABLE + `BLOCKED{requirements}` — surfaced to LLM instead of the playground's error-payload send) → `runGenerate` → dry_run? store+`DRAFTED` : `sender.send` → `appendApiEntry` (timestamp = payload `context.timestamp`) → `saveBusinessData` → AVAILABLE → `SENT`.
4. `chainNext` (auto_advance): loop `proceed` while `SENT`; on anything else persist `attention` on txn record + emit `CHAIN_PAUSED`/`CHAIN_SENT`.

### ReceiverService + routes

**`POST /rx/:sessionId/:action`** — beckn callbacks are `{callback_uri}/{action}`, so advertising `{RECEIVER_PUBLIC_URL}/rx/{sessionId}` as our bap/bpp_uri gets the action as a path param free; sessionId in path resolves config without txn lookup and covers unsolicited-first-inbound (mock-BPP receiving `search`). Form routes match the config-baked shape: `GET /forms/:domain/:formId` + `POST /forms/:domain/:formId/submit` (+`transaction_id`/`session_id` query).

Inbound pipeline: (1) parse; missing context ids → **400**. (2) resolve session → else 400; `verifyAuth` no-op. (3) resolve txn; absent → create from `expect::{sessionId}`, no expectation → **412** "No active expectation found". (4) build flow map; match sequenceNext LISTENING by action (+`message_id` echo when it's the `pair` response), else NP-owned extras by type; no match → append anyway (missedResolver classifies next read), NACK 200. (5) `runValidate`: crash → NACK `VALIDATION_FUNCTION_ERROR`; invalid → NACK with step's code (200, `{message:{ack:{status:"NACK"}}, error:{…}}`). (6) append slim entry + out-of-line payload, update latestAction/messageIds/seq. (7) valid → `saveBusinessData` → **HTML_FORM lookahead** (port `processHtmlFormStep`: fetch URL from MOCK_DATA, `validateFormHtml` security scan, `resolveFormActions`, store resolved HTML back — powers both modes). (8) reply ACK **first**, then `events.notify` and, if auto_advance, `setImmediate(chainNext)` — never chain inside the NP's ACK window.

Lifecycle: one fastify plugin. HTTP entrypoint: mounted at boot (`receiver_start` reports URLs). stdio: `receiver_start` builds a standalone Fastify on `RECEIVER_PORT`; `receiver_stop`/`dispose()` close it. Server handle lives in `ReceiverService` in the container.

### FormService

- **Host side** (mock owns form): decode `formHtml`, `ejs.render` with `actionUrl` + `submissionData` (configs are authored against ejs — playground `form-handlers.ts:52`). On submit: mint UUID `submission_id`, `addFormData` into MOCK_DATA, append FORM entry, then `flowService.proceed({submission_id})`, answer success page/JSON.
- **Fill side** (NP hosts): `form_fetch` uses receiver-resolved HTML or fetches+sanitizes on demand; parse `input/select/textarea` with a small regex parser (no DOM dep). `form_submit` posts urlencoded to the resolved action URL, extracts `submission_id` from `{success, submission_id}` (unknown shapes returned raw for the model), then proceeds the flow. Manual mode: `form_fetch` returns link + instructions; `form_submit` accepts a human-supplied `submission_id`.

## `session_create` extension (backward compatible)

Optional inputs: `interaction_mode` enum default `llm_auto`, `auto_advance` boolean default `false`, `receiver_public_url` (per-session tunnel override). Session output gains `interaction_mode`, `auto_advance`, `callback_url`. `flow_start` may override `auto_advance` per transaction. Existing callers/tests unaffected.

## Await mechanism

`TransactionEvents` container singleton: `Map<txnKey, Set<Waiter>>`, `notify()`, `waitFor({afterSeq, timeoutMs})`. Race-proof: `flow_await` first reads the txn record — any `seq > after_seq` returns immediately from the store; only then registers a waiter. `timeout_ms` capped at `AWAIT_MAX_WAIT_MS` (25s < `REQUEST_TIMEOUT_MS` 30s); timeout → `{timed_out:true}`, model re-calls (long-poll loop). Events also persisted as txn `attention`/seq so nothing is lost between calls. Multi-replica caveat documented (same constraint the in-memory CacheStore already imposes; Redis swap adds pub/sub behind the same interface).

## Env additions (all defaulted, zod in `env.ts`)

`RECEIVER_PORT=3001` · `RECEIVER_PUBLIC_URL` (default derived from PORT/RECEIVER_PORT) · `MOCK_SUBSCRIBER_ID=mock.ondc-mcp.local` · `SEND_TIMEOUT_MS=15000` · `AWAIT_MAX_WAIT_MS=25000` · `FLOW_STATUS_TTL_MS=18000000` · `RUNNER_CACHE_TTL_MS=300000` · `RUNNER_FETCH_ALLOWLIST=` (empty = sandbox fetch blocked) · `FORM_FETCH_TIMEOUT_MS=10000`.

## New dependencies

- `@ondc/automation-mock-runner@^1.3.56` — generation/validation/requirements, `runGetSave`, context. CJS dist; ships `public/node-worker.js` resolved via `__dirname` (safe under npm+tsc/tsx, no bundler; M0 spike verifies).
- `jsonpath@^1.1.1` (+types) — our `saveBusinessData` port (declared directly, not via transitive).
- `ejs@^3` (+types) — hosted-form rendering (what configs were authored against).
  Not added: axios, amqplib, redis, express, winston.

## Testing strategy

- `engine/`: ported playground `flow-mapper.test.ts` + table-driven `pending-step` truth-table tests.
- `record/`: unit tests on `InMemoryCacheStore` — append/dedupe/seq, `APPEND#`/`EVAL#`/auto-context merge.
- `mock-engine/`: fixture `MOCK_CONFIG_RESPONSE` has truncated base64 (can't execute) — build a tiny runnable config at test time with `MockRunner.encodeBase64` (real worker round trip); test cache eviction + re-fetch.
- Tools: `createHarness()` + fake gateway. Simulated NP: outbound via undici `MockAgent` injected into SenderService; inbound via `app.inject()` on the receiver routes. End-to-end loop test scripts the NP: `flow_start` (mock BAP) → assert search POSTed → inject `on_search` → `flow_await` → `flow_proceed` → … through a form step.
- stdio purity: extend `stdio.test.ts` with a mock-engine-touching scenario (runner console must never hit stdout).
- 70% coverage thresholds unchanged; live NP test opt-in `RUN_LIVE_TESTS=1`.

## Implementation order (each milestone green before the next)

| #   | Lands                                                                                                                                     | Checkpoint                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| M0  | Deps + env + container seams (`TransactionEvents`, mock-engine boot/teardown spike: CJS interop, worker path, stdout) + delete `example/` | Boots both transports; runner executes hello-world generate in a test |
| M1  | `flow/engine/` port + ported tests                                                                                                        | Mapper verified against playground behavior                           |
| M2  | `record` module + tools + resources                                                                                                       | Txn records readable from seeded fixtures                             |
| M3  | mock-engine adapter + sender +`flow_start`/`flow_get_status`/`flow_proceed` (outbound)                                                    | Mock-BAP sends generated`search` to stubbed NP; recorded + fetchable  |
| M4  | receiver (both entrypoints, pipeline, ACK/NACK, expectations, 400/412) +`flow_await` + `receiver_start/stop`                              | Full request/callback pair completes vs scripted NP via loop tools    |
| M5  | `auto_advance` chaining + `session_create` extension                                                                                      | Flow completes hands-off up to first INPUT-REQUIRED                   |
| M6  | `forms` both directions + receiver HTML_FORM lookahead                                                                                    | FIS12 Personal-Loan flow end-to-end incl. forms, both modes           |
| M7  | prompts, render polish, CLAUDE.md update, coverage/lint sweep                                                                             | typecheck + lint + test green                                         |

## Risks & gotchas (mitigations planned)

1. **stdio purity vs runner logging** — runner Logger writes `console.log` when `NODE_ENV=development`/`DEBUG` (verified `logger.ts:63-68`); stdio entrypoint rebinds console to pino(stderr) before mock-engine loads; runner level ERROR; stray-byte test extended.
2. **Worker pool lifecycle** — terminate shared runner in `dispose()` or stdio process hangs on shutdown.
3. **Canned identity leakage** — seed identity + `transaction_id` into session data at `flow_start` or `generateContext` emits fixture ids/`bap.example.com`.
4. **330KB configs / large payloads never reach the model** — summaries + handles everywhere; `max_bytes` + jsonpath slicing on `record_get_payload`.
5. **TTL misalignment** — flow-status expiry reads as AVAILABLE (playground's own safe fallback); mockcfg 15m < flow life → transparent re-fetch; runner instances rebuilt from config.
6. **Timestamp ordering / clock skew** — sort by `(context.timestamp, seq)` with seq tiebreak; inbound matching by action+placeholder(+message_id echo), not the fragile playground triplet.
7. **Unsigned outbound** — real NPs with header validation will 401; milestone targets NPs with validation off; `RequestSigner` seam ready.
8. **Concurrency** — WORKING guards double dispatch (`BLOCKED("already processing")`); auto-advance chain via `setImmediate` post-ACK.
9. **Engine schema strictness** — `toEngineFlow` adapter + `flow_start` key↔config assertion fail loudly at start, not mid-loop. `PLAYGROUND-FLOW` special case ignored (unreachable via catalog). Missing mock config (404) → `flow_start` NotFoundError telling the model to pick a flow that has one.

## Verification (end-to-end)

1. `npm run typecheck && npm run lint && npm test` in `automation-mcp` (coverage thresholds hold).
2. Harness end-to-end test (M4/M6 checkpoints): scripted-NP transaction completes — including a form step in both `llm_auto` and `manual` modes — asserting apiList sequence, ACK/NACK bodies, MOCK_DATA contents.
3. Manual smoke via MCP Inspector (`npm run inspect`): `receiver_start` → `session_create` (FIS12 2.0.3 PERSONAL LOAN) → `flow_start` → drive the loop with `flow_await`/`flow_proceed` against a second local instance acting as the NP (or curl-scripted callbacks), confirm `flow_get_status` shows COMPLETE.
4. stdio purity: `npm test -- stdio` — no stray stdout bytes with the runner active.

### Critical files

- `automation-mcp/src/container.ts`, `src/mcp/capabilities.ts`, `src/config/env.ts`, `src/app.ts` — wiring
- `automation-mcp/src/modules/catalog/catalog.service.ts` (`mockConfigKey`/`getCachedMockConfig`/`loadMockConfig` seam)
- Ported from: `automation-mock-playground-service/src/service/flows/**` (mapper), `process-flow.ts` (dispatch), `src/service/cache/workbench-cache.ts` (`getUpdatedData` merge), `src/controllers/incoming-request-controller.ts` (`processHtmlFormStep`), `src/utils/{flow-utils,form-utils}.ts`
- Reference: `automation-mock-runner-lib/src/lib/MockRunner.ts`, `default-helpers-source.ts` (`createFormURL`), `configHelper.ts`
