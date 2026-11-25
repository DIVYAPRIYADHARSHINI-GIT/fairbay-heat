/**
 * Turns the `City` data into renderable Three.js meshes.
 *
 * Performance strategy (thousands of objects, one draw call budget):
 *  - Buildings, block slabs and road markings are merged per material into
 *    240 m chunks, so a whole district is a handful of draw calls but the
 *    renderer can still frustum-cull chunks behind the camera.
 *  - Repeated props (lamps, trees, containers, tanks) are InstancedMeshes.
 *  - Night lighting is emissive windows + bloom + additive light-pool decals,
 *    not hundreds of real lights.
 */

import * as THREE from "three";
import {
  CITY,
  CITY_EDGE,
  CURB,
  GRID,
  LINES,
  SEAWALL_Z,
  SIDEWALK,
  TERRAIN_STEP,
  WORLD,
  fbm,
  lineCoord,
  roadWidth,
  type Building,
  type BuildingStyle,
  type City,
} from "../game/city";
import { mulberry32, pick, range } from "../core/math";
import * as T from "./textures";
import type { CircleCollider } from "../game/collision";

class GeoBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];

  /** Adds a quad a-b-c-d (counter-clockwise seen from the front). */
  quad(
    a: number[],
    b: number[],
    c: number[],
    d: number[],
    n: number[],
    uvs: number[][],
    color: THREE.Color,
  ): void {
    const base = this.pos.length / 3;
    for (const [p, t] of [
      [a, uvs[0]],
      [b, uvs[1]],
      [c, uvs[2]],
      [d, uvs[3]],
    ] as const) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(n[0], n[1], n[2]);
      this.uv.push(t[0], t[1]);
      this.col.push(color.r, color.g, color.b);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  tri(a: number[], b: number[], c: number[], uvs: number[][], color: THREE.Color): void {
    const base = this.pos.length / 3;
    const n = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2])
      .cross(new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]))
      .normalize();
    for (const [p, t] of [
      [a, uvs[0]],
      [b, uvs[1]],
      [c, uvs[2]],
    ] as const) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(n.x, n.y, n.z);
      this.uv.push(t[0], t[1]);
      this.col.push(color.r, color.g, color.b);
    }
    this.idx.push(base, base + 1, base + 2);
  }

  /** A box's 4 walls (+ optional top) with world-scaled UVs. */
  walls(
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
    y0: number,
    y1: number,
    tileW: number,
    tileH: number,
    color: THREE.Color,
    uOff = 0,
  ): void {
    const v0 = y0 / tileH;
    const v1 = y1 / tileH;
    const w = (maxX - minX) / tileW;
    const d = (maxZ - minZ) / tileW;
    // +Z face
    this.quad([minX, y0, maxZ], [maxX, y0, maxZ], [maxX, y1, maxZ], [minX, y1, maxZ], [0, 0, 1], [[uOff, v0], [uOff + w, v0], [uOff + w, v1], [uOff, v1]], color);
    // -Z face
    this.quad([maxX, y0, minZ], [minX, y0, minZ], [minX, y1, minZ], [maxX, y1, minZ], [0, 0, -1], [[uOff, v0], [uOff + w, v0], [uOff + w, v1], [uOff, v1]], color);
    // +X face
    this.quad([maxX, y0, maxZ], [maxX, y0, minZ], [maxX, y1, minZ], [maxX, y1, maxZ], [1, 0, 0], [[uOff, v0], [uOff + d, v0], [uOff + d, v1], [uOff, v1]], color);
    // -X face
    this.quad([minX, y0, minZ], [minX, y0, maxZ], [minX, y1, maxZ], [minX, y1, minZ], [-1, 0, 0], [[uOff, v0], [uOff + d, v0], [uOff + d, v1], [uOff, v1]], color);
  }

  top(minX: number, maxX: number, minZ: number, maxZ: number, y: number, tile: number, color: THREE.Color): void {
    this.quad(
      [minX, y, maxZ],
      [maxX, y, maxZ],
      [maxX, y, minZ],
      [minX, y, minZ],
      [0, 1, 0],
      [
        [minX / tile, maxZ / tile],
        [maxX / tile, maxZ / tile],
        [maxX / tile, minZ / tile],
        [minX / tile, minZ / tile],
      ],
      color,
    );
  }

  box(minX: number, maxX: number, minZ: number, maxZ: number, y0: number, y1: number, tile: number, color: THREE.Color): void {
    this.walls(minX, maxX, minZ, maxZ, y0, y1, tile, tile, color);
    this.top(minX, maxX, minZ, maxZ, y1, tile, color);
  }

  get empty(): boolean {
    return this.idx.length === 0;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const CHUNK = 240;

type MatKey = BuildingStyle | "roof" | "shingle" | "sidewalk" | "grass" | "gravel" | "curb" | "marking" | "concrete" | "ramp" | "rampSide";

export interface CityView {
  group: THREE.Group;
  setNight(n: number): void;
  update(time: number, camera: THREE.Camera): void;
  breakLamp(c: CircleCollider): void;
  /** Re-stands every knocked-over lamp (used on respawn / reset). */
  resetLamps(): void;
  water: THREE.Mesh;
}

export function buildCityView(city: City, maxAniso: number): CityView {
  const group = new THREE.Group();
  group.name = "city";

  // ---- materials ---------------------------------------------------------------
  const styles: BuildingStyle[] = ["glass", "office", "brick", "house", "warehouse"];
  const facades = Object.fromEntries(styles.map((s) => [s, T.facade(s)])) as Record<BuildingStyle, T.Facade>;
  const facadeMats = {} as Record<BuildingStyle, THREE.MeshStandardMaterial>;
  for (const s of styles) {
    const f = facades[s];
    for (const t of [f.map, f.emissive, f.rough]) t.anisotropy = maxAniso;
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
  const tex = (t: THREE.Texture) => {
    t.anisotropy = maxAniso;
    return t;
  };
  const mats: Record<Exclude<MatKey, BuildingStyle>, THREE.Material> = {
    roof: new THREE.MeshStandardMaterial({ map: tex(T.roofTex()), vertexColors: true, roughness: 0.95 }),
    shingle: new THREE.MeshStandardMaterial({ map: tex(T.shingles()), vertexColors: true, roughness: 0.85 }),
    sidewalk: new THREE.MeshStandardMaterial({ map: tex(T.sidewalk()), vertexColors: true, roughness: 0.9 }),
    grass: new THREE.MeshStandardMaterial({ map: tex(T.grass()), vertexColors: true, roughness: 1 }),
    gravel: new THREE.MeshStandardMaterial({ map: tex(T.gravel()), vertexColors: true, roughness: 1 }),
    curb: new THREE.MeshStandardMaterial({ map: tex(T.concrete()), vertexColors: true, roughness: 0.9 }),
    concrete: new THREE.MeshStandardMaterial({ map: tex(T.concrete()), vertexColors: true, roughness: 0.85 }),
    marking: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    ramp: new THREE.MeshStandardMaterial({ map: tex(T.concrete()), vertexColors: true, roughness: 0.6, metalness: 0.4 }),
    rampSide: new THREE.MeshStandardMaterial({ map: tex(T.hazardStripes()), vertexColors: true, roughness: 0.7 }),
  };
  const material = (k: MatKey): THREE.Material => (styles.includes(k as BuildingStyle) ? facadeMats[k as BuildingStyle] : mats[k as Exclude<MatKey, BuildingStyle>]);

  const chunks = new Map<string, Map<MatKey, GeoBuilder>>();
  const builder = (x: number, z: number, k: MatKey): GeoBuilder => {
    const key = `${Math.floor((x + WORLD) / CHUNK)},${Math.floor((z + WORLD) / CHUNK)}`;
    let c = chunks.get(key);
    if (!c) chunks.set(key, (c = new Map()));
    let g = c.get(k);
    if (!g) c.set(k, (g = new GeoBuilder()));
    return g;
  };

  const white = new THREE.Color(1, 1, 1);
  const rng = mulberry32(city.seed + 99);

  // ---- road surface ----------------------------------------------------------
  const asphaltTex = tex(T.asphalt());
  asphaltTex.repeat.set((CITY_EDGE * 2) / 9, (CITY_EDGE * 2) / 9);
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(CITY_EDGE * 2, CITY_EDGE * 2),
    new THREE.MeshStandardMaterial({ map: asphaltTex, roughness: 0.88, metalness: 0.0, color: 0xb8b8b8 }),
  );
  road.rotation.x = -Math.PI / 2;
  road.receiveShadow = true;
  road.name = "road";
  group.add(road);

  // ---- block slabs (sidewalks, lawns, yards) ---------------------------------
  for (const b of city.blocks) {
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const tint = new THREE.Color(1, 1, 1).multiplyScalar(range(rng, 0.92, 1.04));
    // Curb sides.
    builder(cx, cz, "curb").walls(b.minX, b.maxX, b.minZ, b.maxZ, 0, CURB, 2, 2, white);
    const inner = b.district === "park" || b.district === "northshore" ? "grass" : b.district === "ironworks" || b.district === "port" ? "gravel" : "sidewalk";
    if (inner === "sidewalk") {
      builder(cx, cz, "sidewalk").top(b.minX, b.maxX, b.minZ, b.maxZ, CURB, 3, tint);
    } else {
      const s = SIDEWALK;
      const sw = builder(cx, cz, "sidewalk");
      sw.top(b.minX, b.maxX, b.maxZ - s, b.maxZ, CURB, 3, tint);
      sw.top(b.minX, b.maxX, b.minZ, b.minZ + s, CURB, 3, tint);
      sw.top(b.minX, b.minX + s, b.minZ + s, b.maxZ - s, CURB, 3, tint);
      sw.top(b.maxX - s, b.maxX, b.minZ + s, b.maxZ - s, CURB, 3, tint);
      const g = new THREE.Color(1, 1, 1).multiplyScalar(range(rng, 0.85, 1.05));
      builder(cx, cz, inner).top(b.minX + s, b.maxX - s, b.minZ + s, b.maxZ - s, CURB, inner === "grass" ? 6 : 5, g);
    }
  }

  // ---- buildings ---------------------------------------------------------------
  const roofTints = ["#8a8a8a", "#9a948a", "#7e8388", "#a19a8e"];
  const shingleTints = ["#8b3a2b", "#5a5f66", "#6b4a3a", "#3f4a55", "#9c5a3c"];
  for (const bd of city.buildings) {
    const t0 = bd.tiers[0];
    const cx = (t0.minX + t0.maxX) / 2;
    const cz = (t0.minZ + t0.maxZ) / 2;
    const f = facades[bd.style];
    const color = new THREE.Color(bd.color);
    const fb = builder(cx, cz, bd.style);
    const uOff = Math.floor(rng() * 8) / 8;
    for (const t of bd.tiers) fb.walls(t.minX, t.maxX, t.minZ, t.maxZ, t.y0 + CURB, t.y1, f.tileW, f.tileH, color, uOff);
    const roofCol = new THREE.Color(pick(rng, roofTints));
    const rb = builder(cx, cz, "roof");
    for (const t of bd.tiers) {
      rb.top(t.minX, t.maxX, t.minZ, t.maxZ, t.y1, 6, roofCol);
      // Parapet on flat roofs.
      if (!bd.pitched && bd.style !== "warehouse") {
        const p = 0.35;
        rb.walls(t.minX, t.maxX, t.minZ, t.maxZ, t.y1, t.y1 + 0.9, 4, 4, roofCol);
        rb.walls(t.minX + p, t.maxX - p, t.minZ + p, t.maxZ - p, t.y1, t.y1 + 0.9, 4, 4, roofCol);
        rb.top(t.minX, t.maxX, t.maxZ - p, t.maxZ, t.y1 + 0.9, 4, roofCol);
        rb.top(t.minX, t.maxX, t.minZ, t.minZ + p, t.y1 + 0.9, 4, roofCol);
        rb.top(t.minX, t.minX + p, t.minZ, t.maxZ, t.y1 + 0.9, 4, roofCol);
        rb.top(t.maxX - p, t.maxX, t.minZ, t.maxZ, t.y1 + 0.9, 4, roofCol);
      }
    }
    for (const r of bd.rooftop) {
      const top = bd.tiers[bd.tiers.length - 1].y1;
      rb.box(r.x - r.w / 2, r.x + r.w / 2, r.z - r.d / 2, r.z + r.d / 2, top, top + r.h, 3, new THREE.Color("#b9bcbf"));
    }
    if (bd.pitched) addPitchedRoof(builder(cx, cz, "shingle"), bd, new THREE.Color(pick(rng, shingleTints)));
    if (bd.style === "warehouse") addSawtooth(rb, bd, roofCol);
    if (bd.spire) {
      const t = bd.tiers[bd.tiers.length - 1];
      const sx = (t.minX + t.maxX) / 2;
      const sz = (t.minZ + t.maxZ) / 2;
      rb.box(sx - 0.6, sx + 0.6, sz - 0.6, sz + 0.6, t.y1, t.y1 + bd.spire, 2, new THREE.Color("#cfd3d6"));
    }
  }

  // ---- road markings -----------------------------------------------------------
  addMarkings(city, builder);

  // ---- ramps -------------------------------------------------------------------
  for (const r of city.ramps) {
    const fx = Math.sin(r.heading);
    const fz = Math.cos(r.heading);
    const rx = fz;
    const rz = -fx;
    const hw = r.width / 2;
    const P = (a: number, b: number, y: number) => [r.x + fx * a + rx * b, y, r.z + fz * a + rz * b];
    const top = builder(r.x, r.z, "ramp");
    const side = builder(r.x, r.z, "rampSide");
    const col = new THREE.Color(1, 1, 1);
    // Sloped deck.
    const n = new THREE.Vector3(0, r.length, -r.height).normalize();
    const nw = [fx * n.z * -1, n.y, fz * n.z * -1];
    top.quad(P(0, hw, 0.02), P(0, -hw, 0.02), P(r.length, -hw, r.height), P(r.length, hw, r.height), nw, [[0, 0], [r.width / 3, 0], [r.width / 3, r.length / 3], [0, r.length / 3]], col);
    // Back face.
    side.quad(P(r.length, -hw, 0), P(r.length, hw, 0), P(r.length, hw, r.height), P(r.length, -hw, r.height), [fx, 0, fz], [[0, 0], [r.width / 2, 0], [r.width / 2, r.height / 2], [0, r.height / 2]], col);
    // Side triangles.
    side.tri(P(0, hw, 0), P(r.length, hw, r.height), P(r.length, hw, 0), [[0, 0], [r.length / 2, r.height / 2], [r.length / 2, 0]], col);
    side.tri(P(0, -hw, 0), P(r.length, -hw, 0), P(r.length, -hw, r.height), [[0, 0], [r.length / 2, 0], [r.length / 2, r.height / 2]], col);
  }

  // ---- flush chunks to meshes -------------------------------------------------
  let drawCalls = 0;
  for (const [, mats] of chunks) {
    for (const [k, g] of mats) {
      if (g.empty) continue;
      const mesh = new THREE.Mesh(g.build(), material(k));
      const big = styles.includes(k as BuildingStyle) || k === "roof" || k === "shingle" || k === "ramp" || k === "rampSide";
      mesh.castShadow = big;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      drawCalls++;
    }
  }

  // ---- terrain -----------------------------------------------------------------
  group.add(buildTerrain(city, maxAniso));

  // ---- sea + sea wall ------------------------------------------------------------
  const waterNormals = T.waterNormals();
  waterNormals.repeat.set(60, 24);
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD * 4, 1800, 1, 1),
    new THREE.MeshStandardMaterial({
      color: 0x1d4f6b,
      roughness: 0.06,
      metalness: 0.1,
      normalMap: waterNormals,
      normalScale: new THREE.Vector2(0.35, 0.35),
      envMapIntensity: 1.2,
    }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, -1.1, SEAWALL_Z - 900);
  water.receiveShadow = true;
  water.name = "sea";
  group.add(water);
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(WORLD * 2, 7.2, 1.2),
    new THREE.MeshStandardMaterial({ map: (() => {
      const t = tex(T.concrete());
      t.repeat.set(WORLD / 2, 2);
      return t;
    })(), roughness: 0.9 }),
  );
  wall.position.set(0, 1.1 - 3.6, SEAWALL_Z - 0.6);
  wall.receiveShadow = true;
  wall.castShadow = true;
  group.add(wall);

  // ---- props -------------------------------------------------------------------
  const lamps = buildLamps(city);
  group.add(lamps.group);
  group.add(buildTrees(city));
  const port = buildPort(city);
  group.add(port);
  group.add(buildBillboards(city));

  group.userData.drawCalls = drawCalls;

  const emissiveMats = Object.values(facadeMats);
  return {
    group,
    water,
    setNight(n: number) {
      for (const m of emissiveMats) m.emissiveIntensity = n * 1.1;
      lamps.setNight(n);
    },
    update(time: number) {
      waterNormals.offset.set(time * 0.004, time * 0.01);
    },
    breakLamp: lamps.breakLamp,
    resetLamps: lamps.reset,
  };
}

