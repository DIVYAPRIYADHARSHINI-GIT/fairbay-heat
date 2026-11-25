/**
 * Turns the hand-made `World` into renderable Three.js meshes.
 *
 *  - Roads: each road is a ribbon mesh following its curved centreline and
 *    elevation profile, with painted lane lines, edge lines and centre lines
 *    built as thin ribbons on top; sidewalks with kerbs; bridge decks with
 *    piers over water. Junctions are flat discs (fans) blended with the roads;
 *    signalised junctions get stop lines and traffic-light poles.
 *  - Terrain: one heightfield mesh coloured by slope/height (grass, forest
 *    floor, rock, sand), with the river, lake and sea as water planes.
 *  - Buildings: oriented boxes (along the curved streets) merged per material
 *    into 256 m chunks so whole districts are a few draw calls but still
 *    frustum-culled.
 *  - Props: lamps, trees, pines, barriers, rails, containers, tanks and
 *    cranes as InstancedMeshes.
 */

import * as THREE from "three";
import { mulberry32, pick, range } from "../core/math";
import { obbCorners } from "../core/geom";
import type { CircleCollider } from "../game/collision";
import { signalState, type Light, type RNode, type Road } from "../game/roads";
import { CURB, TERRAIN_STEP, WATER_LEVEL, WORLD_HALF, coastN, fbm, freshWaterDistance, type Building, type BuildingStyle, type World } from "../game/world";
import { LAKE, RIVER, RIVER_HALF, toWorld } from "../game/mapdata";
import * as T from "./textures";

// ---------------------------------------------------------------------------
// Geometry builder
// ---------------------------------------------------------------------------

class Geo {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];

  get count(): number {
    return this.pos.length / 3;
  }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, c: THREE.Color): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(c.r, c.g, c.b);
    return this.count - 1;
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /** Planar quad from 4 corners (counter-clockwise from the visible side). */
  face(p: number[][], n: number[], uvs: number[][], c: THREE.Color): void {
    const i = this.count;
    for (let k = 0; k < 4; k++) this.vert(p[k][0], p[k][1], p[k][2], n[0], n[1], n[2], uvs[k][0], uvs[k][1], c);
    this.quad(i, i + 1, i + 2, i + 3);
  }

  tri(a: number[], b: number[], c: number[], uvs: number[][], col: THREE.Color): void {
    const n = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).cross(new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2])).normalize();
    const i = this.count;
    this.vert(a[0], a[1], a[2], n.x, n.y, n.z, uvs[0][0], uvs[0][1], col);
    this.vert(b[0], b[1], b[2], n.x, n.y, n.z, uvs[1][0], uvs[1][1], col);
    this.vert(c[0], c[1], c[2], n.x, n.y, n.z, uvs[2][0], uvs[2][1], col);
    this.idx.push(i, i + 1, i + 2);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

const CHUNK = 256;
const WHITE = new THREE.Color(1, 1, 1);

type Mat =
  | BuildingStyle
  | "roof"
  | "shingle"
  | "asphalt"
  | "sidewalk"
  | "curb"
  | "paint"
  | "concrete"
  | "ramp"
  | "rampSide"
  | "bridge"
  | "plaza";

export interface WorldView {
  group: THREE.Group;
  water: THREE.Mesh[];
  setNight(n: number): void;
  update(time: number, signalTime: number): void;
  breakLamp(c: CircleCollider): void;
  resetLamps(): void;
}

export function buildWorldView(world: World, maxAniso: number): WorldView {
  const group = new THREE.Group();
  group.name = "world";
  const tex = <X extends THREE.Texture>(t: X) => {
    t.anisotropy = maxAniso;
    return t;
  };

  // ---- materials -------------------------------------------------------------
  const styles: BuildingStyle[] = ["glass", "office", "brick", "house", "warehouse"];
  const facades = Object.fromEntries(styles.map((s) => [s, T.facade(s)])) as Record<BuildingStyle, T.Facade>;
  const facadeMats = {} as Record<BuildingStyle, THREE.MeshStandardMaterial>;
  for (const s of styles) {
    const f = facades[s];
    for (const t of [f.map, f.emissive, f.rough]) tex(t);
    facadeMats[s] = new THREE.MeshStandardMaterial({
      map: f.map,
      roughnessMap: f.rough,
      emissiveMap: f.emissive,
      emissive: new THREE.Color(1, 1, 1),
      emissiveIntensity: 0,
      vertexColors: true,
      roughness: 1,
      metalness: s === "glass" ? 0.5 : 0.05,
      envMapIntensity: s === "glass" ? 1.0 : 0.5,
    });
  }
  const asphaltTex = tex(T.asphalt());
  const mats: Record<Exclude<Mat, BuildingStyle>, THREE.Material> = {
    roof: new THREE.MeshStandardMaterial({ map: tex(T.roofTex()), vertexColors: true, roughness: 0.95 }),
    shingle: new THREE.MeshStandardMaterial({ map: tex(T.shingles()), vertexColors: true, roughness: 0.85 }),
    asphalt: new THREE.MeshStandardMaterial({ map: asphaltTex, vertexColors: true, roughness: 0.88, color: 0xb0b0b0 }),
    sidewalk: new THREE.MeshStandardMaterial({ map: tex(T.sidewalk()), vertexColors: true, roughness: 0.9 }),
    curb: new THREE.MeshStandardMaterial({ map: tex(T.concrete()), vertexColors: true, roughness: 0.9 }),
    paint: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }),
    concrete: new THREE.MeshStandardMaterial({ map: tex(T.concrete()), vertexColors: true, roughness: 0.85 }),
    ramp: new THREE.MeshStandardMaterial({ map: tex(T.concrete()), vertexColors: true, roughness: 0.6, metalness: 0.4 }),
    rampSide: new THREE.MeshStandardMaterial({ map: tex(T.hazardStripes()), vertexColors: true, roughness: 0.7 }),
    bridge: new THREE.MeshStandardMaterial({ map: tex(T.concrete()), vertexColors: true, roughness: 0.8 }),
    plaza: new THREE.MeshStandardMaterial({ map: tex(T.sidewalk()), vertexColors: true, roughness: 0.85 }),
  };
  const material = (k: Mat): THREE.Material => (styles.includes(k as BuildingStyle) ? facadeMats[k as BuildingStyle] : mats[k as Exclude<Mat, BuildingStyle>]);

  const chunks = new Map<string, Map<Mat, Geo>>();
  const geo = (x: number, z: number, k: Mat): Geo => {
    const key = `${Math.floor((x + WORLD_HALF) / CHUNK)},${Math.floor((z + WORLD_HALF) / CHUNK)}`;
    let c = chunks.get(key);
    if (!c) chunks.set(key, (c = new Map()));
    let g = c.get(k);
    if (!g) c.set(k, (g = new Geo()));
    return g;
  };

  // ---- roads ---------------------------------------------------------------------
  for (const r of world.net.roads) buildRoad(r, geo, world);
  for (const n of world.net.nodes.values()) buildJunction(n, world, geo);

  // ---- buildings -----------------------------------------------------------------
  const rng = mulberry32(world.seed + 99);
  const roofTints = ["#8a8a8a", "#9a948a", "#7e8388", "#a19a8e"];
  const shingleTints = ["#8b3a2b", "#5a5f66", "#6b4a3a", "#3f4a55", "#9c5a3c"];
  for (const b of world.buildings) buildBuilding(b, facades[b.style], geo, rng, roofTints, shingleTints);

  // ---- ramps ---------------------------------------------------------------------
  for (const r of world.ramps) {
    const fx = Math.sin(r.heading);
    const fz = Math.cos(r.heading);
    const rx = -fz;
    const rz = fx;
    const hw = r.width / 2;
    const P = (a: number, b: number, y: number) => [r.x + fx * a + rx * b, r.base + y, r.z + fz * a + rz * b];
    const top = geo(r.x, r.z, "ramp");
    const side = geo(r.x, r.z, "rampSide");
    const n = new THREE.Vector3(-fx * r.height, r.length, -fz * r.height).normalize();
    top.face([P(0, -hw, 0.03), P(0, hw, 0.03), P(r.length, hw, r.height), P(r.length, -hw, r.height)], [n.x, n.y, n.z], [[0, 0], [r.width / 3, 0], [r.width / 3, r.length / 3], [0, r.length / 3]], WHITE);
    side.face([P(r.length, hw, -0.5), P(r.length, -hw, -0.5), P(r.length, -hw, r.height), P(r.length, hw, r.height)], [fx, 0, fz], [[0, 0], [r.width / 2, 0], [r.width / 2, r.height / 2], [0, r.height / 2]], WHITE);
    side.tri(P(0, hw, 0), P(r.length, hw, -0.5), P(r.length, hw, r.height), [[0, 0], [r.length / 2, 0], [r.length / 2, r.height / 2]], WHITE);
    side.tri(P(0, -hw, 0), P(r.length, -hw, r.height), P(r.length, -hw, -0.5), [[0, 0], [r.length / 2, r.height / 2], [r.length / 2, 0]], WHITE);
  }

  // ---- flush chunks ----------------------------------------------------------------
  for (const [, m] of chunks) {
    for (const [k, g] of m) {
      if (g.count === 0) continue;
      const mesh = new THREE.Mesh(g.build(), material(k));
      const big = styles.includes(k as BuildingStyle) || k === "roof" || k === "shingle" || k === "ramp" || k === "rampSide" || k === "bridge";
      mesh.castShadow = big;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.name = `chunk-${k}`;
      group.add(mesh);
    }
  }

  // ---- terrain + water --------------------------------------------------------------
  group.add(buildTerrain(world, maxAniso));
  const water = buildWater(group);
  group.add(buildFountain(world));

  // ---- props -----------------------------------------------------------------------
  const lamps = buildLamps(world);
  group.add(lamps.group);
  group.add(buildTrees(world));
  group.add(buildBarriers(world));
  group.add(buildPort(world));
  group.add(buildBillboards(world));
  const signals = buildSignals(world);
  group.add(signals.group);
  group.add(buildSigns(world));

  const emissiveMats = Object.values(facadeMats);
  const waterNormals = (water[0].material as THREE.MeshStandardMaterial).normalMap!;
  return {
    group,
    water,
    setNight(n: number) {
      for (const m of emissiveMats) m.emissiveIntensity = n * 1.1;
      lamps.setNight(n);
      signals.setNight(n);
    },
    update(time: number, signalTime: number) {
      waterNormals.offset.set(time * 0.004, time * 0.01);
      signals.update(signalTime);
    },
    breakLamp: lamps.breakLamp,
    resetLamps: lamps.reset,
  };
}

