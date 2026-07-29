import type { Container } from "@/container.js";
import { defineTool, type Registerable } from "@/lib/define-tool.js";
import {
  ReceiverStartInput,
  ReceiverStartOutput,
  ReceiverStopInput,
  ReceiverStopOutput,
} from "@/modules/transport/transport.schema.js";

/**
 * Bringing the mock's inbound endpoint up, and saying where it is.
 *
 * The reachability note is deliberately prominent. A loopback callback URL is
 * correct for a participant on the same machine and useless for anything else,
 * and the failure mode — the participant simply never calls back — reads like a
 * bug in the participant. Saying it up front, every time, is cheaper than
 * diagnosing it later.
 */
export function createTransportTools(container: Container): Registerable[] {
  const { receiver } = container;

  return [
    defineTool({
      name: "receiver_start",
      title: "Start the inbound receiver",
      description:
        "Make sure this mock can receive the participant's callbacks, and " +
        "report the URL it must use. Call it once before session_create. " +
        "Under the HTTP transport the receiver is already mounted and this " +
        "just reports the address; on stdio it binds a listener. Safe to call " +
        "repeatedly. The address must be reachable *from the participant* — " +
        "for a remote participant, set RECEIVER_PUBLIC_URL (or the session's " +
        "receiver_public_url) to a tunnel address instead.",
      inputSchema: ReceiverStartInput,
      outputSchema: ReceiverStartOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      render: (output) =>
        [
          `receiver ${output.running ? "running" : "not running"} (${output.mode})`,
          `  base:     ${output.base_url}`,
          ...(output.callback_url !== undefined
            ? [`  callback: ${output.callback_url}`]
            : []),
          `  ${output.reachability_note}`,
        ].join("\n"),
      handler: async (input) => {
        const status = await receiver.start(container);

        let callbackUrl: string | undefined;
        if (input.session_id !== undefined) {
          const session = await container.services.session.requireSession(
            input.session_id,
          );
          callbackUrl = session.callback_url;
        }

        const loopback =
          /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)/i.test(
            status.baseUrl,
          );

        return {
          running: status.running,
          mode: status.mode,
          base_url: status.baseUrl,
          ...(callbackUrl !== undefined ? { callback_url: callbackUrl } : {}),
          ...(status.port !== undefined ? { port: status.port } : {}),
          reachability_note: loopback
            ? "This is a loopback address: only a participant on this machine can reach it. " +
              "For anything else, expose a tunnel and set RECEIVER_PUBLIC_URL to it."
            : "Confirm the participant can actually reach this address before starting a flow.",
        };
      },
    }),

    defineTool({
      name: "receiver_stop",
      title: "Stop the inbound receiver",
      description:
        "Close the standalone inbound listener. Only meaningful on the stdio " +
        "transport; under HTTP the receiver shares this server's port and " +
        "stops with it, and this explains that rather than failing.",
      inputSchema: ReceiverStopInput,
      outputSchema: ReceiverStopOutput,
      annotations: {
        readOnlyHint: false,
        // Stops accepting the participant's callbacks — a flow mid-transaction
        // will lose them.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      render: ({ stopped, reason }) =>
        `${stopped ? "receiver stopped" : "receiver not stopped"} — ${reason}`,
      handler: () => receiver.stop(),
    }),
  ];
}
