import { defineTool, type Registerable } from "@/lib/define-tool.js";
import type { ProtocolService } from "@/modules/protocol/protocol.service.js";
import {
  DescribeActionInput,
  DescribeActionOutput,
  DescribeBuildInput,
  DescribeBuildOutput,
  ExplainRuleInput,
  ExplainRuleOutput,
  ListErrorCodesInput,
  ListErrorCodesOutput,
  NextActionsInput,
  NextActionsOutput,
  SearchFieldsInput,
  SearchFieldsOutput,
  SearchKnowledgeInput,
  SearchKnowledgeOutput,
} from "@/modules/protocol/protocol.schema.js";

/**
 * The reference tools.
 *
 * Every one takes a build **directly** — `domain` + `version` — with
 * `session_id` as a shorthand. That is the opposite of every catalog tool, and
 * deliberately so: those exist to drive a mock, and a session is the right
 * handle for that. These exist to answer a question, and the person asking is
 * usually building a participant rather than testing one. Making them open a
 * mock session first, against a counterparty they do not have, to read a
 * schema, would be the same "everything here is procedural" failure the module
 * was written to fix.
 */

const DEFAULT_INCLUDE: ("overview" | "flows")[] = ["overview"];

export function createProtocolTools(protocol: ProtocolService): Registerable[] {
  return [
    defineTool({
      name: "protocol_describe_build",
      title: "Describe an ONDC build",
      description:
        "What a domain/version actually is: the published business context, " +
        "its use-cases, every action it defines, which actions may open a " +
        "transaction, and how many error codes and validation rules it " +
        "publishes. Start here when the question is about the ONDC protocol " +
        "rather than about driving a mock — no session is needed.",
      inputSchema: DescribeBuildInput,
      outputSchema: DescribeBuildOutput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      render: (out) => {
        const lines = [
          `${out.domain} ${out.version}${out.title ? ` — ${out.title}` : ""}`,
          `use-cases: ${out.usecases
            .map((entry) => `${entry.usecase} (${entry.status})`)
            .join(", ")}`,
          `actions (${String(out.actions.length)}): ${out.actions.join(" ")}`,
          `may open a transaction: ${out.may_start_with.join(", ")}`,
          `${String(out.error_code_count)} error codes · ${String(
            out.rule_count,
          )} published validation rules`,
        ];
        if (out.flows.length > 0) {
          lines.push(
            `flows (${String(out.flows.length)}, ${String(
              out.mandatory_flow_count,
            )} mandatory):`,
            ...out.flows.map(
              (flow) =>
                `  ${flow.flow_id}${
                  flow.tags.length > 0 ? ` [${flow.tags.join(",")}]` : ""
                }`,
            ),
          );
        }
        if (out.error_codes !== undefined) {
          lines.push(
            "",
            "error codes:",
            ...out.error_codes.map(
              (code) =>
                `  ${code.code.padEnd(7)} ${code.sent_by.padEnd(9)}${code.event}`,
            ),
          );
        }
        if (out.recent_changes !== undefined) {
          lines.push(
            "",
            `recent changes in this build's draft branch (${String(out.recent_changes.length)}) — not a migration guide:`,
            ...out.recent_changes
              .slice(0, 20)
              .map((change) => `  ${change.kind}: ${change.summary}`),
          );
        }
        if (out.overview !== undefined) lines.push("", out.overview);
        lines.push(
          "",
          out.note,
          "Call protocol_next_actions to see the graph itself.",
        );
        return lines.join("\n");
      },
      handler: async (input) =>
        protocol.describeBuild(input, input.include ?? DEFAULT_INCLUDE),
    }),

    defineTool({
      name: "protocol_next_actions",
      title: "What may legitimately happen next",
      description:
        "Every action the spec permits after a given one, from the build's " +
        "published action graph — with the ones that may repeat, the ones " +
        "that arrive unsolicited, and the earlier actions each must echo its " +
        "values from. Use this whenever you are about to assume what comes " +
        "next: a flow is one scripted path through this graph, not the graph.",
      inputSchema: NextActionsInput,
      outputSchema: NextActionsOutput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      render: (out) => {
        if (out.terminal) {
          return `${out.domain} ${out.version}: the spec publishes nothing after ${
            out.after ?? "the start of a transaction"
          }.`;
        }
        const lines = [
          `After ${out.after ?? "(start of transaction)"} — ${out.domain} ${
            out.version
          }:`,
          ...out.next.map((entry) => {
            const marks = [
              entry.repeatable ? "repeats" : undefined,
              entry.unsolicited ? "unsolicited" : undefined,
              entry.answers !== undefined
                ? `answers ${entry.answers}`
                : undefined,
              entry.must_echo.length > 0
                ? `echoes ${entry.must_echo.join("/")}`
                : undefined,
            ].filter((mark): mark is string => mark !== undefined);
            return `  ${entry.action}${
              marks.length > 0 ? `  (${marks.join("; ")})` : ""
            }`;
          }),
          "",
          out.note,
        ];
        return lines.join("\n");
      },
      handler: async (input) =>
        protocol.nextActions(input, input.after ?? null),
    }),

    defineTool({
      name: "protocol_describe_action",
      title: "Describe one action",
      description:
        "What one action's payload must contain: each field's meaning, which " +
        "side populates it, whether it is required, and its allowed values — " +
        "plus the earlier actions it must echo. Ask for include: ['rules'] to " +
        "see the validation rules that will be applied to it. Large actions " +
        "publish hundreds of fields, so narrow with path_prefix or max_depth " +
        "rather than raising limit.",
      inputSchema: DescribeActionInput,
      outputSchema: DescribeActionOutput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      render: (out) => {
        const lines = [
          `${out.domain} ${out.version}${out.usecase ? ` / ${out.usecase}` : ""} — ${out.action}${
            out.owner ? ` (mostly populated by ${out.owner})` : ""
          }`,
        ];
        if (out.answers !== undefined) lines.push(`answers: ${out.answers}`);
        if (out.must_echo.length > 0) {
          lines.push(
            `must echo values from: ${out.must_echo.join(", ")} — read them back, never reuse a value from another run`,
          );
        }
        if (out.legal_next.length > 0) {
          lines.push(`legal next: ${out.legal_next.join(", ")}`);
        }
        if (out.fields !== undefined) {
          lines.push(
            "",
            `fields ${String(out.fields.returned)} of ${String(out.fields.total)}${
              out.fields.truncated
                ? " (truncated — narrow with path_prefix)"
                : ""
            }`,
            ...out.fields.items.map((field) => {
              const mark = field.required ? "R" : " ";
              const owner = field.owner ? ` ${field.owner}` : "";
              const type = field.type ? ` ${field.type}` : "";
              const info = field.info ? ` — ${field.info}` : "";
              const values =
                field.enums !== undefined
                  ? `  [${field.enums.map((e) => e.code).join(", ")}${
                      field.enum_total !== undefined
                        ? `, +${String(field.enum_total - field.enums.length)} more`
                        : ""
                    }]`
                  : "";
              return `  ${mark} ${field.path}${type}${owner}${info}${values}`;
            }),
          );
        }
        if (out.rules !== undefined) {
          lines.push(
            "",
            `rules ${String(out.rules.returned)} of ${String(out.rules.total)}`,
            ...out.rules.items.map(
              (rule) =>
                `  ${rule.name}${rule.description ? ` — ${rule.description}` : ""}`,
            ),
          );
        }
        if (out.schema !== undefined) {
          lines.push("", `JSON Schema: ${out.schema.resource_uri}`);
        }
        return lines.join("\n");
      },
      handler: async (input) => protocol.describeAction(input),
    }),

    defineTool({
      name: "protocol_search_fields",
      title: "Find a field across a build",
      description:
        "Search every action's fields by path, enum value or meaning — " +
        "'where does ONDC expect a GSTIN', 'which actions carry " +
        "fulfillment.stops'. Use this when you do not yet know which action " +
        "to ask about.",
      inputSchema: SearchFieldsInput,
      outputSchema: SearchFieldsOutput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      render: (out) => {
        if (out.total === 0) return `Nothing matched "${out.query}".`;
        return [
          `${String(out.returned)} of ${String(out.total)} fields matching "${out.query}"`,
          ...out.hits.map(
            (hit) =>
              `  ${hit.required ? "R" : " "} ${hit.action.padEnd(12)} ${hit.path}${
                hit.info ? ` — ${hit.info}` : ""
              }`,
          ),
        ].join("\n");
      },
      handler: async (input) => protocol.searchFields(input),
    }),

    defineTool({
      name: "protocol_explain_rule",
      title: "Explain a validation rule or error code",
      description:
        "Look up what a validation rule actually checks, from the build's " +
        "published rule table. Takes a rule name, an ONDC error code, a " +
        "JSONPath, or a finding code exactly as payload_validate reported it " +
        "— you do not need to know which. A rule name can apply to several " +
        "actions, and all of them are returned.",
      inputSchema: ExplainRuleInput,
      outputSchema: ExplainRuleOutput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      render: (out) => {
        const lines = [
          `${out.query} (read as ${out.query_kind.replace("_", " ")}) — ${String(out.total)} match${
            out.total === 1 ? "" : "es"
          }`,
        ];
        if (out.error_code !== undefined) {
          lines.push(
            `${out.error_code.code}: ${out.error_code.event} — ${out.error_code.description} (raised by ${out.error_code.sent_by})`,
          );
        }
        for (const rule of out.matches) {
          lines.push(
            "",
            `${rule.action} · ${rule.name}${rule.scope ? `  scope ${rule.scope}` : ""}`,
            rule.description ?? "",
            rule.skip_if ? `  skipped when: ${rule.skip_if}` : "",
          );
        }
        if (out.truncated) {
          lines.push(
            "",
            `showing ${String(out.returned)}; per action: ${Object.entries(
              out.per_action,
            )
              .map(([action, count]) => `${action}=${String(count)}`)
              .join(" ")}`,
          );
        }
        if (out.note !== undefined) lines.push("", out.note);
        return lines.filter((line) => line !== "").join("\n");
      },
      handler: async (input) => protocol.explainRule(input),
    }),

    defineTool({
      name: "protocol_list_error_codes",
      title: "List a build's error codes",
      description:
        "Every ONDC error code this build publishes, with what it means, " +
        "which side raises it, and — where upstream says so — whether it " +
        "belongs in a synchronous NACK or in the error object of an " +
        "asynchronous callback.",
      inputSchema: ListErrorCodesInput,
      outputSchema: ListErrorCodesOutput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      render: (out) => {
        if (out.codes.length === 0) return "No error codes matched.";
        return [
          `${String(out.returned)} of ${String(out.total)} error codes — ${out.domain} ${out.version}`,
          ...out.codes.map(
            (code) =>
              `  ${code.code.padEnd(7)} ${code.sent_by.padEnd(9)}${
                code.used_in ? `${code.used_in.padEnd(14)}` : "".padEnd(14)
              }${code.event}${code.description ? ` — ${code.description}` : ""}`,
          ),
        ].join("\n");
      },
      handler: async (input) => protocol.listErrorCodes(input),
    }),

    defineTool({
      name: "protocol_search_knowledge",
      title: "How the ONDC network works",
      description:
        "The parts of ONDC that do not vary by build and that no spec " +
        "endpoint publishes. Two layers behind one query: this server's own " +
        "orientation notes (the ACK-then-callback contract, identity, " +
        "signing, the registry and gateway, why a flow is not the protocol) " +
        "and the knowledge base ONDC publishes — signing and key rotation, " +
        "onboarding and lookup, the gateway, TTL and idempotency, the " +
        "catalog model and serviceability, the order state machine, quotes, " +
        "payment terms, cancellation and returns, fulfillment states, " +
        "logistics, error and reason codes, and the Workbench. Use it for " +
        "'how does X work' rather than 'what fields does X have'. Pass a " +
        "`topic` with an empty `query` to read one document end to end.",
      inputSchema: SearchKnowledgeInput,
      outputSchema: SearchKnowledgeOutput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      render: (out) => {
        if (out.sections.length === 0) {
          return [
            `Nothing on "${out.query}".`,
            `Categories: ${out.categories.join(", ")}.`,
            out.topics ? `Topics: ${out.topics.join(", ")}.` : "",
          ]
            .filter((line) => line !== "")
            .join("\n");
        }

        const hits = out.sections.map((section) => {
          // The provenance line is what lets an answer be weighed: which
          // layer it came from, and how well sourced upstream says it is.
          const origin = [
            section.topic,
            section.category,
            section.status,
            section.tier === "core" ? "this server's own notes" : undefined,
          ]
            .filter((part) => part !== undefined && part !== "")
            .join(" · ");
          const cut = section.truncated
            ? `\n\n_(cut to fit — whole document at ondc://knowledge/${section.topic})_`
            : "";
          return `## ${section.title} — ${section.heading}\n_${origin}_\n\n${section.body}${cut}`;
        });

        // Said out loud, not left in structuredContent. A model that cannot
        // see what was withheld cannot ask for it.
        const footer = [
          `${String(out.returned)} of ${String(out.total)} matching sections`,
          out.elided > 0
            ? `${String(out.elided)} more dropped to fit the budget`
            : undefined,
          `notes reviewed ${out.as_of}`,
          `ONDC docs ${out.kb.as_of} @ ${out.kb.sha.slice(0, 7)}`,
        ]
          .filter((part) => part !== undefined)
          .join("; ");

        return [...hits, "", `(${footer})`].join("\n\n");
      },
      handler: (input) => Promise.resolve(protocol.searchKnowledge(input)),
    }),
  ];
}
