/**
 * Stage 4: races, speed cameras and speed traps (NFS Most Wanted style).
 *
 * Pure logic - no rendering - so the whole thing is unit-tested headless.
 *
 *  - A RACE is a route through named roads of the map. Its checkpoints are
 *    generated along the route (every ~120 m and at every turn), each a gate
 *    across the road. Sprints run start -> finish; circuits run N laps.
 *  - RIVALS are full physics cars with an AI driver that follows the racing
 *    line (the route polyline), brakes for corners in time, weaves around
 *    traffic, and has a skill setting (cornering margin, top speed share,
 *    reaction to the player). A little catch-up keeps a race close without
 *    cheating: a rival never exceeds its car's real top speed.
 *  - POSITIONS are ranked by (checkpoints passed, distance to the next one).
 *  - A wrong turn is detected when the player drives away from the next
 *    checkpoint for a while; R puts you back on the route at the last gate.
 *  - SPEED CAMERAS photograph your speed as you pass (best speed counts);
 *    SPEED TRAPS (Most Wanted "speed zones") average your speed through a
 *    stretch between two gates. Each has a bronze/silver/gold target.
 *  - Best times / speeds are saved per event.
 */

import { clamp, wrapAngle } from "../core/math";
import { Polyline } from "../core/geom";
import { CarPhysics, KMH, type Controls, type World } from "./physics";
import type { CarDef } from "./cars";
import type { Road, RoadNetwork } from "./roads";
import { resolveCars } from "./contact";
import type { Traffic } from "./traffic";

// ---- event catalogue ----------------------------------------------------------

export type RaceKind = "sprint" | "circuit";

export interface RaceDef {
  id: string;
  name: string;
  kind: RaceKind;
  /** Roads in driving order. A road is driven from the junction it shares with the previous one. */
  roads: string[];
  laps: number;
  /** Rival cars (car ids). */
  rivals: string[];
  /** 0..1: how hard the rivals push. */
  skill: number;
  district: string;
}

export const RACES: RaceDef[] = [
  {
    id: "midtown-sprint",
    name: "Midtown Rush",
    kind: "sprint",
    // Kingsway east, down Grand Avenue, along the frontage road under I-9.
    roads: ["kings-1", "kings-2", "kings-3", "kings-4", "grand-4", "sf-4"],
    laps: 1,
    rivals: ["mustanger", "carrara", "vantis"],
    skill: 0.45,
    district: "Midtown",
  },
  {
    id: "harbour-circuit",
    name: "Harbour Loop",
    kind: "circuit",
    // Downtown block loop: Main Street, Waterfront, Bay Street, Market Street.
    roads: ["main-5", "main-6", "water-1", "water-2", "water-3", "bay-st-2", "market-3", "market-2", "market-1"],
    laps: 2,
    rivals: ["gtarr", "vantis", "carrara"],
    skill: 0.6,
    district: "Downtown",
  },
  {
    id: "coast-sprint",
    name: "Sunset Coast Run",
    kind: "sprint",
    roads: ["beach-rd", "coast-1", "coast-w", "westside-s"],
    laps: 1,
    rivals: ["aventura", "gtarr", "vantis"],
    skill: 0.7,
    district: "Sunset Beach",
  },
  {
    id: "ridge-sprint",
    name: "Ridge Parkway Dash",
    kind: "sprint",
    roads: ["rp-4", "rp-3", "rp-2", "rp-1", "af-rd"],
    laps: 1,
    rivals: ["veyrone", "aventura", "gtarr"],
    skill: 0.8,
    district: "Hillcrest",
  },
];

export interface CameraDef {
  id: string;
  name: string;
  kind: "camera" | "trap";
  road: string;
  /** Position along the road (0..1); a trap runs from t to t2. */
  t: number;
  t2?: number;
  /** km/h targets for bronze / silver / gold. */
  targets: [number, number, number];
}

