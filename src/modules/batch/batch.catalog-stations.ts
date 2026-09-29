import { distanceKm } from "@/modules/batch/batch.station-reference.js";

/**
 * Stations as the counterparty's *own* catalog lists them, read back from the
 * business data its `on_search1` response saved — as opposed to
 * `STATION_REFERENCE`, a table this repo made up. A seller only accepts
 * `start_code`/`end_code` values that exist in its route: the live TRV11
 * Metro mock rejects anything else ("Start or End station not found in the
 * route"), so an order can only be placed against stations the seller offered.
 */

export interface CatalogStation {
  code: string;
  gps?: [number, number];
}

function parseGps(value: unknown): [number, number] | undefined {
  if (typeof value !== "string") return undefined;
  const [lat, lon] = value.split(",").map((part) => Number(part.trim()));
  return lat !== undefined &&
    lon !== undefined &&
    Number.isFinite(lat) &&
    Number.isFinite(lon)
    ? [lat, lon]
    : undefined;
}

/**
 * Every distinct station code in `fulfillments[*].stops[*].location`, with
 * GPS where the catalog gives one. Tolerant of shape: anything that is not
 * the expected nesting is skipped rather than thrown on, since this reads a
 * counterparty's payload.
 *
 * A catalog listing is not proof the seller will route between two stations:
 * verified live, the TRV11 `2.0.1` mock lists 37+ stations in `on_search1`
 * but its `on_search2` only routes `MOCK_STATION_1`–`22`. `restrictTo`
 * narrows to the codes known to be serviceable.
 */
export function stationsFromCatalog(
  fulfillments: unknown,
  restrictTo?: readonly string[],
): CatalogStation[] {
  const seen = new Map<string, CatalogStation>();
  const list = Array.isArray(fulfillments) ? fulfillments : [];
  for (const fulfillment of list) {
    const stops = (fulfillment as { stops?: unknown } | null)?.stops;
    if (!Array.isArray(stops)) continue;
    for (const stop of stops) {
      const location = (stop as { location?: Record<string, unknown> } | null)
        ?.location;
      const descriptor = location?.["descriptor"] as
        { code?: unknown } | undefined;
      const code = descriptor?.code;
      if (typeof code !== "string" || code === "" || seen.has(code)) continue;
      if (restrictTo !== undefined && !restrictTo.includes(code)) continue;
      const gps = parseGps(location?.["gps"]);
      seen.set(code, { code, ...(gps !== undefined ? { gps } : {}) });
    }
  }
  return [...seen.values()];
}

function nearest(
  stations: CatalogStation[],
  gps: readonly [number, number],
  exclude?: string,
): CatalogStation | undefined {
  let best: CatalogStation | undefined;
  let bestDist = Infinity;
  for (const station of stations) {
    if (station.gps === undefined || station.code === exclude) continue;
    const dist = distanceKm(gps, station.gps);
    if (dist < bestDist) {
      best = station;
      bestDist = dist;
    }
  }
  return best;
}

/** Beyond this, a generated GPS point is not near the seller's network at all. */
const MAX_NEAREST_KM = 25;

function around(gps: readonly [number, number], random: () => number): string {
  const jitter = () => (random() - 0.5) * 0.004;
  return `${(gps[0] + jitter()).toFixed(6)},${(gps[1] + jitter()).toFixed(6)}`;
}

export interface StationPick {
  start: CatalogStation;
  end: CatalogStation;
  /** Set when the order's GPS had to be re-centred on the chosen stations. */
  originGps?: string;
  destinationGps?: string;
}

/**
 * A distinct start/end pair from the seller's stations.
 *
 * When the catalog carries GPS and the order's generated points fall near the
 * network, the stations nearest to them are used — the "nearest GPS" call.
 * When they do not (a mock seller's stations are not in the city the points
 * were generated in, and "nearest" would then be the same two stations for
 * every order), a random distinct pair is chosen instead and the order's GPS
 * is re-centred on those stations, so GPS and stations still agree and orders
 * still differ. Without GPS, a random distinct pair. Undefined when there are
 * fewer than two stations: the seller offers no journey at all.
 */
export function pickStations(
  stations: CatalogStation[],
  origin: readonly [number, number],
  destination: readonly [number, number],
  random: () => number = Math.random,
): StationPick | undefined {
  if (stations.length < 2) return undefined;

  const withGps = stations.filter((s) => s.gps !== undefined);
  if (withGps.length >= 2) {
    const start = nearest(withGps, origin);
    const end = start ? nearest(withGps, destination, start.code) : undefined;
    if (
      start?.gps !== undefined &&
      end &&
      distanceKm(origin, start.gps) <= MAX_NEAREST_KM
    ) {
      return { start, end };
    }
  }

  const startIndex = Math.floor(random() * stations.length);
  let endIndex = Math.floor(random() * (stations.length - 1));
  if (endIndex >= startIndex) endIndex += 1;
  const start = stations[startIndex];
  const end = stations[endIndex];
  if (!start || !end) return undefined;
  return {
    start,
    end,
    ...(start.gps !== undefined
      ? { originGps: around(start.gps, random) }
      : {}),
    ...(end.gps !== undefined
      ? { destinationGps: around(end.gps, random) }
      : {}),
  };
}
