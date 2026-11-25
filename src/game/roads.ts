/**
 * Road network: turns the authored map into smooth road centrelines,
 * junctions, an elevation profile per road, and the lane graph that traffic
 * drives on (lanes + junction connectors with turn type, signal group,
 * yield rule and conflict list). Pure data - no rendering - so it can be
 * unit-tested.
 */

import { catmullRom, Polyline, segmentsIntersect, type V2 } from "../core/geom";
import { clamp, wrapAngle } from "../core/math";
import { NODES, ROADS, ROAD_CLASSES, roadWidth, toWorld, type JunctionKind, type NodeDef, type RoadClass, type RoadClassSpec, type RoadDef } from "./mapdata";

export type Turn = "left" | "straight" | "right" | "uturn";

export interface LaneSeg {
  id: number;
  kind: "lane" | "conn";
  poly: Polyline;
  length: number;
  /** Free-flow speed, m/s. */
  speed: number;
  next: LaneSeg[];
  /** Lanes: owning road, direction (+1 = from->to) and index (0 = innermost). */
  road: Road | null;
  dir: 1 | -1;
  index: number;
  startNode: RNode | null;
  endNode: RNode | null;
  /** Connectors: junction, source lane, target lane, manoeuvre. */
  node: RNode | null;
  from: LaneSeg | null;
  to: LaneSeg | null;
  turn: Turn;
  /** Signal group of the approach (-1 = not signalised). */
  group: number;
  /** Must give way to non-yielding conflicting connectors. */
  yields: boolean;
  conflicts: LaneSeg[];
}

export interface RoadEnd {
  road: Road;
  atStart: boolean;
  /** Unit direction pointing from the node into the road. */
  dx: number;
  dz: number;
  angle: number;
}

export interface RNode {
  id: string;
  def: NodeDef;
  x: number;
  z: number;
  kind: JunctionKind;
  ends: RoadEnd[];
  radius: number;
  elev: number;
  /** Number of signal groups (signals only). */
  groups: number;
  /** Phase offset in seconds, so junctions are not synchronised. */
  offset: number;
  label?: string;
}

export class Road {
  readonly id: string;
  readonly name: string;
  readonly cls: RoadClass;
  readonly spec: RoadClassSpec;
  readonly center: Polyline;
  /** Half width of the carriageway (shoulder edge to shoulder edge). */
  readonly hw: number;
  /** Sidewalk width each side (0 = none). */
  readonly sidewalk: number;
  s0 = 0;
  s1 = 0;
  elev: Float64Array;
  lanesFwd: LaneSeg[] = [];
  lanesBwd: LaneSeg[] = [];
  /** Arc-length ranges where the road crosses water (bridges). */
  bridges: [number, number][] = [];

  constructor(
    readonly def: RoadDef,
    readonly from: RNode,
    readonly to: RNode,
  ) {
    this.id = def.id;
    this.name = def.name;
    this.cls = def.cls;
    this.spec = ROAD_CLASSES[def.cls];
    this.hw = roadWidth(def.cls) / 2;
    this.sidewalk = this.spec.sidewalk ? 4 : 0;
    const pts: V2[] = [{ x: from.x, z: from.z }, ...def.via.map(([e, n]) => toWorld(e, n)), { x: to.x, z: to.z }];
    this.center = new Polyline(catmullRom(pts, 4));
    this.elev = new Float64Array(this.center.n);
  }

  get length(): number {
    return this.center.length;
  }

  heightAt(s: number): number {
    const c = this.center;
    const i = c.segmentAt(s);
    const L = c.s[i + 1] - c.s[i];
    const f = L > 0 ? clamp((s - c.s[i]) / L, 0, 1) : 0;
    return this.elev[i] + (this.elev[i + 1] - this.elev[i]) * f;
  }

  isBridge(s: number): boolean {
    for (const [a, b] of this.bridges) if (s >= a && s <= b) return true;
    return false;
  }

