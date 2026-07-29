# Session events & auto-send: close the loop between the wire and the model

> Status: **implemented**, 2026-07-29, except M7 (dropped — see below).
> Companion to `FLOW-LOOP-PLAN.md`; reading that first explains every primitive
> this plan builds on. `CLAUDE.md` describes the code as it stands today.
>
> ## What shipped, and where it diverged
>
> M0–M6 landed as designed. Four decisions were made at implementation time
> that the plan did not anticipate; each is documented in the code as well.
>
> 1. **`POSSIBLY_RELATED`'s audience is every live session on the endpoint, not
>    every session with an armed expectation.** The plan's rule turns out to be
>    empty in the common case: a run that has *sent* its request and is waiting
>    for the callback arms nothing at all — the receiver files that callback by
>    `transaction_id` — so the sessions most likely to own a stray call were
>    exactly the ones the rule excluded. Sessions are now indexed by endpoint at
>    `session_create` (`endpoint_sessions::…`, an atomic `listAppend`), and the
>    fan-out is capped because this path is reachable unauthenticated.
>    `WRONG_ENDPOINT` is the exception: there the `txn_index` names the owning
>    session, so it is told alone rather than broadcast.
> 2. **A chain pause journals one line, not two.** The kind table lists both
>    `CHAIN_PAUSED` and `ATTENTION` for `#pauseChain`. `CHAIN_PAUSED` is strictly
>    the more informative of the pair for the same event, so the receiver's two
>    refusal sites own `ATTENTION` and the chain owns `CHAIN_PAUSED`. The split
>    now means something: `INBOUND_NACK` is "refused, flow unaffected";
>    `ATTENTION` is "refused, and there is a body here for you".
> 3. **`FLOW_COMPLETE` dedupes on an atomic counter, not a flag on the record**
>    (open question 1 defaulted to the flag). The transaction record is
>    read-modify-written by every `appendApiEntry`, so a flag on it would be
>    clobbered by an append already in flight. `claimFirst` is one `increment`
>    and cannot lose that race.
> 4. **The two new auto-send trigger sites collapsed into one.** `proceed`
>    answers `SENT` for a completed form step as well as for a dispatched
>    payload, so `FlowService#scheduleChain` covers the hosted-form submission
>    and the model-initiated send with a single mechanism, and `forms.service.ts`
>    needs no chaining hook of its own.
>
> ## M7 was dropped, on the plan's own terms
>
> The plan gated it on the SDK wiring being cheap. It is not. `serveStdio`
> accepts no `ServerEventBus` and returns no notifier, and `Server#sendResourceUpdated`
> needs the pinned server instance — which the stateless HTTP factory
> deliberately does not keep, and which the container would have to acquire
> through a back-reference that makes `buildMcpServer` stateful. The result
> would work over HTTP and silently not over stdio, breaking the standing rule
> that both transports get identical capabilities from one factory. Since the
> feature was explicitly non-load-bearing, not building it is the cheaper
> correct answer.
>
> ## Open questions, as settled
>
> 1. `FLOW_COMPLETE` dedupe — atomic claim, per (3) above.
> 2. Piggyback on record/read tools — kept. Result bloat has not been a problem;
>    the delta is capped at ten one-line summaries and omitted entirely when empty.
> 3. `SESSION_EXPIRING` — skipped in v1, as the default said.
> 4. Cursor at-most-once — no redelivery. `record_get_events` is cursor-neutral
>    and recovers a lost delta, which is why it must never consume.
> 5. `session_state` — **still worth building, but smaller than planned.** The
>    session-scope `runs` summary covers "where is every flow", so what is left
>    for `session_state` is the accumulated business data across transactions.

## Context — the gap

The flow loop works, but the model only learns what happened on the wire when it
is **parked in `flow_await` on the right run at the right moment**. Everything
else is recorded durably and surfaced to nobody:

- A callback lands while the model is mid-thought, filling a form, or driving a
  _different_ flow in the same session → ACKed and recorded, silently.
- Auto-advance (`FlowService#chainNext`) sends three payloads and pauses on
  `INPUT_REQUIRED` → the pause is persisted as `attention`, but only a
  `flow_get_status` the model has no reason to make would show it.
- We NACK an inbound call (`OUT_OF_SEQUENCE`, `TRANSACTION_MISMATCH`,
  `TRANSACTION_ABANDONED`) → stored as evidence, silently.