function addPitchedRoof(g: GeoBuilder, bd: Building, color: THREE.Color): void {
  const t = bd.tiers[0];
  const y = t.y1;
  const h = 3;
  const alongX = t.maxX - t.minX >= t.maxZ - t.minZ;
  const o = 0.4; // eaves overhang
  const minX = t.minX - o;
  const maxX = t.maxX + o;
  const minZ = t.minZ - o;
  const maxZ = t.maxZ + o;
  if (alongX) {
    const mz = (minZ + maxZ) / 2;
    const s = Math.hypot(h, mz - minZ) / 3;
    const L = (maxX - minX) / 3;
    const nz = new THREE.Vector3(0, mz - minZ, h).normalize();
    g.quad([minX, y, maxZ], [maxX, y, maxZ], [maxX, y + h, mz], [minX, y + h, mz], [0, nz.y, nz.z], [[0, 0], [L, 0], [L, s], [0, s]], color);
    g.quad([maxX, y, minZ], [minX, y, minZ], [minX, y + h, mz], [maxX, y + h, mz], [0, nz.y, -nz.z], [[0, 0], [L, 0], [L, s], [0, s]], color);
    g.tri([t.minX, y, t.maxZ], [t.minX, y + h * ((t.maxZ - t.minZ) / 2 / (mz - minZ)), mz], [t.minX, y, t.minZ], [[0, 0], [0.5, 1], [1, 0]], color.clone().multiplyScalar(1.6));
    g.tri([t.maxX, y, t.minZ], [t.maxX, y + h * ((t.maxZ - t.minZ) / 2 / (mz - minZ)), mz], [t.maxX, y, t.maxZ], [[0, 0], [0.5, 1], [1, 0]], color.clone().multiplyScalar(1.6));
  } else {
    const mx = (minX + maxX) / 2;
    const s = Math.hypot(h, mx - minX) / 3;
    const L = (maxZ - minZ) / 3;
    const nx = new THREE.Vector3(mx - minX, h, 0).normalize();
    g.quad([maxX, y, maxZ], [maxX, y, minZ], [mx, y + h, minZ], [mx, y + h, maxZ], [nx.x, nx.y, 0], [[0, 0], [L, 0], [L, s], [0, s]], color);
    g.quad([minX, y, minZ], [minX, y, maxZ], [mx, y + h, maxZ], [mx, y + h, minZ], [-nx.x, nx.y, 0], [[0, 0], [L, 0], [L, s], [0, s]], color);
    g.tri([t.maxX, y, t.maxZ], [mx, y + h * ((t.maxX - t.minX) / 2 / (mx - minX)), t.maxZ], [t.minX, y, t.maxZ], [[0, 0], [0.5, 1], [1, 0]], color.clone().multiplyScalar(1.6));
    g.tri([t.minX, y, t.minZ], [mx, y + h * ((t.maxX - t.minX) / 2 / (mx - minX)), t.minZ], [t.maxX, y, t.minZ], [[0, 0], [0.5, 1], [1, 0]], color.clone().multiplyScalar(1.6));
  }
}

