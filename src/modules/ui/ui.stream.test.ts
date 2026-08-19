import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHttpApp, type App } from "@/app.js";
import { parseConfig } from "@/config/env.js";
import { createContainer, type Container } from "@/container.js";
import {
  createFakeConfigServiceGateway,
  createFakeValidationGateway,
} from "@/test/fakes.js";
import { RUNNABLE_BUILD } from "@/test/runnable-config.js";
import type { SessionEvent } from "@/modules/record/record.schema.js";
import { UI_ROUTE_PREFIX } from "@/modules/ui/ui.routes.js";

/**
 * The event stream, over a real socket.
 *
 * `app.inject()` buffers a whole response before returning it, so it cannot
 * observe a stream that has not ended — which is every useful state this route
 * has. So this one binds a port.
 *
 * What is being pinned is that the stream **parks** rather than polls: nothing
 * here waits on a timer, and a frame that arrives promptly is the evidence that
 * the journal's wake-up reached a waiter rather than a sleep expiring.
 */

const NP = "https://np.example.com";
const TOKEN = "test-viewer-token";
const config = parseConfig({
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  UI_TOKEN: TOKEN,
  HOST: "127.0.0.1",
  PORT: "0",
});

let app: App;
let container: Container;
let baseUrl: string;
let sessionId: string;

beforeEach(async () => {
  container = await createContainer(config, {
    configServiceGateway: createFakeConfigServiceGateway(),
    validationGateway: createFakeValidationGateway(),
  });
  app = await buildHttpApp(container, config);
  await app.listen({ port: 0, host: "127.0.0.1" });

  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  baseUrl = `http://127.0.0.1:${String(address.port)}`;

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
  await app.close();
  await container.dispose();
});

/**
 * Read SSE frames until `wanted` of them have arrived, then let go.
 *
 * Deliberately no timer of its own: the test's own timeout is the deadline, and
 * a stream that only delivered because something polled would show up as a slow
 * test rather than passing quietly.
 */
async function readFrames(
  response: Response,
  wanted: number,
): Promise<{ id: string; event: SessionEvent }[]> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no body");

  const decoder = new TextDecoder();
  const frames: { id: string; event: SessionEvent }[] = [];
  let buffer = "";

  while (frames.length < wanted) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split = buffer.indexOf("\n\n");
    while (split !== -1) {
      const chunk = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const id = /^id: (.+)$/m.exec(chunk)?.[1];
      const data = /^data: (.+)$/m.exec(chunk)?.[1];
      if (id !== undefined && data !== undefined) {
        frames.push({ id, event: JSON.parse(data) as SessionEvent });
      }
      split = buffer.indexOf("\n\n");
    }
  }

  await reader.cancel();
  return frames;
}

function open(
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}`, ...headers },
  });
}

describe("the event stream", () => {
  it("delivers a journal line without being polled", async () => {
    const response = await open(
      `${UI_ROUTE_PREFIX}/sessions/${sessionId}/stream`,
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    // Appended after the stream is parked, so the only thing that can deliver
    // it is the wake-up.
    await container.services.record.journal(sessionId, {
      kind: "ATTENTION",
      summary: "something worth reading",
    });

    const [frame] = await readFrames(response, 1);

    expect(frame?.event.kind).toBe("ATTENTION");
    expect(frame?.event.summary).toBe("something worth reading");
    expect(frame?.id).toBe(String(frame?.event.seq));
  });

  it("replays what was already there before parking", async () => {
    await container.services.record.journal(sessionId, {
      kind: "ATTENTION",
      summary: "happened before anyone was watching",
    });

    const response = await open(
      `${UI_ROUTE_PREFIX}/sessions/${sessionId}/stream`,
    );
    const [frame] = await readFrames(response, 1);

    expect(frame?.event.summary).toBe("happened before anyone was watching");
  });

  it("resumes from last-event-id rather than replaying the whole journal", async () => {
    await container.services.record.journal(sessionId, {
      kind: "ATTENTION",
      summary: "first",
    });
    await container.services.record.journal(sessionId, {
      kind: "ATTENTION",
      summary: "second",
    });

    const seen = await container.services.record.readEvents(sessionId, 0);
    const firstSeq = seen[0]?.seq ?? 0;

    const response = await open(
      `${UI_ROUTE_PREFIX}/sessions/${sessionId}/stream`,
      { "last-event-id": String(firstSeq) },
    );
    const [frame] = await readFrames(response, 1);

    expect(frame?.event.summary).toBe("second");
  });

  it("never consumes the model's cursor", async () => {
    const before = await container.services.record.eventCursor(sessionId);

    const response = await open(
      `${UI_ROUTE_PREFIX}/sessions/${sessionId}/stream`,
    );
    await container.services.record.journal(sessionId, {
      kind: "ATTENTION",
      summary: "watched, not consumed",
    });
    await readFrames(response, 1);

    expect(await container.services.record.eventCursor(sessionId)).toBe(before);
    // `contains`, not `last`: an ATTENTION line opens an incident, and the
    // corpus journals its own `ISSUE_OPEN` nudge behind it.
    const delta = await container.services.record.drainEvents(sessionId);
    expect(delta?.events.map((event) => event.summary)).toContain(
      "watched, not consumed",
    );
  });

  it("refuses an unknown session before opening a stream nobody can close", async () => {
    const response = await open(`${UI_ROUTE_PREFIX}/sessions/nope/stream`);

    expect(response.status).toBe(404);
    await response.body?.cancel();
  });

  it("refuses without a token", async () => {
    const response = await fetch(
      `${baseUrl}${UI_ROUTE_PREFIX}/sessions/${sessionId}/stream`,
    );

    expect(response.status).toBe(401);
    await response.body?.cancel();
  });
});
