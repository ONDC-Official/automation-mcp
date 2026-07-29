import { MockRunner } from "@ondc/automation-mock-runner";
import type {
  UpstreamFlow,
  UpstreamMockConfig,
} from "@/modules/catalog/catalog.schema.js";

/**
 * A flow whose mock-runner config **actually executes**.
 *
 * `ondc-fixtures.ts` holds real captured config-service responses, but their
 * base64 bodies are truncated to keep the file readable — they describe a
 * config faithfully and cannot be run. Anything that drives the flow loop needs
 * the opposite: a small config, invented but genuinely executable, so tests
 * exercise the real worker round trip rather than a stub of it.
 *
 * The shape is a miniature of the real thing: a `search` the mock BAP sends, an
 * `on_search` the participant answers with, a `select`/`on_select` pair, and a
 * form step — enough to cover every branch the loop takes.
 */

/** The `(domain, version, usecase)` these fixtures are published under. */
export const RUNNABLE_BUILD = {
  domain: "ONDC:FIS12",
  version: "2.0.3",
  usecase: "PERSONAL LOAN",
} as const;

export const RUNNABLE_FLOW_ID = "Runnable_Loop";

/**
 * The flow definition, as `/ui/flow` would return it.
 *
 * `search` carries `expect: true` — that is what arms an expectation and lets
 * an inbound callback find its transaction.
 */
export const RUNNABLE_FLOW: UpstreamFlow = {
  id: RUNNABLE_FLOW_ID,
  description: "A miniature loan flow used to exercise the flow loop.",
  tags: ["WORKBENCH", "REPORTABLE"],
  sequence: [
    {
      key: "search_1",
      type: "search",
      owner: "BAP",
      description: "The buyer app searches for loan offers.",
      expect: true,
      unsolicited: false,
      pair: "on_search_1",
      repeat: 1,
    },
    {
      key: "on_search_1",
      type: "on_search",
      owner: "BPP",
      description: "The seller app answers with a catalog.",
      expect: false,
      unsolicited: false,
      pair: null,
      repeat: 1,
    },
    {
      key: "select_1",
      type: "select",
      owner: "BAP",
      description: "The buyer app selects an offer.",
      expect: false,
      unsolicited: false,
      pair: "on_select_1",
      repeat: 1,
      input: [
        {
          name: "loan_amount",
          label: "Amount to borrow",
          type: "text",
        },
      ],
    },
    {
      key: "on_select_1",
      type: "on_select",
      owner: "BPP",
      description: "The seller app confirms the selection.",
      expect: false,
      unsolicited: false,
      pair: null,
      repeat: 1,
    },
  ],
  extraSequence: [],
};

/** The same flow with a trailing mock-hosted form step. */
export const RUNNABLE_FORM_FLOW_ID = "Runnable_Loop_Form";

