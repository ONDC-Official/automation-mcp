import { randomUUID } from "node:crypto";
import { MockRunner } from "@ondc/automation-mock-runner";
import ejs from "ejs";
import type { Dispatcher } from "undici";
import { request } from "undici";
import type { Logger } from "pino";
import { NotFoundError, UpstreamError, ValidationError } from "@/lib/errors.js";
import type { UpstreamMockConfig } from "@/modules/catalog/catalog.schema.js";
import type { MappedStep } from "@/modules/flow/engine/engine-types.js";
import { getFlowCompleteStatus } from "@/modules/flow/engine/flow-mapper.js";
import type { FlowRuntime, FlowService } from "@/modules/flow/flow.service.js";
import {
  formActionUrl,
  resolveFormActions,
  validateFormHtml,
  type FormFieldInfo,
} from "@/modules/forms/forms.html.js";
import type {
  FetchFormOutput,
  SubmitFormOutput,
} from "@/modules/forms/forms.schema.js";
import {
  unwrapSaved,
  type RecordService,
} from "@/modules/record/record.service.js";

/**
 * Forms, in both directions.
 *
 * A form step is the one place a beckn flow leaves the protocol and goes
 * through a web page, and which side hosts the page decides everything:
 *
 * - **We host it.** The payload we sent carried a URL built by the config's own
 *   `createFormURL` helper — `{mockBaseUrl}/forms/{domain}/{formId}/?…` — so
 *   the routes have to match that shape exactly. We render the config's own
 *   `formHtml` through ejs (which is what those templates are authored
 *   against), take the submission, mint an id, and advance the flow.
 * - **They host it.** Their payload carried their URL. We fetch it, screen it,
 *   parse its fields, fill them, and POST back. In `manual` mode we stop at
 *   "here is the link" and let a human do the middle part.
 *
 * Either way the step completes the same way any other does: a `submission_id`
 * lands in business data under the step's key, and `flow_proceed` moves on.
 */

const FORM_TYPES = new Set(["HTML_FORM", "DYNAMIC_FORM", "HTML_FORM_MULTI"]);

export interface FormsServiceOptions {
  flows: FlowService;
  records: RecordService;
  logger: Logger;
  /** Budget for fetching a counterparty-hosted page. */
  fetchTimeoutMs: number;
  /** Base URL our own hosted forms are served from. */
  publicBaseUrl: string;
  dispatcher?: Dispatcher;
}

export interface RenderHostedFormArgs {
  domain: string;
  formId: string;
  transactionId: string;
  sessionId: string;
}

export interface AcceptSubmissionArgs extends RenderHostedFormArgs {
  fields: Record<string, string>;
}

export class FormsService {
  readonly #flows: FlowService;
  readonly #records: RecordService;
  readonly #logger: Logger;
  readonly #fetchTimeoutMs: number;
  readonly #publicBaseUrl: string;
  readonly #dispatcher: Dispatcher | undefined;

  constructor(options: FormsServiceOptions) {
    this.#flows = options.flows;
    this.#records = options.records;
    this.#logger = options.logger;
    this.#fetchTimeoutMs = options.fetchTimeoutMs;
    this.#publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, "");
    this.#dispatcher = options.dispatcher;
  }

  /* ============================== fill side ============================== */

