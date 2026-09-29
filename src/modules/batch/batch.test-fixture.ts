import { MockRunner } from "@ondc/automation-mock-runner";
import type {
  UpstreamFlow,
  UpstreamMockConfig,
} from "@/modules/catalog/catalog.schema.js";
import { RUNNABLE_BUILD } from "@/test/runnable-config.js";

/**
 * A small, genuinely-executable flow shaped like the TRV11 Metro SJT flow's
 * essentials — `search` (BAP, needs `city_code`) → `on_search` (BPP) →
 * `select` (BAP, needs `Item_id`/`Item_Quantity`, and the seller's real item
 * id is saved off `on_search`) → `on_select` (BPP) → main sequence COMPLETE,
 * plus one `unsolicited: true` extra step only the BPP side can fire.
 *
 * Modelled directly on `src/test/runnable-config.ts` (see it for the general
 * pattern); this is `batch`'s own variant because the real thing needs
 * `search2`-free shape and an unsolicited close, which the shared fixture
 * does not have.
 */

// Reuses the fake config-service's already-registered build rather than
// inventing a new one — `session.createSession` validates the build against
// the published catalog first, and adding a second fake build for one test
// fixture is not worth the extra surface in shared test infrastructure.
export const BATCH_FIXTURE_BUILD = RUNNABLE_BUILD;

export const BATCH_FIXTURE_FLOW_ID = "Batch_Fixture_Journey";

const SEARCH_STEP = "search_1";
const SELECT_STEP = "select_1";
const CLOSE_STEP = "unsolicited_close_1";

