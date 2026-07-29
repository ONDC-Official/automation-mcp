import type { ConfigServiceGateway } from "@/modules/catalog/catalog.gateway.js";
import { parseValidationMessage } from "@/modules/validate/validate.parse.js";
import type {
  GatewayResult,
  ValidationGateway,
  ValidationRequest,
} from "@/modules/validate/validate.gateway.js";
import {
  UpstreamBuilds,
  UpstreamFlow,
  UpstreamFlowsResponse,
  UpstreamMockConfig,
  type BuildRef,
} from "@/modules/catalog/catalog.schema.js";
import {
  BUILDS_RESPONSE,
  FLOWS_RESPONSE,
  MOCK_CONFIG_RESPONSE,
} from "@/test/ondc-fixtures.js";
import {
  buildRunnableMockConfig,
  RUNNABLE_CHAIN_FLOW,
  RUNNABLE_CHAIN_FLOW_ID,
  RUNNABLE_FLOW,
  RUNNABLE_FLOW_ID,
  RUNNABLE_FORM_FLOW,
  RUNNABLE_FORM_FLOW_ID,
} from "@/test/runnable-config.js";

/**
 * A `ConfigServiceGateway` backed by captured responses.
 *
 * Tests must never reach the network: a suite whose result depends on a remote
 * service is a suite that fails for reasons unrelated to the change under test.
 * Every container built in a test therefore gets one of these.
 *
 * The fixtures are parsed through the **same schemas the real gateway uses**,
 * so a fixture that drifts out of shape fails here rather than quietly
 * diverging from production behaviour.
 */

export interface FakeConfigServiceGateway extends ConfigServiceGateway {
  /** How many times each method was called — for cache-hit assertions. */
  readonly calls: { builds: number; flows: number; mockConfig: number };
}

export interface FakeGatewayOptions {
  /** Flow ids this gateway knows about. Anything else 404s. */
  knownFlowIds?: string[];
  /** Make every call fail, e.g. to drive a `/ready` 503. */
  failWith?: Error;
}

export function createFakeConfigServiceGateway(
  options: FakeGatewayOptions = {},
): FakeConfigServiceGateway {
  const builds = UpstreamBuilds.parse(BUILDS_RESPONSE).map((entry) => ({
    domain: entry.key,
    versions: entry.version.map((version) => ({
      version: version.key,
      usecases: version.usecase,
    })),
  }));

  // Captured flows plus the three whose configs actually execute, so a test can
  // choose between fidelity to the wire and a real worker round trip.
  const flows: UpstreamFlow[] = [
    ...UpstreamFlowsResponse.parse(FLOWS_RESPONSE).data.flows,
    UpstreamFlow.parse(RUNNABLE_FLOW),
    UpstreamFlow.parse(RUNNABLE_FORM_FLOW),
    UpstreamFlow.parse(RUNNABLE_CHAIN_FLOW),
  ];
  const mockConfig = UpstreamMockConfig.parse(MOCK_CONFIG_RESPONSE);
  const runnableConfigs = new Map<string, UpstreamMockConfig>(
    [RUNNABLE_FLOW_ID, RUNNABLE_FORM_FLOW_ID, RUNNABLE_CHAIN_FLOW_ID].map(
      (flowId) => [
        flowId,
        UpstreamMockConfig.parse(buildRunnableMockConfig(flowId)),
      ],
    ),
  );
  const knownFlowIds =
    options.knownFlowIds ?? flows.map((flow: UpstreamFlow) => flow.id);

  const calls = { builds: 0, flows: 0, mockConfig: 0 };

  function guard(): void {
    if (options.failWith) throw options.failWith;
  }

  return {
    calls,
    fetchBuilds() {
      calls.builds += 1;
      guard();
      return Promise.resolve(builds);
    },
    fetchFlows(_build: BuildRef) {
      calls.flows += 1;
      guard();
      return Promise.resolve(flows);
    },
    fetchMockConfig(_build: BuildRef, flowId: string) {
      calls.mockConfig += 1;
      guard();
      if (!knownFlowIds.includes(flowId)) return Promise.resolve(undefined);
      return Promise.resolve(runnableConfigs.get(flowId) ?? mockConfig);
    },
    ping() {
      guard();
      return Promise.resolve(true);
    },
  };
}

/** The build every fixture-backed test uses. */
export const FIXTURE_BUILD: BuildRef = {
  domain: "ONDC:FIS12",
  version: "2.0.3",
  usecase: "PERSONAL LOAN",
};

/** A flow present in the fixtures, with both mock- and np-owned steps. */
export const FIXTURE_FLOW_ID = "Personal_Loan_Offline";

/* -------------------------------------------------------------------------- */
/* The validation oracle                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A `ValidationGateway` under the test's control.
 *
 * Defaults to answering `valid`, because almost every test in this suite is
 * about something else and a validator that started refusing payloads would
 * break all of them for reasons unrelated to what they assert.
 *
 * `invalidFrom` builds its findings with the **real parser**, so a test that
 * asserts on a code or a JSONPath is asserting against the grammar the live
 * service actually emits rather than against hand-written findings that could
 * drift from it.
 */
export interface FakeValidationGateway extends ValidationGateway {
  readonly calls: { validate: number };
  /** Every request judged, in order. */
  readonly seen: ValidationRequest[];
  /** Answer every subsequent call with this. */
  setResult(result: GatewayResult): void;
  /** Throw on every subsequent call — exercises the "a check threw" path. */
  setThrows(error: Error): void;
}

export function createFakeValidationGateway(
  initial: GatewayResult = { status: "valid" },
): FakeValidationGateway {
  let result = initial;
  let thrown: Error | undefined;
  const calls = { validate: 0 };
  const seen: ValidationRequest[] = [];

  return {
    calls,
    seen,
    setResult(next: GatewayResult) {
      result = next;
      thrown = undefined;
    },
    setThrows(error: Error) {
      thrown = error;
    },
    validate(request: ValidationRequest) {
      calls.validate += 1;
      seen.push(request);
      if (thrown) return Promise.reject(thrown);
      return Promise.resolve(result);
    },
    ping() {
      return Promise.resolve(true);
    },
  };
}

/** An `invalid` result whose findings come from the real parser. */
export function invalidFrom(message: string): GatewayResult {
  const { findings, docsUrl } = parseValidationMessage(message);
  return {
    status: "invalid",
    findings,
    ...(docsUrl !== undefined ? { docsUrl } : {}),
  };
}
