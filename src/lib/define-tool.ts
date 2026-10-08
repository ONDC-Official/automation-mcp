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

/**
 * What the server wants to know about a tool call, beyond its result.
 *
 * Optional, and passed at registration rather than declared per tool: the one
 * consumer is a module (`feedback`) that `src/lib` must not import, and the one
 * place that has both the container and the tool list is
 * `registerCapabilities`.
 */
export interface ToolHooks {
  /**
   * A tool returned keys its own `outputSchema` does not declare.
   *
   * They have already been dropped by the time this is called — see
   * `conformOutput`. Never throw from it and never keep the caller waiting:
   * this runs on the tool path.
   */
  onOutputDrift?(tool: string, paths: string[], sessionId?: string): void;
}

/** A capability that knows how to attach itself to a server instance. */
export interface Registerable {
  readonly name: string;
  register(server: McpServer, hooks?: ToolHooks): void;
}

/** Depth and node caps on the drift walk, matching `feedback.redact.ts`. */
const DRIFT_MAX_DEPTH = 12;
const DRIFT_MAX_NODES = 1_500;
/** Array elements walked per array. They share a shape; the first few tell it. */
const DRIFT_ARRAY_SAMPLE = 3;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The keys present in what the handler built and absent from what the schema
 * kept.
 *
 * Array indices collapse to `[]`, so a hundred items missing the same key are
 * one path rather than a hundred — which is also what keeps this usable as a
 * metrics label and as a dedupe signature.
 */
export function undeclaredPaths(original: unknown, parsed: unknown): string[] {
  const found = new Set<string>();
  let nodes = 0;

  const walk = (left: unknown, right: unknown, path: string, depth: number) => {
    if (depth > DRIFT_MAX_DEPTH || nodes > DRIFT_MAX_NODES) return;
    nodes += 1;

    if (Array.isArray(left) && Array.isArray(right)) {
      const limit = Math.min(left.length, right.length, DRIFT_ARRAY_SAMPLE);
      for (let i = 0; i < limit; i += 1) {
        walk(left[i], right[i], `${path}[]`, depth + 1);
      }
      return;
    }

    if (!isPlainObject(left) || !isPlainObject(right)) return;

    for (const [key, value] of Object.entries(left)) {
      const next = path === "" ? key : `${path}.${key}`;
      // An explicit `undefined` is dropped by JSON as well as by the parse, so
      // it is not drift — it never reaches the wire either way.
      if (!(key in right)) {
        if (value !== undefined) found.add(next);
        continue;
      }
      walk(value, right[key], next, depth + 1);
    }
  };

  walk(original, parsed, "", 0);
  return [...found];
}

/**
 * Send what the schema describes, not what the handler happened to build.
 *
 * The SDK server does validate tool output — and it validates it through the
 * *standard schema*, which for zod **strips** unknown keys rather than
 * refusing them, and then discards the stripped value and sends the original.
 * The client applies the published JSON Schema instead, which carries
 * `additionalProperties: false`, so an undeclared key is invisible here and
 * fatal there: `protocol_describe_action` shipped a `depth` key `ActionField`
 * did not declare, and every strict client rejected every non-empty result
 * while 1104 tests passed.
 *
 * So the parse runs here and its *value* is what goes out. The key set is
 * compared first, because a silent strip would fix the symptom and hide the
 * defect — an output schema and the object a handler builds are two spellings
 * of one shape, and nothing else notices when they stop agreeing.
 *
 * A validation failure is passed through untouched: the SDK raises the same
 * protocol error it raises today, and it says it better than we would.
 */
async function conformOutput<O extends StandardSchemaWithJSON>(
  schema: O,
  output: unknown,
  onDrift: (paths: string[]) => void,
): Promise<unknown> {
  const result = await schema["~standard"].validate(output);
  if (result.issues) return output;

  const paths = undeclaredPaths(output, result.value);
  if (paths.length > 0) onDrift(paths);
  return result.value;
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
    register(server: McpServer, hooks?: ToolHooks): void {
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
          // Who made the call: the Workbench user_id for a user key, or "apikey-client" for a fixed key.
          caller: ctx.http?.authInfo?.clientId,
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

          const conformed = (await conformOutput(
            spec.outputSchema,
            output,
            (paths) => {
              logger.warn(
                { paths },
                "tool output carried keys its outputSchema does not declare; " +
                  "they were dropped before sending",
              );
              hooks?.onOutputDrift?.(
                spec.name,
                paths,
                correlationFields(input).session_id,
              );
            },
          )) as StandardSchemaWithJSON.InferOutput<O>;

          logger.info(
            { durationMs: Math.round(performance.now() - started) },
            "tool call succeeded",
          );

          // Both halves are rendered from the same value. A text block
          // describing a key the structured half no longer carries is the
          // shape of this bug, one layer up.
          return {
            content: [{ type: "text", text: spec.render(conformed) }],
            structuredContent: conformed as Record<string, unknown>,
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
