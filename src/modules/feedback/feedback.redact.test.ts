import { describe, expect, it } from "vitest";
import {
  installId,
  pseudonymise,
  scrubIds,
  scrubProse,
  redactEvidence,
  scrubStack,
  scrubText,
  structuralise,
} from "@/modules/feedback/feedback.redact.js";
import {
  PII_FORM_FIELDS,
  PII_HOME_PATH,
  PII_LITERALS,
  PII_PAYLOAD,
  PII_PROSE,
  PII_STACK,
  expectNoPii,
} from "@/test/pii-fixtures.js";

const SALT = "test-salt-do-not-reuse";

/** Reach into the structuralised result without fighting `unknown`. */
function at(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) => (node as Record<string, unknown> | undefined)?.[key],
      value,
    );
}

describe("scrubText", () => {
  it.each([
    ["email", "write to ramesh.kumar@example.com now", "<email>"],
    ["indian mobile", "call 9876543210", "<phone>"],
    ["e164", "call +919876543210", "<phone>"],
    ["gps pair", "at 12.9715987,77.5945627 exactly", "<gps>"],
    ["gstin", "tax id 27AAPFU0939F1ZV filed", "<gstin>"],
    ["pan", "pan ABCPK1234M on file", "<pan>"],
    ["spaced 12-digit", "uid 1234 5678 9012 verified", "<id12>"],
    ["bare 12-digit", "acct 123456789012 credited", "<id12>"],
    ["ipv4", "from 192.168.1.42 today", "<ipv4>"],
    ["long digits", "ref 1234567890123456 ok", "<digits>"],
  ])("replaces a %s", (_label, input, token) => {
    const out = scrubText(input);
    expect(out).toContain(token);
  });

  it("strips userinfo from a URL without losing the scheme", () => {
    expect(scrubText("https://user:pw@np.example.com/ondc")).toBe(
      "https://<userinfo>@np.example.com/ondc",
    );
  });

  it("replaces a JWT-shaped token", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijklmno";
    expect(scrubText(`bearer ${jwt}`)).toBe("bearer <jwt>");
  });

  it("leaves an ISO timestamp and a semver alone", () => {
    // Both are matched by nothing here on purpose: clock skew is a real finding
    // and a build version is how the corpus is grouped.
    const text = "at 2026-07-30T11:02:13.123Z on 2.0.2";
    expect(scrubText(text)).toBe(text);
  });

  it("scrubs the oracle's own prose, which quotes what it rejected", () => {
    const out = scrubText(PII_PROSE);

    expect(out).toContain("<email>");
    expect(out).toContain("<phone>");
    // The JSON Pointer is where the value was, never the value — it stays.
    expect(out).toContain("/message/order/billing/email");
  });

  it("truncates past the limit and says so", () => {
    expect(scrubText("a".repeat(50), 10)).toBe(`${"a".repeat(10)}<truncated>`);
  });
});

describe("scrubStack", () => {
  it("drops an absolute path outside the repo, keeping file and line", () => {
    const out = scrubStack(PII_STACK);

    expect(out).not.toContain(PII_HOME_PATH);
    expect(out).toContain("<path>/on_confirm.js:12:5");
    expect(out).toContain("at generate");
  });

  it("makes an in-repo frame relative rather than anonymous", () => {
    const root = "/build/automation-mcp";
    const stack = `    at run (${root}/src/lib/mock-engine/mock-engine.ts:250:9)`;

    expect(scrubStack(stack, root)).toContain(
      "src/lib/mock-engine/mock-engine.ts:250:9",
    );
  });
});

describe("scrubIds / scrubProse", () => {
  it("pseudonymises a transaction id quoted inside prose", () => {
    // Found by reading a generated report, not by a test: the structured
    // `transaction_id` was pseudonymised while a journal summary two lines
    // below still said it in plain text.
    const uuid = "f5473454-e82d-4c39-97b7-1bb2cbe95cf0";
    const out = scrubIds(`Flow "X" minted transaction ${uuid} for its first action.`, SALT);

    expect(out).not.toContain(uuid);
    expect(out).toMatch(/id_[0-9a-f]{12}/);
  });

  it("gives the same id the same pseudonym, so a slice still correlates", () => {
    const uuid = "f5473454-e82d-4c39-97b7-1bb2cbe95cf0";
    const first = scrubIds(`opened ${uuid}`, SALT);
    const second = scrubIds(`closed ${uuid}`, SALT);

    expect(first.split(" ")[1]).toBe(second.split(" ")[1]);
  });

  it("does both shapes and ids in one pass", () => {
    const out = scrubProse(
      "txn 6a1f0c94-1111-4222-8333-444455556666 rejected for 9876543210",
      SALT,
    );

    expect(out).toContain("<phone>");
    expect(out).toMatch(/id_[0-9a-f]{12}/);
  });
});

