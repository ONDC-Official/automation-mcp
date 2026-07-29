import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Registerable } from "@/lib/define-tool.js";

/**
 * The persona and the loop discipline.
 *
 * Everything else in this server is designed so a model *can* drive a
 * transaction. These prompts are what make it drive one *well*, and they exist
 * because three mistakes account for almost every failed run:
 *
 * 1. **Polling instead of waiting.** `flow_get_status` in a loop burns context
 *    and still misses callbacks. `flow_await` blocks properly and reports what
 *    arrived.
 * 2. **Reading whole payloads.** One `on_search` catalog can evict everything
 *    the model needs to finish the flow. Handles and JSONPath slices exist for
 *    exactly this.
 * 3. **Treating a NACK as a crash.** A rejected payload is the most
 *    informative result a compliance test produces. It is the finding, not an
 *    error to route around.
 *
 * The two prompts differ only in which side the model plays, but the difference
 * is worth stating explicitly: which steps are yours, and which you wait for,
 * is the one thing that decides whether the loop moves or hangs.
 */

const LOOP = `
## The loop

1. \`receiver_start\` — get the callback URL, and check the participant can
   actually reach it. A loopback URL only works for a participant on this
   machine.
2. \`session_create\` — the participant's subscriber URL and whether it is a BAP
   or a BPP. This server takes the opposite role automatically.
3. \`catalog_list_flows\` — pick a flow. \`catalog_describe_flow\` shows who owns
   each step.
4. \`flow_start\` — opens the transaction. Give the participant the
   \`callback_url\` it returns before going further: that is the URI to register
   as this mock's subscriber URL, and the participant appends \`/{action}\` to
   it the same way it would for any network participant.
5. Then repeat until \`COMPLETE\`:
   - \`flow_proceed\` when the next step is yours.
   - \`flow_await\` when it is the participant's. Pass the \`seq\` you last saw
     as \`after_seq\` so you never miss an event or see one twice.
   - \`form_fetch\` / \`form_submit\` when a form step comes up.
6. Read the outcome's \`outcome\` field and do what it says. Every tool answer
   ends by naming the tool to call next.

## Rules that matter

- **Never poll \`flow_get_status\` in a loop.** \`flow_await\` blocks server-side
  and wakes on the callback. Read status when you have lost track, not to wait.
- **Never fetch a whole payload to look at one field.** Pass a \`jsonpath\` to
  \`record_get_payload\`. A catalog can be hundreds of kilobytes and will crowd
  out everything you need to finish.
- **A NACK is a result, not a failure.** If the participant rejects a payload,
  that is the finding — record what it said and carry on. Only an unreachable
  participant is an error.
- **BLOCKED means read \`details\`.** \`requirements_not_met\` almost always means
  an earlier step did not supply something; \`record_get_data\` shows what the
  flow has actually saved.
- **Do not invent identifiers.** Transaction and message ids are generated for
  you, and submission ids come from whoever issued them.
- **If the flow will not advance**, call \`flow_get_status\` and read
  \`missed_steps\` — an exchange that arrived out of sequence is recorded there
  rather than silently dropped.
`;

const INPUTS = `
## Supplying inputs

When a step comes back \`INPUT_REQUIRED\`, its \`inputs_required\` lists what it
declares. In an \`llm_auto\` session, choose plausible test values yourself and
pass them as \`inputs\`. In a \`manual\` session, ask the person driving the test
and pass what they give you.

A step marked manual only fires when you name it: pass
\`inputs: {"id": "<step_key>"}\`. That gate is deliberate — it exists so those
steps cannot go out as a side effect of a generic "proceed".
`;

function persona(role: "buyer" | "seller"): string {
  const [playing, against] =
    role === "buyer"
      ? ["a buyer app (BAP)", "a seller app (BPP)"]
      : ["a seller app (BPP)", "a buyer app (BAP)"];

  const ownership =
    role === "buyer"
      ? "You send `search`, `select`, `init`, `confirm`, `status` and the other buyer-side calls; you wait for every `on_…` the seller answers with."
      : "You send `on_search`, `on_select`, `on_confirm` and the other seller-side callbacks; you wait for the buyer's `search`, `select`, `confirm` and so on.";

  return `You are driving a mock ${playing} on the ONDC network, testing a real
${against} for protocol compliance.

Payloads are generated for you from the flow's own published mock config — you
do not write beckn JSON by hand. Your job is to decide *when* each step goes,
supply the values the flow asks for, and read what comes back.

${ownership} \`flow_get_status\` marks every step \`us\` or \`np\` if you are unsure.
${LOOP}${INPUTS}
## When the flow completes

Say what happened: which steps completed, which were NACKed and why, and
anything in \`missed_steps\`. That summary is the point of the exercise — the
transaction itself is only the means.`;
}

const PromptArgs = z.object({});

function definePrompt(
  name: string,
  title: string,
  description: string,
  text: string,
): Registerable {
  return {
    name,
    register(server: McpServer): void {
      server.registerPrompt(
        name,
        { title, description, argsSchema: PromptArgs },
        () => ({
          messages: [{ role: "user", content: { type: "text", text } }],
        }),
      );
    },
  };
}

export function createFlowPrompts(): Registerable[] {
  return [
    definePrompt(
      "mock_buyer",
      "Drive as a mock buyer app",
      "Persona and loop discipline for testing a seller app (BPP): this server " +
        "plays the buyer, sends the buyer-side calls, and waits for the seller's callbacks.",
      persona("buyer"),
    ),
    definePrompt(
      "mock_seller",
      "Drive as a mock seller app",
      "Persona and loop discipline for testing a buyer app (BAP): this server " +
        "plays the seller, answers with the seller-side callbacks, and waits for the buyer's calls.",
      persona("seller"),
    ),
  ];
}
