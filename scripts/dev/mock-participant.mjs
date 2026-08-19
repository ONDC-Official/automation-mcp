/**
 * A local counterparty, for driving a flow end to end without a real NP.
 *
 * This is the *other half* of the same published mock config. The MCP server
 * executes the steps its `mock_role` owns; this process executes the ones the
 * participant owns — same `generate`, same `saveData`, same sandbox — so the
 * traffic on the wire is what the flow's authors published rather than
 * something hand-written here.
 *
 * It is a development aid: no signing, no registry, and it trusts whatever it
 * is sent. Point a session's `subscriber_url` at it and run the loop.
 *
 *   node scripts/dev/mock-participant.mjs \
 *     --port 4010 \
 *     --callback http://127.0.0.1:3010/ONDC:TRV11/2.0.1/buyer \
 *     --domain ONDC:TRV11 --version 2.0.1 --usecase Metro \
 *     --flow STATION_CODE_FLOW_ORDER \
 *     --role BPP
 */

import { createServer } from "node:http";
import { MockRunner } from "@ondc/automation-mock-runner";
import jsonpath from "jsonpath";

/* ------------------------------- arguments ------------------------------- */

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(" ")
    .matchAll(/--([\w-]+)[= ]([^\s]+)/g)
    .map((m) => [m[1], m[2]]),
);

const PORT = Number(args.port ?? 4010);
const CALLBACK = (args.callback ?? "").replace(/\/+$/, "");
const ROLE = (args.role ?? "BPP").toUpperCase(); // the side *this* process plays
const FLOW = args.flow;
const BUILD = {
  domain: args.domain,
  version: args.version,
  usecase: args.usecase,
};
const CONFIG_SERVICE = (
  args["config-service"] ?? "https://workbench.ondc.tech/config-service"
).replace(/\/+$/, "");
const SELF_ID = args["subscriber-id"] ?? `mock-${ROLE.toLowerCase()}.local`;
const SELF_URI = args["subscriber-uri"] ?? `http://127.0.0.1:${String(PORT)}`;

if (!CALLBACK || !FLOW || !BUILD.domain || !BUILD.version || !BUILD.usecase) {
  console.error(
    "need --callback, --flow, --domain, --version and --usecase (see the header)",
  );
  process.exit(1);
}

const log = (...parts) => {
  console.error(`[participant] ${parts.join(" ")}`);
};

/* --------------------------------- config -------------------------------- */

const url = new URL(`${CONFIG_SERVICE}/mock/playground`);
for (const [k, v] of Object.entries({ ...BUILD, flowId: FLOW })) {
  url.searchParams.set(k, v);
}

const response = await fetch(url, { headers: { accept: "application/json" } });
if (!response.ok) {
  log(`config-service answered ${String(response.status)} for ${FLOW}`);
  process.exit(1);
}
const config = await response.json();
const steps = config.steps ?? [];
if (steps.length === 0) {
  log(`no steps in the config for ${FLOW}`);
  process.exit(1);
}

MockRunner.initSharedRunner({ allowedFetchBaseUrls: [] });
let runner;
try {
  runner = new MockRunner(config);
} catch {
  // Published configs do drift from the library's own schema; the per-step
  // JavaScript is unaffected, which is the part that matters here.
  runner = new MockRunner(config, true);
}

log(
  `playing ${ROLE} for ${FLOW} — ${String(steps.length)} steps,`,
  `${String(steps.filter((s) => s.owner === ROLE).length)} mine`,
);

/* ------------------------------ session data ------------------------------ */

/** transaction_id → {data, cursor} */
const runs = new Map();

const stateFor = (txn) => {
  let state = runs.get(txn);
  if (!state) {
    state = { data: {}, cursor: 0 };
    runs.set(txn, state);
  }
  return state;
};

/**
 * The workbench's `getUpdatedData`, in the shape the configs are written
 * against: every value is a *list*, five context paths are injected on every
 * save, `APPEND#` concatenates, `EVAL#` runs in the sandbox.
 */
async function save(state, payload, saveData) {
  const config = {
    ...(saveData && typeof saveData === "object" ? saveData : {}),
    latestMessage_id: "$.context.message_id",
    latestTimestamp: "$.context.timestamp",
    bapUri: "$.context.bap_uri",
    bppUri: "$.context.bpp_uri",
    bppId: "$.context.bpp_id",
    bapId: "$.context.bap_id",
  };

  for (const [key, path] of Object.entries(config)) {
    if (typeof path !== "string" || path.length === 0) continue;
    try {
      const append = key.startsWith("APPEND#");
      const evaluate = path.startsWith("EVAL#");
      const target = key.split("#").pop() ?? key;
      const expression = evaluate ? (path.split("#")[1] ?? "") : path;

      const value = evaluate
        ? (await MockRunner.runGetSave(payload, expression)).result
        : jsonpath.query(payload, expression);

      if (append) {
        const current = Array.isArray(state.data[target])
          ? state.data[target]
          : [];
        state.data[target] = [
          ...current,
          ...(Array.isArray(value) ? value : [value]),
        ];
      } else {
        state.data[target] = value;
      }
    } catch (error) {
      log(`skipped save key ${key}: ${String(error)}`);
    }
  }
}

