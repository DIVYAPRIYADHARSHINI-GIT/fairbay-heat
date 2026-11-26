/**
 * Fairbay - the hand-designed open world (replaces the Stage 1 grid city).
 *
 * Pure data, no Three.js, so it is unit-testable in Node. Builds, from the
 * authored map in `mapdata.ts`:
 *   - natural terrain (rolling land, northern hills, Mount Calder, a river
 *     valley, beaches) carved by the Fair River, a lake and the sea;
 *   - the road network (curved roads, junctions, elevation profiles, bridges);
 *   - buildings fronting the roads, oriented to the curves, per district;
 *   - lamps, trees, freeway barriers, guard rails, containers, tanks, cranes,
 *     jump ramps and kerbside jack spots;
 *   - the queries the physics and traffic use: ground height, surface type,
 *     district, nearest road.
 * Generation is fully deterministic from the seed.
 */

import { obb, obbCorners, obbOverlap, pointInOBB, pointInPolygon, pointSegmentDistance, type OBB, type V2 } from "../core/geom";
import { clamp, mulberry32, pick, range, smoothstep } from "../core/math";
import { SpatialHash, type CircleCollider, type Collider, type OBBCollider } from "./collision";
import {
  CIRCLE,
  COAST,
  DISTRICT_NAMES,
  DISTRICT_POLYS,
  LAKE,
  MOUNTAIN,
  PARK_POLY,
  RAMPS,
  RIVER,
  RIVER_HALF,
  WATER_LEVEL,
  WORLD_HALF,
  toWorld,
  type District,
} from "./mapdata";
import { CURB, RoadNetwork, type Road } from "./roads";
import type { Surface, World as PhysicsWorld } from "./physics";

export { DISTRICT_NAMES, WATER_LEVEL, WORLD_HALF, CURB };
export type { District };

export const TERRAIN_STEP = 8;

export type BuildingStyle = "glass" | "office" | "brick" | "house" | "warehouse";

export interface Tier {
  hx: number;
  hz: number;
  y0: number;
  y1: number;
}

export interface Building {
  id: number;
  style: BuildingStyle;
  color: string;
  district: District;
  /** Footprint (the collider) - x axis runs along the street frontage. */
  box: OBB;
  /** Ground height at the lowest corner (walls start here). */
  base: number;
  /** Tiers in the box's local frame, heights relative to `base`. */
  tiers: Tier[];
  pitched: boolean;
  height: number;
  rooftop: { u: number; v: number; w: number; d: number; h: number }[];
  billboard?: { w: number; h: number; color: string };
  spire?: number;
}

export interface Ramp {
  x: number;
  z: number;
  heading: number;
  width: number;
  length: number;
  height: number;
  base: number;
  label: string;
}

export interface Prop {
  x: number;
  z: number;
  y: number;
  rot: number;
  scale: number;
  collider?: CircleCollider;
}

export interface Barrier {
  box: OBB;
  y0: number;
  y1: number;
  kind: "jersey" | "rail";
}

/**
 * A column under an overpass deck (solid: cars cannot drive through it).
 * Built once here so the renderer draws exactly the columns the physics
 * knows about.
 */
export interface Pier {
  x: number;
  z: number;
  /** Axis angle of the bent (the road tangent). */
  ang: number;
  /** Ground height at the foot and height of the deck underside. */
  y0: number;
  y1: number;
}

/** A cap beam across an overpass bent (visual only - it is above the traffic). */
export interface PierCap {
  x: number;
  z: number;
  ang: number;
  /** Half length across the road. */
  half: number;
  y: number;
}

export interface Container {
  x: number;
  z: number;
  y: number;
  rot: number;
  color: string;
}

export interface Tank {
  x: number;
  z: number;
  y: number;
  r: number;
  h: number;
}

export interface Crane {
  x: number;
  z: number;
  y: number;
  rot: number;
}

export interface JackSpotPos {
  id: string;
  carId: string;
  color: number;
  where: string;
  x: number;
  z: number;
  heading: number;
}

/** Jack spots are authored against roads; positions are computed by the world. */
export interface JackSpotDef {
  id: string;
  carId: string;
  color: number;
  road: string;
  /** Fraction along the road. */
  t: number;
}

interface Region {
  p: V2;
  r: number;
}

export interface WorldOptions {
  seed?: number;
  jackSpots?: readonly JackSpotDef[];
  /** Skip props/buildings (fast construction for tests of roads only). */
  bare?: boolean;
}

// ---------------------------------------------------------------------------
// Natural terrain
// ---------------------------------------------------------------------------

function hash2(ix: number, iz: number, seed: number): number {
  let h = (ix * 374761393 + iz * 668265263 + seed * 144269504) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x: number, z: number): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let o = 0; o < 4; o++) {
    sum += amp * valueNoise(x * f, z * f, 7 + o);
    f *= 2.03;
    amp *= 0.5;
  }
  return sum / 0.9375;
}

/** Northing of the coastline at easting e. */
export function coastN(e: number): number {
  if (e <= COAST[0][0]) return COAST[0][1];
  for (let i = 0; i < COAST.length - 1; i++) {
    const [e0, n0] = COAST[i];
    const [e1, n1] = COAST[i + 1];
    if (e <= e1) return n0 + ((n1 - n0) * (e - e0)) / (e1 - e0);
  }
  return COAST[COAST.length - 1][1];
}

/** Distance (m) from (e, n) to the river centreline, and to the lake shore. */
export function riverDistance(e: number, n: number): number {
  let d = Infinity;
  for (let i = 0; i < RIVER.length - 1; i++) {
    d = Math.min(d, pointSegmentDistance(e, n, RIVER[i][0], RIVER[i][1], RIVER[i + 1][0], RIVER[i + 1][1]));
  }
  return d;
}

