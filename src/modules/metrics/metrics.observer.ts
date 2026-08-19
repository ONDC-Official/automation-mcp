import type { Metrics } from "@/lib/metrics/metrics.js";
import type { SessionEvent } from "@/modules/record/record.schema.js";
import type { SessionEventObserver } from "@/modules/record/record.service.js";

/**
 * Counters, read off the session journal.
 *
 * ## Why the journal rather than eight call sites
 *
 * Everything noteworthy already goes through `RecordService#journal` — that is
 * the guarantee the journal was built to make ("if the model is told, the
 * corpus is told"). Counting there means the wire counters cost one observer
 * instead of a `metrics` parameter threaded through the receiver, the sender,
 * the flow service and the forms service, and it means a new journal kind is
 * counted the day it is added rather than the day somebody remembers.
 *
 * What the journal genuinely **cannot** see is duration — a line says a call
 * was ACKed, not how long the participant's socket was held open — and the
 * moments that are not journaled at all (a run opening, a config-service
 * fetch, a sandbox execution). Those are the only places that hold a `Metrics`
 * directly.
 *
 * ## The observer contract, restated
 *
 * `SessionEventObserver` requires this to return promptly and never throw, and
 * these are `Counter#inc` calls, which is about as prompt as a method gets.
 * `RecordService` catches per-observer anyway, so a throw here would cost the
 * corpus nothing — but it would cost this observer the rest of *its* feed, and
 * silence is the failure mode a metrics tap must not have.
 *
 * It journals nothing, so it needs no equivalent of `FeedbackService`'s
 * `ISSUE_OPEN` recursion guard.
 */

/** Prometheus wants every series to carry the same label set. */
const ABSENT = "";

export class MetricsObserver implements SessionEventObserver {
  readonly #metrics: Metrics;

  constructor(metrics: Metrics) {
    this.#metrics = metrics;
  }

  onSessionEvent(_sessionId: string, event: SessionEvent): void {
    // Bounded, not trusted: on the inbound side this is `context.action` from a
    // caller nothing authenticates. `flow_id` is a published catalog
    // coordinate — tens of them per build, and ours — so it needs no cap.
    const action =
      event.action !== undefined ? this.#metrics.action(event.action) : ABSENT;
    const flowId = event.flow_id ?? ABSENT;

    switch (event.kind) {
      case "INBOUND_ACK":
        this.#metrics.inboundCalls.inc({
          action,
          ack: "ACK",
          nack_code: ABSENT,
        });
        return;

      case "INBOUND_NACK":
        this.#metrics.inboundCalls.inc({
          action,
          ack: "NACK",
          // Our own enum — `OUT_OF_SEQUENCE`, `WRONG_ENDPOINT`, and a dozen
          // more — so it needs no cardinality bound.
          nack_code: event.nack_code ?? ABSENT,
        });
        return;

      case "OUTBOUND_SENT":
      case "CHAIN_SENT":
        // A chained send and an explicit one are the same thing on the wire,
        // and the distinction the journal draws — "you were not watching" — is
        // for the model, not for an operator's dashboard.
        this.#metrics.outboundSends.inc({
          action,
          outcome: event.ack ?? "UNKNOWN",
        });
        return;

      case "TRANSACTION_BOUND":
        this.#metrics.flowRuns.inc({ flow_id: flowId, status: "bound" });
        return;

      case "FLOW_COMPLETE":
        this.#metrics.flowRuns.inc({ flow_id: flowId, status: "complete" });
        return;

      case "FLOW_RESTARTED":
        this.#metrics.flowRuns.inc({ flow_id: flowId, status: "restarted" });
        return;

      default:
        // Every other kind is narrative — a chain pause, a re-armed
        // expectation, an attention note. Countable, but nothing here is a
        // question an operator asks in a time series.
        return;
    }
  }
}
