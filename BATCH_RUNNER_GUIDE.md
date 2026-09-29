# Concurrent TRV11 Metro order-journey runner — usage guide

`src/modules/batch/` lets you fire off many independent Beckn order journeys at
once, in the background, and poll their progress — for load and compliance
testing of the TRV11-2.0.0 Metro flow (or any other domain/flow this server
knows about). This is a runbook for driving it from an MCP client. For how it
is built, see `CLAUDE.md`'s "Feature in progress" section and the module's own
source comments; this file is only about *using* it.

## 0. The short version: one call

Call the **buyer** instance only. It starts the seller instance itself
(arming it first), places the orders, and one `batch_id` covers both sides.

```bash
curl --location 'http://127.0.0.1:3000/mcp' \
--header 'Content-Type: application/json' \
--header 'Accept: application/json, text/event-stream' \
--data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
  "name":"batch_run_start",
  "arguments":{"version":"2.0.1","transaction_count":100,"concurrency":25}}}'
```

- Needs `BATCH_PEER_URL=http://127.0.0.1:3010` on the buyer instance (already in
  `.env.initiator`), pointing at the seller instance.
- `version` picks the journey: `2.0.1` or `2.0.0`. `role` defaults to `both`.
- Status (`batch_run_status`) and cancel (`batch_run_cancel`) take that one
  `batch_id`; status also shows the seller side under `peer`.

**Who the orders are between.** The buyer is the BAP and the seller the BPP.
`bap_id`, `bap_uri`, `bpp_id` and `bpp_uri` are all optional inputs; leave them
out and the defaults apply (this instance's `MOCK_SUBSCRIBER_ID` and advertised
URI for the buyer, the configured seller instance for the seller).

- **`bpp_uri` (+ `bpp_id`)** points the buyer at *another seller app*. The order
  then happens between this buyer and that seller; nothing is started on the
  seller instance, and the seller must call back on `bap_uri`.
- **`bap_uri`** is where the seller calls this buyer back. It must end
  `/{domain}/{version}/buyer` (the path this server mounts) and be reachable by
  the seller; anything else is refused up front.
- `bap_id` / `bpp_id` are what goes into `context.bap_id` / `context.bpp_id`.
  Once the seller's own replies name its `bpp_id`, that value takes over for the
  rest of the order.

```bash
curl --location 'http://127.0.0.1:3000/mcp' \
--header 'Content-Type: application/json' \
--header 'Accept: application/json, text/event-stream' \
--data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
  "name":"batch_run_start",
  "arguments":{
    "version":"2.0.1","transaction_count":10,
    "bap_id":"my-buyer.example.com",
    "bap_uri":"https://my-buyer.example.com/ONDC:TRV11/2.0.1/buyer",
    "bpp_id":"their-seller.example.com",
    "bpp_uri":"https://their-seller.example.com/ONDC:TRV11/2.0.1/seller"}}}'
```

The response lists `parties` (who the orders are between, and whether the seller
is `peer` or `external`).

**Choosing the flow.** `version` alone runs that version's default order
journey. To pick another flow, list what the version offers and pass `flow_id`:

```bash
curl --location 'http://127.0.0.1:3000/mcp' \
--header 'Content-Type: application/json' \
--header 'Accept: application/json, text/event-stream' \
--data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
  "name":"batch_list_flows","arguments":{"version":"2.0.1"}}}'
```

Each flow is marked runnable or not, with the reason. The flow is read from its
own definition on the config-service, so a flow is runnable when every step
that needs input is one the runner can fill (a city search, a station search,
a select). A flow with an update, cancel or issue step that takes input is
refused, naming the step.

**Every order id and amount in a batch** — the direct answer to "what did this
batch place": each order's real seller-assigned id, status, payment status and
the quote total, without pulling a payload body:

```bash
curl --location 'http://127.0.0.1:3000/mcp' \
--header 'Content-Type: application/json' \
--header 'Accept: application/json, text/event-stream' \
--data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
  "name":"batch_list_orders",
  "arguments":{"batch_id":"<batch_id>","since_index":0,"limit":100}}}'
```