export function riverEastingAt(n: number): number {
  for (let i = 0; i < RIVER.length - 1; i++) {
    const [e0, n0] = RIVER[i];
    const [e1, n1] = RIVER[i + 1];
    if ((n <= n0 && n >= n1) || (n >= n0 && n <= n1)) return e0 + ((e1 - e0) * (n - n0)) / (n1 - n0 || 1);
  }
  return n > RIVER[0][1] ? RIVER[0][0] : RIVER[RIVER.length - 1][0];
}

/** Distance to open fresh water (river bank or lake shore), negative inside. */
export function freshWaterDistance(e: number, n: number): number {
  const lake = Math.hypot(e - LAKE.e, n - LAKE.n) - LAKE.r;
  return Math.min(riverDistance(e, n) - RIVER_HALF, lake);
}

/** Uncarved land height - the shape of the land before water cuts into it. */
export function naturalHeight(e: number, n: number): number {
  // Flat-ish city core (Downtown + Midtown sit around (150, -400)).
  const rc = Math.hypot((e - 150) * 0.8, n + 400);
  const urban = smoothstep(420, 900, rc);
  let h = 3 + (1.5 + 13 * urban) * fbm(e / 320 + 5, n / 320 - 3);
  h += smoothstep(280, 950, n) * 20 * (0.6 + 0.4 * fbm(e / 210, n / 210));
  const dm2 = (e - MOUNTAIN.e) ** 2 + (n - MOUNTAIN.n) ** 2;
  h += MOUNTAIN.height * Math.exp(-dm2 / (2 * MOUNTAIN.sigma ** 2));
  const edge = Math.max(Math.abs(e), n);
  h += smoothstep(1080, WORLD_HALF, edge) * 50;
  const dr = Math.min(riverDistance(e, n), Math.hypot(e - LAKE.e, n - LAKE.n) - LAKE.r + RIVER_HALF);
  h = 1.4 + (h - 1.4) * smoothstep(RIVER_HALF + 6, 170, dr);
  const inland = n - coastN(e);
  h = 0.9 + (h - 0.9) * smoothstep(12, 260, inland);
  return h;
}

/** Land height with the river, lake and sea carved in. */
export function carvedHeight(e: number, n: number): number {
  let h = naturalHeight(e, n);
  const fw = freshWaterDistance(e, n);
  if (fw < 12) h = WATER_LEVEL - 3.5 + (h - (WATER_LEVEL - 3.5)) * smoothstep(-5, 12, fw);
  const inland = n - coastN(e);
  if (inland < 35) h = WATER_LEVEL - 4.5 + (h - (WATER_LEVEL - 4.5)) * smoothstep(-45, 35, inland);
  return h;
}

// ---------------------------------------------------------------------------

interface DistrictStyle {
  frontage: [number, number];
  depth: [number, number];
  height: [number, number];
  setback: number;
  gap: number;
  rows: number;
  chance: number;
}

const STYLE: Partial<Record<District, DistrictStyle>> = {
  downtown: { frontage: [26, 40], depth: [24, 36], height: [45, 165], setback: 0.8, gap: 3, rows: 2, chance: 0.97 },
  midtown: { frontage: [16, 28], depth: [16, 26], height: [12, 46], setback: 0.8, gap: 2, rows: 2, chance: 0.9 },
  oldtown: { frontage: [9, 14], depth: [12, 18], height: [8, 19], setback: 0.4, gap: 0.6, rows: 1, chance: 0.95 },
  southside: { frontage: [14, 24], depth: [14, 22], height: [7, 24], setback: 1.5, gap: 3, rows: 1, chance: 0.8 },
  hillcrest: { frontage: [17, 23], depth: [10, 13], height: [5.5, 7.5], setback: 7, gap: 6, rows: 1, chance: 0.85 },
  westside: { frontage: [17, 23], depth: [10, 13], height: [5.5, 7.5], setback: 7, gap: 6, rows: 1, chance: 0.85 },
  ironworks: { frontage: [30, 54], depth: [24, 38], height: [9, 16], setback: 5, gap: 8, rows: 1, chance: 0.85 },
  port: { frontage: [30, 50], depth: [22, 34], height: [10, 15], setback: 5, gap: 8, rows: 1, chance: 0.85 },
  beach: { frontage: [10, 13], depth: [6, 8], height: [3.6, 4.8], setback: 4, gap: 14, rows: 1, chance: 0.45 },
};

const PAVED = new Set<District | "sea" | "river">(["downtown", "midtown", "oldtown", "southside", "port", "ironworks"]);

export class World {
  readonly seed: number;
  readonly net: RoadNetwork;
  readonly colliders = new SpatialHash(40);
  readonly buildings: Building[] = [];
  readonly ramps: Ramp[] = [];
  readonly lamps: Prop[] = [];
  readonly trees: Prop[] = [];
  readonly pines: Prop[] = [];
  readonly barriers: Barrier[] = [];
  /** Overpass columns (solid) and their cap beams. */
  readonly piers: Pier[] = [];
  readonly pierCaps: PierCap[] = [];
  readonly containers: Container[] = [];
  readonly tanks: Tank[] = [];
  readonly cranes: Crane[] = [];
  readonly jackSpots: JackSpotPos[] = [];
  readonly terrainN: number;
  /** Physics terrain heights (road-blended) on the grid. */
  readonly terrain: Float32Array;
  readonly spawn: { x: number; z: number; heading: number };
  readonly parkPoly: V2[];
  readonly islandR = CIRCLE.island;
  private parkEN = PARK_POLY.map(([e, n]) => ({ x: e, z: n }));
  private districtPolys = DISTRICT_POLYS.map(([d, poly]) => [d, poly.map(([e, n]) => ({ x: e, z: n }))] as const);
  readonly circle: V2;
  private nextId = 1;
  private reserved: Region[] = [];
  private buildingHash = new SpatialHash(48);
  private boxOf = new Map<number, Building>();

