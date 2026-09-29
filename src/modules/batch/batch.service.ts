import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { NotFoundError, ValidationError } from "@/lib/errors.js";
import type { FlowService } from "@/modules/flow/flow.service.js";
import type { RecordService } from "@/modules/record/record.service.js";
import {
  advertisedUri,
  type SessionService,
} from "@/modules/session/session.service.js";
import type { BatchPeer } from "@/modules/batch/batch.peer.js";
import {
  assembleJourney,
  summariseOrder,
  type ExchangeRow,
  type StepRow,
} from "@/modules/batch/batch.journey.js";
import type { DriverFlowConfig } from "@/modules/batch/batch.driver.js";
import type { UpstreamFlow } from "@/modules/catalog/catalog.schema.js";
import { runOneTransaction } from "@/modules/batch/batch.driver.js";
import {
  findPreset,
  knownPresets,
} from "@/modules/batch/batch.version-presets.js";
import type { CatalogService } from "@/modules/catalog/catalog.service.js";
import {
  generateOrderInputs,
  IssuedPairTracker,
} from "@/modules/batch/batch.input-generator.js";
import {
  BATCH_RESULT_TTL_MS,
  BatchRepository,
} from "@/modules/batch/batch.repository.js";
import type {
  BatchTransactionStatus,
  CancelBatchRunOutput,
  BatchRole,
  BatchOrderSummary,
  GetBatchRunStatusOutput,
  GetBatchPayloadsInput,
  GetBatchPayloadsOutput,
  GetOrderLogInput,
  GetOrderLogOutput,
  ListBatchOrdersInput,
  ListBatchOrdersOutput,
  BatchTransactionResult,
  PeerBatchStatus,
  StartBatchRunInput,
  StartBatchRunOutput,
} from "@/modules/batch/batch.schema.js";

/**
 * Business logic for the concurrent order-journey runner. Imports nothing
 * from the MCP SDK.
 *
 * `startRun` returns as soon as the batch is accepted — the actual driving
 * happens on a detached, un-awaited promise chain, the same "scheduled, never
 * awaited" idiom `flow.chain.ts#scheduleChain` uses for auto-advance. A tool
 * call must never block on a 1000-transaction run finishing.
 *
 * Concurrency is a small hand-rolled bounded pool: `concurrency` workers each
 * pull the next transaction index and drive it in a fully isolated
 * `try/catch` (`runOneTransaction` never throws — see its own contract) so one
 * stuck or errored transaction can never block or crash the others. There is
 * no queue library in this repo's dependency tree, and one is not warranted
 * for one call site.
 */

interface ResolvedJourney {
  flowId: string;
  flow: UpstreamFlow;
  config: DriverFlowConfig;
  stepOverrides: Record<string, Record<string, unknown>>;
}

/**
 * `https://host/prefix/ONDC:TRV11/2.0.1/buyer` → `https://host/prefix`. The
 * route is mounted once at boot under a fixed shape, so a URI this server is
 * to advertise has to end in it; anything else would be a callback URL that
 * 404s, which surfaces only as orders that never hear back.
 */
function baseOf(
  uri: string,
  build: { domain: string; version: string },
  side: "buyer" | "seller",
): string {
  const suffix = `/${build.domain}/${build.version}/${side}`;
  const trimmed = uri.replace(/\/+$/, "");
  if (!trimmed.endsWith(suffix)) {
    throw new ValidationError(
      `${side === "buyer" ? "bap_uri" : "bpp_uri"} must end "${suffix}" — the ` +
        "path this server mounts its receiver on.",
      { got: uri },
    );
  }
  return trimmed.slice(0, -suffix.length);
}

/** A payload's `context`, its `message`, or both. */
function pickParts(
  payload: unknown,
  parts: "both" | "context" | "message",
): unknown {
  if (parts === "both" || typeof payload !== "object" || payload === null) {
    return payload;
  }
  return (payload as Record<string, unknown>)[parts];
}

/**
 * The newest payload that describes an order — the last step, in wire order,
 * whose body carries a `message.order` — for {@link summariseOrder} to read.
 * Walking backward is deliberate: `on_confirm`/`on_status` describe the order
 * more completely than `on_select` does, so the latest one wins.
 */
