import {
  defineTool,
  type Registerable,
  type ToolContext,
} from "@/lib/define-tool.js";
import {
  AwaitInput,
  AwaitOutput,
  ProceedInput,
  ProceedOutput,
  RestartFlowInput,
  RestartFlowOutput,
  StartFlowInput,
  StartFlowOutput,
  FlowStatusInput,
  FlowStatusOutput,
  type FlowStepState,
  type RunSummary,
  type StepOutcome,
} from "@/modules/flow/flow.schema.js";
import type { FlowService } from "@/modules/flow/flow.service.js";
import { eventsFor, renderEvents } from "@/modules/record/record.tool.js";
import type { RecordService } from "@/modules/record/record.service.js";

/**
 * The protocol edge of the loop — no business rules, no data access.
 *
 * `render` earns its keep here more than anywhere else in the server. These are
 * the tools a model calls dozens of times in a row, and what it reads back is
 * what decides whether it makes the next call correctly. So every outcome ends
 * in a sentence naming the tool to reach for, and the status view is laid out
 * as a sequence you can scan rather than a list of objects you have to parse.
 */

const STATUS_MARK: Record<FlowStepState["status"], string> = {
  COMPLETE: "✓",
  LISTENING: "…",
  RESPONDING: "→",
  WAITING: " ",
  "INPUT-REQUIRED": "?",
  PROCESSING: "~",
  "WAITING-SUBMISSION": "⇢",
};

export function renderOutcome(outcome: StepOutcome): string {
  const lines = [`[${outcome.outcome}] ${outcome.message}`];

  if (outcome.payload_id !== undefined) {
    lines.push(`  payload: ${outcome.payload_id}`);
  }
  if (outcome.ack !== undefined) {
    lines.push(
      `  ack: ${outcome.ack}${outcome.http_status !== undefined ? ` (HTTP ${String(outcome.http_status)})` : ""}`,
    );
  }
  if (outcome.ack === "NACK" || outcome.ack === "UNPARSEABLE") {
    lines.push(`  body: ${JSON.stringify(outcome.ack_body)}`);
  }
  if (outcome.inputs_required !== undefined) {
    lines.push(`  needs: ${JSON.stringify(outcome.inputs_required)}`);
  }
  if (outcome.form_url !== undefined) {
    lines.push(`  form: ${outcome.form_url}`);
  }
  // Said plainly rather than left in `details`: a patched step is the one thing
  // in a run that a compliance report has to caveat, and the model narrating
  // that run should not have to go looking for it.
  if (outcome.overrides !== undefined && outcome.overrides.length > 0) {
    lines.push(`  patched: ${outcome.overrides.join(", ")}`);
  }
  if (outcome.override_problems !== undefined) {
    lines.push(
      ...outcome.override_problems.map(
        (problem) => `  override refused: ${problem.path} — ${problem.reason}`,
      ),
    );
  }
  if (outcome.details !== undefined) {
    lines.push(`  details: ${JSON.stringify(outcome.details)}`);
  }

  return lines.join("\n");
}

export function renderStep(step: FlowStepState): string {
  const mark = STATUS_MARK[step.status];
  const who = step.actor === "mock" ? "us" : step.actor === "np" ? "np" : "??";
  const suffix =
    step.ack === "NACK"
      ? "  ← NACKed"
      : step.unsolicited
        ? "  (unsolicited)"
        : "";
  return `  ${mark} ${step.action.padEnd(18)} ${who}  ${step.key}${suffix}`;
}

/**
 * Where every run stands, for a wait that named none of them.
 *
 * Ordered by how much they want attention, not by flow id: a session-scope wait
 * ends with the model choosing what to do next, and the choice should be the
 * first thing it reads rather than something it has to hunt for.
 */
export function renderRuns(runs: RunSummary[]): string[] {
  if (runs.length === 0) return ["no runs open in this session — call flow_start"];

  const rank: Record<string, number> = {
    INPUT_REQUIRED: 0,
    FORM_PENDING: 1,
    READY: 2,
    BLOCKED: 3,
    WAITING: 4,
    COMPLETE: 5,
  };
  const ordered = [...runs].sort(
    (a, b) => (rank[a.outcome] ?? 9) - (rank[b.outcome] ?? 9),
  );

  return [
    "runs in this session:",
    ...ordered.map(
      (run) =>
        `  ${run.outcome.padEnd(15)} ${run.flow_id}` +
        `${run.attempt > 1 ? ` (attempt ${String(run.attempt)})` : ""} — ${run.message}`,
    ),
  ];
}

