import type { Logger } from "pino";
import type { Metrics } from "@/lib/metrics/metrics.js";
import type { MockEngine } from "@/lib/mock-engine/mock-engine.js";
import type { ReceiverRole } from "@/modules/catalog/catalog.schema.js";
import type { FlowService } from "@/modules/flow/flow.service.js";
import type { FormsService } from "@/modules/forms/forms.service.js";
import type { RecordService } from "@/modules/record/record.service.js";
import type { SessionService } from "@/modules/session/session.service.js";
import type { ValidateService } from "@/modules/validate/validate.service.js";

/**
 * The shapes the inbound pipeline is written in terms of.
 *
 * Split out so the pipeline's phases — attribute, refuse, persist — can share
 * them without importing each other. `receiver.service.ts` re-exports the lot,
 * so `container.ts` and the routes are untouched.
 */

/** The parts of the URL a call arrived on. */
export interface InboundRequest {
  domain: string;
  version: string;
  /** `buyer` or `seller` — **our** role, since the endpoint is ours. */
  role: ReceiverRole;
  /** From the path. `context.action` is what actually decides the step. */
  action: string;
}

/** What the receiver decided, ready to be written to the wire. */
export interface InboundResult {
  status: number;
  body: unknown;
  /** Set when the call was filed against a transaction. */
  transactionId?: string;
  /** Set when auto-advance should run once the ACK has been written. */
  chain?: { sessionId: string; transactionId: string };
  /**
   * Set when this call may have finished the flow, and nothing else is going
   * to notice. Checked after the ACK, like chaining — and mutually exclusive
   * with it, because `chainNext` reaches `COMPLETE` on its own.
   */
  complete?: { sessionId: string; transactionId: string };
}

export interface ReceiverServiceOptions {
  sessions: SessionService;
  records: RecordService;
  flows: FlowService;
  forms: FormsService;
  mockEngine: MockEngine;
  /** L0 + L1 on what arrives, inside the ACK window. */
  validate: ValidateService;
  logger: Logger;
  /** Optional; absent in unit tests. The verdict is the same either way. */
  metrics?: Metrics;
}

export interface BecknContext {
  action?: unknown;
  message_id?: unknown;
  transaction_id?: unknown;
  timestamp?: unknown;
  bap_uri?: unknown;
  bpp_uri?: unknown;
}

/**
 * What a phase of the inbound pipeline is handed.
 *
 * `ReceiverService` holds **no mutable state at all** — every field is an
 * injected collaborator — which is why each phase is a plain function over
 * this bundle rather than a method. There is nothing for a phase to mutate,
 * and nothing for two phases to disagree about.
 */
export type ReceiverDeps = Readonly<ReceiverServiceOptions>;