function latestOrderPayload(
  withPayloads: { key: string; payload_ids: string[] }[],
  bodies: Map<string, unknown>,
): { stepKey: string; body: unknown } | undefined {
  for (const row of [...withPayloads].reverse()) {
    const id = row.payload_ids[0];
    const body = id !== undefined ? bodies.get(id) : undefined;
    if (
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      typeof (body as { message?: { order?: unknown } }).message?.order ===
        "object"
    ) {
      return { stepKey: row.key, body };
    }
  }
  return undefined;
}

const TERMINAL_STATUSES: readonly BatchTransactionStatus[] = [
  "completed",
  "blocked",
  "nacked",
  "timed_out",
  "errored",
];

export interface BatchServiceOptions {
  session: SessionService;
  flow: FlowService;
  record: RecordService;
  repository: BatchRepository;
  logger: Logger;
  /** How long a finished batch's meta/progress/results are kept. */
  resultTtlMs?: number;
  catalog: CatalogService;
  /** This instance's default subscriber id — what bap_id defaults to. */
  mockSubscriberId?: string;
  /** The seller instance, for `role: "both"`. */
  peer?: BatchPeer;
  /** This instance's own advertised receiver base URL. */
  receiverPublicUrl?: string;
  /** Pause after the seller is started, so its sessions are armed first. */
  armSettleMs?: number;
}

export class BatchService {
  readonly #session: SessionService;
  readonly #flow: FlowService;
  readonly #record: RecordService;
  readonly #repository: BatchRepository;
  readonly #logger: Logger;
  readonly #resultTtlMs: number;
  readonly #catalog: CatalogService;
  readonly #mockSubscriberId: string | undefined;
  readonly #peer: BatchPeer | undefined;
  readonly #receiverPublicUrl: string | undefined;
  readonly #armSettleMs: number;
  /**
   * In-process only, and that is sufficient: a batch's driving loop lives in
   * the same process that started it (`startRun`'s detached promise chain),
   * so cancellation never needs to cross a process boundary. Persisted state
   * (`BatchMeta.state`) still records "cancelled" for anyone polling status.
   */
  readonly #cancelled = new Set<string>();

  constructor(options: BatchServiceOptions) {
    this.#session = options.session;
    this.#flow = options.flow;
    this.#record = options.record;
    this.#repository = options.repository;
    this.#logger = options.logger.child({ component: "batch" });
    this.#resultTtlMs = options.resultTtlMs ?? BATCH_RESULT_TTL_MS;
    this.#catalog = options.catalog;
    this.#mockSubscriberId = options.mockSubscriberId;
    this.#peer = options.peer;
    this.#receiverPublicUrl = options.receiverPublicUrl;
    this.#armSettleMs = options.armSettleMs ?? 1_000;
  }

