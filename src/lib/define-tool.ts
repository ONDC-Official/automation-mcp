import {
  BAGGAGE_META_KEY,
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
  type AuthInfo,
  type CallToolResult,
  type McpServer,
  type ServerContext,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
  type ToolCallback,
} from "@modelcontextprotocol/server";
import type { Logger } from "pino";
import { handleToolError } from "@/lib/errors.js";
import { requestLogger } from "@/lib/logger.js";

/**
 * The tool convention, expressed as a type so it cannot be skipped.
 *
 * Three rules are enforced here rather than by review:
 *
 * 1. **`inputSchema` and `outputSchema` are both required.** `outputSchema` is
 *    the MCP analogue of "every route declares a response schema" — it drives
 *    `structuredContent`, which is what makes a tool consumable by code rather
 *    than only by a model reading prose. A tool without one will not typecheck.
 * 2. **Handlers return domain data, not MCP envelopes.** The handler resolves
 *    with the value described by `outputSchema`; this module builds the
 *    `content` + `structuredContent` result around it. Tool authors never
 *    hand-assemble a `CallToolResult`, so they cannot forget half of it.
 * 3. **Errors route themselves.** Anything thrown goes through
 *    `handleToolError`, which sends business failures back as
 *    `isError: true` results and protocol faults as JSON-RPC errors.
 */

export interface ToolContext {
  /** Raw SDK context, for the rare handler that needs protocol details. */
  readonly ctx: ServerContext;
  /** Request-scoped logger, pre-tagged with tool name and trace context. */
  readonly logger: Logger;
  /** Verified auth, when the transport supplied it. Never set on stdio. */
  readonly authInfo: AuthInfo | undefined;
}

export interface ToolSpec<
  I extends StandardSchemaWithJSON,
  O extends StandardSchemaWithJSON,
> {
  /** Wire name, e.g. `example_get_item`. Stable; renaming breaks clients. */
  name: string;
  /** Short human-facing label shown in tool pickers. */
  title: string;
  /** What the tool does and when to reach for it. Written for a model. */
  description: string;
  inputSchema: I;
  outputSchema: O;
  /**
   * Behavioural hints for clients — `readOnlyHint`, `destructiveHint`,
   * `idempotentHint`, `openWorldHint`. Clients use these to decide what to
   * auto-approve, so set them honestly.
   */
  annotations?: ToolAnnotations;
  /**
   * Render structured output as text for the model. Both are always returned:
   * `structuredContent` for code, this string for the model.
   */
  render: (output: StandardSchemaWithJSON.InferOutput<O>) => string;
  handler: (
    input: StandardSchemaWithJSON.InferOutput<I>,
    tools: ToolContext,
  ) => Promise<StandardSchemaWithJSON.InferOutput<O>>;
}

/** A capability that knows how to attach itself to a server instance. */
export interface Registerable {
  readonly name: string;
  register(server: McpServer): void;
}

function traceFieldsFrom(ctx: ServerContext): Record<string, string> {
  const meta = ctx.mcpReq._meta;
  if (!meta) return {};

  const fields: Record<string, string> = {};
  const lift = (key: string, field: string): void => {
    const value = meta[key];
    if (typeof value === "string") fields[field] = value;
  };

  // W3C trace context, formalised for MCP in revision 2026-07-28. Lifting it
  // into the logger is what makes a tool call correlatable across services.
  lift(TRACEPARENT_META_KEY, "traceparent");
  lift(TRACESTATE_META_KEY, "tracestate");
  lift(BAGGAGE_META_KEY, "baggage");
  return fields;
}

/** The input keys worth correlating on, in the wire spelling logs now use. */
const CORRELATION_KEYS = ["session_id", "flow_id", "transaction_id"] as const;

/**
 * Join keys off a tool's input.
 *
 * By name, and that works because the names are already uniform across every
 * session-scoped tool — `session_id`, `flow_id`, `transaction_id`. One function
 * here correlates every tool's log lines without touching a single tool.
 *
 * The alternative was each handler remembering to tag its own logger, which is
 * a convention that holds right up until someone adds a tool.
 */
export function correlationFields(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null) return {};

  const source = input as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const key of CORRELATION_KEYS) {
    const value = source[key];
    if (typeof value === "string") fields[key] = value;
  }
  return fields;
}

export function defineTool<
  I extends StandardSchemaWithJSON,
  O extends StandardSchemaWithJSON,
>(spec: ToolSpec<I, O>): Registerable {
  return {
    name: spec.name,
    register(server: McpServer): void {
      // `ToolCallback<I>` is a conditional type over `I`. While `I` is still an
      // unresolved generic parameter TypeScript defers the conditional, so a
      // structurally-correct function isn't assignable to it. The cast is
      // confined to this one line; every tool author gets full inference.
      const callback = (async (
        input: StandardSchemaWithJSON.InferOutput<I>,
        ctx: ServerContext,
      ): Promise<CallToolResult> => {
        const logger = requestLogger({
          tool: spec.name,
          method: ctx.mcpReq.method,
          ...traceFieldsFrom(ctx),
          ...correlationFields(input),
        });

        const started = performance.now();
        try {
          const output = await spec.handler(input, {
            ctx,
            logger,
            authInfo: ctx.http?.authInfo,
          });

          logger.info(
            { durationMs: Math.round(performance.now() - started) },
            "tool call succeeded",
          );

          return {
            content: [{ type: "text", text: spec.render(output) }],
            structuredContent: output as Record<string, unknown>,
          };
        } catch (error) {
          logger.warn(
            { err: error, durationMs: Math.round(performance.now() - started) },
            "tool call failed",
          );
          // Routes to the correct channel, or re-throws for protocol faults.
          return handleToolError(error);
        }
      }) as ToolCallback<I>;

      server.registerTool(
        spec.name,
        {
          title: spec.title,
          description: spec.description,
          inputSchema: spec.inputSchema,
          outputSchema: spec.outputSchema,
          ...(spec.annotations ? { annotations: spec.annotations } : {}),
        },
        callback,
      );
    },
  };
}
