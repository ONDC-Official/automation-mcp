import { describe, expect, it } from "vitest";
import { parseConfig } from "@/config/env.js";
import { logger } from "@/lib/logger.js";
import {
  HttpValidationGateway,
  type ValidationGateway,
} from "@/modules/validate/validate.gateway.js";
import { L0_CODE } from "@/modules/validate/validate.schema.js";

/**
 * Contract test against the **real** api-service oracle. Skipped unless
 * `RUN_LIVE_TESTS=1`.
 *
 *     RUN_LIVE_TESTS=1 npm test -- validate.live
 *
 * This is the canary for the one structural risk in delegating validation: the
 * failure format is **prose, not a versioned API**. `validate.parse.ts` is
 * tested against captured fixtures, which proves it parses what upstream sent
 * *once*. Only this file can notice when upstream starts sending something
 * else.
 *
 * So the assertions are strict about the two grammars and the layer they imply,
 * and deliberately loose about which rules a build happens to publish — those
 * legitimately change as specs are revised.
 *
 * Calling this is safe: the `test` route is ONIX's `standaloneValidator`
 * module, which proxies nothing, stores nothing and creates no session or
 * transaction. It is the only endpoint in this repo's world we can hit from a
 * test without consequences for anyone.
 */

const LIVE = process.env.RUN_LIVE_TESTS === "1";
const TIMEOUT_MS = 30_000;

const BUILD = { domain: "ONDC:TRV11", version: "2.0.1" };

function liveGateway(): ValidationGateway {
  const config = parseConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });
  return new HttpValidationGateway({
    baseUrl: config.VALIDATION_SERVICE_URL,
    timeoutMs: TIMEOUT_MS,
    logger,
  });
}

/** A TRV11 search that really does pass, as of 2026-07-29. */
function compliantSearch(): unknown {
  return {
    context: {
      location: { city: { code: "std:080" }, country: { code: "IND" } },
      domain: BUILD.domain,
      timestamp: "2026-03-20T12:06:44.654Z",
      bap_id: "dev-automation.ondc.org",
      transaction_id: "3a0ebe08-114e-4ddc-a880-bb049df1db16",
      message_id: "b83754cc-5dff-4075-84ee-1ad906e85c45",
      version: BUILD.version,
      action: "search",
      bap_uri: "https://dev-automation.ondc.org/bap",
      ttl: "PT30S",
    },
    message: {
      intent: {
        fulfillment: { type: "ROUTE", vehicle: { category: "BUS" } },
        payment: { collected_by: "BAP" },
      },
    },
  };
}

describe.skipIf(!LIVE)("the live validation oracle", () => {
  it(
    "accepts a compliant payload",
    async () => {
      const result = await liveGateway().validate({
        ...BUILD,
        action: "search",
        payload: compliantSearch(),
      });

      expect(result.status).toBe("valid");
    },
    TIMEOUT_MS,
  );

  it(
    "still rejects a payload we know is bad",
    async () => {
      // The false-negative guard. ONIX skips L1 entirely — and answers ACK —
      // when a `protocol_validation=false` cookie is present. If this ever
      // starts passing, the oracle has stopped judging and every verdict this
      // server has reported since is worthless.
      const payload = compliantSearch() as {
        message: { intent: { fulfillment: { vehicle: { category: string } } } };
      };
      payload.message.intent.fulfillment.vehicle.category = "SUBMARINE";

      const result = await liveGateway().validate({
        ...BUILD,
        action: "search",
        payload,
      });

      expect(result.status).toBe("invalid");
    },
    TIMEOUT_MS,
  );

  it(
    "still speaks the L1 markdown grammar",
    async () => {
      const payload = compliantSearch() as {
        message: { intent: { fulfillment: { vehicle: { category: string } } } };
      };
      payload.message.intent.fulfillment.vehicle.category = "SUBMARINE";

      const result = await liveGateway().validate({
        ...BUILD,
        action: "search",
        payload,
      });

      expect(result.status).toBe("invalid");
      if (result.status !== "invalid") return;

      const [finding] = result.findings;
      // Structure, not content: a real rule code, a real JSONPath, attributed
      // to L1. Which rule fires is the spec's business and may change.
      expect(finding?.layer).toBe("L1");
      expect(finding?.code).toMatch(/^[A-Z0-9_]+$/);
      expect(finding?.json_path).toMatch(/^\$\./);
      // If this drifts, the parser fell back to the raw message.
      expect(finding?.code).not.toBe("VALIDATION_UNPARSED");
      expect(result.docsUrl).toContain("developer-guide");
    },
    TIMEOUT_MS,
  );

  it(
    "still speaks the L0 plain-text grammar, and short-circuits L1",
    async () => {
      const payload = compliantSearch() as { message: unknown };
      payload.message = ["not", "an", "object"];

      const result = await liveGateway().validate({
        ...BUILD,
        action: "search",
        payload,
      });

      expect(result.status).toBe("invalid");
      if (result.status !== "invalid") return;

      // Every finding L0: a schema failure stops the pipeline, which is what
      // makes the layer inferable from the grammar rather than guessed.
      expect(result.findings.every((f) => f.layer === "L0")).toBe(true);
      expect(result.findings[0]?.code).toBe(L0_CODE);
      expect(result.findings[0]?.json_path).toBe("$.message");
    },
    TIMEOUT_MS,
  );

  it(
    "reports a build it does not serve as unavailable, not invalid",
    async () => {
      const result = await liveGateway().validate({
        domain: "ONDC:NOSUCH",
        version: "9.9.9",
        action: "search",
        payload: compliantSearch(),
      });

      // A 404 means "this oracle has no opinion", not "your payload is wrong".
      // Reading it as invalid would fail compliant participants on any build
      // the instance was not built for.
      expect(result.status).toBe("unavailable");
    },
    TIMEOUT_MS,
  );

  it(
    "never calls out without a transaction_id, because that 500s",
    async () => {
      const payload = compliantSearch() as {
        context: Record<string, unknown>;
      };
      delete payload.context["transaction_id"];

      const result = await liveGateway().validate({
        ...BUILD,
        action: "search",
        payload,
      });

      expect(result.status).toBe("unavailable");
      if (result.status !== "unavailable") return;
      expect(result.reason).toContain("transaction_id");
    },
    TIMEOUT_MS,
  );
});
