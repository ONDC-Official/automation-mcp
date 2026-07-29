import { defineTool, type Registerable } from "@/lib/define-tool.js";
import { ValidationError } from "@/lib/errors.js";
import { eventsFor, renderEvents } from "@/modules/record/record.tool.js";
import type { RecordService } from "@/modules/record/record.service.js";
import type { SessionService } from "@/modules/session/session.service.js";
import {
  ValidatePayloadInput,
  ValidatePayloadOutput,
  orderedFindings,
  type ValidationVerdict,
} from "@/modules/validate/validate.schema.js";
import {
  actionOf,
  type ValidateService,
} from "@/modules/validate/validate.service.js";

/**
 * The protocol edge for validation — no data access, no policy.
 *
 * `payload_validate` is the only *voluntary* way into the validator. The two
 * that matter more are involuntary: the gate inside `flow_proceed`, which stops
 * a malformed payload reaching the wire whether or not the model thought to
 * check, and the receiver, which judges what arrives. This tool exists for the
 * case those two cannot serve — inspecting a body before committing to it, or
 * asking why something was refused.
 */

/**
 * A verdict as the model reads it.
 *
 * The `unchecked` block is not decoration. A `valid` here means "valid as far as
 * the layers that ran" and today two of the four are unbuilt, so printing the
 * coverage next to the verdict is what stops it being read as a clean bill of
 * health for the whole protocol.
 */
export function renderVerdict(
  verdict: ValidationVerdict,
  action: string,
): string {
  const headline =
    verdict.status === "valid"
      ? `${action}: passed ${verdict.checked.join(" + ")}`
      : verdict.status === "invalid"
        ? `${action}: REJECTED — ${String(verdict.findings.length)} finding${
            verdict.findings.length === 1 ? "" : "s"
          }`
        : `${action}: no verdict — nothing could be checked`;

  const findings = orderedFindings(verdict.findings).map((finding) => {
    const guard =
      finding.skip_if !== undefined
        ? `\n      would not apply if: ${finding.skip_if}`
        : "";
    return `  • [${finding.layer}] ${finding.code}\n      at ${finding.json_path}\n      ${finding.message}${guard}`;
  });

  const unchecked = verdict.unchecked.map(
    (entry) => `  · ${entry.layer} — ${entry.reason}`,
  );

  return [
    headline,
    ...(findings.length > 0 ? ["", ...findings] : []),
    ...(unchecked.length > 0 ? ["", "not checked:", ...unchecked] : []),
    ...(verdict.docs_url !== undefined
      ? ["", `all rules for this build: ${verdict.docs_url}`]
      : []),
  ].join("\n");
}

export function createValidateTools(
  validate: ValidateService,
  sessions: SessionService,
  records: RecordService,
): Registerable[] {
  return [
    defineTool({
      name: "payload_validate",
      title: "Validate a payload",
      description:
        "Check a protocol payload against the ONDC spec for this session's " +
        "build, without sending it anywhere. Runs L0 (JSON Schema) and L1 " +
        "(the spec's contextual rules); every failure comes back with a rule " +
        "code and a JSONPath. Use it to inspect a body before committing to " +
        "it, or to understand a refusal. Note that `flow_proceed` already " +
        "gates what it sends, so this is not a required step in the loop. " +
        "A `valid` verdict only covers the layers listed in `checked`.",
      inputSchema: ValidatePayloadInput,
      outputSchema: ValidatePayloadOutput,
      annotations: {
        // Genuinely read-only: nothing is recorded, and the oracle it calls has
        // no side effects of its own — no proxying, no state, no session. This
        // is the honest opposite of `flow_proceed`.
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      async handler({ session_id, payload, action }) {
        const session = await sessions.requireSession(session_id);

        const resolved = action ?? actionOf(payload);
        if (resolved === undefined) {
          // Tool channel: the model can fix this by naming the action or by
          // fixing the payload's context, and both are one retry away.
          throw new ValidationError(
            "This payload has no context.action, so there is nothing to say " +
              "which schema and rules apply. Pass `action` explicitly, or fix " +
              "the payload's context.",
            { session_id },
          );
        }

        const verdict = await validate.validate({
          domain: session.build.domain,
          version: session.build.version,
          action: resolved,
          payload,
          // Nothing about a payload the model is inspecting has crossed the
          // wire, so it is judged as something we would send.
          direction: "outbound",
          session,
        });

        return {
          ...verdict,
          action: resolved,
          ...(await eventsFor(records, session_id)),
        };
      },
      render: (output) =>
        [
          renderVerdict(output, output.action),
          ...renderEvents(output.events),
        ].join("\n"),
    }),
  ];
}