- The participant submits a form **we** host → a `FORM_SUBMITTED` event fires,
  visible only to a coincidentally-parked waiter.
- An expectation lapses and is re-armed, a run binds its transaction id, a call
  arrives that is refused but _might_ belong to this session → nowhere at all.

The model's only remedy today is polling `flow_get_status` / `session_get`,
which burns context and still misses session-level events. This plan gives the
server a **durable, session-scoped event journal** and three delivery paths, and
then — because the model can finally _see_ automated activity — flips
**auto-advance on by default**, so any mock-owned step that needs no input sends
itself and the model's job collapses to inputs, forms, and judgement.

## The constraint that shapes everything

**The only channel guaranteed to reach the model's context is a tool result.**
MCP server→client notifications (`notifications/resources/updated`, logging)
terminate at the client, and most hosts — Claude Code included — do not inject
them into model context. MCP sampling would be true push but is rarely supported
and inverts the architecture. So "push" is simulated with two pull-shaped
mechanisms the model cannot avoid, plus one real-push enhancement that must
never be load-bearing:

1. **Piggyback** — every session-scoped tool result carries the events that
   happened since the model's last call.
2. **Session-scope long-poll** — one blocking call that wakes on _anything_ in
   the session, not just one run's next step.
3. _(Optional)_ MCP `resources/updated` notifications for clients that surface
   them.

## Decisions (fixed — do not relitigate silently)