export function renderStatus(status: FlowStatusOutput): string {
  const lines = [
    `flow ${status.flow_id} · txn ${status.transaction_id ?? "unassigned"} · ${status.flow_status}`,
    `  mock plays ${status.mock_role} · attempt ${String(status.attempt)} · seq ${String(status.seq)}`,
    "",
    ...status.sequence.map(renderStep),
  ];

  if (status.abandoned) {
    lines.push(
      "",
      `abandoned: attempt ${String(status.abandoned.attempt)} was written off at ${status.abandoned.at}` +
        `${status.abandoned.reason !== undefined ? ` — ${status.abandoned.reason}` : ""}`,
      "  kept as evidence; the run has moved on to a later attempt.",
    );
  }

  if (status.extra_steps.length > 0) {
    lines.push("", "extra steps:", ...status.extra_steps.map(renderStep));
  }
  if (status.missed_steps.length > 0) {
    lines.push(
      "",
      "off-sequence exchanges (compliance findings):",
      ...status.missed_steps.map(
        (step) => `  ! ${step.action} — ${step.reason}`,
      ),
    );
  }
  if (status.reference_data_keys.length > 0) {
    lines.push("", `forms resolved: ${status.reference_data_keys.join(", ")}`);
  }
  if (status.attention) {
    lines.push("", `attention: ${status.attention.message}`);
  }

  lines.push("", renderOutcome(status.next), ...renderEvents(status.events));
  return lines.join("\n");
}

export interface FlowToolOptions {
  /** Ceiling on one blocking wait, from `AWAIT_MAX_WAIT_MS`. */
  maxAwaitMs: number;
}

/** How often a parked `flow_await` tells the client it is still waiting. */
const AWAIT_HEARTBEAT_MS = 10_000;

/**
 * How long `flow_await` blocks when the caller names no timeout.
 *
 * Well under `AWAIT_MAX_WAIT_MS`, which stays the ceiling an explicit
 * `timeout_ms` is clamped to. See the handler for why the two differ.
 */
const DEFAULT_AWAIT_MS = 60_000;

/**
 * Keep a long wait alive in the client.
 *
 * A wait measured in minutes outlives most MCP clients' own tool-call timeout,
 * and a client that gives up mid-wait loses the callback it was waiting for.
 * The protocol's answer is a progress notification: a client that asked for
 * progress — by sending a `progressToken` — resets its timer on every one. No
 * token means nothing is listening, so nothing is sent.
 *
 * Returns the stop function; it is safe to call more than once.
 */
function startAwaitHeartbeat(
  tools: ToolContext,
  timeoutMs: number,
): () => void {
  const token = tools.ctx.mcpReq._meta?.["progressToken"];
  if (token === undefined) {
    return () => {
      /* nothing to stop */
    };
  }

  // Thirds of a short wait, so a wait configured below the heartbeat still
  // announces itself at least twice — which is what makes this testable
  // without a test that has to sit for ten seconds.
  const every = Math.min(
    AWAIT_HEARTBEAT_MS,
    Math.max(50, Math.floor(timeoutMs / 3)),
  );
  const started = Date.now();
  const timer = setInterval(() => {
    void tools.ctx.mcpReq
      .notify({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress: Date.now() - started,
          total: timeoutMs,
          message: "waiting for the participant to call back",
        },
      })
      // A transport that has gone away is not this tool's problem: the wait is
      // still valid, and failing to announce it must not fail the call.
      .catch(() => {
        /* ignored */
      });
  }, every);

  // A heartbeat must never be the reason a stdio process refuses to exit.
  timer.unref?.();
  return () => {
    clearInterval(timer);
  };
}

