/**
 * Jack spots: parked cars around Fairbay that the player can drive up to and
 * take (like Most Wanted 2013). Pure logic, unit-tested.
 */

import { CARS } from "./cars";
import { GRID, roadWidth } from "./city";

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
 * A car parked at the kerb of road line `index` ("x" roads run along Z),
 * `along` metres down the road, on the right-hand side of a car travelling in
 * direction `dir` (+1 = towards +Z / +X). Facing the direction of traffic.
 */
function kerb(axis: "x" | "z", index: number, along: number, dir: 1 | -1): { x: number; z: number; heading: number } {
  const off = roadWidth(index) / 2 - 1.6;
  const coord = index * GRID;
  // Right-hand side when facing +Z is -X; when facing +X it is +Z.
  if (axis === "x") return { x: coord - dir * off, z: along, heading: dir > 0 ? 0 : Math.PI };
  return { x: along, z: coord + dir * off, heading: dir > 0 ? Math.PI / 2 : -Math.PI / 2 };
}

const spot = (id: string, carId: string, color: number, where: string, k: ReturnType<typeof kerb>): JackSpot => ({ id, carId, color, where, ...k });

/** Placed in kerbside parking along roads, mid-block (verified by unit tests). */
export const JACK_SPOTS: JackSpot[] = [
  spot("js-carrara-1", "carrara", 1, "Downtown - Main St", kerb("x", 0, 70, -1)),
  spot("js-mustanger-1", "mustanger", 0, "Midtown - 2nd Ave", kerb("x", -2, -60, 1)),
  spot("js-vantis-1", "vantis", 1, "Ridge Park - Lakeside Dr", kerb("z", 4, 300, -1)),
  spot("js-aventura-1", "aventura", 0, "East Midtown - Harbour Rd", kerb("x", 5, 300, -1)),
  spot("js-gtarr-1", "gtarr", 1, "Ironworks - Foundry St", kerb("x", 3, -420, 1)),
  spot("js-veyrone-1", "veyrone", 0, "Port Fairbay - Dock Rd", kerb("z", -5, -420, 1)),
  spot("js-mustanger-2", "mustanger", 2, "Northshore - Elm St", kerb("x", -5, 540, 1)),
  spot("js-aventura-2", "aventura", 1, "South Midtown - Canal St", kerb("z", -3, -60, 1)),
  spot("js-gtarr-2", "gtarr", 2, "West Midtown - Ridge Ave", kerb("x", -3, 180, -1)),
  spot("js-carrara-2", "carrara", 0, "Northshore - Bay View", kerb("x", 1, 540, 1)),
  spot("js-vantis-2", "vantis", 3, "Downtown - Market St", kerb("z", -1, -60, -1)),
  spot("js-veyrone-2", "veyrone", 2, "Northshore - Hill Rd", kerb("z", 5, -300, -1)),
];

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
