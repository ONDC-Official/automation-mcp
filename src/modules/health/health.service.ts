import type { HealthCheck } from "@/container.js";

/**
 * Readiness evaluation. Protocol-agnostic like every other service — it takes
 * probes and returns a verdict; the route decides the status code.
 */

export interface DependencyReport {
  readonly name: string;
  readonly status: "up" | "down";
  readonly durationMs: number;
  readonly error?: string;
}

export interface ReadinessReport {
  readonly status: "ready" | "degraded";
  readonly checks: DependencyReport[];
}

const DEFAULT_TIMEOUT_MS = 2_000;

async function runCheck(
  check: HealthCheck,
  timeoutMs: number,
): Promise<DependencyReport> {
  const started = performance.now();

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`timed out after ${String(timeoutMs)}ms`)),
      timeoutMs,
    ).unref();
  });

  try {
    const result = await Promise.race([check.check(), timeout]);
    // A check may resolve `false` instead of throwing.
    if (result === false) throw new Error("check reported unhealthy");
    return {
      name: check.name,
      status: "up",
      durationMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    return {
      name: check.name,
      status: "down",
      durationMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export class HealthService {
  constructor(
    private readonly checks: readonly HealthCheck[],
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  /** Runs every probe concurrently; one failure degrades the whole report. */
  async readiness(): Promise<ReadinessReport> {
    const checks = await Promise.all(
      this.checks.map((check) => runCheck(check, this.timeoutMs)),
    );

    return {
      status: checks.some((check) => check.status === "down")
        ? "degraded"
        : "ready",
      checks,
    };
  }
}