export const RUNNABLE_FORM_FLOW: UpstreamFlow = {
  ...RUNNABLE_FLOW,
  id: RUNNABLE_FORM_FLOW_ID,
  sequence: [
    ...RUNNABLE_FLOW.sequence,
    {
      key: "kyc_form",
      type: "HTML_FORM",
      owner: "BPP",
      description: "The borrower completes a KYC form.",
      label: "KYC details",
      unsolicited: false,
      pair: null,
      repeat: 1,
      input: [
        {
          name: "form_submission_id",
          label: "Enter form submission id",
          type: "HTML_FORM",
          reference: "$.reference_data.kyc_form",
        },
      ],
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* The executable half                                                         */
/* -------------------------------------------------------------------------- */

const b64 = (source: string): string => MockRunner.encodeBase64(source);

/**
 * `generate` bodies echo their inputs into the message so tests can assert the
 * runner really ran, and that session data reached it.
 *
 * Note the signatures: `generate` is `async`, `validate` and
 * `meetsRequirements` are synchronous. The runner enforces both the name and
 * the return shape (`{valid, code, description}`), so these are written exactly
 * as a real config would be.
 */
const GENERATE_SEARCH = b64(`
async function generate(defaultPayload, sessionData) {
  defaultPayload.message = {
    intent: { descriptor: { name: sessionData.user_inputs?.query ?? "loan" } },
  };
  return defaultPayload;
}
`);

const GENERATE_SELECT = b64(`
async function generate(defaultPayload, sessionData) {
  defaultPayload.message = {
    order: {
      provider: { id: sessionData.providerId?.[0] ?? "unknown-provider" },
      amount: sessionData.user_inputs?.loan_amount ?? null,
    },
  };
  return defaultPayload;
}
`);

const GENERATE_ON = b64(`
async function generate(defaultPayload, sessionData) {
  defaultPayload.message = { order: { id: "order-1", state: "CREATED" } };
  return defaultPayload;
}
`);

const VALIDATE_OK = b64(`
function validate(targetPayload, sessionData) {
  if (!targetPayload || !targetPayload.message) {
    return { valid: false, code: 30000, description: "message is required" };
  }
  return { valid: true, code: 200, description: "ok" };
}
`);

/** Rejects anything without a catalog — a realistic L2 check. */
const VALIDATE_ON_SEARCH = b64(`
function validate(targetPayload, sessionData) {
  const catalog = targetPayload?.message?.catalog;
  if (!catalog) {
    return { valid: false, code: 30001, description: "catalog is missing" };
  }
  return { valid: true, code: 200, description: "ok" };
}
`);

const REQUIREMENTS_OK = b64(`
function meetsRequirements(sessionData) {
  return { valid: true, code: 200, description: "ready" };
}
`);

/** Blocks until `providerId` has been saved from a prior step. */
const REQUIREMENTS_NEEDS_PROVIDER = b64(`
function meetsRequirements(sessionData) {
  const provider = sessionData.providerId;
  const has = Array.isArray(provider) ? provider.length > 0 : Boolean(provider);
  return has
    ? { valid: true, code: 200, description: "ready" }
    : { valid: false, code: 40001, description: "no provider selected yet" };
}
`);

const FORM_HTML = b64(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>KYC details</title></head>
<body>
  <form id="kycForm" method="POST" action="<%= actionUrl %>">
    <label for="pan">PAN</label>
    <input type="text" id="pan" name="pan" />
    <input type="submit" value="Submit" />
  </form>
</body>
</html>
`);

interface StepOverrides {
  generate: string;
  validate: string;
  requirements: string;
  saveData?: Record<string, string>;
  formHtml?: string;
}

function step(
  api: string,
  actionId: string,
  owner: "BAP" | "BPP",
  responseFor: string | null,
  overrides: StepOverrides,
): UpstreamMockConfig["steps"][number] {
  return {
    api,
    action_id: actionId,
    owner,
    responseFor,
    unsolicited: false,
    description: `${api} step`,
    mock: {
      generate: overrides.generate,
      validate: overrides.validate,
      requirements: overrides.requirements,
      defaultPayload: { context: { action: api }, message: {} },
      saveData: overrides.saveData ?? {},
      inputs: {},
      ...(overrides.formHtml !== undefined
        ? { formHtml: overrides.formHtml }
        : {}),
    },
  };
}

/**
 * Build the executable mock config for `RUNNABLE_FLOW`.
 *
 * `transaction_data` deliberately carries the same canned `bap.example.com`
 * identity a real published config does — the loop is expected to override it
 * from session data, and a test that seeded clean values here would not notice
 * if it stopped doing so.
 */
export function buildRunnableMockConfig(flowId: string): UpstreamMockConfig {
  return {
    meta: {
      domain: RUNNABLE_BUILD.domain,
      version: RUNNABLE_BUILD.version,
      flowId,
      flowName: "Runnable Loop",
      use_case_id: RUNNABLE_BUILD.usecase,
      config_version: "0.0.1",
    },
    transaction_data: {
      transaction_id: "canned-fixture-transaction-id",
      latest_timestamp: "1970-01-01T00:00:00.000Z",
      bap_id: "bap.example.com",
      bap_uri: "https://bap.example.com",
      bpp_id: "bpp.example.com",
      bpp_uri: "https://bpp.example.com",
    },
    steps: [
      step("search", "search_1", "BAP", null, {
        generate: GENERATE_SEARCH,
        validate: VALIDATE_OK,
        requirements: REQUIREMENTS_OK,
        saveData: { latestMessage_id: "$.context.message_id" },
      }),
      step("on_search", "on_search_1", "BPP", "search_1", {
        generate: GENERATE_ON,
        validate: VALIDATE_ON_SEARCH,
        requirements: REQUIREMENTS_OK,
        saveData: { providerId: "$.message.catalog.providers[*].id" },
      }),
      step("select", "select_1", "BAP", null, {
        generate: GENERATE_SELECT,
        validate: VALIDATE_OK,
        requirements: REQUIREMENTS_NEEDS_PROVIDER,
        saveData: { orderAmount: "$.message.order.amount" },
      }),
      step("on_select", "on_select_1", "BPP", "select_1", {
        generate: GENERATE_ON,
        validate: VALIDATE_OK,
        requirements: REQUIREMENTS_OK,
        saveData: { orderId: "$.message.order.id" },
      }),
      step("html_form", "kyc_form", "BPP", null, {
        generate: GENERATE_ON,
        validate: VALIDATE_OK,
        requirements: REQUIREMENTS_OK,
        formHtml: FORM_HTML,
      }),
    ],
    transaction_history: [],
    helperLib: "",
    validationLib: "",
  };
}

/** The `on_search` a scripted participant sends back — passes L2. */
export function validOnSearchPayload(
  transactionId: string,
  messageId: string,
): Record<string, unknown> {
  return {
    context: {
      domain: RUNNABLE_BUILD.domain,
      action: "on_search",
      version: RUNNABLE_BUILD.version,
      transaction_id: transactionId,
      message_id: messageId,
      timestamp: new Date().toISOString(),
      bap_id: "mock.ondc-mcp.local",
      bap_uri: "http://127.0.0.1:3001/ONDC:RET10/2.0.2/buyer",
      bpp_id: "np.example.com",
      bpp_uri: "https://np.example.com",
      ttl: "PT30S",
    },
    message: {
      catalog: {
        providers: [{ id: "provider-1", descriptor: { name: "Bank" } }],
      },
    },
  };
}
