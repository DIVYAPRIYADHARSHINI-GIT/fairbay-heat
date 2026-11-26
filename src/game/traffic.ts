/**
 * Stage 2: traffic.
 *
 * Every traffic car follows the lane graph built by `RoadNetwork`:
 *  - Longitudinal control is the Intelligent Driver Model (IDM, Treiber
 *    2000) - the standard car-following model used in traffic research: it
 *    keeps a safe time gap to the car ahead, accelerates smoothly towards
 *    the free-flow speed, and brakes harder the closer it gets.
 *  - "Obstacles" fed to IDM: the car ahead on the same path (looked up over
 *    the next ~90 m of planned route), a red/yellow light at the stop line,
 *    a give-way line when a conflicting car is coming, the player's car in
 *    its path, and slowing for curves (v = sqrt(a_lat / curvature)).
 *  - Routing: at the end of each lane a random connector is chosen
 *    (weighted towards going straight); the route is planned a few segments
 *    ahead so cars know about junctions before reaching them.
 *  - Junction reservation: a car commits to a connector only when no car is
 *    already on a conflicting connector and (if it yields) no priority car
 *    is about to arrive. This is what stops cars driving through each other.
 *  - Collisions with the player (oriented boxes, see contact.ts): a light
 *    brush is a rub (the car keeps its lane), a firmer tap is a bump (the
 *    car is shoved along its lane and drives on), and only a real crash
 *    knocks it out of its lane ("wrecked") for a few seconds - and the
 *    driver honks. Momentum is shared by mass, so the player ploughs on.
 *  - Spawning/despawning in a ring around the player (60-300 m), never in
 *    view range right in front of the camera, keeps ~50 cars alive in a
 *    24 km road network at negligible cost.
 *
 * Pure logic (no Three.js) - unit tested headlessly.
 */

import { clamp, mulberry32 } from "../core/math";
import { signalState, type LaneSeg, type RoadNetwork, type RNode } from "./roads";
import type { CircleCollider } from "./collision";
import { CRASH_BOUNCE, CRASH_SPEED, PLAYER_MASS, RUB_SPEED, boxContact, footprint } from "./contact";

// ---- IDM parameters --------------------------------------------------------

export const IDM = {
  /** Max acceleration, m/s^2. */
  a: 1.6,
  /** Comfortable deceleration, m/s^2. */
  b: 2.6,
  /** Jam distance (bumper to bumper), m. */
  s0: 2.2,
  /** Desired time headway, s. */
  T: 1.3,
  delta: 4,
  /** Hard emergency braking limit, m/s^2. */
  bMax: 9,
};

/** IDM acceleration for speed v, desired v0, gap s and approach rate dv (= v - v_lead). */
export function idmAccel(v: number, v0: number, s: number, dv: number, p = IDM): number {
  const free = 1 - Math.pow(Math.max(0, v) / Math.max(0.1, v0), p.delta);
  if (!Number.isFinite(s)) return p.a * free;
  const sStar = p.s0 + Math.max(0, v * p.T + (v * dv) / (2 * Math.sqrt(p.a * p.b)));
  const gap = Math.max(0.1, s);
  return clamp(p.a * (free - (sStar / gap) ** 2), -p.bMax, p.a);
}

// ---- Traffic car models ------------------------------------------------------

/** Axle positions along a traffic model, measured from its centre (+ = front). */
export function axlesOf(m: { kind: string; length: number }): [number, number] {
  const h = m.length / 2;
  return m.kind === "bus" ? [h - 2.2, -h + 2.6] : [h - 0.85, -h + 0.85];
}

/** Axle-to-axle distance for a traffic model (m). */
export function wheelbaseOf(m: { kind: string; length: number }): number {
  const [f, r] = axlesOf(m);
  return f - r;
}

export type TrafficKind = "sedan" | "hatch" | "suv" | "taxi" | "van" | "pickup" | "bus" | "police";

export interface TrafficModel {
  kind: TrafficKind;
  length: number;
  width: number;
  height: number;
  colors: string[];
  weight: number;
  /** Mass relative to a mid-size sedan (sharing out collisions). */
  mass: number;
}