// ---------------------------------------------------------------------------
// Roads
// ---------------------------------------------------------------------------

const PAINT_WHITE = new THREE.Color(0.93, 0.93, 0.9);
const PAINT_YELLOW = new THREE.Color(0.96, 0.74, 0.14);

/** Builds a ribbon between lateral offsets l0..l1 (right-positive) along s0..s1. */
function ribbon(
  r: Road,
  g: (x: number, z: number, k: Mat) => Geo,
  k: Mat,
  l0: number,
  l1: number,
  s0: number,
  s1: number,
  lift: number,
  uScale: number,
  col: THREE.Color,
  step = 4,
  dash?: [number, number],
): void {
  const c = r.center;
  const ss: number[] = [];
  for (let s = s0; s < s1; s += step) ss.push(s);
  ss.push(s1);
  if (ss.length < 2) return;
  interface Edge {
    g: Geo;
    a: number;
    b: number;
    pa: number[];
    pb: number[];
    s: number;
  }
  let prev: Edge | null = null;
  let G: Geo | null = null;
  for (let i = 0; i < ss.length; i++) {
    const s = ss[i];
    if (dash && (s - s0) % (dash[0] + dash[1]) > dash[0] + 1e-6) {
      prev = null;
      continue;
    }
    const p = c.sample(s);
    const t = c.tangent(s);
    const y = r.heightAt(s) + lift;
    const pa = [p.x - t.tz * l0, y, p.z + t.tx * l0];
    const pb = [p.x - t.tz * l1, y, p.z + t.tx * l1];
    // Re-pick the chunk every ~24 samples so long roads split across chunks.
    if (!G || i % 24 === 0) G = g(p.x, p.z, k);
    const ia = G.vert(pa[0], pa[1], pa[2], 0, 1, 0, l0 / uScale, s / uScale, col);
    const ib = G.vert(pb[0], pb[1], pb[2], 0, 1, 0, l1 / uScale, s / uScale, col);
    if (prev) {
      if (prev.g === G) G.quad(prev.a, prev.b, ib, ia);
      else {
        // Chunk boundary: duplicate the previous edge into this chunk.
        const qa = G.vert(prev.pa[0], prev.pa[1], prev.pa[2], 0, 1, 0, l0 / uScale, prev.s / uScale, col);
        const qb = G.vert(prev.pb[0], prev.pb[1], prev.pb[2], 0, 1, 0, l1 / uScale, prev.s / uScale, col);
        G.quad(qa, qb, ib, ia);
      }
    }
    prev = { g: G, a: ia, b: ib, pa, pb, s };
  }
}

/** Vertical wall along a lateral offset (kerb faces, bridge sides). */
function wall(r: Road, g: (x: number, z: number, k: Mat) => Geo, k: Mat, lat: number, s0: number, s1: number, y0: number, y1: number, col: THREE.Color, absolute = false): void {
  const c = r.center;
  const step = 6;
  const side = lat >= 0 ? 1 : -1;
  for (let s = s0; s < s1 - 0.01; s += step) {
    const e = Math.min(s1, s + step);
    const p0 = c.sample(s);
    const p1 = c.sample(e);
    const t0 = c.tangent(s);
    const t1 = c.tangent(e);
    const a = [p0.x - t0.tz * lat, p0.z + t0.tx * lat];
    const b = [p1.x - t1.tz * lat, p1.z + t1.tx * lat];
    const h0 = absolute ? 0 : r.heightAt(s);
    const h1 = absolute ? 0 : r.heightAt(e);
    const nx = -t0.tz * side;
    const nz = t0.tx * side;
    const G = g(p0.x, p0.z, k);
    const pts = side > 0 ? [[a[0], h0 + y0, a[1]], [b[0], h1 + y0, b[1]], [b[0], h1 + y1, b[1]], [a[0], h0 + y1, a[1]]] : [[b[0], h1 + y0, b[1]], [a[0], h0 + y0, a[1]], [a[0], h0 + y1, a[1]], [b[0], h1 + y1, b[1]]];
    G.face(pts, [nx, 0, nz], [[0, 0], [step / 2, 0], [step / 2, (y1 - y0) / 2], [0, (y1 - y0) / 2]], col);
  }
}

