import { z } from "zod";
import {
  BuildRef,
  FlowSummary,
  NpType,
} from "@/modules/catalog/catalog.schema.js";
import { EventsField } from "@/modules/record/record.schema.js";

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

/**
 * Who supplies the values a flow asks for, and who fills its forms.
 *
 * `llm_auto` — the caller answers every prompt itself, including fetching a
 * counterparty-hosted form and filling its fields. The loop runs unattended.
 *
 * `manual` — a human is in the loop: the caller relays each request for input
 * to them, and forms are handed over as links to open rather than parsed and
 * posted. Slower, and the only honest mode when the values are real.
 */
export const InteractionMode = z.enum(["llm_auto", "manual"]);
export type InteractionMode = z.infer<typeof InteractionMode>;

export const Session = z.object({
  session_id: z.string().describe("Identifier for every later call."),
  created_at: z.string().describe("ISO 8601 creation timestamp."),
  expires_at: z
    .string()
    .describe("ISO 8601 expiry; the session is gone after."),
  np: NetworkParticipant.describe("The participant under test."),
  mock_role: NpType.describe(
    "The role this server plays — always the opposite of the participant's.",
  ),
  build: BuildRef.describe("Domain, version and use-case under test."),
  interaction_mode: InteractionMode.describe(
    "Who supplies inputs and fills forms for flows in this session.",
  ),
  auto_advance: z
    .boolean()
    .describe(
      "When true, this server chains its own steps as soon as the participant " +
        "answers, pausing only for inputs, forms and errors. Whatever it sends " +
        "is reported as a CHAIN_SENT event on the next tool result.",
    ),
  callback_url: z
    .string()
    .describe(
      "The URI this mock advertises as bap_uri/bpp_uri: " +
        "{base}/{domain}/{version}/{buyer|seller}. Register it as your " +
        "counterparty's subscriber URL. The participant appends /{action} " +
        "itself, as it would for any network participant. Shared by every " +
        "session on the same build and role — inbound calls are matched by " +
        "transaction_id, not by this URL.",
    ),
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
  interaction_mode: InteractionMode.optional().describe(
    "'llm_auto' (default) — you supply every input and fill forms yourself. " +
      "'manual' — a human supplies them; forms come back as links to hand over.",
  ),
  auto_advance: z
    .boolean()
    .optional()
    .describe(
      "Defaults to on for llm_auto sessions and off for manual ones. When on, " +
        "this server sends its own next step as soon as the participant " +
        "answers, instead of waiting to be asked — pausing for inputs, forms " +
        "and errors. You do not see less of the flow: everything sent this way " +
        "comes back as a CHAIN_SENT event on your next tool result. Set it " +
        "false to drive every step yourself.",
    ),
  receiver_public_url: z
    .url()
    .optional()
    .describe(
      "Override the URL advertised for callbacks. Set this to your tunnel " +
        "address (ngrok, cloudflared) whenever the participant is not on this " +
        "machine — otherwise its callbacks go somewhere it cannot reach.",
    ),
});
export type CreateSessionInput = z.infer<typeof CreateSessionInput>;

/**
 * A page the human driving this test can open to watch it happen.
 *
 * On both session outputs and not on `Session` itself, because it is derived
 * from where this process is deployed and from a token that may be minted per
 * process — storing it would leave a link that looks right and no longer works.
 * Absent when the viewer is switched off.
 */
const ViewerUrlField = {
  viewer_url: z
    .string()
    .optional()
    .describe(
      "A page showing this session's flows, payloads and events, live. Give " +
        "it to the person you are testing for — it is the only view they have " +
        "of the run that is not you describing it. Read-only: driving the flow " +
        "is still yours.",
    ),
};

export const CreateSessionOutput = z.object({
  session: Session,
  ...ViewerUrlField,
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
  ...ViewerUrlField,
  ...EventsField,
});
export type GetSessionOutput = z.infer<typeof GetSessionOutput>;
