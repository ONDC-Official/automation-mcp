import { describe, expect, it } from "vitest";
import { parseConfig } from "@/config/env.js";
import { logger } from "@/lib/logger.js";
import { HttpConfigServiceGateway } from "@/modules/catalog/catalog.gateway.js";
import { buildSpecBundle } from "@/modules/protocol/protocol.bundle.js";

/**
 * Contract test against the **real** config-service. Skipped unless
 * `RUN_LIVE_TESTS=1`.
 *
 *     RUN_LIVE_TESTS=1 npm test -- protocol.live
 *
 * This is the most important live test in the repo, and the reason is worth
 * stating: `/protocol/spec/{domain}/{version}` is an **undocumented internal
 * endpoint**. Nothing upstream promises its shape, no version is negotiated,
 * and the whole `protocol` module is a bet that the shape is stable and the
 * same across domains. A fixture cannot check that bet — it is a copy of the
 * thing being checked.
 *
 * So it runs over three builds from three different families. "The shape is
 * identical across domains" is this module's foundation and it deserves a
 * check rather than a memory.
 *
 * Loose about content that legitimately moves (which flows exist, how many
 * codes are published); strict about structure.
 */

const LIVE = process.env.RUN_LIVE_TESTS === "1";
const TIMEOUT_MS = 60_000;
/** Comfortably above the 10.5 MB observed, far below anything alarming. */
const MAX_SPEC_BYTES = 41_943_040;

const BUILDS = [
  { domain: "ONDC:TRV11", version: "2.0.1" },
  { domain: "ONDC:RET11", version: "1.2.5" },
  { domain: "ONDC:FIS12", version: "2.0.3" },
];

function liveGateway(): HttpConfigServiceGateway {
  const config = parseConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });
  return new HttpConfigServiceGateway({
    baseUrl: config.CONFIG_SERVICE_URL,
    timeoutMs: TIMEOUT_MS,
    logger: logger.child({ test: "protocol.live" }),
  });
}

describe.skipIf(!LIVE)("the published spec endpoint", () => {
  for (const build of BUILDS) {
    describe(`${build.domain} ${build.version}`, () => {
      it(
        "answers with the sections this module is built on",
        async () => {
          const raw = (await liveGateway().fetchSpec(
            build.domain,
            build.version,
            MAX_SPEC_BYTES,
          )) as Record<string, unknown>;

          for (const key of [
            "meta",
            "docs",
            "attributes",
            "validationTable",
            "validations",
            // Asserted even though we drop it: if upstream stops sending
            // `flows` we want to learn it deliberately, not to silently save
            // 8 MB and wonder later why the payload shrank.
            "flows",
          ]) {
            expect(raw, `missing section: ${key}`).toHaveProperty(key);
          }

          const meta = raw.meta as Record<string, unknown>;
          // The action graph, and the entry key that a JSON object has to
          // spell as a string.
          expect(meta.supportedActions).toBeTypeOf("object");
          expect(meta.supportedActions).toHaveProperty("null");
          // The correlation contract — the load-bearing fact for `must_echo`.
          expect(meta.apiProperties).toBeTypeOf("object");
          expect(Array.isArray(meta.errorCodes)).toBe(true);

          // `validations` nests one level deeper than it reads. If that ever
          // flattens, the rule tools need to know.
          expect(raw.validations).toHaveProperty("validations");

          // No `$ref` anywhere in `meta.paths`, and no `components` to resolve
          // against — which is what makes a per-action schema cheap to serve.
          expect(meta.components ?? null).toBeNull();
          expect(JSON.stringify(meta.paths ?? {})).not.toContain("$ref");
        },
        TIMEOUT_MS,
      );

      it(
        "reduces to a bundle that is small, complete and quick",
        async () => {
          const started = Date.now();
          const raw = await liveGateway().fetchSpec(
            build.domain,
            build.version,
            MAX_SPEC_BYTES,
          );
          const bundle = buildSpecBundle({ ...build, raw });
          const elapsed = Date.now() - started;

          expect(bundle.actions.length).toBeGreaterThan(5);
          // Phase 2/3 retain these; a build that stopped publishing either
          // would leave describe_action and explain_rule silently empty.
          expect(bundle.rules.length).toBeGreaterThan(0);
          expect(Object.keys(bundle.schemas).length).toBeGreaterThan(0);
          expect(Object.keys(bundle.fields).length).toBeGreaterThan(0);
          for (const byAction of Object.values(bundle.fields)) {
            const paths = Object.values(byAction)
              .flat()
              .map((field) => field.path);
            expect(paths.length).toBeGreaterThan(0);
            // Every synthesised path must be evaluable: a `/` or `@` in a key
            // has to be bracket-quoted, never dotted.
            for (const path of paths) {
              expect(path.startsWith("$")).toBe(true);
              expect(/\.[^.[]*[/@]/.test(path)).toBe(false);
            }
          }
          expect(bundle.error_codes.length).toBeGreaterThan(0);
          expect(bundle.usecases.length).toBeGreaterThan(0);
          expect(bundle.docs.overview ?? "").not.toBe("");
          // Every code is a string whichever type upstream published.
          for (const entry of bundle.error_codes) {
            expect(typeof entry.code).toBe("string");
          }
          // No flow config survived — the 8 MB question.
          for (const flow of bundle.flows) {
            expect(flow).not.toHaveProperty("config");
          }

          // The two numbers the timeout and the bundle cap were chosen from.
          expect(bundle.bytes).toBeLessThan(4_000_000);
          expect(elapsed).toBeLessThan(TIMEOUT_MS);
        },
        TIMEOUT_MS,
      );
    });
  }
});