function buildRoad(r: Road, g: (x: number, z: number, k: Mat) => Geo, world: World): void {
  const k = r.spec;
  const s0 = Math.max(0, r.s0 - 1);
  const s1 = Math.min(r.length, r.s1 + 1);
  const hw = r.hw;
  // Carriageway.
  ribbon(r, g, "asphalt", -hw, hw, s0, s1, 0.02, 9, WHITE);
  // Sidewalks with kerbs (or bridge walkways).
  if (r.sidewalk > 0) {
    for (const side of [1, -1]) {
      const a = side * hw;
      const b = side * (hw + r.sidewalk);
      ribbon(r, g, "sidewalk", Math.min(a, b), Math.max(a, b), s0, s1, CURB + 0.02, 3, WHITE);
      wall(r, g, "curb", side * hw, s0, s1, 0.0, CURB + 0.02, WHITE);
    }
  }
  // Overpasses / viaducts: deck sides, underside, parapets and column bents.
  // Only where the deck is clearly above the ground (the low ends sit on
  // embankment terrain).
  for (const [o0, o1] of r.overpasses) {
    const ext = hw + r.sidewalk + 0.4;
    const a = Math.max(s0, o0);
    const b = Math.min(s1, o1);
    const grey = new THREE.Color(0.82, 0.82, 0.8);
    for (const side of [1, -1]) {
      wall(r, g, "bridge", side * ext, a, b, -1.4, 0.95, grey);
    }
    ribbon(r, g, "bridge", -ext, ext, a, b, -1.4, 4, new THREE.Color(0.5, 0.5, 0.5));
    // Under-deck face (visible when driving beneath): reversed ribbon.
    for (let s = a; s < b - 0.5; s += 4) {
      const e = Math.min(b, s + 4);
      const p0 = r.center.sample(s);
      const p1 = r.center.sample(e);
      const t0 = r.center.tangent(s);
      const t1 = r.center.tangent(e);
      const y0 = r.heightAt(s) - 1.4;
      const y1 = r.heightAt(e) - 1.4;
      const G = g(p0.x, p0.z, "bridge");
      const A = [p0.x - t0.tz * ext, y0, p0.z + t0.tx * ext];
      const B = [p0.x + t0.tz * ext, y0, p0.z - t0.tx * ext];
      const C = [p1.x + t1.tz * ext, y1, p1.z - t1.tx * ext];
      const D = [p1.x - t1.tz * ext, y1, p1.z + t1.tx * ext];
      G.face([A, D, C, B], [0, -1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]], new THREE.Color(0.42, 0.42, 0.42));
    }
    // Column bents every ~30 m where the deck is > 4 m above the terrain
    // and the column does not land on another road.
    for (let s = a + 12; s < b - 6; s += 30) {
      const p = r.center.sample(s);
      const t = r.center.tangent(s);
      const y = r.heightAt(s) - 1.4;
      for (const lat of r.cls === "freeway" ? [-ext * 0.62, 0, ext * 0.62] : [0]) {
        const x = p.x - t.tz * lat;
        const z = p.z + t.tx * lat;
        const ground = world.terrainAt(x, z);
        if (y - ground < 4) continue;
        let blocked = false;
        for (const o of world.net.roadsAt(x, z)) if (o.road !== r) blocked = true;
        if (world.net.roadAt(x, z, 1.2, ground)?.road !== undefined && world.net.roadAt(x, z, 1.2, ground)!.road !== r) blocked = true;
        if (blocked) continue;
        const G = g(x, z, "bridge");
        boxObb(G, x, z, 0.8, 0.8, Math.atan2(t.tz, t.tx), ground - 0.5, y, grey);
      }
      // Cap beam across the bent.
      const G = g(p.x, p.z, "bridge");
      boxObb(G, p.x, p.z, 0.9, ext * 0.85, Math.atan2(t.tz, t.tx), y - 1.1, y, grey);
    }
  }
  // Bridges: deck underside, sides and piers.
  for (const [b0, b1] of r.bridges) {
    const ext = hw + r.sidewalk + 0.4;
    for (const side of [1, -1]) wall(r, g, "bridge", side * ext, Math.max(s0, b0), Math.min(s1, b1), -1.6, 0.25, new THREE.Color(0.85, 0.85, 0.85));
    ribbon(r, g, "bridge", -ext, ext, Math.max(s0, b0), Math.min(s1, b1), -1.6, 4, new THREE.Color(0.55, 0.55, 0.55));
    for (let s = b0 + 14; s < b1 - 8; s += 26) {
      const p = r.center.sample(s);
      const y = r.heightAt(s);
      const G = g(p.x, p.z, "bridge");
      const t = r.center.tangent(s);
      const ang = Math.atan2(t.tz, t.tx);
      boxObb(G, p.x, p.z, 2.2, ext * 0.8, ang, WATER_LEVEL - 4, y - 1.6, new THREE.Color(0.75, 0.75, 0.75));
    }
  }
  // Road markings.
  const lw = k.laneWidth;
  const mL = k.median / 2;
  const edge = k.oneWay ? (k.lanes * lw) / 2 : mL + k.lanes * lw;
  for (const side of [1, -1]) ribbon(r, g, "paint", side * edge - 0.08, side * edge + 0.08, s0 + 2, s1 - 2, 0.035, 1, PAINT_WHITE, 4);
  if (!k.oneWay) {
    if (r.cls === "freeway" || r.cls === "boulevard") {
      // Painted median edges (yellow), barrier sits between them.
      for (const side of [1, -1]) ribbon(r, g, "paint", side * mL - 0.08, side * mL + 0.08, s0 + 2, s1 - 2, 0.035, 1, PAINT_YELLOW, 4);
      if (r.cls === "boulevard") ribbon(r, g, "concrete", -mL + 0.2, mL - 0.2, s0 + 6, s1 - 6, 0.16, 2, new THREE.Color(0.75, 0.75, 0.72), 4);
    } else if (k.lanes >= 2) {
      for (const side of [-0.17, 0.17]) ribbon(r, g, "paint", side - 0.07, side + 0.07, s0 + 2, s1 - 2, 0.035, 1, PAINT_YELLOW, 4);
    } else {
      ribbon(r, g, "paint", -0.07, 0.07, s0 + 2, s1 - 2, 0.035, 1, PAINT_YELLOW, 2, [4, 5]);
    }
  }
  for (let i = 1; i < k.lanes; i++) {
    for (const side of k.oneWay ? [1] : [1, -1]) {
      const off = k.oneWay ? -(k.lanes * lw) / 2 + i * lw : side * (mL + i * lw);
      ribbon(r, g, "paint", off - 0.07, off + 0.07, s0 + 3, s1 - 3, 0.035, 1, PAINT_WHITE, 2, [3, 9]);
    }
  }
  // Stop lines at signalised / give-way ends.
  for (const [node, atStart] of [
    [r.from, true],
    [r.to, false],
  ] as const) {
    if (node.kind === "priority" && (r.def.main || r.cls === "freeway")) continue;
    const s = atStart ? r.s0 + 1.2 : r.s1 - 1.2;
    // Incoming lanes for that end are on the left (atStart) or right side.
    const sideSign = atStart ? -1 : 1;
    const a = k.oneWay ? -(k.lanes * lw) / 2 : sideSign * mL;
    const b = k.oneWay ? (k.lanes * lw) / 2 : sideSign * (mL + k.lanes * lw);
    if (k.oneWay && atStart) continue;
    const giveWay = node.kind !== "signal";
    ribbon(r, g, "paint", Math.min(a, b), Math.max(a, b), s - 0.25, s + 0.25, 0.04, 1, PAINT_WHITE, 1, giveWay ? undefined : undefined);
    void giveWay;
  }
}