  constructor(opts: WorldOptions = {}) {
    this.seed = opts.seed ?? 2013;
    const rng = mulberry32(this.seed);
    this.net = new RoadNetwork({
      height: (x, z) => naturalHeight(-x, z),
      waterDistance: (x, z) => freshWaterDistance(-x, z),
    });
    this.parkPoly = PARK_POLY.map(([e, n]) => toWorld(e, n));
    this.circle = toWorld(CIRCLE.e, CIRCLE.n);

    // Terrain grid, blended into the roads so verges and embankments meet them.
    this.terrainN = Math.round((2 * WORLD_HALF) / TERRAIN_STEP) + 1;
    this.terrain = new Float32Array(this.terrainN * this.terrainN);
    for (let j = 0; j < this.terrainN; j++) {
      for (let i = 0; i < this.terrainN; i++) {
        const x = -WORLD_HALF + i * TERRAIN_STEP;
        const z = -WORLD_HALF + j * TERRAIN_STEP;
        this.terrain[j * this.terrainN + i] = this.blendedTerrain(x, z);
      }
    }

    // Jack spots reserve their kerbside bays before anything else is placed.
    for (const d of opts.jackSpots ?? []) {
      const r = this.net.road(d.road);
      const s = r.s0 + (r.s1 - r.s0) * d.t;
      // Park on the inside or outside of a bend so the car is fully off the
      // carriageway: step outward until clear of every road.
      let lat = r.hw + (r.sidewalk > 0 ? 2.4 : 3.2);
      let p = this.net.pointOn(d.road, s, lat);
      for (let k = 0; k < 8 && this.net.roadAt(p.x, p.z, 1.2); k++) {
        lat += 0.8;
        p = this.net.pointOn(d.road, s, lat);
      }
      this.jackSpots.push({ id: d.id, carId: d.carId, color: d.color, where: `${DISTRICT_NAMES[this.districtAtEN(-p.x, p.z) as District] ?? "Fairbay"} - ${r.name}`, ...p });
      this.reserved.push({ p: { x: p.x, z: p.z }, r: 9 });
    }
    const spawnRoad = this.net.road("main-5");
    const sp = this.net.pointOn("main-5", spawnRoad.s0 + 25, spawnRoad.laneOffset(1));
    this.spawn = { x: sp.x, z: sp.z, heading: sp.heading };

    this.buildRamps();
    // The roundabout island (fountain): a solid kerbed disc.
    this.circleCollider(this.circle.x, this.circle.z, this.islandR - 0.6, 3, this.net.nodes.get("rb-N")!.elev, false);
    if (!opts.bare) {
      this.buildBarriers();
      this.buildPiers();
      this.buildBuildings(rng);
      this.buildLamps();
      this.buildPort(rng);
      this.buildTrees(rng);
    }
    this.buildBoundaries();
  }

  // ---------------------------------------------------------------------------
  // Terrain
  // ---------------------------------------------------------------------------

  private blendedTerrain(x: number, z: number): number {
    const nat = carvedHeight(-x, z);
    const node = this.net.nodeAt(x, z);
    if (node) return node.elev;
    const near = this.net.nearestRoad(x, z, 48);
    if (!near) return nat;
    const r = near.road;
    if (r.isBridge(near.s)) return nat;
    // A road surface well above the ground (approach embankment of an
    // overpass) gets a sloped embankment; deck spans keep the ground.
    const roadH = r.heightAt(near.s) + (r.sidewalk > 0 ? CURB : 0);
    const d = near.dist - r.hw;
    const w = smoothstep(r.sidewalk + 2, r.sidewalk + 34, d);
    return roadH + (nat - roadH) * w;
  }

  terrainAt(x: number, z: number): number {
    const n = this.terrainN;
    const gx = clamp((x + WORLD_HALF) / TERRAIN_STEP, 0, n - 1.0001);
    const gz = clamp((z + WORLD_HALF) / TERRAIN_STEP, 0, n - 1.0001);
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const u = gx - i;
    const v = gz - j;
    const h00 = this.terrain[j * n + i];
    const h10 = this.terrain[j * n + i + 1];
    const h01 = this.terrain[(j + 1) * n + i];
    const h11 = this.terrain[(j + 1) * n + i + 1];
    if (u + v <= 1) return h00 + u * (h10 - h00) + v * (h01 - h00);
    return h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
  }

  private rampHeight(x: number, z: number): { h: number; base: number } | null {
    for (const r of this.ramps) {
      const dx = x - r.x;
      const dz = z - r.z;
      if (Math.abs(dx) > r.length + r.width || Math.abs(dz) > r.length + r.width) continue;
      const fx = Math.sin(r.heading);
      const fz = Math.cos(r.heading);
      const a = dx * fx + dz * fz;
      const b = dx * fz - dz * fx;
      if (a < 0 || a > r.length || Math.abs(b) > r.width / 2) continue;
      return { h: (r.height * a) / r.length, base: r.base };
    }
    return null;
  }

