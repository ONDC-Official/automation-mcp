import { z } from "zod";

/**
 * The receiver's own control surface.
 *
 * Small, but not optional: the single most common way for a mock-NP session to
 * fail is that the participant's callbacks go somewhere unreachable, and by the
 * time that shows up it looks like the participant is simply not answering.
 * `receiver_start` exists so the callback URL is stated out loud, early, before
 * anything is sent.
 */

export const ReceiverStartInput = z.object({
  session_id: z
    .string()
    .optional()
    .describe(
      "Include a session to get its exact callback URL back. Omit for just the base URL.",
    ),
});
export type ReceiverStartInput = z.infer<typeof ReceiverStartInput>;

export const ReceiverStartOutput = z.object({
  running: z.boolean(),
  mode: z
    .enum(["mounted", "standalone"])
    .describe(
      "'mounted' — the receiver shares this server's HTTP port. " +
        "'standalone' — a listener of its own, started for the stdio transport.",
    ),
  base_url: z
    .string()
    .describe("Base URL the participant must be able to reach."),
  callback_url: z
    .string()
    .optional()
    .describe(
      "The exact URL for the given session. Give this to the participant as " +
        "its counterparty subscriber URL.",
    ),
  port: z.number().int().optional(),
  reachability_note: z
    .string()
    .describe(
      "What to check before assuming the participant can reach this address.",
    ),
});
export type ReceiverStartOutput = z.infer<typeof ReceiverStartOutput>;

export const ReceiverStopInput = z.object({});
export type ReceiverStopInput = z.infer<typeof ReceiverStopInput>;

export const ReceiverStopOutput = z.object({
  stopped: z.boolean(),
  reason: z.string(),
});
export type ReceiverStopOutput = z.infer<typeof ReceiverStopOutput>;
