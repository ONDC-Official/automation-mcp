# OVERRIDES-PLAN.md — an escape hatch for a broken flow config

> **Status: shipped**, 2026-07-31. Every decision below landed as written; the
> verification list is covered by `flow.overrides.test.ts` (the rules) and a
> `payload_overrides` block in `flow.loop.test.ts` (the path).
>
> ## What shipped beyond the plan
>
> - **A third refusal the plan did not name: overrides on a non-dispatch
>   branch.** They only mean something where a payload is generated, and
>   silently dropping them on a `listen`, `form` or `outcome` branch would be
>   the very failure this feature answers — a caller states an intent and
>   nothing honours it or says so. `flow_proceed` answers
>   `BLOCKED`/`overrides_not_applicable`.
> - **Two caps, because the input is a free-form map**: 20 paths per call and
>   4KB per value. An override repairs a field; a caller supplying a message
>   body through it is running the wrong flow.
> - **Duplicate spellings are refused**, not merged. `$.context.bpp_uri` and
>   `$['context']['bpp_uri']` are one location, and applying both would resolve
>   in object-key order — an order nobody chose.
> - **Numeric subscripts had to survive as numbers.**
>   `jsonpath.stringify(["$","a","0"])` is `$.a["0"]`, which creates an object
>   key rather than writing an array element. Pinned by a test.
> - **`suggestOverrides` filters what it suggests.** A finding on
>   `$.context.transaction_id` would be suggested and then refused, which reads
>   as the tool contradicting itself.
> - **The journal carries `overrides` too**, not just the record. The incident
>   corpus resolves from the journal, so `RECOVERED_WITH_OVERRIDE` could not
>   have been derived from `ApiEntry` alone.
> - **`ApiEntry.overrides` holds paths only**, not the values. The plan said
>   "the paths and the values"; the values are already in the stored payload at
>   exactly those paths, and duplicating unbounded caller-supplied data into the
>   record buys nothing.
> - **`isRecovered()`** exists so the two recoveries stay distinguishable in the
>   corpus and interchangeable in control flow — a repeat re-opens either one.
>
> ## Not done
>
> `report/` reporting a patched step as patched, because `report_generate` does
> not exist yet. The evidence it needs is recorded and waiting:
> `ApiEntry.overrides`.

## Context — both runs ended `gave_up`

Two TRV11 runs on 2026-07-31 spooled four incidents. Three were tooling defects
and are fixed. The fourth is not ours at all, and that is the problem.

`search2_METRO_201` in `STATION_CODE_FLOW_ORDER`, decoded from the live
config-service:

```js
existingPayload.context.bpp_id = sessionData?.bppId[0]; // unwraps
existingPayload.context.bpp_uri = sessionData?.bppUri; // ← missing [0]
```

`saveBusinessData` stores `jsonpath.query` results, so `bppUri` is
`["https://…/seller"]`. The adjacent line unwraps; this one does not. The
generated payload carries an array where the schema wants a string, our outbound
gate answers `BLOCKED`/`validation_failed`, and the run stops there. It
reproduces on the workbench identically — our port of `getUpdatedData` matches
`workbench-cache.ts:132-168` exactly. This is a defect in a **published** config,
and nothing in this repo can fix it.

What the model could do about it was: dry-run, inspect the payload, confirm the
diagnosis, and stop. Both runs' `tooling_gap` fields asked for the same thing in
different words, and both `outcome` fields read `gave_up`.

That is the real cost. A compliance run against a correct participant produced no
compliance report, because one step of one flow had a typo upstream. The
participant learns nothing; we learn nothing about the participant.

## The shape

Add `payload_overrides` to `flow_proceed`: a map of JSONPath → replacement
value, applied to the generated payload **after** `generate` and **before** the
validation gate.

```jsonc
{
  "flow_id": "STATION_CODE_FLOW_ORDER",
  "inputs": { "start_code": "MOCK_STATION_1", "end_code": "MOCK_STATION_2" },
  "payload_overrides": {
    "$.context.bpp_uri": "https://workbench.ondc.tech/api-service/ONDC:TRV11/2.0.1/seller",
  },
}
```