export const SPEED_EVENTS: CameraDef[] = [
  { id: "cam-i9", name: "I-9 Viaduct Camera", kind: "camera", road: "i9-2", t: 0.55, targets: [180, 220, 260] },
  { id: "cam-runway", name: "Airfield Camera", kind: "camera", road: "runway", t: 0.8, targets: [200, 250, 300] },
  { id: "cam-coast", name: "Coast Highway Camera", kind: "camera", road: "coast-w", t: 0.6, targets: [150, 190, 230] },
  { id: "cam-r7", name: "Route 7 Camera", kind: "camera", road: "r7-2", t: 0.5, targets: [170, 210, 250] },
  { id: "trap-i9", name: "Interstate Speed Trap", kind: "trap", road: "i9-1", t: 0.25, t2: 0.8, targets: [160, 200, 240] },
  { id: "trap-ridge", name: "Ridge Parkway Speed Trap", kind: "trap", road: "rp-1", t: 0.2, t2: 0.8, targets: [130, 165, 200] },
];

export type Medal = "none" | "bronze" | "silver" | "gold";

export function medalFor(kmh: number, targets: readonly [number, number, number]): Medal {
  if (kmh >= targets[2]) return "gold";
  if (kmh >= targets[1]) return "silver";
  if (kmh >= targets[0]) return "bronze";
  return "none";
}

// ---- route geometry -------------------------------------------------------------

export interface Gate {
  x: number;
  z: number;
  y: number;
  /** Driving direction through the gate. */
  hx: number;
  hz: number;
  /** Half width (the road's carriageway). */
  hw: number;
  /** Arc length along the route. */
  s: number;
}

export interface Route {
  /** Racing line through the whole route (one lap), right-hand lane. */
  line: Polyline;
  /** Heights along `line` points. */
  y: number[];
  gates: Gate[];
  /** Start grid: 4 slots, 2 abreast (pole first). */
  grid: { x: number; z: number; y: number; heading: number }[];
  length: number;
  closed: boolean;
}

/**
 * Builds the route for a race: walks its roads in order, picking each road's
 * direction from the junction it shares with the previous road, samples a
 * line along the right-hand carriageway, and drops gates every ~120 m plus
 * at every sharp turn.
 */