export const TRAFFIC_MODELS: TrafficModel[] = [
  { kind: "sedan", length: 4.7, width: 1.85, height: 1.45, colors: ["#c9ccd1", "#2b2f36", "#7a1f25", "#1f3a5f", "#e8e8e8", "#5b6168"], weight: 5, mass: 1 },
  { kind: "hatch", length: 4.1, width: 1.78, height: 1.48, colors: ["#d2483d", "#e0c341", "#3d7ab8", "#f2f2f2", "#3b4a3f", "#8c3b8f"], weight: 4, mass: 0.85 },
  { kind: "suv", length: 4.85, width: 1.95, height: 1.75, colors: ["#1e2226", "#9aa1a8", "#48525c", "#efefef", "#5a3b2a"], weight: 3, mass: 1.3 },
  { kind: "taxi", length: 4.75, width: 1.85, height: 1.5, colors: ["#f2c230"], weight: 1.4, mass: 1 },
  { kind: "van", length: 5.3, width: 2.0, height: 2.2, colors: ["#f4f4f4", "#d9d9d9", "#2f5d8a"], weight: 1.2, mass: 1.6 },
  { kind: "pickup", length: 5.4, width: 2.0, height: 1.85, colors: ["#8b1e1e", "#2e4a2e", "#c4c4c4", "#1c1c1c"], weight: 1.3, mass: 1.5 },
  { kind: "bus", length: 11.5, width: 2.55, height: 3.1, colors: ["#d8392b"], weight: 0.4, mass: 6 },
];

/**
 * A police patrol car. Patrols drive in traffic (lanes, signals, car
 * following) until they witness an offence; the police module then takes
 * the car over and chases you. Never picked at random (not in TRAFFIC_MODELS);
 * drawn by the police renderer, not the traffic one.
 */
export const POLICE_MODEL: TrafficModel = { kind: "police", length: 5.0, width: 1.92, height: 1.46, colors: ["#101318"], weight: 0, mass: 1.3 };

export interface TrafficCar {
  id: number;
  model: TrafficModel;
  color: string;
  seg: LaneSeg;
  s: number;
  v: number;
  /** Desired speed factor (some drivers are faster than others). */
  temper: number;
  /** Planned upcoming segments (route[0] follows seg). */
  route: LaneSeg[];
  /** World pose (updated every step). */
  x: number;
  y: number;
  z: number;
  heading: number;
  /** Brake light state. */
  braking: boolean;
  /** Indicator: -1 left, 1 right, 0 off. */
  blink: number;
  /** When wrecked, the car is off the lane graph and slides as a body. */
  wrecked: number;
  wx: number;
  wz: number;
  wvx: number;
  wvz: number;
  wyaw: number;
  /** Collider the player physics sees. */
  colliders: CircleCollider[];
  /** The segment the car was on before this one (for rear-axle tracking). */
  prevSeg: LaneSeg | null;
  /** Waiting time at a junction (s), to break deadlocks. */
  waited: number;
  /** Horn cool-down. */
  hornT: number;
  alive: boolean;
}

export interface PlayerState {
  x: number;
  z: number;
  vx: number;
  vz: number;
  heading: number;
  radius: number;
  length: number;
  /** Body width (m); defaults to about twice the radius. */
  width?: number;
  /**
   * Height of the car (m). Cars on different levels (one on a viaduct, one
   * on the street underneath) never touch, block or near-miss each other.
   */
  y?: number;
}

/** Two cars this far apart vertically are on different levels (deck vs street). */
export const LEVEL_GAP = 2.5;

export interface TrafficEvents {
  /**
   * Cars the player just crashed into: impact (closing) speed, contact point,
   * the normal from the traffic car to the player, the overlap to push out
   * by, and `share` - the part of the closing speed the player's car takes
   * (by mass: a sedan barely slows you, a bus stops you).
   */
  hits: { car: TrafficCar; impact: number; x: number; z: number; nx: number; nz: number; depth: number; share: number }[];
  /**
   * Firmer taps (RUB_SPEED..CRASH_SPEED): the traffic car is shoved along
   * its lane and drives on; the player loses only its mass share of the
   * closing speed. `vx/vz` is the traffic car's velocity after the shove.
   */
  bumps: { car: TrafficCar; impact: number; x: number; z: number; nx: number; nz: number; depth: number; vx: number; vz: number }[];
  /**
   * Cars the player is brushing past (closing slower than RUB_SPEED): the
   * normal points from the traffic car to the player, `depth` is the overlap
   * the caller must push the player out by.
   */
  rubs: { car: TrafficCar; nx: number; nz: number; depth: number; rel: number; x: number; z: number }[];
  horns: { car: TrafficCar; long: boolean }[];
}

const LOOKAHEAD = 95;
const SPAWN_MIN = 45;
const SPAWN_MAX = 320;
const DESPAWN = 380;