function buildJunction(n: RNode, world: World, g: (x: number, z: number, k: Mat) => Geo): void {
  const segs = 40;
  const R = n.radius + 1.5;
  const y = n.elev + 0.02;
  const G = g(n.x, n.z, "asphalt");
  const c = G.vert(n.x, y, n.z, 0, 1, 0, n.x / 9, n.z / 9, WHITE);
  const ring: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const x = n.x + Math.cos(a) * R;
    const z = n.z + Math.sin(a) * R;
    ring.push(G.vert(x, y, z, 0, 1, 0, x / 9, z / 9, WHITE));
  }
  for (let i = 0; i < segs; i++) G.idx.push(c, ring[(i + 1) % segs], ring[i]);
  // Sidewalk apron around junctions in the city (fills the corners).
  const hasWalk = n.ends.some((e) => e.road.sidewalk > 0);
  if (hasWalk && n.kind !== "roundabout") {
    const W = g(n.x, n.z, "plaza");
    const yi = n.elev + CURB + 0.015;
    const rIn = R;
    const rOut = R + 5;
    const inner: number[] = [];
    const outer: number[] = [];
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      inner.push(W.vert(n.x + Math.cos(a) * rIn, yi - 0.01, n.z + Math.sin(a) * rIn, 0, 1, 0, Math.cos(a) * rIn / 3, Math.sin(a) * rIn / 3, WHITE));
      outer.push(W.vert(n.x + Math.cos(a) * rOut, yi, n.z + Math.sin(a) * rOut, 0, 1, 0, Math.cos(a) * rOut / 3, Math.sin(a) * rOut / 3, WHITE));
    }
    // Only draw apron sectors that are not over a road.
    for (let i = 0; i < segs; i++) {
      const a = ((i + 0.5) / segs) * Math.PI * 2;
      const mx = n.x + Math.cos(a) * (R + 2.5);
      const mz = n.z + Math.sin(a) * (R + 2.5);
      if (world.net.roadAt(mx, mz, 0.5)) continue;
      W.idx.push(inner[i], outer[i + 1], outer[i], inner[i], inner[i + 1], outer[i + 1]);
    }
  }
}

function boxObb(G: Geo, cx: number, cz: number, hx: number, hz: number, ang: number, y0: number, y1: number, col: THREE.Color): void {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const P = (u: number, v: number) => [cx + u * c - v * s, cz + u * s + v * c];
  const corners = [P(hx, hz), P(-hx, hz), P(-hx, -hz), P(hx, -hz)];
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const nx = (a[1] - b[1]);
    const nz = -(a[0] - b[0]);
    const l = Math.hypot(nx, nz) || 1;
    const w = Math.hypot(b[0] - a[0], b[1] - a[1]);
    G.face([[b[0], y0, b[1]], [a[0], y0, a[1]], [a[0], y1, a[1]], [b[0], y1, b[1]]], [-nx / l, 0, -nz / l], [[0, 0], [w / 4, 0], [w / 4, (y1 - y0) / 4], [0, (y1 - y0) / 4]], col);
  }
  G.face([[corners[0][0], y1, corners[0][1]], [corners[3][0], y1, corners[3][1]], [corners[2][0], y1, corners[2][1]], [corners[1][0], y1, corners[1][1]]], [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]], col);
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

function buildBuilding(b: Building, f: T.Facade, g: (x: number, z: number, k: Mat) => Geo, rng: () => number, roofTints: string[], shingleTints: string[]): void {
  const box = b.box;
  const color = new THREE.Color(b.color);
  const ang = Math.atan2(box.s, box.c);
  const G = g(box.cx, box.cz, b.style);
  const R = g(box.cx, box.cz, "roof");
  const uOff = Math.floor(rng() * 8) / 8;
  const roofCol = new THREE.Color(pick(rng, roofTints));
  for (const t of b.tiers) {
    // Walls with world-scaled UVs (texture tiles = window bays).
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const P = (u: number, v: number) => [box.cx + u * c - v * s, box.cz + u * s + v * c];
    const corners = [P(t.hx, t.hz), P(-t.hx, t.hz), P(-t.hx, -t.hz), P(t.hx, -t.hz)];
    const y0 = b.base + t.y0;
    const y1 = b.base + t.y1;
    for (let i = 0; i < 4; i++) {
      const a = corners[i];
      const q = corners[(i + 1) % 4];
      const w = Math.hypot(q[0] - a[0], q[1] - a[1]);
      const nx = (q[1] - a[1]) / w;
      const nz = -(q[0] - a[0]) / w;
      const u0 = uOff;
      const u1 = uOff + w / f.tileW;
      // Corners run counter-clockwise seen from above, so walking q -> a
      // keeps the outside on the right: that order faces outward.
      G.face(
        [
          [q[0], y0, q[1]],
          [a[0], y0, a[1]],
          [a[0], y1, a[1]],
          [q[0], y1, q[1]],
        ],
        [nx, 0, nz],
        [
          [u0, (y0 - b.base) / f.tileH],
          [u1, (y0 - b.base) / f.tileH],
          [u1, (y1 - b.base) / f.tileH],
          [u0, (y1 - b.base) / f.tileH],
        ],
        color,
      );
    }
    if (!b.pitched) {
      R.face(
        [
          [corners[0][0], y1, corners[0][1]],
          [corners[3][0], y1, corners[3][1]],
          [corners[2][0], y1, corners[2][1]],
          [corners[1][0], y1, corners[1][1]],
        ],
        [0, 1, 0],
        [[0, 0], [t.hx / 3, 0], [t.hx / 3, t.hz / 3], [0, t.hz / 3]],
        roofCol,
      );
      if (b.style !== "warehouse") {
        // Parapet.
        boxObbRing(R, box.cx, box.cz, t.hx, t.hz, ang, y1, y1 + 0.9, 0.35, roofCol);
      }
    }
  }
  const top = b.tiers[b.tiers.length - 1];
  for (const rt of b.rooftop) {
    const cx = box.cx + rt.u * box.c - rt.v * box.s;
    const cz = box.cz + rt.u * box.s + rt.v * box.c;
    boxObb(R, cx, cz, rt.w / 2, rt.d / 2, ang, b.base + top.y1, b.base + top.y1 + rt.h, new THREE.Color("#b9bcbf"));
  }
  if (b.spire) boxObb(R, box.cx, box.cz, 0.6, 0.6, ang, b.base + top.y1, b.base + top.y1 + b.spire, new THREE.Color("#cfd3d6"));
  if (b.pitched) {
    const S = g(box.cx, box.cz, "shingle");
    const t = b.tiers[0];
    const y = b.base + t.y1;
    const h = 3;
    const o = 0.45;
    const hx = t.hx + o;
    const hz = t.hz + o;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const P = (u: number, v: number, yy: number) => [box.cx + u * c - v * s, yy, box.cz + u * s + v * c];
    const col = new THREE.Color(pick(rng, shingleTints));
    // Ridge along the u axis (frontage).
    S.face([P(hx, -hz, y), P(-hx, -hz, y), P(-hx, 0, y + h), P(hx, 0, y + h)], [-s * 0, 1, 0], [[0, 0], [hx / 1.5, 0], [hx / 1.5, 2], [0, 2]], col);
    S.face([P(-hx, hz, y), P(hx, hz, y), P(hx, 0, y + h), P(-hx, 0, y + h)], [0, 1, 0], [[0, 0], [hx / 1.5, 0], [hx / 1.5, 2], [0, 2]], col);
    const gable = color.clone().multiplyScalar(1.05);
    const hh = h * (t.hz / hz);
    G.tri(P(t.hx, -t.hz, y), P(t.hx, 0, y + hh), P(t.hx, t.hz, y), [[0, 0], [0.5, 0.2], [1, 0]], gable);
    G.tri(P(-t.hx, t.hz, y), P(-t.hx, 0, y + hh), P(-t.hx, -t.hz, y), [[0, 0], [0.5, 0.2], [1, 0]], gable);
  }
}

