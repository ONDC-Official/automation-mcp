import { z } from "zod";
import {
  BuildRef,
  FlowSummary,
  NpType,
} from "@/modules/catalog/catalog.schema.js";
import type { FlowMap } from "@/modules/flow/engine/engine-types.js";
import { FlowStatus, OutcomeKind } from "@/modules/flow/flow.schema.js";
import { Direction, SessionEvent } from "@/modules/record/record.schema.js";
import { InteractionMode } from "@/modules/session/session.schema.js";

/**
 * What the viewer page is allowed to see.
 *
 * These are response schemas in the ordinary sense — `serializerCompiler` uses
 * them to serialise, so a field absent here does not reach the wire. That is
 * the point: this surface is reachable by a browser and answers with the
 * participant's payloads, so what leaves is stated rather than inherited from
 * whatever a service happened to return.
 *
 * ## The one deliberate hole: `map`
 *
 * `FlowMap` is passed through unmodelled. Restating it in zod would create a
 * *second* definition of a type `flow/engine/` holds as a near-verbatim port of
 * the workbench's mapper — and `CLAUDE.md` asks that port to stay diffable, so
 * a fix landing upstream can be replayed here by eye. A zod mirror would drift
 * from it silently, and worse: an object schema **strips keys it does not
 * know**, so the drift would show up as a field quietly missing from the page
 * rather than as a type error. `ui.contract.test.ts` is what checks this shape
 * instead, against a literal transcription of what the page expects.
 */

/** Types-for-us, bytes-through-untouched. See the header. */
const verbatim = <T>() => z.custom<T>(() => true);

export const UiSession = z.object({
  session_id: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  np: z.object({
    subscriber_url: z.string(),
    subscriber_id: z.string().optional(),
    type: NpType,
  }),
  mock_role: NpType,
  build: BuildRef,
  interaction_mode: InteractionMode,
  auto_advance: z.boolean(),
  callback_url: z.string(),
});
export type UiSession = z.infer<typeof UiSession>;

/**
 * One run, summarised for a list.
 *
 * `steps_complete / steps_total` rather than a percentage, because the page
 * renders both a bar and a count and deriving one from the other loses the
 * count. `error` is set when a run could not be read at all — a config the
 * catalog can no longer serve, most often — so one broken run cannot blank the
 * whole list.
 */
export const UiRun = z.object({
  flow_id: z.string(),
  transaction_id: z.string().nullable(),
  attempt: z.number().int(),
  started_at: z.string(),
  auto_advance: z.boolean(),
  flow_status: FlowStatus.optional(),
  steps_total: z.number().int().optional(),
  steps_complete: z.number().int().optional(),
  next_outcome: OutcomeKind.optional(),
  next_message: z.string().optional(),
  error: z.string().optional(),
});
export type UiRun = z.infer<typeof UiRun>;

export const UiSessionListResponse = z.object({
  sessions: z.array(UiSession),
});

export const UiSessionResponse = z.object({
  session: UiSession,
  /** Every flow published for this build, whether or not a run exists. */
  flows: z.array(FlowSummary),
  runs: z.array(UiRun),
  transaction_ids: z.array(z.string()),
  /** Journal position, so a stream can pick up exactly where a read stopped. */
  seq: z.number().int(),
});

export const UiFlowResponse = z.object({
  transaction_id: z.string().nullable(),
  flow_id: z.string(),
  flow_status: FlowStatus,
  mock_role: NpType,
  attempt: z.number().int(),
  abandoned: z
    .object({
      at: z.string(),
      attempt: z.number().int(),
      reason: z.string().optional(),
    })
    .optional(),
  seq: z.number().int(),
  attention: z
    .object({
      kind: z.string(),
      message: z.string(),
      step_key: z.string().optional(),
      at: z.string(),
    })
    .optional(),
  next: z.object({
    outcome: OutcomeKind,
    message: z.string(),
    step_key: z.string().optional(),
    action: z.string().optional(),
    expected_action: z.string().optional(),
    reason: z.string().optional(),
  }),
  reference_data_keys: z.array(z.string()),
  /** The engine's own `FlowMap`. See this file's header. */
  map: verbatim<FlowMap>(),
});

/**
 * One payload, in the shape the page's step card already reads.
 *
 * `req` / `res.response` is the workbench's `PayloadResponse`, and matching it
 * is why the existing card needs no new branch: `req` is the protocol payload
 * that crossed the wire in whichever direction, `res.response` is the
 * synchronous ACK/NACK exchanged for it. Everything above those two keys is
 * additive.
 */
export const UiPayloadResponse = z.object({
  payload_id: z.string(),
  transaction_id: z.string(),
  action: z.string(),
  direction: Direction,
  message_id: z.string(),
  timestamp: z.string(),
  http_status: z.number().int().optional(),
  req: z.unknown(),
  res: z.object({ response: z.unknown() }),
});

export const UiDataResponse = z.object({
  transaction_id: z.string(),
  data: z.record(z.string(), z.unknown()),
});

export const UiEventsResponse = z.object({
  events: z.array(SessionEvent),
  /** Highest seq in `events`, or the caller's cursor when nothing was new. */
  seq: z.number().int(),
});