export class Traffic {
  readonly cars: TrafficCar[] = [];
  target = 48;
  time = 0;
  private nextId = 1;
  private rng: () => number;
  /** Cars currently on each segment, sorted by s. */
  private onSeg = new Map<number, TrafficCar[]>();
  /** Collider pool registered with the physics world. */
  private colliderPool: CircleCollider[] = [];
  private sibCache = new Map<number, LaneSeg[]>();
  enabled = true;
  /**
   * Other cars traffic must not drive into, like the player's: police units
   * and roadblocks (set every frame by the police module).
   */
  obstacles: PlayerState[] = [];

  constructor(
    readonly net: RoadNetwork,
    seed = 77,
    private ground: (x: number, z: number, y?: number) => number = () => 0,
  ) {
    this.rng = mulberry32(seed);
  }

  // ---------------------------------------------------------------------------
  // Spawning
  // ---------------------------------------------------------------------------

  private pickModel(): TrafficModel {
    const total = TRAFFIC_MODELS.reduce((a, m) => a + m.weight, 0);
    let r = this.rng() * total;
    for (const m of TRAFFIC_MODELS) {
      r -= m.weight;
      if (r <= 0) return m;
    }
    return TRAFFIC_MODELS[0];
  }

  /** Tries to place one car (a random model, or `model`) on a lane near the focus point. */
  spawnNear(fx: number, fz: number, fHeading: number | null, minR = SPAWN_MIN, maxR = SPAWN_MAX, model?: TrafficModel): TrafficCar | null {
    const lanes = this.net.lanes;
    for (let attempt = 0; attempt < 24; attempt++) {
      const seg = lanes[Math.floor(this.rng() * lanes.length)];
      if (seg.road?.cls === "ring" && this.rng() < 0.5) continue;
      if (seg.length < 40) continue;
      // Never spawn in the last 35 m before a junction (it could appear past
      // a stop line with no room to brake) or the first 6 m after one.
      const s = 6 + this.rng() * (seg.length - 41);
      const p = seg.poly.sample(s);
      const d = Math.hypot(p.x - fx, p.z - fz);
      if (d < minR || d > maxR) continue;
      // Not right in front of the player's camera.
      if (fHeading !== null && d < 110) {
        const ang = Math.atan2(p.x - fx, p.z - fz) - fHeading;
        if (Math.cos(ang) > 0.7) continue;
      }
      if (!this.gapFree(seg, s, 14)) continue;
      return this.add(seg, s, model ?? this.pickModel());
    }
    return null;
  }

  private gapFree(seg: LaneSeg, s: number, gap: number): boolean {
    for (const c of this.onSeg.get(seg.id) ?? []) if (Math.abs(c.s - s) < gap) return false;
    return true;
  }

  add(seg: LaneSeg, s: number, model = this.pickModel()): TrafficCar {
    const temper = 0.88 + this.rng() * 0.24;
    const car: TrafficCar = {
      id: this.nextId++,
      model,
      color: model.colors[Math.floor(this.rng() * model.colors.length)],
      seg,
      s,
      v: Math.min(seg.speed * temper, 8 + this.rng() * 6),
      temper,
      route: [],
      x: 0,
      y: 0,
      z: 0,
      heading: 0,
      braking: false,
      blink: 0,
      wrecked: 0,
      wx: 0,
      wz: 0,
      wvx: 0,
      wvz: 0,
      wyaw: 0,
      colliders: [],
      prevSeg: null,
      waited: 0,
      hornT: 0,
      alive: true,
    };
    this.planRoute(car);
    this.place(car);
    this.cars.push(car);
    this.index(car);
    return car;
  }

  private planRoute(car: TrafficCar): void {
    let last = car.route.length ? car.route[car.route.length - 1] : car.seg;
    let dist = car.route.reduce((a, r) => a + r.length, car.seg.length - car.s);
    while ((dist < LOOKAHEAD + 40 || car.route.length < 2) && car.route.length < 8) {
      const next = this.choose(last);
      if (!next) break;
      car.route.push(next);
      dist += next.length;
      last = next;
    }
  }

  private choose(seg: LaneSeg): LaneSeg | null {
    const opts = seg.next;
    if (opts.length === 0) return null;
    if (opts.length === 1) return opts[0];
    // Prefer going straight, avoid U-turns, and avoid the roundabout's
    // inner loop running forever.
    let total = 0;
    const w = opts.map((o) => {
      let k = o.turn === "straight" ? 3 : o.turn === "uturn" ? 0.05 : 1;
      if (o.to?.road?.cls === "ring") k *= 0.8;
      total += k;
      return k;
    });
    let r = this.rng() * total;
    for (let i = 0; i < opts.length; i++) {
      r -= w[i];
      if (r <= 0) return opts[i];
    }
    return opts[opts.length - 1];
  }