  /** Lateral offset (right of the forward direction) of lane `i` travelling `dir`. */
  laneOffset(i: number): number {
    const k = this.spec;
    if (k.oneWay) return -(k.lanes * k.laneWidth) / 2 + (i + 0.5) * k.laneWidth;
    return k.median / 2 + (i + 0.5) * k.laneWidth;
  }
}

/** Class rank used to decide right of way at priority junctions. */
const RANK: Record<RoadClass, number> = { freeway: 6, ring: 5, boulevard: 4, coast: 4, avenue: 3, mountain: 2, street: 1 };

export interface NetworkOptions {
  /** Natural ground height (without water carving) used for road profiles. */
  height: (x: number, z: number) => number;
  /** Distance to open water (river/lake), for bridge detection. */
  waterDistance: (x: number, z: number) => number;
  seed?: number;
}

export class RoadNetwork {
  readonly nodes = new Map<string, RNode>();
  readonly roads: Road[] = [];
  readonly segs: LaneSeg[] = [];
  readonly lanes: LaneSeg[] = [];
  readonly conns: LaneSeg[] = [];
  private hash = new Map<number, [Road, number][]>();
  private readonly cell = 32;

  constructor(opts: NetworkOptions) {
    let k = 0;
    for (const d of NODES) {
      const w = toWorld(d.e, d.n);
      this.nodes.set(d.id, {
        id: d.id,
        def: d,
        x: w.x,
        z: w.z,
        kind: d.kind,
        ends: [],
        radius: 10,
        elev: 0,
        groups: 0,
        offset: ((k++ * 7.31) % 21) + (opts.seed ?? 0) * 0,
        label: d.label,
      });
    }
    for (const def of ROADS) {
      const from = this.nodes.get(def.from);
      const to = this.nodes.get(def.to);
      if (!from || !to) throw new Error(`Road ${def.id} references a missing node`);
      const road = new Road(def, from, to);
      this.roads.push(road);
      const c = road.center;
      const a = c.sample(Math.min(10, c.length / 3));
      const b = c.sample(Math.max(c.length - 10, (2 * c.length) / 3));
      const d0 = norm(a.x - from.x, a.z - from.z);
      const d1 = norm(b.x - to.x, b.z - to.z);
      from.ends.push({ road, atStart: true, dx: d0.x, dz: d0.z, angle: Math.atan2(d0.z, d0.x) });
      to.ends.push({ road, atStart: false, dx: d1.x, dz: d1.z, angle: Math.atan2(d1.z, d1.x) });
    }
    for (const n of this.nodes.values()) this.junctionRadius(n);
    for (const r of this.roads) {
      r.s0 = Math.min(r.from.radius, r.length * 0.45);
      r.s1 = Math.max(r.length - r.to.radius, r.length * 0.55);
    }
    this.elevations(opts);
    this.findBridges(opts);
    this.buildLanes();
    this.buildConnectors();
    this.indexSegments();
  }

  // ---------------------------------------------------------------------------

  private junctionRadius(n: RNode): void {
    const ends = [...n.ends].sort((a, b) => a.angle - b.angle);
    let r = 0;
    for (const e of ends) r = Math.max(r, e.road.hw + 2);
    if (ends.length === 1) {
      n.radius = ends[0].road.hw + 6;
      return;
    }
    for (let i = 0; i < ends.length; i++) {
      const a = ends[i];
      const b = ends[(i + 1) % ends.length];
      let d = b.angle - a.angle;
      if (d <= 0) d += Math.PI * 2;
      if (ends.length === 2 && d > Math.PI) continue;
      const w = Math.max(a.road.hw + a.road.sidewalk * 0.5, b.road.hw + b.road.sidewalk * 0.5) + 1;
      const need = w / Math.tan(Math.min(d, Math.PI * 0.94) / 2);
      r = Math.max(r, need);
    }
    n.radius = clamp(r, 8, 42);
  }