function addSawtooth(g: GeoBuilder, bd: Building, color: THREE.Color): void {
  const t = bd.tiers[0];
  const n = Math.max(2, Math.floor((t.maxX - t.minX) / 9));
  const w = (t.maxX - t.minX) / n;
  const h = 2.2;
  for (let i = 0; i < n; i++) {
    const x0 = t.minX + i * w;
    const x1 = x0 + w;
    g.quad([x0, t.y1, t.maxZ], [x0, t.y1, t.minZ], [x1, t.y1 + h, t.minZ], [x1, t.y1 + h, t.maxZ], [-h, w, 0].map((v) => v / Math.hypot(h, w)), [[0, 0], [2, 0], [2, 1], [0, 1]], color);
    g.quad([x1, t.y1, t.minZ], [x1, t.y1, t.maxZ], [x1, t.y1 + h, t.maxZ], [x1, t.y1 + h, t.minZ], [1, 0, 0], [[0, 0], [2, 0], [2, 0.3], [0, 0.3]], new THREE.Color("#3a4652"));
  }
}

function addMarkings(city: City, builder: (x: number, z: number, k: MatKey) => GeoBuilder): void {
  const white = new THREE.Color(0.92, 0.92, 0.9);
  const yellow = new THREE.Color(0.95, 0.72, 0.12);
  const y = 0.012;
  const up = [0, 1, 0];
  const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
  /** A marking strip along a road axis, `a0..a1` along, `o` across offset. */
  const strip = (axis: "x" | "z", coord: number, a0: number, a1: number, o: number, w: number, c: THREE.Color) => {
    if (axis === "x") {
      const x = coord + o;
      builder(x, (a0 + a1) / 2, "marking").quad([x - w / 2, y, a1], [x + w / 2, y, a1], [x + w / 2, y, a0], [x - w / 2, y, a0], up, uv, c);
    } else {
      const z = coord + o;
      builder((a0 + a1) / 2, z, "marking").quad([a0, y, z + w / 2], [a1, y, z + w / 2], [a1, y, z - w / 2], [a0, y, z - w / 2], up, uv, c);
    }
  };
  for (const r of city.roads) {
    const lanes = r.lanes;
    const laneW = r.width / lanes;
    for (let i = -LINES; i < LINES; i++) {
      const a0 = lineCoord(i) + roadWidth(i) / 2 + 1.5;
      const a1 = lineCoord(i + 1) - roadWidth(i + 1) / 2 - 1.5;
      // Centre line: double yellow on multi-lane roads, dashed yellow otherwise.
      if (lanes >= 4) {
        strip(r.axis, r.coord, a0, a1, -0.18, 0.14, yellow);
        strip(r.axis, r.coord, a0, a1, 0.18, 0.14, yellow);
      } else {
        for (let a = a0; a < a1 - 3; a += 9) strip(r.axis, r.coord, a, a + 4, 0, 0.14, yellow);
      }
      // Lane dividers (dashed white).
      for (let k = 1; k < lanes / 2; k++) {
        for (const s of [-1, 1]) {
          for (let a = a0; a < a1 - 3; a += 12) strip(r.axis, r.coord, a, a + 5, s * k * laneW, 0.14, white);
        }
      }
      // Edge lines.
      for (const s of [-1, 1]) strip(r.axis, r.coord, a0, a1, s * (r.width / 2 - 0.35), 0.12, white);
      // Stop lines + zebra crossings at each end.
      for (const [end, dir] of [
        [a0, 1],
        [a1, -1],
      ] as const) {
        if (Math.abs(r.index) === LINES) continue;
        for (let k = -r.width / 2 + 1; k < r.width / 2 - 0.5; k += 1.4) {
          const z0 = end - dir * 1.2;
          const z1 = end - dir * 0.2 + dir * 2.4;
          const lo = Math.min(z0, z1);
          const hi = Math.max(z0, z1);
          if (r.axis === "x") {
            const x = r.coord + k;
            builder(x, end, "marking").quad([x, y, hi], [x + 0.7, y, hi], [x + 0.7, y, lo], [x, y, lo], up, uv, white);
          } else {
            const z = r.coord + k;
            builder(end, z, "marking").quad([lo, y, z + 0.7], [hi, y, z + 0.7], [hi, y, z], [lo, y, z], up, uv, white);
          }
        }
      }
    }
  }
}

