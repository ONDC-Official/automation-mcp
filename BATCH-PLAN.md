# BATCH-PLAN.md — a concurrent order-journey runner for load testing

> **Status: shipped**, 2026-09-27/28. Every decision below landed as written;
> `src/modules/batch/*.test.ts` (32 tests) covers the module, plus the wiring
> checks in `capabilities.test.ts`. Usage is documented separately in
> `BATCH_RUNNER_GUIDE.md` — this file is the design record, that one is the
> runbook.
>
> ## What shipped beyond the plan
>
> - **A real Node event-loop starvation bug, found and fixed during
>   integration testing, not designed for up front.** The driver's `waitFor`
>   polls `flow.status()` then long-polls `flow.awaitEvent()`. `awaitEvent`
>   answers **immediately**, with `waited: false`, whenever the run's next
>   step is not the participant's to move — e.g. a mock-owned step waiting on
>   the receiver's `setImmediate`-scheduled auto-advance chain. Against the
>   in-memory `CacheStore`, every call in that path resolves through an
>   already-settled promise, so a `waitFor` loop that keeps re-entering
>   `status()`/`awaitEvent()` back to back is a closed chain of microtasks that
>   never yields to the macrotask queue — and `setImmediate` callbacks (exactly
>   where auto-advance lives) only run there. The result was a live deadlock:
>   the listener-role integration test spun ~45,000 iterations in 15 seconds
>   without the auto-advanced `on_search` ever being sent, because the
>   `setImmediate` carrying it never got a turn. Fixed with a short real
>   `setTimeout` delay whenever `awaitEvent` comes back `waited: false`, which
>   forces a macrotask tick. This is not a test-harness artifact — it would
>   reproduce in production against the in-memory store, and is muted but not
>   eliminated against Redis (a real socket round trip yields naturally, but
>   the same call pattern still burns a wasted round trip per iteration
>   without the delay).
> - **`classifyError` did not carry `inputs` through on `timed_out` /
>   `cancelled` / `errored` outcomes**, only on the happy and `blocked` paths.
>   Caught by `batch.service.test.ts` asserting every result's `inputs` field.
>   Fixed by threading `args.inputs` into `classifyError`. This matters
>   operationally: a `timed_out` result is exactly the one you want to
>   reproduce, and without this its GPS/station/quantity inputs were silently
>   dropped.
> - **`MOCK_RUNNER_POOL_SIZE`** landed as a new env var (default 8, was
>   hardcoded to the library default of 2) and is threaded through
>   `MockEngineOptions` → `MockRunner.initSharedRunner`. Called out in the
>   original ask only implicitly ("that much concurrent... without any
>   blocking"); made explicit once the worker pool was identified as the
>   concrete ceiling on throughput.
>
> ## Live two-instance run, 2026-09-28 — a real race found and closed
>
> Ran a genuine two-process smoke test (two `npm run dev` instances, real
> sockets, the live `workbench.ondc.tech` config-service, `ONDC:TRV11`/`2.0.0`/
> `Metro`) — the thing the first pass above left as "not done". It surfaced a
> real bug, not a fixture artifact:
>
> - **Auto-advance chaining raced this driver's own explicit sends for
>   `search2`/`select`.** Both `flow.chain.ts`'s auto-advance and the driver's
>   own `flow.proceed()` call notice a step is ours to send at the same
>   moment — the instant the participant's previous reply lands — and only one
>   can hold the per-transaction dispatch lock (`flow.dispatch.ts`'s `WORKING`
>   marker, keyed on the whole transaction, not the step). The loser backs off
>   cleanly (`already_processing`, a `CHAIN_PAUSED` journal line), so no
>   payload is corrupted — but it opened a spurious `ISSUE_OPEN` feedback
>   incident on **every** race, on every transaction. Confirmed by grepping a
>   live run's logs: zero `already_processing` occurrences after the fix,
>   several per transaction before it.
> - **What looked like a genuine live-config defect turned out to be a
>   symptom of the same race.** The first live run also NACKed `on_select`
>   (`Missing fulfillment_ids for item I1`) and stalled there. Re-run after the
>   fix: the NACK never recurred. The race's loser (auto-advance, sending a
>   step with no inputs supplied) was almost certainly landing a malformed
>   duplicate send moments apart from the driver's own correctly-populated
>   one — this was never a defect in the deployed `2.0.0` Metro build itself.
> - **Fix: `auto_advance: false` on every batch-driven session, and the
>   driver now explicitly drives every one of its own steps**, not just the
>   three that declare inputs. `advanceToDecisionPoint()` (new,
>   `batch.driver.ts`) polls to the next `COMPLETE`/`BLOCKED`/`INPUT_REQUIRED`
>   decision point, driving any plain `READY` step (ours, needing nothing —
>   `init`/`confirm`/`status` on the initiator side, `on_search*`/`on_select`/
>   `on_init`/`on_confirm`/`on_status_complete` on the listener side) through
>   itself along the way, with a bare `flow.proceed({sessionId, transactionId})`.
>   This is a strict improvement independent of the race: the driver is now
>   the *sole* authority over when its own steps go out, on both roles
>   symmetrically, rather than "the initiator explicitly drives three steps
>   and hopes auto-advance carries the rest, the listener drives nothing but
>   the final unsolicited close and hopes auto-advance carries everything
>   before it."
> - **A second, genuine win from the same fix: stalls are now detected in
>   seconds, not at the full timeout.** Before, a silently-stalled auto-advance
>   chain left the driver's `waitFor` watching for `COMPLETE`/`BLOCKED` that
>   would never come, burning the entire `per_transaction_timeout_ms` before
>   reporting a content-free `timed_out`. After the fix, the same run's
>   listener side reported `blocked` in ~6 seconds with the exact cause:
>   `Step "on_init_METRO_200" is not ready: Missing fulfillments in
>   sessionData` — the live, `TO_BE_DEPRECATED` `ONDC:TRV11`/`2.0.0` Metro
>   build's own `on_init` step requires business data (`fulfillments`) that
>   nothing earlier in the sequence populates for it. That is a real gap in
>   that specific (deprecated) build, out of scope for this module to fix —
>   `payload_overrides` exists for exactly this, or a non-deprecated version
>   (`2.0.1`/`2.1.0`) may not have it at all.
> - All 32 `src/modules/batch/*.test.ts` cases, `typecheck` and `lint` stay
>   green after the change — the fixture-based tests exercise the same
>   `auto_advance: false` + explicit-driving path, just against a scripted
>   counterparty instead of a second live instance.
>
> ## Version selection and a placed order, 2026-09-28
>
> `version` now picks the whole order journey (`batch.version-presets.ts`):
> flow id, step ids, and repairs for defects in the published config. With
> `version: "2.0.1"` on the deployed dev-workbench config-service, **10 of 10
> orders ran all 12 steps to `COMPLETE` on both sides** — `confirm` sent,
> `on_confirm` ACKed, order `PAID`, 10 distinct station pairs. What it took:
>
> - **`search2_METRO_201` bug** (`bpp_uri` an array) repaired per version via
>   `payload_overrides` (`OVERRIDES-PLAN.md`); the gate still validates the
>   patched payload.
> - **Stations come from the seller, not this repo's table.** The seller's mock
>   rejects a station outside its route ("Start or End station not found in
>   the route"). Its catalog lists more stations than its `on_search2` routes,
>   so a preset can carry `serviceableStationCodes` (`MOCK_STATION_1`–`22`).
>   The order's GPS is re-centred on the chosen stations when the generated
>   point is nowhere near the network — otherwise "nearest" was the same pair
>   for every order.
> - **`select` input shape differs by version** (`{Item_id, Item_Quantity}` vs
>   `{items:[{id, quantity:{selected:{count}}}]}`) — `selectInputShape`.
> - **`2.0.0` fixed by the same station rule.** Its `on_init` block ("Missing
>   fulfillments") was never a config gap: with an unserviceable station the
>   seller answers `on_search2` with error `91201` and saves no fulfillments.
>   Its route builder needs the pair in *both* of its routes (37 and 9 stops),
>   so only 9 stations are serviceable. 10 of 10 orders now run 13 steps to
>   `COMPLETE`, order `COMPLETED`. Its final unsolicited step sits in the main
>   sequence, already ACKed, so `unsolicitedClose` is not set for it.
> - Timed-out results now carry `session_id`, `transaction_id` and the inputs
>   actually sent.
>
> ## 1000 orders, 2026-09-28
>
> `2.0.1`, `concurrency: 50`: **1000 of 1000 completed on both sides in ~2
> minutes**, 1000 unique transaction ids and GPS pairs, memory under 1 GB.
> Orders per batch and orders in flight are both capped at 1000
> (`MAX_BATCH_ORDERS`). Getting there took three findings:
>
> - **The app-wide rate limit (120/min per IP) throttled the two instances'
>   calls to each other**, which surfaced as `UNPARSEABLE` replies and orders
>   waiting on a callback the receiver had refused. Fix: `RATE_LIMIT_MAX` on
>   both instances.
> - **Config fetches had no single-flight.** N simultaneous sessions on a cold
>   cache each downloaded the same large config from the deployed
>   config-service, and some timed out. `CatalogService` now shares one fetch
>   per key (tested).
> - **`concurrency: 200` is counter-productive**: orders queue behind each
>   other and memory reached 5-6 GB per instance. Use 10-50. The driver's
>   `flow_await` park is also capped at 1.5s so a missed wake-up costs little.
>
> ## One call, and a complete order log, 2026-09-28
>
> `batch_run_start` defaults to `role: "both"`: the buyer instance starts the
> seller instance itself over its MCP endpoint (`batch.peer.ts`, `BATCH_PEER_URL`),
> waits for its first wave to be armed, then drives the buyer side. One
> `batch_id` covers both; status shows the seller under `peer`, cancel stops
> both, and a failed start cancels the seller so it is never left armed. It is
> two processes behind one API on purpose: a single process would share a
> `txn_index` entry per transaction id between the buyer and seller sessions.
> `batch_run_order_log` returns one order's whole journey — every exchange in
> order with direction, timestamp, ACK, events and the final order — read from
> the buyer's own record (the seller's replies are in it as inbound exchanges).
> Verified live: one call, 20 of 20 orders on both sides.
>
> `batch_run_payloads` fetches one action's payload across every order of a
> batch (`actions: ["on_confirm"]` → each order's on_confirm, context and
> message), or every step of every order when `actions` is omitted; `parts`
> narrows to context or message. Paginated over the batch's results. Verified
> live on 10 orders: 10 on_confirms with 10 distinct transaction ids; the
> complete batch is 12 payloads per order.
>
> ## Who the orders are between, and choosing the flow, 2026-09-28
>
> - **`bap_id` / `bap_uri` / `bpp_id` / `bpp_uri` are inputs**, all optional
>   (defaults: this instance's `MOCK_SUBSCRIBER_ID` and advertised URI; the
>   configured seller instance). Setting `bpp_uri` runs the buyer against that
>   seller app: no seller instance is started, and the orders are between this
>   buyer and it. `bap_uri` must end `/{domain}/{version}/buyer` (the path the
>   receiver is mounted on) or the call is refused. Underneath, a per-session
>   `mock_subscriber_id` overrides which id a side presents as its own
>   (`flow.identity.ts#seedIdentity`), and `receiver_public_url` / `subscriber_id`
>   carry the URI and the other side's id.
> - **`flow_id` runs exactly that flow, from its own definition, with no
>   runnable/refused gate.** (Superseded by the next entry — the first version
>   of this added a `deriveFlowShape`/`batch_list_flows` gate that decided
>   ahead of time whether a flow *could* be driven; removed on request in
>   favour of just running whatever `flow_id` names.)
>
> ## Any flow, driven from its own definition — no step-id table, 2026-09-29
>
> Per an explicit follow-up ask ("just input the flow_id and run the flow
> according to that flow id"), the driver no longer needs a step-id table per
> flow at all. `batch.step-inputs.ts` reads a step's own input declaration
> (`schema.properties` / `jsonSchema.properties`, both published shapes) and
> fills it by field name — `city_code` from the order, `start_code`/`end_code`
> from the order (or the seller's catalog once one exists), `Item_id`/`items`
> from the real id read back off the seller, everything else from the
> declaration's own `default`. `batch.driver.ts#runOrder` replaces the old
> step-id-specific `runInitiator`/`runListener` with one generic loop: wait for
> a decision point, and if it is `INPUT_REQUIRED`, build that step's inputs and
> send; an unsolicited step of `extraSequence` is fired automatically once the
> main sequence completes, for whichever side owns it. `batch.version-presets.ts`
> now holds only what genuinely cannot be read off a flow: the default flow id,
> the mock seller's serviceable stations, and config repairs.
>
> **A real bug found by this, live**: a flow whose *first* step is the station
> search has no transaction yet when stations must be chosen, so the seller's
> catalog fallback was skipped entirely and the driver's own placeholder codes
> went out — rejected. Fixed to fall back to the configured serviceable-station
> list whenever there is no catalog to read yet, not only when there is no
> transaction. Regression test: a new station-first fixture flow
> (`batch.test-fixture.ts`) proves the fix without a live call.
>
> **Verified live**: every flow published by TRV11 `2.0.0` and `2.0.1` (45
> flows total), started by `flow_id` alone. ~30 completed correctly, including
> every order-journey shape, the catalog-only search, and every IGM/issue flow
> tried. A handful correctly *block*, naming the step, because they need a
> nested field (a specific fulfillment/item reference) the generic filler
> cannot construct from a flat schema — not a hang, an honest answer. The
> delayed/technical cancellation flows time out, likely needing a triggered or
> manual step this generic loop does not yet fire — not investigated further,
> out of scope for what was asked.
>
> ## `batch_list_orders` — order ids and amounts across a batch, 2026-09-29
>
> The direct answer to "what did this batch place": for a `batch_id`, every
> order's real seller-assigned `order_id`, `order_status`, `payment_status` and
> `amount`/`currency` (the quote total), paginated. Deliberately cheaper than
> `batch_run_order_log` (one order's whole journey) or `batch_run_payloads`
> (every payload of every order): it reads only the last few payloads of each
> order — enough to find the newest one that carries `message.order`
> (`batch.service.ts#latestOrderPayload`, factored out of `orderLog` so both
> use the same rule) — never the full journey or a whole body. An order that
> has not settled to an order yet (still running, or blocked/timed out first)
> reports `message` instead of an id, never a guess. Verified live: 5 real
> orders, 5 distinct order ids, correct amounts (120.00/60.00/180.00 INR,
> matching each order's own generated item quantity).
>
> ## Not done
>
> - `retry_policy` is defined on the schema (`StartBatchRunInput.retry_policy`)
>   but not yet read by `BatchService` — a terminal `timed_out` transaction is
>   not automatically retried. Called out in `BATCH_RUNNER_GUIDE.md`'s scope as
>   a follow-up, not silently missing.
> - Not tried against a non-deprecated TRV11 version (`2.0.1`/`2.1.0`) to
>   confirm a full `search1` → `COMPLETE` run end to end on a build that
>   actually populates `on_init`'s `fulfillments` — the `2.0.0` gap above means
>   this hasn't yet been observed reaching `COMPLETE` against a live
>   counterparty, only against the fixture (which does reach `COMPLETE`, since
>   its own tiny mock config has no such gap).

## Context — the request

> "I wanted to build a robust API from backend, or let's say using MCP, around
> TRV11-2.0.0 metro, to test an order journey. I wanted to make my API
> configurable — if I input suppose 1000 order transactions, my system should
> be that much concurrent, that it can handle all the requests asynchronously
> in the background without any blocking, breaking, timeout. That API should
> be fully configurable, and I can test a complete order journey for TRV11
> from that API till on_status delivered and order state completed."

Plus, mid-planning: every order must be a genuinely unique transaction with
its own nearest/unique GPS, every required input generated dynamically by
default (never one static template reused N times), and a usage `.md` for how
to actually drive it.

`automation-mcp` already existed as a mature MCP server that lets an LLM play
one full ONDC transaction end to end as a mock BAP or BPP
(`session_create`/`flow_start`/`flow_proceed`/`flow_await`, backed by
`@ondc/automation-mock-runner`). What did not exist was a way to fire off many
independent journeys concurrently, in the background, driven by code rather
than by a model deciding each step.

## The hard architectural question, resolved from source before writing code

**1000 concurrent journeys need 1000 sessions *per role* (2000 total), not 2
shared sessions.** Verified directly against source, not inferred:

- `FlowBinding` locks on `(sessionId, flowId)` (`flow.service.ts#runLocks`,
  `flow.load.ts#lockId`) — one session runs one instance of a flow at a time,
  structurally.
- `armExpectation` upserts on `(sessionId, expectedAction)`
  (`record.service.ts`) — reusing a session across concurrent runs clobbers
  earlier arms.
- The expectation-matching ranking ladder (`receiver.attribute.ts`,
  `record.service.ts#rankExpectations`) degrades to FIFO-by-oldest-armed only
  for the **first, not-yet-bound** exchange of each flow; every exchange after
  that resolves deterministically via `txn_index::{transactionId}`. Safe at
  scale, but it means the listener side must **arm before the initiator
  sends** — "arm before send" is a real ordering requirement, not a
  suggestion, and is why `role: "listener"` is documented as the side you
  start first.

Two more load-bearing findings from the same investigation:

- The TRV11 SJT flow's unsolicited close step
  (`unsoliciated_on_status_complete_METRO_200`) is `unsolicited: true` and
  **never** fired by auto-advance chaining (`flow.chain.ts#scheduleChain` only
  continues a flow's main sequence) — it needs one explicit
  `flow_proceed({trigger_extra: ...})` call, which is why the listener role's
  driver loop ends with exactly that.
- The mock-runner's shared worker pool defaulted to `poolSize: 2`
  (`mock-engine.ts` called `MockRunner.initSharedRunner` with no `poolSize`).
  This is the single most concrete throughput ceiling at high concurrency and
  had to be fixed as part of this feature, not left as a footnote.

## The shape

**Two roles, one process each, no new cross-process dependency.** The
original instinct was one instance driving both BAP and BPP sides via a
second `automation-mcp` process as an MCP *client* — rejected because
`automation-mcp` has no MCP client in its production `dependencies` (only in
`devDependencies`, for tests), and adding one for this would widen the
production dependency surface for a single feature. Instead:

- `role: "listener"` — plays the mock BPP. Creates a session per virtual
  transaction, arms the expectation via `flow.start()`, waits for the ordinary
  sequence to reach `COMPLETE`, then fires the unsolicited close explicitly.
- `role: "initiator"` — plays the mock BAP. Sends `search1` with generated
  `city_code`, waits for its turn, conditionally sends `search2`, then reads
  the *real* item id back from the counterparty's response
  (`record.getBusinessData`) before sending `select` — never a hardcoded
  guess. Blocks with `reason: "no_item_id"` rather than fabricating one if the
  read-back comes up empty.

The two roles coordinate purely through real wire traffic between two
`automation-mcp` instances — the same way any two independent network
participants would. There is no shared state between the two processes'
`BatchService` instances at all.

**GPS-driven, unique-per-order input generation**
(`batch.input-generator.ts`). Every virtual transaction gets a random-but-
plausible origin/destination GPS pair within a configurable bounding box,
resolved to the *nearest* station via Haversine distance against a small
curated reference table (`batch.station-reference.ts` — 16 hand-picked
Bangalore-area stations, explicitly documented as not sourced from real
network data). `IssuedPairTracker` re-rolls on a station-pair collision within
one run, falling back to a UUID-suffixed unique key if it exhausts
`MAX_REROLLS`. `Item_id` is deliberately never in this generated set — it is
read back from the counterparty's real response, per the anti-hardcoding
argument above.

**Concurrency: a hand-rolled bounded pool, not a new dependency.**
`BatchService#driveAll` runs `concurrency` workers, each pulling the next
transaction index off a shared counter and driving it in full isolation.
`runOneTransaction` is contractually guaranteed to never throw — every path
ends in a classified terminal result — so no per-worker `.catch` is needed to
protect the pool from one bad transaction. `startRun` returns before any of
this runs: the driving loop is a detached, un-awaited promise chain, the same
"scheduled, never awaited" idiom `flow.chain.ts#scheduleChain` already uses.

**State: `CacheStore` primitives only, never read-modify-write.**
`batch.repository.ts` keys meta (`batch::{id}::meta`), per-status progress
counters (`batch::{id}::progress::{status}`, via `CacheStore#increment`), and
paginated results (`batch::{id}::results`, via `CacheStore#listAppend` /
`#listRange`) — following the same rule the rest of this codebase holds to
(see `CLAUDE.md` §5, "do not add a fourth" read-modify-write site).
`BatchRunState` (`running`/`completed`/`cancelled`) is derived and persisted
in meta; `queued` in `BatchProgress` is computed on read as
`transaction_count - (everything else)` rather than stored, so it can never
drift from the other counters.

## Decisions

| Decision | Choice |
| --- | --- |
| **Counterparty topology** | Two local `automation-mcp` instances (mock BAP ↔ mock BPP), no external network dependency, no cross-process MCP client |
| **Where the module lives** | Inside `automation-mcp` (`src/modules/batch/`), following the existing `tool → service → repository` layering, not a separate service |
| **Uniqueness** | Not just a unique `transaction_id` (the protocol already guarantees that) — distinct GPS-derived input data per order, tracked and re-rolled within a run |
| **`Item_id` sourcing** | Always read back from the counterparty's real response; never templated or guessed. A missing read-back is `blocked`/`no_item_id`, never a fabricated value |
| **Cancellation semantics** | Stops issuing *new* transactions only. In-flight ones finish or hit their own `per_transaction_timeout_ms` naturally — never hard-killed, to avoid an orphaned lock or a duplicate wire call |
| **Results surface** | Always paginated (`since_index`/`limit`, capped at 500) — the full result list is never returned in one `batch_run_status` call, matching this codebase's "nothing large reaches the model" rule |
| **Worker pool sizing** | New `MOCK_RUNNER_POOL_SIZE` env var (default 8), threaded through `MockEngineOptions`; the library's own default of 2 is the concrete ceiling on throughput at scale |

## Files

| File | Change |
| --- | --- |
| `src/modules/batch/batch.schema.ts` | new — zod schemas for every tool input/output, `OrderInputs`, `BatchTransactionResult`, `BatchProgress` |
| `src/modules/batch/batch.station-reference.ts` | new — curated station code + GPS table, `nearestStation()` |
| `src/modules/batch/batch.input-generator.ts` | new — `generateOrderInputs()`, `IssuedPairTracker` |
| `src/modules/batch/batch.repository.ts` | new — `CacheStore` key scheme for meta/progress/results |
| `src/modules/batch/batch.driver.ts` | new — `runOneTransaction()`, the per-virtual-transaction loop for both roles |
| `src/modules/batch/batch.service.ts` | new — `BatchService`: the bounded-concurrency pool, `startRun`/`status`/`cancel` |
| `src/modules/batch/batch.tool.ts` | new — `batch_run_start` / `batch_run_status` / `batch_run_cancel` via `defineTool` |
| `src/modules/batch/batch.test-fixture.ts` | new, test-only — a small genuinely-executable flow shaped like the TRV11 SJT flow's essentials |
| `src/modules/batch/*.test.ts` | new — 32 tests across all of the above |
| `src/config/env.ts` | `MOCK_RUNNER_POOL_SIZE` |
| `src/lib/mock-engine/mock-engine.ts` | thread `poolSize` into `MockRunner.initSharedRunner` |
| `src/container.ts` | construct `BatchRepository`/`BatchService`, wire into `Container.services` |
| `src/config/features.ts` | `"batch"` module, `REQUIRES`, added to the `driver` profile |
| `src/mcp/capabilities.ts` | one line wiring `createBatchTools` |
| `src/mcp/capabilities.test.ts` | updated exact-match tool list |
| `src/test/fakes.ts` | wire the batch fixture flow/config into the fake config-service gateway |
| `BATCH_RUNNER_GUIDE.md` | new — the end-user runbook (two-instance setup, tool reference, walkthrough, troubleshooting) |

## Verification

1. `npm run typecheck && npm run lint && npm test` — clean. Full suite: 1133
   passing; the only failures seen across repeated runs are the pre-existing
   `stdio.test.ts` flakiness under full-suite parallel subprocess contention
   (confirmed via `git stash` comparison to predate this feature, and to pass
   reliably in isolation) — a different unrelated file flakes on each run,
   never the batch module.
2. `batch.driver.test.ts` — both roles, end to end, against a real worker
   execution and real HTTP routes: initiator happy path with real item-id
   read-back, initiator timeout when no response arrives, listener arming +
   watching completion + firing the unsolicited close.
3. `batch.service.test.ts` — immediate return from `startRun`; bounded
   concurrency actually bounds `in_flight`; progress counters and result
   pagination are correct; cancellation stops new work while capping
   in-flight settlement at `concurrency`; unknown-batch-id 404s.
4. `batch.input-generator.test.ts` / `batch.station-reference.test.ts` /
   `batch.repository.test.ts` — generator uniqueness and bounding-box
   behavior, nearest-station resolution, and the `CacheStore` key scheme in
   isolation.
5. Not yet done: a live two-instance run against real ports at N=5→1000, per
   `BATCH_RUNNER_GUIDE.md`'s own walkthrough — flagged above under "Not done".
