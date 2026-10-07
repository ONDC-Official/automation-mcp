import type { SessionEvent } from "@/modules/record/record.schema.js";
import type { SessionEventObserver } from "@/modules/record/record.service.js";

/**
 * Tells the batch service when a seller's `on_status` lands, so an order that
 * was still ACTIVE when its flow finished is sent the moment it becomes
 * COMPLETED.
 *
 * It is a journal observer, so it sees every inbound acknowledgement as it is
 * recorded. The target is attached after the batch service exists, because the
 * record service — which owns the observer list — is built first.
 */
export class OrderStatusWatch implements SessionEventObserver {
  #onSellerStatus:
    ((sessionId: string, transactionId: string) => void) | undefined;

  attach(
    onSellerStatus: (sessionId: string, transactionId: string) => void,
  ): void {
    this.#onSellerStatus = onSellerStatus;
  }

  onSessionEvent(sessionId: string, event: SessionEvent): void {
    if (
      event.kind !== "INBOUND_ACK" ||
      event.action !== "on_status" ||
      event.transaction_id === undefined
    ) {
      return;
    }
    try {
      this.#onSellerStatus?.(sessionId, event.transaction_id);
    } catch {
      // Observers must never throw into the receiver's path; a missed check is
      // retried by the next on_status for the same order.
    }
  }
}