The run continues with a **correct** payload rather than a knowingly broken one.
That is the whole argument for overrides over a `force: true` that sends the bad
payload anyway: the participant is being tested, and testing it against a payload
we already know violates L0 tells neither side anything.

## Decisions (fix these before building)

| Decision                     | Choice                                                                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where it applies**         | After`generate`, before the gate and before `#assertTransactionId`. Overriding a payload the gate has not yet seen is the point; overriding one already sent is not expressible                          |
| **What it can name**         | Any JSONPath the generated payload already resolves,**plus** creation of a missing leaf. A path that matches nothing and cannot be created is a tool error, not a silent no-op                           |
| **`context.transaction_id`** | **Refused.** `#assertTransactionId` exists because a config rewriting it takes the transaction apart on both sides; letting the model do deliberately what the config does by accident is strictly worse |
| **Recorded, always**         | `ApiEntry` grows `overrides` — the paths and the values. A patched step is not a clean step and the compliance report must be able to say so                                                             |
| **Scope**                    | One call. Overrides do**not** persist to the next `flow_proceed`, and auto-advance chaining never inherits them — a chained step nobody approved must not carry a patch nobody re-stated                 |
| **Not a validation bypass**  | The gate still runs, on the patched payload. An override that does not fix the finding still blocks                                                                                                      |

### What this is explicitly not

- **Not `force`/`skip_validation`.** Sending a payload known to fail L0 writes
  our defect into the participant's compliance report. If that is ever wanted it
  is a separate, louder flag.
- **Not a step skip.** Skipping leaves the flow's state machine describing a
  transaction that did not happen.
- **Not a config editor.** Overrides live on the call, never on the cached
  config. The next session gets the upstream config unmodified.

## Surfacing it

The `BLOCKED`/`validation_failed` detail already carries `findings`, each with a
`json_path`. It should carry the override that would fix each one:

```
Blocked: $.context.bpp_uri — got array, want string.
  To proceed past a config defect, re-run with
  payload_overrides: {"$.context.bpp_uri": <a string>}
```

That closes the loop the 2026-07-31 runs opened: the message that says "this is
probably a config defect" should also say what to do about it. Today it says
"inspect with dry_run" and stops — which is what walked the model into filing a
second incident (fixed separately in `feedback.detect.ts`).

## Feedback interaction

An override is evidence, not noise. When a step succeeds only with one applied,
the incident's resolution should record `RECOVERED_WITH_OVERRIDE` rather than
plain `RECOVERED` — "the model worked around a config defect" and "the model
fixed its own mistake" are different rows in the corpus, and conflating them
would make the most valuable column mean less. The upstream defect is then
reportable to whoever owns the config, which is the outcome that actually
matters here.

## Files

| File                          | Change                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `flow/flow.schema.ts`         | `payload_overrides` on `ProceedInput`; `overrides` on the outcome                                         |
| `flow/flow.service.ts`        | apply after`generate`; refuse `transaction_id`; thread to the record; never inherit into `#scheduleChain` |
| `flow/flow.overrides.ts`      | new — apply + refuse, pure, and the file with the tests                                                   |
| `record/record.schema.ts`     | `ApiEntry.overrides`                                                                                      |
| `feedback/feedback.schema.ts` | the`RECOVERED_WITH_OVERRIDE` state                                                                        |
| `report/`                     | when it lands, a patched step is reported as patched                                                      |

## Verification

1. A step whose config generates a non-compliant payload proceeds with an
   override and is refused without one.
2. The gate still runs on the patched payload: an override that does not fix the
   finding still blocks.
3. `$.context.transaction_id` is refused by name.
4. A chained step does not inherit the previous call's overrides.
5. The record shows the step as overridden, with the paths.
6. End to end against `runnable-config.ts`: add a step whose `generate` emits a
   known-bad field, and drive it green through `payload_overrides`.