const isEmpty = (value) =>
  value === undefined ||
  value === null ||
  (Array.isArray(value) && value.length === 0);

/**
 * Identity in the shape `generate` reads it — lists, always, because every
 * other value arrives through `saveData` and `jsonpath.query` returns a list.
 * Ours is authoritative; theirs is a fallback behind what their own payloads
 * have already told us.
 */
function sessionData(state, txn) {
  const ours =
    ROLE === "BPP"
      ? { bppId: [SELF_ID], bppUri: [SELF_URI] }
      : { bapId: [SELF_ID], bapUri: [SELF_URI] };

  return {
    ...state.data,
    ...ours,
    transaction_id: txn,
    transactionId: [txn],
  };
}

/* -------------------------------- the loop -------------------------------- */

/** Find the step this inbound call answers, from the cursor forward. */
function matchInbound(state, action) {
  for (let i = state.cursor; i < steps.length; i += 1) {
    if (steps[i].owner !== ROLE && steps[i].api === action) return i;
  }
  // Tolerate a repeat or a call we did not expect: match anywhere.
  return steps.findIndex((s) => s.owner !== ROLE && s.api === action);
}

async function send(state, txn, step) {
  const outcome = await runner.runGeneratePayloadWithSession(
    step.action_id,
    sessionData(state, txn),
  );

  if (!outcome.success) {
    log(`generate failed for ${step.action_id}: ${outcome.error?.message}`);
    for (const entry of outcome.logs ?? []) log(`  config: ${entry.message}`);
    return;
  }

  const payload = outcome.result;
  // Whoever sends addresses the payload; the config's own generate may not.
  payload.context ??= {};
  if (ROLE === "BPP") {
    payload.context.bpp_id ??= SELF_ID;
    payload.context.bpp_uri ??= SELF_URI;
  }

  await save(state, payload, step.mock?.saveData);

  const target = `${CALLBACK}/${step.api}`;
  try {
    const reply = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await reply.text();
    const status = body.includes('"NACK"') ? "NACK" : "ACK";
    log(
      `→ ${step.api} (${step.action_id}) ${String(reply.status)} ${status}` +
        (status === "NACK" ? ` ${body.slice(0, 300)}` : ""),
    );
  } catch (error) {
    log(`→ ${step.api} failed: ${String(error)}`);
  }
}

/** Send every step of ours that is now due, stopping at the other side's. */
async function advance(state, txn) {
  while (state.cursor < steps.length && steps[state.cursor].owner === ROLE) {
    const step = steps[state.cursor];
    state.cursor += 1;
    await send(state, txn, step);
  }
}

/* --------------------------------- server --------------------------------- */

const server = createServer((request, reply) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    void handle(request, reply, Buffer.concat(chunks).toString("utf8"));
  });
});

async function handle(request, reply, raw) {
  const action = (request.url ?? "/").split("?")[0].split("/").filter(Boolean).pop();

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    reply.writeHead(400, { "content-type": "application/json" });
    reply.end(
      JSON.stringify({
        message: { ack: { status: "NACK" } },
        error: { code: "40000", message: "unparseable body" },
      }),
    );
    return;
  }

  const txn = payload?.context?.transaction_id ?? "unknown";
  const state = stateFor(txn);
  const index = matchInbound(state, action);

  // ACK first: the caller's connection must not be held open for our own
  // outbound call. Everything after this runs with nobody waiting on it.
  reply.writeHead(200, { "content-type": "application/json" });
  reply.end(JSON.stringify({ message: { ack: { status: "ACK" } } }));

  log(
    `← ${action} txn=${txn.slice(0, 8)}` +
      (index >= 0 ? ` (${steps[index].action_id})` : " — no matching step"),
  );

  if (index < 0) return;

  state.cursor = index + 1;
  await save(state, payload, steps[index].mock?.saveData);
  await advance(state, txn);
}

server.listen(PORT, "127.0.0.1", () => {
  log(`listening on http://127.0.0.1:${String(PORT)} → callbacks to ${CALLBACK}`);
});

const shutdown = () => {
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
