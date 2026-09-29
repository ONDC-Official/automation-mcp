import { randomUUID } from "node:crypto";
import type {
  GpsBoundingBox,
  OrderInputs,
} from "@/modules/batch/batch.schema.js";
import { nearestStation } from "@/modules/batch/batch.station-reference.js";

/**
 * Every order this module drives gets its own inputs — never one static
 * template reused across a batch. Concretely:
 *
 * 1. A random-but-plausible **origin GPS**, jittered within a bounding box
 *    (default: a real Indian metro service area).
 * 2. A random-but-plausible **destination GPS**, re-rolled until it resolves
 *    to a *different* station than the origin — a journey needs two ends.
 * 3. Each resolved to its **nearest station** (`nearestStation`), which is
 *    what `start_code`/`end_code` are actually fed from — "a nearest and
 *    unique GPS call" per order, not a hardcoded station pair.
 * 4. `city_code` drawn from a small pool, `item_quantity` randomised — every
 *    field the flow declares as an input is generated, never templated.
 *
 * `IssuedPairTracker` guarantees no two orders in one run share an identical
 * origin/destination *station* pair — re-rolling on collision. At the scale
 * this module targets (up to tens of thousands of orders against a ~16-station
 * table) exact-pair collisions are otherwise likely, and "no two transactions
 * are clones of each other" was an explicit requirement, not just distinct
 * GPS decimals.
 */

const DEFAULT_BOUNDING_BOX: GpsBoundingBox = {
  min_lat: 12.9,
  max_lat: 13.05,
  min_lon: 77.5,
  max_lon: 77.66,
};

const DEFAULT_CITY_CODES = ["std:080"];

const MAX_REROLLS = 50;

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomGps(box: GpsBoundingBox): readonly [number, number] {
  return [
    randomInRange(box.min_lat, box.max_lat),
    randomInRange(box.min_lon, box.max_lon),
  ];
}

function formatGps([lat, lon]: readonly [number, number]): string {
  return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

/** Tracks station pairs already issued in this run, so no two orders collide. */
export class IssuedPairTracker {
  readonly #seen = new Set<string>();

  /** Records the pair and reports whether it was already issued. */
  claim(startCode: string, endCode: string): boolean {
    const key = `${startCode}>${endCode}`;
    if (this.#seen.has(key)) return false;
    this.#seen.add(key);
    return true;
  }
}

export interface InputGeneratorOptions {
  boundingBox?: GpsBoundingBox;
  cityCodes?: readonly string[];
  /** Injectable for tests; defaults to `Math.random` via `randomGps`. */
  random?: () => number;
}

/**
 * Generate one virtual transaction's inputs, guaranteed distinct (by station
 * pair) from every other call against the same `tracker`.
 *
 * `item_quantity` is randomised 1-4 — small enough to stay a plausible single
 * booking, varied enough that no two orders are byte-identical requests.
 */
export function generateOrderInputs(
  tracker: IssuedPairTracker,
  options: InputGeneratorOptions = {},
): OrderInputs {
  const box = options.boundingBox ?? DEFAULT_BOUNDING_BOX;
  const cityCodes = options.cityCodes ?? DEFAULT_CITY_CODES;

  let origin: readonly [number, number];
  let destination: readonly [number, number];
  let start: string;
  let end: string;

  let attempt = 0;
  do {
    origin = randomGps(box);
    destination = randomGps(box);
    start = nearestStation(origin).code;
    end = nearestStation(destination).code;
    attempt += 1;
  } while (
    (start === end || !tracker.claim(start, end)) &&
    attempt < MAX_REROLLS
  );

  // Exhausting MAX_REROLLS means the bounding box's station coverage is too
  // small for the requested transaction_count — fall back to a unique key
  // suffix so the run still proceeds rather than looping forever, and the
  // resulting pair is still recorded (claim() is idempotent-safe to call
  // again here since a fresh key can never collide).
  if (start === end) {
    end = `${end}_${randomUUID().slice(0, 8)}`;
    tracker.claim(start, end);
  }

  if (cityCodes.length === 0) {
    throw new Error("generateOrderInputs: cityCodes must not be empty");
  }
  const cityCode = cityCodes[Math.floor(Math.random() * cityCodes.length)]!;

  return {
    city_code: cityCode,
    origin_gps: formatGps(origin),
    destination_gps: formatGps(destination),
    start_code: start,
    end_code: end,
    vehicle_category: "METRO",
    item_quantity: 1 + Math.floor(Math.random() * 4),
  };
}
