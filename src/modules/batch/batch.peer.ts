import { UpstreamError } from "@/lib/errors.js";
import type {
  GetBatchRunStatusOutput,
  StartBatchRunInput,
  StartBatchRunOutput,
} from "@/modules/batch/batch.schema.js";

/**
 * The other instance — the mock seller — as one call from the buyer's point of
 * view. `role: "both"` uses it so a single `batch_run_start` can arm the
 * seller's side itself, instead of the caller having to start two batches in
 * the right order.
 *
 * It is a port so the service can be tested against a scripted peer, and
 * because "another instance reached over HTTP" is exactly the part that should
 * be swappable (a different transport, a fake).
 */
export interface BatchPeer {
  /** Where the peer's receiver is reachable — its advertised base URL. */
  readonly receiverUrl: string;
  startListener(
    input: Partial<StartBatchRunInput> & {
      counterparty_subscriber_url: string;
    },
  ): Promise<StartBatchRunOutput>;
  status(
    batchId: string,
    options: { includeResults: boolean; sinceIndex: number; limit: number },
  ): Promise<GetBatchRunStatusOutput>;
  cancel(batchId: string): Promise<void>;
}

const CALL_TIMEOUT_MS = 20_000;

/** The peer over its MCP HTTP endpoint: one stateless `tools/call` per method. */
export class HttpBatchPeer implements BatchPeer {
  readonly receiverUrl: string;
  readonly #mcpUrl: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;
  #nextId = 1;

  constructor(options: { url: string; apiKey?: string; fetch?: typeof fetch }) {
    this.receiverUrl = options.url.replace(/\/+$/, "");
    // `/mcp` is mounted at the app's root *as the app sees the request* —
    // but what the app sees and what a caller outside it sends are only the
    // same path when nothing in front rewrites it. `app.ts` registers `/mcp`
    // with no prefix, so under a bare, unproxied deployment the outside path
    // really is `{origin}/mcp`. Behind a **prefix-stripping** reverse proxy —
    // verified live against dev-workbench.ondc.tech: `/automation-mcp/mcp`
    // externally reaches this app's `/mcp` (401, this app's own auth), while
    // bare `/mcp` falls through to a completely different service sharing the
    // host — reaching this app at all requires keeping the prefix in the
    // *outside* URL, because that prefix is the proxy's own routing key, not
    // a path this app is expected to strip itself. `RECEIVER_PUBLIC_URL`'s
    // path is exactly that externally-visible prefix, so plain concatenation
    // onto `receiverUrl` is correct for that (by far the more common) case.
    // A deployment where the proxy does *not* rewrite the path — the app's
    // own prefix and the external one are identical — has an empty path on
    // `RECEIVER_PUBLIC_URL` in the first place, making this a no-op there too.
    this.#mcpUrl = `${this.receiverUrl}/mcp`;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
  }

  startListener(
    input: Partial<StartBatchRunInput> & {
      counterparty_subscriber_url: string;
    },
  ): Promise<StartBatchRunOutput> {
    return this.#call<StartBatchRunOutput>("batch_run_start", {
      ...input,
      role: "listener",
    });
  }

  status(
    batchId: string,
    options: { includeResults: boolean; sinceIndex: number; limit: number },
  ): Promise<GetBatchRunStatusOutput> {
    return this.#call<GetBatchRunStatusOutput>("batch_run_status", {
      batch_id: batchId,
      include_results: options.includeResults,
      since_index: options.sinceIndex,
      limit: options.limit,
    });
  }

  async cancel(batchId: string): Promise<void> {
    await this.#call("batch_run_cancel", { batch_id: batchId });
  }

  async #call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(this.#mcpUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(this.#apiKey !== undefined
            ? { authorization: `Bearer ${this.#apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: this.#nextId++,
          method: "tools/call",
          params: { name: tool, arguments: args },
        }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (error) {
      throw new UpstreamError(
        "batch-peer",
        `${tool} could not reach ${this.#mcpUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const text = await response.text();
    const message = parseRpc(text);
    const result = message?.result;
    if (!response.ok || message?.error || !result || result.isError) {
      const detail =
        message?.error?.message ??
        result?.content?.map((c) => c.text ?? "").join(" ") ??
        text.slice(0, 200);
      throw new UpstreamError(
        "batch-peer",
        `${tool} was refused (HTTP ${String(response.status)}): ${detail}`,
      );
    }
    return result.structuredContent as T;
  }
}

interface RpcMessage {
  result?: {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { text?: string }[];
  };
  error?: { message?: string };
}

/** A reply is one JSON body, or one SSE `data:` line — the server picks. */
function parseRpc(body: string): RpcMessage | undefined {
  const line = body
    .split("\n")
    .find((l) => l.startsWith("data:"))
    ?.slice(5)
    .trim();
  try {
    return JSON.parse(line ?? body) as RpcMessage;
  } catch {
    return undefined;
  }
}