Each entry is `{index, transaction_id, order_id, order_status, payment_status,
amount, currency, batch_status, ...}`. An order that never reached one — still
running, or blocked/timed out before the seller assigned an id — has no
`order_id`/`amount` and carries `message` saying why instead. Paginated the
same way as the two tools below (`since_index`/`limit`, `next_since_index`).

**The complete log of one order** (every exchange in order, direction, timestamp,
ACK, events, final order state):

```bash
curl --location 'http://127.0.0.1:3000/mcp' \
--header 'Content-Type: application/json' \
--header 'Accept: application/json, text/event-stream' \
--data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
  "name":"batch_run_order_log",
  "arguments":{"batch_id":"<batch_id>","index":0,"include_payloads":true}}}'
```

**One action across the whole batch** — e.g. the `on_confirm` of all 10 orders
(context and message), or omit `actions` for every step of every order:

```bash
curl --location 'http://127.0.0.1:3000/mcp' \
--header 'Content-Type: application/json' \
--header 'Accept: application/json, text/event-stream' \
--data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
  "name":"batch_run_payloads",
  "arguments":{"batch_id":"<batch_id>","actions":["on_confirm"],"limit":10}}}'
```

`parts` is `both` (default), `context` or `message`. Results are paginated over
the batch's orders (`since_index` / `limit`, `next_since_index` in the answer):
a full order is about 85KB, so 10 complete orders are about 0.9MB.

Name the order by `index` or `transaction_id` (both are in the status results).
`include_payloads` adds every request and response body (capped per payload by
`max_payload_bytes`, default 50000). The sections below describe the two-call
form, which still works (`role: "listener"` then `role: "initiator"`).

## 1. What it actually does

One `batch_run_start` call kicks off up to `transaction_count` independent
order journeys, each with its own session and its own randomly-generated,
unique inputs (GPS-derived origin/destination stations, item quantity), driven
concurrently by a bounded worker pool (`concurrency` slots). It returns
immediately — the call never blocks on the batch finishing — and you poll
`batch_run_status` for progress and, once you want them, results.

**Two local `automation-mcp` instances, not one.** This server is a *mock
network participant* — one side of a transaction. To run a full order journey
end to end you need a mock BAP and a mock BPP talking to each other over real
wire calls, which means two processes:

- One instance runs the batch with `role: "listener"` — it plays the mock BPP
  (the seller). It arms every session up front and waits for the buyer side to
  call in, then fires the one step nothing auto-sends (the unsolicited
  `on_status` close) once each journey's ordinary sequence completes.
- The other runs the batch with `role: "initiator"` — it plays the mock BAP
  (the buyer). It sends `search1` with this order's generated `city_code`,
  waits for the catalog, and drives `select` with the real item id read back
  from the seller's response (never a hardcoded guess).

**Start the listener side first.** Every session on one instance shares one
receiver endpoint, and the very first exchange of each journey is matched
against whatever is currently armed, oldest first. If the initiator starts
sending before the listener has armed its sessions, the seller side has
nothing to match those calls against.

## 2. Prerequisites

Two ports, two `automation-mcp` processes, both pointed at the same
config-service. Redis is optional under a few dozen concurrent transactions
but recommended at `concurrency` >= 100, so state survives a crash of either
process instead of stranding the other mid-transaction.

```bash
# Optional, but recommended at scale — shared Redis for both instances.
docker compose -f docker-compose.dev.yml up -d
```

```bash
# Instance A — mock BPP (the "listener" side, start this one first)
PORT=3010 MOCK_SUBSCRIBER_ID=mock-bpp.local \
  REDIS_URL=redis://127.0.0.1:6379 REDIS_KEY_PREFIX=bppinst:: \
  MOCK_RUNNER_POOL_SIZE=16 \
  npm run dev
```

```bash
# Instance B — mock BAP (the "initiator" side)
PORT=3000 MOCK_SUBSCRIBER_ID=mock-bap.local \
  REDIS_URL=redis://127.0.0.1:6379 REDIS_KEY_PREFIX=bapinst:: \
  MOCK_RUNNER_POOL_SIZE=16 \
  npm run dev
```

Notes:

- **`RECEIVER_PORT` is not what you think under `npm run dev`.** Under HTTP
  transport (which is what `npm run dev` runs), the receiver is mounted on the
  *same* port as everything else — `PORT` — and `RECEIVER_PORT` is read only
  by the stdio entrypoint's standalone listener. `PORT` alone is what
  determines each instance's receiver base URL (`http://127.0.0.1:{PORT}` by
  default, or set `RECEIVER_PUBLIC_URL` explicitly to override it, e.g. behind
  a tunnel).
- `REDIS_KEY_PREFIX` must differ between the two instances sharing one Redis,
  or their sessions collide.
- `MOCK_RUNNER_POOL_SIZE` is the mock-runner's own worker pool for executing
  each step's generate/validate/requirements JS. The library default is 2,
  which starves badly under real concurrency — see the troubleshooting table.
- Your MCP client connects to each instance separately (e.g.
  `http://localhost:3000/mcp` and `http://localhost:3010/mcp`), and you call
  `batch_run_start` on each with the matching `role`.

## 3. The counterparty URL

`counterparty_subscriber_url` on `batch_run_start` is **the other instance's
receiver base URL for the role that instance is playing** — not your own.
Given the ports above:

| Call this on...       | `role`        | `counterparty_subscriber_url`                   |
| --------------------- | --------------- | ------------------------------------------------- |
| Instance A (mock BPP) | `"listener"`  | `http://localhost:3001/ONDC:TRV11/2.0.0/buyer`  |
| Instance B (mock BAP) | `"initiator"` | `http://localhost:3011/ONDC:TRV11/2.0.0/seller` |

(`buyer` is the BAP's own endpoint segment, `seller` the BPP's — see
`CLAUDE.md` §"The endpoint, and how a call is matched to a session".) If you
changed `RECEIVER_PORT` / `RECEIVER_PUBLIC_URL`, substitute your own base.

## 4. Tool reference

### `batch_run_start`

All fields except `role`, `counterparty_subscriber_url` and
`transaction_count` have sane defaults for TRV11-2.0.0 Metro.

Minimal — on the listener instance:

```json
{
  "role": "listener",
  "counterparty_subscriber_url": "http://localhost:3001/ONDC:TRV11/2.0.0/buyer",
  "transaction_count": 5
}
```

Minimal — on the initiator instance:

```json
{
  "role": "initiator",
  "counterparty_subscriber_url": "http://localhost:3011/ONDC:TRV11/2.0.0/seller",
  "transaction_count": 5
}
```

Fully specified:

```json
{
  "role": "initiator",
  "domain": "ONDC:TRV11",
  "version": "2.0.0",
  "usecase": "Metro",
  "flow_id": "ORDER_TO_CONFIRM_TO_JOURNEY_COMPLETION_SJT",
  "counterparty_subscriber_url": "http://localhost:3011/ONDC:TRV11/2.0.0/seller",
  "transaction_count": 1000,
  "concurrency": 50,
  "per_transaction_timeout_ms": 120000,
  "gps_bounding_box": { "min_lat": 12.90, "max_lat": 13.05, "min_lon": 77.55, "max_lon": 77.70 },
  "city_codes": ["std:080"]
}
```

Returns immediately:

```json
{
  "batch_id": "…",
  "role": "initiator",
  "transaction_count": 1000,
  "concurrency": 50,
  "accepted_at": "2026-09-27T…"
}
```

### `batch_run_status`

```json
{ "batch_id": "…" }
```

```json
{
  "batch_id": "…",
  "state": "running",
  "transaction_count": 1000,
  "concurrency": 50,
  "progress": {
    "queued": 812, "in_flight": 50, "completed": 130,
    "blocked": 3, "nacked": 0, "timed_out": 5, "errored": 0
  },
  "accepted_at": "2026-09-27T…"
}
```

`state` is `"running"` until every transaction has settled or the run was
cancelled, then `"completed"` or `"cancelled"`.

To see individual outcomes, pass `include_results: true` and paginate with
`since_index`/`limit` (max 500 per call — the full list is never returned in
one response):

```json
{ "batch_id": "…", "include_results": true, "since_index": 0, "limit": 100 }
```

Each result carries `index`, `status`, `transaction_id`, the `inputs` that
were generated for it (present as soon as the transaction started driving,
including on a timed-out/blocked/errored outcome — useful for reproducing a
specific failure), `item_id` when one was read back, and a human `message`
plus a machine `reason` for anything non-`completed`.

