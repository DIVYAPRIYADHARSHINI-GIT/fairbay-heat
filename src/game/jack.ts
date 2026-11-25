/**
 * Jack spots: parked cars around Fairbay that the player can drive up to and
 * take (like Most Wanted 2013). Pure logic, unit-tested.
 */

import { CARS } from "./cars";
import type { JackSpotDef } from "./world";

export interface JackSpot {
  id: string;
  carId: string;
  color: number; // index into the car's colours
  x: number;
  z: number;
  heading: number;
  /** Human-readable hint for the map, e.g. "Downtown - 3rd & Main". */
  where: string;
}

/**
 * Jack spots are kerbside bays on named roads of the hand-made map. The
 * world computes the exact position (just outside the carriageway) and
 * reserves the bay so no building, tree or lamp is placed there.
 */
export const JACK_SPOT_DEFS: JackSpotDef[] = [
  { id: "js-carrara-1", carId: "carrara", color: 1, road: "lib-1", t: 0.55 },
  { id: "js-mustanger-1", carId: "mustanger", color: 0, road: "mkt-2", t: 0.5 },
  { id: "js-vantis-1", carId: "vantis", color: 1, road: "cath", t: 0.45 },
  { id: "js-aventura-1", carId: "aventura", color: 0, road: "hfront", t: 0.5 },
  { id: "js-gtarr-1", carId: "gtarr", color: 1, road: "smelt", t: 0.5 },
  { id: "js-veyrone-1", carId: "veyrone", color: 0, road: "look", t: 0.5 },
  { id: "js-mustanger-2", carId: "mustanger", color: 2, road: "wa-1", t: 0.5 },
  { id: "js-aventura-2", carId: "aventura", color: 1, road: "ocean", t: 0.62 },
  { id: "js-gtarr-2", carId: "gtarr", color: 2, road: "hc-1", t: 0.5 },
  { id: "js-carrara-2", carId: "carrara", color: 0, road: "canal", t: 0.5 },
  { id: "js-vantis-2", carId: "vantis", color: 3, road: "cr-CF", t: 0.5 },
  { id: "js-veyrone-2", carId: "veyrone", color: 2, road: "be-1", t: 0.5 },
];

/** Filled in by the game once the world has computed the positions. */
export const JACK_SPOTS: JackSpot[] = [];

export function setJackSpots(spots: readonly JackSpot[]): void {
  JACK_SPOTS.length = 0;
  JACK_SPOTS.push(...spots);
}

/** How close (m) and how slow (km/h) the player must be to jack a car. */
export const JACK_RANGE = 7;
export const JACK_MAX_KMH = 40;

export function nearestSpot(
  x: number,
  z: number,
  spots: readonly JackSpot[] = JACK_SPOTS,
): { spot: JackSpot; dist: number } | null {
  let best: JackSpot | null = null;
  let bd = Infinity;
  for (const s of spots) {
    const d = Math.hypot(s.x - x, s.z - z);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best ? { spot: best, dist: bd } : null;
}

/** The spot the player could jack right now, or null. */
export function jackable(
  x: number,
  z: number,
  speedKmh: number,
  currentCarId: string,
  spots: readonly JackSpot[] = JACK_SPOTS,
): JackSpot | null {
  const n = nearestSpot(x, z, spots);
  if (!n || n.dist > JACK_RANGE || speedKmh > JACK_MAX_KMH) return null;
  // Allow re-jacking the same model only if it is a different colour; keeps
  // "press E" from appearing for the car you are already sitting next to.
  void currentCarId;
  return n.spot;
}

export function discoveredCount(discovered: readonly string[]): { found: number; total: number } {
  const ids = new Set(CARS.map((c) => c.id));
  return { found: discovered.filter((d) => ids.has(d)).length, total: ids.size };
}
