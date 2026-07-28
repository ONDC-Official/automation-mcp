import {
  destination,
  pino,
  stdTimeFunctions,
  type Logger,
  type LoggerOptions,
} from "pino";
import { config } from "@/config/env.js";

/**
 * Logging for an MCP server.
 *
 * ## Everything goes to stderr. Always.
 *
 * On the stdio transport, **stdout is the JSON-RPC channel**. A single stray
 * byte written to stdout corrupts the message stream and the client fails with
 * an opaque parse error, usually far from the cause. So this logger is pinned
 * to file descriptor 2 in every mode — there is no configuration that routes it
 * to stdout, and `no-console` is an ESLint error so nothing else can either.
 *
 * This also matches spec revision 2026-07-28, which deprecates the MCP
 * `logging` capability in favour of stderr for stdio and OpenTelemetry for HTTP.
 */

const STDERR_FD = 2;

const redact: LoggerOptions["redact"] = {
  paths: [
    "authorization",
    "Authorization",
    "headers.authorization",
    "headers.cookie",
    "req.headers.authorization",
    "req.headers.cookie",
    "*.password",
    "*.token",
    "*.accessToken",
    "*.access_token",
    "*.refreshToken",
    "*.refresh_token",
    "*.clientSecret",
    "*.client_secret",
    "*.apiKey",
    "*.api_key",
  ],
  censor: "[redacted]",
};

const base: LoggerOptions = {
  level: config.LOG_LEVEL,
  redact,
  formatters: {
    // Emit `"level":"info"` rather than `"level":30` so log processors don't
    // each need the pino level table.
    level: (label) => ({ level: label }),
  },
  timestamp: stdTimeFunctions.isoTime,
};

function createLogger(): Logger {
  if (config.NODE_ENV === "development") {
    try {
      return pino({
        ...base,
        transport: {
          target: "pino-pretty",
          options: {
            destination: STDERR_FD,
            colorize: true,
            translateTime: "HH:MM:ss.l",
          },
        },
      });
    } catch {
      // pino-pretty is a devDependency; fall through to raw JSON if absent.
    }
  }

  return pino(base, destination({ dest: STDERR_FD, sync: false }));
}

export const logger: Logger = createLogger();

/** Fields lifted from MCP `_meta` for cross-service correlation. */
export interface TraceContext {
  traceparent?: string | undefined;
  tracestate?: string | undefined;
  baggage?: string | undefined;
}

/**
 * Build a request-scoped child logger. Every log line emitted while serving a
 * request should come from one of these so entries correlate.
 */
export function requestLogger(
  fields: TraceContext & Record<string, unknown>,
): Logger {
  const defined = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
  return logger.child(defined);
}