function boxObbRing(G: Geo, cx: number, cz: number, hx: number, hz: number, ang: number, y0: number, y1: number, th: number, col: THREE.Color): void {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const edge = (u: number, v: number, ehx: number, ehz: number) => boxObb(G, cx + u * c - v * s, cz + u * s + v * c, ehx, ehz, ang, y0, y1, col);
  edge(0, hz - th / 2, hx, th / 2);
  edge(0, -hz + th / 2, hx, th / 2);
  edge(hx - th / 2, 0, th / 2, hz);
  edge(-hx + th / 2, 0, th / 2, hz);
}

// ---------------------------------------------------------------------------
// Terrain + water
// ---------------------------------------------------------------------------

function buildTerrain(world: World, maxAniso: number): THREE.Mesh {
  const n = world.terrainN;
  const pos = new Float32Array(n * n * 3);
  const col = new Float32Array(n * n * 3);
  const uv = new Float32Array(n * n * 2);
  const grassA = new THREE.Color("#5c8a3a");
  const grassB = new THREE.Color("#86a352");
  const forest = new THREE.Color("#3f5f2a");
  const rock = new THREE.Color("#8b8378");
  const snow = new THREE.Color("#e9eef2");
  const sand = new THREE.Color("#d6c391");
  const mud = new THREE.Color("#6b5d45");
  const urban = new THREE.Color("#7c8a6a");
  const c = new THREE.Color();
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -WORLD_HALF + i * TERRAIN_STEP;
      const z = -WORLD_HALF + j * TERRAIN_STEP;
      const h = world.terrain[j * n + i];
      const k = (j * n + i) * 3;
      // Sink the terrain a touch under roads to avoid z-fighting.
      const onRoad = world.net.nodeAt(x, z) || world.net.roadAt(x, z, 0.5);
      pos[k] = x;
      pos[k + 1] = onRoad ? h - 0.25 : h;
      pos[k + 2] = z;
      uv[(j * n + i) * 2] = x / 12;
      uv[(j * n + i) * 2 + 1] = z / 12;
      const hx = world.terrain[j * n + Math.min(n - 1, i + 1)] - world.terrain[j * n + Math.max(0, i - 1)];
      const hz = world.terrain[Math.min(n - 1, j + 1) * n + i] - world.terrain[Math.max(0, j - 1) * n + i];
      const slope = Math.hypot(hx, hz) / (2 * TERRAIN_STEP);
      const e = -x;
      const d = world.districtOf(x, z);
      c.copy(grassA).lerp(grassB, fbm(x / 90, z / 90));
      if (d === "highlands" || d === "hillcrest") c.lerp(forest, 0.45);
      if (d === "downtown" || d === "midtown" || d === "oldtown" || d === "southside") c.lerp(urban, 0.35);
      if (d === "ironworks" || d === "port") c.lerp(mud, 0.4);
      c.lerp(rock, Math.min(1, Math.max(0, (slope - 0.32) * 2.5)));
      if (h > 120) c.lerp(snow, Math.min(1, (h - 120) / 25));
      const inland = z - coastN(e);
      if (inland < 60) c.lerp(sand, Math.min(1, Math.max(0, 1 - inland / 60)) * 0.9);
      if (freshWaterDistance(e, z) < 10) c.lerp(mud, 0.6);
      col[k] = c.r;
      col[k + 1] = c.g;
      col[k + 2] = c.b;
    }
  }
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let p = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const cc = a + n;
      const d = cc + 1;
      idx[p++] = a;
      idx[p++] = cc;
      idx[p++] = b;
      idx[p++] = b;
      idx[p++] = cc;
      idx[p++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  const t = T.grass();
  t.anisotropy = maxAniso;
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: t, vertexColors: true, roughness: 1 }));
  mesh.receiveShadow = true;
  mesh.name = "terrain";
  return mesh;
}

function buildWater(group: THREE.Group): THREE.Mesh[] {
  const normals = T.waterNormals();
  normals.repeat.set(80, 80);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x1f5570,
    roughness: 0.05,
    metalness: 0.1,
    normalMap: normals,
    normalScale: new THREE.Vector2(0.35, 0.35),
    envMapIntensity: 1.2,
    transparent: true,
    opacity: 0.92,
  });
  // One big plane at water level: the terrain is carved below it wherever
  // there is sea, river or lake, and stays above it everywhere else.
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_HALF * 6, WORLD_HALF * 6), mat);
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = WATER_LEVEL;
  plane.receiveShadow = true;
  plane.name = "water";
  group.add(plane);
  void RIVER;
  void RIVER_HALF;
  void LAKE;
  void toWorld;
  return [plane];
}