  async startRun(input: StartBatchRunInput): Promise<StartBatchRunOutput> {
    const both = input.role === "both";
    const role: BatchRole =
      input.role === "listener" ? "listener" : "initiator";
    const buyerSide = role === "initiator";
    const build = {
      domain: input.domain,
      version: input.version,
      usecase: input.usecase,
    };

    // Who is who. This instance plays one side; `own` is that side's identity
    // and `their` the other's. The buyer is the BAP, the seller the BPP.
    const own = buyerSide
      ? { id: input.bap_id, uri: input.bap_uri }
      : { id: input.bpp_id, uri: input.bpp_uri };
    const their = buyerSide
      ? { id: input.bpp_id, uri: input.bpp_uri }
      : { id: input.bap_id, uri: input.bap_uri };

    // Naming a seller URI means "run against THAT seller": nothing is started
    // on the configured seller instance, and the orders are between this buyer
    // and the app at bpp_uri.
    const externalSeller = buyerSide && their.uri !== undefined;
    const usePeer = both && !externalSeller;

    let counterparty = their.uri ?? input.counterparty_subscriber_url;
    if (usePeer) {
      if (!this.#peer || !this.#receiverPublicUrl) {
        throw new ValidationError(
          'role "both" needs a seller: set bpp_uri to another seller app, or ' +
            "set BATCH_PEER_URL on this instance to use the seller instance, " +
            'or start each side yourself with role "listener" and "initiator".',
        );
      }
      counterparty = advertisedUri(this.#peer.receiverUrl, build, "BPP");
    }
    if (counterparty === undefined) {
      throw new ValidationError(
        (buyerSide ? "bpp_uri" : "bap_uri") +
          " (or counterparty_subscriber_url) is required for role " +
          input.role +
          ".",
      );
    }

    const receiverPublicUrl =
      own.uri !== undefined
        ? baseOf(own.uri, build, buyerSide ? "buyer" : "seller")
        : undefined;
    const identity = {
      ...(own.id !== undefined ? { ownSubscriberId: own.id } : {}),
      ...(their.id !== undefined ? { counterpartySubscriberId: their.id } : {}),
      ...(receiverPublicUrl !== undefined ? { receiverPublicUrl } : {}),
    };

    // Before anything is started on either side: an unknown or undrivable flow
    // fails once, here, instead of once per order.
    const journey = await this.#resolveJourney(input, role, counterparty);
    const batchId = randomUUID();
    const acceptedAt = new Date().toISOString();

    const buyerUri =
      input.bap_uri ??
      (this.#receiverPublicUrl !== undefined
        ? advertisedUri(this.#receiverPublicUrl, build, "BAP")
        : undefined);

    let peerBatchId: string | undefined;
    try {
      if (usePeer && this.#peer && buyerUri !== undefined) {
        const started = await this.#peer.startListener({
          ...build,
          ...(input.flow_id !== undefined ? { flow_id: input.flow_id } : {}),
          counterparty_subscriber_url: buyerUri,
          ...(input.bap_id !== undefined ? { bap_id: input.bap_id } : {}),
          ...(input.bpp_id !== undefined ? { bpp_id: input.bpp_id } : {}),
          transaction_count: input.transaction_count,
          concurrency: input.concurrency,
          per_transaction_timeout_ms: input.per_transaction_timeout_ms,
        });
        peerBatchId = started.batch_id;
        await this.#waitForSeller(
          peerBatchId,
          Math.min(input.concurrency, input.transaction_count),
        );
      }

      await this.#repository.saveMeta(
        {
          batch_id: batchId,
          state: "running",
          input,
          accepted_at: acceptedAt,
          ...(peerBatchId !== undefined
            ? { peer: { batch_id: peerBatchId } }
            : {}),
        },
        this.#resultTtlMs,
      );
    } catch (error) {
      // Never leave the seller armed for orders that will not be sent.
      if (peerBatchId !== undefined && this.#peer) {
        await this.#peer.cancel(peerBatchId).catch(() => undefined);
      }
      throw error;
    }

    this.#logger.info(
      {
        batchId,
        role: input.role,
        seller: buyerSide ? (usePeer ? "peer" : "external") : undefined,
        peerBatchId,
        transactionCount: input.transaction_count,
        concurrency: input.concurrency,
        flowId: journey.flowId,
      },
      "batch run accepted",
    );

    // Scheduled, never awaited — the tool call's answer is already decided.
    void this.#driveAll(
      batchId,
      input,
      journey,
      role,
      counterparty,
      identity,
    ).catch((error: unknown) => {
      this.#logger.error(
        { err: error, batchId },
        "batch run driver crashed outside per-transaction isolation",
      );
    });

    return {
      batch_id: batchId,
      role: input.role,
      ...(buyerSide && buyerUri !== undefined
        ? {
            parties: {
              bap_id:
                own.id ?? this.#mockSubscriberId ?? "(this instance's own id)",
              bap_uri: buyerUri,
              ...(their.id !== undefined ? { bpp_id: their.id } : {}),
              bpp_uri: counterparty,
              seller: usePeer ? ("peer" as const) : ("external" as const),
            },
          }
        : {}),
      ...(peerBatchId !== undefined ? { peer_batch_id: peerBatchId } : {}),
      flow_id: journey.flowId,
      transaction_count: input.transaction_count,
      concurrency: input.concurrency,
      accepted_at: acceptedAt,
    };
  }

  /**
   * The flow to run: `flow_id` if given, else the version's default order
   * journey. It is read from the config-service, which both proves it exists
   * (an unknown id is refused naming the flows that do) and hands the driver
   * the flow's own definition of what each step needs.
   */
  async #resolveJourney(
    input: StartBatchRunInput,
    role: BatchRole,
    counterpartySubscriberUrl: string,
  ): Promise<ResolvedJourney> {
    const build = {
      domain: input.domain,
      version: input.version,
      usecase: input.usecase,
    };
    const preset = findPreset(build.domain, build.version, build.usecase);
    const flowId = input.flow_id ?? preset?.defaultFlowId;
    if (flowId === undefined) {
      throw new ValidationError(
        `No default flow for ${build.domain} ${build.version} (${build.usecase}). ` +
          "Pass flow_id (catalog_list_flows shows what this version publishes).",
        { builds_with_a_default: knownPresets() },
      );
    }

    const flow = await this.#catalog.requireFlow(build, flowId);
    return {
      flowId,
      flow,
      config: {
        itemIdsBusinessDataKey: "item_ids",
        stationsBusinessDataKey:
          preset?.stationsBusinessDataKey ?? "fulfillments",
        ...(preset?.serviceableStationCodes !== undefined
          ? { serviceableStationCodes: preset.serviceableStationCodes }
          : {}),
      },
      stepOverrides:
        preset?.stepOverrides?.({ role, counterpartySubscriberUrl }) ?? {},
    };
  }

  /**
   * The buyer must not send before the seller has armed, or its first calls
   * find nothing waiting (412). The seller counts an order "started" before its
   * session is armed, so once the first wave has started, allow a short settle.
   */
  async #waitForSeller(peerBatchId: string, firstWave: number): Promise<void> {
    if (!this.#peer) return;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const seller = await this.#peer.status(peerBatchId, {
        includeResults: false,
        sinceIndex: 0,
        limit: 1,
      });
      const p = seller.progress;
      const started =
        p.in_flight +
        p.completed +
        p.blocked +
        p.nacked +
        p.timed_out +
        p.errored;
      if (started >= firstWave) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await new Promise((resolve) => setTimeout(resolve, this.#armSettleMs));
  }

  async status(
    batchId: string,
    options: { includeResults: boolean; sinceIndex: number; limit: number },
  ): Promise<GetBatchRunStatusOutput> {
    const meta = await this.#repository.getMeta(batchId);
    if (!meta) {
      throw new NotFoundError("batch run", batchId, {
        hint: "Batch results are kept 24h after the run finishes, then expire.",
      });
    }

    const progress = await this.#repository.getProgress(batchId);
    const inFlightOrDone =
      progress.in_flight +
      progress.completed +
      progress.blocked +
      progress.nacked +
      progress.timed_out +
      progress.errored;
    const queued = Math.max(0, meta.input.transaction_count - inFlightOrDone);

    const peer = await this.#peerStatus(meta.peer?.batch_id);
    const state =
      meta.state === "completed" && peer?.state === "running"
        ? "running"
        : meta.state;

    const base: GetBatchRunStatusOutput = {
      batch_id: batchId,
      state,
      ...(peer !== undefined ? { peer } : {}),
      transaction_count: meta.input.transaction_count,
      concurrency: meta.input.concurrency,
      progress: { ...progress, queued },
      accepted_at: meta.accepted_at,
      ...(meta.finished_at !== undefined
        ? { finished_at: meta.finished_at }
        : {}),
    };

    if (!options.includeResults) return base;

    const end = options.sinceIndex + options.limit - 1;
    const [results, total] = await Promise.all([
      this.#repository.listResults(batchId, options.sinceIndex, end),
      this.#repository.countResults(batchId),
    ]);

    return { ...base, results, results_total: total };
  }

  /**
   * One order's complete journey: every exchange, in order, both directions,
   * with the flow's own step status and the ACK each got, the events the
   * session journaled for it, and the order as the seller last described it.
   * Read entirely from this instance's record — the seller's replies are in it
   * as inbound exchanges — so it needs no call to the peer.
   */
  async orderLog(input: GetOrderLogInput): Promise<GetOrderLogOutput> {
    if (input.index === undefined && input.transaction_id === undefined) {
      throw new ValidationError(
        "Name the order by `index` or `transaction_id`.",
      );
    }
    const meta = await this.#repository.getMeta(input.batch_id);
    if (!meta) throw new NotFoundError("batch run", input.batch_id);

    const found = await this.#findResult(input);
    if (!found) {
      throw new NotFoundError(
        "order",
        String(input.index ?? input.transaction_id),
        {
          batch_id: input.batch_id,
          hint: "Results appear once an order settles.",
        },
      );
    }
    if (found.session_id === undefined || found.transaction_id === null) {
      throw new ValidationError(
        "That order never got as far as sending its first call, so it has no journey.",
        { status: found.status, message: found.message },
      );
    }

    const wantedBodies = (rows: StepRow[]): StepRow[] =>
      input.include_payloads ? rows : rows.slice(-3);
    const { session, flow, stepRows, exchanges, bodies, withPayloads } =
      await this.#loadJourney(
        { session_id: found.session_id, transaction_id: found.transaction_id },
        wantedBodies,
      );

    const steps = assembleJourney({
      steps: stepRows,
      exchanges,
      ...(input.include_payloads
        ? { bodies, maxPayloadBytes: input.max_payload_bytes }
        : {}),
    });

    const order = summariseOrder(latestOrderPayload(withPayloads, bodies));

    const events = (await this.#record.readEvents(session.session_id, 0))
      .filter((e) => e.transaction_id === found.transaction_id)
      .map((e) => ({
        at: e.at,
        kind: e.kind,
        ...(e.action !== undefined ? { action: e.action } : {}),
        summary: e.summary,
      }));

    return {
      batch_id: input.batch_id,
      index: found.index,
      transaction_id: found.transaction_id,
      session_id: session.session_id,
      flow_id: flow.flow_id,
      flow_status: flow.flow_status,
      batch_status: found.status,
      ...(found.duration_ms !== undefined
        ? { duration_ms: found.duration_ms }
        : {}),
      ...(found.inputs !== undefined ? { inputs: found.inputs } : {}),
      ...(order !== undefined ? { order } : {}),
      steps,
      events,
    };
  }

  /**
   * What an order's record holds, joined to the flow's own step list. `pick`
   * chooses which steps' bodies are worth fetching — bodies are the expensive
   * part, so callers ask only for what they will return.
   */
  async #loadJourney(
    ref: { session_id: string; transaction_id: string },
    pick: (rows: StepRow[]) => StepRow[],
  ) {
    const session = await this.#session.requireSession(ref.session_id);
    const flow = await this.#flow.status(session.session_id, {
      transactionId: ref.transaction_id,
    });
    const record = await this.#record.findTransaction(
      ref.transaction_id,
      session.np.subscriber_url,
    );

    const exchanges: ExchangeRow[] = (record?.apiList ?? []).flatMap((entry) =>
      entry.entryType === "API"
        ? [
            {
              payloadId: entry.payloadId,
              direction: entry.direction,
              messageId: entry.messageId,
              timestamp: entry.timestamp,
              seq: entry.seq,
              response: entry.response,
              overrides: entry.overrides,
            },
          ]
        : [],
    );

    const stepRows = [...flow.sequence, ...flow.extra_steps].map((step) => ({
      key: step.key,
      action: step.action,
      owner: step.owner,
      status: step.status,
      ack: step.ack,
      payload_ids: step.payload_ids,
    }));
    const withPayloads = stepRows.filter((r) => r.payload_ids[0] !== undefined);

    const bodies = new Map<string, unknown>();
    for (const row of pick(withPayloads)) {
      const id = row.payload_ids[0];
      if (id === undefined) continue;
      bodies.set(id, (await this.#record.requirePayload(id)).body);
    }
    return { session, flow, stepRows, exchanges, bodies, withPayloads };
  }

  /**
   * Every order in a batch, with its order id and amount once the seller has
   * assigned one — the direct answer to "what did batch X actually place".
   * Cheap relative to {@link batchPayloads}: only the last few payloads of
   * each order are read (enough to find the newest one that describes an
   * order), never the whole journey.
   */
  async listOrders(
    input: ListBatchOrdersInput,
  ): Promise<ListBatchOrdersOutput> {
    const meta = await this.#repository.getMeta(input.batch_id);
    if (!meta) throw new NotFoundError("batch run", input.batch_id);

    const [page, total] = await Promise.all([
      this.#repository.listResults(
        input.batch_id,
        input.since_index,
        input.since_index + input.limit - 1,
      ),
      this.#repository.countResults(input.batch_id),
    ]);

    const orders = await Promise.all(
      page.map(async (result): Promise<BatchOrderSummary> => {
        const base = {
          index: result.index,
          transaction_id: result.transaction_id,
          ...(result.session_id !== undefined
            ? { session_id: result.session_id }
            : {}),
          batch_status: result.status,
          ...(result.duration_ms !== undefined
            ? { duration_ms: result.duration_ms }
            : {}),
        };
        if (result.session_id === undefined || result.transaction_id === null) {
          return { ...base, message: result.message };
        }

        const { flow, bodies, withPayloads } = await this.#loadJourney(
          {
            session_id: result.session_id,
            transaction_id: result.transaction_id,
          },
          (rows) => rows.slice(-3),
        );
        const order = summariseOrder(latestOrderPayload(withPayloads, bodies));

        return {
          ...base,
          flow_status: flow.flow_status,
          ...(order?.order_id !== undefined
            ? { order_id: order.order_id }
            : {}),
          ...(order?.order_status !== undefined
            ? { order_status: order.order_status }
            : {}),
          ...(order?.payment_status !== undefined
            ? { payment_status: order.payment_status }
            : {}),
          ...(order?.total !== undefined ? { amount: order.total } : {}),
          ...(order?.currency !== undefined
            ? { currency: order.currency }
            : {}),
          ...(order === undefined ? { message: result.message } : {}),
        };
      }),
    );

    const nextSince = input.since_index + page.length;
    return {
      batch_id: input.batch_id,
      results_total: total,
      orders_returned: orders.length,
      ...(nextSince < total ? { next_since_index: nextSince } : {}),
      orders,
    };
  }

  /**
   * One batch's payloads across all its orders: a single action's call for
   * every order (`actions: ["on_confirm"]`), or every step of every order.
   * Paginated over the batch's results, because a full order is ~85KB.
   */
  async batchPayloads(
    input: GetBatchPayloadsInput,
  ): Promise<GetBatchPayloadsOutput> {
    const meta = await this.#repository.getMeta(input.batch_id);
    if (!meta) throw new NotFoundError("batch run", input.batch_id);

    const [page, total] = await Promise.all([
      this.#repository.listResults(
        input.batch_id,
        input.since_index,
        input.since_index + input.limit - 1,
      ),
      this.#repository.countResults(input.batch_id),
    ]);

    const wanted =
      input.actions !== undefined ? new Set(input.actions) : undefined;
    const orders: GetBatchPayloadsOutput["orders"] = [];
    const skipped: GetBatchPayloadsOutput["skipped"] = [];

    for (const result of page) {
      if (result.session_id === undefined || result.transaction_id === null) {
        skipped.push({
          index: result.index,
          status: result.status,
          reason: "never sent its first call, so it has no payloads",
        });
        continue;
      }
      const { stepRows, exchanges, bodies } = await this.#loadJourney(
        {
          session_id: result.session_id,
          transaction_id: result.transaction_id,
        },
        (rows) =>
          wanted === undefined
            ? rows
            : rows.filter((r) => wanted.has(r.action)),
      );

      const journey = assembleJourney({
        steps: stepRows,
        exchanges,
        bodies,
        maxPayloadBytes: input.max_payload_bytes,
      });
      orders.push({
        index: result.index,
        transaction_id: result.transaction_id,
        session_id: result.session_id,
        batch_status: result.status,
        payloads: journey
          .filter((step) => wanted === undefined || wanted.has(step.action))
          .map((step) => ({
            ...step,
            ...(step.payload !== undefined
              ? { payload: pickParts(step.payload, input.parts) }
              : {}),
          })),
      });
    }

    const nextSince = input.since_index + page.length;
    return {
      batch_id: input.batch_id,
      ...(input.actions !== undefined ? { actions: input.actions } : {}),
      parts: input.parts,
      results_total: total,
      orders_returned: orders.length,
      ...(nextSince < total ? { next_since_index: nextSince } : {}),
      orders,
      skipped,
    };
  }

  async #findResult(
    input: GetOrderLogInput,
  ): Promise<BatchTransactionResult | undefined> {
    const page = 500;
    for (let since = 0; ; since += page) {
      const results = await this.#repository.listResults(
        input.batch_id,
        since,
        since + page - 1,
      );
      const hit = results.find((r) =>
        input.index !== undefined
          ? r.index === input.index
          : r.transaction_id === input.transaction_id,
      );
      if (hit) return hit;
      if (results.length < page) return undefined;
    }
  }

  async #peerStatus(
    peerBatchId: string | undefined,
  ): Promise<PeerBatchStatus | undefined> {
    if (peerBatchId === undefined || !this.#peer) return undefined;
    try {
      const seller = await this.#peer.status(peerBatchId, {
        includeResults: false,
        sinceIndex: 0,
        limit: 1,
      });
      return {
        batch_id: peerBatchId,
        state: seller.state,
        progress: seller.progress,
      };
    } catch (error) {
      return {
        batch_id: peerBatchId,
        state: "unreachable",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async cancel(batchId: string): Promise<CancelBatchRunOutput> {
    const meta = await this.#repository.getMeta(batchId);
    if (!meta) {
      throw new NotFoundError("batch run", batchId);
    }

    this.#cancelled.add(batchId);
    const cancelledAt = new Date().toISOString();

    if (meta.peer !== undefined && this.#peer) {
      await this.#peer.cancel(meta.peer.batch_id).catch((error: unknown) => {
        this.#logger.warn(
          { err: error, batchId },
          "could not cancel the seller side",
        );
      });
    }

    if (meta.state === "running") {
      await this.#repository.updateMeta(batchId, this.#resultTtlMs, {
        state: "cancelled",
        finished_at: cancelledAt,
      });
    }

    this.#logger.info({ batchId }, "batch run cancellation requested");

    return {
      batch_id: batchId,
      state: "cancelled",
      cancelled_at: cancelledAt,
    };
  }

  async #driveAll(
    batchId: string,
    input: StartBatchRunInput,
    journey: ResolvedJourney,
    role: BatchRole,
    counterparty: string,
    identity: {
      ownSubscriberId?: string;
      counterpartySubscriberId?: string;
      receiverPublicUrl?: string;
    },
  ): Promise<void> {
    const tracker = new IssuedPairTracker();
    const total = input.transaction_count;
    let nextIndex = 0;
    const isCancelled = () => this.#cancelled.has(batchId);

    const worker = async (): Promise<void> => {
      for (;;) {
        if (isCancelled()) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= total) return;

        await this.#repository.bumpProgress(
          batchId,
          "in_flight",
          this.#resultTtlMs,
        );

        const inputs =
          role === "initiator"
            ? generateOrderInputs(tracker, {
                ...(input.gps_bounding_box !== undefined
                  ? { boundingBox: input.gps_bounding_box }
                  : {}),
                ...(input.city_codes !== undefined
                  ? { cityCodes: input.city_codes }
                  : {}),
              })
            : undefined;

        // `runOneTransaction` isolates every failure into its own result — it
        // never throws — so no `.catch` is needed here to protect the pool.
        const result = await runOneTransaction(
          {
            session: this.#session,
            flow: this.#flow,
            record: this.#record,
            logger: this.#logger,
          },
          {
            index,
            role,
            domain: input.domain,
            version: input.version,
            usecase: input.usecase,
            flowId: journey.flowId,
            counterpartySubscriberUrl: counterparty,
            ...identity,
            ...(inputs !== undefined ? { inputs } : {}),
            perTransactionTimeoutMs: input.per_transaction_timeout_ms,
            isCancelled,
            flow: journey.flow,
            config: journey.config,
            stepOverrides: journey.stepOverrides,
          },
        );

        await this.#repository.bumpProgress(
          batchId,
          "in_flight",
          this.#resultTtlMs,
          -1,
        );
        await this.#repository.bumpProgress(
          batchId,
          result.status,
          this.#resultTtlMs,
        );
        await this.#repository.appendResult(batchId, result, this.#resultTtlMs);

        if (!TERMINAL_STATUSES.includes(result.status)) {
          this.#logger.warn(
            { batchId, index, status: result.status },
            "batch transaction settled on a non-terminal status",
          );
        }
      }
    };

    const workerCount = Math.max(1, Math.min(input.concurrency, total));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    await this.#repository.updateMeta(batchId, this.#resultTtlMs, {
      state: isCancelled() ? "cancelled" : "completed",
      finished_at: new Date().toISOString(),
    });

    this.#logger.info({ batchId }, "batch run finished");
  }
}

export { BatchRepository };