  private elevations(opts: NetworkOptions): void {
    for (const n of this.nodes.values()) {
      let sum = 0;
      let cnt = 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          sum += opts.height(n.x + dx * 12, n.z + dz * 12);
          cnt++;
        }
      }
      n.elev = sum / cnt;
    }
    // Pull junction heights together where a road between them would be too
    // steep (keeps every road within its grade limit).
    for (let pass = 0; pass < 30; pass++) {
      let changed = false;
      for (const r of this.roads) {
        const g = r.cls === "mountain" ? 0.14 : 0.085;
        const usable = Math.max(10, r.length - r.from.radius - r.to.radius - 50);
        const d = r.to.elev - r.from.elev;
        const max = g * usable;
        if (Math.abs(d) > max) {
          const fix = (Math.abs(d) - max) / 2 + 0.01;
          const sgn = Math.sign(d);
          r.from.elev += sgn * fix;
          r.to.elev -= sgn * fix;
          changed = true;
        }
      }
      if (!changed) break;
    }
    for (const r of this.roads) {
      const c = r.center;
      const raw = new Float64Array(c.n);
      for (let i = 0; i < c.n; i++) raw[i] = opts.height(c.x[i], c.z[i]);
      // Two passes of a ~60 m moving average.
      let sm = raw;
      for (let pass = 0; pass < 3; pass++) {
        const out = new Float64Array(c.n);
        for (let i = 0; i < c.n; i++) {
          let s = 0;
          let w = 0;
          for (let j = Math.max(0, i - 8); j <= Math.min(c.n - 1, i + 8); j++) {
            s += sm[j];
            w++;
          }
          out[i] = s / w;
        }
        sm = out;
      }
      const L = c.length;
      const d0 = r.from.elev - sm[0];
      const d1 = r.to.elev - sm[c.n - 1];
      for (let i = 0; i < c.n; i++) {
        const s = c.s[i];
        let h = sm[i] + d0 + (d1 - d0) * (s / L);
        // Flat inside the junction disc, then blend over 25 m.
        const ra = r.from.radius;
        const rb = r.to.radius;
        if (s < ra + 25) h = lerpN(r.from.elev, h, clamp((s - ra) / 25, 0, 1));
        if (L - s < rb + 25) h = lerpN(r.to.elev, h, clamp((L - s - rb) / 25, 0, 1));
        r.elev[i] = h;
      }
      // Pin the profile to the junction height inside each junction disc,
      // then limit the grade (which keeps pinned endpoints fixed).
      const ra = r.from.radius;
      const rb = r.to.radius;
      for (let i = 0; i < c.n; i++) {
        if (c.s[i] <= ra) r.elev[i] = r.from.elev;
        if (L - c.s[i] <= rb) r.elev[i] = r.to.elev;
      }
      limitGradePinned(r.elev, c.s, r.cls === "mountain" ? 0.15 : 0.1, ra, L - rb);
    }
  }

  private findBridges(opts: NetworkOptions): void {
    for (const r of this.roads) {
      let start = -1;
      const step = 2;
      for (let s = 0; s <= r.length; s += step) {
        const p = r.center.sample(s);
        const wet = opts.waterDistance(p.x, p.z) < r.hw + 6;
        if (wet && start < 0) start = s;
        if (!wet && start >= 0) {
          r.bridges.push([Math.max(0, start - 8), Math.min(r.length, s + 8)]);
          start = -1;
        }
      }
      if (start >= 0) r.bridges.push([start - 8, r.length]);
    }
  }

  private newSeg(kind: "lane" | "conn", poly: Polyline, speed: number): LaneSeg {
    const s: LaneSeg = {
      id: this.segs.length,
      kind,
      poly,
      length: poly.length,
      speed,
      next: [],
      road: null,
      dir: 1,
      index: 0,
      startNode: null,
      endNode: null,
      node: null,
      from: null,
      to: null,
      turn: "straight",
      group: -1,
      yields: false,
      conflicts: [],
    };
    this.segs.push(s);
    return s;
  }

  private buildLanes(): void {
    for (const r of this.roads) {
      const k = r.spec;
      for (let i = 0; i < k.lanes; i++) {
        const off = r.laneOffset(i);
        const f = this.newSeg("lane", new Polyline(r.center.offsetRange(off, r.s0, r.s1)), k.speed);
        f.road = r;
        f.dir = 1;
        f.index = i;
        f.startNode = r.from;
        f.endNode = r.to;
        r.lanesFwd.push(f);
        this.lanes.push(f);
        if (!k.oneWay) {
          const rev = r.center.reversed();
          const L = r.length;
          const b = this.newSeg("lane", new Polyline(rev.offsetRange(off, L - r.s1, L - r.s0)), k.speed);
          b.road = r;
          b.dir = -1;
          b.index = i;
          b.startNode = r.to;
          b.endNode = r.from;
          r.lanesBwd.push(b);
          this.lanes.push(b);
        }
      }
    }
  }

  /** Lanes arriving at / leaving node n, grouped by road direction. */
  private approaches(n: RNode): { incoming: LaneSeg[][]; outgoing: LaneSeg[][] } {
    const incoming: LaneSeg[][] = [];
    const outgoing: LaneSeg[][] = [];
    for (const e of n.ends) {
      const r = e.road;
      if (e.atStart) {
        if (r.lanesFwd.length) outgoing.push(r.lanesFwd);
        if (r.lanesBwd.length) incoming.push(r.lanesBwd);
      } else {
        if (r.lanesFwd.length) incoming.push(r.lanesFwd);
        if (r.lanesBwd.length) outgoing.push(r.lanesBwd);
      }
    }
    return { incoming, outgoing };
  }

  private buildConnectors(): void {
    for (const n of this.nodes.values()) {
      const { incoming, outgoing } = this.approaches(n);
      // Signal groups by approach axis.
      const axisOf = (lanes: LaneSeg[]): number => {
        const p = lanes[0].poly;
        const t = p.tangent(p.length);
        return Math.atan2(t.tz, t.tx);
      };
      const groupOf = new Map<LaneSeg[], number>();
      if (n.kind === "signal" && incoming.length >= 2) {
        const ref = axisOf(incoming[0]);
        for (const inc of incoming) {
          const d = Math.abs(wrapAngle(2 * (axisOf(inc) - ref))) / 2;
          groupOf.set(inc, d < Math.PI / 4 ? 0 : 1);
        }
        n.groups = new Set(groupOf.values()).size;
        if (n.groups < 2) n.groups = 1;
      }
      const maxRank = Math.max(...n.ends.map((e) => (e.road.def.main ? 10 : RANK[e.road.cls])));
      const local: LaneSeg[] = [];
      for (const inc of incoming) {
        const road = inc[0].road!;
        const options = outgoing.filter((o) => o[0].road !== road);
        const targets = options.length ? options : outgoing;
        for (const out of targets) {
          const a = inc[0].poly;
          const b = out[0].poly;
          const ta = a.tangent(a.length);
          const tb = b.tangent(0);
          const ang = wrapAngle(Math.atan2(tb.tx, tb.tz) - Math.atan2(ta.tx, ta.tz));
          const uturn = out[0].road === road;
          // Continuing on the same named road (a freeway bend, a ring) is
          // "straight" whatever the angle, so every lane carries on.
          const sameName = out[0].road!.name === road.name && n.kind !== "roundabout";
          const turn: Turn = uturn ? "uturn" : sameName || Math.abs(ang) < 0.6 ? "straight" : ang > 0 ? "left" : "right";
          const m = inc.length;
          const kk = out.length;
          const pairs: [number, number][] = [];
          // Turns go from the outer (right) / inner (left) lane into ANY lane
          // of the target road, so every lane of every road is reachable.
          // On multi-lane roads the lane next to the turning lane may also
          // turn (it represents a late lane change), so no lane is a trap.
          if (turn === "right") for (let j = 0; j < kk; j++) for (const i of m > 2 ? [m - 1, m - 2] : [m - 1]) pairs.push([i, j]);
          else if (turn === "left" || turn === "uturn") for (let j = 0; j < kk; j++) for (const i of m > 2 ? [0, 1] : [0]) pairs.push([i, j]);
          else for (let i = 0; i < m; i++) pairs.push([i, Math.min(i, kk - 1)]);
          // Lanes that would otherwise have nowhere to go also get this exit
          // when it is the closest thing to straight on.
          pairs.push(...extraPairs(inc, out, turn, pairs));
          for (const [i, j] of pairs) {
            const from = inc[i];
            const to = out[j];
            if (from.next.some((c) => c.to === to)) continue;
            const poly = bezier(from.poly, to.poly, turn === "uturn");
            let kmax = 0;
            for (let v = 1; v < poly.n - 1; v++) kmax = Math.max(kmax, Math.abs(poly.curvature(v)));
            const vCurve = kmax > 1e-4 ? Math.sqrt(3.2 / kmax) : 99;
            const c = this.newSeg("conn", poly, Math.max(4, Math.min(from.speed, to.speed, vCurve)));
            c.node = n;
            c.from = from;
            c.to = to;
            c.turn = turn;
            c.next = [to];
            from.next.push(c);
            c.group = groupOf.get(inc) ?? -1;
            const rank = road.def.main ? 10 : RANK[road.cls];
            if (n.kind === "roundabout") c.yields = road.cls !== "ring";
            else if (n.kind === "priority") c.yields = rank < maxRank;
            else if (n.kind === "signal") c.yields = turn === "left" || turn === "uturn" || n.groups < 2;
            this.conns.push(c);
            local.push(c);
          }
        }
        // Guarantee: every incoming lane leads somewhere.
        for (let i = 0; i < inc.length; i++) {
          const lane = inc[i];
          if (lane.next.length > 0) continue;
          const sib = inc.find((l) => l.next.length > 0);
          if (!sib) continue;
          for (const c0 of sib.next) {
            const poly = bezier(lane.poly, c0.to!.poly, c0.turn === "uturn");
            const c = this.newSeg("conn", poly, c0.speed);
            Object.assign(c, { node: n, from: lane, to: c0.to, turn: c0.turn, next: [c0.to!], group: c0.group, yields: c0.yields });
            lane.next.push(c);
            this.conns.push(c);
            local.push(c);
          }
        }
      }
      // Conflicts: crossing paths or merging into the same lane.
      for (let i = 0; i < local.length; i++) {
        for (let j = i + 1; j < local.length; j++) {
          const a = local[i];
          const b = local[j];
          if (a.from === b.from) continue;
          if (a.to === b.to || polysCross(a.poly, b.poly)) {
            a.conflicts.push(b);
            b.conflicts.push(a);
          }
        }
      }
    }
  }

  private key(ix: number, iz: number): number {
    return (ix + 4096) * 8192 + (iz + 4096);
  }

  private indexSegments(): void {
    for (const r of this.roads) {
      const c = r.center;
      const pad = r.hw + r.sidewalk + 2;
      for (let i = 0; i < c.n - 1; i++) {
        const minX = Math.min(c.x[i], c.x[i + 1]) - pad;
        const maxX = Math.max(c.x[i], c.x[i + 1]) + pad;
        const minZ = Math.min(c.z[i], c.z[i + 1]) - pad;
        const maxZ = Math.max(c.z[i], c.z[i + 1]) + pad;
        for (let ix = Math.floor(minX / this.cell); ix <= Math.floor(maxX / this.cell); ix++) {
          for (let iz = Math.floor(minZ / this.cell); iz <= Math.floor(maxZ / this.cell); iz++) {
            const k = this.key(ix, iz);
            let list = this.hash.get(k);
            if (!list) this.hash.set(k, (list = []));
            list.push([r, i]);
          }
        }
      }
    }
  }

  // ---- queries ------------------------------------------------------------------

  /** Junction disc containing (x, z), if any. */
  nodeAt(x: number, z: number): RNode | null {
    for (const n of this.nodes.values()) {
      const dx = x - n.x;
      const dz = z - n.z;
      if (dx * dx + dz * dz <= n.radius * n.radius) return n;
    }
    return null;
  }

  /**
   * The road whose carriageway (plus `extra` metres) contains (x, z):
   * returns the road, arc length and signed lateral offset.
   */
  roadAt(x: number, z: number, extra = 0): { road: Road; s: number; lat: number } | null {
    const list = this.hash.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell)));
    if (!list) return null;
    // For each road keep its CLOSEST segment (true projection: |lat| is then
    // the real distance); among roads that contain the point, prefer the one
    // whose centreline is nearest relative to its half width.
    let best: { road: Road; s: number; lat: number } | null = null;
    let bestScore = Infinity;
    const closest = new Map<Road, { s: number; lat: number; dist: number }>();
    for (const [r, i] of list) {
      const p = r.center.projectSegment(x, z, i);
      const prev = closest.get(r);
      if (!prev || p.dist < prev.dist) closest.set(r, { s: p.s, lat: p.lat, dist: p.dist });
    }
    for (const [r, p] of closest) {
      // Points beyond the road's ends project onto an endpoint: skip those.
      if (p.s <= 0.01 || p.s >= r.length - 0.01) continue;
      const over = p.dist - (r.hw + extra);
      if (over > 0) continue;
      const score = p.dist / (r.hw + extra);
      if (score < bestScore) {
        bestScore = score;
        best = { road: r, s: p.s, lat: p.lat };
      }
    }
    return best;
  }

  /** Nearest road centreline point within `radius` metres. */
  nearestRoad(x: number, z: number, radius = 60): { road: Road; s: number; lat: number; dist: number } | null {
    let best: { road: Road; s: number; lat: number; dist: number } | null = null;
    const r0 = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    const seen = new Set<string>();
    for (let ix = cx - r0; ix <= cx + r0; ix++) {
      for (let iz = cz - r0; iz <= cz + r0; iz++) {
        const list = this.hash.get(this.key(ix, iz));
        if (!list) continue;
        for (const [r, i] of list) {
          const k = `${r.id}:${i}`;
          if (seen.has(k)) continue;
          seen.add(k);
          const p = r.center.projectSegment(x, z, i);
          if (p.dist <= radius && (!best || p.dist < best.dist)) best = { road: r, s: p.s, lat: p.lat, dist: p.dist };
        }
      }
    }
    return best;
  }

  /** Surface height of the road network at (x, z), or null if not on it. */
  heightAt(x: number, z: number, includeSidewalk = true): number | null {
    const n = this.nodeAt(x, z);
    if (n) return n.elev;
    const r = this.roadAt(x, z, includeSidewalk ? 0 : 0);
    if (r) return r.road.heightAt(r.s);
    if (includeSidewalk) {
      const sw = this.roadAt(x, z, 4);
      if (sw && sw.road.sidewalk > 0 && Math.abs(sw.lat) <= sw.road.hw + sw.road.sidewalk) return sw.road.heightAt(sw.s) + CURB;
    }
    return null;
  }

  road(id: string): Road {
    const r = this.roads.find((x) => x.id === id);
    if (!r) throw new Error(`no road ${id}`);
    return r;
  }

  /** World position / heading of a point `lat` metres right of road `id` at arc length s. */
  pointOn(id: string, s: number, lat: number, reverse = false): { x: number; z: number; heading: number } {
    const r = this.road(id);
    const p = r.center.sample(s);
    const t = r.center.tangent(s);
    const sign = reverse ? -1 : 1;
    const tx = t.tx * sign;
    const tz = t.tz * sign;
    return { x: p.x - tz * lat, z: p.z + tx * lat, heading: Math.atan2(tx, tz) };
  }
}

