import { request, type Dispatcher } from "undici";
import type { Logger } from "pino";
import { UpstreamError } from "@/lib/errors.js";
import type { Metrics } from "@/lib/metrics/metrics.js";
import {
  UpstreamBuilds,
  UpstreamFlowsResponse,
  UpstreamMockConfig,
  type BuildRef,
  type UpstreamFlow,
  type UpstreamMockConfig as MockConfig,
} from "@/modules/catalog/catalog.schema.js";

/**
 * Data access for the ONDC config-service.
 *
 * This is the repository layer of the catalog module; it is called a *gateway*
 * because the store it reads is a remote HTTP service rather than a database.
 * Same contract either way: it knows how to fetch and parse, it holds no
 * business rule, and it imports nothing from the MCP SDK.
 *
 * ## The one behaviour worth knowing
 *
 * The config-service answers an **unknown domain or usecase with `200
 * {"data":{"flows":[]}}`** — a typo is indistinguishable from a genuinely empty
 * catalog. This layer reports what it saw; `CatalogService` is responsible for
 * validating the build against `available-builds` first so an empty list can
 * only ever mean "really empty".
 *
 * Failures are wrapped in `UpstreamError`, which is a *tool*-channel error: the
 * model reads it and can retry or pick different values.
 */

const SERVICE = "config-service";

export interface ConfigServiceGateway {
  /** The full domain/version/usecase catalog. */
  fetchBuilds(): Promise<
    { domain: string; versions: { version: string; usecases: string[] }[] }[]
  >;
  /** Flow definitions for a build. Empty array is a valid answer. */
  fetchFlows(build: BuildRef): Promise<UpstreamFlow[]>;
  /** The mock-runner config, or `undefined` when the flow does not exist. */
  fetchMockConfig(
    build: BuildRef,
    flowId: string,
  ): Promise<MockConfig | undefined>;
  /** Dependency probe surfaced through `/ready`. */
  ping(): Promise<boolean>;
}

export interface HttpConfigServiceGatewayOptions {
  baseUrl: string;
  timeoutMs: number;
  logger: Logger;
  /** Shared undici Agent from the container. */
  dispatcher?: Dispatcher | undefined;
  /** Optional; absent in unit tests. */
  metrics?: Metrics | undefined;
}

export class HttpConfigServiceGateway implements ConfigServiceGateway {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #logger: Logger;
  readonly #dispatcher: Dispatcher | undefined;
  readonly #metrics: Metrics | undefined;

  constructor(options: HttpConfigServiceGatewayOptions) {
    // Trailing slashes would produce `//ui/flow`, which some proxies 404.
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs;
    this.#logger = options.logger;
    this.#dispatcher = options.dispatcher;
    this.#metrics = options.metrics;
  }