export function buildRoute(net: RoadNetwork, def: RaceDef): Route {
  const roads = def.roads.map((id) => net.road(id));
  // Direction of the first road: towards the junction shared with the second.
  const dirs: (1 | -1)[] = [];
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    if (i === 0) {
      const nx = roads[1];
      dirs.push(nx && (r.to === nx.from || r.to === nx.to) ? 1 : -1);
    } else {
      const prev = roads[i - 1];
      const end = dirs[i - 1] > 0 ? prev.to : prev.from;
      if (r.from === end) dirs.push(1);
      else if (r.to === end) dirs.push(-1);
      else throw new Error(`race ${def.id}: ${r.id} does not continue from ${prev.id}`);
    }
  }
  if (def.kind === "circuit") {
    const last = roads[roads.length - 1];
    const end = dirs[dirs.length - 1] > 0 ? last.to : last.from;
    const start = dirs[0] > 0 ? roads[0].from : roads[0].to;
    if (end !== start) throw new Error(`race ${def.id}: circuit does not close`);
  }
  // Each road is driven between its junction discs (s0..s1); through every
  // junction the line is a smooth curve (cubic Bezier) joining the two roads,
  // so a 90-degree turn becomes a real arc instead of a hairpin corner.
  const pts: { x: number; z: number }[] = [];
  const ys: number[] = [];
  const hws: number[] = [];
  const legs: { start: { x: number; z: number; tx: number; tz: number; y: number }; end: { x: number; z: number; tx: number; tz: number; y: number } }[] = [];
  roads.forEach((r, i) => {
    const d = dirs[i];
    const s0 = d > 0 ? r.s0 : r.s1;
    const s1 = d > 0 ? r.s1 : r.s0;
    const n = Math.max(2, Math.ceil(Math.abs(s1 - s0) / 4));
    // Racing line: the inner lane of the carriageway in our direction (or the middle of a one-way road).
    const lat = r.spec.oneWay ? 0 : Math.min(r.laneOffset(0), r.hw * 0.45);
    const at = (s: number) => {
      const p = r.center.sample(clamp(s, 0, r.length));
      const t = r.center.tangent(clamp(s, 0, r.length));
      const sx = t.tx * d;
      const sz = t.tz * d;
      return { x: p.x - sz * lat, z: p.z + sx * lat, tx: sx, tz: sz, y: r.heightAt(clamp(s, 0, r.length)) };
    };
    const hw = r.spec.oneWay ? r.hw : r.hw - r.spec.median / 2;
    if (i > 0) {
      // Junction curve from the previous road's end to this road's start.
      const a = legs[i - 1].end;
      const b = at(s0);
      const gap = Math.hypot(b.x - a.x, b.z - a.z);
      const k = gap * 0.42;
      const c1 = { x: a.x + a.tx * k, z: a.z + a.tz * k };
      const c2 = { x: b.x - b.tx * k, z: b.z - b.tz * k };
      const m = Math.max(3, Math.ceil(gap / 3));
      for (let j = 1; j < m; j++) {
        const u = j / m;
        const w = 1 - u;
        pts.push({
          x: w * w * w * a.x + 3 * w * w * u * c1.x + 3 * w * u * u * c2.x + u * u * u * b.x,
          z: w * w * w * a.z + 3 * w * w * u * c1.z + 3 * w * u * u * c2.z + u * u * u * b.z,
        });
        ys.push(a.y + (b.y - a.y) * u);
        hws.push(Math.max(hw, hws[hws.length - 1] ?? hw) + 4);
      }
    }
    for (let k = 0; k <= n; k++) {
      const p = at(s0 + ((s1 - s0) * k) / n);
      pts.push({ x: p.x, z: p.z });
      ys.push(p.y);
      hws.push(hw);
    }
    legs.push({ start: at(s0), end: at(s1) });
  });
  if (def.kind === "circuit") {
    // Close the loop through the start junction.
    const a = legs[legs.length - 1].end;
    const b = legs[0].start;
    const gap = Math.hypot(b.x - a.x, b.z - a.z);
    const k = gap * 0.42;
    const m = Math.max(3, Math.ceil(gap / 3));
    for (let j = 1; j <= m; j++) {
      const u = j / m;
      const w = 1 - u;
      const c1 = { x: a.x + a.tx * k, z: a.z + a.tz * k };
      const c2 = { x: b.x - b.tx * k, z: b.z - b.tz * k };
      pts.push({
        x: w * w * w * a.x + 3 * w * w * u * c1.x + 3 * w * u * u * c2.x + u * u * u * b.x,
        z: w * w * w * a.z + 3 * w * w * u * c1.z + 3 * w * u * u * c2.z + u * u * u * b.z,
      });
      ys.push(a.y + (b.y - a.y) * u);
      hws.push(hws[hws.length - 1] + 4);
    }
  }
  const line = new Polyline(pts);
  // Gates: every ~120 m, at sharp turns, and at the end.
  const gates: Gate[] = [];
  const addGate = (s: number) => {
    const p = line.sample(s);
    const t = line.tangent(s);
    const i = line.segmentAt(s);
    gates.push({ x: p.x, z: p.z, y: ys[Math.min(ys.length - 1, i)], hx: t.tx, hz: t.tz, hw: Math.max(6, hws[Math.min(hws.length - 1, i)] + 1.5), s });
  };
  let last = 0;
  const startS = 30; // first gate just past the grid
  addGate(startS);
  last = startS;
  for (let s = startS + 20; s < line.length - 25; s += 10) {
    const a = line.tangent(Math.max(0, s - 10));
    const b = line.tangent(Math.min(line.length, s + 10));
    const turn = Math.abs(wrapAngle(Math.atan2(b.tx, b.tz) - Math.atan2(a.tx, a.tz)));
    if (s - last > 120 || (turn > 0.5 && s - last > 45)) {
      addGate(s);
      last = s;
    }
  }
  // Finish gate (for circuits, the start/finish line at the end of the lap).
  addGate(def.kind === "circuit" ? line.length - 2 : line.length - 4);
  // Start grid: two rows of two, behind the start line (s = 6), staggered.
  const grid: Route["grid"] = [];
  for (let k = 0; k < 4; k++) {
    const s = clamp(16 - Math.floor(k / 2) * 9, 1, line.length);
    const p = line.sample(s);
    const t = line.tangent(s);
    const side = (k % 2 ? 1 : -1) * 2.1;
    grid.push({ x: p.x - t.tz * side, z: p.z + t.tx * side, y: ys[Math.min(ys.length - 1, line.segmentAt(s))], heading: Math.atan2(t.tx, t.tz) });
  }
  return { line, y: ys, gates, grid, length: line.length, closed: def.kind === "circuit" };
}