| Decision | Choice |
| --- | --- |
| **Journal is store, not hint** | The existing `TransactionEvents` stays exactly what it is — an in-process wake-up hint whose truth lives in the record. The journal is a **durable** append-only log in `stateStore` (survives restarts when Redis is configured), with its own session-wide monotonic seq. The two compose: every journal append also notifies waiters. |
| **Seq spaces stay separate** | Transaction-entry `seq` (per-transaction, drives replay and `flow_await`'s `after_seq`) and journal `seq` (per-session) are different counters. Session-scope await deliberately avoids exposing a second seq to the model by using the server-tracked delivery cursor instead. |
| **Server-tracked delivery cursor** | The server remembers `last_delivered_seq` per session. The model does no bookkeeping; piggyback drains advance the cursor, explicit reads (`record_get_events`) never do. |
| **No fourth RMW race** | `CLAUDE.md` forbids adding a fourth read-modify-write site. The journal therefore starts by widening the `CacheStore` port with atomic `increment` / `listAppend` / `listRange` primitives — which is also the documented fix for the three existing races (migrating those is a follow-up, not this plan). |
| **Journal writes never fail the hot path** | Same discipline as `TransactionEvents.notify`: a journal append from the receiver runs after the ACK is written and a failure to journal must not become a failure to respond. Log and continue. |
| **Nothing large reaches the model** | Journal entries are one-line summaries plus handles (`payload_id`), hard-capped in count per tool result. Bodies stay behind `record_get_payload`. |
| **Auto-send default follows interaction mode** | `auto_advance` defaults to **true** for `llm_auto` sessions, **false** for `manual`. Explicit values (session or per-`flow_start`) always win. This lands _after_ piggyback delivery — silent automation is the thing this plan exists to eliminate. |
| **`flow_start` still sends nothing** | The first send remains an explicit act (the model's `flow_proceed`, or the participant's call). Auto-sending from `flow_start` would race the model's first proceed and complicate the identity model for nothing. |

## What we are explicitly NOT building

- Any out-of-band channel (SSE endpoint, webhook "to the LLM") — no client
  feeds it into model context.
- Sampling-driven interruption of the model.
- Deriving the journal from transaction records at read time — it cannot
  represent session-level events (lapsed expectations, unattributable
  refusals), and replaying every transaction per read is the polling cost this
  plan removes.
- Distributed locking / cross-replica waiter sharing — same scope rules as
  `TransactionEvents` today; Redis pub/sub behind the same interfaces is the
  future seam, not this milestone.

---

## Architecture

### The journal

One append-only log per session in `stateStore`:

- `journal::{sessionId}` — the entries (list, capped ~500 via trim-on-append)
- `journal_seq::{sessionId}` — atomic counter; an entry's seq is assigned by
  `increment` _before_ append, so readers sort by seq and tolerate interleaved
  appends
- `journal_cursor::{sessionId}` — `last_delivered_seq` for piggyback drains

All three carry the session TTL. Entry shape (zod, snake_case like every tool
schema):

```
SessionEvent {
  seq: number            // session-wide, monotonic
  at: string             // ISO 8601
  kind: SessionEventKind
  flow_id?: string
  transaction_id?: string
  action?: string        // protocol action or form step key
  ack?: "ACK" | "NACK"
  nack_code?: string     // OUT_OF_SEQUENCE, TRANSACTION_MISMATCH, …
  payload_id?: string    // handle — body via record_get_payload
  summary: string        // one human sentence, ≤ 200 chars
}
```

`SessionEventKind`:

| Kind | Written from |
| --- | --- |
| `INBOUND_ACK` | receiver, after an accepted call is recorded |
| `INBOUND_NACK` | receiver, every NACK path — carries `nack_code` |
| `OUTBOUND_SENT` | `flow_proceed` dispatch — carries the participant's sync `ack` |
| `CHAIN_SENT` | `chainNext`, per auto-sent step |
| `CHAIN_PAUSED` | `#pauseChain` — summary says why (inputs needed, form, blocked) |
| `FORM_SUBMITTED` | forms, both directions (we submitted theirs / they submitted ours) |
| `TRANSACTION_BOUND` | `#bindOutbound` / `adoptTransaction` — the run got its id |
| `FLOW_COMPLETE` | wherever the mapper first reports COMPLETE after an append |
| `FLOW_RESTARTED` | `flow_restart` — old attempt sealed, run unbound |
| `EXPECTATION_REARMED` | `#rearmIfLapsed` |
| `ATTENTION` | every `setAttention` site (mismatch/abandoned bodies, chain pauses) |
| `POSSIBLY_RELATED` | receiver refusal paths that cannot name a session (M4) |

### Delivery path A — piggyback (the seamless part)

Every session-scoped tool result gains an optional `events` block:

```
EventsDelta {
  events: SessionEvent[]   // ≤ 10, oldest first
  more: number             // undrained count beyond the cap
  cursor: number           // journal seq of the last entry included
}
```

`RecordService#drainEvents(sessionId)` reads the cursor, fetches newer entries,
advances the cursor past what it returns. Tools call it after their real work
and splice the delta in; an empty drain adds nothing to the result. Wired into:
`flow_start`, `flow_proceed`, `flow_await`, `flow_get_status`, `flow_restart`,
`form_fetch`, `form_submit`, `record_get_payload`, `record_get_data`,
`session_get`. The model literally cannot act without learning what changed.

Escape hatch: a new read-only tool `record_get_events` (`session_id`,
`since_seq?`, `limit?`) that reads the journal **without** touching the cursor —
for re-reading, and for recovering if a drained delta was lost to a client
error.

### Delivery path B — session-scope await

`flow_await` is widened: `flow_id` / `transaction_id` become optional.

- **Both absent ⇒ session scope.** Semantics: _blocking drain_. If undelivered
  journal entries exist, return them immediately (as the piggyback delta);
  otherwise park on a new `session::{sessionId}` waiter key — which every
  journal append notifies — and drain on wake. Read-then-park order preserved;
  the delivery cursor doubles as the "anything new?" test, so no second seq
  space is ever exposed. Optional filters: `kinds`, `flow_ids` (filtering
  happens on wake; non-matching events are still delivered in the delta, they
  just don't end the wait — dropping them would lose them).
- **Run-scoped calls behave exactly as today**, plus the piggybacked delta.

Session scope returns no single `next` (`StepOutcome` names one run); instead it
returns the delta plus a `runs` summary line per active flow (id, outcome tag,
one sentence) so the model knows where to go next.

Re-arm on long park: before a session-scope park, re-arm lapsed expectations
for every active binding whose next target is `listen` (bounded to the
session's bindings; reuses `#rearmIfLapsed` per run).

### Delivery path C (optional) — real MCP notifications

Declare the `resources.subscribe` capability; on every journal append emit
`notifications/resources/updated` for `ondc://session/{sessionId}`. Helps
clients that surface it, harms nothing, **never load-bearing**. Last milestone,
droppable.

### Auto-send by default

`chainNext` already implements the semantics ("keep sending mock-owned steps,
pause on inputs/forms/their-turn/errors"; `inputGate` already auto-fires steps
with an empty declared input list and never auto-fires `manual: true` steps).
Three changes make it the default experience:

1. **Default flip.** `session_create` resolves an unspecified `auto_advance` to
   `interaction_mode === "llm_auto"`. Explicit values win, per-`flow_start`
   override unchanged. The stored-binding schema default stays `false` for
   back-compat with persisted bindings; the service always passes an explicit
   value.
2. **New trigger sites** (today only receiver.routes.ts fires it, post-ACK):
   - **Hosted form submission** — after the participant submits a form we host
     and the reply is sent, `setImmediate(chainNext)` when the binding has
     auto-advance. Same ACK-window discipline as the receiver.
   - **After a model-initiated `SENT`** — when `flow_proceed` dispatches and the
     run has auto-advance, schedule `chainNext` after returning the outcome, so
     consecutive mock-owned input-free steps (confirm → status → …) flow
     without further calls. Safe against the run locks: the proceed lock is
     released before the scheduled chain runs, and `chainNext` re-enters
     `proceed` which takes them normally.
3. **Visibility** — `CHAIN_SENT` / `CHAIN_PAUSED` journal entries (M1) arrive on
   the model's next tool call, any tool call. This is the dependency that
   makes the default flip safe; it is why M5 follows M2.

Existing guards carry over untouched: the 20-step runaway cap, the `WORKING`
marker, run locks, abandoned-attempt refusals, `#pauseChain` attention.

**Resulting steady-state loop** for a no-input flow: `flow_start` → at most one
`flow_proceed` → session-scope `flow_await` until `FLOW_COMPLETE`, reading
events as they stream back. That is the end-to-end autonomy target.

---

## Module / file layout (new and touched)

```
src/lib/cache/
  cache-store.ts               # + increment(key, ttlMs?), listAppend(key, value, {ttlMs, maxLength}),
                               #   listRange(key, start?, end?)  — atomic per implementation
  memory-cache-store.ts        # arrays + counters; trivially atomic in-process
  redis-cache-store.ts         # INCR / RPUSH+LTRIM+PEXPIRE (MULTI) / LRANGE; UpstreamError discipline

src/lib/events/
  transaction-events.ts        # unchanged; gains nothing — sessionKey is just a new key string

src/modules/record/
  record.schema.ts             # + SessionEvent, SessionEventKind, EventsDelta
  record.repository.ts         # + appendJournal, journalSince, getEventCursor, setEventCursor,
                               #   journalKey/journalSeqKey/journalCursorKey helpers
  record.service.ts            # + journal(sessionId, entry) — seq via increment, append, notify
                               #   session::{id} + existing keys; never throws
                               # + drainEvents(sessionId) — cursor-advancing delta
  record.tool.ts               # + record_get_events (read-only, cursor-neutral)

src/modules/flow/
  flow.schema.ts               # + events? on Start/Proceed/Status/Await/Restart outputs;
                               #   AwaitInput: flow_id/transaction_id now optional, + kinds?/flow_ids?;
                               #   AwaitOutput: + runs? summary for session scope
  flow.service.ts              # journal hooks in #dispatch/chainNext/#pauseChain/#bindOutbound/
                               #   adoptTransaction/restart/#rearmIfLapsed;
                               #   awaitEvent: session scope branch (blocking drain);
                               #   proceed: post-SENT chain scheduling
  flow.tool.ts                 # splice drainEvents into every result
  flow.prompt.ts               # new loop discipline (M6)

src/modules/transport/
  receiver.service.ts          # journal INBOUND_ACK / INBOUND_NACK / ATTENTION / POSSIBLY_RELATED
  receiver.routes.ts           # unchanged trigger, now also fires for form submissions (via forms)

src/modules/forms/
  forms.service.ts             # journal FORM_SUBMITTED both directions; chainNext after hosted submit

src/modules/session/
  session.schema.ts / .service.ts  # auto_advance default resolution; session_get piggyback
```

No new env vars required; journal cap (500) and piggyback cap (10) are named
constants beside the code they govern.

---

## Milestones

Each lands with tests green (`npm run typecheck && npm run lint && npm test`)
before the next starts.

### M0 — `CacheStore` atomic primitives

`increment`, `listAppend` (with max-length trim + TTL), `listRange` on the port
and both implementations. Redis paths use MULTI so trim and expiry ride the
append. `RedisCacheStore` keeps the `UpstreamError`-not-`undefined` rule.
Tests: unit for memory; `RUN_REDIS_TESTS=1` suite extension for Redis,
including trim behaviour and TTL refresh. _Follow-up noted, not done here:_
migrate the three known RMW races (`addTransactionLocation`,
`#indexTransaction`, `#saveExpectations`) onto set-style primitives.

### M1 — the journal

Schema, repository, `RecordService#journal`, and every writer hook listed in
the kind table. `journal` assigns seq, appends, notifies
`session::{sessionId}` **and** leaves the existing per-transaction /
per-flow-run notifies untouched. Hot-path discipline: wrapped so a store
failure logs and returns. Tests: unit on seq monotonicity, cap trimming,
never-throws; receiver tests assert an ACK and each NACK code journal the right
kind; chain tests assert `CHAIN_SENT`/`CHAIN_PAUSED` entries.

### M2 — piggyback delivery

`drainEvents` + cursor, `EventsDelta` spliced into all listed tool outputs,
`record_get_events`. Cursor semantics: drain advances, explicit read never
does. Harness tests: an event journaled between two tool calls appears on the
second call's result, exactly once; `more` counts overflow; `record_get_events`
re-reads without consuming.

### M3 — session-scope await

Widen `flow_await` per the design (blocking drain, `session::` waiter key,
filters, `runs` summary, bounded re-arm sweep). Existing run-scoped behaviour
byte-for-byte unchanged (its tests must not move). Tests: park then journal →
wakes with the delta; undelivered backlog returns without parking; filter wakes
only on matching kind but delivers everything; timeout is an ordinary outcome.

### M4 — `POSSIBLY_RELATED`

Receiver refusal paths that cannot name a session (`NO_EXPECTATION`,
`WRONG_ENDPOINT`, `SESSION_EXPIRED`) store the refused body out of line
(existing payload store, size-capped) and journal `POSSIBLY_RELATED` — with the
quoted `transaction_id`, action, refusal code and payload handle — to **every
session with an armed expectation on that endpoint scope**. The already-
attributed refusals (`TRANSACTION_MISMATCH`, `TRANSACTION_ABANDONED`) journal
`ATTENTION` on their own session (M1 covers them). Tests: two sessions armed on
one endpoint both see the entry; an unarmed endpoint journals nowhere.

### M5 — auto-send by default

The default flip and the two new trigger sites, exactly as designed above.
Tests: `search` arrives on an `llm_auto` session → `on_search` (no inputs)
auto-sent with zero model calls, `CHAIN_SENT` surfaces on the next tool result;
chain pauses at an input-required step with a `CHAIN_PAUSED` entry naming the
inputs; hosted-form submit triggers the chain; consecutive mock-owned steps
after a manual `SENT` chain through; `manual` session does not chain; explicit
`auto_advance: false` wins.

### M6 — prompts + the end-to-end tests

`mock_buyer` / `mock_seller` learn the new discipline: _steps that need nothing
send themselves; read `events` on every result; when idle, call `flow_await`
with no flow to watch the whole session; your job is inputs, forms and
judgement._ The loop test that matters: **two flows in one session** — an event
lands on flow B while the model works flow A and is learned from piggyback
alone; plus the full no-input flow driven start→COMPLETE with exactly
`flow_start` + one `flow_proceed` + awaits.

### M7 (optional, droppable) — MCP notifications

`resources.subscribe` capability + `notifications/resources/updated` for
`ondc://session/{id}` on journal append. Only if the SDK wiring is cheap;
explicitly non-load-bearing and untested against real clients.

---

## Open questions (settle at implementation, defaults stated)

1. **`FLOW_COMPLETE` dedupe** — the mapper reports COMPLETE on every read after
   the last exchange; journal it only from the append path that first observes
   the transition (receiver post-append / chain pause with COMPLETE). Default:
   guard with a `completed` flag on the transaction record.
2. **Piggyback on record/read tools** — included above for seamlessness; drop
   to flow/form/session tools only if result bloat annoys in practice.
3. **`SESSION_EXPIRING`** — not stored; if wanted, synthesize lazily into a
   delta when `expires_at − now` crosses a threshold. Default: skip in v1.
4. **Cursor at-most-once** — a drained delta lost to a client-side error is
   recoverable via `record_get_events`; do not build redelivery.
5. **`session_state` tool** (planned in CLAUDE.md §3) — the session-scope
   `flow_await` `runs` summary gives most of it; decide after M3 whether a
   separate tool still earns its place.
