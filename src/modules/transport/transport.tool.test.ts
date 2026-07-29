import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "@/config/env.js";
import { createContainer, type Container } from "@/container.js";
import { createFakeConfigServiceGateway } from "@/test/fakes.js";
import { createHarness, type Harness } from "@/test/harness.js";
import { RUNNABLE_BUILD } from "@/test/runnable-config.js";

/**
 * The receiver's control surface.
 *
 * The reachability note is the substance here. A loopback callback URL is
 * correct for a participant on the same machine and useless for anything else,
 * and the failure it causes — the participant simply never calls back — reads
 * like a bug on their side. Saying it out loud, every time, is the fix.
 */

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.close();
});

describe("receiver_start", () => {
  it("reports the mounted receiver under the HTTP transport", async () => {
    const result = await harness.client.callTool({
      name: "receiver_start",
      arguments: {},
    });

    expect(result.structuredContent).toMatchObject({
      running: false, // not mounted: this harness builds no HTTP app
      mode: "mounted",
    });
    expect((result.structuredContent as { base_url: string }).base_url).toMatch(
      /^http:\/\//,
    );
  });

  it("warns when the advertised address is loopback", async () => {
    const result = await harness.client.callTool({
      name: "receiver_start",
      arguments: {},
    });

    const note = (result.structuredContent as { reachability_note: string })
      .reachability_note;
    expect(note).toContain("loopback");
    expect(note).toContain("RECEIVER_PUBLIC_URL");
  });

  it("returns the exact callback URL for a session", async () => {
    const created = await harness.client.callTool({
      name: "session_create",
      arguments: {
        subscriber_url: "https://np.example.com",
        np_type: "BPP",
        domain: RUNNABLE_BUILD.domain,
        version: RUNNABLE_BUILD.version,
        usecase: RUNNABLE_BUILD.usecase,
      },
    });
    const sessionId = (
      created.structuredContent as { session: { session_id: string } }
    ).session.session_id;

    const result = await harness.client.callTool({
      name: "receiver_start",
      arguments: { session_id: sessionId },
    });

    // np_type BPP ⇒ the mock is a BAP ⇒ it advertises the `buyer` URI.
    expect(
      (result.structuredContent as { callback_url: string }).callback_url,
    ).toBe(
      `http://127.0.0.1:3000/${RUNNABLE_BUILD.domain}/${RUNNABLE_BUILD.version}/buyer`,
    );
  });

  it("is idempotent", async () => {
    const first = await harness.client.callTool({
      name: "receiver_start",
      arguments: {},
    });
    const second = await harness.client.callTool({
      name: "receiver_start",
      arguments: {},
    });

    expect(second.structuredContent).toEqual(first.structuredContent);
  });
});

describe("receiver_stop", () => {
  it("explains itself rather than failing under HTTP", async () => {
    const result = await harness.client.callTool({
      name: "receiver_stop",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ stopped: false });
    expect((result.structuredContent as { reason: string }).reason).toContain(
      "mounted",
    );
  });
});

describe("the standalone receiver (stdio transport)", () => {
  let container: Container;

  afterEach(async () => {
    await container.dispose();
  });

  it("binds a port of its own, serves callbacks, and releases it", async () => {
    // On stdio there is no HTTP server at all until one is asked for — a
    // client that only browses the catalog never opens a port.
    const config = parseConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      // 0 asks the OS for any free port, so the test cannot collide.
      RECEIVER_PORT: "0",
    });
    container = await createContainer(config, {
      configServiceGateway: createFakeConfigServiceGateway(),
      transport: "stdio",
    });

    expect(container.receiver.status()).toMatchObject({
      running: false,
      mode: "standalone",
    });

    const started = await container.receiver.start(container);
    expect(started.running).toBe(true);

    const stopped = await container.receiver.stop();
    expect(stopped.stopped).toBe(true);
    expect(container.receiver.status().running).toBe(false);
  });
});