/** True if a car moving from (ax,az) to (bx,bz) crossed the gate in its driving direction. */
export function crossedGate(g: Gate, ax: number, az: number, bx: number, bz: number): boolean {
  const da = (ax - g.x) * g.hx + (az - g.z) * g.hz;
  const db = (bx - g.x) * g.hx + (bz - g.z) * g.hz;
  if (!(da < 0 && db >= 0)) return false;
  // Where along the gate line did it cross?
  const f = da / (da - db);
  const cx = ax + (bx - ax) * f;
  const cz = az + (bz - az) * f;
  const lat = Math.abs((cx - g.x) * -g.hz + (cz - g.z) * g.hx);
  return lat <= g.hw;
}

// ---- racers ------------------------------------------------------------------------

export interface Racer {
  id: string;
  name: string;
  /** The player has no physics here (the game owns it); rivals do. */
  phys: CarPhysics | null;
  player: boolean;
  /** Gates passed in total (laps x gates + current). */
  passed: number;
  lap: number;
  finished: boolean;
  finishTime: number;
  /** Last position (to detect gate crossings). */
  px: number;
  pz: number;
  /** Rival AI: cursor along the racing line, skill, stuck timer. */
  cursor: number;
  skill: number;
  stuck: number;
  reversing: number;
  /** Lateral offset from the racing line this rival prefers (spreads the pack). */
  laneBias: number;
  ctl: Controls;
}

export type RaceState = "countdown" | "racing" | "finished";

export interface RaceEvent {
  type: "go" | "checkpoint" | "lap" | "finish" | "wrong-way" | "back-on-track" | "rival-finished";
  racer?: Racer;
  position?: number;
  time?: number;
}

export const COUNTDOWN = 3;

/** One running race. */
export class Race {
  readonly route: Route;
  readonly racers: Racer[] = [];
  state: RaceState = "countdown";
  /** Seconds since GO (negative during the countdown). */
  time = -COUNTDOWN;
  /** Seconds the player has been heading away from the next gate. */
  wrongWay = 0;
  private wrongShown = false;
  private finishOrder: Racer[] = [];

  constructor(
    readonly def: RaceDef,
    readonly net: RoadNetwork,
    readonly world: World,
    rivalDefs: CarDef[],
    playerName: string,
  ) {
    this.route = buildRoute(net, def);
    const g = this.route.grid;
    // The player starts at the back of the grid (like NFS), rivals ahead.
    rivalDefs.forEach((d, i) => {
      const slot = g[i];
      const phys = new CarPhysics(d);
      phys.place(slot.x, slot.z, slot.heading, world.ground(slot.x, slot.z, slot.y + 0.5));
      this.racers.push({
        id: `rival-${i}`,
        name: d.name,
        phys,
        player: false,
        passed: 0,
        lap: 1,
        finished: false,
        finishTime: 0,
        px: slot.x,
        pz: slot.z,
        cursor: 0,
        skill: clamp(def.skill + (i - 1) * 0.07, 0.2, 1),
        stuck: 0,
        reversing: 0,
        laneBias: (i - 1) * 1.1,
        ctl: { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false },
      });
    });
    const ps = g[Math.min(g.length - 1, rivalDefs.length)];
    this.racers.push({
      id: "player",
      name: playerName,
      phys: null,
      player: true,
      passed: 0,
      lap: 1,
      finished: false,
      finishTime: 0,
      px: ps.x,
      pz: ps.z,
      cursor: 0,
      skill: 0,
      stuck: 0,
      reversing: 0,
      laneBias: 0,
      ctl: { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false },
    });
  }

  /** The player's grid slot (the game places the player car here). */
  get playerStart(): { x: number; z: number; y: number; heading: number } {
    return this.route.grid[Math.min(this.route.grid.length - 1, this.racers.length - 1)];
  }