function buildTerrain(city: City, maxAniso: number): THREE.Mesh {
  const n = city.terrainN;
  const pos = new Float32Array(n * n * 3);
  const col = new Float32Array(n * n * 3);
  const uv = new Float32Array(n * n * 2);
  const grassA = new THREE.Color("#5f8f3e");
  const grassB = new THREE.Color("#8aa456");
  const rock = new THREE.Color("#8b8378");
  const sand = new THREE.Color("#cdbb8f");
  const c = new THREE.Color();
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -WORLD + i * TERRAIN_STEP;
      const z = -WORLD + j * TERRAIN_STEP;
      let h = city.terrain[j * n + i];
      const inside = Math.abs(x) < CITY_EDGE - 1 && Math.abs(z) < CITY_EDGE - 1;
      if (inside) h = -0.4;
      const k = (j * n + i) * 3;
      pos[k] = x;
      pos[k + 1] = h;
      pos[k + 2] = z;
      uv[(j * n + i) * 2] = x / 14;
      uv[(j * n + i) * 2 + 1] = z / 14;
      // Slope from neighbours.
      const hx = city.terrain[j * n + Math.min(n - 1, i + 1)] - city.terrain[j * n + Math.max(0, i - 1)];
      const hz = city.terrain[Math.min(n - 1, j + 1) * n + i] - city.terrain[Math.max(0, j - 1) * n + i];
      const slope = Math.hypot(hx, hz) / (2 * TERRAIN_STEP);
      c.copy(grassA).lerp(grassB, fbm(x / 90, z / 90));
      c.lerp(rock, Math.min(1, Math.max(0, (slope - 0.35) * 3)));
      if (h < 0.5 && z < SEAWALL_Z + 30) c.lerp(sand, 0.8);
      col[k] = c.r;
      col[k + 1] = c.g;
      col[k + 2] = c.b;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const cc = a + n;
      const d = cc + 1;
      // Matches City.terrainAt triangulation (diagonal b-cc).
      idx.push(a, cc, b, b, cc, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const t = T.grass();
  t.anisotropy = maxAniso;
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: t, vertexColors: true, roughness: 1 }));
  mesh.receiveShadow = true;
  mesh.name = "terrain";
  return mesh;
}