function buildFountain(world: World): THREE.Group {
  const g = new THREE.Group();
  const y = world.net.nodes.get("rb-N")!.elev;
  const c = world.circle;
  const R = world.islandR;
  const grass = new THREE.Mesh(new THREE.CylinderGeometry(R, R + 0.3, 0.35, 64), new THREE.MeshStandardMaterial({ map: T.grass(), color: 0x7aa05a, roughness: 1 }));
  grass.position.set(c.x, y + 0.17, c.z);
  grass.receiveShadow = true;
  const kerb = new THREE.Mesh(new THREE.TorusGeometry(R + 0.1, 0.25, 6, 64), new THREE.MeshStandardMaterial({ color: 0xcfcfcf, roughness: 0.8 }));
  kerb.rotation.x = Math.PI / 2;
  kerb.position.set(c.x, y + 0.2, c.z);
  const basinMat = new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.7 });
  const bR = Math.min(14, R * 0.55);
  const basin = new THREE.Mesh(new THREE.CylinderGeometry(bR, bR + 0.5, 0.9, 48, 1, true), basinMat);
  basin.position.set(c.x, y + 0.6, c.z);
  const pool = new THREE.Mesh(new THREE.CircleGeometry(bR - 0.1, 48), new THREE.MeshStandardMaterial({ color: 0x3d7f9a, roughness: 0.05, metalness: 0.2 }));
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(c.x, y + 0.85, c.z);
  const column = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 2.2, 7, 16), basinMat);
  column.position.set(c.x, y + 4, c.z);
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 1.2, 1.2, 24), basinMat);
  bowl.position.set(c.x, y + 7.6, c.z);
  const statue = new THREE.Mesh(new THREE.ConeGeometry(0.9, 4.5, 6), new THREE.MeshStandardMaterial({ color: 0xb08d57, metalness: 0.8, roughness: 0.35 }));
  statue.position.set(c.x, y + 10.4, c.z);
  for (const m of [basin, column, bowl, statue]) m.castShadow = true;
  g.add(grass, kerb, basin, pool, column, bowl, statue);
  return g;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

function buildLamps(world: World) {
  const group = new THREE.Group();
  const lamps = world.lamps;
  const n = Math.max(1, lamps.length);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3b4046, roughness: 0.5, metalness: 0.7 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0x777777, emissive: 0xffd9a0, emissiveIntensity: 0, roughness: 0.4 });
  const pole = new THREE.CylinderGeometry(0.09, 0.14, 8, 8);
  pole.translate(0, 4, 0);
  const arm = new THREE.BoxGeometry(0.1, 0.1, 2.2);
  arm.translate(0, 7.9, 1.1);
  const head = new THREE.BoxGeometry(0.5, 0.14, 0.9);
  head.translate(0, 7.8, 2.1);
  const poles = new THREE.InstancedMesh(pole, poleMat, n);
  const arms = new THREE.InstancedMesh(arm, poleMat, n);
  const heads = new THREE.InstancedMesh(head, headMat, n);
  // Median lamps have two arms (back to back) - a second arm/head set.
  const arms2 = new THREE.InstancedMesh(arm, poleMat, n);
  const heads2 = new THREE.InstancedMesh(head, headMat, n);
  poles.castShadow = true;
  const poolTex = T.radial("rgba(255,214,150,0.55)", "rgba(255,214,150,0)", 128);
  const poolMat = new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const poolGeo = new THREE.PlaneGeometry(11, 11);
  poolGeo.rotateX(-Math.PI / 2);
  poolGeo.translate(0, 0.06, 2.6);
  const pools = new THREE.InstancedMesh(poolGeo, poolMat, n);
  const pools2 = new THREE.InstancedMesh(poolGeo, poolMat, n);
  const index = new Map<number, number>();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const place = (i: number, fallen: boolean) => {
    const l = lamps[i];
    q.setFromAxisAngle(up, l.rot);
    if (fallen) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.45));
    m.compose(new THREE.Vector3(l.x, l.y, l.z), q, one);
    poles.setMatrixAt(i, m);
    arms.setMatrixAt(i, m);
    heads.setMatrixAt(i, m);
    const dual = l.scale < 0;
    if (dual) {
      const q2 = q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(up, Math.PI));
      const m2 = new THREE.Matrix4().compose(new THREE.Vector3(l.x, l.y, l.z), q2, one);
      arms2.setMatrixAt(i, m2);
      heads2.setMatrixAt(i, m2);
      if (fallen) pools2.setMatrixAt(i, zero);
      else pools2.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(l.x, l.y, l.z), new THREE.Quaternion().setFromAxisAngle(up, l.rot + Math.PI), one));
    } else {
      arms2.setMatrixAt(i, zero);
      heads2.setMatrixAt(i, zero);
      pools2.setMatrixAt(i, zero);
    }
    if (fallen) pools.setMatrixAt(i, zero);
    else pools.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(l.x, l.y, l.z), new THREE.Quaternion().setFromAxisAngle(up, l.rot), one));
  };
  lamps.forEach((l, i) => {
    place(i, false);
    if (l.collider) index.set(l.collider.id, i);
  });
  const all = [poles, arms, heads, arms2, heads2, pools, pools2];
  for (const im of all) im.count = lamps.length;
  group.add(...all);
  const dirty = () => {
    for (const im of all) {
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
    }
  };
  dirty();
  return {
    group,
    setNight(v: number) {
      headMat.emissiveIntensity = v * 6;
      poolMat.opacity = v * 0.6;
      pools.visible = pools2.visible = v > 0.02;
    },
    breakLamp(c: CircleCollider) {
      const i = index.get(c.id);
      if (i === undefined) return;
      place(i, true);
      dirty();
    },
    reset() {
      lamps.forEach((l, i) => {
        if (l.collider) l.collider.broken = false;
        place(i, false);
      });
      dirty();
    },
  };
}

