import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { parseConfig } from "@/config/env.js";
import {
  createContainer,
  type Container,
  type CreateContainerOptions,
} from "@/container.js";
import { NoopSink } from "@/modules/feedback/feedback.sink.js";
import { NoopMirrorSink } from "@/modules/mirror/mirror.sink.js";
import { buildMcpServer } from "@/mcp/server.js";
import {
  createFakeConfigServiceGateway,
  createFakeValidationGateway,
} from "@/test/fakes.js";

/**
 * In-process client ↔ server harness — the MCP analogue of `app.inject()`.
 *
 * A real `Client` speaks to a real `McpServer` over a linked in-memory
 * transport, so tests exercise genuine protocol framing (schema validation,
 * result envelopes, error codes) with no socket and no subprocess.
 *
 * The config-service gateway defaults to a fixture-backed fake, so no test can
 * reach the network by forgetting to inject one. Pass your own to control what
 * the catalog returns.
 */

export interface Harness {
  readonly client: Client;
  readonly container: Container;
  close(): Promise<void>;
}

/**
 * The text of a resource read. Resource contents are a `text | blob` union, so
 * every assertion would otherwise need the same narrowing.
 */
export function resourceText(result: {
  contents: ({ text: string } | { blob: string })[];
}): string {
  const [content] = result.contents;
  if (content && "text" in content) return content.text;
  throw new Error("expected a text resource content block");
}

export async function createHarness(
  options: CreateContainerOptions = {},
): Promise<Harness> {
  const config = parseConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });
  const container = await createContainer(config, {
    configServiceGateway: createFakeConfigServiceGateway(),
    // Like the config-service fake: the default must never reach the network.
    // A suite whose result depends on a remote validator is a suite that fails
    // for reasons unrelated to the change under test.
    validationGateway: createFakeValidationGateway(),
    // Same rule, one step further: no test may write an issue report to the
    // operator's home directory. `createContainer` refuses to build a real
    // spool under `NODE_ENV=test` as well — two guards, because this one is
    // bypassed by any test that builds a container directly.
    feedbackSink: new NoopSink(),
    // Same rule again: no test may open a socket to a mirror ingest. Pass your
    // own `NoopMirrorSink` to assert on what would have been streamed.
    mirrorSink: new NoopMirrorSink(),
    ...options,
  });
  const server = buildMcpServer(container);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "test-client", version: "0.0.0" });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    container,
    async close(): Promise<void> {
      await client.close();
      await server.close();
      await container.dispose();
    },
  };
}