function buildLamps(city: City) {
  const group = new THREE.Group();
  const n = city.lamps.length;
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3b4046, roughness: 0.5, metalness: 0.7 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0x777777, emissive: 0xffd9a0, emissiveIntensity: 0, roughness: 0.4 });
  const pole = new THREE.CylinderGeometry(0.09, 0.14, 7.2, 8);
  pole.translate(0, 3.6, 0);
  const arm = new THREE.BoxGeometry(0.1, 0.1, 2.0);
  arm.translate(0, 7.1, 1.0);
  const head = new THREE.BoxGeometry(0.5, 0.14, 0.9);
  head.translate(0, 7.0, 1.9);
  const poles = new THREE.InstancedMesh(pole, poleMat, n);
  const arms = new THREE.InstancedMesh(arm, poleMat, n);
  const heads = new THREE.InstancedMesh(head, headMat, n);
  poles.castShadow = true;
  // Light pools on the road (additive decals, visible at night).
  const poolTex = T.radial("rgba(255,214,150,0.55)", "rgba(255,214,150,0)", 128);
  const poolMat = new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const poolGeo = new THREE.PlaneGeometry(10, 10);
  poolGeo.rotateX(-Math.PI / 2);
  poolGeo.translate(0, 0.03, 2.4);
  const pools = new THREE.InstancedMesh(poolGeo, poolMat, n);
  const index = new Map<number, number>();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const place = (i: number, fallen: boolean) => {
    const l = city.lamps[i];
    q.setFromAxisAngle(up, l.rot);
    if (fallen) {
      const tip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.45);
      q.multiply(tip);
    }
    m.compose(new THREE.Vector3(l.x, CURB, l.z), q, one);
    poles.setMatrixAt(i, m);
    arms.setMatrixAt(i, m);
    heads.setMatrixAt(i, m);
    if (fallen) m.makeScale(0, 0, 0);
    else m.compose(new THREE.Vector3(l.x, 0, l.z), new THREE.Quaternion().setFromAxisAngle(up, l.rot), one);
    pools.setMatrixAt(i, m);
  };
  city.lamps.forEach((l, i) => {
    place(i, false);
    if (l.collider) index.set(l.collider.id, i);
  });
  group.add(poles, arms, heads, pools);
  const dirty = () => {
    poles.instanceMatrix.needsUpdate = true;
    arms.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    pools.instanceMatrix.needsUpdate = true;
    for (const im of [poles, arms, heads, pools]) im.computeBoundingSphere();
  };
  dirty();
  return {
    group,
    setNight(v: number) {
      headMat.emissiveIntensity = v * 6;
      poolMat.opacity = v * 0.6;
      pools.visible = v > 0.02;
    },
    breakLamp(c: CircleCollider) {
      const i = index.get(c.id);
      if (i === undefined) return;
      place(i, true);
      dirty();
    },
    reset() {
      city.lamps.forEach((l, i) => {
        if (l.collider && "broken" in l.collider) l.collider.broken = false;
        place(i, false);
      });
      dirty();
    },
  };
}