  get player(): Racer {
    return this.racers.find((r) => r.player)!;
  }

  get gatesPerLap(): number {
    return this.route.gates.length;
  }

  get totalGates(): number {
    return this.gatesPerLap * this.def.laps;
  }

  /** The gate a racer must pass next. */
  nextGate(r: Racer): Gate {
    return this.route.gates[r.passed % this.gatesPerLap];
  }

  /** Race positions, leader first. */
  standings(px: number, pz: number): Racer[] {
    const progress = (r: Racer) => {
      if (r.finished) return 1e9 - r.finishTime;
      const g = this.nextGate(r);
      const x = r.player ? px : r.phys!.x;
      const z = r.player ? pz : r.phys!.z;
      return r.passed * 1e4 - Math.hypot(g.x - x, g.z - z);
    };
    return [...this.racers].sort((a, b) => progress(b) - progress(a));
  }

  positionOf(r: Racer, px: number, pz: number): number {
    return this.standings(px, pz).indexOf(r) + 1;
  }

  /**
   * Advances the race. `player` is the player's car (moved by the game);
   * rivals are stepped here at `dt` with physics sub-steps.
   */
  step(dt: number, player: CarPhysics, traffic: Traffic | null): RaceEvent[] {
    const ev: RaceEvent[] = [];
    const before = this.time;
    this.time += dt;
    if (this.state === "countdown") {
      if (this.time >= 0) {
        this.state = "racing";
        ev.push({ type: "go" });
      } else {
        // Rivals hold on the grid (brakes on) during the countdown.
        for (const r of this.racers) if (r.phys) r.phys.step(dt, { throttle: 0, brake: 0, steer: 0, handbrake: true, nitro: false }, this.world);
        return ev;
      }
    }
    void before;
    // Rivals.
    const sub = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / sub;
    for (const r of this.racers) {
      if (!r.phys) continue;
      if (r.finished) {
        // Cruise to a stop past the line.
        r.ctl = { throttle: 0, brake: r.phys.vLong > 1 ? 0.4 : 0, steer: 0, handbrake: r.phys.vLong <= 1, nitro: false };
      } else r.ctl = this.drive(r, player, traffic, dt);
      for (let k = 0; k < sub; k++) r.phys.step(h, r.ctl, this.world);
    }
    // Car-to-car contact between racers (player included): rubs slide, crashes bounce.
    const cars = this.racers.map((r) => (r.player ? player : r.phys!));
    for (let i = 0; i < cars.length; i++) for (let k = i + 1; k < cars.length; k++) resolveCars(cars[i], cars[k]);
    // Rivals vs traffic.
    if (traffic) {
      for (const r of this.racers) {
        if (!r.phys) continue;
        const c = r.phys;
        const tev = traffic.collide({ x: c.x, z: c.z, vx: c.vx, vz: c.vz, heading: c.heading, radius: c.radius, length: c.def.body.length, width: c.def.body.width });
        for (const rb of tev.rubs) {
          c.x += rb.nx * rb.depth;
          c.z += rb.nz * rb.depth;
          const vn = c.vx * rb.nx + c.vz * rb.nz;
          if (vn < 0) {
            c.vx -= vn * rb.nx;
            c.vz -= vn * rb.nz;
          }
        }
        for (const hit of tev.hits) {
          const k = 1 - 0.25 * clamp(hit.impact / 25, 0, 1);
          c.vx *= k;
          c.vz *= k;
        }
      }
    }
    // Gates, laps, finish.
    for (const r of this.racers) {
      if (r.finished) continue;
      const x = r.player ? player.x : r.phys!.x;
      const z = r.player ? player.z : r.phys!.z;
      const g = this.nextGate(r);
      if (crossedGate(g, r.px, r.pz, x, z) || Math.hypot(x - g.x, z - g.z) < 3) {
        r.passed++;
        const lapDone = r.passed % this.gatesPerLap === 0;
        if (r.passed >= this.totalGates) {
          r.finished = true;
          r.finishTime = this.time;
          this.finishOrder.push(r);
          ev.push({ type: r.player ? "finish" : "rival-finished", racer: r, position: this.finishOrder.length, time: this.time });
        } else if (lapDone) {
          r.lap++;
          if (r.player) ev.push({ type: "lap", racer: r, time: this.time });
        } else if (r.player) ev.push({ type: "checkpoint", racer: r, time: this.time });
      }
      r.px = x;
      r.pz = z;
    }
    // Wrong way / off route for the player.
    const pl = this.player;
    if (!pl.finished) {
      const g = this.nextGate(pl);
      const toG = Math.atan2(g.x - player.x, g.z - player.z);
      const away = Math.cos(wrapAngle(toG - player.heading)) < -0.35 && player.speed > 4;
      const far = Math.hypot(g.x - player.x, g.z - player.z) > 260;
      this.wrongWay = away || far ? this.wrongWay + dt : Math.max(0, this.wrongWay - dt * 2);
      if (this.wrongWay > 1.6 && !this.wrongShown) {
        this.wrongShown = true;
        ev.push({ type: "wrong-way" });
      } else if (this.wrongWay === 0 && this.wrongShown) {
        this.wrongShown = false;
        ev.push({ type: "back-on-track" });
      }
    }
    if (this.racers.every((r) => r.finished) || (pl.finished && this.state === "racing")) this.state = "finished";
    return ev;
  }

