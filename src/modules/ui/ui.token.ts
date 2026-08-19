import { randomUUID, timingSafeEqual } from "node:crypto";

/**
 * The viewer's credential.
 *
 * ## Why there is always one
 *
 * `METRICS_TOKEN` may be absent and the endpoint is then served in the clear,
 * because what it publishes is counters. This surface publishes **payload
 * bodies** — the participant's real transaction data — and under stdio it rides
 * the standalone receiver, which binds `0.0.0.0` on purpose so a third party
 * can reach it. "Unset" therefore has to mean *a token you did not choose*, not
 * *no token*: the link carries it either way, so a minted one costs the operator
 * nothing and closes the case where somebody runs this on a shared network
 * without thinking about it.
 *
 * The trade is that a minted token changes when the process does, so every link
 * handed out before a restart stops working. That is the right shape for a
 * laptop and the wrong shape for a deployment, which is why `env.ts` refuses to
 * boot production without an explicit `UI_TOKEN`.
 */

export interface ViewerToken {
  readonly value: string;
  /** True when the operator chose it, false when this process invented one. */
  readonly configured: boolean;
  /** Constant-time check of whatever a request presented. */
  accepts(presented: string | undefined): boolean;
}

export function createViewerToken(configured: string | undefined): ViewerToken {
  const value = configured ?? randomUUID();
  return {
    value,
    configured: configured !== undefined,
    accepts: (presented) => matches(presented, value),
  };
}

/**
 * Where a request may carry the token.
 *
 * Two spellings because two callers. `fetch` can set a header and should;
 * `EventSource` cannot set any header at all, so the stream has to accept a
 * query parameter. The query form is the weaker of the two — it lands in this
 * process's own access logs — but it is our log, about our own token, and the
 * alternative is no live updates.
 */
export function presentedToken(
  headers: Record<string, unknown>,
  query: Record<string, unknown>,
): string | undefined {
  const header = headers["authorization"];
  if (typeof header === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match?.[1] !== undefined) return match[1];
  }

  const k = query["k"];
  return typeof k === "string" && k.length > 0 ? k : undefined;
}

/**
 * Constant-time comparison.
 *
 * **The length guard is not an optimisation.** `timingSafeEqual` *throws* on
 * buffers of different lengths, so without it a token of the wrong length would
 * leave the handler as a 500 rather than a 401 — which both confuses the caller
 * and leaks the correct length through the status code. Same reasoning, and the
 * same shape, as `metrics.routes.ts#presentsToken`.
 */
function matches(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
