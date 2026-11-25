/**
 * Stage 3: the Fairbay Police Department.
 *
 * Two kinds of police car exist:
 *
 *  - PATROLS are ordinary traffic cars (model "police") driving the lane
 *    graph: they stop at lights, follow cars, indicate. Each one watches for
 *    offences in a 140 m, 150-degree cone (buildings block its view).
 *  - UNITS are full physics cars (the same arcade `CarPhysics` as the
 *    player) with an AI driver. A patrol that witnesses an offence becomes a
 *    unit on the spot; more units join from out of sight as the heat rises.
 *
 * A unit's driver:
 *  - with the player in sight and close, drives at where the player WILL be
 *    (lead pursuit) and, once alongside, swerves into the rear quarter (PIT);
 *  - otherwise follows the ROAD GRAPH (A* over junctions) to the player's
 *    last known position, so it corners like a car instead of cutting
 *    through buildings, then searches nearby junctions;
 *  - backs out when stuck against a wall, and is taken out ("wrecked") by
 *    hard hits.
 *
 * Roadblocks (heat 3+) are parked units across a road ahead of the player,
 * out of sight, with a gap at one kerb you can thread if you are brave.
 *
 * Everything here is pure simulation (no rendering) and runs headless in
 * the unit tests.
 */

import { CarPhysics, KMH, type Controls, type World } from "./physics";
import type { CarDef } from "./cars";
import { clamp, mulberry32, wrapAngle } from "../core/math";
import { segmentsIntersect } from "../core/geom";
import type { RNode, Road, RoadNetwork } from "./roads";
import type { Collider, SpatialHash } from "./collision";
import { POLICE_MODEL, type PlayerState, type Traffic, type TrafficCar } from "./traffic";
import { enforcerShare, roadblocksAt, unitsForHeat, type HeatState } from "./heat";

// ---- the two police cars ----------------------------------------------------

/** Fairbay PD Interceptor: a big, heavy pursuit sedan (Crown Vic / Charger style). */
export const INTERCEPTOR: CarDef = {
  id: "interceptor",
  name: "Fairbay PD Interceptor",
  inspiredBy: "classic police pursuit sedan",
  klass: "Muscle",
  colors: ["#0d0f13"],
  body: {
    length: 5.0, width: 1.92, height: 1.46, clearance: 0.15, wheelRadius: 0.36,
    frontAxle: 0.3, rearAxle: -0.29,
    noseHeight: 0.78, cowlHeight: 0.98, tailHeight: 1.0,
    cabinRear: -0.3, roofRear: -0.12, roofFront: 0.06, cabinFront: 0.18,
    tumblehome: 0.78, fenderFlare: 0.02, plan: 0.25, spoiler: "none",
    details: { headlight: "swept", taillight: "strip", grille: "bar", rim: "star7", rimColor: "#2a2c30", caliper: "#3a3d42", aero: 0.15 },
  },
  handling: {
    zeroTo100: 5.4, topSpeed: 245, brake: 13, grip: 9.5, driftGrip: 2.6, cornering: 21,
    response: 8, drive: "RWD", steering: { lock: 0.6, rate: 7, centre: 10, speedFalloff: 24, rear: 0.3 },
    engine: { cylinders: 8, idle: 700, redline: 6200, banks: [[0, 2, 3, 5], [1, 4, 6, 7]], pipes: [0.9, 2.4], muffler: 1300, turbos: 0, crackle: 0.1, intake: 0.3, rough: 0.2, headerMismatch: 0.2 },
  },
};

/** Fairbay PD Enforcer: the high-heat pursuit car, built on the Mustanger. */
export const ENFORCER: CarDef = {
  id: "enforcer",
  name: "Fairbay PD Enforcer",
  inspiredBy: "police-spec muscle car",
  klass: "Muscle",
  colors: ["#0d0f13"],
  body: {
    length: 4.78, width: 1.88, height: 1.4, clearance: 0.15, wheelRadius: 0.36,
    frontAxle: 0.29, rearAxle: -0.3,
    noseHeight: 0.8, cowlHeight: 0.98, tailHeight: 0.98,
    cabinRear: -0.32, roofRear: -0.12, roofFront: 0.04, cabinFront: 0.14,
    tumblehome: 0.76, fenderFlare: 0.02, plan: 0.2, spoiler: "lip", hoodScoop: true,
    details: { headlight: "round", taillight: "tribar", grille: "mesh", rim: "star7", rimColor: "#1c1d20", caliper: "#3a3d42", aero: 0.3 },
  },
  handling: {
    zeroTo100: 4.0, topSpeed: 290, brake: 14, grip: 10, driftGrip: 2.6, cornering: 22,
    response: 8.5, drive: "RWD", steering: { lock: 0.58, rate: 7.5, centre: 10, speedFalloff: 25, rear: 0.3 },
    engine: { cylinders: 8, idle: 750, redline: 6800, banks: [[0, 2, 3, 5], [1, 4, 6, 7]], pipes: [0.8, 2.6], muffler: 1700, turbos: 0, crackle: 0.2, intake: 0.4, rough: 0.25, headerMismatch: 0.3 },
  },
};

export const POLICE_CARS: CarDef[] = [INTERCEPTOR, ENFORCER];

/**
 * Controls that keep a car where it is. ("Brake" at a standstill means
 * reverse in the car physics, so a parked car uses the handbrake instead.)
 */
export function holdControls(c: CarPhysics): Controls {
  const v = c.vLong;
  if (v > 0.5) return { throttle: 0, brake: 1, steer: 0, handbrake: false, nitro: false };
  if (v < -0.5) return { throttle: 1, brake: 0, steer: 0, handbrake: false, nitro: false };
  return { throttle: 0, brake: 0, steer: 0, handbrake: true, nitro: false };
}

/** Highest speed (m/s) from which a car can still stop within `dist` metres, braking at `decel`. */
export function stoppingSpeed(dist: number, decel = 8): number {
  return Math.sqrt(2 * decel * Math.max(0, dist));
}

// ---- types -----------------------------------------------------------------------

export type UnitMode = "pursue" | "search" | "roadblock" | "wrecked";

