import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { request, type Dispatcher } from "undici";
import type { IssueReport } from "@/modules/feedback/feedback.schema.js";

/**
 * Where a finished report goes.
 *
 * A port rather than a function so the two real destinations — a local spool
 * file and an HTTP ingest — compose, and so no test ever writes to a real home
 * directory or opens a socket by forgetting to inject one. Injected through
 * `CreateContainerOptions.feedbackSink`, the same seam as `senderDispatcher`
 * and `validationGateway`.
 *
 * **`deliver` must never throw and never reject.** Its callers are `note()` on
 * the receiver's path and `dispose()` during shutdown; neither has anywhere to
 * put a failure, and a telemetry outage must not become a protocol one. An
 * implementation that cannot deliver logs and returns.
 */
export interface FeedbackSink {
  deliver(report: IssueReport): Promise<void>;
  /** Flush anything held back. Called once, from `container.dispose()`. */
  close(): Promise<void>;
}

/**
 * The sink used when reporting is switched off, and in every test that does not
 * assert on delivery.
 *
 * Note that capture still runs with this installed: incidents are opened,
 * counted and resolved as usual, and only the *send* is dropped. That is
 * deliberate — `feedback_list_reports` stays useful for the operator who wants
 * to see what would have been sent without anything leaving the machine.
 */
export class NoopSink implements FeedbackSink {
  readonly delivered: IssueReport[] = [];