function buildTrees(world: World): THREE.Group {
  const group = new THREE.Group();
  const rng = mulberry32(5);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const c = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  // Broadleaf.
  {
    const n = Math.max(1, world.trees.length);
    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.26, 3, 6);
    trunkGeo.translate(0, 1.5, 0);
    const crownGeo = new THREE.IcosahedronGeometry(2.2, 1);
    crownGeo.translate(0, 4.6, 0);
    const crown2Geo = new THREE.IcosahedronGeometry(1.6, 1);
    crown2Geo.translate(0.6, 6.0, -0.3);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5a4030, roughness: 1 }), n);
    const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });
    const crowns = new THREE.InstancedMesh(crownGeo, leafMat, n);
    const crowns2 = new THREE.InstancedMesh(crown2Geo, leafMat, n);
    const palette = ["#3e6a26", "#4b7a2e", "#335a22", "#5a8231", "#466b25", "#64782a"];
    world.trees.forEach((t, i) => {
      q.setFromAxisAngle(up, t.rot);
      m.compose(new THREE.Vector3(t.x, t.y, t.z), q, new THREE.Vector3(t.scale, t.scale * range(rng, 0.9, 1.2), t.scale));
      trunks.setMatrixAt(i, m);
      crowns.setMatrixAt(i, m);
      crowns2.setMatrixAt(i, m);
      c.set(pick(rng, palette));
      crowns.setColorAt(i, c);
      crowns2.setColorAt(i, c.multiplyScalar(1.12));
    });
    for (const im of [trunks, crowns, crowns2]) {
      im.count = world.trees.length;
      im.castShadow = true;
      im.receiveShadow = true;
      im.computeBoundingSphere();
    }
    group.add(trunks, crowns, crowns2);
  }
  // Conifers.
  {
    const n = Math.max(1, world.pines.length);
    const trunkGeo = new THREE.CylinderGeometry(0.14, 0.24, 2.2, 6);
    trunkGeo.translate(0, 1.1, 0);
    const cone1 = new THREE.ConeGeometry(2.4, 4.2, 7);
    cone1.translate(0, 3.8, 0);
    const cone2 = new THREE.ConeGeometry(1.8, 3.6, 7);
    cone2.translate(0, 6.0, 0);
    const cone3 = new THREE.ConeGeometry(1.1, 2.8, 7);
    cone3.translate(0, 8.0, 0);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x4a3426, roughness: 1 }), n);
    const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });
    const c1 = new THREE.InstancedMesh(cone1, leafMat, n);
    const c2 = new THREE.InstancedMesh(cone2, leafMat, n);
    const c3 = new THREE.InstancedMesh(cone3, leafMat, n);
    const palette = ["#2d4f2a", "#36592f", "#264526", "#3c5f34", "#2f4a2c"];
    world.pines.forEach((t, i) => {
      q.setFromAxisAngle(up, t.rot);
      m.compose(new THREE.Vector3(t.x, t.y, t.z), q, new THREE.Vector3(t.scale, t.scale * range(rng, 1.0, 1.4), t.scale));
      for (const im of [trunks, c1, c2, c3]) im.setMatrixAt(i, m);
      c.set(pick(rng, palette));
      c1.setColorAt(i, c);
      c2.setColorAt(i, c.clone().multiplyScalar(1.08));
      c3.setColorAt(i, c.clone().multiplyScalar(1.16));
    });
    for (const im of [trunks, c1, c2, c3]) {
      im.count = world.pines.length;
      im.castShadow = true;
      im.receiveShadow = true;
      im.computeBoundingSphere();
    }
    group.add(trunks, c1, c2, c3);
  }
  return group;
}

function buildBarriers(world: World): THREE.Group {
  const group = new THREE.Group();
  const jersey = world.barriers.filter((b) => b.kind === "jersey");
  const rails = world.barriers.filter((b) => b.kind === "rail");
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  // Jersey barrier: trapezoid profile extruded along x.
  const shape = new THREE.Shape();
  shape.moveTo(-0.32, 0);
  shape.lineTo(0.32, 0);
  shape.lineTo(0.12, 0.3);
  shape.lineTo(0.09, 0.85);
  shape.lineTo(-0.09, 0.85);
  shape.lineTo(-0.12, 0.3);
  shape.closePath();
  const jg = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
  jg.translate(0, 0, -0.5);
  jg.rotateY(Math.PI / 2);
  const jm = new THREE.InstancedMesh(jg, new THREE.MeshStandardMaterial({ map: T.concrete(), color: 0xd0d0cc, roughness: 0.9 }), Math.max(1, jersey.length));
  jersey.forEach((b, i) => {
    q.setFromAxisAngle(up, -Math.atan2(b.box.s, b.box.c));
    m.compose(new THREE.Vector3(b.box.cx, b.y0, b.box.cz), q, new THREE.Vector3(b.box.hx * 2, 1, 1));
    jm.setMatrixAt(i, m);
  });
  jm.count = jersey.length;
  jm.castShadow = jm.receiveShadow = true;
  jm.computeBoundingSphere();
  // Guard rail: W-beam + posts.
  const beam = new THREE.BoxGeometry(1, 0.32, 0.08);
  beam.translate(0, 0.6, 0);
  const post = new THREE.BoxGeometry(0.12, 0.75, 0.12);
  post.translate(0.45, 0.37, 0.06);
  const railMat = new THREE.MeshStandardMaterial({ color: 0xc4c8cc, metalness: 0.8, roughness: 0.35 });
  const rm = new THREE.InstancedMesh(beam, railMat, Math.max(1, rails.length));
  const pm = new THREE.InstancedMesh(post, new THREE.MeshStandardMaterial({ color: 0x6d7178, metalness: 0.5, roughness: 0.6 }), Math.max(1, rails.length));
  rails.forEach((b, i) => {
    q.setFromAxisAngle(up, -Math.atan2(b.box.s, b.box.c));
    m.compose(new THREE.Vector3(b.box.cx, b.y0, b.box.cz), q, new THREE.Vector3(b.box.hx * 2, 1, 1));
    rm.setMatrixAt(i, m);
    pm.setMatrixAt(i, m);
  });
  rm.count = pm.count = rails.length;
  for (const im of [rm, pm]) {
    im.castShadow = true;
    im.computeBoundingSphere();
  }
  group.add(jm, rm, pm);
  return group;
}

function buildPort(world: World): THREE.Group {
  const group = new THREE.Group();
  const cTex = T.corrugated();
  cTex.wrapS = cTex.wrapT = THREE.ClampToEdgeWrapping;
  const geo = new THREE.BoxGeometry(12.2, 2.6, 2.44);
  geo.translate(0, 1.3, 0);
  const cont = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ map: cTex, roughness: 0.6, metalness: 0.3 }), Math.max(1, world.containers.length));
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  world.containers.forEach((k, i) => {
    m.makeRotationY(-k.rot);
    m.setPosition(k.x, k.y, k.z);
    cont.setMatrixAt(i, m);
    cont.setColorAt(i, c.set(k.color));
  });
  cont.count = world.containers.length;
  cont.castShadow = cont.receiveShadow = true;
  cont.computeBoundingSphere();
  group.add(cont);

  const tankGeo = new THREE.CylinderGeometry(1, 1, 1, 28);
  tankGeo.translate(0, 0.5, 0);
  const tankMat = new THREE.MeshStandardMaterial({ color: 0xd9dcdf, roughness: 0.35, metalness: 0.6 });
  const tanks = new THREE.InstancedMesh(tankGeo, tankMat, Math.max(1, world.tanks.length));
  const domeGeo = new THREE.SphereGeometry(1, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  domeGeo.scale(1, 0.18, 1);
  const domes = new THREE.InstancedMesh(domeGeo, tankMat, Math.max(1, world.tanks.length));
  world.tanks.forEach((t, i) => {
    m.makeScale(t.r, t.h, t.r);
    m.setPosition(t.x, t.y, t.z);
    tanks.setMatrixAt(i, m);
    m.makeScale(t.r, t.r, t.r);
    m.setPosition(t.x, t.y + t.h, t.z);
    domes.setMatrixAt(i, m);
  });
  tanks.count = domes.count = world.tanks.length;
  for (const im of [tanks, domes]) {
    im.castShadow = im.receiveShadow = true;
    im.computeBoundingSphere();
  }
  group.add(tanks, domes);

  const craneMat = new THREE.MeshStandardMaterial({ color: 0xd9531e, roughness: 0.6, metalness: 0.4 });
  for (const cr of world.cranes) {
    const g = new THREE.Group();
    const leg = new THREE.BoxGeometry(1.2, 40, 1.2);
    for (const [x, z] of [
      [-8, -6],
      [8, -6],
      [-8, 6],
      [8, 6],
    ]) {
      const l = new THREE.Mesh(leg, craneMat);
      l.position.set(x, 20, z);
      g.add(l);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.4, 70), craneMat);
    beam.position.set(0, 40, -18);
    g.add(beam);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 4), new THREE.MeshStandardMaterial({ color: 0xe8e8e8 }));
    cab.position.set(0, 37.5, -10);
    g.add(cab);
    for (const s of [-1, 1]) {
      const cross = new THREE.Mesh(new THREE.BoxGeometry(17, 1.2, 1.2), craneMat);
      cross.position.set(0, 36, s * 6);
      g.add(cross);
    }
    g.position.set(cr.x, cr.y, cr.z);
    g.traverse((o) => (o.castShadow = true));
    group.add(g);
  }
  return group;
}