  /** Driving surface height at (x, z). */
  /**
   * Driving surface height at (x, z). Where roads are stacked (an overpass
   * above a street) `y` - the height of the thing asking - picks the deck it
   * is on: a car on the viaduct stays on it, a car below drives underneath.
   */
  ground = (x: number, z: number, y?: number): number => {
    const ramp = this.rampHeight(x, z);
    let g: number;
    const node = this.net.nodeAt(x, z);
    const r = this.net.roadAt(x, z, 0, y);
    // Inside a junction disc that a road still runs through (the road's own
    // profile is continuous there), follow the road; only open junction
    // surface away from every carriageway uses the flat junction height.
    if (node && !r) g = node.elev;
    else if (node && r && y !== undefined && Math.abs(node.elev - y) + 0.5 < Math.abs(r.road.heightAt(r.s) - y)) g = node.elev;
    else if (r) {
      g = r.road.heightAt(r.s);
      // Where carriageways overlap (a slip road peeling off a highway), blend
      // the surfaces by how far inside each one the point is - no seams.
      const other = this.net.roadAt(x, z, -0.01, g);
      const all = this.net.roadsAt(x, z);
      if (all.length > 1) {
        let wsum = 0;
        let hsum = 0;
        for (const o of all) {
          const h = o.road.heightAt(o.s);
          if (Math.abs(h - g) > 1.2) continue; // a different level
          const w = Math.max(0.001, o.road.hw - Math.abs(o.lat));
          wsum += w;
          hsum += w * h;
        }
        if (wsum > 0) g = hsum / wsum;
      }
      void other;
    }
    else {
      const sw = this.net.roadAt(x, z, 4.2, y);
      if (sw && sw.road.sidewalk > 0 && !sw.road.isBridge(sw.s)) g = sw.road.heightAt(sw.s) + CURB;
      else if (sw && sw.road.isBridge(sw.s) && Math.abs(sw.lat) < sw.road.hw + sw.road.sidewalk) g = sw.road.heightAt(sw.s) + CURB;
      else g = this.terrainAt(x, z);
      // Under a deck you are on the terrain, not up on the bridge.
      if (sw && y !== undefined && g > y + 1.5) g = this.terrainAt(x, z);
    }
    if (ramp) return Math.max(g, ramp.base + ramp.h);
    return g;
  };

  surface = (x: number, z: number): Surface => {
    if (this.rampHeight(x, z)) return "road";
    if (this.net.nodeAt(x, z) || this.net.roadAt(x, z, 4.2)) return "road";
    const d = this.districtOf(x, z);
    return PAVED.has(d as District) ? "road" : "offroad";
  };

  get world(): PhysicsWorld {
    return { ground: this.ground, surface: this.surface, colliders: this.colliders };
  }

  /** True if the point is over open water (river, lake or sea). */
  isWater(x: number, z: number): boolean {
    const e = -x;
    return z < coastN(e) || freshWaterDistance(e, z) < 0;
  }

  // ---------------------------------------------------------------------------
  // Districts
  // ---------------------------------------------------------------------------

  districtAtEN(e: number, n: number): District | "sea" | "river" {
    if (n < coastN(e)) return "sea";
    if (freshWaterDistance(e, n) < 0) return "river";
    if (pointInPolygon(e, n, this.parkEN)) return "park";
    const dm = Math.hypot(e - MOUNTAIN.e, n - MOUNTAIN.n);
    if (dm < 420 || (e < -800 && n > 420)) return "highlands";
    if (e < riverEastingAt(n) - RIVER_HALF) return "westside";
    for (const [d, poly] of this.districtPolys) if (pointInPolygon(e, n, poly)) return d;
    if (n > 600) return "hillcrest";
    return "southside";
  }

  districtOf(x: number, z: number): District | "sea" | "river" {
    return this.districtAtEN(-x, z);
  }

  // ---------------------------------------------------------------------------
  // Placement helpers
  // ---------------------------------------------------------------------------

  private obbCollider(b: OBB, top: number, base: number, ramp = false): OBBCollider {
    const c: OBBCollider = { kind: "obb", id: this.nextId++, cx: b.cx, cz: b.cz, hx: b.hx, hz: b.hz, c: b.c, s: b.s, top, base, ramp };
    this.colliders.add(c);
    return c;
  }

  private circleCollider(x: number, z: number, r: number, top: number, base: number, breakable: boolean): CircleCollider {
    const c: CircleCollider = { kind: "circle", id: this.nextId++, x, z, r, top, base, breakable, broken: false };
    this.colliders.add(c);
    return c;
  }

  private isReserved(x: number, z: number, pad = 0): boolean {
    for (const r of this.reserved) if (Math.hypot(x - r.p.x, z - r.p.z) < r.r + pad) return true;
    return false;
  }

  /** True if (x, z) is on (or within `pad` m of) any carriageway or junction. */
  onRoad(x: number, z: number, pad: number): boolean {
    if (this.net.roadAt(x, z, pad)) return true;
    for (const n of this.net.nodes.values()) if (Math.hypot(x - n.x, z - n.z) < n.radius + pad) return true;
    return false;
  }

  private nearRamp(x: number, z: number, pad: number): boolean {
    for (const r of this.ramps) if (Math.hypot(x - r.x, z - r.z) < r.length + r.width + pad) return true;
    return false;
  }

  /** Can a building footprint go here? */
  private footprintFree(b: OBB, padRoad: number, maxSlope: number): boolean {
    if (Math.abs(b.cx) > WORLD_HALF - 40 || Math.abs(b.cz) > WORLD_HALF - 40) return false;
    // Sample a grid over the footprint (<= 7 m spacing) plus the corners.
    const nu = Math.max(2, Math.ceil((2 * b.hx) / 7));
    const nv = Math.max(2, Math.ceil((2 * b.hz) / 7));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i <= nu; i++) {
      for (let j = 0; j <= nv; j++) {
        const u = -b.hx + (2 * b.hx * i) / nu;
        const v = -b.hz + (2 * b.hz * j) / nv;
        const x = b.cx + u * b.c - v * b.s;
        const z = b.cz + u * b.s + v * b.c;
        if (this.onRoad(x, z, padRoad)) return false;
        const e = -x;
        if (freshWaterDistance(e, z) < 10 || z - coastN(e) < 18) return false;
        if (pointInPolygon(x, z, this.parkPoly)) return false;
        if (this.isReserved(x, z, 3)) return false;
        if (this.nearRamp(x, z, 6)) return false;
        if (Math.hypot(x - this.circle.x, z - this.circle.z) < this.islandR + 6) return false;
        const h = this.terrainAt(x, z);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
    }
    if (hi - lo > maxSlope) return false;
    // Overlap with already placed buildings / lots (padded).
    const r = Math.hypot(b.hx, b.hz) + 2;
    const padded = { ...b, hx: b.hx + 1.2, hz: b.hz + 1.2 };
    for (const c of this.buildingHash.query(b.cx, b.cz, r + 40)) {
      if (c.kind !== "obb") continue;
      if (obbOverlap(padded, { cx: c.cx, cz: c.cz, hx: c.hx, hz: c.hz, c: c.c, s: c.s })) return false;
    }
    return true;
  }

