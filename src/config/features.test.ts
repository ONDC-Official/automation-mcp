import { describe, expect, it, vi } from "vitest";
import {
  describeConflict,
  MODULE_NAMES,
  PROFILES,
  resolveFeatures,
  selectedModules,
  unknownModules,
  type FeatureConfig,
} from "@/config/features.js";
import { parseConfig } from "@/config/env.js";

const base: FeatureConfig = {
  PROFILE: "full",
  MODULES_DISABLED: [],
  MODULES_ENABLED: [],
  UI_ENABLED: true,
  METRICS_ENABLED: true,
  FEEDBACK_DISABLED: false,
  MIRROR_ENDPOINT_URL: "https://ingest.example.com",
};

describe("profiles", () => {
  it("defaults to every module, so the default changes nothing", () => {
    const features = resolveFeatures(base);
    expect(features.names).toEqual([...MODULE_NAMES]);
  });

  it("keeps the loop but drops the observers under `minimal`", () => {
    const features = resolveFeatures({ ...base, PROFILE: "minimal" });
    expect(features.enabled("flow")).toBe(true);
    expect(features.enabled("transport")).toBe(true);
    expect(features.enabled("feedback")).toBe(false);
    expect(features.enabled("ui")).toBe(false);
    expect(features.enabled("mirror")).toBe(false);
    expect(features.enabled("metrics")).toBe(false);
  });

  it("keeps metrics but nothing else optional under `driver`", () => {
    const features = resolveFeatures({ ...base, PROFILE: "driver" });
    expect(features.enabled("metrics")).toBe(true);
    expect(features.enabled("ui")).toBe(false);
    expect(features.enabled("feedback")).toBe(false);
  });

  it("registers in MODULE_NAMES order, not selection order", () => {
    const features = resolveFeatures({
      ...base,
      PROFILE: "minimal",
      MODULES_ENABLED: ["ui", "feedback"],
    });
    expect(features.names).toEqual(
      MODULE_NAMES.filter((n) => features.enabled(n)),
    );
  });
});

describe("the arithmetic", () => {
  it("subtracts MODULES_DISABLED from the profile", () => {
    const selected = selectedModules({
      PROFILE: "full",
      MODULES_DISABLED: ["ui"],
      MODULES_ENABLED: [],
    });
    expect(selected.has("ui")).toBe(false);
  });

  it("applies MODULES_ENABLED after MODULES_DISABLED", () => {
    const selected = selectedModules({
      PROFILE: "minimal",
      MODULES_DISABLED: ["ui"],
      MODULES_ENABLED: ["ui"],
    });
    expect(selected.has("ui")).toBe(true);
  });
});

describe("the gate only ever removes", () => {
  /*
   * The property that keeps every existing deployment working: a profile can
   * take a module away, but it can never switch one on that its own flag has
   * turned off. `CLAUDE.md` is explicit that `MIRROR_ENDPOINT_URL` unset is
   * the *only* mirror off switch, and a profile that could override that would
   * be exactly the second flag it refuses to have.
   */
  it("cannot switch the mirror on without an endpoint", () => {
    const features = resolveFeatures({
      ...base,
      PROFILE: "full",
      MODULES_ENABLED: ["mirror"],
      MIRROR_ENDPOINT_URL: undefined,
    });
    expect(features.enabled("mirror")).toBe(false);
  });

  it("cannot switch the viewer on when UI_ENABLED is off", () => {
    const features = resolveFeatures({
      ...base,
      MODULES_ENABLED: ["ui"],
      UI_ENABLED: false,
    });
    expect(features.enabled("ui")).toBe(false);
  });

  it("cannot switch feedback on when FEEDBACK_DISABLED is set", () => {
    const features = resolveFeatures({
      ...base,
      MODULES_ENABLED: ["feedback"],
      FEEDBACK_DISABLED: true,
    });
    expect(features.enabled("feedback")).toBe(false);
  });
});

describe("dependency conflicts", () => {
  it("accepts every shipped profile", () => {
    for (const [name, modules] of Object.entries(PROFILES)) {
      expect(describeConflict(new Set(modules)), name).toBeUndefined();
    }
  });

  it("names both sides when a dependency is missing", () => {
    const selected = selectedModules({
      PROFILE: "full",
      MODULES_DISABLED: ["record"],
      MODULES_ENABLED: [],
    });
    expect(describeConflict(selected)).toMatch(/requires "record"/);
  });

  it("reports names that are not modules", () => {
    expect(unknownModules(["ui", "nope", "flow"])).toEqual(["nope"]);
  });
});

describe("boot refusal", () => {
  /*
   * A contradictory profile must refuse to boot rather than start half-wired,
   * matching how `AUTH_MODE=none`-in-production and a missing `METRICS_TOKEN`
   * are already handled. `parseConfig` exits the process on failure, so these
   * assert through `safeParse` semantics by catching the exit.
   */
  const exits = (env: Record<string, string>): string => {
    let captured = "";
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((): never => {
        throw new Error("__exit__");
      });
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown): boolean => {
        captured += String(chunk);
        return true;
      });
    try {
      parseConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", ...env });
    } catch {
      /* the stubbed exit */
    } finally {
      exit.mockRestore();
      write.mockRestore();
    }
    return captured;
  };

  it("refuses a profile missing a dependency", () => {
    expect(exits({ MODULES_DISABLED: "record" })).toMatch(/requires "record"/);
  });

  it("refuses an unknown module name", () => {
    expect(exits({ MODULES_DISABLED: "recrod" })).toMatch(/unknown module/);
  });

  it("accepts the default", () => {
    expect(exits({})).toBe("");
  });
});
