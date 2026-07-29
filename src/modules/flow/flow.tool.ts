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
  StartFlowInput,
  StartFlowOutput,
  FlowStatusInput,
  FlowStatusOutput,
  type FlowStepState,
  type StepOutcome,
} from "@/modules/flow/flow.schema.js";
import type { FlowService } from "@/modules/flow/flow.service.js";

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

export function renderStatus(status: FlowStatusOutput): string {
  const lines = [
    `flow ${status.flow_id} · txn ${status.transaction_id} · ${status.flow_status}`,
    `  mock plays ${status.mock_role} · seq ${String(status.seq)}`,
    "",
    ...status.sequence.map(renderStep),
  ];

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

  lines.push("", renderOutcome(status.next));
  return lines.join("\n");
}

export interface FlowToolOptions {
  /** Ceiling on one blocking wait, from `AWAIT_MAX_WAIT_MS`. */
  maxAwaitMs: number;
}

/** How often a parked `flow_await` tells the client it is still waiting. */
const AWAIT_HEARTBEAT_MS = 10_000;

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
  options: FlowToolOptions,
): Registerable[] {
  return [
    defineTool({
      name: "flow_start",
      title: "Start a flow",
      description:
        "Open a transaction for one flow and report what its first step needs. " +
        "Returns the callback URL the participant under test must be able to " +
        "reach — every payload this server sends advertises it as bap_uri or " +
        "bpp_uri, so a participant that cannot reach it will never call back. " +
        "Fails immediately if the flow has no mock config or any step with no " +
        "owner, so a flow that cannot be driven is rejected before anything is " +
        "sent. Drive the flow from here with flow_proceed and flow_await.",
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
          `  transaction: ${output.transaction_id}`,
          `  mock plays:  ${output.mock_role}`,
          `  callback:    ${output.callback_url}`,
          `  auto-advance: ${output.auto_advance ? "on" : "off"}`,
          "",
          renderOutcome(output.outcome),
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
          transaction_id: runtime.record.transactionId,
          flow_id: input.flow_id,
          mock_role: runtime.session.mock_role,
          callback_url: service.callbackUrl(runtime.session),
          auto_advance: autoAdvance,
          outcome,
        };
      },
    }),

    defineTool({
      name: "flow_get_status",
      title: "Get flow status",
      description:
        "Where a transaction has got to: every step with its status and who " +
        "owes it, any exchanges that arrived off-sequence, and what the loop " +
        "needs next. State is derived from the recorded exchanges on every " +
        "call, so this is always current. Read it whenever you lose track; " +
        "`next` says exactly which tool to call.",
      inputSchema: FlowStatusInput,
      outputSchema: FlowStatusOutput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      render: renderStatus,
      handler: (input) =>
        service.status(input.session_id, input.transaction_id),
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
        "or `trigger_extra` to fire a named side-channel step.",
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
      render: renderOutcome,
      handler: (input) =>
        service.proceed({
          sessionId: input.session_id,
          transactionId: input.transaction_id,
          inputs: input.inputs,
          triggerExtra: input.trigger_extra,
          dryRun: input.dry_run,
        }),
    }),

    defineTool({
      name: "flow_await",
      title: "Wait for the participant",
      description:
        "Block until the participant under test calls back, then report what " +
        "arrived and what the loop needs next. Returns immediately if " +
        "something already arrived after `after_seq` — pass the `seq` from your " +
        "last call so nothing is seen twice and nothing is missed. " +
        "`timed_out: true` just means nothing happened yet; call again to keep " +
        "waiting. This is the tool to use instead of polling flow_get_status.",
      inputSchema: AwaitInput,
      outputSchema: AwaitOutput,
      annotations: {
        // Reads only — but it blocks, so it is not a free call to repeat.
        readOnlyHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      render: (output) => {
        if (output.timed_out) {
          return [
            `nothing arrived (seq ${String(output.seq)}) — call flow_await again to keep waiting`,
            "",
            renderOutcome(output.next),
          ].join("\n");
        }
        const event = output.event;
        return [
          `${event?.kind ?? "EVENT"} ${event?.action ?? ""} (seq ${String(output.seq)})`,
          ...(event?.payload_id !== undefined
            ? [`  payload: ${event.payload_id}`]
            : []),
          ...(event?.detail !== undefined ? [`  ${event.detail}`] : []),
          "",
          renderOutcome(output.next),
        ].join("\n");
      },
      handler: async (input, tools) => {
        // Capped server-side by AWAIT_MAX_WAIT_MS: an unbounded wait would sit
        // past whatever the caller's own timeout is, and the model would never
        // learn whether anything arrived.
        const timeoutMs = Math.min(
          input.timeout_ms ?? options.maxAwaitMs,
          options.maxAwaitMs,
        );

        const stopHeartbeat = startAwaitHeartbeat(tools, timeoutMs);
        let result;
        try {
          result = await service.awaitEvent({
            sessionId: input.session_id,
            transactionId: input.transaction_id,
            afterSeq: input.after_seq,
            timeoutMs,
          });
        } finally {
          stopHeartbeat();
        }

        return {
          timed_out: result.timedOut,
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
          next: result.next,
        };
      },
    }),
  ];
}