  deliver(report: IssueReport): Promise<void> {
    // Retained rather than discarded so tests can assert on what *would* have
    // gone; the array is bounded by the session's incident cap, not by traffic.
    this.delivered.push(report);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/* -------------------------------------------------------------------------- */
/* Spool                                                                       */
/* -------------------------------------------------------------------------- */

/** Written next to a report once the ingest has accepted it. */
const SENT_SUFFIX = ".sent";
const REPORT_SUFFIX = ".json";

export interface SpoolSinkOptions {
  directory: string;
  /** Entries kept before the oldest are pruned. */
  maxFiles: number;
  logger: Logger;
}

/**
 * A directory of reports, one file each.
 *
 * The spool is the trust surface. Everything this feature sends is on disk
 * first, in the form it was sent, so the answer to "what did you tell them
 * about my participant?" is a file the operator can read rather than a promise
 * they have to take. It is also what makes an ingest outage survivable: an
 * upload that fails leaves its report pending, and the next sweep retries it.
 *
 * Writes are tmp-then-rename, so a reader — or a sweep running concurrently —
 * never sees half a JSON document.
 */
export class SpoolSink implements FeedbackSink {
  readonly #directory: string;
  readonly #maxFiles: number;
  readonly #logger: Logger;

  constructor(options: SpoolSinkOptions) {
    this.#directory = options.directory;
    this.#maxFiles = options.maxFiles;
    this.#logger = options.logger;
  }

  get directory(): string {
    return this.#directory;
  }

  async deliver(report: IssueReport): Promise<void> {
    try {
      await mkdir(this.#directory, { recursive: true });
      const name = `${report.generated_at.replace(/[:.]/g, "-")}-${report.report_id}`;
      const target = join(this.#directory, `${name}${REPORT_SUFFIX}`);
      const temporary = join(this.#directory, `.${name}.${randomUUID()}.tmp`);

      await writeFile(temporary, JSON.stringify(report, null, 2), "utf8");
      await rename(temporary, target);
      await this.#prune();
    } catch (error) {
      this.#logger.warn(
        { err: error, directory: this.#directory },
        "could not spool an issue report",
      );
    }
  }

  /** Reports written but not yet accepted by an ingest, oldest first. */
  async pending(): Promise<string[]> {
    try {
      const entries = await readdir(this.#directory);
      const sent = new Set(
        entries
          .filter((entry) => entry.endsWith(SENT_SUFFIX))
          .map((entry) => entry.slice(0, -SENT_SUFFIX.length)),
      );
      return entries
        .filter((entry) => entry.endsWith(REPORT_SUFFIX) && !sent.has(entry))
        .sort();
    } catch {
      // An absent spool directory is an empty spool, not a failure — nothing
      // has been written yet.
      return [];
    }
  }

  async read(name: string): Promise<IssueReport | undefined> {
    try {
      return JSON.parse(
        await readFile(join(this.#directory, name), "utf8"),
      ) as IssueReport;
    } catch (error) {
      this.#logger.warn(
        { err: error, name },
        "could not read a spooled report",
      );
      return undefined;
    }
  }

  async markSent(name: string): Promise<void> {
    try {
      await writeFile(
        join(this.#directory, `${name}${SENT_SUFFIX}`),
        new Date().toISOString(),
        "utf8",
      );
    } catch (error) {
      this.#logger.warn({ err: error, name }, "could not mark a report sent");
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Keep the directory bounded.
   *
   * An offline laptop running flows all week must not grow an unbounded folder,
   * and the oldest reports are the ones most likely to have been superseded.
   * Sent markers go with their report so the two never drift apart.
   */
  async #prune(): Promise<void> {
    const entries = (await readdir(this.#directory))
      .filter((entry) => entry.endsWith(REPORT_SUFFIX))
      .sort();
    const excess = entries.length - this.#maxFiles;
    if (excess <= 0) return;

    for (const entry of entries.slice(0, excess)) {
      await unlink(join(this.#directory, entry)).catch(() => undefined);
      await unlink(join(this.#directory, `${entry}${SENT_SUFFIX}`)).catch(
        () => undefined,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                        */
/* -------------------------------------------------------------------------- */

export interface HttpSinkOptions {
  endpoint: string;
  apiKey?: string;
  timeoutMs: number;
  /** The process-wide undici agent. A `MockAgent` in tests. */
  dispatcher?: Dispatcher;
  logger: Logger;
}

/**
 * POST a report to the ingest.
 *
 * `AbortSignal.timeout` rather than the sender's `headersTimeout`/`bodyTimeout`
 * pair, matching the two gateways: this is not a protocol call, nothing waits on
 * it, and a single bound on the whole exchange is the simpler correct thing.
 *
 * It answers with a boolean rather than throwing because its caller is deciding
 * whether to mark a spooled file sent, and "it did not go" is a normal outcome
 * of being offline rather than an error anybody can act on.
 */
export class HttpSink {
  readonly #endpoint: string;
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;
  readonly #dispatcher: Dispatcher | undefined;
  readonly #logger: Logger;

  constructor(options: HttpSinkOptions) {
    this.#endpoint = options.endpoint;
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs;
    this.#dispatcher = options.dispatcher;
    this.#logger = options.logger;
  }

  async send(report: IssueReport): Promise<boolean> {
    try {
      const response = await request(this.#endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.#apiKey !== undefined
            ? { authorization: `Bearer ${this.#apiKey}` }
            : {}),
        },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(this.#timeoutMs),
        ...(this.#dispatcher ? { dispatcher: this.#dispatcher } : {}),
      });

      // The body is drained regardless: undici holds the connection open until
      // it is, and a leaked one costs a slot in the shared agent's pool that
      // protocol calls are also using.
      await response.body.text().catch(() => undefined);

      if (response.statusCode >= 200 && response.statusCode < 300) return true;

      this.#logger.warn(
        { status: response.statusCode, endpoint: this.#endpoint },
        "the issue-report ingest refused a report; it stays spooled",
      );
      return false;
    } catch (error) {
      this.#logger.warn(
        { err: error, endpoint: this.#endpoint },
        "could not reach the issue-report ingest; the report stays spooled",
      );
      return false;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Spool + upload                                                              */
/* -------------------------------------------------------------------------- */

export interface SpoolAndUploadOptions {
  spool: SpoolSink;
  /** Absent means spool-only, which is what an unconfigured install gets. */
  http?: HttpSink;
  /** How many pending reports one sweep retries. */
  sweepLimit?: number;
  logger: Logger;
}

/** Bounded so a week offline does not turn the next boot into a flood. */
const DEFAULT_SWEEP_LIMIT = 20;

/**
 * The sink an install actually gets: spool first, upload second.
 *
 * The ordering is the whole design. A report is on disk before any network call
 * is attempted, so nothing is lost to an outage and nothing is sent that cannot
 * afterwards be read back. Upload failures are not retried inline — they are
 * left pending, and the next delivery sweeps a bounded number of them, which
 * turns "the ingest was down for an hour" into a delay rather than a gap.
 */
export class SpoolAndUploadSink implements FeedbackSink {
  readonly #spool: SpoolSink;
  readonly #http: HttpSink | undefined;
  readonly #sweepLimit: number;
  readonly #logger: Logger;

  constructor(options: SpoolAndUploadOptions) {
    this.#spool = options.spool;
    this.#http = options.http;
    this.#sweepLimit = options.sweepLimit ?? DEFAULT_SWEEP_LIMIT;
    this.#logger = options.logger;
  }

  async deliver(report: IssueReport): Promise<void> {
    await this.#spool.deliver(report);
    await this.sweep();
  }

  /**
   * Push whatever is still pending, oldest first.
   *
   * Also the retry path: a report the ingest refused stays pending and is tried
   * again by the next sweep, without a timer or a queue of its own.
   */
  async sweep(): Promise<void> {
    const http = this.#http;
    if (http === undefined) return;

    try {
      const pending = (await this.#spool.pending()).slice(0, this.#sweepLimit);
      for (const name of pending) {
        const report = await this.#spool.read(name);
        if (report === undefined) continue;
        if (await http.send(report)) await this.#spool.markSent(name);
      }
    } catch (error) {
      this.#logger.warn({ err: error }, "an issue-report sweep failed");
    }
  }

  async close(): Promise<void> {
    await this.sweep();
    await this.#spool.close();
  }
}

/** Where reports live when nothing names a directory. */
export function defaultSpoolDirectory(): string {
  return join(homedir(), ".ondc-mcp", "feedback");
}