export interface Unit {
  id: number;
  phys: CarPhysics;
  mode: UnitMode;
  /** Seconds until the road route is re-planned. */
  repath: number;
  /** Seconds trying to drive but barely moving. */
  stuck: number;
  /** Seconds left of backing out of a jam. */
  reversing: number;
  /** Seconds since this unit last saw the player. */
  lostFor: number;
  sees: boolean;
  siren: boolean;
  /** Damage 0..1; a unit rammed hard enough is taken out. */
  damage: number;
  /** Seconds since the last hit on the player (a unit does not "ram" every frame). */
  hitCool: number;
  /** Which side of the player this unit tries to get alongside (-1 / 1). */
  side: number;
  /** Seconds left before a wrecked unit is cleared away. */
  clearT: number;
  /** Driver controls this step (for the renderer: brake lights, steering). */
  ctl: Controls;
  /** Where a searching unit is heading. */
  searchGoal: { x: number; z: number } | null;
  /** Road route being followed (points in the right-hand lane) and progress along it. */
  route: { x: number; z: number }[];
  cursor: number;
  /** Where the current route leads. */
  routeGoal: { x: number; z: number } | null;
  /** Seconds spent off the road network (a lost unit is recycled out of sight). */
  offRoad: number;
}

export interface Roadblock {
  id: number;
  x: number;
  z: number;
  /** Road direction at the block. */
  heading: number;
  road: Road;
  units: Unit[];
  /** True once the player has driven past it. */
  passed: boolean;
  age: number;
}

export interface PlayerView {
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  heading: number;
  speed: number;
  car: CarPhysics;
}

export interface PoliceEvents {
  /** Offences seen by police this step. */
  witnessed: ("speeding" | "rammed-cop" | "takedown")[];
  /** Hits between the player and a unit: the unit and the closing speed (m/s). */
  rams: { unit: Unit; impact: number; x: number; z: number }[];
  /** A patrol turned into a pursuit unit (it saw something). */
  joined: Unit[];
  roadblock: Roadblock | null;
  /** Traffic cars honking at a unit that hit them. */
  horns: { car: TrafficCar; long: boolean }[];
}

/** Police vision: a patrol notices offences within 140 m; units already on a chase keep you in sight to 220 m. */
export const SIGHT_RANGE = 140;
export const PURSUIT_SIGHT = 220;
const SIGHT_FOV = Math.cos((150 / 2) * (Math.PI / 180));
/** Speed limits cops enforce (km/h): city streets, and highways (freeway, ramps, coast road). */
export const SPEED_LIMIT_KMH = 95;
export const HIGHWAY_LIMIT_KMH = 140;

export class Police {
  readonly units: Unit[] = [];
  readonly roadblocks: Roadblock[] = [];
  /** Patrol cars kept in traffic around the player while calm. */
  patrolTarget = 3;
  enabled = true;
  private nextId = 1;
  private rng = mulberry32(911);
  private scratch: Collider[] = [];
  /** Seconds until the next roadblock may be set up (public for tests). */
  blockCool = 15;
  private spawnCool = 0;
  private patrolCool = 0;
  /** Last place a unit saw the player. */
  lastKnown: { x: number; z: number } | null = null;

  constructor(
    readonly net: RoadNetwork,
    readonly world: World,
    readonly statics: SpatialHash,
    readonly traffic: Traffic,
  ) {}

  // ---------------------------------------------------------------------------
  // Vision
  // ---------------------------------------------------------------------------

