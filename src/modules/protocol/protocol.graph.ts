/**
 * The action graph — pure functions over `meta.supportedActions` and
 * `meta.apiProperties`.
 *
 * This file exists because of one specific failure. A flow definition is a
 * **scripted linear path**: one counterparty, a known next step, a definite
 * end. A model reads five or ten of them in a session and concludes that is
 * what the protocol is — and then starts reaching for values that "worked last
 * time", because in a script they do.
 *
 * A live transaction is a walk through a graph. `supportedActions` publishes
 * that graph per build and nothing in this server has ever shown it:
 *
 * ```
 * null       → search, select, init         a transaction need not open at search
 * on_search  → search, select, init, on_search   on_search follows itself: catalog fan-out
 * on_confirm → confirm, status, cancel, on_status, update, issue, on_cancel
 * ```
 *
 * `apiProperties` publishes the other half — `transaction_partner`, the earlier
 * actions whose values this payload has to stay consistent with. That is the
 * published answer to "did I just invent this identifier?", and it is why
 * `mustEcho` is the single most useful thing here.
 */

import type { z } from "zod";
import type {
  FlowReality,
  NextAction,
  UpstreamApiProperty,
} from "@/modules/protocol/protocol.schema.js";

type ApiProperty = z.infer<typeof UpstreamApiProperty>;

/**
 * The key under which upstream lists the actions that may open a transaction.
 *
 * It is the literal four-character string `"null"` — a JSON object key cannot
 * be null, so upstream serialises it this way. Reading it as a missing entry
 * loses the entry-point set entirely.
 */
export const ENTRY_KEY = "null";

export interface ActionGraph {
  /** `supportedActions`, verbatim, including the `"null"` entry key. */
  readonly edges: Readonly<Record<string, readonly string[]>>;
  readonly properties: Readonly<Record<string, ApiProperty>>;
}

/** Actions that may legitimately open a transaction. */
export function entryActions(graph: ActionGraph): string[] {
  return [...(graph.edges[ENTRY_KEY] ?? [])];
}

/**
 * Every action the build defines, sorted, with the entry pseudo-key removed.
 *
 * Blank names are dropped. That is not defensive coding: `ONDC:RET11/1.2.5`
 * publishes a literal empty-string key in `supportedActions`, verified live.
 * Left in, it surfaces as a nameless action in `not_in_this_flow` — a model
 * reading "the build also permits: , cancel, issue" learns nothing and
 * distrusts the rest of the line.
 */
export function allActions(graph: ActionGraph): string[] {
  const seen = new Set<string>();
  for (const [from, tos] of Object.entries(graph.edges)) {
    if (from !== ENTRY_KEY) seen.add(from);
    for (const to of tos) seen.add(to);
  }
  for (const action of Object.keys(graph.properties)) seen.add(action);
  return [...seen].filter((action) => action.trim().length > 0).sort();
}

/**
 * True when an action may follow itself.
 *
 * This is the fan-out marker. `on_search → on_search` is not a quirk of the
 * table: one `search` reaches many sellers through the gateway and each answers
 * separately, so a real buyer app aggregates N callbacks over the context TTL
 * rather than awaiting "the" response. A flow shows one.
 */
export function isRepeatable(graph: ActionGraph, action: string): boolean {
  return (graph.edges[action] ?? []).includes(action);
}

/**
 * True when nothing we send prompts this callback.
 *
 * `async_predecessor === null` on an `on_` action means the spec does not pair
 * it with a request. `on_status` is the standing example: a seller may send one
 * whenever the order's state changes, days after `on_confirm`, with no `status`
 * from us. A participant that only accepts callbacks it asked for is not
 * compliant, and no flow makes that visible.
 */
export function isUnsolicited(graph: ActionGraph, action: string): boolean {
  const property = graph.properties[action];
  if (property === undefined) return false;
  return (
    (property.async_predecessor === null ||
      property.async_predecessor === undefined) &&
    action.startsWith("on_")
  );
}

/** The earlier actions this action's payload must stay consistent with. */
export function mustEcho(graph: ActionGraph, action: string): string[] {
  return [...(graph.properties[action]?.transaction_partner ?? [])];
}

/** The request this callback is the asynchronous answer to, if the spec pairs it. */
export function answers(
  graph: ActionGraph,
  action: string,
): string | undefined {
  return graph.properties[action]?.async_predecessor ?? undefined;
}

/**
 * What may legitimately follow `after`.
 *
 * `after === null` asks what may open a transaction. An action the graph does
 * not mention answers with an empty list and `terminal: true` — an unknown
 * action is a question with an answer ("nothing follows it here"), not an
 * error, because the caller may well be asking precisely to find that out.
 */
export function successorsOf(
  graph: ActionGraph,
  after: string | null,
): NextAction[] {
  const key = after ?? ENTRY_KEY;
  return (graph.edges[key] ?? [])
    .filter((action) => action.trim().length > 0)
    .map((action) => ({
      action,
      unsolicited: isUnsolicited(graph, action),
      repeatable: isRepeatable(graph, action),
      ...(answers(graph, action) !== undefined
        ? { answers: answers(graph, action) }
        : {}),
      must_echo: mustEcho(graph, action),
    }));
}

/** Fixed prose. Stated in the structured output too, not only the render. */
export const REALITY_NOTE =
  "This sequence is ONE path through the build's action graph, chosen for " +
  "testing. A live counterparty may take any permitted branch, repeat an " +
  "action, or send an unsolicited callback with no request at all.";

/**
 * What a flow's sequence does not say, computed against the graph.
 *
 * Deliberately small — action names and short lists, no prose per step — because
 * this rides along on `catalog_describe_flow`, which the model already reads
 * before every run. The budget is asserted in the tests, not hoped for.
 */
export function realityFor(
  graph: ActionGraph,
  sequenceActions: readonly string[],
): FlowReality {
  const covered = new Set(sequenceActions);
  const steps = [...covered]
    .map((action) => {
      const repeatable = isRepeatable(graph, action);
      const unsolicited = isUnsolicited(graph, action);
      const echo = mustEcho(graph, action);
      return {
        action,
        ...(repeatable ? { repeatable: true } : {}),
        ...(unsolicited ? { unsolicited: true } : {}),
        ...(echo.length > 0 ? { must_echo: echo } : {}),
        ...(repeatable
          ? {
              note:
                "may follow itself — a real run receives several, and stops on " +
                "the context TTL rather than on a count",
            }
          : {}),
      };
    })
    // Only steps that actually carry a caveat are worth the bytes.
    .filter(
      (step) =>
        step.repeatable === true ||
        step.unsolicited === true ||
        step.must_echo !== undefined,
    )
    .sort((a, b) => a.action.localeCompare(b.action));

  return {
    note: REALITY_NOTE,
    may_start_with: entryActions(graph),
    steps,
    not_in_this_flow: allActions(graph)
      .filter((action) => !covered.has(action))
      .sort(),
  };
}