function buildTrees(city: City): THREE.Group {
  const group = new THREE.Group();
  const n = city.trees.length;
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
  const rng = mulberry32(5);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const c = new THREE.Color();
  const palette = ["#3e6a26", "#4b7a2e", "#335a22", "#5a8231", "#466b25", "#64782a"];
  city.trees.forEach((t, i) => {
    const s = range(rng, 0.8, 1.35);
    const y = city.ground(t.x, t.z);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.rot);
    m.compose(new THREE.Vector3(t.x, y, t.z), q, new THREE.Vector3(s, s * range(rng, 0.9, 1.2), s));
    trunks.setMatrixAt(i, m);
    crowns.setMatrixAt(i, m);
    crowns2.setMatrixAt(i, m);
    c.set(pick(rng, palette));
    crowns.setColorAt(i, c);
    crowns2.setColorAt(i, c.multiplyScalar(1.12));
  });
  for (const im of [trunks, crowns, crowns2]) {
    im.castShadow = true;
    im.receiveShadow = true;
    im.computeBoundingSphere();
  }
  group.add(trunks, crowns, crowns2);
  return group;
}

function buildPort(city: City): THREE.Group {
  const group = new THREE.Group();
  const cTex = T.corrugated();
  cTex.wrapS = cTex.wrapT = THREE.ClampToEdgeWrapping;
  const geo = new THREE.BoxGeometry(12.2, 2.6, 2.44);
  geo.translate(0, 1.3, 0);
  const cont = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ map: cTex, roughness: 0.6, metalness: 0.3 }), Math.max(1, city.containers.length));
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  city.containers.forEach((k, i) => {
    m.makeRotationY(k.rot);
    m.setPosition(k.x, CURB + k.level * 2.6, k.z);
    cont.setMatrixAt(i, m);
    cont.setColorAt(i, c.set(k.color));
  });
  cont.count = city.containers.length;
  cont.castShadow = cont.receiveShadow = true;
  cont.computeBoundingSphere();
  group.add(cont);

  const tankGeo = new THREE.CylinderGeometry(1, 1, 1, 28);
  tankGeo.translate(0, 0.5, 0);
  const tanks = new THREE.InstancedMesh(tankGeo, new THREE.MeshStandardMaterial({ color: 0xd9dcdf, roughness: 0.35, metalness: 0.6 }), Math.max(1, city.tanks.length));
  const domeGeo = new THREE.SphereGeometry(1, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  domeGeo.scale(1, 0.18, 1);
  const domes = new THREE.InstancedMesh(domeGeo, tanks.material, Math.max(1, city.tanks.length));
  city.tanks.forEach((t, i) => {
    m.makeScale(t.r, t.h, t.r);
    m.setPosition(t.x, CURB, t.z);
    tanks.setMatrixAt(i, m);
    m.makeScale(t.r, t.r, t.r);
    m.setPosition(t.x, CURB + t.h, t.z);
    domes.setMatrixAt(i, m);
  });
  tanks.count = domes.count = city.tanks.length;
  for (const im of [tanks, domes]) {
    im.castShadow = im.receiveShadow = true;
    im.computeBoundingSphere();
  }
  group.add(tanks, domes);

  // Gantry cranes on the quay.
  const craneMat = new THREE.MeshStandardMaterial({ color: 0xd9531e, roughness: 0.6, metalness: 0.4 });
  for (const cr of city.cranes) {
    const g = new THREE.Group();
    const leg = new THREE.BoxGeometry(1.2, 40, 1.2);
    for (const [x, z] of [
      [-8, -6],
      [8, -6],
      [-8, 6],
      [8, 6],
    ]) {
      const l = new THREE.Mesh(leg, craneMat);
      l.position.set(x, 20 - 6, z);
      g.add(l);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.4, 70), craneMat);
    beam.position.set(0, 34, -18);
    g.add(beam);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 4), new THREE.MeshStandardMaterial({ color: 0xe8e8e8 }));
    cab.position.set(0, 31.5, -10);
    g.add(cab);
    for (const s of [-1, 1]) {
      const cross = new THREE.Mesh(new THREE.BoxGeometry(17, 1.2, 1.2), craneMat);
      cross.position.set(0, 30, s * 6);
      g.add(cross);
    }
    g.position.set(cr.x, 0, cr.z);
    g.traverse((o) => {
      o.castShadow = true;
    });
    group.add(g);
  }
  return group;
}

