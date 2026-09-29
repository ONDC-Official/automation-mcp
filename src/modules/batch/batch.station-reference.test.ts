import { describe, expect, it } from "vitest";
import {
  nearestStation,
  STATION_REFERENCE,
} from "@/modules/batch/batch.station-reference.js";

describe("nearestStation", () => {
  it("returns the exact station when the GPS matches it precisely", () => {
    const target = STATION_REFERENCE[5]!;
    expect(nearestStation(target.gps).code).toBe(target.code);
  });

  it("returns the closer of two candidates", () => {
    const a = STATION_REFERENCE[0]!;
    const b = STATION_REFERENCE[1]!;
    // A point nudged fractionally toward `a` from `b`'s coordinates.
    const nearA: readonly [number, number] = [
      b.gps[0] + (a.gps[0] - b.gps[0]) * 0.9,
      b.gps[1] + (a.gps[1] - b.gps[1]) * 0.9,
    ];
    expect(nearestStation(nearA).code).toBe(a.code);
  });

  it("never throws for a point far outside the whole table", () => {
    expect(() => nearestStation([0, 0])).not.toThrow();
    expect(() => nearestStation([90, 180])).not.toThrow();
  });

  it("the reference table has no duplicate codes", () => {
    const codes = STATION_REFERENCE.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
