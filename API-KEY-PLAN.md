# Plan: a personal MCP API key for every user

## 1. How it works today

Everyone who uses the ONDC Workbench MCP pastes the **same** API key into their AI client.
The MCP (`AUTH_MODE=apikey`) checks the key against the list in `AUTH_API_KEYS`. If it is on
the list, every tool works.

This causes three problems:

- **We don't know who is calling.** Every request looks like `apikey-client`.
- **We can't take access away from one person.** Changing the key cuts everyone off.
- **No one has accepted any terms.** There is no consent step before someone uses the MCP.

## 2. The idea

Think of a gym membership card. You sign up at the front desk (the Workbench website), you
sign the terms, and you get **your own** card. At the door (the MCP), the guard checks the
card against the gym's records on every visit. If you lose the card, you ask the desk for a
new one, and the old one stops working.

- The **Workbench website** is the front desk. It handles login, consent and key creation.
- **Workbench Mongo** holds the records (only a SHA-256 hash of each key).
- The **MCP** is the door. It only checks keys, on every request. It never creates or stores them.

A key lasts **90 days**. It stops working earlier if the user regenerates it or it is revoked.

## 3. The user's journey

1. The user opens the Workbench website and **logs in with GitHub**.
2. They go to **Profile → MCP Access**, read the **consent notice** and tick "I agree".
3. They click **Generate API key**. The site shows the key **once**, e.g. `ondc_mcp_UbXc…`.
4. They paste it into their AI client as `Authorization: Bearer ondc_mcp_…`.
5. On every MCP request, the MCP asks user-management "whose key is this?" If the key is
   valid, tools run as that user. If not, the request gets a `401` and no tool runs.
6. If the key leaks, they click **Regenerate**. The old key stops working **immediately**.
7. After 90 days the key expires and they generate a new one.

```
 User ──login (GitHub)──▶ Workbench website ──▶ user-management ──▶ Mongo
   │                       consent + generate         (stores hash of key)
   │
   └──Bearer ondc_mcp_…──▶ MCP ──POST /mcp/verify (every request)──▶ user-management
                            │◀──────── 200 user 6ac7… / 401 reason ────────┘
                            └─ runs the tool, or refuses
```

## 4. What the Workbench team built (their contract)

The Workbench team owns key creation, consent and the verify endpoint. Their integration
guide is `mcp-key-verification.md` (received 2026-10-08). The parts the MCP depends on:

| | |
|---|---|
| **Endpoint** | `POST {base}/mcp/verify`, body `{ "key": "ondc_mcp_…" }` |
| **Base (dev)** | `https://dev-workbench.ondc.tech/automation-user-management` |
| **Base (prod)** | `https://workbench.ondc.tech/automation-user-management` |
| **Service secret** | Header `X-Service-Token`, one per environment, handed over out of band |
| **Key format** | `^ondc_mcp_[A-Za-z0-9_-]{43}$` (52 chars, 256-bit) |
| **Key lifetime** | 90 days |

- **The base must include `/automation-user-management`.** The bare host is the website,
  which answers every path with `200` and an HTML page. Check with `GET {base}/health`,
  which must return `{"service":"automation-developer-guide","status":"ok"}` as JSON.
- **Valid key:** `200 { valid: true, user_id, username, email, expires_at }`.
  `user_id` is the stable identity.
- **Bad key:** `401 { reason }`, where `reason` is one of:
  - `invalid_format`: not shaped like a key;
  - `not_found`: unknown, or replaced by a regenerated key;
  - `revoked`;
  - `expired`: the body also carries `expires_at`.
- **Our fault:** `400 invalid_body`, `403 forbidden` (service token missing or wrong),
  `429 rate_limited` (a valid service token skips the limiter), and `500 internal_error`.
- Status on 2026-10-08: live on **dev** (answers `403` without the token); production
  returns `404` until they deploy.

**Three requirements are contractual.** The consent text promises them to users:

1. **Fail closed (§8).** Any non-200, timeout or connection error refuses the request.
2. **No caching of verification results (§3).** "The old key stops working immediately."
   Adding a cache needs a consent change and version bump first.
3. **Never store or log the key (§7).** If correlation is needed, log only its first 15
   characters, which is the same hint the profile page shows.

## 5. What we build in the MCP (automation-mcp)

The tools themselves don't change. Only the "door" changes.

**Decision: no new auth mode.** User keys go into the existing `AUTH_MODE=apikey`. Fixed
`AUTH_API_KEYS` keep working (for the batch peer, and for the old shared key during the move),
and user keys are checked with Workbench when a verify URL is set.

**1. Settings** (`src/config/env.ts`), all under `AUTH_MODE=apikey`:

- `AUTH_API_KEYS`: fixed keys, as today. They're optional once the verify URL is set.
- `AUTH_APIKEY_VERIFY_URL`: the full verify URL, including `/automation-user-management/mcp/verify`.
  If unset, only fixed keys work, exactly as today.
- `AUTH_APIKEY_VERIFY_TOKEN`: the service secret, sent as `X-Service-Token`. Keep it in a
  secret store or a local `.env`, never in the repo.
- `AUTH_APIKEY_VERIFY_TIMEOUT_MS`: time budget per verify call (default `5000`).
- The server refuses to start if `apikey` mode has neither fixed keys nor a verify URL, or
  has a verify URL without its token.

**2. How a key is checked**, on every request:

1. **Fixed key?** A timing-safe match against `AUTH_API_KEYS` means a service caller. This
   needs no network, so the batch peer keeps working if Workbench is down.