  private index(car: TrafficCar): void {
    let list = this.onSeg.get(car.seg.id);
    if (!list) this.onSeg.set(car.seg.id, (list = []));
    list.push(car);
  }

  private unindex(car: TrafficCar): void {
    const list = this.onSeg.get(car.seg.id);
    if (!list) return;
    const i = list.indexOf(car);
    if (i >= 0) list.splice(i, 1);
  }

  remove(car: TrafficCar): void {
    car.alive = false;
    this.unindex(car);
    const i = this.cars.indexOf(car);
    if (i >= 0) this.cars.splice(i, 1);
    for (const c of car.colliders) c.broken = true;
  }

  clear(): void {
    for (const c of [...this.cars]) this.remove(c);
  }

  /** Physics colliders for traffic, re-used every frame (3 circles per car). */
  colliders(max = 60): CircleCollider[] {
    while (this.colliderPool.length < max * 3) {
      this.colliderPool.push({ kind: "circle", id: 5_000_000 + this.colliderPool.length, x: 0, z: 0, r: 1, top: 2, base: 0, breakable: false, broken: true });
    }
    return this.colliderPool;
  }

  // ---------------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------------

  /** Distance and speed of the nearest car ahead along the planned path. */
  private leader(car: TrafficCar): { gap: number; v: number } {
    const half = car.model.length / 2;
    let best = Infinity;
    let bv = 0;
    // Same segment.
    for (const o of this.onSeg.get(car.seg.id) ?? []) {
      if (o === car || o.s <= car.s) continue;
      const g = o.s - car.s - half - o.model.length / 2;
      if (g < best) {
        best = g;
        bv = o.v;
      }
    }
    if (car.seg.kind === "conn") {
      for (const c of this.siblings(car.seg)) {
        for (const o of this.onSeg.get(c.id) ?? []) {
          const along = c.to === car.seg.to ? car.seg.length - (c.length - o.s) : (o.s / c.length) * car.seg.length;
          if (along <= car.s) continue;
          const g = along - car.s - half - o.model.length / 2;
          if (g < best) {
            best = Math.max(0.3, g);
            bv = o.v;
          }
        }
      }
    }
    if (best < Infinity) return { gap: best, v: bv };
    let dist = car.seg.length - car.s;
    for (const seg of car.route) {
      if (dist > LOOKAHEAD) break;
      let found = false;
      for (const o of this.onSeg.get(seg.id) ?? []) {
        const g = dist + o.s - half - o.model.length / 2;
        if (g < best) {
          best = g;
          bv = o.v;
          found = true;
        }
      }
      // Cars on another connector that shares this one's entry or exit lane
      // (parallel turn paths overlap at both ends).
      if (seg.kind === "conn") {
        for (const c of this.siblings(seg)) {
          for (const o of this.onSeg.get(c.id) ?? []) {
            // Progress fraction along the parallel path, mapped onto ours.
            const along = c.to === seg.to ? seg.length - (c.length - o.s) : (o.s / c.length) * seg.length;
            {
              const g = dist + along - half - o.model.length / 2;
              if (g > -2 && g < best) {
                best = Math.max(0.5, g);
                bv = o.v;
                found = true;
              }
            }
          }
        }
      }
      if (found) break;
      dist += seg.length;
    }
    return { gap: best, v: bv };
  }

  /** Connectors that share an entry or exit lane with `conn` (they overlap physically). */
  private siblings(conn: LaneSeg): LaneSeg[] {
    let list = this.sibCache.get(conn.id);
    if (list) return list;
    list = [];
    for (const c of conn.from!.next) if (c !== conn) list.push(c);
    for (const c of conn.conflicts) if (c.to === conn.to && !list.includes(c)) list.push(c);
    this.sibCache.set(conn.id, list);
    return list;
  }

