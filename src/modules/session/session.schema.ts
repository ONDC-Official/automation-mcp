import { z } from "zod";
import {
  BuildRef,
  FlowSummary,
  NpType,
} from "@/modules/catalog/catalog.schema.js";

/**
 * A session is the anchor for everything that follows: it records **who is
 * being tested** and **which build they are being tested against**, and from
 * the participant's type it derives the role the mock has to play.
 *
 * The inversion is the point. A participant that is a BAP (buyer app) can only
 * be exercised by a counterparty that behaves like a BPP (seller app), and vice
 * versa. Every later step — which payload to produce, which call to wait for,
 * which side signs — reads from `mock_role`, so it is computed once, here, and
 * never asked of the caller.
 *
 * Field naming is `snake_case` to match the ONDC vocabulary the model sees in
 * payloads.
 */

export const NetworkParticipant = z.object({
  subscriber_url: z
    .string()
    .describe("Base URL the participant under test receives callbacks on."),
  subscriber_id: z
    .string()
    .optional()
    .describe("Registry subscriber id, when known."),
  type: NpType.describe(
    "BAP if the participant is a buyer app, BPP if it is a seller app.",
  ),
});
export type NetworkParticipant = z.infer<typeof NetworkParticipant>;

export const Session = z.object({
  session_id: z.string().describe("Identifier for every later call."),
  created_at: z.string().describe("ISO 8601 creation timestamp."),
  expires_at: z.string().describe("ISO 8601 expiry; the session is gone after."),
  np: NetworkParticipant.describe("The participant under test."),
  mock_role: NpType.describe(
    "The role this server plays — always the opposite of the participant's.",
  ),
  build: BuildRef.describe("Domain, version and use-case under test."),
});
export type Session = z.infer<typeof Session>;

/* --------------------------------- create --------------------------------- */

export const CreateSessionInput = z.object({
  subscriber_url: z
    .url()
    .describe(
      "Base URL of the participant under test, e.g. https://bap.example.com.",
    ),
  np_type: NpType.describe(
    "What the participant under test is: BAP (buyer app) or BPP (seller app). The mock takes the opposite role.",
  ),
  domain: z.string().min(1).describe("ONDC domain code, e.g. ONDC:FIS12."),
  version: z.string().min(1).describe("Spec version, e.g. 2.0.3."),
  usecase: z
    .string()
    .min(1)
    .describe(
      "Use-case name exactly as published, e.g. 'PERSONAL LOAN'. Case- and space-sensitive.",
    ),
  subscriber_id: z
    .string()
    .optional()
    .describe("Registry subscriber id of the participant, when known."),
});
export type CreateSessionInput = z.infer<typeof CreateSessionInput>;

export const CreateSessionOutput = z.object({
  session: Session,
  flows: z
    .array(FlowSummary)
    .describe("Every flow published for this build, ready to start."),
  total: z.number().int().describe("Number of flows available."),
});
export type CreateSessionOutput = z.infer<typeof CreateSessionOutput>;

/* ----------------------------------- get ---------------------------------- */

export const GetSessionInput = z.object({
  session_id: z.string().min(1).describe("Session returned by session_create."),
});
export type GetSessionInput = z.infer<typeof GetSessionInput>;

export const GetSessionOutput = z.object({
  session: Session,
});
export type GetSessionOutput = z.infer<typeof GetSessionOutput>;
