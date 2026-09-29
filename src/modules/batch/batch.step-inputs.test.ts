import { describe, expect, it } from "vitest";
import {
  buildStepInputs,
  needsItem,
  needsStations,
  type Step,
} from "@/modules/batch/batch.step-inputs.js";
import type { OrderInputs } from "@/modules/batch/batch.schema.js";

const order: OrderInputs = {
  city_code: "std:080",
  origin_gps: "28.7,77.1",
  destination_gps: "28.6,77.2",
  start_code: "MOCK_STATION_2",
  end_code: "MOCK_STATION_9",
  vehicle_category: "METRO",
  item_quantity: 3,
};

/** A step as the config-service publishes it (`schema.properties`). */
const step = (
  key: string,
  properties: Record<string, Record<string, unknown>>,
  schemaKey: "schema" | "jsonSchema" = "schema",
): Step => {
  const declaration: Record<string, unknown> = { name: "x" };
  declaration[schemaKey] = { properties };
  return {
    key,
    type: "search",
    owner: "BAP",
    input: [declaration],
  } as unknown as Step;
};

describe("buildStepInputs", () => {
  it("fills a city search from the order", () => {
    expect(
      buildStepInputs(step("s1", { city_code: { default: "std:011" } }), {
        order,
      }),
    ).toEqual({ city_code: "std:080" });
  });

  it("fills a station search, keeping vehicle_category only when the flow allows it", () => {
    const allowed = step("s2", {
      vehicle_category: { enum: ["METRO"], default: "METRO" },
      start_code: {},
      end_code: {},
    });
    expect(buildStepInputs(allowed, { order })).toEqual({
      vehicle_category: "METRO",
      start_code: "MOCK_STATION_2",
      end_code: "MOCK_STATION_9",
    });

    const notAllowed = step("s2", {
      vehicle_category: { enum: ["BUS"], default: "BUS" },
      start_code: {},
      end_code: {},
    });
    expect(buildStepInputs(notAllowed, { order })["vehicle_category"]).toBe(
      "BUS",
    );
  });

  it("fills both published select shapes with the item read back from the seller", () => {
    expect(
      buildStepInputs(
        step("sel", { Item_id: {}, Item_Quantity: { default: 1 } }),
        {
          order,
          itemId: "I7",
        },
      ),
    ).toEqual({ Item_id: "I7", Item_Quantity: 3 });

    expect(
      buildStepInputs(step("sel", { items: { type: "array" } }), {
        order,
        itemId: "I7",
      }),
    ).toEqual({ items: [{ id: "I7", quantity: { selected: { count: 3 } } }] });
  });

  it("never invents an item id", () => {
    expect(
      buildStepInputs(step("sel", { Item_id: {}, Item_Quantity: {} }), {
        order,
      })["Item_id"],
    ).toBeUndefined();
    expect(buildStepInputs(step("sel", { items: {} }), { order })).toEqual({
      id: "sel",
    });
  });

  it("takes the flow's own default for a field it has no better value for", () => {
    expect(
      buildStepInputs(
        step("update", { end_stop: { default: "MOCK_STATION_5" }, note: {} }),
        { order },
      ),
    ).toEqual({ end_stop: "MOCK_STATION_5" });
  });

  it("gives a step it can fill nothing of a placeholder, since an empty object reads as no input", () => {
    expect(
      buildStepInputs(step("issue", { description: {} }), { order }),
    ).toEqual({
      id: "issue",
    });
  });

  it("reads mock-runner style declarations too (jsonSchema)", () => {
    expect(
      buildStepInputs(step("s1", { city_code: {} }, "jsonSchema"), { order }),
    ).toEqual({ city_code: "std:080" });
  });

  it("works with no order at all (the seller side), on defaults only", () => {
    expect(
      buildStepInputs(step("s", { choice: { default: "ACCEPT" } }), {}),
    ).toEqual({ choice: "ACCEPT" });
  });
});

describe("what a step needs", () => {
  it("knows a station search and an item pick", () => {
    expect(needsStations(step("s2", { start_code: {}, end_code: {} }))).toBe(
      true,
    );
    expect(needsStations(step("s1", { city_code: {} }))).toBe(false);
    expect(needsItem(step("sel", { items: {} }))).toBe(true);
    expect(needsItem(step("sel", { Item_id: {} }))).toBe(true);
    expect(needsItem(step("s1", { city_code: {} }))).toBe(false);
  });
});