describe("pseudonymise", () => {
  it("is stable for one salt and different across salts", () => {
    const a = pseudonymise("np.example.com", SALT, "np");
    const b = pseudonymise("np.example.com", SALT, "np");
    const other = pseudonymise("np.example.com", "another-salt", "np");

    expect(a).toBe(b);
    expect(a).not.toBe(other);
    expect(a).toMatch(/^np_[0-9a-f]{12}$/);
  });

  it("never contains the input", () => {
    expect(pseudonymise("buyer.example.com", SALT, "np")).not.toContain(
      "example",
    );
  });

  it("gives the installation its own stable id", () => {
    expect(installId(SALT)).toBe(installId(SALT));
    expect(installId(SALT)).toMatch(/^inst_[0-9a-f]{12}$/);
  });
});

describe("structuralise", () => {
  const shape = structuralise(PII_PAYLOAD, SALT);

  it("keeps the protocol coordinates verbatim — they are the signal", () => {
    expect(at(shape, "context.action")).toBe("on_confirm");
    expect(at(shape, "context.domain")).toBe("ONDC:FIS12");
    expect(at(shape, "context.version")).toBe("2.0.0");
    expect(at(shape, "context.ttl")).toBe("PT30S");
  });

  it("keeps the timestamp, because clock skew is a real finding", () => {
    // `reduce-history.ts` orders by `seq` rather than timestamp precisely
    // because a participant's clock ran fast. A report that structuralised
    // timestamps could never show that.
    expect(at(shape, "context.timestamp")).toBe("2026-07-30T11:02:13.123Z");
  });

  it("keeps ONDC standard location codes, which name no one", () => {
    expect(at(shape, "context.location.country.code")).toBe("IND");
    expect(at(shape, "context.location.city.code")).toBe("std:080");
  });

  it("pseudonymises identifiers instead of tokenising them", () => {
    expect(at(shape, "context.bap_id")).toMatch(/^np_[0-9a-f]{12}$/);
    expect(at(shape, "context.bpp_uri")).toMatch(/^np_[0-9a-f]{12}$/);
    expect(at(shape, "context.transaction_id")).toMatch(/^txn_[0-9a-f]{12}$/);
    expect(at(shape, "context.message_id")).toMatch(/^msg_[0-9a-f]{12}$/);
  });

  it("replaces every other leaf with a type token but keeps its key", () => {
    const billing = at(shape, "message.order.billing") as Record<
      string,
      unknown
    >;

    // The keys are the whole point: "billing.phone was the wrong shape" is a
    // finding, and it survives without the number ever being present.
    expect(Object.keys(billing).sort()).toEqual([
      "address",
      "email",
      "name",
      "phone",
      "tax_id",
    ]);
    expect(billing["name"]).toBe("<string:12>");
    expect(billing["phone"]).toBe("<string:10>");
    expect(at(shape, "message.order.billing.address.area_code")).toBe(
      "<string:6>",
    );
  });

  it("redacts a bracket-quoted @ondc/org key without special-casing it", () => {
    // Paths are compared as segment arrays, so the key never has to be escaped.
    const settlement = at(shape, "message.order.payment.@ondc/org/settlement");

    expect(Array.isArray(settlement)).toBe(true);
    expect((settlement as unknown[])[0]).toEqual({
      bank_account_number: "<string:12>",
      ifsc: "<string:11>",
    });
  });

  it("keeps array length even when it only samples the head", () => {
    const many = structuralise(
      { items: Array.from({ length: 20 }, () => ({ id: "x" })) },
      SALT,
    );
    const items = at(many, "items") as unknown[];

    // Three described, and the count of what was not — a truncated list that
    // does not say it is truncated reads as a complete one.
    expect(items).toHaveLength(4);
    expect(items[3]).toBe("<+17 more>");
  });

  it("stops rather than describing an unbounded catalog", () => {
    const huge = {
      catalog: Array.from({ length: 400 }, (_, index) => ({
        id: index,
        nested: { a: 1, b: 2, c: 3, d: 4 },
      })),
    };

    const out = JSON.stringify(structuralise(huge, SALT));
    expect(out.length).toBeLessThan(20_000);
  });

  it("handles a cycle-free deep structure without throwing", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 40; i += 1) deep = { down: deep };

    expect(() => structuralise(deep, SALT)).not.toThrow();
  });

  it("tokenises a flat form field map wholesale — no allowlist applies", () => {
    const fields = structuralise(PII_FORM_FIELDS, SALT) as Record<
      string,
      unknown
    >;

    expect(Object.keys(fields)).toEqual(Object.keys(PII_FORM_FIELDS));
    expect(
      Object.values(fields).every((v) => String(v).startsWith("<string:")),
    ).toBe(true);
  });
});