  /** Where to put the player back on the route (R during a race): the last gate passed. */
  resetPoint(): { x: number; z: number; y: number; heading: number } {
    const pl = this.player;
    const idx = (pl.passed - 1 + this.gatesPerLap) % this.gatesPerLap;
    const g = pl.passed === 0 ? null : this.route.gates[idx];
    if (!g) return this.playerStart;
    return { x: g.x, z: g.z, y: g.y, heading: Math.atan2(g.hx, g.hz) };
  }

  /**
   * Rival driver: pure pursuit along the racing line (offset by its lane
   * bias), braking in time for every corner within braking distance, with
   * a corner margin and top-speed share set by skill. Weaves around traffic
   * ahead. Light rubber-banding: a rival far ahead eases off a little, one
   * far behind uses everything its car has - never beyond its real limits.
   */
  private drive(r: Racer, player: CarPhysics, traffic: Traffic | null, dt: number): Controls {
    const c = r.phys!;
    const line = this.route.line;
    // Cursor: nearest point on the line, searching forward from the last one.
    const proj = line.project(c.x, c.z);
    if (proj.s > r.cursor - 30 && proj.s < r.cursor + 60) r.cursor = proj.s;
    else if (Math.abs(proj.s - r.cursor) > 60) r.cursor = proj.s;
    if (r.reversing > 0) {
      r.reversing -= dt;
      const t = line.tangent(r.cursor);
      const err = wrapAngle(Math.atan2(t.tx, t.tz) - c.heading);
      return { throttle: 0, brake: 1, steer: -Math.sign(err || 1), handbrake: false, nitro: false };
    }
    const look = 8 + c.speed * 0.45;
    let sAim = r.cursor + look;
    if (this.route.closed && sAim > line.length) sAim -= line.length;
    sAim = clamp(sAim, 0, line.length);
    const aim = line.sample(sAim);
    const at = line.tangent(sAim);
    // Spread the pack across the road a little.
    let tx = aim.x - at.tz * r.laneBias * 0.6;
    let tz = aim.z + at.tx * r.laneBias * 0.6;
    // Traffic ahead in our path: aim beside it.
    if (traffic) {
      const fx = Math.sin(c.heading);
      const fz = Math.cos(c.heading);
      let bestAlong = Infinity;
      let bestLat = 0;
      for (const t of traffic.cars) {
        if (Math.abs(t.y - c.y) > 3) continue;
        const ox = t.x - c.x;
        const oz = t.z - c.z;
        const along = ox * fx + oz * fz;
        if (along < 2 || along > 18 + c.speed * 1.2 || along > bestAlong) continue;
        const lat = -ox * fz + oz * fx;
        if (Math.abs(lat) > t.model.width / 2 + c.def.body.width / 2 + 0.6) continue;
        bestAlong = along;
        bestLat = lat;
      }
      if (bestAlong < Infinity) {
        const side = bestLat < -0.2 ? 1 : -1;
        const lat = bestLat + side * 3.0;
        tx = c.x + fx * bestAlong - fz * lat;
        tz = c.z + fz * bestAlong + fx * lat;
      }
    }
    const err = wrapAngle(Math.atan2(tx - c.x, tz - c.z) - c.heading);
    // Corner speed limit over the braking distance ahead.
    const margin = 0.62 + r.skill * 0.3; // share of the car's cornering grip used
    const aLat = c.def.handling.cornering * margin;
    const brakeA = c.def.handling.brake * (0.6 + r.skill * 0.25);
    const vTop = c.vmax * (0.9 + r.skill * 0.1);
    let vAllowed = vTop;
    const reach = (c.speed * c.speed) / (2 * brakeA) + 25;
    for (let d = 5; d < reach; d += 6) {
      let s = r.cursor + d;
      if (this.route.closed && s > line.length) s -= line.length;
      if (s > line.length - 1) break;
      const a = line.tangent(Math.max(0, s - 6));
      const b = line.tangent(Math.min(line.length, s + 6));
      const dh = Math.abs(wrapAngle(Math.atan2(b.tx, b.tz) - Math.atan2(a.tx, a.tz)));
      if (dh < 0.04) continue;
      const radius = 12 / dh;
      const vc = Math.sqrt(aLat * radius);
      vAllowed = Math.min(vAllowed, Math.sqrt(vc * vc + 2 * brakeA * Math.max(0, d - 4)));
    }
    // Light catch-up (within the car's real limits): ease off when far ahead of the player.
    const pAhead = this.progressOf(r) - this.progressOfPlayer(player);
    if (pAhead > 150) vAllowed = Math.min(vAllowed, Math.max(25, player.speed * 0.95 + 4));
    const v = c.vLong;
    const throttle = v < vAllowed - 0.3 ? 1 : 0;
    const brake = v > vAllowed + 1.2 ? clamp((v - vAllowed) / 4, 0.3, 1) : 0;
    const steer = clamp(err * 2.2, -1, 1);
    // Stuck: back out.
    r.stuck = throttle > 0 && c.speed < 1.2 && this.time > 2 ? r.stuck + dt : 0;
    if (r.stuck > 1.3) {
      r.stuck = 0;
      r.reversing = 1.0;
    }
    // Nitro on long straights for good drivers.
    const nitro = r.skill > 0.55 && Math.abs(err) < 0.06 && vAllowed > v + 8 && v > 20;
    return { throttle, brake, steer, handbrake: false, nitro };
  }

