/**
 * Reading a counterparty's form without a DOM.
 *
 * ## Why regexes and not a parser
 *
 * The alternative is `cheerio` (what the workbench uses) — 3MB of dependency to
 * read a handful of `<input>` tags out of a page we already refuse to execute.
 * These forms are small, machine-generated, and structurally boring; and the
 * cost of being wrong is bounded, because nothing here decides anything
 * security-relevant on its own. `validateFormHtml` is a **conservative screen**
 * whose job is to refuse the obviously dangerous and warn about the merely
 * suspicious — not to be a sanitiser we then trust.
 *
 * ## What we are actually defending against
 *
 * The page comes from the system under test, and it is shown to a human or read
 * by a model. Ported from the workbench's `form-utils.ts`, the screen rejects
 * active content (`<script>`, `<iframe>`, inline `on*` handlers, `javascript:`
 * URLs) and flags hidden fields with names that suggest redirection or
 * credentials. Everything else is reported, not silently cleaned, so the caller
 * decides with the evidence in front of it.
 */

export interface FormFieldInfo {
  name: string;
  type: string;
  label?: string | undefined;
  required: boolean;
  value?: string | undefined;
  options?: string[] | undefined;
  hidden: boolean;
}

export interface FormScan {
  ok: boolean;
  errors: string[];
  warnings: string[];
  action?: string | undefined;
  method: "GET" | "POST";
  fields: FormFieldInfo[];
}

/**
 * One attribute: a name, then optionally `=` and a quoted or bare value.
 *
 * The optional value half is load-bearing — `required`, `checked`, `disabled`
 * and `multiple` are boolean attributes written with no value at all, and
 * `required` in particular decides whether the caller has to fill a field.
 */
const TAG_ATTRS =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/** Attributes of one tag's opening text, lower-cased keys. */
export function readAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(TAG_ATTRS)) {
    const key = match[1]?.toLowerCase();
    if (!key) continue;
    // A valueless attribute is present with an empty value, so callers can
    // test presence with `in`.
    attrs[key] = match[3] ?? match[4] ?? match[5] ?? "";
  }
  return attrs;
}

/** Names whose presence in a hidden field is worth flagging to a human. */
const SUSPICIOUS_HIDDEN = ["redirect", "callback", "token", "url", "password"];

/**
 * Screen a counterparty's form and pull out its fields.
 *
 * `ok: false` means do not show this page to anyone and do not fill it in.
 */