function buildBillboards(city: City): THREE.Group {
  const group = new THREE.Group();
  const texCache = new Map<string, THREE.Texture>();
  let k = 0;
  for (const b of city.buildings) {
    const bb = b.billboard;
    if (!bb) continue;
    const key = `${bb.color}-${k % 5}`;
    let t = texCache.get(key);
    if (!t) texCache.set(key, (t = T.billboard(bb.color, 300 + k)));
    k++;
    const mat = new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.5 });
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(bb.w, bb.h), mat);
    panel.position.set(bb.x, bb.y + bb.h / 2 + 1.4, bb.z);
    panel.rotation.y = (bb.face * Math.PI) / 2;
    const back = new THREE.Mesh(new THREE.BoxGeometry(bb.w + 0.4, bb.h + 0.4, 0.3), new THREE.MeshStandardMaterial({ color: 0x222428, roughness: 0.6, metalness: 0.6 }));
    back.position.copy(panel.position);
    back.rotation.y = panel.rotation.y;
    back.translateZ(-0.2);
    back.castShadow = true;
    const legs = new THREE.Mesh(new THREE.BoxGeometry(bb.w * 0.6, 1.6, 0.2), back.material);
    legs.position.set(bb.x, bb.y + 0.8, bb.z);
    legs.rotation.y = panel.rotation.y;
    group.add(back, panel, legs);
  }
  return group;
}

export { CITY, GRID, CURB };
