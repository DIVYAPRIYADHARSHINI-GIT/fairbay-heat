/**
 * Car-to-car contact, shared by the player, police units and race rivals.
 *
 * Cars are oriented boxes (their footprints). Every touch is classified by
 * its CLOSING SPEED along the contact normal:
 *
 *  - below RUB_SPEED it is a RUB: the cars are separated and the part of
 *    their velocity that drives them into each other is removed - nothing
 *    else. They slide past each other side by side (no bounce, no speed
 *    loss, no crash effects). Brushing a car while weaving through traffic
 *    is a rub.
 *  - at or above RUB_SPEED it is a CRASH: the cars bounce apart a little,
 *    spin, and the game plays sparks, sound and camera shake; traffic cars
 *    are knocked out of their lane.
 *
 * Cars touching side by side meet along their side faces, so only the
 * SIDEWAYS speed counts: brushing a car while weaving through traffic
 * closes at 1-4 m/s (a rub) even when overtaking it 100 km/h faster, while
 * rear-ending a car 20 km/h slower closes at 5.6 m/s (a crash).
 */

import { clamp } from "../core/math";
import type { CarPhysics } from "./physics";

/** Closing speed (m/s, ~18 km/h) below which a touch is a rub, not a crash. */
export const RUB_SPEED = 5;

export interface CarHit {
  /** Unit normal pointing from car a to car b. */
  nx: number;
  nz: number;
  /** Overlap depth (m). */
  depth: number;
  /** Contact point. */
  x: number;
  z: number;
}

/**
 * Contact between two oriented boxes (2D separating-axis test). A box is a
 * car's footprint: centre, heading, half length / half width. Returns the
 * minimum-overlap axis as the normal (from A to B), the overlap depth and a
 * contact point on the penetrating corner. Side-by-side cars therefore touch
 * along their SIDE faces, so overtaking speed never counts as "closing".
 */
export function boxContact(
  ax: number, az: number, ah: number, ahl: number, ahw: number,
  bx: number, bz: number, bh: number, bhl: number, bhw: number,
): CarHit | null {
  const afx = Math.sin(ah);
  const afz = Math.cos(ah);
  const bfx = Math.sin(bh);
  const bfz = Math.cos(bh);
  // Axes: A forward, A right, B forward, B right.
  const axes: [number, number, number][] = [
    [afx, afz, 0],
    [-afz, afx, 0],
    [bfx, bfz, 1],
    [-bfz, bfx, 1],
  ];
  const dx = bx - ax;
  const dz = bz - az;
  let best = Infinity;
  let nx = 0;
  let nz = 0;
  let fromA = true;
  for (const [x, z, owner] of axes) {
    const ra = ahl * Math.abs(afx * x + afz * z) + ahw * Math.abs(-afz * x + afx * z);
    const rb = bhl * Math.abs(bfx * x + bfz * z) + bhw * Math.abs(-bfz * x + bfx * z);
    const d = dx * x + dz * z;
    const overlap = ra + rb - Math.abs(d);
    if (overlap <= 0) return null;
    if (overlap < best - 1e-9) {
      best = overlap;
      const sgn = d >= 0 ? 1 : -1;
      nx = x * sgn;
      nz = z * sgn;
      fromA = owner === 0;
    }
  }
  // Contact point: the corner of the other box that reaches deepest along the normal.
  const corners = (cx: number, cz: number, fx: number, fz: number, hl: number, hw: number) => {
    const rx = -fz;
    const rz = fx;
    return [
      [cx + fx * hl + rx * hw, cz + fz * hl + rz * hw],
      [cx + fx * hl - rx * hw, cz + fz * hl - rz * hw],
      [cx - fx * hl + rx * hw, cz - fz * hl + rz * hw],
      [cx - fx * hl - rx * hw, cz - fz * hl - rz * hw],
    ];
  };
  let px = 0;
  let pz = 0;
  if (fromA) {
    // B's corner most against the normal (deepest into A).
    let m = Infinity;
    for (const [x, z] of corners(bx, bz, bfx, bfz, bhl, bhw)) {
      const k = x * nx + z * nz;
      if (k < m) {
        m = k;
        px = x;
        pz = z;
      }
    }
  } else {
    let m = -Infinity;
    for (const [x, z] of corners(ax, az, afx, afz, ahl, ahw)) {
      const k = x * nx + z * nz;
      if (k > m) {
        m = k;
        px = x;
        pz = z;
      }
    }
  }
  return { nx, nz, depth: best, x: px, z: pz };
}

/** Footprint half-extents used for car-to-car contact. */
export function footprint(length: number, width: number): { hl: number; hw: number } {
  return { hl: length / 2 - 0.05, hw: width / 2 - 0.04 };
}

/** Contact between two physics cars (oriented-box footprints). Normal points from a to b. */
export function carContact(a: CarPhysics, b: CarPhysics): CarHit | null {
  const dx0 = b.x - a.x;
  const dz0 = b.z - a.z;
  const reach = (a.def.body.length + b.def.body.length) / 2 + 0.5;
  if (dx0 * dx0 + dz0 * dz0 > reach * reach || Math.abs(a.y - b.y) > 2.5) return null;
  const fa = footprint(a.def.body.length, a.def.body.width);
  const fb = footprint(b.def.body.length, b.def.body.width);
  return boxContact(a.x, a.z, a.heading, fa.hl, fa.hw, b.x, b.z, b.heading, fb.hl, fb.hw);
}

export interface CarContactResult {
  hit: CarHit;
  /** Closing speed along the normal before the contact was resolved (m/s, > 0 = closing). */
  rel: number;
  crash: boolean;
}

/**
 * Resolves a contact between two physics cars. `wa` / `wb` are the share of
 * the push each car takes (0 = immovable, e.g. a parked roadblock car;
 * equal cars 0.5 / 0.5).
 */
export function resolveCars(a: CarPhysics, b: CarPhysics, wa = 0.5, wb = 0.5): CarContactResult | null {
  const hit = carContact(a, b);
  if (!hit) return null;
  const sum = wa + wb;
  if (sum <= 0) return null;
  const sa = wa / sum;
  const sb = wb / sum;
  a.x -= hit.nx * hit.depth * sa;
  a.z -= hit.nz * hit.depth * sa;
  b.x += hit.nx * hit.depth * sb;
  b.z += hit.nz * hit.depth * sb;
  const rel = (a.vx - b.vx) * hit.nx + (a.vz - b.vz) * hit.nz;
  const crash = rel >= RUB_SPEED;
  if (rel > 0) {
    // Rubs are perfectly inelastic along the normal (no bounce); crashes bounce a little.
    const j = (crash ? 1.25 : 1) * rel;
    a.vx -= hit.nx * j * sa;
    a.vz -= hit.nz * j * sa;
    b.vx += hit.nx * j * sb;
    b.vz += hit.nz * j * sb;
    // An off-centre push turns the car (yaw torque = lever x impulse). A
    // light brush barely turns it; a sustained shove into the rear quarter
    // (a PIT) spins it.
    const tx = -hit.nz;
    const tz = hit.nx;
    const la = (hit.x - a.x) * tx + (hit.z - a.z) * tz;
    const lb = (hit.x - b.x) * tx + (hit.z - b.z) * tz;
    a.yawRate -= clamp(la * j * sa * 0.2, -2, 2);
    b.yawRate += clamp(lb * j * sb * 0.2, -3, 3);
  }
  return { hit, rel: Math.max(0, rel), crash };
}