  /** Line of sight against tall static obstacles (buildings, containers, tanks). */
  lineOfSight(ax: number, az: number, bx: number, bz: number): boolean {
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(len / 30));
    for (let k = 0; k <= steps; k++) {
      const cx = ax + ((bx - ax) * k) / steps;
      const cz = az + ((bz - az) * k) / steps;
      for (const col of this.statics.query(cx, cz, 16, this.scratch)) {
        if (col.top < 3 || col.top > 900) continue; // kerbs / low walls; world boundary
        if (col.kind === "circle") {
          if (col.breakable || col.broken || col.r < 2) continue; // posts, trees, parked cars
          if (distToSeg(col.x, col.z, ax, az, bx, bz) < col.r) return false;
          continue;
        }
        const c = col.kind === "box" ? boxCorners(col) : obbCorners(col);
        for (let i = 0; i < 4; i++) {
          const p = c[i];
          const q = c[(i + 1) % 4];
          if (segmentsIntersect(ax, az, bx, bz, p[0], p[1], q[0], q[1])) return false;
        }
      }
    }
    return true;
  }

  /**
   * Can a police car at (x, z) facing `heading` see the player? In range,
   * in its field of view (or very close), and not behind a building.
   */
  canSee(x: number, z: number, y: number, heading: number, p: PlayerView, alert: boolean): boolean {
    const dx = p.x - x;
    const dz = p.z - z;
    const d = Math.hypot(dx, dz);
    if (d > (alert ? PURSUIT_SIGHT : SIGHT_RANGE) || Math.abs(p.y - y) > 9) return false;
    if (d > 20 && !alert) {
      const f = (dx * Math.sin(heading) + dz * Math.cos(heading)) / d;
      if (f < SIGHT_FOV) return false;
    }
    return this.lineOfSight(x, z, p.x, p.z);
  }

  /**
   * Would a police car see an offence happening right now? Units on a chase
   * see all round; patrols only in their field of view.
   */
  witness(p: PlayerView): boolean {
    for (const u of this.units) if (u.mode !== "wrecked" && this.canSee(u.phys.x, u.phys.z, u.phys.y, u.phys.heading, p, true)) return true;
    for (const c of this.patrols()) if (c.wrecked <= 0 && this.canSee(c.x, c.z, c.y, c.heading, p, false)) return true;
    return false;
  }

  /** The speed limit (km/h) where the player is driving. */
  speedLimit(p: PlayerView): number {
    const r = this.net.roadAt(p.x, p.z, 2, p.y)?.road;
    return r && (r.cls === "freeway" || r.cls === "ramp" || r.cls === "coast") ? HIGHWAY_LIMIT_KMH : SPEED_LIMIT_KMH;
  }

  /** Turns the police on / off (off = no patrols, no chases: free roam). */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.standDown();
      for (const c of this.patrols()) this.traffic.remove(c);
    }
  }

  /** Any unit currently seeing the player. */
  anyoneSees(): boolean {
    return this.units.some((u) => u.sees && u.mode !== "wrecked");
  }

  /** Distance to the nearest unit that can still chase. */
  nearest(px: number, pz: number): number {
    let d = Infinity;
    for (const u of this.units) if (u.mode !== "wrecked") d = Math.min(d, Math.hypot(u.phys.x - px, u.phys.z - pz));
    return d;
  }

  /** Two or more units within a few metres on different sides of the player. */
  boxedIn(px: number, pz: number): boolean {
    const near = this.units.filter((u) => u.mode !== "wrecked" && Math.hypot(u.phys.x - px, u.phys.z - pz) < 8.5);
    for (let i = 0; i < near.length; i++) {
      for (let j = i + 1; j < near.length; j++) {
        const a = Math.atan2(near[i].phys.x - px, near[i].phys.z - pz);
        const b = Math.atan2(near[j].phys.x - px, near[j].phys.z - pz);
        if (Math.abs(wrapAngle(a - b)) > Math.PI / 2) return true;
      }
    }
    return false;
  }

  /** Patrol cars in traffic. */
  patrols(): TrafficCar[] {
    return this.traffic.cars.filter((c) => c.model.kind === "police");
  }

  // ---------------------------------------------------------------------------
  // Units
  // ---------------------------------------------------------------------------

  /** Adds a police car (also used by the tests to stage scenes). */
  makeUnit(def: CarDef, x: number, z: number, heading: number, y: number, mode: UnitMode): Unit {
    const phys = new CarPhysics(def);
    phys.place(x, z, heading, y);
    const u: Unit = {
      id: this.nextId++,
      phys,
      mode,
      repath: 0,
      stuck: 0,
      reversing: 0,
      lostFor: 0,
      sees: false,
      siren: mode !== "wrecked",
      damage: 0,
      hitCool: 0,
      side: this.rng() < 0.5 ? -1 : 1,
      clearT: 0,
      ctl: { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false },
      searchGoal: null,
      route: [],
      cursor: 0,
      routeGoal: null,
      offRoad: 0,
    };
    this.units.push(u);
    return u;
  }

  /** Turns a traffic patrol into a pursuit unit where it is. */
  promote(car: TrafficCar): Unit {
    const u = this.makeUnit(INTERCEPTOR, car.x, car.z, car.heading, car.y, "pursue");
    u.phys.vx = Math.sin(car.heading) * car.v;
    u.phys.vz = Math.cos(car.heading) * car.v;
    this.traffic.remove(car);
    return u;
  }

  /**
   * Brings a unit in out of the player's sight, already driving along its
   * road route towards them. `ahead` puts it 160-320 m up the road the
   * player is heading for (to cut them off), otherwise anywhere 140-320 m away.
   */
  spawnUnit(p: PlayerView, heat: number, ahead = this.rng() < 0.6): Unit | null {
    const vx = p.speed > 3 ? p.vx / p.speed : Math.sin(p.heading);
    const vz = p.speed > 3 ? p.vz / p.speed : Math.cos(p.heading);
    for (let attempt = 0; attempt < 30; attempt++) {
      const r = this.net.roads[Math.floor(this.rng() * this.net.roads.length)];
      if (r.cls === "runway" || r.s1 - r.s0 < 40) continue;
      const s = r.s0 + 15 + this.rng() * (r.s1 - r.s0 - 30);
      const c = r.center.sample(s);
      const dx = c.x - p.x;
      const dz = c.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < (ahead ? 160 : 140) || d > 320) continue;
      if (ahead && (dx * vx + dz * vz) / d < 0.55) continue;
      const y = r.heightAt(s);
      if (Math.abs(y - p.y) > 25) continue;
      if (d < 230 && this.lineOfSight(p.x, p.z, c.x, c.z)) continue;
      const route = this.planRoute(c.x, c.z, y, p.x, p.z, p.y);
      if (!route || route.length < 6) continue;
      const a = route[0];
      const b = route[4];
      const heading = Math.atan2(b.x - a.x, b.z - a.z);
      const def = this.rng() < enforcerShare(heat) ? ENFORCER : INTERCEPTOR;
      const u = this.makeUnit(def, a.x, a.z, heading, this.world.ground(a.x, a.z, y), "pursue");
      u.phys.vx = Math.sin(heading) * 14;
      u.phys.vz = Math.cos(heading) * 14;
      u.route = route;
      u.routeGoal = { x: p.x, z: p.z };
      u.repath = 1;
      u.lostFor = 0.5;
      return u;
    }
    return null;
  }

  remove(u: Unit): void {
    const i = this.units.indexOf(u);
    if (i >= 0) this.units.splice(i, 1);
    for (const rb of this.roadblocks) {
      const k = rb.units.indexOf(u);
      if (k >= 0) rb.units.splice(k, 1);
    }
  }

  /** Ends every chase: units leave, roadblocks are cleared. Patrols stay in traffic. */
  standDown(): void {
    this.units.length = 0;
    this.roadblocks.length = 0;
    this.lastKnown = null;
    this.blockCool = 15;
  }

  // ---------------------------------------------------------------------------
  // Road routing: A* over the junction graph, turned into a lane-level path
  // (police may drive against one-way traffic, like in the films)
  // ---------------------------------------------------------------------------

  /** Points along road `r` from arc length s0 to s1, in the right-hand lane for that direction. */
  private legPoints(r: Road, s0: number, s1: number, out: { x: number; z: number }[]): void {
    const dir = s1 >= s0 ? 1 : -1;
    const lat = r.spec.oneWay ? 0 : Math.min(r.laneOffset(0), r.hw * 0.5) * dir;
    const n = Math.max(1, Math.ceil(Math.abs(s1 - s0) / 5));
    for (let k = out.length ? 1 : 0; k <= n; k++) {
      const s = clamp(s0 + ((s1 - s0) * k) / n, 0.01, r.length - 0.01);
      const p = r.center.sample(s);
      const t = r.center.tangent(s);
      out.push({ x: p.x - t.tz * lat, z: p.z + t.tx * lat });
    }
  }

  /** Road route from (a) to (b) as a polyline, or null if either end is off the network. */
  planRoute(ax: number, az: number, ay: number, bx: number, bz: number, by: number): { x: number; z: number }[] | null {
    const a = this.net.nearestRoad(ax, az, 45, ay);
    const b = this.net.nearestRoad(bx, bz, 60, by);
    if (!a || !b) return null;
    const out: { x: number; z: number }[] = [];
    if (a.road === b.road) {
      this.legPoints(a.road, a.s, b.s, out);
      return out;
    }
    const g = new Map<RNode, number>();
    const came = new Map<RNode, { prev: RNode | null; road: Road }>();
    const open = new Set<RNode>();
    const seed = (n: RNode, cost: number) => {
      if (cost < (g.get(n) ?? Infinity)) {
        g.set(n, cost);
        came.set(n, { prev: null, road: a.road });
        open.add(n);
      }
    };
    seed(a.road.from, a.s);
    seed(a.road.to, a.road.length - a.s);
    const tail = new Map<RNode, number>();
    tail.set(b.road.from, b.s);
    tail.set(b.road.to, Math.min(tail.get(b.road.to) ?? Infinity, b.road.length - b.s));
    let best: RNode | null = null;
    let bestCost = Infinity;
    let guard = 0;
    while (open.size && guard++ < 4000) {
      let cur: RNode | null = null;
      let bf = Infinity;
      for (const n of open) {
        const f = (g.get(n) ?? Infinity) + Math.hypot(n.x - bx, n.z - bz);
        if (f < bf) {
          bf = f;
          cur = n;
        }
      }
      if (!cur || bf >= bestCost) break;
      open.delete(cur);
      const gc = g.get(cur)!;
      const t = tail.get(cur);
      if (t !== undefined && gc + t < bestCost) {
        bestCost = gc + t;
        best = cur;
      }
      for (const e of cur.ends) {
        const r = e.road;
        if (r.cls === "runway") continue;
        const nb = e.atStart ? r.to : r.from;
        const cost = gc + r.length * (r.cls === "freeway" ? 0.8 : 1);
        if (cost < (g.get(nb) ?? Infinity)) {
          g.set(nb, cost);
          came.set(nb, { prev: cur, road: r });
          open.add(nb);
        }
      }
    }
    if (!best) return null;
    const nodes: RNode[] = [];
    const roads: Road[] = [];
    for (let n: RNode | null = best; n; ) {
      nodes.unshift(n);
      const c: { prev: RNode | null; road: Road } = came.get(n)!;
      if (c.prev) roads.unshift(c.road);
      n = c.prev;
    }
    this.legPoints(a.road, a.s, nodes[0] === a.road.from ? 0 : a.road.length, out);
    for (let i = 0; i < roads.length; i++) {
      const r = roads[i];
      const fwd = nodes[i] === r.from;
      this.legPoints(r, fwd ? 0 : r.length, fwd ? r.length : 0, out);
    }
    const last = nodes[nodes.length - 1];
    this.legPoints(b.road, last === b.road.from ? 0 : b.road.length, b.s, out);
    return out;
  }

  /**
   * Follows the unit's road route (pure pursuit: steer at a point a little
   * way along it), braking in time for every corner. Re-plans when the goal
   * moves or the unit strays. Returns null if there is no usable route.
   */
  private follow(u: Unit, goal: { x: number; z: number }, goalY: number, vMax: number, dt: number, goalSpeed = 0): Controls | null {
    const c = u.phys;
    u.repath -= dt;
    const stale = !u.routeGoal || Math.hypot(u.routeGoal.x - goal.x, u.routeGoal.z - goal.z) > 25;
    if (u.repath <= 0 || (stale && u.repath < 1.1) || u.route.length < 2) {
      u.route = this.planRoute(c.x, c.z, c.y, goal.x, goal.z, goalY) ?? [];
      u.cursor = 0;
      u.routeGoal = { x: goal.x, z: goal.z };
      u.repath = 1.5;
    }
    const pts = u.route;
    if (pts.length < 2) return null;
    let i = u.cursor;
    let bd = Infinity;
    for (let k = u.cursor; k < Math.min(pts.length, u.cursor + 40); k++) {
      const d = Math.hypot(pts[k].x - c.x, pts[k].z - c.z);
      if (d < bd) {
        bd = d;
        i = k;
      }
    }
    u.cursor = i;
    if (bd > 28) {
      u.repath = 0; // strayed: re-plan next frame
      return null;
    }
    // Steering target: ~look metres along the route.
    const look = 7 + c.speed * 0.42;
    let j = i;
    for (let acc = 0; j < pts.length - 1 && acc < look; j++) acc += Math.hypot(pts[j + 1].x - pts[j].x, pts[j + 1].z - pts[j].z);
    // Corner speed: heading change over the next ~15 m, at every point within
    // braking distance, braking at ~7 m/s^2.
    const aLat = c.def.handling.cornering * 0.8;
    const brakeDist = (c.speed * c.speed) / 14 + 20;
    let vAllowed = vMax;
    let d = 0;
    for (let k = i; k < pts.length - 2 && d < brakeDist; k++) {
      const p0 = pts[k];
      const p1 = pts[k + 1];
      const q0 = pts[Math.min(pts.length - 2, k + 3)];
      const q1 = pts[Math.min(pts.length - 1, k + 4)];
      const dh = Math.abs(wrapAngle(Math.atan2(q1.x - q0.x, q1.z - q0.z) - Math.atan2(p1.x - p0.x, p1.z - p0.z)));
      if (dh > 0.06) {
        const vc = Math.sqrt(aLat * (15 / dh));
        vAllowed = Math.min(vAllowed, Math.sqrt(vc * vc + 14 * d));
      }
      d += Math.hypot(p1.x - p0.x, p1.z - p0.z);
    }
    // Arrive under control: at most the target's own speed plus what we can
    // still brake away before reaching it (no bulldozing a stopped player).
    let left = 0;
    for (let k = i; k < pts.length - 1; k++) left += Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].z - pts[k].z);
    vAllowed = Math.min(vAllowed, goalSpeed + stoppingSpeed(left - 9, 7));
    return this.drive(u, pts[j].x, pts[j].z, vAllowed, dt);
  }

  /** Steers back to the nearest road when a unit has no usable route. */
  private backToRoad(u: Unit, dt: number): Controls {
    const c = u.phys;
    const near = this.net.nearestRoad(c.x, c.z, 160, c.y);
    if (!near) return holdControls(c);
    const p = near.road.center.sample(near.s);
    return this.drive(u, p.x, p.z, 10, dt);
  }

  // ---------------------------------------------------------------------------
  // The AI driver
  // ---------------------------------------------------------------------------

  /**
   * Steers around traffic and other police cars in the way: if one sits in
   * the corridor towards the target, aim beside it instead (passing on the
   * side it is not on; dead ahead, overtake on the left).
   */
  private avoid(u: Unit, tx: number, tz: number): { x: number; z: number } {
    const c = u.phys;
    const dx = tx - c.x;
    const dz = tz - c.z;
    const L = Math.hypot(dx, dz);
    if (L < 3) return { x: tx, z: tz };
    const fx = dx / L;
    const fz = dz / L;
    const look = Math.min(L - 1, 10 + c.speed * 1.3);
    let bestAlong = Infinity;
    let bestLat = 0;
    let bestW = 0;
    const others: { x: number; y: number; z: number; w: number }[] = [];
    for (const t of this.traffic.cars) others.push({ x: t.x, y: t.y, z: t.z, w: t.model.width });
    for (const o of this.units) if (o !== u) others.push({ x: o.phys.x, y: o.phys.y, z: o.phys.z, w: o.phys.def.body.width });
    for (const o of others) {
      if (Math.abs(o.y - c.y) > 3) continue;
      const ox = o.x - c.x;
      const oz = o.z - c.z;
      const along = ox * fx + oz * fz;
      if (along < 1.5 || along > look || along >= bestAlong) continue;
      const lat = -ox * fz + oz * fx; // + right of the line to the target
      if (Math.abs(lat) > o.w / 2 + c.def.body.width / 2 + 0.5) continue;
      bestAlong = along;
      bestLat = lat;
      bestW = o.w;
    }
    if (bestAlong === Infinity) return { x: tx, z: tz };
    // Pass on the side the obstacle is NOT on; dead ahead, go left (lat < 0).
    const side = bestLat < -0.3 ? 1 : -1;
    const clearance = bestW / 2 + c.def.body.width / 2 + 0.9;
    const lat = bestLat + side * clearance;
    return { x: c.x + fx * bestAlong - fz * lat, z: c.z + fz * bestAlong + fx * lat };
  }

  /** Throttle / brake / steer to reach (tx, tz) at about `vWant` m/s. */
  private drive(u: Unit, tx: number, tz: number, vWant: number, dt: number, ram = false): Controls {
    const c = u.phys;
    ({ x: tx, z: tz } = this.avoid(u, tx, tz));
    const dx = tx - c.x;
    const dz = tz - c.z;
    const err = wrapAngle(Math.atan2(dx, dz) - c.heading);
    const dist = Math.hypot(dx, dz);
    if (u.reversing > 0) {
      u.reversing -= dt;
      // Back out, steering the other way so the nose swings towards the target.
      return { throttle: 0, brake: 1, steer: -Math.sign(err || 1), handbrake: false, nitro: false };
    }
    const sharp = Math.abs(err);
    let steer = clamp(err * 2.4, -1, 1);
    const v = c.vLong;
    // Slow for the corner ahead: the tighter the angle, the slower.
    const vTurn = sharp > 1.3 ? 8 : sharp > 0.7 ? 13 : sharp > 0.35 ? Math.max(18, vWant * 0.6) : vWant;
    const target = ram ? vWant : Math.min(vWant, vTurn);
    let throttle = v < target - 0.5 ? 1 : 0;
    let brake = v > target + 1.5 ? clamp((v - target) / 3, 0.35, 1) : 0;
    const handbrake = sharp > 1.0 && v > 15 && !ram;
    if (sharp > 2.3 && v < 5) {
      // Target behind us at low speed: three-point turn.
      throttle = 0;
      brake = 1;
      steer = -steer;
    }
    void dist;
    return { throttle, brake, steer, handbrake, nitro: false };
  }

  private pursue(u: Unit, p: PlayerView, heat: number, dt: number): Controls {
    const c = u.phys;
    const d = Math.hypot(p.x - c.x, p.z - c.z);
    // Units drive flat out, capped a little under the player's top speed at
    // low heat so you can outrun them (heat 5 units can keep up).
    const cap = Math.min(c.vmax, p.car.vmax * [0, 0.78, 0.84, 0.9, 0.96, 1.02][Math.min(5, heat)]);
    if (u.sees && d < 45) {
      // Where is the unit relative to the player's car?
      const fx = Math.sin(p.heading);
      const fz = Math.cos(p.heading);
      const rx = -fz;
      const rz = fx;
      const along = (c.x - p.x) * fx + (c.z - p.z) * fz;
      const side = (c.x - p.x) * rx + (c.z - p.z) * rz;
      if (p.speed < 4) {
        // Player (nearly) stopped: pull up right next to them and hold - that
        // is how a bust is made. Brake in time so we stop beside them
        // instead of ramming them out of the box.
        if (d < 6) return holdControls(c);
        return this.drive(u, p.x, p.z, Math.min(cap, stoppingSpeed(d - 6.5)), dt, true);
      }
      if (d < 24 && heat < 2) {
        // Heat 1: tail the player at a few car lengths (no ramming yet).
        const tx = p.x - Math.sin(p.heading) * 9;
        const tz = p.z - Math.cos(p.heading) * 9;
        return this.drive(u, tx, tz, Math.min(cap, p.speed + clamp((d - 9) * 0.6, -6, 6)), dt);
      }
      if (d < 24) {
        // Heat 2+: get beside the rear quarter, then steer into it (PIT) - a
        // firm nudge that spins the player, not a bulldozer push.
        if (Math.abs(side) > 0.8) u.side = Math.sign(side);
        const besideLat = (p.car.def.body.width + c.def.body.width) / 2 + 0.35;
        if (along > 2.5) {
          // Ahead of the player: cut in front and brake-check.
          return this.drive(u, p.x + fx * 9, p.z + fz * 9, Math.max(0, p.speed - 4), dt, true);
        }
        if (along < -3.5) {
          // Behind: draw alongside the rear quarter, offset by a car width.
          const tx = p.x - fx * 2 + rx * u.side * besideLat;
          const tz = p.z - fz * 2 + rz * u.side * besideLat;
          return this.drive(u, tx, tz, Math.min(cap, p.speed + clamp(-along * 0.6, 2, 8)), dt, true);
        }
        // Alongside: steer into the rear wheel at matched speed.
        const tx = p.x - fx * 1.8 + rx * u.side * (besideLat - 1.4);
        const tz = p.z - fz * 1.8 + rz * u.side * (besideLat - 1.4);
        return this.drive(u, tx, tz, Math.min(cap, p.speed + 1), dt, true);
      }
      // Lead pursuit: aim where the player will be.
      const lead = clamp(d / Math.max(12, c.speed + 1), 0, 1.2);
      return this.drive(u, p.x + p.vx * lead, p.z + p.vz * lead, cap, dt);
    }
    // Further away or out of sight: follow the roads to the player (seen) or
    // to the last sighting radioed in by another unit.
    const live = u.sees || (this.lastKnown && Math.hypot(this.lastKnown.x - p.x, this.lastKnown.z - p.z) < 1);
    const goal = u.sees ? { x: p.x, z: p.z } : (this.lastKnown ?? { x: p.x, z: p.z });
    const ctl = this.follow(u, goal, p.y, cap, dt, live ? p.speed : 0);
    return ctl ?? this.backToRoad(u, dt);
  }

  private search(u: Unit, dt: number): Controls {
    const c = u.phys;
    const lk = this.lastKnown ?? { x: c.x, z: c.z };
    // Head to the last sighting, then sweep junctions around it.
    if (!u.searchGoal || Math.hypot(u.searchGoal.x - c.x, u.searchGoal.z - c.z) < 25) {
      const near = Math.hypot(lk.x - c.x, lk.z - c.z) < 40;
      let goal = lk;
      if (near || u.searchGoal) {
        const nodes = [...this.net.nodes.values()].filter((n) => Math.hypot(n.x - lk.x, n.z - lk.z) < 320);
        const n = nodes[Math.floor(this.rng() * nodes.length)];
        if (n) goal = { x: n.x, z: n.z };
      }
      u.searchGoal = goal;
    }
    const ctl = this.follow(u, u.searchGoal, c.y, 21, dt, 21);
    return ctl ?? this.backToRoad(u, dt);
  }

  // ---------------------------------------------------------------------------
  // Main update (once per frame)
  // ---------------------------------------------------------------------------

  /**
   * Advances the police for one frame.
   *  - pursuit: the chase is hot. Units are radioed your position, so they
   *    all converge on you along the roads (and lead-pursue / PIT on sight).
   *  - cooldown: they lost you. Units search the roads around where you
   *    were last seen; any unit or patrol seeing you restarts the pursuit.
   *  - busted / escaped / calm: units pull over, or leave once out of view.
   */
  step(dt: number, p: PlayerView, heat: number, state: HeatState): PoliceEvents {
    const ev: PoliceEvents = { witnessed: [], rams: [], joined: [], roadblock: null, horns: [] };
    if (!this.enabled) return ev;
    const active = state === "pursuit" || state === "cooldown";

    // ---- patrols in traffic --------------------------------------------------
    const patrols = this.patrols();
    this.patrolCool -= dt;
    if (this.traffic.enabled && patrols.length < this.patrolTarget && this.patrolCool <= 0) {
      this.patrolCool = 2;
      // Patrols are part of the traffic budget: retire the civilian car
      // farthest from the player to make room.
      if (this.traffic.cars.length >= this.traffic.target) {
        let far: TrafficCar | null = null;
        let fd = 150;
        for (const c of this.traffic.cars) {
          if (c.model.kind === "police") continue;
          const dd = Math.hypot(c.x - p.x, c.z - p.z);
          if (dd > fd) {
            fd = dd;
            far = c;
          }
        }
        if (far) this.traffic.remove(far);
      }
      if (this.traffic.cars.length < this.traffic.target) this.traffic.spawnNear(p.x, p.z, p.heading, 120, 320, POLICE_MODEL);
    }
    const speeding = p.speed * KMH > this.speedLimit(p);
    for (const car of patrols) {
      if (car.wrecked > 0) continue;
      const d = Math.hypot(car.x - p.x, car.z - p.z);
      if (d > SIGHT_RANGE) continue;
      // Patrols look along their lane; when a chase is on they look everywhere.
      if (!this.canSee(car.x, car.z, car.y, car.heading, p, active)) continue;
      if (active || (speeding && d < 100)) {
        if (!active) ev.witnessed.push("speeding");
        const u = this.promote(car);
        u.sees = true;
        ev.joined.push(u);
        this.lastKnown = { x: p.x, z: p.z };
      }
    }

    // ---- reinforcements ----------------------------------------------------------
    const chasing = this.units.filter((u) => u.mode === "pursue" || u.mode === "search");
    this.spawnCool -= dt;
    if (active && chasing.length < unitsForHeat(heat) && this.spawnCool <= 0) {
      this.spawnCool = 2.5;
      this.spawnUnit(p, heat);
    }

    // ---- units ----------------------------------------------------------------------
    for (const u of [...this.units]) {
      const c = u.phys;
      const d = Math.hypot(c.x - p.x, c.z - p.z);
      u.hitCool = Math.max(0, u.hitCool - dt);
      if (u.mode === "wrecked") {
        u.ctl = holdControls(c);
        c.step(dt, u.ctl, this.world);
        u.clearT -= dt;
        if (u.clearT <= 0 && d > 90) this.remove(u);
        continue;
      }
      if (state === "busted") {
        // Pull over around the player, lights still flashing.
        u.ctl = holdControls(c);
        c.step(dt, u.ctl, this.world);
        continue;
      }
      if (!active && u.mode !== "roadblock") {
        // Chase over: units leave once out of view.
        if (d > 160 || !this.lineOfSight(p.x, p.z, c.x, c.z)) {
          this.remove(u);
          continue;
        }
      }
      if (d > 750) {
        this.remove(u);
        continue;
      }
      u.sees = this.canSee(c.x, c.z, c.y, c.heading, p, u.mode === "pursue");
      if (u.sees) {
        u.lostFor = 0;
        this.lastKnown = { x: p.x, z: p.z };
      } else u.lostFor += dt;
      if (u.mode === "roadblock") {
        u.ctl = holdControls(c);
        c.step(dt, u.ctl, this.world);
        u.siren = true;
        continue;
      }
      if (u.sees && speeding && !active && d < 100) ev.witnessed.push("speeding");
      // Pursuit: every unit converges (on sightings radioed in). Cooldown:
      // only units that can see you chase; the rest search where you were
      // last seen. Chase over: they cruise off and leave once out of view.
      const want: UnitMode = active && (state === "pursuit" || u.sees) ? "pursue" : "search";
      if (want !== u.mode) {
        u.mode = want;
        u.repath = 0;
        u.searchGoal = null;
      }
      u.siren = active;
      const ctl = u.mode === "pursue" ? this.pursue(u, p, heat, dt) : this.search(u, dt);
      // Stuck: trying to move but not moving -> back out.
      const trying = ctl.throttle > 0 || (ctl.brake > 0 && c.vLong < 0.3);
      u.stuck = trying && c.speed < 1.5 && u.reversing <= 0 ? u.stuck + dt : 0;
      if (u.stuck > 1.2) {
        u.reversing = 1.0;
        u.stuck = 0;
      }
      u.ctl = ctl;
      c.step(dt, ctl, this.world);
      // Lost: off the road network for a while and out of the player's sight
      // -> recycle it (a fresh unit will be dispatched). Fell in the water: drop it.
      const onNet = !!(this.net.roadAt(c.x, c.z, 6, c.y) || this.net.nodeAt(c.x, c.z));
      u.offRoad = onNet ? 0 : u.offRoad + dt;
      if (c.y < -1.2 || !Number.isFinite(c.x + c.z) || (u.offRoad > 6 && !u.sees)) this.remove(u);
    }

    // ---- roadblocks -------------------------------------------------------------------
    this.blockCool -= dt;
    if (active && roadblocksAt(heat) && this.blockCool <= 0 && this.roadblocks.length === 0) {
      const rb = this.placeRoadblock(p);
      if (rb) {
        this.roadblocks.push(rb);
        ev.roadblock = rb;
        this.blockCool = 34 - heat * 3;
      } else this.blockCool = 3;
    }
    for (const rb of [...this.roadblocks]) {
      rb.age += dt;
      const dx = p.x - rb.x;
      const dz = p.z - rb.z;
      const along = dx * Math.sin(rb.heading) + dz * Math.cos(rb.heading);
      const d = Math.hypot(dx, dz);
      if (!rb.passed && d < 30 && Math.abs(along) > 8) rb.passed = true;
      if (!active || (rb.passed && d > 140) || (rb.age > 75 && d > 160)) {
        for (const u of [...rb.units]) this.remove(u);
        this.roadblocks.splice(this.roadblocks.indexOf(rb), 1);
      }
    }
    return ev;
  }

  /**
   * Player <-> unit and unit <-> unit contacts. Called every physics
   * sub-step (120 Hz) so a fast car cannot pass through a police car.
   */
  collide(p: PlayerView): PoliceEvents {
    const ev: PoliceEvents = { witnessed: [], rams: [], joined: [], roadblock: null, horns: [] };
    const pc = p.car;
    for (const u of this.units) {
      const c = u.phys;
      const hit = carContact(pc, c);
      if (!hit) continue;
      const parked = u.mode === "roadblock";
      // Separate (a parked roadblock car barely moves: it has its brakes on).
      const share = parked ? 0.85 : 0.5;
      pc.x -= hit.nx * hit.depth * share;
      pc.z -= hit.nz * hit.depth * share;
      c.x += hit.nx * hit.depth * (1 - share);
      c.z += hit.nz * hit.depth * (1 - share);
      const rel = (pc.vx - c.vx) * hit.nx + (pc.vz - c.vz) * hit.nz;
      if (rel <= 0) continue;
      // Momentum exchange along the normal (similar masses; a parked car is
      // effectively heavier because its wheels are locked).
      const restitution = 0.25;
      const mp = parked ? 0.72 : 0.5;
      const j = (1 + restitution) * rel;
      pc.vx -= hit.nx * j * mp;
      pc.vz -= hit.nz * j * mp;
      c.vx += hit.nx * j * (1 - mp);
      c.vz += hit.nz * j * (1 - mp);
      // An off-centre shove spins both cars a little (that is what a PIT does).
      const tx = -hit.nz;
      const tz = hit.nx;
      const lever = (hit.x - c.x) * tx + (hit.z - c.z) * tz;
      c.yawRate += clamp(lever * rel * 0.12, -3, 3);
      const plever = (hit.x - pc.x) * tx + (hit.z - pc.z) * tz;
      pc.yawRate -= clamp(plever * rel * 0.08, -2, 2);
      if (rel > 2.5 && u.hitCool === 0) {
        u.hitCool = 0.5;
        ev.rams.push({ unit: u, impact: rel, x: hit.x, z: hit.z });
        // Who drove into whom: the player is ramming if they were moving into the cop.
        const into = pc.vx * hit.nx + pc.vz * hit.nz;
        const copInto = -(c.vx * hit.nx + c.vz * hit.nz);
        const playerRam = into > copInto && into > 5 && u.mode !== "wrecked";
        if (playerRam) ev.witnessed.push("rammed-cop");
        if (u.mode !== "wrecked") {
          // A unit's own PIT nudges barely hurt it; your hits do.
          u.damage += (rel / (parked ? 30 : 40)) * (playerRam ? 1 : 0.2);
          if (u.damage >= 1) {
            u.mode = "wrecked";
            u.siren = false;
            u.clearT = 8;
            ev.witnessed.push("takedown");
          }
        }
      }
    }
    // Units crash through traffic like the player does: the traffic car is
    // knocked aside (hazards on, horn), the unit loses some speed.
    for (const u of this.units) {
      if (u.mode === "roadblock") continue;
      const c = u.phys;
      const tev = this.traffic.collide({ x: c.x, z: c.z, vx: c.vx, vz: c.vz, heading: c.heading, radius: c.radius, length: c.def.body.length });
      for (const h of tev.hits) {
        const k = 1 - 0.18 * clamp(h.impact / 25, 0, 1);
        c.vx *= k;
        c.vz *= k;
      }
      ev.horns.push(...tev.horns);
    }
    // Units push each other apart (no stacking in a pile-up).
    for (let i = 0; i < this.units.length; i++) {
      for (let k = i + 1; k < this.units.length; k++) {
        const a = this.units[i];
        const b = this.units[k];
        const hit = carContact(a.phys, b.phys);
        if (!hit) continue;
        const wa = a.mode === "roadblock" ? 0 : 0.5;
        const wb = b.mode === "roadblock" ? 0 : 0.5;
        const sum = wa + wb || 1;
        a.phys.x -= (hit.nx * hit.depth * wa) / sum;
        a.phys.z -= (hit.nz * hit.depth * wa) / sum;
        b.phys.x += (hit.nx * hit.depth * wb) / sum;
        b.phys.z += (hit.nz * hit.depth * wb) / sum;
        const rel = (a.phys.vx - b.phys.vx) * hit.nx + (a.phys.vz - b.phys.vz) * hit.nz;
        if (rel > 0) {
          a.phys.vx -= hit.nx * rel * wa;
          a.phys.vz -= hit.nz * rel * wa;
          b.phys.vx += hit.nx * rel * wb;
          b.phys.vz += hit.nz * rel * wb;
        }
      }
    }
    return ev;
  }

  /** Traffic treats units like the player's car: it brakes for them instead of driving through. */
  trafficObstacles(): PlayerState[] {
    return this.units.map((u) => ({ x: u.phys.x, z: u.phys.z, vx: u.phys.vx, vz: u.phys.vz, heading: u.phys.heading, radius: u.phys.radius, length: u.phys.def.body.length }));
  }

  /**
   * Builds a roadblock across a road 170-330 m ahead of the player (along
   * their heading), out of their line of sight when possible.
   */
  placeRoadblock(p: PlayerView): Roadblock | null {
    const fx = Math.sin(p.heading);
    const fz = Math.cos(p.heading);
    for (let attempt = 0; attempt < 20; attempt++) {
      const dist = 170 + attempt * 8;
      const ax = p.x + fx * dist + (this.rng() - 0.5) * 50;
      const az = p.z + fz * dist + (this.rng() - 0.5) * 50;
      const hit = this.net.roadAt(ax, az, 0, p.y);
      if (!hit) continue;
      const r = hit.road;
      if (r.cls === "runway" || r.cls === "ring" || r.cls === "ramp") continue;
      if (hit.s < r.s0 + 25 || hit.s > r.s1 - 25 || r.isBridge(hit.s)) continue;
      const y = r.heightAt(hit.s);
      if (Math.abs(y - p.y) > 12) continue;
      if (attempt < 12 && this.lineOfSight(p.x, p.z, ax, az)) continue;
      const c = r.center.sample(hit.s);
      const t = r.center.tangent(hit.s);
      const heading = Math.atan2(t.tx, t.tz);
      const rb: Roadblock = { id: this.nextId++, x: c.x, z: c.z, heading, road: r, units: [], passed: false, age: 0 };
      // Cars parked across the carriageway at an angle, leaving one gap at a
      // random kerb: ~3 m clear, room for a car if you thread it at speed.
      const gapSide = this.rng() < 0.5 ? -1 : 1;
      const GAP = 3.1;
      // A car angled 60 degrees off the road axis covers this much road width.
      const cover = (L: number, W: number) => L * Math.sin(1.07) + W * Math.cos(1.07);
      const cw = cover(INTERCEPTOR.body.length, INTERCEPTOR.body.width);
      // From the far kerb (no gap) to the gap edge: centres from far + cw/2 to near - GAP - cw/2.
      const far = -r.hw;
      const near = r.hw - GAP;
      const n = Math.max(2, Math.ceil((near - far) / (cw * 0.92)));
      for (let k = 0; k < n; k++) {
        const f = n === 1 ? 0.5 : k / (n - 1);
        const lat = (far + cw / 2 + f * (near - far - cw)) * gapSide;
        const x = c.x - t.tz * lat;
        const z = c.z + t.tx * lat;
        const def = k % 2 ? ENFORCER : INTERCEPTOR;
        // Angled ~60 degrees to the road, alternating, like a real block.
        const ang = heading + Math.PI / 2 + (k % 2 ? 0.5 : -0.5);
        const u = this.makeUnit(def, x, z, ang, this.world.ground(x, z, y), "roadblock");
        rb.units.push(u);
      }
      return rb;
    }
    return null;
  }

  /** Plain-data view for the tests and the HUD. */
  snapshot() {
    return {
      units: this.units.map((u) => ({ id: u.id, car: u.phys.def.id, mode: u.mode, x: u.phys.x, z: u.phys.z, speedKmh: u.phys.speedKmh, sees: u.sees, siren: u.siren, damage: u.damage })),
      patrols: this.patrols().map((c) => ({ id: c.id, x: c.x, z: c.z })),
      roadblocks: this.roadblocks.map((r) => ({ id: r.id, x: r.x, z: r.z, road: r.road.id, cars: r.units.length, passed: r.passed })),
    };
  }
}

