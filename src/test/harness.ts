import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { parseConfig } from "@/config/env.js";
import {
  createContainer,
  type Container,
  type CreateContainerOptions,
} from "@/container.js";
import { buildMcpServer } from "@/mcp/server.js";
import { createFakeConfigServiceGateway } from "@/test/fakes.js";

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