### `batch_run_cancel`

```json
{ "batch_id": "…" }
```

Stops issuing *new* transactions from the pool. Whatever is already in flight
(at most `concurrency` transactions) finishes or times out on its own —
nothing is hard-killed mid-call, so no lock or session is ever left in a torn
state. `batch_run_status` will keep reporting `"running"` for those last few
slots, then settle to `"cancelled"`.

## Scale, limits and the rate limit

- **Up to 1000 orders per batch, and up to 1000 running at once.** Anything
  larger is refused.
- **Verified live:** 1000 orders on `2.0.1` at `concurrency: 50` completed 1000
  of 1000 on both sides in about 2 minutes (median 3.6s per order), with
  1000 unique transaction ids and instance memory under 1 GB. Use 10 to 50;
  much higher (200 was tried) only queues orders behind each other and grows
  memory.
- **Set `RATE_LIMIT_MAX` high on both instances** (the `.env` files here use
  `1000000`). The default is 120 requests per minute per IP, shared with the
  receiver routes. Buyer and seller call each other from one IP, so a batch
  trips it within seconds: replies come back as "UNPARSEABLE" and orders wait
  forever for a callback that was never accepted. The symptom is orders stuck
  at a late step (`on_status`) and `timed_out`.
- Only 22 (`2.0.1`) or 9 (`2.0.0`) stations exist on the mock seller, so
  station pairs repeat across a large batch (409 distinct pairs in 1000
  orders); GPS points and transaction ids are still unique per order.

## Choosing a version

Set `version` on `batch_run_start` (on **both** calls) and the matching order
journey is used — `flow_id`, step ids and known config repairs come with it:

| `version` | Flow | Notes |
| --- | --- | --- |
| `2.0.1` (**recommended** — released) | `STATION_CODE_FLOW_ORDER` | Runs all 12 steps to `COMPLETE`: `confirm` is sent and the order comes back `PAID`. Verified live, 10 of 10 orders on the deployed dev-workbench config-service. Start/end stations are picked from the seller's own catalog, and each order's GPS is re-centred on them |
| `2.0.0` (`TO_BE_DEPRECATED`) | `ORDER_TO_CONFIRM_TO_JOURNEY_COMPLETION_SJT` | Runs all 13 steps to `COMPLETE`, order `status: COMPLETED`. Verified live, 10 of 10 orders. Stations are limited to the 9 the seller's two routes share. Still the default `version` for backward compatibility |

The counterparty URLs must carry the same version:
`http://127.0.0.1:3000/ONDC:TRV11/2.0.1/buyer` and
`http://127.0.0.1:3010/ONDC:TRV11/2.0.1/seller`.

Any other domain/version/usecase has no built-in journey and is refused up
front; pass `flow_id` and `step_ids` yourself (find them with
`catalog_describe_flow`). See `src/modules/batch/batch.version-presets.ts`.

## 5. Worked walkthrough

1. **Sanity-check at N=5.** Start both instances (§2). On the listener
   instance, call `batch_run_start` with `role: "listener"`,
   `transaction_count: 5`. On the initiator instance, call it with
   `role: "initiator"`, `transaction_count: 5`, same `flow_id`. Poll
   `batch_run_status` with `include_results: true` on either instance until
   `state` is `"completed"`. All 5 should show `status: "completed"`.
2. **Spot-check uniqueness.** Compare the `inputs` across the 5 results:
   `origin_gps`/`destination_gps`/`start_code`/`end_code` should all differ,
   and no two `item_id` reads should be suspicious duplicates unless the
   fixture's catalog genuinely offers the same item to everyone (it does, by
   design — uniqueness is about the *inputs*, not the catalog).
3. **N=25.** Bump `transaction_count` to 25 on both sides (same `concurrency`
   default, 50). Watch for `blocked` results with `reason: "no_item_id"` or
   anything mentioning `NO_EXPECTATION` — that means the initiator side
   started sending before the listener side had armed its sessions. Restart
   the listener's batch first, wait for its `batch_run_status` to show
   `progress.in_flight` or `queued` nonzero, *then* start the initiator's.
