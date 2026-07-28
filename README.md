# ondc-mcp

A production MCP server boilerplate: **stdio + Streamable HTTP**, built on the
MCP TypeScript SDK **v2** against spec revision **2026-07-28**.

The design goal is horizontal scalability. The 2026-07-28 transport is
stateless — no `Mcp-Session-Id`, no `initialize` handshake, no long-lived GET
stream — so any replica can answer any request behind a plain round-robin load
balancer. `src/app.test.ts` proves it: one instance lists the tools, a second
instance with no shared state executes the call.

```bash
npm install
cp .env.example .env

npm run dev          # HTTP transport on :3000
npm run dev:stdio    # stdio transport
npm run inspect      # MCP Inspector against the stdio entrypoint

npm run typecheck && npm run lint && npm test
```

---

## Layout

```
src/
  mcp/server.ts          buildMcpServer(container, ctx) — THE factory, no transport
  mcp/capabilities.ts    one line per module
  entrypoints/stdio.ts   serveStdio(...)     — only stdio binder
  entrypoints/http.ts    listen()            — only file that binds a port
  app.ts                 buildHttpApp(...)   — Fastify host, no listen()
  container.ts           boot-once singletons + dependency health checks
  config/env.ts          zod env, parsed once, exits non-zero when invalid
  plugins/               security · error-handler · auth · mcp
  modules/example/       the reference pattern — copy this for new modules
  modules/health/        /health and /ready
  lib/                   errors · define-tool · logger · token-verifier
  test/harness.ts        in-process client ↔ server (the app.inject() analogue)
```

## The one architectural idea

The SDK's central type is `McpServerFactory = (ctx) => McpServer`. Both
entrypoints consume it, so the scaffold has a direct analogue of `buildApp()`:

> **`buildMcpServer(container, ctx)` registers every capability and binds no
> transport.** Entrypoints own transports. Tests consume the factory directly.

**Keep the factory cheap.** Over HTTP it runs **once per request** — that is
what makes the transport stateless. Anything expensive (connection pools, HTTP
agents, caches) belongs in `createContainer`, built once at boot and closed
over. Get this wrong and you open a pool per request; the symptom is a capacity
cliff under load, not a failing test. So `src/mcp/server.test.ts` asserts the
factory performs no I/O across 100 constructions.

## Layering

`tool → service → repository`, one-way, never skipped — the MCP analogue of
`routes → controller → service → repository`.

| File              | Role                                                                 |
| ----------------- | -------------------------------------------------------------------- |
| `*.tool.ts`       | Protocol edge. Schemas, annotations, result shaping. Knows MCP only. |
| `*.service.ts`    | Business logic.**Imports nothing from the SDK.** Throws `AppError`.  |
| `*.repository.ts` | Data access. Interface + in-memory implementation.                   |
| `*.schema.ts`     | zod schemas;`z.infer<>` types derive from them.                      |

A service never returns `{ content: [...] }`; a tool never contains a business
rule. That is what lets one service back a tool, a resource, and later a REST
route.

---

## MCP-specific conventions

These are the rules with no REST analogue. They are the substance of the
scaffold.

### 1. Every tool declares both schemas

`defineTool` requires `inputSchema` **and** `outputSchema` — a tool missing
either will not typecheck. `outputSchema` drives `structuredContent`, which is
what makes a tool consumable by code rather than only by a model reading prose.
Handlers return typed domain data; the helper builds the envelope, so no tool
can return half of it.

```ts
defineTool({
  name: "example_get_item",
  title: "Get item",
  description: "Fetch a single item by its exact identifier.",
  inputSchema: GetItemInput,
  outputSchema: GetItemOutput,
  annotations: { readOnlyHint: true, idempotentHint: true },
  render: ({ item }) => `${item.name} (${item.id})`,
  handler: async ({ id }) => ({ item: await service.getItem(id) }),
});
```

### 2. Two error channels — pick by _who can fix it_

| Failure                                           | Channel                    | Who acts                                                         |
| ------------------------------------------------- | -------------------------- | ---------------------------------------------------------------- |
| Bad arguments, not found, conflict, upstream down | `{ isError: true }` result | The**model** — it reads the failure and retries differently      |
| Auth failure, unknown method                      | JSON-RPC error             | The**client** — the model cannot mint a token or invent a method |

Report a model-fixable failure as a protocol error and the model never learns
the call failed; it sees a transport fault and retries the identical call.

Argument validation sits on the **tool** channel — which is also what the SDK
does for `inputSchema` violations it catches itself. `example.tool.test.ts`
pins that behaviour so the two layers stay consistent.

Each `AppError` subclass declares its own channel; `handleToolError` routes it.

### 3. stdout belongs to the protocol

On stdio, **stdout is the JSON-RPC channel**. One stray `console.log` corrupts
the stream and surfaces as an unrelated-looking parse error in the client.

- pino writes to **stderr** in every mode. There is no config that changes it.
- `no-console` is an ESLint **error** — load-bearing here, not stylistic.
- `src/entrypoints/stdio.test.ts` spawns the real entrypoint and fails if a
  single non-protocol byte reaches stdout.

This also matches 2026-07-28, which deprecates the MCP `logging` capability in
favour of stderr (stdio) and OpenTelemetry (HTTP).