  private progressOf(r: Racer): number {
    return r.passed * 1e3 - (r.phys ? Math.hypot(this.nextGate(r).x - r.phys.x, this.nextGate(r).z - r.phys.z) : 0);
  }

  private progressOfPlayer(p: CarPhysics): number {
    const pl = this.player;
    return pl.passed * 1e3 - Math.hypot(this.nextGate(pl).x - p.x, this.nextGate(pl).z - p.z);
  }

  /** Plain data for tests / HUD. */
  snapshot(px: number, pz: number) {
    return {
      id: this.def.id,
      state: this.state,
      time: this.time,
      lap: this.player.lap,
      laps: this.def.laps,
      passed: this.player.passed,
      gates: this.totalGates,
      position: this.positionOf(this.player, px, pz),
      racers: this.racers.length,
      finished: this.racers.filter((r) => r.finished).map((r) => ({ name: r.name, time: r.finishTime, player: r.player })),
    };
  }
}

// ---- speed cameras + traps -------------------------------------------------------------

export interface SpeedEventState {
  def: CameraDef;
  /** Gates: the camera line, or trap start/end lines (both directions count). */
  a: { x: number; z: number; tx: number; tz: number; hw: number; y: number };
  b: { x: number; z: number; tx: number; tz: number; hw: number; y: number } | null;
  /** Trap in progress: entry time and distance tracker. */
  inTrap: boolean;
  trapT: number;
  trapDist: number;
  trapDir: number;
}

export interface SpeedResult {
  def: CameraDef;
  kmh: number;
  medal: Medal;
}

