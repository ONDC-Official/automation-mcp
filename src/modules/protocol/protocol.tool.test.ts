import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_BUILD } from "@/test/fakes.js";
import { createHarness, resourceText, type Harness } from "@/test/harness.js";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.close();
});

const BUILD = {
  domain: FIXTURE_BUILD.domain,
  version: FIXTURE_BUILD.version,
};

function textOf(result: { content: unknown }): string {
  return (result.content as { type: string; text: string }[])[0]?.text ?? "";
}

describe("protocol tools over MCP", () => {
  it("describes a build with no session at all", async () => {
    // The whole point of the module: someone implementing ONDC has no
    // participant under test and should not have to invent one to read a spec.
    const result = await harness.client.callTool({
      name: "protocol_describe_build",
      arguments: BUILD,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      domain: BUILD.domain,
      version: BUILD.version,
    });
    const out = result.structuredContent as {
      actions: string[];
      may_start_with: string[];
      error_code_count: number;
      rule_count: number;
    };
    expect(out.actions.length).toBeGreaterThan(0);
    expect(out.may_start_with.length).toBeGreaterThan(0);
    expect(out.error_code_count).toBeGreaterThan(0);
    expect(out.rule_count).toBeGreaterThan(0);
  });

  it("takes a session_id as a shorthand for the build", async () => {
    const created = await harness.client.callTool({
      name: "session_create",
      arguments: {
        subscriber_url: "https://np.example.com",
        np_type: "BAP",
        ...FIXTURE_BUILD,
      },
    });
    const { session } = created.structuredContent as {
      session: { session_id: string };
    };

    const result = await harness.client.callTool({
      name: "protocol_describe_build",
      arguments: { session_id: session.session_id },
    });
    expect(result.structuredContent).toMatchObject({ domain: BUILD.domain });
  });

  it("keeps the default answer small, and only grows when asked", async () => {
    // Budgets asserted mechanically, because a budget nobody measures is a
    // budget that rots on the first added field.
    const lean = await harness.client.callTool({
      name: "protocol_describe_build",
      arguments: { ...BUILD, include: [] },
    });
    expect(JSON.stringify(lean.structuredContent).length).toBeLessThan(4_000);

    const full = await harness.client.callTool({
      name: "protocol_describe_build",
      arguments: { ...BUILD, include: ["overview", "flows"] },
    });
    expect(JSON.stringify(full.structuredContent).length).toBeGreaterThan(
      JSON.stringify(lean.structuredContent).length,
    );
    expect(JSON.stringify(full.structuredContent).length).toBeLessThan(12_000);
  });

  it("refuses an unknown build by name instead of answering emptily", async () => {
    const result = await harness.client.callTool({
      name: "protocol_describe_build",
      arguments: { domain: "ONDC:NOPE", version: "9.9.9" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Unknown domain/);
  });

  it("answers what may open a transaction when no action is named", async () => {
    const result = await harness.client.callTool({
      name: "protocol_next_actions",
      arguments: BUILD,
    });
    const out = result.structuredContent as {
      after: string | null;
      next: { action: string }[];
    };
    expect(out.after).toBeNull();
    expect(out.next.length).toBeGreaterThan(0);
  });

  it("annotates successors and says a flow is only one path", async () => {
    const result = await harness.client.callTool({
      name: "protocol_next_actions",
      arguments: { ...BUILD, after: "search" },
    });
    const out = result.structuredContent as {
      next: { action: string; unsolicited: boolean; must_echo: string[] }[];
      note: string;
    };
    expect(out.next.map((entry) => entry.action)).toContain("on_search");
    for (const entry of out.next) {
      expect(entry).toHaveProperty("unsolicited");
      expect(entry).toHaveProperty("must_echo");
    }
    expect(out.note).toMatch(/ONE path/);
    expect(textOf(result)).toMatch(/ONE path/);
  });

  it("refuses an action the build does not define, naming the ones it does", async () => {
    const result = await harness.client.callTool({
      name: "protocol_next_actions",
      arguments: { ...BUILD, after: "teleport" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/does not define an action/);
  });

  it("stays tiny", async () => {
    const result = await harness.client.callTool({
      name: "protocol_next_actions",
      arguments: { ...BUILD, after: "search" },
    });
    expect(JSON.stringify(result.structuredContent).length).toBeLessThan(2_500);
  });

  it("offers np_integrator as a prompt, distinct from the mock personas", async () => {
    const { prompts } = await harness.client.listPrompts();
    const names = prompts.map((prompt) => prompt.name).sort();
    expect(names).toEqual(["mock_buyer", "mock_seller", "np_integrator"]);
  });

  describe("protocol_describe_action", () => {
    const ACTION = {
      ...BUILD,
      usecase: FIXTURE_BUILD.usecase,
      action: "search",
    };

    it("reports fields with meaning, ownership and the echo contract", async () => {
      const result = await harness.client.callTool({
        name: "protocol_describe_action",
        arguments: ACTION,
      });
      expect(result.isError).toBeFalsy();
      const out = result.structuredContent as {
        fields?: {
          total: number;
          items: { path: string; required: boolean }[];
        };
        must_echo: string[];
        legal_next: string[];
      };
      expect(out.fields?.items.length).toBeGreaterThan(0);
      expect(out.fields?.items[0]?.path.startsWith("$")).toBe(true);
      expect(Array.isArray(out.must_echo)).toBe(true);
      expect(out.legal_next.length).toBeGreaterThan(0);
    });

    it("truncates deterministically and says it did", async () => {
      const result = await harness.client.callTool({
        name: "protocol_describe_action",
        arguments: { ...ACTION, limit: 1 },
      });
      const out = result.structuredContent as {
        fields?: { total: number; returned: number; truncated: boolean };
      };
      expect(out.fields?.returned).toBe(1);
      if ((out.fields?.total ?? 0) > 1)
        expect(out.fields?.truncated).toBe(true);

      // Stable: the same call must not return a different field.
      const again = await harness.client.callTool({
        name: "protocol_describe_action",
        arguments: { ...ACTION, limit: 1 },
      });
      expect(again.structuredContent).toEqual(result.structuredContent);
    });

    it("narrows by path prefix and by required", async () => {
      const narrowed = await harness.client.callTool({
        name: "protocol_describe_action",
        arguments: {
          ...ACTION,
          path_prefix: "$.context",
          required_only: true,
          limit: 100,
        },
      });
      const out = narrowed.structuredContent as {
        fields?: { items: { path: string; required: boolean }[] };
      };
      expect(out.fields?.items.length).toBeGreaterThan(0);
      for (const field of out.fields?.items ?? []) {
        expect(field.path.startsWith("$.context")).toBe(true);
        expect(field.required).toBe(true);
      }
    });

    it("never inlines the JSON Schema — it hands back a resource uri", async () => {
      const result = await harness.client.callTool({
        name: "protocol_describe_action",
        arguments: { ...ACTION, include: ["schema"] },
      });
      const out = result.structuredContent as {
        schema?: { bytes: number; resource_uri: string };
      };
      expect(out.schema?.resource_uri).toMatch(/^ondc:\/\/schema\//);
      expect(JSON.stringify(out)).not.toContain("properties");
    });

    it("stays inside its default budget", async () => {
      const result = await harness.client.callTool({
        name: "protocol_describe_action",
        arguments: ACTION,
      });
      expect(JSON.stringify(result.structuredContent).length).toBeLessThan(
        9_000,
      );
    });

    it("refuses an action the build does not define", async () => {
      const result = await harness.client.callTool({
        name: "protocol_describe_action",
        arguments: { ...ACTION, action: "teleport" },
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("protocol_search_fields", () => {
    it("finds a field without being told which action it is on", async () => {
      const result = await harness.client.callTool({
        name: "protocol_search_fields",
        arguments: {
          ...BUILD,
          usecase: FIXTURE_BUILD.usecase,
          query: "domain",
        },
      });
      const out = result.structuredContent as {
        total: number;
        hits: { action: string; path: string }[];
      };
      expect(out.total).toBeGreaterThan(0);
      expect(out.hits[0]?.action).toBeTruthy();
    });

    it("answers a query that matches nothing without erroring", async () => {
      const result = await harness.client.callTool({
        name: "protocol_search_fields",
        arguments: {
          ...BUILD,
          usecase: FIXTURE_BUILD.usecase,
          query: "zzzznope",
        },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ total: 0 });
    });
  });

  describe("protocol_explain_rule", () => {
    it("explains a rule by name and names every action it applies to", async () => {
      const first = await harness.client.callTool({
        name: "protocol_describe_action",
        arguments: {
          ...BUILD,
          usecase: FIXTURE_BUILD.usecase,
          action: "search",
          include: ["rules"],
        },
      });
      const rules = (
        first.structuredContent as {
          rules?: { items: { name: string }[] };
        }
      ).rules;
      const name = rules?.items[0]?.name;
      expect(name).toBeTruthy();

      const result = await harness.client.callTool({
        name: "protocol_explain_rule",
        arguments: { ...BUILD, query: name as string },
      });
      const out = result.structuredContent as {
        query_kind: string;
        total: number;
        per_action: Record<string, number>;
      };
      expect(out.query_kind).toBe("rule_name");
      expect(out.total).toBeGreaterThan(0);
      expect(Object.keys(out.per_action).length).toBeGreaterThan(0);
    });

    it("reads a bare code as an error code and gives its business meaning", async () => {
      const codes = await harness.client.callTool({
        name: "protocol_list_error_codes",
        arguments: BUILD,
      });
      const code = (codes.structuredContent as { codes: { code: string }[] })
        .codes[0]?.code;

      const result = await harness.client.callTool({
        name: "protocol_explain_rule",
        arguments: { ...BUILD, query: code as string },
      });
      const out = result.structuredContent as {
        query_kind: string;
        error_code?: { code: string; description: string };
      };
      expect(out.query_kind).toBe("error_code");
      expect(out.error_code?.code).toBe(code);
    });

    it("explains our own synthesised codes rather than answering nothing", async () => {
      // A model pasting `L0_SCHEMA` back is holding a code this server minted,
      // not a published rule. Silence would read as "no such rule".
      const result = await harness.client.callTool({
        name: "protocol_explain_rule",
        arguments: { ...BUILD, query: "L0_SCHEMA" },
      });
      const out = result.structuredContent as {
        query_kind: string;
        note?: string;
      };
      expect(out.query_kind).toBe("pseudo_code");
      expect(out.note).toMatch(/ondc:\/\/schema/);
    });
  });

  describe("protocol_list_error_codes", () => {
    it("lists them with the side that raises each", async () => {
      const result = await harness.client.callTool({
        name: "protocol_list_error_codes",
        arguments: BUILD,
      });
      const out = result.structuredContent as {
        codes: { code: string; sent_by: string }[];
      };
      expect(out.codes.length).toBeGreaterThan(0);
      for (const code of out.codes) expect(typeof code.code).toBe("string");
    });

    it("narrows to one side", async () => {
      const result = await harness.client.callTool({
        name: "protocol_list_error_codes",
        arguments: { ...BUILD, sent_by: "BPP" },
      });
      const out = result.structuredContent as { codes: { sent_by: string }[] };
      expect(out.codes.every((c) => c.sent_by === "BPP")).toBe(true);
    });
  });

  describe("protocol_search_knowledge", () => {
    it("answers a network question with no build at all", async () => {
      // The corpus does not vary by build, which is exactly why it is bundled.
      const result = await harness.client.callTool({
        name: "protocol_search_knowledge",
        arguments: { query: "how do I sign a request" },
      });
      expect(result.isError).toBeFalsy();
      const out = result.structuredContent as {
        sections: { topic: string }[];
        as_of: string;
      };
      expect(out.sections.map((s) => s.topic)).toContain("signing");
      expect(out.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("explains why a flow is not the protocol", async () => {
      const result = await harness.client.callTool({
        name: "protocol_search_knowledge",
        arguments: { query: "can I hardcode a provider id from a flow" },
      });
      const out = result.structuredContent as { sections: { topic: string }[] };
      expect(out.sections.map((s) => s.topic)).toContain("flows-vs-reality");
    });

    it("reaches the published knowledge base, not only its own notes", async () => {
      const result = await harness.client.callTool({
        name: "protocol_search_knowledge",
        arguments: { query: "how do I rotate my signing key", limit: 4 },
      });
      expect(result.isError).toBeFalsy();
      const out = result.structuredContent as {
        sections: { topic: string; tier: string; status?: string }[];
        kb: { repo: string; sha: string; docs: number; as_of: string };
      };
      expect(out.sections.map((s) => s.topic)).toContain("30-key-rotation");
      expect(out.kb.repo).toBe("ONDC-Official/automation-kb-studio");
      expect(out.kb.docs).toBe(63);
      expect(out.kb.sha).toMatch(/^[0-9a-f]{40}$/);
    });

    it("renders provenance into the text, not just the structured content", async () => {
      // The rendered text is what the model reads. A status of `partial` that
      // only reaches a code consumer has told nobody anything.
      const result = await harness.client.callTool({
        name: "protocol_search_knowledge",
        arguments: { query: "awb shipping label", limit: 2 },
      });
      const text = textOf(result);
      expect(text).toContain("51-awb-shipping-label");
      expect(text).toContain("Fulfillment & Logistics");
      expect(text).toMatch(/matching sections/);
      expect(text).toMatch(/ONDC docs \d{4}-\d{2}-\d{2} @ [0-9a-f]{7}/);
    });

    it("narrows to a category, and says which ones exist", async () => {
      const result = await harness.client.callTool({
        name: "protocol_search_knowledge",
        arguments: {
          query: "state machine",
          category: "Order Lifecycle",
          limit: 3,
        },
      });
      const out = result.structuredContent as {
        sections: { category?: string }[];
        categories: string[];
      };
      expect(out.sections.length).toBeGreaterThan(0);
      expect(out.sections.every((s) => s.category === "Order Lifecycle")).toBe(
        true,
      );
      expect(out.categories).toHaveLength(12);
    });

    it("refuses an unknown topic instead of answering nothing", async () => {
      // An empty answer reads as "the network has nothing on this", which is a
      // much more expensive thing for a model to believe than a typo.
      const result = await harness.client.callTool({
        name: "protocol_search_knowledge",
        arguments: { query: "keys", topic: "key-rotation" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/knowledge topic/i);
    });

    it("keeps a default answer small enough to be worth reading", async () => {
      // Tool output reaches the model twice — once rendered, once as
      // structured content — so the budget is effectively halved.
      const result = await harness.client.callTool({
        name: "protocol_search_knowledge",
        arguments: { query: "ondc network participant catalog order" },
      });
      expect(textOf(result).length).toBeLessThan(6_000);
    });
  });

  describe("resources", () => {
    it("serves a build spec at a uri whose domain carries a colon", async () => {
      // The only path segment in this server containing a `:`.
      const result = await harness.client.readResource({
        uri: `ondc://spec/${BUILD.domain}/${BUILD.version}`,
      });
      const card = JSON.parse(resourceText(result)) as { domain: string };
      expect(card.domain).toBe(BUILD.domain);
    });

    it("lists every knowledge topic, both layers, with its facets", async () => {
      const result = await harness.client.readResource({
        uri: "ondc://knowledge",
      });
      const body = JSON.parse(resourceText(result)) as {
        topics: { id: string; tier: string; category?: string }[];
        total: number;
        categories: string[];
      };
      expect(body.total).toBe(68);
      expect(body.categories).toHaveLength(12);
      expect(body.topics.map((t) => t.id)).toContain("signing");
      expect(body.topics.map((t) => t.id)).toContain("30-key-rotation");
    });

    it("serves one whole knowledge document as markdown", async () => {
      // The follow-up to a search hit. A resource, so it lands in context only
      // when a client actually pulls it.
      const result = await harness.client.readResource({
        uri: "ondc://knowledge/30-key-rotation",
      });
      const text = resourceText(result);
      expect(text).toContain("# Key Rotation");
      expect(text).toContain("Published by ONDC.");
      expect(text).toContain("Category: Security & Auth.");
      expect(text).toContain("## Objective");
    });

    it("serves the hand-written notes through the same uri", async () => {
      const result = await harness.client.readResource({
        uri: "ondc://knowledge/signing",
      });
      expect(resourceText(result)).toContain(
        "This server's own orientation notes.",
      );
    });

    it("serves one action's schema, fully inlined", async () => {
      const result = await harness.client.readResource({
        uri: `ondc://schema/${BUILD.domain}/${BUILD.version}/search`,
      });
      const body = JSON.parse(resourceText(result)) as {
        action: string;
        schema: unknown;
      };
      expect(body.action).toBe("search");
      expect(JSON.stringify(body.schema)).not.toContain("$ref");
    });
  });
});