// ---- helpers ------------------------------------------------------------------

function distToSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const L2 = dx * dx + dz * dz || 1e-9;
  let t = ((px - ax) * dx + (pz - az) * dz) / L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

function boxCorners(b: { minX: number; maxX: number; minZ: number; maxZ: number }): number[][] {
  return [
    [b.minX, b.minZ],
    [b.maxX, b.minZ],
    [b.maxX, b.maxZ],
    [b.minX, b.maxZ],
  ];
}

function obbCorners(b: { cx: number; cz: number; hx: number; hz: number; c: number; s: number }): number[][] {
  const ux = b.c * b.hx;
  const uz = b.s * b.hx;
  const vx = -b.s * b.hz;
  const vz = b.c * b.hz;
  return [
    [b.cx + ux + vx, b.cz + uz + vz],
    [b.cx - ux + vx, b.cz - uz + vz],
    [b.cx - ux - vx, b.cz - uz - vz],
    [b.cx + ux - vx, b.cz + uz - vz],
  ];
}

/** Contact between two cars (3 circles each). Normal points from a to b; (x, z) is the contact point. */
export function carContact(a: CarPhysics, b: CarPhysics): { nx: number; nz: number; depth: number; x: number; z: number } | null {
  const dx0 = b.x - a.x;
  const dz0 = b.z - a.z;
  const reach = (a.def.body.length + b.def.body.length) / 2 + 0.5;
  if (dx0 * dx0 + dz0 * dz0 > reach * reach || Math.abs(a.y - b.y) > 2.5) return null;
  let best: { nx: number; nz: number; depth: number; x: number; z: number } | null = null;
  for (const oa of a.circleOffsets) {
    const ax = a.x + a.forwardX * oa;
    const az = a.z + a.forwardZ * oa;
    for (const ob of b.circleOffsets) {
      const bx = b.x + b.forwardX * ob;
      const bz = b.z + b.forwardZ * ob;
      const dx = bx - ax;
      const dz = bz - az;
      const d = Math.hypot(dx, dz);
      const depth = a.radius + b.radius - d;
      if (depth > 0 && (!best || depth > best.depth)) {
        const nx = d > 1e-6 ? dx / d : 1;
        const nz = d > 1e-6 ? dz / d : 0;
        best = { nx, nz, depth, x: ax + nx * a.radius, z: az + nz * a.radius };
      }
    }
  }
  return best;
}
