import { describe, expect, it } from "vitest";
import {
  generateOrderInputs,
  IssuedPairTracker,
} from "@/modules/batch/batch.input-generator.js";
import { STATION_REFERENCE } from "@/modules/batch/batch.station-reference.js";

describe("generateOrderInputs", () => {
  it("every declared field is populated", () => {
    const tracker = new IssuedPairTracker();
    const inputs = generateOrderInputs(tracker);

    expect(inputs.city_code.length).toBeGreaterThan(0);
    expect(inputs.origin_gps).toMatch(/^-?\d+\.\d{6},-?\d+\.\d{6}$/);
    expect(inputs.destination_gps).toMatch(/^-?\d+\.\d{6},-?\d+\.\d{6}$/);
    expect(inputs.vehicle_category).toBe("METRO");
    expect(inputs.item_quantity).toBeGreaterThanOrEqual(1);
    expect(inputs.item_quantity).toBeLessThanOrEqual(4);
  });

  it("start and end stations are always distinct", () => {
    const tracker = new IssuedPairTracker();
    for (let i = 0; i < 50; i++) {
      const inputs = generateOrderInputs(tracker);
      expect(inputs.start_code).not.toBe(inputs.end_code);
    }
  });

  it("resolved station codes are drawn from the reference table", () => {
    const tracker = new IssuedPairTracker();
    const codes = new Set(STATION_REFERENCE.map((s) => s.code));
    const inputs = generateOrderInputs(tracker);
    expect(codes.has(inputs.start_code)).toBe(true);
    expect(codes.has(inputs.end_code)).toBe(true);
  });

  it("no two orders in one run share an identical station pair", () => {
    const tracker = new IssuedPairTracker();
    const pairs = new Set<string>();
    // Small enough relative to the ~16*15 possible ordered pairs that every
    // one should be unique without exhausting MAX_REROLLS.
    for (let i = 0; i < 100; i++) {
      const inputs = generateOrderInputs(tracker);
      const key = `${inputs.start_code}>${inputs.end_code}`;
      expect(pairs.has(key)).toBe(false);
      pairs.add(key);
    }
  });

  it("respects a custom bounding box and city code pool", () => {
    const tracker = new IssuedPairTracker();
    const box = {
      min_lat: 12.9,
      max_lat: 12.91,
      min_lon: 77.6,
      max_lon: 77.61,
    };
    const inputs = generateOrderInputs(tracker, {
      boundingBox: box,
      cityCodes: ["std:999"],
    });
    const [lat, lon] = inputs.origin_gps.split(",").map(Number);
    expect(lat).toBeGreaterThanOrEqual(box.min_lat);
    expect(lat).toBeLessThanOrEqual(box.max_lat);
    expect(lon).toBeGreaterThanOrEqual(box.min_lon);
    expect(lon).toBeLessThanOrEqual(box.max_lon);
    expect(inputs.city_code).toBe("std:999");
  });

  it("throws rather than silently picking undefined for an empty city pool", () => {
    const tracker = new IssuedPairTracker();
    expect(() => generateOrderInputs(tracker, { cityCodes: [] })).toThrow(
      /cityCodes must not be empty/,
    );
  });
});

describe("IssuedPairTracker", () => {
  it("claims a pair once and reports collisions on re-claim", () => {
    const tracker = new IssuedPairTracker();
    expect(tracker.claim("A", "B")).toBe(true);
    expect(tracker.claim("A", "B")).toBe(false);
    expect(tracker.claim("B", "A")).toBe(true);
  });
});
