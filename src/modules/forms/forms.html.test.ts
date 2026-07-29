import { describe, expect, it } from "vitest";
import {
  formActionUrl,
  parseFields,
  resolveFormActions,
  validateFormHtml,
} from "@/modules/forms/forms.html.js";

/**
 * The screen and the parser.
 *
 * These read a page written by the system under test — which is, by
 * definition, the component we do not trust. The screen's job is to refuse the
 * obviously dangerous and *report* the merely suspicious, so nothing gets
 * quietly cleaned up and then trusted anyway.
 */

const GOOD = `<!DOCTYPE html>
<html><head><title>KYC</title></head>
<body>
  <form id="kyc" method="POST" action="/forms/submit">
    <label for="pan">PAN number</label>
    <input type="text" id="pan" name="pan" required />
    <label for="income">Annual income</label>
    <input type="number" id="income" name="income" value="500000" />
    <label for="employment">Employment</label>
    <select id="employment" name="employment">
      <option value="salaried">Salaried</option>
      <option value="self">Self employed</option>
    </select>
    <textarea id="notes" name="notes">prefilled</textarea>
    <input type="hidden" name="transaction_id" value="txn-1" />
    <input type="submit" value="Submit" />
  </form>
</body></html>`;

describe("validateFormHtml", () => {
  it("accepts an ordinary form and reports its shape", () => {
    const scan = validateFormHtml(GOOD);

    expect(scan.ok).toBe(true);
    expect(scan.errors).toEqual([]);
    expect(scan.method).toBe("POST");
    expect(scan.action).toBe("/forms/submit");
    expect(scan.fields.map((field) => field.name)).toEqual([
      "pan",
      "income",
      "transaction_id",
      "notes",
      "employment",
    ]);
  });

  it.each([
    ["a script tag", "<form><script>alert(1)</script></form>"],
    ["an iframe", "<form><iframe src='x'></iframe></form>"],
    ["an inline handler", `<form><input name="a" onclick="steal()" /></form>`],
    ["a javascript: action", `<form action="javascript:go()"></form>`],
  ])("refuses %s", (_name, html) => {
    const scan = validateFormHtml(html);
    expect(scan.ok).toBe(false);
    expect(scan.errors.length).toBeGreaterThan(0);
  });

  it("refuses a page with no form at all", () => {
    const scan = validateFormHtml("<html><body>gone fishing</body></html>");
    expect(scan.ok).toBe(false);
    expect(scan.errors).toContain("No <form> element found.");
  });

  it("warns rather than refuses on a suspicious hidden field", () => {
    // Not fatal — plenty of legitimate forms carry a redirect — but the caller
    // is about to fill this in, so it gets told.
    const scan = validateFormHtml(
      `<form action="/x"><input type="hidden" name="redirect_url" value="http://evil" /><input type="submit" /></form>`,
    );

    expect(scan.ok).toBe(true);
    expect(scan.warnings.join(" ")).toContain("redirect_url");
  });

  it("warns when there is nothing to submit with", () => {
    const scan = validateFormHtml(
      `<form action="/x"><input name="a" /></form>`,
    );
    expect(scan.ok).toBe(true);
    expect(scan.warnings.join(" ")).toContain("submit control");
  });
});

describe("parseFields", () => {
  it("pairs a label with its input", () => {
    const [pan] = parseFields(GOOD);
    expect(pan).toMatchObject({
      name: "pan",
      type: "text",
      label: "PAN number",
      required: true,
    });
  });

  it("reads a select's options as submittable values", () => {
    const employment = parseFields(GOOD).find(
      (field) => field.name === "employment",
    );
    expect(employment?.options).toEqual(["salaried", "self"]);
  });

  it("keeps prefilled values so they can be sent back unchanged", () => {
    const fields = parseFields(GOOD);
    expect(fields.find((f) => f.name === "income")?.value).toBe("500000");
    expect(fields.find((f) => f.name === "notes")?.value).toBe("prefilled");
    expect(fields.find((f) => f.name === "transaction_id")).toMatchObject({
      hidden: true,
      value: "txn-1",
    });
  });

  it("skips submit and reset controls — they are not values", () => {
    expect(parseFields(GOOD).map((f) => f.name)).not.toContain("Submit");
  });

  it("handles single-quoted and unquoted attributes", () => {
    const fields = parseFields(
      `<input type='email' name='a' required><input type=text name=b>`,
    );
    expect(fields.map((f) => [f.name, f.type])).toEqual([
      ["a", "email"],
      ["b", "text"],
    ]);
    expect(fields[0]?.required).toBe(true);
  });
});

describe("resolveFormActions", () => {
  const BASE = "https://np.example.com/forms/kyc?id=1";

  it("resolves a relative action against the page's own URL", () => {
    // By submission time we no longer have the browser's notion of where the
    // page came from, so this has to happen at fetch time.
    const resolved = resolveFormActions(
      BASE,
      `<form action="/submit" method="POST"></form>`,
    );
    expect(resolved).toContain('action="https://np.example.com/submit"');
  });

  it("leaves an absolute or protocol-relative action alone", () => {
    expect(
      resolveFormActions(BASE, `<form action="https://other.test/s"></form>`),
    ).toContain('action="https://other.test/s"');
    expect(
      resolveFormActions(BASE, `<form action="//other.test/s"></form>`),
    ).toContain('action="//other.test/s"');
  });

  it("points an empty or '#' action back at the page, as a browser would", () => {
    const resolved = resolveFormActions(BASE, `<form action="#"></form>`);
    expect(resolved).toContain(
      'action="https://np.example.com/forms/kyc?id=1"',
    );
  });

  it("preserves the form's other attributes", () => {
    const resolved = resolveFormActions(
      BASE,
      `<form id="kyc" method="POST" action="/s" class="x"></form>`,
    );
    expect(resolved).toContain('id="kyc"');
    expect(resolved).toContain('method="POST"');
    expect(resolved).toContain('class="x"');
  });

  it("rejects a non-http base", () => {
    expect(() => resolveFormActions("ftp://x/y", "<form></form>")).toThrow(
      /Invalid baseUrl/,
    );
  });
});

describe("formActionUrl", () => {
  it("returns the absolute submit target", () => {
    expect(
      formActionUrl("https://np.example.com/f/kyc", `<form action="/submit">`),
    ).toBe("https://np.example.com/submit");
  });

  it("falls back to the page URL when there is no action", () => {
    expect(formActionUrl("https://np.example.com/f/kyc", `<form>`)).toBe(
      "https://np.example.com/f/kyc",
    );
  });

  it("returns undefined when there is no form", () => {
    expect(
      formActionUrl("https://np.example.com", "<p>nope</p>"),
    ).toBeUndefined();
  });
});