  private claim(b: OBB): void {
    this.buildingHash.add({ kind: "obb", id: this.nextId++, cx: b.cx, cz: b.cz, hx: b.hx, hz: b.hz, c: b.c, s: b.s, top: 0, base: 0 });
  }

  private minGround(b: OBB): number {
    let lo = Infinity;
    for (const p of obbCorners(b)) lo = Math.min(lo, this.terrainAt(p.x, p.z));
    return Math.min(lo, this.terrainAt(b.cx, b.cz));
  }

  // ---------------------------------------------------------------------------
  // Generation
  // ---------------------------------------------------------------------------

  private buildRamps(): void {
    for (const d of RAMPS) {
      const p = toWorld(d.e, d.n);
      const heading = (-d.bearing * Math.PI) / 180;
      const base = this.terrainAt(p.x, p.z);
      const ramp: Ramp = { x: p.x, z: p.z, heading, width: d.width, length: d.length, height: d.height, base, label: d.label };
      this.ramps.push(ramp);
      const fx = Math.sin(heading);
      const fz = Math.cos(heading);
      // Solid back face: a thin box across the top end. An OBB's hx axis is
      // (cos a, sin a); we want it along the ramp's right vector (fz, -fx).
      const bx = p.x + fx * (d.length + 0.3);
      const bz = p.z + fz * (d.length + 0.3);
      this.obbCollider(obb(bx, bz, d.width / 2, 0.3, Math.atan2(-fx, fz)), d.height, base, true);
      this.reserved.push({ p: { x: p.x + fx * d.length * 0.5, z: p.z + fz * d.length * 0.5 }, r: d.length + 6 });
    }
  }

  private buildBarriers(): void {
    const segLen = 6;
    for (const r of this.net.roads) {
      const c = r.center;
      const jersey = r.cls === "freeway";
      for (let s = r.s0 + 18; s < r.s1 - 18; s += segLen) {
        const p = c.sample(s + segLen / 2);
        const t = c.tangent(s + segLen / 2);
        const y = r.heightAt(s + segLen / 2);
        const ang = Math.atan2(t.tz, t.tx);
        const bridge = r.isBridge(s + segLen / 2);
        const place = (lat: number, kind: "jersey" | "rail", h: number) => {
          const x = p.x - t.tz * lat;
          const z = p.z + t.tx * lat;
          // Never inside another road's carriageway or a junction.
          const hit = this.net.roadAt(x, z, 0.3);
          if (hit && hit.road !== r) return;
          for (const n of this.net.nodes.values()) if (Math.hypot(x - n.x, z - n.z) < n.radius + 4) return;
          const box = obb(x, z, segLen / 2 + 0.1, kind === "jersey" ? 0.32 : 0.12, ang);
          this.barriers.push({ box, y0: y, y1: y + h, kind });
          this.obbCollider(box, h, y);
        };
        if (jersey) place(0, "jersey", 0.85);
        if (r.cls === "mountain" || bridge) {
          const off = r.hw + (bridge ? r.sidewalk : 0) + 0.25;
          place(off, "rail", bridge ? 1.0 : 0.75);
          place(-off, "rail", bridge ? 1.0 : 0.75);
        }
      }
    }
  }

  /**
   * Overpass column bents every ~30 m where the deck is more than 4 m above
   * the ground and the column would not land on another carriageway. The
   * columns are SOLID (0.8 m square) - before, they were scenery you could
   * drive straight through.
   */
  private buildPiers(): void {
    for (const r of this.net.roads) {
      const s0 = Math.max(0, r.s0 - 1);
      const s1 = Math.min(r.length, r.s1 + 1);
      const ext = r.hw + r.sidewalk + 0.4;
      for (const [o0, o1] of r.overpasses) {
        const a = Math.max(s0, o0);
        const b = Math.min(s1, o1);
        for (let s = a + 12; s < b - 6; s += 30) {
          const p = r.center.sample(s);
          const t = r.center.tangent(s);
          const y = r.heightAt(s) - 1.4;
          const ang = Math.atan2(t.tz, t.tx);
          for (const lat of r.cls === "freeway" ? [-ext * 0.62, 0, ext * 0.62] : [0]) {
            const x = p.x - t.tz * lat;
            const z = p.z + t.tx * lat;
            const ground = this.terrainAt(x, z);
            if (y - ground < 4) continue;
            // Never on another road (padded: the column stands clear of the kerb).
            let blocked = false;
            for (const o of this.net.roadsAt(x, z)) if (o.road !== r) blocked = true;
            const below = this.net.roadAt(x, z, 1.2, ground);
            if (below && below.road !== r) blocked = true;
            if (this.net.nodeAt(x, z)) blocked = true;
            if (blocked) continue;
            this.piers.push({ x, z, ang, y0: ground - 0.5, y1: y });
            this.obbCollider(obb(x, z, 0.8, 0.8, ang), y - ground + 0.5, ground - 0.5);
          }
          this.pierCaps.push({ x: p.x, z: p.z, ang, half: ext * 0.85, y });
        }
      }
    }
  }

