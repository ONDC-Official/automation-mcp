import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { CacheStore } from "@/lib/cache/cache-store.js";
import type { Session } from "@/modules/session/session.schema.js";
import { readContext, type ValidationGateway } from "@/modules/validate/validate.gateway.js";
import {
  ValidationLayer,
  type UncheckedLayer,
  type ValidationFinding,
  type ValidationVerdict,
} from "@/modules/validate/validate.schema.js";

/**
 * Protocol validation, composed from layers.
 *
 * ## The extension point, and why it is shaped this way
 *
 * ONDC validation is four layers deep and this repo will grow into all of them:
 * L0 and L1 are answered today by the workbench's api-service, `context`
 * (ids match the session, timestamp window, TTL) and `L2` (business judgement,
 * the model's own) are not built yet. Those two are **not** variations on the
 * remote call — one is a local pure function, the other is an LLM round trip
 * that happens after the ACK.
 *
 * So the composition point is `ValidationCheck`: a thing that declares which
 * layers it covers and answers pass / fail / unavailable. Adding a layer is
 * **one implementation and one `register` call**. Nothing else changes — the
 * tool, the outbound gate, the receiver and the report all read `findings[].layer`
 * and a merged status, and none of them knows how many checks produced it.
 *
 * The `unchecked` list is what keeps that honest as the set grows: a layer no
 * registered check covers is reported as unchecked with a reason, so a `valid`
 * verdict never silently claims more coverage than it has. When a context check
 * is finally registered, its "not implemented" line disappears on its own.
 */

/** Everything a check is given. Extend this rather than widening a check's constructor. */
export interface CheckRequest {
  /** The build to judge against — normally the session's. */
  domain: string;
  version: string;
  /** Decides which schema and rule set applies. */
  action: string;
  payload: unknown;
  /** Which way the payload is travelling. Some layers only apply one way. */
  direction: "inbound" | "outbound";
  /** Present for everything except a bare `payload_validate` on a stray body. */
  session?: Session | undefined;
  transactionId?: string | undefined;
}

export type CheckOutcome =
  | { status: "pass" }
  | { status: "fail"; findings: ValidationFinding[]; docsUrl?: string }
  | { status: "unavailable"; reason: string };

export interface ValidationCheck {
  /** A stable name, for logs. */
  readonly name: string;
  /**
   * Which layers this check answers for. More than one when a single call
   * covers several — the remote oracle runs L0 and L1 in one request, and if it
   * answers ACK then both passed.
   */
  readonly layers: readonly ValidationLayer[];
  /** A reason to skip, or `undefined` to run. Skipping is not failing. */
  skipReason?(request: CheckRequest): string | undefined;
  run(request: CheckRequest): Promise<CheckOutcome>;
}

/**
 * How hard a verdict bites.
 *
 * `advisory` is not a lesser `enforce`: the verdict returned is identical, and
 * only the *gates* consult this. That split is deliberate — a service that lied
 * about the verdict to implement a policy would make the findings recorded
 * against a transaction depend on a deployment flag.
 */
export type ValidationMode = "off" | "advisory" | "enforce";

export interface ValidateServiceOptions {
  gateway: ValidationGateway;
  /** In-process derived-data cache. See `#cacheKey` for what is cached. */
  cache: CacheStore;
  cacheTtlMs: number;
  mode: ValidationMode;
  logger: Logger;
}

export class ValidateService {
  readonly #checks: ValidationCheck[] = [];
  readonly #cache: CacheStore;
  readonly #cacheTtlMs: number;
  readonly #mode: ValidationMode;
  readonly #logger: Logger;

  constructor(options: ValidateServiceOptions) {
    this.#cache = options.cache;
    this.#cacheTtlMs = options.cacheTtlMs;
    this.#mode = options.mode;
    this.#logger = options.logger;

    this.register(new ProtocolCheck(options.gateway));
  }

  /** Add a layer. The one call a new `ValidationCheck` needs. */
  register(check: ValidationCheck): void {
    this.#checks.push(check);
  }

  get mode(): ValidationMode {
    return this.#mode;
  }

  /** Whether a gate should act on an `invalid` verdict, or merely record it. */
  get enforces(): boolean {
    return this.#mode === "enforce";
  }

  /**
   * Judge one payload.
   *
   * Never throws. A check that throws is treated as `unavailable` for its own
   * layers and the rest still run — one broken layer must not blind the others,
   * and on the inbound path an exception here would answer a participant 500.
   */
  async validate(request: CheckRequest): Promise<ValidationVerdict> {
    if (this.#mode === "off") {
      return verdictOf([], this.#uncheckedFor([], "validation is switched off"));
    }

    const cacheKey = this.#cacheKey(request);
    const cached = await this.#read(cacheKey);
    if (cached) return cached;

    const runnable: ValidationCheck[] = [];
    const unchecked: UncheckedLayer[] = [];

    for (const check of this.#checks) {
      const skip = check.skipReason?.(request);
      if (skip === undefined) {
        runnable.push(check);
        continue;
      }
      unchecked.push(...check.layers.map((layer) => ({ layer, reason: skip })));
    }

    // Concurrent: the layers are independent, and on the inbound path this sits
    // in the ACK window where the cost is the slowest check rather than the sum.
    const outcomes = await Promise.all(
      runnable.map(async (check) => {
        try {
          return { check, outcome: await check.run(request) };
        } catch (error) {
          this.#logger.warn(
            { err: error, check: check.name },
            "validation check threw; treating its layers as unchecked",
          );
          return {
            check,
            outcome: {
              status: "unavailable" as const,
              reason: `the ${check.name} check failed to run`,
            },
          };
        }
      }),
    );

    const findings: ValidationFinding[] = [];
    const checked: ValidationLayer[] = [];
    let docsUrl: string | undefined;

    for (const { check, outcome } of outcomes) {
      if (outcome.status === "unavailable") {
        unchecked.push(
          ...check.layers.map((layer) => ({ layer, reason: outcome.reason })),
        );
        continue;
      }

      checked.push(...check.layers);
      if (outcome.status === "fail") {
        findings.push(...outcome.findings);
        docsUrl ??= outcome.docsUrl;
      }
    }

    const verdict = verdictOf(
      checked,
      [...unchecked, ...this.#uncheckedFor([...checked, ...unchecked.map((u) => u.layer)])],
      findings,
      docsUrl,
    );

    await this.#write(cacheKey, verdict);
    return verdict;
  }

  /**
   * Layers no registered check covers.
   *
   * This is the line that keeps a `valid` verdict from over-claiming. It is
   * derived from the enum rather than hardcoded, so registering a check for a
   * layer removes its notice automatically.
   */
  #uncheckedFor(
    accountedFor: readonly ValidationLayer[],
    reason = "no check is registered for this layer yet",
  ): UncheckedLayer[] {
    const seen = new Set(accountedFor);
    return ValidationLayer.options
      .filter((layer) => !seen.has(layer))
      .map((layer) => ({ layer, reason }));
  }