export function validateFormHtml(html: string): FormScan {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const tag of ["script", "iframe", "object", "embed"]) {
    if (new RegExp(`<\\s*${tag}\\b`, "i").test(html)) {
      errors.push(`Forbidden tag present: <${tag}>`);
    }
  }

  // Inline event handlers — `onclick`, `onload`, and the rest.
  for (const match of html.matchAll(/\son([a-z]+)\s*=/gi)) {
    errors.push(`Inline event handler "on${match[1] ?? ""}" found`);
  }

  if (/\b(?:href|src|action)\s*=\s*["']?\s*javascript:/i.test(html)) {
    errors.push("javascript: URL found in an href, src or action");
  }

  const formMatch = /<form\b([^>]*)>([\s\S]*?)<\/form>/i.exec(html);
  if (!formMatch) {
    return {
      ok: false,
      errors: [...errors, "No <form> element found."],
      warnings,
      method: "GET",
      fields: [],
    };
  }
  if (/<form\b/gi.test(html) && (html.match(/<form\b/gi)?.length ?? 0) > 1) {
    errors.push("Multiple <form> elements found (expected exactly one).");
  }

  const formAttrs = readAttributes(formMatch[1] ?? "");
  const rawMethod = (formAttrs["method"] ?? "GET").toUpperCase();
  const method = rawMethod === "POST" ? "POST" : "GET";
  if (rawMethod !== "GET" && rawMethod !== "POST") {
    warnings.push(
      `Unsupported form method "${rawMethod}" (treating as ${method}).`,
    );
  }

  const body = formMatch[2] ?? "";
  const fields = parseFields(body);

  if (!/type\s*=\s*["']?submit/i.test(body) && !/<button\b/i.test(body)) {
    warnings.push("No visible submit control found.");
  }

  const suspicious = fields
    .filter((field) => field.hidden)
    .filter((field) =>
      SUSPICIOUS_HIDDEN.some((needle) =>
        field.name.toLowerCase().includes(needle),
      ),
    );
  if (suspicious.length > 0) {
    warnings.push(
      `Suspicious hidden fields: ${suspicious.map((f) => f.name).join(", ")}`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    action: formAttrs["action"]?.trim(),
    method,
    fields,
  };
}

/** Inputs, selects and textareas of a form body, with their labels. */
export function parseFields(body: string): FormFieldInfo[] {
  const labels = new Map<string, string>();
  for (const match of body.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
    const target = readAttributes(match[1] ?? "")["for"];
    const text = stripTags(match[2] ?? "").trim();
    if (target && text) labels.set(target, text);
  }

  const fields: FormFieldInfo[] = [];

  for (const match of body.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = readAttributes(match[1] ?? "");
    const name = attrs["name"];
    const type = (attrs["type"] ?? "text").toLowerCase();
    // A submit button is a control, not a value the caller has to supply.
    if (!name || type === "submit" || type === "reset" || type === "button") {
      continue;
    }
    fields.push({
      name,
      type,
      label: labelFor(labels, attrs),
      required: "required" in attrs,
      value: attrs["value"],
      hidden: type === "hidden",
    });
  }

  for (const match of body.matchAll(
    /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi,
  )) {
    const attrs = readAttributes(match[1] ?? "");
    const name = attrs["name"];
    if (!name) continue;
    fields.push({
      name,
      type: "textarea",
      label: labelFor(labels, attrs),
      required: "required" in attrs,
      value: stripTags(match[2] ?? "").trim() || undefined,
      hidden: false,
    });
  }

  for (const match of body.matchAll(
    /<select\b([^>]*)>([\s\S]*?)<\/select>/gi,
  )) {
    const attrs = readAttributes(match[1] ?? "");
    const name = attrs["name"];
    if (!name) continue;

    const options: string[] = [];
    for (const option of (match[2] ?? "").matchAll(
      /<option\b([^>]*)>([\s\S]*?)<\/option>/gi,
    )) {
      const optionAttrs = readAttributes(option[1] ?? "");
      // The submitted value is `value` when present, the text otherwise.
      options.push(optionAttrs["value"] ?? stripTags(option[2] ?? "").trim());
    }

    fields.push({
      name,
      type: "select",
      label: labelFor(labels, attrs),
      required: "required" in attrs,
      options,
      hidden: false,
    });
  }

  return fields;
}

function labelFor(
  labels: Map<string, string>,
  attrs: Record<string, string>,
): string | undefined {
  const id = attrs["id"];
  return id !== undefined ? labels.get(id) : undefined;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

/**
 * Rewrite `<form action>` to an absolute URL, resolved against the page's own.
 *
 * A form fetched from the participant routinely posts to a relative path, and
 * by the time we submit it we no longer have the browser's notion of "where
 * this page came from". Resolving it at fetch time is what keeps the submission
 * reaching the right server.
 *
 * An empty, `#`, or `javascript:` action resolves to the page URL itself, which
 * is the same thing a browser would do.
 */
export function resolveFormActions(baseUrl: string, html: string): string {
  let base: URL;
  try {
    base = new URL(baseUrl);
    if (!/^https?:$/i.test(base.protocol)) {
      throw new Error("Base URL must be http(s)");
    }
  } catch {
    throw new Error(`Invalid baseUrl: ${baseUrl}`);
  }

  return html.replace(/<form\b([^>]*)>/gi, (tag, attrs: string) => {
    const current = readAttributes(attrs)["action"]?.trim() ?? "";

    if (/^https?:\/\//i.test(current) || current.startsWith("//")) return tag;

    const clean = new URL(base.toString());
    clean.hash = "";
    const resolved =
      current === "" || current === "#" || /^\s*javascript\s*:/i.test(current)
        ? clean.toString()
        : new URL(current, base).toString();

    const withoutAction = attrs.replace(
      /\saction\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
      "",
    );
    return `<form${withoutAction} action="${escapeAttribute(resolved)}">`;
  });
}

/** Absolute action URL of the first form, if it has one. */
export function formActionUrl(
  baseUrl: string,
  html: string,
): string | undefined {
  const match = /<form\b([^>]*)>/i.exec(html);
  if (!match) return undefined;

  const action = readAttributes(match[1] ?? "")["action"]?.trim();
  if (action === undefined || action === "" || action === "#") return baseUrl;

  try {
    return new URL(action, baseUrl).toString();
  } catch {
    return undefined;
  }
}

export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