describe("redactEvidence", () => {
  it("keeps a finding's layer, code and path, and scrubs only its message", () => {
    const redacted = redactEvidence(
      {
        findings: [
          {
            layer: "L0",
            code: "L0_SCHEMA",
            json_path: "$.message.order.billing.email",
            message: PII_PROSE,
          },
        ],
      },
      { salt: SALT },
    );

    const [finding] = redacted.findings ?? [];
    expect(finding?.layer).toBe("L0");
    expect(finding?.code).toBe("L0_SCHEMA");
    // A JSONPath says where a value was, never what it was.
    expect(finding?.json_path).toBe("$.message.order.billing.email");
    expect(finding?.message).toContain("<email>");
    expect(finding?.message).not.toContain("ramesh.kumar@example.com");
  });

  it("caps runner logs rather than carrying a whole console session", () => {
    const redacted = redactEvidence(
      {
        runner_logs: Array.from({ length: 200 }, (_, i) => `line ${String(i)}`),
      },
      { salt: SALT },
    );

    expect(redacted.runner_logs).toHaveLength(40);
  });

  it("omits absent fields instead of writing undefined", () => {
    // Redis round-trips through JSON, so an explicit `undefined` is dropped on
    // write and reads back missing anyway — the store shapes are built this way
    // throughout (`...(x !== undefined ? { x } : {})`).
    expect(redactEvidence({}, { salt: SALT })).toEqual({});
    expect(
      Object.keys(redactEvidence({ ack: "NACK" }, { salt: SALT })),
    ).toEqual(["ack"]);
  });
});

describe("the leak canary", () => {
  it("lets nothing from PII_LITERALS survive a full evidence redaction", () => {
    const redacted = redactEvidence(
      {
        message: PII_PROSE,
        runner_logs: [
          `applicant ${PII_FORM_FIELDS.applicant_pan} from ${PII_FORM_FIELDS.residence_ip}`,
          "contact ramesh.kumar@example.com / 9876543210",
        ],
        runner_stack: PII_STACK,
        findings: [
          {
            layer: "L1",
            code: "BILLING_PHONE_INVALID",
            json_path: "$.message.order.billing.phone",
            message: PII_PROSE,
          },
        ],
        payload_shape: { ...PII_PAYLOAD, form_fields: PII_FORM_FIELDS },
      },
      { salt: SALT },
    );

    expectNoPii(redacted);
  });

  it("still carries enough to be worth sending", () => {
    // The counterweight: redacting everything to `{}` would pass the canary and
    // be useless. The shape and the protocol coordinates have to survive.
    const redacted = redactEvidence(
      { payload_shape: PII_PAYLOAD },
      { salt: SALT },
    );

    expect(at(redacted.payload_shape, "context.action")).toBe("on_confirm");
    expect(
      Object.keys(
        at(redacted.payload_shape, "message.order.billing") as Record<
          string,
          unknown
        >,
      ),
    ).toContain("phone");
    expect(
      at(redacted.payload_shape, "message.order.fulfillments"),
    ).toBeInstanceOf(Array);
  });

  it("covers every literal it claims to — the fixture is not stale", () => {
    // Guards the canary itself: a literal that no longer appears in the payload
    // makes the assertion vacuous for that shape.
    const source = JSON.stringify({
      PII_PAYLOAD,
      PII_FORM_FIELDS,
      PII_STACK,
      PII_PROSE,
    });
    const orphans = PII_LITERALS.filter((literal) => !source.includes(literal));

    expect(orphans).toEqual([]);
  });
});