  /** Is the junction ahead clear for `conn`? */
  private canEnter(conn: LaneSeg, eta: number): boolean {
    for (const c of conn.conflicts) {
      // Someone already on a crossing path.
      const occupants = this.onSeg.get(c.id);
      if (occupants && occupants.length) {
        for (const o of occupants) if (o.s < c.length - 2) return false;
      }
      if (!conn.yields || c.yields) continue;
      // A priority car arriving at that conflicting connector soon. Cars held
      // by a red light, or stopped and not about to move, do not count.
      if (signalState(c.node as RNode, c.group, this.time) === "red") continue;
      for (const o of this.onSeg.get(c.from!.id) ?? []) {
        if (o.wrecked > 0) continue;
        if (o.route[0] !== c) continue; // not actually taking that path
        const left = c.from!.length - o.s;
        if (o.v < 0.5 && left > 6) continue;
        const t = left / Math.max(0.5, o.v);
        if (t < eta + 2.8 && left < 70) return false;
      }
    }
    return true;
  }

  /**
   * Stop-line constraint for the next junction along the planned route, as
   * an IDM obstacle distance. Looks past short lanes, so a car leaving one
   * junction already sees the light at the next.
   */
  private junctionGap(car: TrafficCar): number {
    let dist = car.seg.length - car.s;
    let conn: LaneSeg | null = null;
    for (const seg of car.route) {
      if (seg.kind === "conn") {
        conn = seg;
        break;
      }
      dist += seg.length;
      if (dist > 80) return Infinity;
    }
    if (!conn || dist > 80) return Infinity;
    const node = conn.node as RNode;
    const light = signalState(node, conn.group, this.time);
    // A left-turner already waiting at the line clears on yellow once the
    // oncoming traffic has stopped ("sneaker" turns, as real drivers do).
    const sneaker = light === "yellow" && dist < 5 && (conn.turn === "left" || conn.turn === "uturn") && !this.someoneOn(conn.conflicts);
    if (light === "red") return dist - 1;
    if (light === "yellow" && !sneaker) {
      const stopDist = (car.v * car.v) / (2 * IDM.b);
      if (stopDist < dist - 1) return dist - 1;
    }
    if (sneaker) return Infinity;
    if (dist < 24) {
      // Don't block the box: only enter if there is room for this car on the
      // exit lane beyond the junction (otherwise a full exit makes cars stop
      // inside the junction and gridlock the cross traffic).
      if (!this.exitHasRoom(conn, car)) return dist - 1;
      const eta = dist / Math.max(2, car.v);
      // After a long wait, creep through cautiously (deadlock breaker).
      if (car.waited > 14 && !this.someoneOn(conn.conflicts)) return Infinity;
      if (!this.canEnter(conn, eta)) return dist - 1;
    }
    return Infinity;
  }

  /** True if the lane after `conn` has space for `car` (plus a gap) beyond the junction. */
  private exitHasRoom(conn: LaneSeg, car: TrafficCar): boolean {
    const exit = conn.to!;
    const need = car.model.length + IDM.s0 + 1.5;
    // Cars already on this connector or any connector into the same exit
    // also need their space.
    let queued = 0;
    for (const c of [conn, ...conn.conflicts.filter((x) => x.to === exit), ...this.siblings(conn).filter((x) => x.to === exit)]) {
      for (const o of this.onSeg.get(c.id) ?? []) if (o !== car) queued += o.model.length + IDM.s0;
    }
    let tail = Infinity;
    for (const o of this.onSeg.get(exit.id) ?? []) {
      if (o.v > 3) continue; // moving cars will make room
      tail = Math.min(tail, o.s - o.model.length / 2);
    }
    if (tail === Infinity) return queued + need <= Math.max(exit.length, need) + 2;
    // On a very short link (under a viaduct) never ask for more room than
    // the link physically has.
    return tail - queued >= Math.min(need, exit.length * 0.6);
  }

  private someoneOn(segs: LaneSeg[]): boolean {
    for (const c of segs) if ((this.onSeg.get(c.id)?.length ?? 0) > 0) return true;
    return false;
  }

  /** Gap to the player's car if it is in this car's path. */
  private playerGap(car: TrafficCar, p: PlayerState | null): { gap: number; v: number } {
    if (!p) return { gap: Infinity, v: 0 };
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    const dx = p.x - car.x;
    const dz = p.z - car.z;
    const ahead = dx * fx + dz * fz;
    const side = Math.abs(-dx * fz + dz * fx);
    if (ahead < 0 || ahead > 60 || side > (car.model.width + p.radius * 2) / 2 + 0.6) return { gap: Infinity, v: 0 };
    if (p.y !== undefined && Math.abs(p.y - car.y) > LEVEL_GAP) return { gap: Infinity, v: 0 };
    const pv = p.vx * fx + p.vz * fz;
    return { gap: ahead - car.model.length / 2 - p.length / 2, v: pv };
  }