export function createFlowTools(
  service: FlowService,
  records: RecordService,
  options: FlowToolOptions,
): Registerable[] {
  return [
    defineTool({
      name: "flow_start",
      title: "Start a flow",
      description:
        "Open a run of one flow and report what its first step needs. " +
        "Returns the callback URL the participant under test must be able to " +
        "reach — every payload this server sends advertises it as bap_uri or " +
        "bpp_uri, so a participant that cannot reach it will never call back. " +
        "Fails immediately if the flow has no mock config or any step with no " +
        "owner, so a flow that cannot be driven is rejected before anything is " +
        "sent. `transaction_id` comes back null: it belongs to whoever sends " +
        "the flow's first action, so when that is the participant it is theirs " +
        "to choose and does not exist yet. Drive the run by flow_id with " +
        "flow_proceed and flow_await, which report the id once it exists.",
      inputSchema: StartFlowInput,
      outputSchema: StartFlowOutput,
      annotations: {
        // Creates a transaction and may put a payload on the wire.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      render: (output) =>
        [
          `flow ${output.flow_id} started`,
          `  transaction: ${
            output.transaction_id ??
            "not yet — minted by whoever sends the first action"
          }`,
          `  mock plays:  ${output.mock_role}`,
          `  callback:    ${output.callback_url}`,
          `  auto-advance: ${output.auto_advance ? "on" : "off"}`,
          "",
          renderOutcome(output.outcome),
          ...renderEvents(output.events),
        ].join("\n"),
      handler: async (input) => {
        const { runtime, outcome, autoAdvance } = await service.start({
          sessionId: input.session_id,
          flowId: input.flow_id,
          transactionId: input.transaction_id,
          autoAdvance: input.auto_advance,
        });

        return {
          session_id: input.session_id,
          transaction_id: runtime.bound ? runtime.record.transactionId : null,
          flow_id: input.flow_id,
          mock_role: runtime.session.mock_role,
          callback_url: service.callbackUrl(runtime.session),
          auto_advance: autoAdvance,
          attempt: runtime.binding.attempt,
          outcome,
          // Present only for a resumed run: a fresh one has no transaction and
          // therefore no cursor, and `flow_await` should be called without one.
          ...(runtime.bound ? { seq: runtime.record.seq } : {}),
          ...(await eventsFor(records, input.session_id)),
        };
      },
    }),

    defineTool({
      name: "flow_restart",
      title: "Restart a flow",
      description:
        "Abandon this run's current attempt and open a fresh one of the same " +
        "flow, in the same session. Use it when a run has gone wrong and you " +
        "want another go: a flow's state is derived by replaying what was " +
        "exchanged, so a NACKed step or an out-of-sequence callback stays part " +
        "of the history and flow_start would only resume it. " +
        "**Nothing recorded is destroyed** — the abandoned attempt keeps its " +
        "payloads and stays readable with record_get_payload, because a failed " +
        "attempt is a compliance finding, not a mistake to erase. The new " +
        "attempt starts unbound: transaction_id comes back null and the next " +
        "action mints a fresh one. Prefer this over creating a second session; " +
        "an abandoned session keeps competing for the participant's callbacks " +
        "on the endpoint every session shares.",
      inputSchema: RestartFlowInput,
      outputSchema: RestartFlowOutput,
      annotations: {
        // Rewrites the binding and may arm an expectation, but destroys no
        // recorded evidence and never puts a payload on the wire.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      render: (output) =>
        [
          `flow ${output.flow_id} restarted — attempt ${String(output.attempt)}`,
          `  abandoned:   ${
            output.abandoned_transaction_id ?? "nothing had been sent yet"
          }`,
          `  transaction: not yet — minted by whoever sends the first action`,
          `  mock plays:  ${output.mock_role}`,
          `  callback:    ${output.callback_url}`,
          `  auto-advance: ${output.auto_advance ? "on" : "off"}`,
          "",
          renderOutcome(output.outcome),
          ...renderEvents(output.events),
        ].join("\n"),
      handler: async (input) => {
        const result = await service.restart({
          sessionId: input.session_id,
          flowId: input.flow_id,
          reason: input.reason,
        });

        return {
          session_id: input.session_id,
          // Always null: a restarted run is unbound by definition.
          transaction_id: null,
          abandoned_transaction_id: result.abandonedTransactionId,
          flow_id: input.flow_id,
          mock_role: result.runtime.session.mock_role,
          callback_url: service.callbackUrl(result.runtime.session),
          auto_advance: result.autoAdvance,
          attempt: result.attempt,
          outcome: result.outcome,
          ...(await eventsFor(records, input.session_id)),
        };
      },
    }),

    defineTool({
      name: "flow_get_status",
      title: "Get flow status",
      description:
        "Where a run has got to: every step with its status and who owes it, " +
        "any exchanges that arrived off-sequence, and what the loop needs " +
        "next. State is derived from the recorded exchanges on every call, so " +
        "this is always current. Name the run by flow_id (or transaction_id " +
        "once it has one). Read it whenever you lose track; `next` says " +
        "exactly which tool to call.",
      inputSchema: FlowStatusInput,
      outputSchema: FlowStatusOutput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      render: renderStatus,
      handler: async (input) => ({
        ...(await service.status(input.session_id, {
          transactionId: input.transaction_id,
          flowId: input.flow_id,
        })),
        ...(await eventsFor(records, input.session_id)),
      }),
    }),

    defineTool({
      name: "flow_proceed",
      title: "Advance the flow",
      description:
        "The loop driver. Takes the next step this mock owns, checks its " +
        "preconditions, generates its payload from the flow's own mock config, " +
        "and POSTs it to the participant — then records both the payload and " +
        "whatever the step saved for later steps. " +
        "If the step needs values it comes back INPUT_REQUIRED with the " +
        "declarations; call again with `inputs`. If the next move is the " +
        "participant's it comes back WAITING; call flow_await. Pass " +
        "`dry_run: true` to generate and inspect a payload without sending it, " +
        "or `trigger_extra` to fire a named side-channel step. " +
        "When a step is blocked because the flow's own config generates a " +
        "non-compliant payload, `payload_overrides` patches the offending " +
        "fields so the run can continue instead of being abandoned. " +
        "Sending the flow's first action is what mints its transaction_id, " +
        "which the answer then reports.",
      inputSchema: ProceedInput,
      outputSchema: ProceedOutput,
      annotations: {
        // Puts real traffic on the wire against a third party, and re-running
        // it sends a second call rather than repeating the first.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      render: (output) =>
        [renderOutcome(output), ...renderEvents(output.events)].join("\n"),
      handler: async (input) => {
        const outcome = await service.proceed({
          sessionId: input.session_id,
          transactionId: input.transaction_id,
          flowId: input.flow_id,
          inputs: input.inputs,
          triggerExtra: input.trigger_extra,
          dryRun: input.dry_run,
          payloadOverrides: input.payload_overrides,
        });

        // The cursor for the `flow_await` this answer tells the caller to make.
        // Without it the only `seq` here is the session journal's, inside
        // `events` — a different counter, and passing it as `after_seq` parks
        // the wait somewhere no event on this run can reach.
        const seq = await service.runSeq(
          input.session_id,
          outcome.transaction_id,
        );

        return {
          ...outcome,
          ...(seq !== undefined ? { seq } : {}),
          ...(await eventsFor(records, input.session_id)),
        };
      },
    }),

    defineTool({
      name: "flow_await",
      title: "Wait for the participant",
      description:
        "Block until something happens, then report it. Two scopes: " +
        "**Name a flow_id (or transaction_id)** and it waits on that one run, " +
        "returning as soon as the participant calls back. Pass the top-level " +
        "`seq` from your last flow_start / flow_proceed / flow_await as " +
        "`after_seq` so nothing is seen twice — never `events.cursor` or an " +
        "`events[].seq`, which count session journal lines and would park the " +
        "wait past anything this run can do. Omit it and you wait for whatever " +
        "happens next. When the " +
        "participant sends the flow's first action this is where you learn the " +
        "transaction_id, because it was theirs to choose. " +
        "A run-scoped wait answers immediately with `waited: false` when the " +
        "next move is yours rather than theirs; `next` says what to call. " +
        "**Name neither** and it waits on the whole session: any callback on " +
        "any run, a step auto-advance sent, a refused call, a form submitted. " +
        "That is the one to use when you have nothing to do — it needs no seq " +
        "bookkeeping, and it comes back with `runs` telling you where every " +
        "flow stands. Narrow what wakes it with `kinds` / `flow_ids`; anything " +
        "filtered out is still reported, it just does not end the wait. " +
        "`timed_out: true` means nothing happened yet — call again. Always " +
        "prefer this over polling flow_get_status.",
      inputSchema: AwaitInput,
      outputSchema: AwaitOutput,
      annotations: {
        // Reads only — but it blocks, so it is not a free call to repeat.
        readOnlyHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      render: (output) => {
        const head =
          output.scope === "session"
            ? output.timed_out
              ? "nothing happened in this session — call flow_await again to keep watching"
              : "something happened in this session"
            : output.waited === false && output.timed_out
              ? "did not wait: this run is not expecting the participant to do " +
                "anything — see below for what it needs from you"
              : output.timed_out
                ? `nothing arrived (seq ${String(output.seq)}) — call flow_await again to keep waiting`
                : `${output.event?.kind ?? "EVENT"} ${output.event?.action ?? ""} (seq ${String(output.seq)})`;

        const detail =
          output.scope === "run" && !output.timed_out
            ? [
                ...(output.event?.payload_id !== undefined
                  ? [`  payload: ${output.event.payload_id}`]
                  : []),
                ...(output.event?.detail !== undefined
                  ? [`  ${output.event.detail}`]
                  : []),
              ]
            : [];

        // Loud, because it is a bug in the caller's bookkeeping and the symptom
        // it produces — a wait that reports nothing — looks exactly like a
        // participant that has gone quiet.
        const adjusted =
          output.after_seq_adjusted !== undefined
            ? [
                `  ! after_seq was ahead of this run (latest is ${String(
                  output.after_seq_adjusted,
                )}) and was ignored.`,
                "    Pass the `seq` from flow_proceed / flow_await, not `events.cursor`.",
              ]
            : [];

        return [
          head,
          ...detail,
          ...adjusted,
          ...renderEvents(output.events),
          ...(output.runs !== undefined ? ["", ...renderRuns(output.runs)] : []),
          ...(output.next !== undefined ? ["", renderOutcome(output.next)] : []),
        ].join("\n");
      },
      handler: async (input, tools) => {
        // Capped server-side by AWAIT_MAX_WAIT_MS: an unbounded wait would sit
        // past whatever the caller's own timeout is, and the model would never
        // learn whether anything arrived.
        //
        // The *default* is a minute rather than the cap, and that is a separate
        // decision from the cap itself. This pair is built to long-poll — every
        // outcome message says "call again" — so the cost of defaulting long is
        // paid entirely by mistakes: a wait issued on the wrong cursor, or on a
        // run that was never expecting anything, used to burn five minutes of
        // the operator's wall clock before saying so. It also keeps the window
        // clear of EXPECTATION_TTL_MS, which is itself five minutes.
        const timeoutMs = Math.min(
          input.timeout_ms ?? DEFAULT_AWAIT_MS,
          options.maxAwaitMs,
        );

        const stopHeartbeat = startAwaitHeartbeat(tools, timeoutMs);
        let result;
        try {
          result = await service.awaitEvent({
            sessionId: input.session_id,
            transactionId: input.transaction_id,
            flowId: input.flow_id,
            afterSeq: input.after_seq,
            timeoutMs,
            kinds: input.kinds,
            flowIds: input.flow_ids,
            // Naming a timeout is the caller saying it means to block. That is
            // the only way to sit on a run whose main sequence is done waiting
            // for an unsolicited extra step, which is otherwise indistinguishable
            // from the mistake of waiting on your own turn.
            waitAnyway: input.timeout_ms !== undefined,
          });
        } finally {
          stopHeartbeat();
        }

        return {
          timed_out: result.timedOut,
          scope: result.scope,
          transaction_id: result.transactionId,
          seq: result.seq,
          ...(result.event
            ? {
                event: {
                  seq: result.event.seq,
                  kind: result.event.kind,
                  ...(result.event.action !== undefined
                    ? { action: result.event.action }
                    : {}),
                  ...(result.event.payload_id !== undefined
                    ? { payload_id: result.event.payload_id }
                    : {}),
                  ...(result.event.detail !== undefined
                    ? { detail: result.event.detail }
                    : {}),
                },
              }
            : {}),
          ...(result.next !== undefined ? { next: result.next } : {}),
          ...(result.runs !== undefined ? { runs: result.runs } : {}),
          ...(result.afterSeqAdjusted !== undefined
            ? { after_seq_adjusted: result.afterSeqAdjusted }
            : {}),
          ...(result.waited !== undefined ? { waited: result.waited } : {}),
          // A session-scope wait drained the journal as its own exit condition,
          // so its delta comes back on the result; draining again here would
          // find nothing and lose the very events it blocked for. A run-scoped
          // wait has not drained, and does so now — after the wait, so the
          // callback it unblocked on is in the delta rather than one call late.
          ...(result.events !== undefined
            ? { events: result.events }
            : await eventsFor(records, input.session_id)),
        };
      },
    }),
  ];
}