### 4. No module-level mutable state

The point of the stateless revision. Cross-request state goes to the injected
`ServerEventBus` — in-process by default; pass a Redis-backed implementation to
`createMcpHandler({ bus })` when running more than one replica.

### 5. Cache hints are free throughput

Cacheable results (`tools/list`, `prompts/list`, `resources/*`,
`server/discover`) carry `ttlMs` / `cacheScope`. **The SDK default is
`ttlMs: 0, cacheScope: "private"` — no caching at all.** `mcp/server.ts` sets
them deliberately, and a test asserts `tools/list` really carries them. Treat an
unset hint as a decision you skipped.

### 6. Trace context is propagated

`_meta` carries W3C `traceparent` / `tracestate` / `baggage` (formalised for
MCP in 2026-07-28). `defineTool` lifts them into the per-call child logger, so
a tool call correlates with the rest of your traces. There is no separate
observability plugin: request logging is Fastify's own (pointed at the shared
stderr logger in `app.ts`), and the MCP-level context belongs where the call
is served.

### 7. Deprecated surface is avoided

`roots`, `sampling`, and the `logging` capability are all deprecated in
2026-07-28. Nothing here builds on them. Server→client requests are expressed
with `inputRequired(...)` instead.

---

## Talking to the HTTP transport

A 2026-07-28 request is stricter than 2025. Three things are mandatory:

1. **`Accept: application/json, text/event-stream`** — both. The server picks
   per response whether to answer with JSON or upgrade to a stream; sending
   only JSON earns a `406`.
2. **A full `_meta` envelope on every request** — `protocolVersion`,
   `clientInfo`, `clientCapabilities`. A missing key is a `-32602` naming it.
3. **`Mcp-Method`, plus `Mcp-Name` for `tools/call`** (SEP-2243) — and they
   must agree with the body. These exist so load balancers and rate limiters
   can route and meter on the operation without parsing JSON-RPC.

```bash
curl -sS localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-method: tools/list' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientInfo":{"name":"curl","version":"1.0"},
        "io.modelcontextprotocol/clientCapabilities":{}}}}'
```

Clients still speaking 2025 keep working: `plugins/mcp.ts` sets
`legacy: "stateless"`, so they are served per-request from the same factory.
Set `legacy: "reject"` to go modern-only.

## Authorization

`AUTH_MODE=jwt` turns `/mcp` into an OAuth 2.1 Resource Server:

- Unauthenticated calls get `401` with
  `WWW-Authenticate: Bearer ... resource_metadata="…"`.
- That URL serves an RFC 9728 document at
  `/.well-known/oauth-protected-resource/mcp`, unauthenticated — it is how a
  client discovers which authorization server to use.
- `/health` and `/ready` stay open so orchestrators can probe without a token.

Swap `lib/token-verifier.ts` for introspection or a vendor SDK; it is a
one-method interface.

> **Gotcha worth knowing:** the SDK rejects any token whose
> `AuthInfo.expiresAt` is unset — silently, as a plain `401`. Both shipped
> verifiers populate it from the JWT `exp` claim.

`env.ts` refuses to boot with `AUTH_MODE=none` when `NODE_ENV=production`, so
an unauthenticated production deploy cannot happen by configuration alone.

## Testing

| Layer                    | Mechanism                                                                      |
| ------------------------ | ------------------------------------------------------------------------------ |
| Service                  | Plain unit test — no MCP involved                                              |
| Tool / resource / prompt | `test/harness.ts`: a real `Client` ↔ real `McpServer` over `InMemoryTransport` |
| HTTP                     | `app.inject()` — full stack, no socket                                         |
| stdio                    | Real subprocess, asserting stdout purity                                       |

Scaffold-level guarantees under test: the factory does no I/O; stdout carries
only protocol bytes; `/ready` returns 503 when a dependency is down; cache
hints are emitted; DNS-rebinding protection rejects bad Host/Origin; the 401
challenge is discoverable; a second instance serves a call the first never saw.

## Adding a module

1. `cp -r src/modules/example src/modules/<name>` and rename.
2. Write schemas first — everything else derives from them.
3. Keep the service free of SDK imports.
4. Add one line to `src/mcp/capabilities.ts`.

Both transports pick it up automatically.

## Notes on versions

- **The SDK is pinned to exact `2.0.0-beta.5`, deliberately.** v2 is in beta and
  the API is still settling. `@modelcontextprotocol/fastify` publishes a
  `latest` tag that lags its siblings, so a caret range silently mixes versions.
  `npm run sdk:check` surfaces the GA bump.
- SDK types are confined to `mcp/`, `entrypoints/`, `plugins/mcp.ts`,
  `lib/define-tool.ts` and `lib/errors.ts`. Services and repositories import
  nothing from the SDK, so a v2 API change has a small blast radius.
- **TypeScript is pinned to 6.0.3**, not 7.x: `typescript-eslint` supports
  `<6.1.0`, and a supported dependency graph beats a forced install. `types: ["node"]` is required either way — TS 6 no longer auto-includes `@types/*`
  and the SDK's `.d.mts` references `Buffer`.
- `@modelcontextprotocol/node` peer-depends on `hono` even under Fastify. It is
  a transitive requirement of the adapter, not a stray dependency.
