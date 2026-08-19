import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { parseConfig } from "@/config/env.js";
import { createContainer, type Container } from "@/container.js";
import {
  createFakeConfigServiceGateway,
  createFakeValidationGateway,
} from "@/test/fakes.js";
import { acceptsAction } from "@/test/mock-participant.js";
import { RUNNABLE_BUILD, RUNNABLE_FLOW_ID } from "@/test/runnable-config.js";

/**
 * What the viewer page expects, transcribed from the other side.
 *
 * ## Why this exists
 *
 * The page lives in `ONDC-Official/automation-frontend` and renders our step
 * map with components written against **its** types, not ours. That contract
 * breaks silently: a field we stop sending does not fail a build or raise a
 * 500 — the page renders an empty step list, and the obvious conclusion is that
 * the engine is broken. There is nothing in either repo that would catch it.
 *
 * ## Why the schemas below are transcribed and not imported
 *
 * Importing the frontend's types would make this test true by construction and
 * assert nothing. These are a **literal transcription** of
 * `frontend/src/types/flow-state-type.ts` on `main-tech` — the point is for the
 * two to be independently maintained, so a drift on either side shows up here.
 * When the page's types change, change these to match and watch what fails.
 *
 * The same trick, for the same reason, as the mirror's envelope contract test
 * in `../automation-monitoring-dashboard`
 * (`backend/src/mcp/modules/ingest/telemetry.contract.test.ts`), which
 * transcribes our `MirrorBatch` from the other side.
 */

/** `ReducedApiData`, verbatim. */
const PageReducedApiData = z.object({
  entryType: z.literal("API"),
  action: z.string(),
  messageId: z.string(),
  timestamp: z.string(),
  subStatus: z.enum(["SUCCESS", "ERROR"]),
  payloads: z.array(z.object({ payloadId: z.string(), response: z.unknown() })),
});

/** `ReduceFormData`, verbatim. */
const PageReduceFormData = z.object({
  entryType: z.literal("FORM"),
  formType: z.enum(["HTML_FORM", "HTML_FORM_MULTI", "RES_FROM"]),
  formId: z.string(),
  submissionId: z.string().optional(),
  timestamp: z.string(),
  subStatus: z.enum(["SUCCESS", "ERROR"]).optional(),
});

/** `MappedStep`, verbatim. */
const PageMappedStep = z.object({
  status: z.enum([
    "COMPLETE",
    "LISTENING",
    "RESPONDING",
    "WAITING",
    "INPUT-REQUIRED",
    "PROCESSING",
    "WAITING-SUBMISSION",
  ]),
  actionId: z.string(),
  owner: z.enum(["BAP", "BPP"]),
  actionType: z.string(),
  input: z.unknown().optional(),
  payloads: z.union([PageReducedApiData, PageReduceFormData]).optional(),
  index: z.number(),
  description: z.string().optional(),
  unsolicited: z.boolean(),
  pairActionId: z.string().nullable(),
  expect: z.boolean().optional(),
  missedStep: z.boolean().optional(),
  label: z.string().optional(),
  force_proceed: z.boolean().optional(),
  isExtraStep: z.boolean().optional(),
  awaitingMessageId: z.string().optional(),
});

/** `FlowMap`, verbatim. */
const PageFlowMap = z.object({
  sequence: z.array(PageMappedStep),
  missedSteps: z.array(PageMappedStep),
  extraSteps: z.array(PageMappedStep).optional(),
  reference_data: z.record(z.string(), z.unknown()).optional(),
});

/** `PayloadResponse<TReq, TRes>`, verbatim. */
const PagePayloadResponse = z.object({
  req: z.unknown(),
  res: z.object({ response: z.unknown() }),
});

const NP = "https://np.example.com";
const config = parseConfig({
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  UI_TOKEN: "test-viewer-token",
});

let container: Container;
let agent: MockAgent;
let sessionId: string;

beforeEach(async () => {
  agent = new MockAgent();
  agent.disableNetConnect();
  container = await createContainer(config, {
    configServiceGateway: createFakeConfigServiceGateway(),
    validationGateway: createFakeValidationGateway(),
    senderDispatcher: agent,
  });

  const created = await container.services.session.createSession({
    subscriber_url: NP,
    np_type: "BPP",
    domain: RUNNABLE_BUILD.domain,
    version: RUNNABLE_BUILD.version,
    usecase: RUNNABLE_BUILD.usecase,
  });
  sessionId = created.session.session_id;
});

afterEach(async () => {
  await container.dispose();
  await agent.close();
});

/**
 * Round-trip through JSON.
 *
 * The page never sees the object this process holds; it sees what survived
 * serialisation. A `Map`, a `Date` or an `undefined` inside an array all read
 * fine in a unit test and differently on the wire.
 */
function asWire<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("the flow map the page renders", () => {
  it("satisfies the page's FlowMap before anything has been sent", async () => {
    await container.services.flow.start({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      autoAdvance: false,
    });

    const view = await container.ui.flow(sessionId, RUNNABLE_FLOW_ID);

    expect(() => PageFlowMap.parse(asWire(view.map))).not.toThrow();
  });

  it("satisfies it once a step has crossed the wire and carries handles", async () => {
    acceptsAction(agent, NP, "search");
    await container.services.flow.start({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      autoAdvance: false,
    });
    await container.services.flow.proceed({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
    });

    const view = await container.ui.flow(sessionId, RUNNABLE_FLOW_ID);
    const map = PageFlowMap.parse(asWire(view.map));

    const done = map.sequence.find((step) => step.status === "COMPLETE");
    expect(done).toBeDefined();
    // The page reads `payloads.payloads[].payloadId` to fetch a body on click.
    // Losing `entryType` is the specific regression that renders an empty
    // inspector rather than an error.
    expect(done?.payloads?.entryType).toBe("API");
    if (done?.payloads?.entryType === "API") {
      expect(done.payloads.payloads[0]?.payloadId).toBeTruthy();
      expect(done.payloads.subStatus).toBe("SUCCESS");
    }
  });

  it("keeps `pairActionId` null rather than dropping it", async () => {
    // `getOrderedSteps` pairs on this field and treats `undefined` as
    // "unpaired" only because `null` reads the same way in JS — but the page's
    // type says `string | null`, and an absent key is neither.
    await container.services.flow.start({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      autoAdvance: false,
    });

    const view = await container.ui.flow(sessionId, RUNNABLE_FLOW_ID);
    const wire = asWire(view.map) as { sequence: Record<string, unknown>[] };

    for (const step of wire.sequence) {
      expect(step).toHaveProperty("pairActionId");
    }
  });
});

describe("the payload the page fetches on click", () => {
  it("satisfies the page's PayloadResponse", async () => {
    acceptsAction(agent, NP, "search");
    await container.services.flow.start({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
      autoAdvance: false,
    });
    await container.services.flow.proceed({
      sessionId,
      flowId: RUNNABLE_FLOW_ID,
    });

    const view = await container.ui.flow(sessionId, RUNNABLE_FLOW_ID);
    const entry = view.map.sequence[0]?.payloads;
    const payloadId =
      entry?.entryType === "API" ? entry.payloads[0]?.payloadId : undefined;

    const payload = await container.ui.payload(sessionId, payloadId ?? "");

    expect(() => PagePayloadResponse.parse(asWire(payload))).not.toThrow();
  });
});