  /** Lowest curve-safe speed over the next ~40 m. */
  private curveSpeed(car: TrafficCar): number {
    let v = Infinity;
    let dist = car.seg.length - car.s;
    if (car.seg.kind === "conn") v = Math.min(v, car.seg.speed);
    for (const seg of car.route) {
      if (dist > 45) break;
      if (seg.kind === "conn") {
        // Decelerate in time: v^2 = v_c^2 + 2 b d.
        v = Math.min(v, Math.sqrt(seg.speed * seg.speed + 2 * IDM.b * 0.8 * Math.max(0, dist)));
      }
      dist += seg.length;
    }
    return v;
  }

  step(dt: number, player: PlayerState | null, focusX: number, focusZ: number, focusHeading: number | null): TrafficEvents {
    const ev: TrafficEvents = { hits: [], bumps: [], rubs: [], horns: [] };
    this.time += dt;
    if (!this.enabled) return ev;

    for (const car of this.cars) {
      car.hornT = Math.max(0, car.hornT - dt);
      if (car.wrecked > 0) {
        this.stepWreck(car, dt);
        continue;
      }
      const v0 = Math.min(car.seg.speed * car.temper, this.curveSpeed(car));
      const lead = this.leader(car);
      let acc = idmAccel(car.v, v0, lead.gap, car.v - lead.v);
      const jg = this.junctionGap(car);
      if (jg < Infinity) {
        acc = Math.min(acc, idmAccel(car.v, v0, jg, car.v));
        // Within braking distance of a red stop line: brake as hard as needed
        // (up to an emergency stop) rather than roll over the line.
        const need = (car.v * car.v) / (2 * Math.max(0.5, jg));
        if (jg < 25 && need > IDM.b) acc = Math.min(acc, -Math.min(IDM.bMax, need * 1.1));
      }
      let pg = this.playerGap(car, player);
      for (const o of this.obstacles) {
        const og = this.playerGap(car, o);
        if (og.gap < pg.gap) pg = og;
      }
      if (pg.gap < Infinity) {
        acc = Math.min(acc, idmAccel(car.v, v0, pg.gap, car.v - pg.v));
        if (pg.gap < 9 && car.v < 3 && car.hornT === 0 && this.rng() < 0.02) {
          car.hornT = 6;
          ev.horns.push({ car, long: this.rng() < 0.3 });
        }
      }
      car.braking = acc < -0.6;
      car.waited = car.v < 0.5 ? car.waited + dt : 0;
      car.v = Math.max(0, car.v + acc * dt);
      let ds = car.v * dt;
      // Advance along segments.
      while (ds > 0) {
        const left = car.seg.length - car.s;
        if (ds < left) {
          car.s += ds;
          ds = 0;
        } else {
          ds -= left;
          const next = car.route.shift();
          if (!next) {
            car.s = car.seg.length;
            car.v = 0;
            ds = 0;
            break;
          }
          this.unindex(car);
          car.prevSeg = car.seg;
          car.seg = next;
          car.s = 0;
          this.index(car);
          this.planRoute(car);
        }
      }
      const nextConn = car.seg.kind === "conn" ? car.seg : car.route[0]?.kind === "conn" && car.seg.length - car.s < 40 ? car.route[0] : null;
      car.blink = nextConn ? (nextConn.turn === "left" || nextConn.turn === "uturn" ? -1 : nextConn.turn === "right" ? 1 : 0) : 0;
      this.place(car);
    }

    this.manage(focusX, focusZ, focusHeading);
    this.syncColliders();
    return ev;
  }

  /**
   * Positions the car like a real one: the REAR AXLE runs along the lane
   * path, and the body points at the path a wheelbase ahead (where the front
   * axle is). In a turn the body therefore swings around its rear wheels,
   * with the nose cutting inside - instead of pivoting about its middle.
   */
  private place(car: TrafficCar): void {
    if (car.wrecked > 0) return;
    const wb = wheelbaseOf(car.model);
    const rearOff = -axlesOf(car.model)[1]; // centre -> rear axle distance
    // car.s is the CENTRE's progress; the rear axle is `rearOff` behind it.
    const rear = this.pathPoint(car, car.s - rearOff);
    const front = this.pathPoint(car, car.s - rearOff + wb);
    const hx = front.x - rear.x;
    const hz = front.z - rear.z;
    const len = Math.hypot(hx, hz) || 1;
    car.heading = Math.atan2(hx, hz);
    car.x = rear.x + (hx / len) * rearOff;
    car.z = rear.z + (hz / len) * rearOff;
    const p = { x: car.x, z: car.z };
    // Height from the car's own road (so cars under a viaduct stay under it).
    const seg = car.seg;
    if (seg.road) car.y = seg.road.heightAt(seg.road.center.project(p.x, p.z).s);
    else {
      const a = car.seg.from!.road!;
      const b = car.seg.to!.road!;
      const f = car.s / Math.max(1e-3, car.seg.length);
      const ha = a.heightAt(car.seg.from!.dir > 0 ? a.s1 : a.s0);
      const hb = b.heightAt(car.seg.to!.dir > 0 ? b.s0 : b.s1);
      car.y = this.ground(p.x, p.z, ha + (hb - ha) * f);
    }
  }

