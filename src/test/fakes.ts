import type { ConfigServiceGateway } from "@/modules/catalog/catalog.gateway.js";
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

  // Captured flows plus the two whose configs actually execute, so a test can
  // choose between fidelity to the wire and a real worker round trip.
  const flows: UpstreamFlow[] = [
    ...UpstreamFlowsResponse.parse(FLOWS_RESPONSE).data.flows,
    UpstreamFlow.parse(RUNNABLE_FLOW),
    UpstreamFlow.parse(RUNNABLE_FORM_FLOW),
  ];
  const mockConfig = UpstreamMockConfig.parse(MOCK_CONFIG_RESPONSE);
  const runnableConfigs = new Map<string, UpstreamMockConfig>([
    [RUNNABLE_FLOW_ID, UpstreamMockConfig.parse(buildRunnableMockConfig(RUNNABLE_FLOW_ID))],
    [
      RUNNABLE_FORM_FLOW_ID,
      UpstreamMockConfig.parse(buildRunnableMockConfig(RUNNABLE_FORM_FLOW_ID)),
    ],
  ]);
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