export const CURB = 0.14;

// ---- signals ---------------------------------------------------------------------

export const SIGNAL = { green: 15, yellow: 3, allRed: 2 };

export type Light = "green" | "yellow" | "red";

/** Deterministic signal state for group g of node n at time t (seconds). */
export function signalState(n: RNode, g: number, t: number): Light {
  if (n.kind !== "signal" || n.groups < 2 || g < 0) return "green";
  const phase = SIGNAL.green + SIGNAL.yellow + SIGNAL.allRed;
  const cycle = phase * n.groups;
  const u = (((t + n.offset) % cycle) + cycle) % cycle;
  const active = Math.floor(u / phase);
  if (active !== g) return "red";
  const v = u - active * phase;
  if (v < SIGNAL.green) return "green";
  if (v < SIGNAL.green + SIGNAL.yellow) return "yellow";
  return "red";
}

// ---- helpers ---------------------------------------------------------------------

function norm(x: number, z: number): V2 {
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
}

/**
 * Like `limitGrade`, but samples inside [0, a] and [b, L] are pinned (junction
 * discs stay flat at the junction height) and only the middle is adjusted.
 */
export function limitGradePinned(h: Float64Array, s: Float64Array, g: number, a: number, b: number): void {
  const n = h.length;
  const free = (i: number) => s[i] > a && s[i] < b;
  for (let pass = 0; pass < 8; pass++) {
    for (let i = 1; i < n; i++) {
      if (!free(i)) continue;
      const d = s[i] - s[i - 1];
      h[i] = clamp(h[i], h[i - 1] - g * d, h[i - 1] + g * d);
    }
    for (let i = n - 2; i >= 0; i--) {
      if (!free(i)) continue;
      const d = s[i + 1] - s[i];
      h[i] = clamp(h[i], h[i + 1] - g * d, h[i + 1] + g * d);
    }
  }
}