  async fetchBuilds(): Promise<
    { domain: string; versions: { version: string; usecases: string[] }[] }[]
  > {
    const body = await this.#get("/protocol/available-builds", {}, {
      operation: "fetchBuilds",
    });
    const parsed = this.#parse(UpstreamBuilds, body, "available-builds");

    // Upstream nests the catalog as {key, version:[{key, usecase[]}]}.
    return parsed.map((entry) => ({
      domain: entry.key,
      versions: entry.version.map((version) => ({
        version: version.key,
        usecases: version.usecase,
      })),
    }));
  }

  async fetchFlows(build: BuildRef): Promise<UpstreamFlow[]> {
    const body = await this.#get(
      "/ui/flow",
      {
        domain: build.domain,
        version: build.version,
        usecase: build.usecase,
      },
      { operation: "fetchFlows" },
    );
    return this.#parse(UpstreamFlowsResponse, body, "ui/flow").data.flows;
  }

  async fetchMockConfig(
    build: BuildRef,
    flowId: string,
  ): Promise<MockConfig | undefined> {
    const body = await this.#get(
      "/mock/playground",
      {
        domain: build.domain,
        version: build.version,
        usecase: build.usecase,
        flowId,
      },
      // An unknown flowId is a legitimate 404 here, not a transport failure.
      { allowNotFound: true, operation: "fetchMockConfig" },
    );
    if (body === undefined) return undefined;

    return this.#parse(UpstreamMockConfig, body, "mock/playground");
  }

  async ping(): Promise<boolean> {
    await this.#get("/health", {}, { operation: "ping" });
    return true;
  }

  /**
   * One request, timed and counted.
   *
   * `operation` is passed in rather than derived from `path` for the reason the
   * `action` label is bounded: a path carries a build's domain and version, and
   * a label whose value space is the catalog is a label that grows with the
   * catalog. The four method names are a closed set by construction.
   *
   * `not_found` is its own outcome and not an error. An unknown `flowId` is a
   * legitimate answer here, and folding it into `error` would make a working
   * config-service look like a failing one on every miss.
   */
  async #get(
    path: string,
    query: Record<string, string> = {},
    options: { allowNotFound?: boolean; operation?: string } = {},
  ): Promise<unknown> {
    const search = new URLSearchParams(query).toString();
    const url = `${this.#baseUrl}${path}${search.length > 0 ? `?${search}` : ""}`;
    const operation = options.operation ?? "unknown";
    const started = performance.now();
    const finish = (outcome: string): void => {
      const metrics = this.#metrics;
      if (metrics === undefined) return;
      metrics.configServiceRequests.inc({ operation, outcome });
      metrics.configServiceDuration.observe(
        { operation },
        (performance.now() - started) / 1_000,
      );
    };

    let response: Dispatcher.ResponseData;
    try {
      response = await request(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.#timeoutMs),
        ...(this.#dispatcher ? { dispatcher: this.#dispatcher } : {}),
      });
    } catch (error) {
      // DNS failure, connection refused, TLS error, or our own timeout.
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.warn({ err: error, url }, "config-service request failed");
      finish("unreachable");
      throw new UpstreamError(SERVICE, message, { url });
    }

    if (response.statusCode === 404 && options.allowNotFound === true) {
      await response.body.dump();
      finish("not_found");
      return undefined;
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      // Read the body for the upstream's own message before discarding it;
      // "version, usecase are required" is far more useful than "400".
      const detail = await this.#readErrorMessage(response);
      this.#logger.warn(
        { url, status: response.statusCode, detail },
        "config-service returned a non-2xx status",
      );
      finish("error");
      throw new UpstreamError(
        SERVICE,
        `responded ${String(response.statusCode)}${detail ? `: ${detail}` : ""}`,
        { url, status: response.statusCode },
      );
    }

    try {
      const parsed = await response.body.json();
      finish("ok");
      return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finish("unreadable");
      throw new UpstreamError(SERVICE, `returned unreadable JSON: ${message}`, {
        url,
      });
    }
  }

  async #readErrorMessage(
    response: Dispatcher.ResponseData,
  ): Promise<string | undefined> {
    try {
      const text = await response.body.text();
      if (text.length === 0) return undefined;
      const parsed: unknown = JSON.parse(text);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "message" in parsed &&
        typeof parsed.message === "string"
      ) {
        return parsed.message;
      }
      return text.slice(0, 200);
    } catch {
      return undefined;
    }
  }

  #parse<T>(
    schema: {
      safeParse: (value: unknown) => {
        success: boolean;
        data?: T;
        error?: unknown;
      };
    },
    body: unknown,
    label: string,
  ): T {
    const result = schema.safeParse(body);
    if (!result.success || result.data === undefined) {
      this.#logger.warn(
        { label, err: result.error },
        "config-service response did not match the expected shape",
      );
      throw new UpstreamError(
        SERVICE,
        `returned an unexpected shape for ${label}`,
        { endpoint: label },
      );
    }
    return result.data;
  }
}