2. **Verify URL set?** If not, `401`.
3. **Right shape?** Anything failing `^ondc_mcp_[A-Za-z0-9_-]{43}$` gets `401` without a
   network call.
4. **Ask Workbench:** `POST /mcp/verify`, with no cache.
   - `200`, `valid: true`: the caller is that user. `clientId = user_id`; username, email and
     `expires_at` go in `extra`. `expiresAt` is set from their `expires_at`.
   - `401` with a `reason`: `401` to the client, with a message that says what to do.
   - Anything else (400, 403, 429, 5xx, timeout, connection error, HTML or other unexpected
     body): **503** with `Retry-After`. Never let through. `403` and `429` are logged as our
     misconfiguration (the service token is missing or wrong).

**3. 503 handling** (`src/plugins/auth.ts`): done. "Couldn't check" is a 503, not a 500.

**4. Log who called** (`src/lib/define-tool.ts`): done. Every tool-call log line carries
`caller: <user_id>`.

### Progress

Built and tested on 2026-10-08, before Workbench's contract arrived:

- [x] Settings and startup checks, user key check, `apikey` verifier, 503 handling,
  caller in logs, tests and docs

Changes to follow Workbench's contract (2026-10-08):

- [x] Remove the verification cache entirely (Redis wiring, cache setting, cache tests)
- [x] Header `X-Internal-Token` → `X-Service-Token`
- [x] Read their flat reply (`user_id`, `username`, `email`, `expires_at`)
- [x] `401` + `reason` → `401` to the client with a clear message; everything else → `503`
- [x] Use their `expires_at` as the token expiry
- [x] Prescreen with their exact regex
- [x] Default timeout 5s
- [x] Test: an HTML `200` (wrong base URL) is refused
- [x] Docs: README, `.env.example`, `docker-compose.yml`
- [x] Typecheck, lint, full suite (1251 passed)
- [x] Live check against dev: service token accepted; malformed key → 401; unknown key → 401
  "Key not recognised…"; fixed key → 200; wrong token → 503; URL without the prefix → 503
- [x] Live check with a **real** user key from dev (valid → 200, real tool call → 200, regenerate → old key 401, new key 200)

**Later, not in this change: session ownership** (parked 2026-10-08).

- **The gap:** anyone with a valid key who has another user's `session_id` can run flows in it
  (`flow_start`/`flow_proceed` send real requests to that session's endpoint), restart it,
  submit forms and read its payloads and data. `flow_id`s are public, so the session id is
  the only secret, and it leaks through viewer links, chats, screenshots and logs.
- **They can't** change the session's endpoint, domain, version or expiry.
- **Fix:** store `owner: <user id>` on `session_create`. Check it at every tool and resource
  boundary with a small `requireOwnedSession` helper, answering "not found" to anyone else.
  Don't put the check in `requireSession`, because the receiver, auto-advance and the viewer
  also call it.
- **Also cover:** `record_get_payload` and `ondc://payload/{id}`, which fetch a payload by id
  without checking which session it belongs to, and `batch_run_*` by `run_id`.
- **Edge cases:** fixed keys share one identity, same as today; sessions without an owner (from
  before the release) stay open until they expire; `AUTH_MODE=none` and stdio don't check.

## 6. Edge cases and decisions

| Situation | What happens |
|---|---|
| User regenerates or a key is revoked | Every request is verified, so the old key gets `401` on its next call. |
| Key expires (90 days) | `401` with reason `expired`; the user generates a new one. |
| Workbench is down or slow | Users get **503** after at most 5s. Fixed keys (batch peer) keep working. |
| Wrong base URL (bare host answers HTML) | The body isn't the expected JSON, so the request is refused with 503 and logged. |
| Service token missing or wrong | Workbench answers `403`, so every user gets 503. It's logged as our misconfiguration. |
| Someone guesses keys | 256-bit keys can't be guessed. Malformed keys are rejected before any network call. |
| Mongo is leaked | It only contains hashes, which are useless as keys. |

## 7. Consent promises about the MCP that need attention

Workbench's guide lists what the consent text promises about the MCP itself. Two don't match
the code today, and must be fixed or reworded before the consent screen ships:

- **"Viewer links gated by a private, expiring access token."** Today the viewer uses one
  shared `UI_TOKEN` that doesn't expire, so any viewer link can open any session.
- **"Outgoing requests validated against ONDC rules before they are sent."** True normally,
  but when the validation service is unreachable, requests are sent unchecked (the gate fails
  open by design).

Also check that the consent text mentions the **90-day** key lifetime.

## 8. Order of work

1. Make the MCP match the contract (section 5 progress list).
2. Test against **dev** with a real key and the dev service token, both from a local `.env`.
3. Commit and open the PR. Merging to `main` deploys the live MCP.
4. Add `AUTH_APIKEY_VERIFY_URL` and `AUTH_APIKEY_VERIFY_TOKEN` (as a Secret) to the
   `automationMcp` section of `automation-iac`.
5. Tell users to generate keys. The old shared key keeps working alongside user keys.
6. Once users have moved, remove the old shared key from `AUTH_API_KEYS`.

## 9. Open questions

- **Service token exposure:** the dev token was pasted into a chat on 2026-10-08. Ask
  Workbench to rotate it.
- **Production:** when will `/mcp/verify` be deployed on `workbench.ondc.tech`, and what is the
  production service token?
- **Consent mismatches:** who fixes the viewer token, and is the fail-open validation wording
  acceptable (section 7)?
- **Expiry warnings:** should the MCP warn users when `expires_at` is close (Workbench
  recommends this)?
- **Cut-over:** how long should the old shared key keep working, and who tells current users?