  /**
   * A point on the car's path at arc length `s` relative to its current
   * segment: negative values reach back into the previous segment (kept in
   * `prevSeg`), values past the end reach into the planned route.
   */
  private pathPoint(car: TrafficCar, s: number): { x: number; z: number } {
    let seg = car.seg;
    if (s < 0 && car.prevSeg) {
      seg = car.prevSeg;
      s += seg.length;
      if (s < 0) s = 0;
      const p = seg.poly.sample(s);
      return { x: p.x, z: p.z };
    }
    if (s < 0) {
      // No history yet: extrapolate backwards along the start tangent.
      const p = seg.poly.sample(0);
      const t = seg.poly.tangent(0);
      return { x: p.x + t.tx * s, z: p.z + t.tz * s };
    }
    let i = 0;
    while (s > seg.length && i < car.route.length) {
      s -= seg.length;
      seg = car.route[i++];
    }
    if (s > seg.length) {
      const p = seg.poly.sample(seg.length);
      const t = seg.poly.tangent(seg.length);
      const over = s - seg.length;
      return { x: p.x + t.tx * over, z: p.z + t.tz * over };
    }
    const p = seg.poly.sample(s);
    return { x: p.x, z: p.z };
  }

  private stepWreck(car: TrafficCar, dt: number): void {
    car.wrecked -= dt;
    const k = Math.exp(-2.2 * dt);
    car.wvx *= k;
    car.wvz *= k;
    car.wyaw *= Math.exp(-2.5 * dt);
    car.x += car.wvx * dt;
    car.z += car.wvz * dt;
    car.heading += car.wyaw * dt;
    car.y = this.ground(car.x, car.z, car.y);
    car.v = 0;
    car.braking = true;
    if (car.wrecked <= 0) {
      // Recover: snap back to the nearest point of its lane if close, else despawn.
      const proj = car.seg.poly.project(car.x, car.z);
      if (proj.dist < 6) {
        car.s = proj.s;
        car.wrecked = 0;
        this.place(car);
      } else {
        this.remove(car);
      }
    }
  }

  /**
   * Player-vs-traffic collision. Called every physics sub-step (120 Hz) by
   * the game, so a fast car cannot pass through a traffic car between frames.
   */
  collide(p: PlayerState): TrafficEvents {
    const ev: TrafficEvents = { hits: [], bumps: [], rubs: [], horns: [] };
    if (this.enabled) this.collidePlayer(p, ev);
    return ev;
  }