/** Watches the player's car for speed camera flashes and speed-trap runs. */
export class SpeedEvents {
  readonly events: SpeedEventState[];
  private lx = 0;
  private lz = 0;
  private started = false;

  constructor(net: RoadNetwork) {
    this.events = SPEED_EVENTS.map((def) => {
      const r = net.road(def.road);
      const mk = (t: number) => {
        const s = r.s0 + (r.s1 - r.s0) * t;
        const p = r.center.sample(s);
        const tg = r.center.tangent(s);
        return { x: p.x, z: p.z, tx: tg.tx, tz: tg.tz, hw: r.hw + 1, y: r.heightAt(s) };
      };
      return { def, a: mk(def.t), b: def.t2 !== undefined ? mk(def.t2) : null, inTrap: false, trapT: 0, trapDist: 0, trapDir: 0 };
    });
  }

  /** Call every physics step with the player's position and speed (m/s). */
  update(x: number, z: number, y: number, speed: number, dt: number): SpeedResult[] {
    const out: SpeedResult[] = [];
    if (!this.started) {
      this.lx = x;
      this.lz = z;
      this.started = true;
      return out;
    }
    const cross = (g: SpeedEventState["a"]): number => {
      if (Math.abs(y - g.y) > 5) return 0;
      const da = (this.lx - g.x) * g.tx + (this.lz - g.z) * g.tz;
      const db = (x - g.x) * g.tx + (z - g.z) * g.tz;
      // Half-open crossing test: from strictly behind the line to on/beyond it
      // (either direction). Landing exactly on the line then leaving it is
      // ONE crossing, not two.
      const fwd = da < 0 && db >= 0;
      const back = da > 0 && db <= 0;
      if (!fwd && !back) return 0;
      const f = da / (da - db);
      const cx = this.lx + (x - this.lx) * f;
      const cz = this.lz + (z - this.lz) * f;
      if (Math.abs((cx - g.x) * -g.tz + (cz - g.z) * g.tx) > g.hw) return 0;
      return fwd ? 1 : -1;
    };
    for (const e of this.events) {
      if (e.def.kind === "camera") {
        if (cross(e.a) !== 0) {
          const kmh = speed * KMH;
          out.push({ def: e.def, kmh, medal: medalFor(kmh, e.def.targets) });
        }
        continue;
      }
      // Trap: enter at either end, exit at the other, average speed = distance / time.
      if (!e.inTrap) {
        const ca = cross(e.a);
        const cb = e.b ? cross(e.b) : 0;
        if (ca !== 0 || cb !== 0) {
          e.inTrap = true;
          e.trapT = 0;
          e.trapDist = 0;
          e.trapDir = ca !== 0 ? 1 : -1; // 1 = entered at a, must exit at b
        }
      } else {
        e.trapT += dt;
        e.trapDist += Math.hypot(x - this.lx, z - this.lz);
        const exit = e.trapDir > 0 ? (e.b ? cross(e.b) : 0) : cross(e.a);
        const back = e.trapDir > 0 ? cross(e.a) : e.b ? cross(e.b) : 0;
        if (exit !== 0) {
          e.inTrap = false;
          const kmh = (e.trapDist / Math.max(0.01, e.trapT)) * KMH;
          out.push({ def: e.def, kmh, medal: medalFor(kmh, e.def.targets) });
        } else if (back !== 0 || e.trapT > 120) e.inTrap = false; // turned back / gave up
      }
    }
    this.lx = x;
    this.lz = z;
    return out;
  }

  /** Teleports (resets) must not count as crossings. */
  reset(x: number, z: number): void {
    this.lx = x;
    this.lz = z;
    for (const e of this.events) e.inTrap = false;
  }

  /** The trap the player is currently inside (for the HUD), if any. */
  activeTrap(): SpeedEventState | null {
    return this.events.find((e) => e.inTrap) ?? null;
  }
}

/** Start point of a race (for the map and the "press E to race" marker). */
export function raceStart(net: RoadNetwork, def: RaceDef): { x: number; z: number; y: number; heading: number } {
  const g = buildRoute(net, def).grid;
  return g[g.length - 1];
}

export type { Road };