  private buildBuildings(rng: () => number): void {
    const roads = [...this.net.roads].sort((a, b) => b.hw - a.hw); // wide roads claim frontage first
    for (const r of roads) {
      if (r.cls === "freeway" || r.cls === "mountain" || r.cls === "ring" || r.cls === "ramp" || r.cls === "runway") continue;
      for (const side of [1, -1] as const) {
        for (let row = 0; row < 2; row++) {
          let s = r.s0 + 4 + rng() * 6;
          while (s < r.s1 - 8) {
            const p = r.center.sample(s);
            const d = this.districtOf(p.x - r.center.tangent(s).tz * side * (r.hw + 15), p.z + r.center.tangent(s).tx * side * (r.hw + 15));
            const st = STYLE[d as District];
            if (!st || row >= st.rows) {
              s += 12;
              continue;
            }
            const front = range(rng, st.frontage[0], st.frontage[1]);
            const depth = range(rng, st.depth[0], st.depth[1]);
            const sc = s + front / 2;
            if (sc > r.s1 - 4 || r.isBridge(sc)) {
              s += front + st.gap;
              continue;
            }
            const t = r.center.tangent(sc);
            const pc = r.center.sample(sc);
            const rowOff = row === 0 ? 0 : st.depth[1] + 4;
            const off = r.hw + r.sidewalk + st.setback + depth / 2 + rowOff;
            const cx = pc.x - t.tz * side * off;
            const cz = pc.z + t.tx * side * off;
            const box = obb(cx, cz, front / 2, depth / 2, Math.atan2(t.tz, t.tx));
            const isHouse = d === "hillcrest" || d === "westside" || d === "beach";
            const ok = rng() < st.chance && this.footprintFree(box, r.sidewalk > 0 ? r.sidewalk - 0.2 : 2.5, isHouse ? 7 : 3.5);
            if (ok) {
              this.claim(box);
              this.makeBuilding(d as District, box, st, rng);
            }
            s += front + st.gap;
          }
        }
      }
    }
  }

  private makeBuilding(d: District, box: OBB, st: DistrictStyle, rng: () => number): void {
    const base = this.minGround(box) - 0.4;
    // Lift the floor so the top of the slope is not buried.
    let hi = -Infinity;
    for (const p of obbCorners(box)) hi = Math.max(hi, this.terrainAt(p.x, p.z));
    const lift = hi - base;
    // Tallest towers in the heart of Downtown, by the bay.
    const rc = Math.hypot(-box.cx - 140, box.cz + 650);
    if (d === "ironworks" && rng() < 0.35) {
      this.tankFarm(box, rng);
      return;
    }
    if (d === "port" && rng() < 0.55) {
      this.containerYard(box, rng);
      return;
    }
    let style: BuildingStyle;
    let color: string;
    let h = range(rng, st.height[0], st.height[1]);
    let tiers = 1;
    let pitched = false;
    switch (d) {
      case "downtown":
        h *= 1 - Math.min(0.55, rc / 600);
        h = Math.max(h, 30);
        style = rng() < 0.58 ? "glass" : "office";
        color = style === "glass" ? pick(rng, ["#7fa7c9", "#5d7f9e", "#8ab0b8", "#a7b6c9", "#4e6e8e", "#6f8fa3"]) : pick(rng, ["#c9c2b5", "#b5b9bf", "#d6cbb8", "#9ea4ab", "#c4b8a6"]);
        tiers = h > 90 ? 3 : 2;
        break;
      case "midtown":
        style = rng() < 0.45 ? "brick" : rng() < 0.7 ? "office" : "glass";
        color =
          style === "brick"
            ? pick(rng, ["#9c4f3c", "#b0644a", "#8a5a44", "#a8735a", "#7d4436"])
            : style === "office"
              ? pick(rng, ["#d9d2c3", "#c4c8cc", "#e0d6c2", "#b9b2a6", "#cfc5b0"])
              : pick(rng, ["#7fa7c9", "#6c8fa8", "#9ab8c4"]);
        tiers = h > 32 && rng() < 0.5 ? 2 : 1;
        break;
      case "oldtown":
        style = rng() < 0.7 ? "brick" : "office";
        color = style === "brick" ? pick(rng, ["#a0523d", "#8f4a38", "#b56a4f", "#7b3f31", "#c08066", "#9a6a52"]) : pick(rng, ["#e6dcc8", "#d8c7a8", "#efe6d3", "#c9b99a"]);
        break;
      case "southside":
        style = rng() < 0.5 ? "brick" : "office";
        color = style === "brick" ? pick(rng, ["#9c5a46", "#8a6250", "#a87a62"]) : pick(rng, ["#d0c8b8", "#bfc3c6", "#d9cdb5"]);
        break;
      case "hillcrest":
      case "westside":
      case "beach":
        style = "house";
        pitched = true;
        color = d === "beach" ? pick(rng, ["#f2e6c9", "#cfe6ea", "#f6d4c4", "#d8ecd0", "#ffffff"]) : pick(rng, ["#e8e0d0", "#d7e3e8", "#f0d9b5", "#c8d5b9", "#e6c9c0", "#f5f1e8"]);
        break;
      default:
        style = "warehouse";
        color = pick(rng, ["#8d9aa6", "#a39e93", "#6f7f8c", "#b4a68f", "#7c8a7a", "#5b7083", "#8d6e63"]);
    }
    const ts: Tier[] = [];
    let hx = box.hx;
    let hz = box.hz;
    let y0 = 0;
    for (let k = 0; k < tiers; k++) {
      const y1 = k === tiers - 1 ? h + lift : Math.max(y0 + 8, (h + lift) * (k === 0 ? range(rng, 0.45, 0.6) : range(rng, 0.75, 0.85)));
      ts.push({ hx, hz, y0, y1 });
      y0 = y1;
      hx *= range(rng, 0.7, 0.82);
      hz *= range(rng, 0.7, 0.82);
    }
    const top = ts[ts.length - 1];
    const rooftop = [];
    if (!pitched) {
      const n = Math.floor(range(rng, 1, 4));
      for (let k = 0; k < n; k++) {
        const w = Math.min(range(rng, 2, 5), top.hx);
        const dd = Math.min(range(rng, 2, 5), top.hz);
        rooftop.push({ u: range(rng, -top.hx + w, top.hx - w), v: range(rng, -top.hz + dd, top.hz - dd), w, d: dd, h: range(rng, 1.2, 3) });
      }
    }
    const b: Building = {
      id: this.buildings.length,
      style,
      color,
      district: d,
      box,
      base,
      tiers: ts,
      pitched,
      height: top.y1 + (pitched ? 3 : 0),
      rooftop,
    };
    if ((d === "downtown" || d === "midtown") && rng() < 0.18) {
      const w = Math.min(top.hx, top.hz) * 1.6;
      b.billboard = { w, h: w * 0.35, color: pick(rng, ["#ff2d55", "#00d1ff", "#ffb800", "#7cff4f", "#b26bff"]) };
    }
    if (d === "downtown" && h > 110 && rng() < 0.5) b.spire = range(rng, 12, 30);
    this.buildings.push(b);
    this.boxOf.set(b.id, b);
    this.obbCollider(box, top.y1 + 2, base);
    // Gardens.
    if (pitched && rng() < 0.8) this.tryTree(box.cx + box.c * (box.hx + 4), box.cz + box.s * (box.hx + 4), rng, false);
  }