  /**
   * Read a form the participant hosts.
   *
   * In `manual` mode this stops at the link: a human opens the page, submits
   * it, and reports the id back. In `llm_auto` it fetches and parses so the
   * caller can fill the fields itself.
   */
  async fetchForm(
    sessionId: string,
    transactionId: string,
    stepKey?: string,
  ): Promise<FetchFormOutput> {
    const runtime = await this.#flows.load(sessionId, transactionId);
    const step = await this.#resolveFormStep(runtime, stepKey);

    // WAITING-SUBMISSION means we are the host — there is nothing to fetch.
    if (step.status === "WAITING-SUBMISSION") {
      const url = this.hostedFormUrl(
        runtime.config.meta.domain ?? runtime.session.build.domain,
        step.actionId,
        transactionId,
        sessionId,
      );
      return {
        step_key: step.actionId,
        mode: runtime.session.interaction_mode,
        role: "host",
        form_url: url,
        fields: [],
        warnings: [],
        instructions:
          "This mock serves this form; the participant under test has to open " +
          "and submit it. The URL was already sent in this mock's payload. " +
          "Call flow_await — the submission arrives as a FORM_SUBMITTED event.",
      };
    }

    const source = await this.#formSource(runtime, step.actionId);

    if (runtime.session.interaction_mode === "manual") {
      return {
        step_key: step.actionId,
        mode: "manual",
        role: "fill",
        ...(source.url !== undefined ? { form_url: source.url } : {}),
        fields: [],
        warnings: [],
        instructions:
          "This session is in manual mode. Give the form URL to the person " +
          "driving this test; once they submit it the participant issues a " +
          "submission id. Call form_submit with that id to advance the flow.",
      };
    }

    const html = source.html ?? (await this.#fetchHtml(source.url ?? ""));
    const scan = validateFormHtml(html);

    if (!scan.ok) {
      // Refused, not sanitised: this page is about to be filled with test data
      // and possibly shown to a person.
      throw new ValidationError(
        `The form served for "${step.actionId}" was refused: ${scan.errors.join("; ")}`,
        { step_key: step.actionId, errors: scan.errors, form_url: source.url },
      );
    }

    const actionUrl =
      source.url !== undefined ? formActionUrl(source.url, html) : scan.action;

    return {
      step_key: step.actionId,
      mode: "llm_auto",
      role: "fill",
      ...(source.url !== undefined ? { form_url: source.url } : {}),
      ...(actionUrl !== undefined ? { action_url: actionUrl } : {}),
      method: scan.method,
      fields: scan.fields.map(toField),
      warnings: scan.warnings,
      instructions:
        "Fill every required field and call form_submit with a `fields` map " +
        "keyed by these names. Hidden fields are pre-filled — send them back " +
        "unchanged unless you mean to change them.",
    };
  }

  /**
   * Submit a form the participant hosts, or record the id a human obtained.
   *
   * Either way it ends the same: the id goes into business data under the step
   * key, and the flow advances.
   */
  async submitForm(args: {
    sessionId: string;
    transactionId: string;
    stepKey?: string | undefined;
    fields?: Record<string, string> | undefined;
    submissionId?: string | undefined;
  }): Promise<SubmitFormOutput> {
    const runtime = await this.#flows.load(args.sessionId, args.transactionId);
    const step = await this.#resolveFormStep(runtime, args.stepKey);

    let submissionId = args.submissionId;
    let rawResponse: unknown;

    if (submissionId === undefined) {
      if (runtime.session.interaction_mode === "manual") {
        throw new ValidationError(
          "This session is in manual mode: pass the submission_id the person " +
            "driving the test was given after submitting the form.",
          { step_key: step.actionId },
        );
      }

      const posted = await this.#postForm(
        runtime,
        step.actionId,
        args.fields ?? {},
      );
      submissionId = posted.submissionId;
      rawResponse = posted.raw;
    }

    const outcome = await this.#flows.proceed({
      sessionId: args.sessionId,
      transactionId: args.transactionId,
      inputs: { submission_id: submissionId },
    });

    return {
      step_key: step.actionId,
      submission_id: submissionId,
      ...(rawResponse !== undefined ? { raw_response: rawResponse } : {}),
      outcome,
    };
  }

  /**
   * Fetch and screen a participant-hosted form ahead of time.
   *
   * Called by the receiver the moment a payload supplies a form URL, so the
   * page is already retrieved, screened and action-resolved before anyone asks
   * for it. Returns `undefined` — never throws — when the page cannot be had or
   * fails the screen: this runs after an ACK has already been decided, and a
   * form we could not pre-fetch is simply fetched on demand later.
   */
  async prefetchForm(url: string): Promise<string | undefined> {
    try {
      const html = await this.#fetchHtml(url);
      const scan = validateFormHtml(html);
      if (!scan.ok) {
        this.#logger.warn(
          { url, errors: scan.errors },
          "the participant's form failed the security screen",
        );
        return undefined;
      }
      return html;
    } catch (error) {
      this.#logger.warn({ err: error, url }, "could not pre-fetch a form");
      return undefined;
    }
  }

  /* ============================== host side ============================== */

  /**
   * The URL the config's `createFormURL` helper builds for a form we host.
   *
   * Reproduced here rather than derived: the helper bakes this shape into the
   * payload we already sent, so the routes and this must agree exactly or the
   * participant follows a link to nothing.
   */
  hostedFormUrl(
    domain: string,
    formId: string,
    transactionId: string,
    sessionId: string,
  ): string {
    return `${this.#publicBaseUrl}/forms/${domain}/${formId}/?transaction_id=${encodeURIComponent(transactionId)}&session_id=${encodeURIComponent(sessionId)}`;
  }

  /** Render the config's own `formHtml` for the participant to fill in. */
  async renderHostedForm(
    args: RenderHostedFormArgs,
  ): Promise<{ status: number; html: string }> {
    try {
      const runtime = await this.#flows.load(
        args.sessionId,
        args.transactionId,
      );
      const config = findConfigStep(runtime.config, args.formId);
      const encoded = config?.mock?.formHtml;

      if (typeof encoded !== "string" || encoded.length === 0) {
        return {
          status: 404,
          html: errorPage(
            `No form is published for step "${args.formId}" in this flow.`,
          ),
        };
      }

      const submitUrl = `${this.#publicBaseUrl}/forms/${args.domain}/${args.formId}/submit?transaction_id=${encodeURIComponent(args.transactionId)}&session_id=${encodeURIComponent(args.sessionId)}`;

      // Config form templates are authored against ejs with exactly these two
      // locals — `actionUrl` is the one the workbench's own default form uses.
      const html = ejs.render(MockRunner.decodeBase64(encoded), {
        actionUrl: submitUrl,
        submissionData: JSON.stringify({
          session_id: args.sessionId,
          transaction_id: args.transactionId,
          flow_id: runtime.record.flowId,
        }),
      });

      return { status: 200, html };
    } catch (error) {
      this.#logger.warn(
        { err: error, formId: args.formId },
        "could not render a hosted form",
      );
      return {
        status: 400,
        html: errorPage(
          error instanceof Error
            ? error.message
            : "Could not render this form.",
        ),
      };
    }
  }

  /**
   * Take a submission on a form we host, then advance the flow.
   *
   * The id is minted here because we are the issuing side — the participant
   * quotes it back in its next payload, which is how the flow proves the form
   * was really completed.
   */
  async acceptSubmission(
    args: AcceptSubmissionArgs,
  ): Promise<{ status: number; html: string; json: unknown }> {
    try {
      const runtime = await this.#flows.load(
        args.sessionId,
        args.transactionId,
      );
      const submissionId = randomUUID();

      const data = await this.#records.getBusinessData(
        args.transactionId,
        runtime.session.np.subscriber_url,
      );
      const formData =
        typeof data["formData"] === "object" && data["formData"] !== null
          ? (data["formData"] as Record<string, unknown>)
          : {};
      formData[args.formId] = {
        ...args.fields,
        form_submission_id: submissionId,
      };
      data["formData"] = formData;
      await this.#records.overwriteBusinessData(
        args.transactionId,
        runtime.session.np.subscriber_url,
        data,
      );

      const outcome = await this.#flows.proceed({
        sessionId: args.sessionId,
        transactionId: args.transactionId,
        inputs: { submission_id: submissionId },
      });

      this.#logger.info(
        {
          transactionId: args.transactionId,
          formId: args.formId,
          submissionId,
          outcome: outcome.outcome,
        },
        "hosted form submitted",
      );

      return {
        status: 200,
        html: successPage(submissionId),
        json: { success: true, submission_id: submissionId },
      };
    } catch (error) {
      this.#logger.warn(
        { err: error, formId: args.formId },
        "could not accept a form submission",
      );
      const message =
        error instanceof Error ? error.message : "Could not accept this form.";
      return {
        status: 400,
        html: errorPage(message),
        json: { success: false, error: message },
      };
    }
  }

  /* ============================== internals ============================== */

  /**
   * Which form step this call is about.
   *
   * Defaults to whichever the flow is actually waiting on, so the common case
   * needs no `step_key` — the caller rarely knows the key and the flow always
   * does.
   */
  async #resolveFormStep(
    runtime: FlowRuntime,
    stepKey: string | undefined,
  ): Promise<MappedStep> {
    const { session, record, flow } = runtime;
    const map = getFlowCompleteStatus(
      record,
      flow,
      await this.#records.getFlowStatus(
        record.transactionId,
        session.np.subscriber_url,
      ),
      await this.#records.getBusinessData(
        record.transactionId,
        session.np.subscriber_url,
      ),
    );

    const steps = [...map.sequence, ...(map.extraSteps ?? [])];

    if (stepKey !== undefined) {
      const named = steps.find((step) => step.actionId === stepKey);
      if (!named) {
        throw new NotFoundError("form step", stepKey, {
          available: steps
            .filter((step) => FORM_TYPES.has(step.actionType))
            .map((step) => step.actionId),
        });
      }
      if (!FORM_TYPES.has(named.actionType)) {
        throw new ValidationError(
          `Step "${stepKey}" is a ${named.actionType}, not a form.`,
          { step_key: stepKey, action: named.actionType },
        );
      }
      return named;
    }

    const pending = steps.find(
      (step) => FORM_TYPES.has(step.actionType) && step.status !== "COMPLETE",
    );
    if (!pending) {
      throw new NotFoundError("pending form step", runtime.record.flowId, {
        hint: "This flow is not waiting on a form. Call flow_get_status to see what it needs.",
      });
    }
    return pending;
  }

  /**
   * Where a participant-hosted form lives, or its already-resolved HTML.
   *
   * The receiver fetches and resolves the page ahead of time when it sees a
   * form step coming (the `HTML_FORM` lookahead), so the value under the step
   * key may already be markup rather than a URL. Handling both is what makes
   * that optimisation invisible here.
   */
  async #formSource(
    runtime: FlowRuntime,
    stepKey: string,
  ): Promise<{ url?: string; html?: string }> {
    const data = await this.#records.getBusinessData(
      runtime.record.transactionId,
      runtime.session.np.subscriber_url,
    );

    const value = unwrapSaved(data[stepKey]);

    if (typeof value !== "string" || value.length === 0) {
      throw new NotFoundError("form url", stepKey, {
        hint:
          "The participant has not sent a form URL for this step yet. It " +
          "normally arrives in the payload just before the form step — check " +
          "record_get_data.",
      });
    }

    return /^https?:\/\//i.test(value) ? { url: value } : { html: value };
  }

  async #fetchHtml(url: string): Promise<string> {
    if (!/^https?:\/\//i.test(url)) {
      throw new ValidationError(
        `"${url}" is not an http(s) URL, so this form cannot be fetched.`,
        { form_url: url },
      );
    }

    try {
      const response = await request(url, {
        method: "GET",
        headersTimeout: this.#fetchTimeoutMs,
        bodyTimeout: this.#fetchTimeoutMs,
        ...(this.#dispatcher ? { dispatcher: this.#dispatcher } : {}),
      });
      const html = await response.body.text();

      if (response.statusCode >= 400) {
        throw new UpstreamError(
          "network-participant",
          `serving the form at ${url} answered HTTP ${String(response.statusCode)}`,
          { form_url: url, status: response.statusCode },
        );
      }

      // Resolve relative actions now, while we still know where the page came
      // from — by submission time that context is gone.
      return resolveFormActions(url, html);
    } catch (error) {
      if (error instanceof UpstreamError || error instanceof ValidationError) {
        throw error;
      }
      throw new UpstreamError(
        "network-participant",
        `could not fetch the form at ${url}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { form_url: url },
      );
    }
  }

  /** POST filled fields back to the counterparty and read the id it issues. */
  async #postForm(
    runtime: FlowRuntime,
    stepKey: string,
    fields: Record<string, string>,
  ): Promise<{ submissionId: string; raw?: unknown }> {
    const source = await this.#formSource(runtime, stepKey);
    const html = source.html ?? (await this.#fetchHtml(source.url ?? ""));
    const actionUrl = formActionUrl(source.url ?? "", html);

    if (actionUrl === undefined) {
      throw new ValidationError(
        `The form for "${stepKey}" declares no action URL, so there is nowhere to submit it.`,
        { step_key: stepKey },
      );
    }

    const body = new URLSearchParams(fields).toString();

    let text: string;
    let status: number;
    try {
      const response = await request(actionUrl, {
        method: "POST",
        body,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json, text/html",
        },
        headersTimeout: this.#fetchTimeoutMs,
        bodyTimeout: this.#fetchTimeoutMs,
        ...(this.#dispatcher ? { dispatcher: this.#dispatcher } : {}),
      });
      status = response.statusCode;
      text = await response.body.text();
    } catch (error) {
      throw new UpstreamError(
        "network-participant",
        `could not submit the form to ${actionUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { step_key: stepKey, action_url: actionUrl },
      );
    }

    if (status >= 400) {
      throw new UpstreamError(
        "network-participant",
        `submitting the form to ${actionUrl} answered HTTP ${String(status)}`,
        { step_key: stepKey, status, body: text.slice(0, 500) },
      );
    }

    const parsed = tryParse(text);
    const submissionId = readSubmissionId(parsed);

    if (submissionId === undefined) {
      // The shape is not the one the workbench issues. Rather than invent an
      // id — which would let the flow proceed on a fiction — hand the whole
      // answer back so the caller can find the id itself.
      throw new ValidationError(
        `The participant accepted the form but its answer carried no recognisable submission id. ` +
          `Read the response and call form_submit again with submission_id set explicitly.`,
        { step_key: stepKey, response: parsed ?? text.slice(0, 1_000) },
      );
    }

    return { submissionId, raw: parsed };
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

function findConfigStep(
  config: UpstreamMockConfig,
  actionId: string,
): UpstreamMockConfig["steps"][number] | undefined {
  return config.steps.find((step) => step.action_id === actionId);
}

function toField(field: FormFieldInfo): FetchFormOutput["fields"][number] {
  return {
    name: field.name,
    type: field.type,
    ...(field.label !== undefined ? { label: field.label } : {}),
    required: field.required,
    ...(field.value !== undefined ? { value: field.value } : {}),
    ...(field.options !== undefined ? { options: field.options } : {}),
  };
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The id, under any of the names implementations actually use. */
export function readSubmissionId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;

  const record = body as Record<string, unknown>;
  for (const key of ["submission_id", "submissionId", "form_submission_id"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }

  const nested = record["data"] ?? record["message"];
  return nested !== undefined ? readSubmissionId(nested) : undefined;
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;margin:4rem auto;max-width:36rem;line-height:1.6}
code{background:#f3f4f6;padding:.15rem .35rem;border-radius:.25rem}</style>
</head><body>${body}</body></html>`;
}

function successPage(submissionId: string): string {
  return page(
    "Submitted",
    `<h1>Form submitted</h1><p>Submission id: <code>${submissionId}</code></p>
     <p>You can close this page — the flow has moved on.</p>`,
  );
}

function errorPage(message: string): string {
  return page("Form unavailable", `<h1>Form unavailable</h1><p>${message}</p>`);
}