export const BATCH_FIXTURE_FLOW: UpstreamFlow = {
  id: BATCH_FIXTURE_FLOW_ID,
  description: "A miniature Metro-shaped journey used to exercise `batch`.",
  tags: ["WORKBENCH", "REPORTABLE"],
  sequence: [
    {
      key: "search_1",
      type: "search",
      owner: "BAP",
      description: "The buyer app searches by city.",
      expect: true,
      unsolicited: false,
      pair: "on_search_1",
      repeat: 1,
      input: [
        {
          name: "FixtureSearchInput",
          jsonSchema: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: {
              city_code: { type: "string", default: "" },
            },
            additionalProperties: true,
          },
        },
      ],
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
      description: "The buyer app selects a real item off on_search's catalog.",
      expect: false,
      unsolicited: false,
      pair: "on_select_1",
      repeat: 1,
      input: [
        {
          name: "FixtureSelectInput",
          jsonSchema: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: {
              Item_id: { type: "string", default: "" },
              Item_Quantity: { type: "number", default: 1 },
            },
            additionalProperties: true,
          },
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
  extraSequence: [
    {
      key: "unsolicited_close_1",
      type: "on_status",
      owner: "BPP",
      description: "The seller app unilaterally closes the journey.",
      expect: false,
      unsolicited: true,
      pair: null,
      repeat: 1,
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* The executable half — see runnable-config.ts for the pattern explained     */
/* -------------------------------------------------------------------------- */

const b64 = (source: string): string => MockRunner.encodeBase64(source);

const GENERATE_SEARCH = b64(`
async function generate(defaultPayload, sessionData) {
  defaultPayload.message = {
    intent: { location: { city: { code: sessionData.user_inputs?.city_code ?? null } } },
  };
  return defaultPayload;
}
`);

const GENERATE_SELECT = b64(`
async function generate(defaultPayload, sessionData) {
  defaultPayload.message = {
    order: {
      items: [{
        id: sessionData.user_inputs?.Item_id ?? null,
        quantity: { selected: { count: sessionData.user_inputs?.Item_Quantity ?? null } },
      }],
    },
  };
  return defaultPayload;
}
`);

const GENERATE_ON_SEARCH = b64(`
async function generate(defaultPayload, sessionData) {
  defaultPayload.message = {
    catalog: { providers: [ { items: [ { id: "real-item-42" } ] } ] },
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
  return { valid: true, code: 200, description: "ok" };
}
`);

const REQUIREMENTS_OK = b64(`
function meetsRequirements(sessionData) {
  return { valid: true, code: 200, description: "ready" };
}
`);

interface StepOverrides {
  generate: string;
  validate: string;
  requirements: string;
  saveData?: Record<string, string>;
  inputs?: unknown;
}

function step(
  api: string,
  actionId: string,
  owner: "BAP" | "BPP",
  responseFor: string | null,
  overrides: StepOverrides,
  unsolicited = false,
): UpstreamMockConfig["steps"][number] {
  return {
    api,
    action_id: actionId,
    owner,
    responseFor,
    unsolicited,
    description: `${api} step`,
    mock: {
      generate: overrides.generate,
      validate: overrides.validate,
      requirements: overrides.requirements,
      defaultPayload: { context: { action: api }, message: {} },
      saveData: overrides.saveData ?? {},
      inputs: overrides.inputs ?? {},
    },
  };
}

/**
 * A flow whose *first* step is a station search — no city search before it, so
 * no transaction is bound and no catalog exists yet when stations have to be
 * chosen. Exercises the fallback to a configured serviceable-station list
 * (`DriverFlowConfig.serviceableStationCodes`) rather than the driver's own
 * generated placeholder codes, which a real seller (and this fixture's own
 * `on_search`) rejects.
 */
export const STATION_FIRST_FLOW_ID = "Batch_Fixture_Station_First";
const STATION_FIRST_SEARCH_STEP = "search2_only";

export const STATION_FIRST_FLOW: UpstreamFlow = {
  id: STATION_FIRST_FLOW_ID,
  description: "Opens at a station search, with no prior city search.",
  tags: ["WORKBENCH"],
  sequence: [
    {
      key: STATION_FIRST_SEARCH_STEP,
      type: "search",
      owner: "BAP",
      description: "The buyer app searches by station pair.",
      expect: true,
      unsolicited: false,
      pair: "on_search2_only",
      repeat: 1,
      input: [
        {
          name: "FixtureStationInput",
          jsonSchema: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: {
              start_code: { type: "string", default: "" },
              end_code: { type: "string", default: "" },
            },
            additionalProperties: true,
          },
        },
      ],
    },
    {
      key: "on_search2_only",
      type: "on_search",
      owner: "BPP",
      description: "The seller app answers with a catalog.",
      expect: false,
      unsolicited: false,
      pair: null,
      repeat: 1,
    },
  ],
  extraSequence: [],
};

const GENERATE_STATION_SEARCH = b64(`
async function generate(defaultPayload, sessionData) {
  defaultPayload.message = {
    intent: {
      fulfillment: {
        stops: [
          { type: "START", location: { descriptor: { code: sessionData.user_inputs?.start_code ?? null } } },
          { type: "END", location: { descriptor: { code: sessionData.user_inputs?.end_code ?? null } } },
        ],
      },
    },
  };
  return defaultPayload;
}
`);

export function buildStationFirstMockConfig(): UpstreamMockConfig {
  return {
    meta: {
      domain: BATCH_FIXTURE_BUILD.domain,
      version: BATCH_FIXTURE_BUILD.version,
      flowId: STATION_FIRST_FLOW_ID,
      flowName: "Batch Fixture Station-First Journey",
      use_case_id: BATCH_FIXTURE_BUILD.usecase,
      config_version: "0.0.1",
    },
    transaction_data: {
      transaction_id: "fixture-transaction-id",
      latest_timestamp: "1970-01-01T00:00:00.000Z",
      bap_id: "bap.example.com",
      bap_uri: "https://bap.example.com",
      bpp_id: "bpp.example.com",
      bpp_uri: "https://bpp.example.com",
    },
    steps: [
      step("search", STATION_FIRST_SEARCH_STEP, "BAP", null, {
        generate: GENERATE_STATION_SEARCH,
        validate: VALIDATE_OK,
        requirements: REQUIREMENTS_OK,
        inputs: {
          id: "FixtureStationInput",
          jsonSchema: {
            type: "object",
            properties: {
              start_code: { type: "string" },
              end_code: { type: "string" },
            },
            additionalProperties: true,
          },
        },
      }),
      step("on_search", "on_search2_only", "BPP", STATION_FIRST_SEARCH_STEP, {
        generate: GENERATE_ON_SEARCH,
        validate: VALIDATE_OK,
        requirements: REQUIREMENTS_OK,
      }),
    ],
    transaction_history: [],
    helperLib: "",
    validationLib: "",
  };
}

export function buildBatchFixtureMockConfig(): UpstreamMockConfig {
  return {
    meta: {
      domain: BATCH_FIXTURE_BUILD.domain,
      version: BATCH_FIXTURE_BUILD.version,
      flowId: BATCH_FIXTURE_FLOW_ID,
      flowName: "Batch Fixture Journey",
      use_case_id: BATCH_FIXTURE_BUILD.usecase,
      config_version: "0.0.1",
    },
    transaction_data: {
      transaction_id: "fixture-transaction-id",
      latest_timestamp: "1970-01-01T00:00:00.000Z",
      bap_id: "bap.example.com",
      bap_uri: "https://bap.example.com",
      bpp_id: "bpp.example.com",
      bpp_uri: "https://bpp.example.com",
    },
    steps: [
      step("search", SEARCH_STEP, "BAP", null, {
        generate: GENERATE_SEARCH,
        validate: VALIDATE_OK,
        requirements: REQUIREMENTS_OK,
        inputs: {
          id: "FixtureSearchInput",
          jsonSchema: {
            type: "object",
            properties: { city_code: { type: "string" } },
            additionalProperties: true,
          },
        },
      }),
      step("on_search", "on_search_1", "BPP", SEARCH_STEP, {
        generate: GENERATE_ON_SEARCH,
        validate: VALIDATE_OK,
        requirements: REQUIREMENTS_OK,
        saveData: {
          item_ids: "$.message.catalog.providers[*].items[*].id",
        },
      }),
      step("select", SELECT_STEP, "BAP", null, {
        generate: GENERATE_SELECT,
        validate: VALIDATE_OK,
        requirements: REQUIREMENTS_OK,
        inputs: {
          id: "FixtureSelectInput",
          jsonSchema: {
            type: "object",
            properties: {
              Item_id: { type: "string" },
              Item_Quantity: { type: "number" },
            },
            additionalProperties: true,
          },
        },
      }),
      step("on_select", "on_select_1", "BPP", SELECT_STEP, {
        generate: GENERATE_ON,
        validate: VALIDATE_OK,
        requirements: REQUIREMENTS_OK,
      }),
      step(
        "on_status",
        // Fixed above, always set — this fixture exists precisely to give
        // `unsolicitedClose` a real value to test.
        CLOSE_STEP,
        "BPP",
        null,
        {
          generate: GENERATE_ON,
          validate: VALIDATE_OK,
          requirements: REQUIREMENTS_OK,
        },
        true,
      ),
    ],
    transaction_history: [],
    helperLib: "",
    validationLib: "",
  };
}