  private tankFarm(box: OBB, rng: () => number): void {
    const r = range(rng, 6, 8.5);
    const cols = Math.max(1, Math.floor((2 * box.hx) / (2 * r + 4)));
    const rows = Math.max(1, Math.floor((2 * box.hz) / (2 * r + 4)));
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        if (rng() < 0.2) continue;
        const u = -box.hx + (i + 0.5) * ((2 * box.hx) / cols);
        const v = -box.hz + (j + 0.5) * ((2 * box.hz) / rows);
        const x = box.cx + u * box.c - v * box.s;
        const z = box.cz + u * box.s + v * box.c;
        const y = this.terrainAt(x, z) - 0.2;
        const h = range(rng, 9, 16);
        this.tanks.push({ x, z, y, r, h });
        this.circleCollider(x, z, r, h, y, false);
      }
    }
  }

  private containerYard(box: OBB, rng: () => number): void {
    const colors = ["#c0392b", "#2471a3", "#d68910", "#1e8449", "#7d3c98", "#b9770e", "#566573", "#a93226", "#117a65"];
    const L = 12.2;
    const W = 2.44;
    const cols = Math.max(1, Math.floor((2 * box.hx) / (L + 3)));
    const rows = Math.max(1, Math.floor((2 * box.hz) / (W * 3 + 6)));
    const ang = Math.atan2(box.s, box.c);
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        if (rng() < 0.15) continue;
        const u0 = -box.hx + (i + 0.5) * ((2 * box.hx) / cols);
        const v0 = -box.hz + (j + 0.5) * ((2 * box.hz) / rows);
        let maxLevel = 0;
        for (let k = 0; k < 3; k++) {
          const v = v0 + (k - 1) * W;
          const x = box.cx + u0 * box.c - v * box.s;
          const z = box.cz + u0 * box.s + v * box.c;
          const levels = 1 + Math.floor(rng() * 3);
          maxLevel = Math.max(maxLevel, levels);
          const y = this.terrainAt(x, z);
          for (let l = 0; l < levels; l++) this.containers.push({ x, z, y: y + l * 2.6, rot: ang, color: pick(rng, colors) });
        }
        const cx = box.cx + u0 * box.c - v0 * box.s;
        const cz = box.cz + u0 * box.s + v0 * box.c;
        this.obbCollider(obb(cx, cz, L / 2, (W * 3) / 2, ang), maxLevel * 2.6, this.terrainAt(cx, cz));
      }
    }
  }

  private buildLamps(): void {
    for (const r of this.net.roads) {
      const mode = r.spec.lamps;
      if (mode === "none") continue;
      const step = r.cls === "freeway" ? 48 : 32;
      for (let s = r.s0 + 10; s < r.s1 - 10; s += step) {
        const p = r.center.sample(s);
        const t = r.center.tangent(s);
        const y = r.heightAt(s);
        const sides: number[] = mode === "median" ? [0] : mode === "one" ? [1] : [1, -1];
        for (const side of sides) {
          const lat = side === 0 ? 0 : side * (r.hw + (r.sidewalk > 0 ? 0.8 : 1.2));
          const x = p.x - t.tz * lat;
          const z = p.z + t.tx * lat;
          if (side !== 0) {
            const hit = this.net.roadAt(x, z, 0.4);
            if (hit) continue;
          }
          let inNode = false;
          for (const n of this.net.nodes.values()) if (Math.hypot(x - n.x, z - n.z) < n.radius + 3) inNode = true;
          if (inNode || this.isReserved(x, z, 1)) continue;
          // Arm points over the road: rotation faces the carriageway.
          const rot = side === 0 ? Math.atan2(t.tx, t.tz) + Math.PI / 2 : Math.atan2(t.tz * side, -t.tx * side);
          const base = side === 0 ? y : y + (r.sidewalk > 0 ? CURB : 0);
          const col = this.circleCollider(x, z, 0.22, 7, base, true);
          this.lamps.push({ x, z, y: base, rot, scale: side === 0 ? -1 : 1, collider: col });
        }
      }
    }
  }

  private buildPort(rng: () => number): void {
    // Gantry cranes on the quay.
    for (let e = 360; e <= 900; e += 170) {
      const n = coastN(e) + 14;
      const p = toWorld(e, n);
      if (this.onRoad(p.x, p.z, 12)) continue;
      const y = this.terrainAt(p.x, p.z);
      this.cranes.push({ x: p.x, z: p.z, y, rot: 0 });
      for (const [dx, dz] of [
        [-8, -6],
        [8, -6],
        [-8, 6],
        [8, 6],
      ]) {
        this.circleCollider(p.x + dx, p.z + dz, 0.8, 40, y, false);
      }
    }
    void rng;
  }

  private tryTree(x: number, z: number, rng: () => number, pine: boolean): boolean {
    const e = -x;
    if (Math.abs(x) > WORLD_HALF - 20 || Math.abs(z) > WORLD_HALF - 20) return false;
    if (freshWaterDistance(e, z) < 6 || z - coastN(e) < 12) return false;
    if (this.onRoad(x, z, 4.6)) return false;
    if (this.isReserved(x, z, 2) || this.nearRamp(x, z, 4)) return false;
    if (Math.hypot(x - this.circle.x, z - this.circle.z) < this.islandR + 4) return false;
    for (const c of this.buildingHash.query(x, z, 30)) {
      if (c.kind === "obb" && pointInOBB(x, z, { cx: c.cx, cz: c.cz, hx: c.hx + 2, hz: c.hz + 2, c: c.c, s: c.s })) return false;
    }
    const y = this.terrainAt(x, z);
    const col = this.circleCollider(x, z, pine ? 0.4 : 0.45, pine ? 9 : 8, y, false);
    const prop = { x, z, y, rot: rng() * Math.PI * 2, scale: range(rng, 0.8, 1.35), collider: col };
    (pine ? this.pines : this.trees).push(prop);
    return true;
  }

  private buildTrees(rng: () => number): void {
    // Central Park: dense.
    let placed = 0;
    for (let k = 0; k < 2600 && placed < 260; k++) {
      const e = range(rng, -210, 100);
      const n = range(rng, 210, 480);
      const p = toWorld(e, n);
      if (!pointInPolygon(p.x, p.z, this.parkPoly)) continue;
      if (this.tryTree(p.x, p.z, rng, false)) placed++;
    }
    // Countryside, hills and the mountain.
    const density: Partial<Record<District | "sea" | "river", number>> = {
      highlands: 0.75,
      hillcrest: 0.35,
      westside: 0.3,
      southside: 0.1,
      oldtown: 0.05,
      beach: 0.04,
      ironworks: 0.03,
    };
    for (let k = 0; k < 40000 && this.trees.length + this.pines.length < 3600; k++) {
      const x = range(rng, -WORLD_HALF + 30, WORLD_HALF - 30);
      const z = range(rng, -WORLD_HALF + 30, WORLD_HALF - 30);
      const d = this.districtOf(x, z);
      let p = density[d] ?? 0;
      // Open countryside (outside the districts' cores) gets light woodland.
      if (d === "southside" && (z > 0 || -x < -600)) p = 0.3;
      if (rng() > p * (0.35 + 0.65 * fbm(x / 140, z / 140))) continue;
      const pine = d === "highlands" || (d === "hillcrest" && rng() < 0.4) || this.terrainAt(x, z) > 45;
      this.tryTree(x, z, rng, pine);
    }
    // Street trees on Old Town and Midtown sidewalks.
    for (const r of this.net.roads) {
      if (r.sidewalk === 0 || r.cls === "ring") continue;
      for (let s = r.s0 + 26; s < r.s1 - 10; s += 32) {
        const p = r.center.sample(s);
        const t = r.center.tangent(s);
        for (const side of [1, -1]) {
          const lat = side * (r.hw + 2.6);
          const x = p.x - t.tz * lat;
          const z = p.z + t.tx * lat;
          const d = this.districtOf(x, z);
          if (d !== "oldtown" && d !== "midtown" && d !== "hillcrest") continue;
          if (this.net.roadAt(x, z, 1)) continue;
          let near = false;
          for (const n of this.net.nodes.values()) if (Math.hypot(x - n.x, z - n.z) < n.radius + 6) near = true;
          if (near || this.isReserved(x, z, 2)) continue;
          let blocked = false;
          for (const c of this.buildingHash.query(x, z, 30)) {
            if (c.kind === "obb" && pointInOBB(x, z, { cx: c.cx, cz: c.cz, hx: c.hx + 0.6, hz: c.hz + 0.6, c: c.c, s: c.s })) blocked = true;
          }
          if (blocked) continue;
          const y = r.heightAt(s) + CURB;
          const col = this.circleCollider(x, z, 0.4, 8, y, false);
          this.trees.push({ x, z, y, rot: rng() * Math.PI * 2, scale: range(rng, 0.75, 1.0), collider: col });
        }
      }
    }
  }

  private buildBoundaries(): void {
    const W = WORLD_HALF;
    for (const [cx, cz, hx, hz] of [
      [0, W + 5, W + 10, 5],
      [0, -W - 5, W + 10, 5],
      [W + 5, 0, 5, W + 10],
      [-W - 5, 0, 5, W + 10],
    ]) {
      this.obbCollider(obb(cx, cz, hx, hz, 0), 9999, -50);
    }
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /** A safe lane position on the nearest road, used to recover the car. */
  nearestRoadPoint(x: number, z: number): { x: number; z: number; heading: number } {
    const near = this.net.nearestRoad(x, z, 400) ?? this.net.nearestRoad(this.spawn.x, this.spawn.z, 400)!;
    const r: Road = near.road;
    const s = clamp(near.s, r.s0 + 6, r.s1 - 6);
    const reverse = !r.spec.oneWay && near.lat < 0;
    const lat = r.laneOffset(r.spec.lanes - 1);
    if (reverse) {
      const p = this.net.pointOn(r.id, s, -lat);
      return { x: p.x, z: p.z, heading: p.heading + Math.PI };
    }
    return this.net.pointOn(r.id, s, lat);
  }

  /** Any building whose footprint contains the point. */
  buildingAt(x: number, z: number): Building | null {
    for (const c of this.buildingHash.query(x, z, 1)) {
      if (c.kind !== "obb") continue;
      if (pointInOBB(x, z, { cx: c.cx, cz: c.cz, hx: c.hx, hz: c.hz, c: c.c, s: c.s })) {
        for (const b of this.buildings) if (Math.abs(b.box.cx - c.cx) < 1e-6 && Math.abs(b.box.cz - c.cz) < 1e-6) return b;
        return null;
      }
    }
    return null;
  }

  /** Static colliders near a point (for tests and the camera). */
  collidersNear(x: number, z: number, r: number): Collider[] {
    return this.colliders.query(x, z, r);
  }
}