4. **N=200–1000.** Bump `transaction_count` further, and raise `concurrency`
   in step with it (e.g. `concurrency: 100` at `transaction_count: 1000`).
   Expect a few seconds of ramp-up latency as sessions arm — not a bug. If
   `per_transaction_timeout_ms` starts getting hit broadly rather than on a
   handful of stragglers, see the troubleshooting table below.

## 6. Troubleshooting

| Symptom                                                                                                                             | Likely cause                                                                                                                                                                                                                                                                                          | Fix                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Many`blocked` results, message mentions `NO_EXPECTATION` or a 412                                                               | The initiator side started (or ramped past what the listener had armed) before the listener's sessions were armed                                                                                                                                                                                     | Start the listener's`batch_run_start` first; wait for its `batch_run_status` to show non-zero `in_flight`/`queued` before starting the initiator's                                                                    |
| `reason: "no_item_id"` on many initiator results                                                                                  | The seller's`on_search` catalog never arrived or carried no item id — check the listener instance is actually reachable at the `counterparty_subscriber_url` you gave the initiator                                                                                                              | Verify the URL (§3), check the listener instance's own logs for inbound`search` calls                                                                                                                                      |
| Rising latency / growing`in_flight` that never drains as `concurrency` climbs                                                   | The mock-runner's shared worker pool (`MOCK_RUNNER_POOL_SIZE`, library default 2) is saturated — every `generate`/`validate`/`requirements` call executes in this pool                                                                                                                       | Raise`MOCK_RUNNER_POOL_SIZE` on both instances (try `concurrency / 3` as a starting point)                                                                                                                                |
| Everything eventually`timed_out`, nothing else                                                                                    | The counterparty URL is wrong, unreachable, or pointed at the wrong role's endpoint (`buyer` vs `seller`)                                                                                                                                                                                         | Re-check §3; curl the bare URL (`GET {counterparty_subscriber_url}`) — the receiver answers `{ok:true,...}` on a reachable endpoint                                                                                     |
| `batch_run_status` 404s (`not_found`) shortly after `batch_run_start` succeeded                                               | You are polling the wrong instance — results live on whichever instance's`startRun` you called, in that process's own state store (or shared Redis, if configured)                                                                                                                                 | Poll the same instance you started the run on, or make sure both instances share`REDIS_URL`                                                                                                                                 |
| A run stuck at`state: "running"` with `progress.queued` frozen and no `in_flight`                                             | You called`batch_run_cancel`, and this is the tail: results already in flight are still finishing on their own budget                                                                                                                                                                               | Wait out`per_transaction_timeout_ms`, or check `batch_run_status` again shortly — it will settle to `"cancelled"`                                                                                                      |
| `blocked` with `reason: "requirements_not_met"`, message names a step like `on_init_METRO_200` and "Missing X in sessionData" | The domain/version you're driving has a real gap in its own published mock config — a later step needs business data an earlier one never populated. Confirmed live on`ONDC:TRV11`/`2.0.0` (`TO_BE_DEPRECATED`): `on_init_METRO_200` needs `fulfillments` that nothing upstream of it sets | Not a batch-runner bug. Try a non-deprecated version (`2.0.1`/`2.1.0`) of the same domain, or use `payload_overrides` on the affected step if you must stay on this version — see `automation-mcp/OVERRIDES-PLAN.md` |

## 7. Defaults worth knowing

- `domain`/`version`/`usecase` default to `ONDC:TRV11` / `2.0.0` / `Metro`.
- `flow_id` defaults to `ORDER_TO_CONFIRM_TO_JOURNEY_COMPLETION_SJT`.
- `concurrency` defaults to 50, `per_transaction_timeout_ms` to 120000 (2
  minutes) — comfortably inside this server's own `EXPECTATION_TTL_MS` /
  `AWAIT_MAX_WAIT_MS` defaults (300s each), so a stuck transaction fails on
  its own budget before those.
- `gps_bounding_box` defaults to a Bangalore-area box; `city_codes` defaults to
  `["std:080"]`. Every generated origin/destination pair is unique within one
  run — the generator re-rolls on collision.
- Batch results are kept 24h after a run finishes, then expire.
