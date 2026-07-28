/* eslint-disable no-console -- this module exists to *replace* console */
import { logger } from "@/lib/logger.js";

/**
 * Make stdout unreachable through `console`.
 *
 * `no-console` keeps *our* code off stdout, but it says nothing about our
 * dependencies. `@ondc/automation-mock-runner` in particular writes its own
 * diagnostics with `console.log` whenever `NODE_ENV=development` or `DEBUG` is
 * set (`utils/logger.ts`), and on stdio a single such line lands in the middle
 * of the JSON-RPC stream — the client then fails with a parse error that points
 * nowhere near the cause.
 *
 * Rather than trying to configure every dependency into silence, the stdio
 * entrypoint calls this **before loading anything else**, and the console
 * methods are rebound onto the pino logger, which is pinned to stderr. Output
 * is preserved, just moved to the channel that is allowed to carry it.
 *
 * Idempotent: calling it twice does not double-wrap.
 */

let installed = false;

/** Best-effort flattening of console's varargs into one message string. */
function format(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.stack ?? arg.message;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

export function guardStdout(): void {
  if (installed) return;
  installed = true;

  const child = logger.child({ source: "console" });

  console.log = (...args: unknown[]): void => {
    child.info(format(args));
  };
  console.info = (...args: unknown[]): void => {
    child.info(format(args));
  };
  console.debug = (...args: unknown[]): void => {
    child.debug(format(args));
  };
  console.warn = (...args: unknown[]): void => {
    child.warn(format(args));
  };
  console.error = (...args: unknown[]): void => {
    child.error(format(args));
  };
  console.trace = (...args: unknown[]): void => {
    child.trace(format(args));
  };
}