  /**
   * The cache key: the build, the action, and the payload's own bytes.
   *
   * A hash of the whole payload rather than of its ids, because the verdict is a
   * function of the bytes and nothing else — two calls quoting one
   * `message_id` with different bodies must not share an answer.
   */
  #cacheKey(request: CheckRequest): string {
    const hash = createHash("sha256")
      .update(request.domain)
      .update(" ")
      .update(request.version)
      .update(" ")
      .update(request.action)
      .update(" ")
      .update(request.direction)
      .update(" ")
      .update(safeStringify(request.payload))
      .digest("hex");
    return `validation::${hash}`;
  }

  async #read(key: string): Promise<ValidationVerdict | undefined> {
    try {
      return await this.#cache.get<ValidationVerdict>(key);
    } catch (error) {
      // The catalog cache is in-process, so this is close to unreachable — but
      // a cache miss and a cache failure are the same thing to a caller, and
      // neither is a reason to refuse to validate.
      this.#logger.debug({ err: error }, "validation cache read failed");
      return undefined;
    }
  }

  async #write(key: string, verdict: ValidationVerdict): Promise<void> {
    // Never cache `unavailable`: an outage would then outlive itself, and the
    // first call after recovery would still be told nobody answered.
    if (verdict.status === "unavailable") return;
    try {
      await this.#cache.set(key, verdict, this.#cacheTtlMs);
    } catch (error) {
      this.#logger.debug({ err: error }, "validation cache write failed");
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The one check that exists today                                             */
/* -------------------------------------------------------------------------- */

/**
 * L0 + L1, answered by the workbench's api-service.
 *
 * One check for two layers because one request covers both: the oracle runs the
 * schema first and only reaches the rules if it passes, so an ACK means both
 * passed and a NACK's grammar says which one spoke.
 */
export class ProtocolCheck implements ValidationCheck {
  readonly name = "protocol";
  readonly layers = ["L0", "L1"] as const;

  readonly #gateway: ValidationGateway;

  constructor(gateway: ValidationGateway) {
    this.#gateway = gateway;
  }

  async run(request: CheckRequest): Promise<CheckOutcome> {
    const result = await this.#gateway.validate({
      domain: request.domain,
      version: request.version,
      action: request.action,
      payload: request.payload,
    });

    if (result.status === "valid") return { status: "pass" };
    if (result.status === "unavailable") {
      return { status: "unavailable", reason: result.reason };
    }
    return {
      status: "fail",
      findings: result.findings,
      ...(result.docsUrl !== undefined ? { docsUrl: result.docsUrl } : {}),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Merge per-check outcomes into one answer.
 *
 * The precedence is the point: **any failure makes the whole verdict `invalid`**,
 * even when another layer could not be reached, because a payload with a known
 * defect is not improved by an unrelated outage. `unavailable` only wins when
 * nothing failed *and* nothing was definitively checked — otherwise a partial
 * pass would be reported as if it were a full one.
 */
export function verdictOf(
  checked: readonly ValidationLayer[],
  unchecked: readonly UncheckedLayer[],
  findings: readonly ValidationFinding[] = [],
  docsUrl?: string,
): ValidationVerdict {
  const status =
    findings.length > 0 ? "invalid" : checked.length > 0 ? "valid" : "unavailable";

  return {
    status,
    findings: [...findings],
    checked: [...checked],
    unchecked: dedupeUnchecked(unchecked),
    // `docs_url`, not `docsUrl`: this is the wire shape, and a spread of a
    // conditional object literal is not excess-property checked, so the wrong
    // name here typechecks cleanly and silently drops the field.
    ...(docsUrl !== undefined ? { docs_url: docsUrl } : {}),
  };
}

/** One line per layer — the first reason given wins. */
function dedupeUnchecked(entries: readonly UncheckedLayer[]): UncheckedLayer[] {
  const byLayer = new Map<ValidationLayer, UncheckedLayer>();
  for (const entry of entries) {
    if (!byLayer.has(entry.layer)) byLayer.set(entry.layer, entry);
  }
  return [...byLayer.values()];
}

/** The action a payload declares, for callers that did not name one. */
export function actionOf(payload: unknown): string | undefined {
  const action = readContext(payload)["action"];
  return typeof action === "string" && action !== "" ? action : undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    // A cycle has no stable serialisation, so every such payload shares this
    // key. Harmless: the gateway cannot serialise it either and answers
    // `unavailable`, which is never written to the cache.
    return "<uncacheable>";
  }
}
