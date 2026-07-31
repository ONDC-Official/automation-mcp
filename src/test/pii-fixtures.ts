import { expect } from "vitest";

/**
 * The leak canary.
 *
 * One payload carrying every shape of personal data we know arrives on this
 * wire, and the list of literals that must never survive redaction. Both are
 * exported because more than one test needs them: `feedback.redact.test.ts`
 * asserts the transform, and the end-to-end loop test asserts the file that
 * actually reached the spool.
 *
 * **Adding a shape here is the whole maintenance story.** When a new field turns
 * up in the wild — a new domain, a new form — add it to `PII_PAYLOAD` and its
 * value to `PII_LITERALS`. The assertion never changes, so a regression shows up
 * as a failing test rather than as a review comment nobody made.
 *
 * The domains in play are FIS12 (personal loan) and TRV11 (mobility), so this is
 * modelled on their real shapes: `billing`, `fulfillments[].customer.person`,
 * `.customer.contact`, `stops[].location.gps`, the bracket-quoted
 * `@ondc/org/settlement` block, and — the sharpest one — a flat `form_submit`
 * field map, which has no protocol shape to lean on at all.
 */

/** A home directory, which is to say the operator's name, in a stack frame. */
export const PII_HOME_PATH = "/Users/testoperator/private/workspace";

export const PII_PAYLOAD = {
  context: {
    domain: "ONDC:FIS12",
    version: "2.0.0",
    action: "on_confirm",
    bap_id: "buyer.example.com",
    bap_uri: "https://buyer.example.com/ondc",
    bpp_id: "lender.example.com",
    bpp_uri: "https://lender.example.com/ondc",
    transaction_id: "b4f1e2a0-0000-4000-8000-000000000001",
    message_id: "b4f1e2a0-0000-4000-8000-000000000002",
    timestamp: "2026-07-30T11:02:13.123Z",
    ttl: "PT30S",
    location: { country: { code: "IND" }, city: { code: "std:080" } },
  },
  message: {
    order: {
      status: "ACTIVE",
      billing: {
        name: "Ramesh Kumar",
        phone: "9876543210",
        email: "ramesh.kumar@example.com",
        tax_id: "27AAPFU0939F1ZV",
        address: {
          full: "42 MG Road, Indiranagar, Bengaluru 560038",
          area_code: "560038",
        },
      },
      fulfillments: [
        {
          id: "F1",
          customer: {
            person: { name: "Ramesh Kumar", dob: "1990-04-12" },
            contact: { phone: "+919876543210", email: "ramesh.k@example.org" },
          },
          stops: [
            { type: "start", location: { gps: "12.9715987,77.5945627" } },
            { type: "end", location: { gps: "12.9352400,77.6245400" } },
          ],
        },
      ],
      payment: {
        "@ondc/org/settlement": [
          { bank_account_number: "123456789012", ifsc: "HDFC0001234" },
        ],
      },
      quote: { price: { currency: "INR", value: "150000.00" } },
    },
  },
} as const;

/** A `form_submit` field map — flat, arbitrary keys, all of it answers. */
export const PII_FORM_FIELDS = {
  applicant_pan: "ABCPK1234M",
  applicant_aadhaar: "1234 5678 9012",
  monthly_income: "85000",
  employer_email: "hr@acme-industries.example.com",
  residence_ip: "192.168.1.42",
};

export const PII_STACK = [
  "Error: cannot read property 'id' of undefined",
  `    at generate (${PII_HOME_PATH}/flows/on_confirm.js:12:5)`,
  `    at runInSandbox (${PII_HOME_PATH}/node_modules/@ondc/runner/index.js:88:11)`,
].join("\n");

/** Prose that quotes a value, the way the validation oracle's L0 grammar does. */
export const PII_PROSE =
  "at '/message/order/billing/email': got 'ramesh.kumar@example.com', " +
  "want format email; contact 9876543210 for details";

/**
 * Every literal that must not survive.
 *
 * Kept separate from the payload so a test can assert over the serialised
 * output as a whole, rather than walking to the fields it happens to remember.
 */
export const PII_LITERALS: readonly string[] = [
  "Ramesh Kumar",
  "ramesh.kumar@example.com",
  "ramesh.k@example.org",
  "hr@acme-industries.example.com",
  "9876543210",
  "+919876543210",
  "12.9715987,77.5945627",
  "12.9352400,77.6245400",
  "27AAPFU0939F1ZV",
  "ABCPK1234M",
  "1234 5678 9012",
  "123456789012",
  "HDFC0001234",
  "42 MG Road, Indiranagar, Bengaluru 560038",
  "1990-04-12",
  "192.168.1.42",
  PII_HOME_PATH,
  "buyer.example.com",
  "lender.example.com",
  "b4f1e2a0-0000-4000-8000-000000000001",
];

/**
 * Assert that nothing in `PII_LITERALS` appears anywhere in `value`.
 *
 * Serialises the whole thing rather than checking known fields, because the
 * failure this guards against is data appearing somewhere nobody looked.
 */
export function expectNoPii(value: unknown): void {
  const serialised = JSON.stringify(value);
  const leaked = PII_LITERALS.filter((literal) => serialised.includes(literal));
  expect(
    leaked,
    `these literals survived redaction: ${leaked.join(", ")}`,
  ).toEqual([]);
}
