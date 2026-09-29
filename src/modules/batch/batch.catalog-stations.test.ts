import { describe, expect, it } from "vitest";
import {
  pickStations,
  stationsFromCatalog,
} from "@/modules/batch/batch.catalog-stations.js";

const stop = (code: string, gps?: string) => ({
  location: { descriptor: { code }, ...(gps ? { gps } : {}) },
});

describe("stationsFromCatalog", () => {
  it("collects distinct codes across routes, keeping GPS when given", () => {
    const stations = stationsFromCatalog([
      { stops: [stop("A", "12.9,77.5"), stop("B"), stop("A")] },
      { stops: [stop("C", "13.0,77.6")] },
    ]);
    expect(stations.map((s) => s.code)).toEqual(["A", "B", "C"]);
    expect(stations[0]?.gps).toEqual([12.9, 77.5]);
    expect(stations[1]?.gps).toBeUndefined();
  });

  it("keeps only serviceable codes when restricted", () => {
    const stations = stationsFromCatalog(
      [{ stops: [stop("A"), stop("B"), stop("C")] }],
      ["B", "C", "Z"],
    );
    expect(stations.map((s) => s.code)).toEqual(["B", "C"]);
  });

  it("skips anything malformed instead of throwing", () => {
    expect(stationsFromCatalog(undefined)).toEqual([]);
    expect(
      stationsFromCatalog([null, { stops: "x" }, { stops: [{}, stop("")] }]),
    ).toEqual([]);
  });
});

describe("pickStations", () => {
  const gpsStations = stationsFromCatalog([
    {
      stops: [
        stop("WEST", "12.90,77.50"),
        stop("MID", "12.95,77.60"),
        stop("EAST", "13.00,77.70"),
      ],
    },
  ]);

  it("uses the nearest stations when the catalog carries GPS", () => {
    const picked = pickStations(gpsStations, [12.91, 77.51], [12.99, 77.69]);
    expect([picked?.start.code, picked?.end.code]).toEqual(["WEST", "EAST"]);
  });

  it("re-centres GPS on random stations when the order is nowhere near the network", () => {
    const picks = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const picked = pickStations(gpsStations, [0, 0], [0, 0]);
      expect(picked?.start.code).not.toBe(picked?.end.code);
      expect(picked?.originGps).toMatch(/^-?\d+\.\d{6},-?\d+\.\d{6}$/);
      picks.add(`${picked?.start.code}>${picked?.end.code}`);
    }
    expect(picks.size).toBeGreaterThan(1);
  });

  it("never returns the same station for both ends", () => {
    const picked = pickStations(gpsStations, [12.9, 77.5], [12.9, 77.5]);
    expect(picked?.start.code).toBe("WEST");
    expect(picked?.end.code).not.toBe("WEST");
  });

  it("falls back to a random distinct pair without GPS", () => {
    const bare = stationsFromCatalog([
      { stops: [stop("A"), stop("B"), stop("C")] },
    ]);
    for (let i = 0; i < 50; i++) {
      const picked = pickStations(bare, [0, 0], [0, 0]);
      expect(picked?.start.code).not.toBe(picked?.end.code);
    }
  });

  it("gives up with fewer than two stations", () => {
    expect(
      pickStations(
        stationsFromCatalog([{ stops: [stop("ONLY")] }]),
        [0, 0],
        [0, 0],
      ),
    ).toBeUndefined();
  });
});