/** Clamps a profile to a maximum grade, keeping both endpoints fixed. */
export function limitGrade(h: Float64Array, s: Float64Array, g: number): void {
  const n = h.length;
  for (let pass = 0; pass < 6; pass++) {
    for (let i = 1; i < n - 1; i++) {
      const d = s[i] - s[i - 1];
      h[i] = clamp(h[i], h[i - 1] - g * d, h[i - 1] + g * d);
    }
    for (let i = n - 2; i > 0; i--) {
      const d = s[i + 1] - s[i];
      h[i] = clamp(h[i], h[i + 1] - g * d, h[i + 1] + g * d);
    }
  }
}

function lerpN(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function extraPairs(inc: LaneSeg[], out: LaneSeg[], turn: Turn, have: [number, number][]): [number, number][] {
  // Roundabout entries/exits and right turns use the outer lane; let the
  // other lanes merge into it too, so no lane dead-ends at a roundabout.
  if (turn !== "right") return [];
  const node = inc[0].endNode;
  if (!node || node.kind !== "roundabout") return [];
  const extra: [number, number][] = [];
  for (let i = 0; i < inc.length; i++) if (!have.some(([a]) => a === i)) for (let j = 0; j < out.length; j++) extra.push([i, j]);
  return extra;
}

function bezier(a: Polyline, b: Polyline, uturn: boolean): Polyline {
  const p0 = a.sample(a.length);
  const p3 = b.sample(0);
  const ta = a.tangent(a.length);
  const tb = b.tangent(0);
  const d = Math.hypot(p3.x - p0.x, p3.z - p0.z);
  const k = uturn ? Math.max(8, d * 1.2) : Math.max(1, d * 0.42);
  const c1 = { x: p0.x + ta.tx * k, z: p0.z + ta.tz * k };
  const c2 = { x: p3.x - tb.tx * k, z: p3.z - tb.tz * k };
  const pts: V2[] = [];
  const n = Math.max(6, Math.ceil(d / 2.5));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push({
      x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
      z: u * u * u * p0.z + 3 * u * u * t * c1.z + 3 * u * t * t * c2.z + t * t * t * p3.z,
    });
  }
  return new Polyline(pts);
}

function polysCross(a: Polyline, b: Polyline): boolean {
  for (let i = 0; i < a.n - 1; i++) {
    for (let j = 0; j < b.n - 1; j++) {
      if (segmentsIntersect(a.x[i], a.z[i], a.x[i + 1], a.z[i + 1], b.x[j], b.z[j], b.x[j + 1], b.z[j + 1], 1e-6)) return true;
    }
  }
  return false;
}
