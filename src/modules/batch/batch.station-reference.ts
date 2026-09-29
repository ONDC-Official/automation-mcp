/**
 * A small curated table of Metro station codes + GPS coordinates, used only to
 * generate realistic, *dynamic* `start_code`/`end_code` inputs for the
 * `batch` module's TRV11 Metro journeys.
 *
 * **Not sourced from the network.** `config/attributes/Metro.yaml` on
 * `automation-specifications` (branch `draft-TRV11-2.0.0`) declares the
 * *schema* for `fulfillment.stops[].location.gps` and station descriptor
 * codes, but publishes no actual station list — there is no live source to
 * pull real station data from. This table is hand-curated placeholder data,
 * loosely modelled on a real Indian metro network's naming/coordinate scale,
 * good enough to exercise the flow's `start_code`/`end_code` inputs and
 * produce visibly distinct, geographically plausible orders. It is not a
 * claim about any real network's actual stations.
 */

export interface StationRef {
  readonly code: string;
  readonly name: string;
  /** [latitude, longitude] */
  readonly gps: readonly [number, number];
}

export const STATION_REFERENCE: readonly StationRef[] = [
  { code: "MG_ROAD", name: "MG Road", gps: [12.9756, 77.6068] },
  { code: "INDIRANAGAR", name: "Indiranagar", gps: [12.9784, 77.6408] },
  {
    code: "BAIYYAPPANAHALLI",
    name: "Baiyyappanahalli",
    gps: [12.9906, 77.6553],
  },
  { code: "CUBBON_PARK", name: "Cubbon Park", gps: [12.9762, 77.5993] },
  { code: "VIDHANA_SOUDHA", name: "Vidhana Soudha", gps: [12.9794, 77.5913] },
  { code: "MAJESTIC", name: "Majestic", gps: [12.9767, 77.5713] },
  { code: "CHICKPET", name: "Chickpet", gps: [12.9679, 77.575] },
  { code: "KR_MARKET", name: "K R Market", gps: [12.9634, 77.5763] },
  { code: "NATIONAL_COLLEGE", name: "National College", gps: [12.95, 77.5741] },
  { code: "LALBAGH", name: "Lalbagh", gps: [12.9498, 77.5847] },
  {
    code: "SOUTH_END_CIRCLE",
    name: "South End Circle",
    gps: [12.9385, 77.5825],
  },
  { code: "JAYANAGAR", name: "Jayanagar", gps: [12.9308, 77.5838] },
  { code: "RAJAJINAGAR", name: "Rajajinagar", gps: [12.9911, 77.5554] },
  { code: "MAHALAKSHMI", name: "Mahalakshmi", gps: [13.0091, 77.5432] },
  { code: "YESHWANTHPUR", name: "Yeshwanthpur", gps: [13.0284, 77.554] },
  {
    code: "SANDAL_SOAP_FACTORY",
    name: "Sandal Soap Factory",
    gps: [13.0176, 77.551],
  },
] as const;

/** Great-circle distance in km — Haversine, precise enough for "nearest". */
export function distanceKm(
  [lat1, lon1]: readonly [number, number],
  [lat2, lon2]: readonly [number, number],
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * The station nearest a GPS point — "kind of a nearest gps call", per the
 * feature request. Ties broken by table order, which is stable and harmless:
 * a genuine tie means the two stations are equidistant, so either answer is
 * equally correct.
 */
export function nearestStation(gps: readonly [number, number]): StationRef {
  const [first, ...rest] = STATION_REFERENCE;
  if (!first) {
    throw new Error("STATION_REFERENCE must not be empty");
  }
  let best = first;
  let bestDist = distanceKm(gps, best.gps);
  for (const station of rest) {
    const dist = distanceKm(gps, station.gps);
    if (dist < bestDist) {
      best = station;
      bestDist = dist;
    }
  }
  return best;
}