  private collidePlayer(p: PlayerState, ev: TrafficEvents): void {
    for (const car of this.cars) {
      const dx = car.x - p.x;
      const dz = car.z - p.z;
      const reach = car.model.length / 2 + p.length / 2 + 0.5;
      if (dx * dx + dz * dz > reach * reach) continue;
      if (p.y !== undefined && Math.abs(p.y - car.y) > LEVEL_GAP) continue; // other level
      // Precise test: car circles vs player circles.
      const hit = this.circleHit(car, p);
      if (!hit) continue;
      const cvx = car.wrecked > 0 ? car.wvx : Math.sin(car.heading) * car.v;
      const cvz = car.wrecked > 0 ? car.wvz : Math.cos(car.heading) * car.v;
      // Closing speed along the contact normal (> 0 = moving into each other).
      const rel = (p.vx - cvx) * hit.nx + (p.vz - cvz) * hit.nz;
      const impact = Math.max(0, rel);
      if (car.wrecked <= 0 && impact < RUB_SPEED) {
        // A RUB: brushing past side by side. The traffic car stays in its
        // lane (its driver lifts off a little); the caller only separates
        // the player's car - no crash, no horn blast, no sparks.
        car.v *= 0.97;
        ev.rubs.push({ car, nx: -hit.nx, nz: -hit.nz, depth: hit.depth, rel: impact, x: hit.cx, z: hit.cz });
        continue;
      }
      if (impact < 1.2 && car.wrecked > 0) continue;
      // Momentum is shared by mass (the player's hero car is heavier than
      // most traffic): `mine` is the share of the closing speed the traffic
      // car takes, the rest is the player's.
      const mine = PLAYER_MASS / (PLAYER_MASS + car.model.mass);
      if (car.wrecked <= 0 && impact < CRASH_SPEED) {
        // A BUMP: shove the car along its lane (a nudge from behind speeds
        // it up, a tap on the nose slows it) - it keeps driving, no crash.
        const fx = Math.sin(car.heading);
        const fz = Math.cos(car.heading);
        const along = hit.nx * fx + hit.nz * fz;
        car.v = clamp(car.v + impact * mine * along, 0, Math.max(car.v, car.seg.speed * 1.6));
        ev.bumps.push({ car, impact, x: hit.cx, z: hit.cz, nx: -hit.nx, nz: -hit.nz, depth: hit.depth, vx: fx * car.v, vz: fz * car.v });
        if (car.hornT === 0) {
          car.hornT = 5;
          ev.horns.push({ car, long: false });
        }
        continue;
      }
      // A CRASH: the traffic car is knocked out of its lane.
      if (car.wrecked <= 0) {
        car.wrecked = 4.5;
        car.wvx = cvx;
        car.wvz = cvz;
        car.wyaw = 0;
      }
      const push = Math.max(impact, 2) * mine * (1 + CRASH_BOUNCE);
      car.wvx += hit.nx * push + p.vx * 0.1;
      car.wvz += hit.nz * push + p.vz * 0.1;
      car.wyaw += (this.rng() - 0.5) * impact * 0.35;
      ev.hits.push({ car, impact, x: hit.cx, z: hit.cz, nx: -hit.nx, nz: -hit.nz, depth: hit.depth, share: 1 - mine });
      if (car.hornT === 0) {
        car.hornT = 8;
        ev.horns.push({ car, long: true });
      }
    }
  }

  /**
   * Contact between a traffic car and the player (oriented-box footprints).
   * The normal points from the player to the traffic car.
   */
  private circleHit(car: TrafficCar, p: PlayerState): { nx: number; nz: number; cx: number; cz: number; depth: number } | null {
    const fp = footprint(p.length, p.width ?? p.radius * 2.08);
    const fc = footprint(car.model.length, car.model.width);
    const hit = boxContact(p.x, p.z, p.heading, fp.hl, fp.hw, car.x, car.z, car.heading, fc.hl, fc.hw);
    if (!hit) return null;
    return { nx: hit.nx, nz: hit.nz, cx: hit.x, cz: hit.z, depth: hit.depth };
  }

  /** Keeps the population near the focus point. */
  private manage(fx: number, fz: number, fh: number | null): void {
    for (const car of [...this.cars]) {
      const d = Math.hypot(car.x - fx, car.z - fz);
      if (d > DESPAWN) this.remove(car);
      else if (car.seg.next.length === 0 && car.s >= car.seg.length - 0.5) this.remove(car);
    }
    let tries = 0;
    while (this.cars.length < this.target && tries < 4) {
      this.spawnNear(fx, fz, fh);
      tries++;
    }
  }

  private syncColliders(): void {
    const pool = this.colliders();
    let k = 0;
    for (const car of this.cars) {
      if (k + 3 > pool.length) break;
      const fx = Math.sin(car.heading);
      const fz = Math.cos(car.heading);
      const r = car.model.width / 2;
      const off = Math.max(0, car.model.length / 2 - r);
      car.colliders = [];
      for (const a of [-off, 0, off]) {
        const c = pool[k++];
        c.x = car.x + fx * a;
        c.z = car.z + fz * a;
        c.r = r;
        c.top = car.model.height;
        c.base = car.y;
        // Traffic is handled by `collidePlayer`; static physics ignores it.
        c.broken = true;
        car.colliders.push(c);
      }
    }
    for (; k < pool.length; k++) pool[k].broken = true;
  }

  /** Test helper: all cars as plain data. */
  snapshot() {
    return this.cars.map((c) => ({ id: c.id, kind: c.model.kind, x: c.x, z: c.z, v: c.v, seg: c.seg.id, segKind: c.seg.kind, wrecked: c.wrecked > 0, braking: c.braking }));
  }
}