function buildBillboards(world: World): THREE.Group {
  const group = new THREE.Group();
  const cache = new Map<string, THREE.Texture>();
  let k = 0;
  for (const b of world.buildings) {
    const bb = b.billboard;
    if (!bb) continue;
    const key = `${bb.color}-${k % 5}`;
    let t = cache.get(key);
    if (!t) cache.set(key, (t = T.billboard(bb.color, 300 + k)));
    k++;
    const top = b.tiers[b.tiers.length - 1];
    const y = b.base + top.y1;
    const ang = Math.atan2(b.box.s, b.box.c);
    const mat = new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.5 });
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(bb.w, bb.h), mat);
    // Face the street: the -v side of the footprint (towards the road).
    const nx = -(-b.box.s);
    const nz = -b.box.c;
    void nx;
    void nz;
    panel.position.set(b.box.cx, y + bb.h / 2 + 1.4, b.box.cz);
    panel.rotation.y = -ang + Math.PI;
    const back = new THREE.Mesh(new THREE.BoxGeometry(bb.w + 0.4, bb.h + 0.4, 0.3), new THREE.MeshStandardMaterial({ color: 0x222428, roughness: 0.6, metalness: 0.6 }));
    back.position.copy(panel.position);
    back.rotation.y = panel.rotation.y;
    back.translateZ(-0.2);
    back.castShadow = true;
    const legs = new THREE.Mesh(new THREE.BoxGeometry(bb.w * 0.6, 1.6, 0.2), back.material);
    legs.position.set(b.box.cx, y + 0.8, b.box.cz);
    legs.rotation.y = panel.rotation.y;
    group.add(back, panel, legs);
  }
  void obbCorners;
  return group;
}

/** Traffic lights at signalised junctions: a pole per approach with 3 lamps. */
function buildSignals(world: World) {
  const group = new THREE.Group();
  interface Head {
    node: RNode;
    group: number;
    mats: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial, THREE.MeshStandardMaterial];
  }
  const heads: Head[] = [];
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2f3338, roughness: 0.5, metalness: 0.6 });
  const boxMat = new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.6 });
  const lampGeo = new THREE.CircleGeometry(0.14, 12);
  const colors = [0xff2a1a, 0xffb000, 0x22e06a];
  for (const conn of world.net.conns) {
    if (conn.group < 0 || conn.from!.index !== conn.from!.road!.spec.lanes - 1 || conn.turn !== "right") continue;
    const node = conn.node!;
    if (heads.some((h) => h.node === node && h.group === conn.group && h.mats[0].userData.road === conn.from!.road!.id + conn.from!.dir)) continue;
    // Pole at the right kerb of the approach, just before the stop line.
    const lane = conn.from!;
    const p = lane.poly.sample(lane.length - 1);
    const t = lane.poly.tangent(lane.length - 1);
    const r = lane.road!;
    const lat = r.hw - r.laneOffset(lane.index) + 1.2;
    const x = p.x - t.tz * lat;
    const z = p.z + t.tx * lat;
    const y = r.heightAt(lane.dir > 0 ? r.s1 : r.s0) + (r.sidewalk > 0 ? CURB : 0);
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 5.6, 8), poleMat);
    pole.position.y = 2.8;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, lat + r.laneOffset(lane.index) * 0.2), poleMat);
    arm.position.set(0, 5.4, (lat) / 2);
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.45, 1.25, 0.32), boxMat);
    box.position.set(0, 4.6, lat - 0.3);
    g.add(pole, arm, box);
    const mats = colors.map((c) => new THREE.MeshStandardMaterial({ color: 0x111111, emissive: c, emissiveIntensity: 0 })) as Head["mats"];
    mats.forEach((mm, i) => {
      const l = new THREE.Mesh(lampGeo, mm);
      // Lamps face oncoming traffic (-forward).
      l.position.set(0, 4.98 - i * 0.38, lat - 0.3 - 0.17);
      l.rotation.y = Math.PI;
      g.add(l);
    });
    mats[0].userData.road = conn.from!.road!.id + conn.from!.dir;
    // Orient: local +Z = across the road (to the left of travel), facing back.
    g.position.set(x, y, z);
    g.rotation.y = Math.atan2(t.tz, -t.tx) + Math.PI;
    pole.castShadow = box.castShadow = true;
    group.add(g);
    heads.push({ node, group: conn.group, mats });
  }
  let night = 0;
  return {
    group,
    setNight(n: number) {
      night = n;
    },
    update(time: number) {
      for (const h of heads) {
        const s: Light = signalState(h.node, h.group, time);
        const on = [s === "red", s === "yellow", s === "green"];
        h.mats.forEach((m, i) => {
          m.emissiveIntensity = on[i] ? 3 + night * 3 : 0.04;
        });
      }
    },
  };
}

/** Street name signs at the start of named roads in the city. */
function buildSigns(world: World): THREE.Group {
  const group = new THREE.Group();
  const done = new Set<string>();
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x8c9196, metalness: 0.6, roughness: 0.4 });
  for (const r of world.net.roads) {
    if (r.cls === "ring" || r.sidewalk === 0 || done.has(r.name)) continue;
    done.add(r.name);
    const s = r.s0 + 6;
    const p = r.center.sample(s);
    const t = r.center.tangent(s);
    const lat = r.hw + 1.2;
    const x = p.x - t.tz * lat;
    const z = p.z + t.tx * lat;
    if (world.buildingAt(x, z)) continue;
    const y = r.heightAt(s) + CURB;
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 48;
    const g = c.getContext("2d")!;
    g.fillStyle = "#1f6b3a";
    g.fillRect(0, 0, 256, 48);
    g.strokeStyle = "#fff";
    g.lineWidth = 3;
    g.strokeRect(3, 3, 250, 42);
    g.fillStyle = "#fff";
    g.font = "bold 26px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(r.name, 128, 25);
    const tx = new THREE.CanvasTexture(c);
    tx.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.45), new THREE.MeshStandardMaterial({ map: tx, side: THREE.DoubleSide, roughness: 0.6 }));
    sign.position.set(x, y + 2.9, z);
    sign.rotation.y = Math.atan2(t.tx, t.tz) + Math.PI / 2;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.1, 6), poleMat);
    pole.position.set(x, y + 1.55, z);
    group.add(sign, pole);
  }
  return group;
}
