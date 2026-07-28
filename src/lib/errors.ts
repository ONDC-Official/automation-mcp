import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  ProtocolError,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { config } from "@/config/env.js";

/**
 * MCP has **two** error channels and they are not interchangeable. Choosing
 * the wrong one is the most consequential mistake in an MCP server.
 *
 * The dividing question is **who can fix it**:
 *
 * | Failure                                     | Channel                    | Who acts |
 * |---------------------------------------------|----------------------------|----------|
 * | Bad arguments, not found, conflict, upstream | `{ isError: true }` result | The **model** — it reads the failure and retries differently. |
 * | Auth failure, unknown method                 | JSON-RPC error (`-32600`…) | The **client** — the model cannot obtain a token or invent a method. |
 *
 * Report a model-fixable failure as a protocol error and the model never learns
 * the call failed — it sees a transport fault and typically retries the
 * identical call forever.
 *
 * Note that argument validation sits on the **tool** channel. That is also what
 * the SDK does for `inputSchema` violations it catches itself (it answers with
 * `isError: true` and a description of the violation), and `example.tool.test.ts`
 * pins that behaviour. Classifying service-level validation the same way keeps
 * one coherent rule: a malformed call is always something the model can correct,
 * whether the schema caught it or a business rule did.
 *
 * Every error declares its own channel, and the two mapper functions below are
 * the only places that build wire-level error values.
 */

export type ErrorChannel = "protocol" | "tool";

export abstract class AppError extends Error {
  /** Stable machine-readable identifier, surfaced to callers. */
  abstract readonly code: string;
  /** Which MCP channel this failure belongs on. */
  abstract readonly channel: ErrorChannel;
  /** JSON-RPC code, only consulted for `channel: "protocol"`. */
  abstract readonly protocolCode: number;
  /**
   * Whether `message` is safe to show a caller in production. Unexpected
   * failures set this false so internals never leak.
   */
  readonly expose: boolean = true;

  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/* -------------------------------------------------------------------------- */
/* Protocol-channel errors — only the client can resolve these                 */
/* -------------------------------------------------------------------------- */

/** The caller is not authenticated, or the token is unusable. */
export class UnauthorizedError extends AppError {
  readonly code = "unauthorized";
  readonly channel = "protocol" as const;
  readonly protocolCode = INVALID_REQUEST;

  constructor(
    message = "Authentication required",
    details?: Record<string, unknown>,
  ) {
    super(message, details);
  }
}

/** Authenticated, but not permitted to do this. */
export class ForbiddenError extends AppError {
  readonly code = "forbidden";
  readonly channel = "protocol" as const;
  readonly protocolCode = INVALID_REQUEST;

  constructor(
    message = "Insufficient permissions",
    details?: Record<string, unknown>,
  ) {
    super(message, details);
  }
}

/* -------------------------------------------------------------------------- */
/* Tool-channel errors — the model can read these and adapt                    */
/* -------------------------------------------------------------------------- */

/**
 * Arguments were structurally valid but semantically wrong — a business rule
 * the JSON Schema could not express (mutually exclusive fields, a date range
 * that runs backwards, an id in the wrong namespace).
 *
 * Tool channel on purpose: this is the same class of mistake as a schema
 * violation, and the SDK answers those with `isError` so the model can correct
 * itself. Routing it anywhere else would make identical mistakes behave
 * differently depending on which layer noticed.
 */
export class ValidationError extends AppError {
  readonly code = "validation_error";
  readonly channel = "tool" as const;
  readonly protocolCode = INVALID_PARAMS;
}

/**
 * A requested entity does not exist.
 *
 * Deliberately a *tool* error: "no order with that id" is a legitimate answer
 * the model should read and act on, not a transport fault.
 */
export class NotFoundError extends AppError {
  readonly code = "not_found";
  readonly channel = "tool" as const;
  readonly protocolCode = INVALID_PARAMS;

  constructor(resource: string, id: string, details?: Record<string, unknown>) {
    super(`No ${resource} found with id "${id}".`, {
      resource,
      id,
      ...details,
    });
  }
}

/** The operation conflicts with current state (duplicate, version clash). */
export class ConflictError extends AppError {
  readonly code = "conflict";
  readonly channel = "tool" as const;
  readonly protocolCode = INVALID_REQUEST;
}

/** A dependency we call out to failed. The model may retry or degrade. */
export class UpstreamError extends AppError {
  readonly code = "upstream_error";
  readonly channel = "tool" as const;
  readonly protocolCode = INTERNAL_ERROR;

  constructor(
    service: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(`Upstream service "${service}" failed: ${message}`, {
      service,
      ...details,
    });
  }
}

/** An unexpected internal failure. Message is withheld in production. */
export class InternalFailure extends AppError {
  readonly code = "internal_error";
  readonly channel = "tool" as const;
  readonly protocolCode = INTERNAL_ERROR;
  override readonly expose = false;
}

/* -------------------------------------------------------------------------- */
/* Mapping to the wire                                                         */
/* -------------------------------------------------------------------------- */

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Normalise any thrown value into an `AppError`. */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value;
  const message = value instanceof Error ? value.message : String(value);
  const wrapped = new InternalFailure(message);
  if (value instanceof Error && value.stack !== undefined)
    wrapped.stack = value.stack;
  return wrapped;
}

/** What a caller is allowed to see. Withholds internals in production. */
function publicMessage(error: AppError): string {
  if (error.expose) return error.message;
  return config.NODE_ENV === "production"
    ? "An internal error occurred."
    : error.message;
}

/**
 * Build the JSON-RPC error to throw for a **protocol-channel** failure. The
 * SDK serialises a thrown `ProtocolError` into a proper JSON-RPC error object.
 */
export function toProtocolError(value: unknown): ProtocolError {
  const error = toAppError(value);
  return new ProtocolError(error.protocolCode, publicMessage(error), {
    code: error.code,
    ...(error.expose && error.details ? { details: error.details } : {}),
  });
}

/**
 * Build the `isError: true` result for a **tool-channel** failure.
 *
 * Carries both a `content` text block (what the model reads) and
 * `structuredContent` (what code reads), so the failure is legible to both.
 */
export function toToolResult(value: unknown): CallToolResult {
  const error = toAppError(value);
  const message = publicMessage(error);

  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: {
      error: {
        code: error.code,
        message,
        ...(error.expose && error.details ? { details: error.details } : {}),
      },
    },
  };
}

/**
 * Route a thrown value to whichever channel it declares.
 *
 * Tool-channel failures resolve to an `isError` result; protocol-channel
 * failures are re-thrown as `ProtocolError` for the SDK to serialise.
 */
export function handleToolError(value: unknown): CallToolResult {
  const error = toAppError(value);
  if (error.channel === "protocol") throw toProtocolError(error);
  return toToolResult(error);
}
