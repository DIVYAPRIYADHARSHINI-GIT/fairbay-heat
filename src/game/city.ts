/**
 * Fairbay - the procedurally generated open-world city.
 *
 * Pure data (no Three.js) so it can be unit-tested in Node: road grid,
 * districts, buildings, props, ramps, terrain, and the `ground` / `surface`
 * queries the physics uses. Generation is fully deterministic (seeded PRNG),
 * so every player gets the same city and tests can assert on it.
 *
 * Layout (metres, +X = west/left on screen when facing north (+Z)):
 *   - 13 x 13 road grid, 120 m apart, spanning +-720 m. Every third line is a
 *     wide 4-lane arterial; the outer square is a 6-lane ring highway.
 *   - Districts: Downtown towers in the centre, Midtown mid-rises, Northshore
 *     houses + Ridge Park in the north, Ironworks industry in the south-east,
 *     Port Fairbay docks along the south shore.
 *   - Outside the ring: rolling hills (drivable off-road) to the world edge at
 *     +-1100 m, and the sea to the south behind a sea wall.
 */

import { clamp, mulberry32, pick, range, smoothstep } from "../core/math";
import { SpatialHash, type BoxCollider, type CircleCollider } from "./collision";
import type { Surface, World } from "./physics";

export const GRID = 120;
export const LINES = 6; // lines run from -LINES..LINES
export const CITY = GRID * LINES; // 720
export const WORLD = 1100;
export const SIDEWALK = 4;
export const CURB = 0.15;
export const SEA_Z = -760;
export const SEAWALL_Z = -736;
export const TERRAIN_STEP = 20;

export type District = "downtown" | "midtown" | "northshore" | "park" | "ironworks" | "port";

export const DISTRICT_NAMES: Record<District, string> = {
  downtown: "Downtown",
  midtown: "Midtown",
  northshore: "Northshore",
  park: "Ridge Park",
  ironworks: "Ironworks",
  port: "Port Fairbay",
};

export type BuildingStyle = "glass" | "office" | "brick" | "house" | "warehouse";

export interface Tier {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  y0: number;
  y1: number;
}

export interface Building {
  id: number;
  style: BuildingStyle;
  /** Hex tint for the facade. */
  color: string;
  tiers: Tier[];
  /** Pitched roof (houses) - ridge along the longer side. */
  pitched: boolean;
  /** Height of the top of the building (tallest tier / roof peak). */
  height: number;
  rooftop: { x: number; z: number; w: number; d: number; h: number }[];
  billboard?: { x: number; z: number; w: number; h: number; face: number; y: number; color: string };
  spire?: number;
}

export interface Block {
  ix: number;
  iz: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  district: District;
  /** Open plaza / car park (no buildings). */
  plaza: boolean;
}

export interface Ramp {
  x: number;
  z: number;
  /** Direction the car drives up the ramp. 0 = +Z. */
  heading: number;
  width: number;
  length: number;
  height: number;
}

export interface Road {
  /** "x" roads run along Z at a fixed X; "z" roads run along X at a fixed Z. */
  axis: "x" | "z";
  index: number;
  coord: number;
  width: number;
  lanes: number;
}

export interface Prop {
  x: number;
  z: number;
  rot: number;
  collider?: CircleCollider | BoxCollider;
}

export interface Container {
  x: number;
  z: number;
  rot: number; // 0 or PI/2
  level: number;
  color: string;
}

export interface Tank {
  x: number;
  z: number;
  r: number;
  h: number;
}

export interface Crane {
  x: number;
  z: number;
  rot: number;
}

export function roadWidth(index: number): number {
  if (Math.abs(index) === LINES) return 26;
  if (index % 3 === 0) return 20;
  return 14;
}

export function roadLanes(index: number): number {
  if (Math.abs(index) === LINES) return 6;
  if (index % 3 === 0) return 4;
  return 2;
}

export const lineCoord = (i: number): number => i * GRID;

/** Outer edge of the paved city (ring highway outer edge). */
export const CITY_EDGE = CITY + roadWidth(LINES) / 2;

export function districtAt(cx: number, cz: number): District {
  if (cz < -480) return "port";
  if (Math.abs(cx) <= 240 && Math.abs(cz) <= 240) return "downtown";
  if (cx > 240 && cx < 480 && cz > 240 && cz < 600) return "park";
  if (cz > 360) return "northshore";
  if (cz < -240 && cx > 120) return "ironworks";
  return "midtown";
}

// ---- smooth value noise for the hills ----------------------------------------
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

/** Analytic terrain height outside the city (sampled into the terrain grid). */
export function terrainHeight(x: number, z: number): number {
  // The whole south band is sea, behind the sea wall.
  if (z < SEAWALL_Z) return -6 * smoothstep(SEAWALL_Z, SEAWALL_Z - 30, z);
  const d = Math.max(Math.abs(x), Math.abs(z)) - CITY_EDGE;
  if (d <= 12) return 0;
  const rise = smoothstep(12, 220, d);
  const n = fbm(x / 260, z / 260);
  const ridge = smoothstep(180, 360, d) * 40;
  // Hills taper down to the shoreline.
  const shore = smoothstep(SEAWALL_Z, SEAWALL_Z + 160, z);
  return (rise * (6 + 46 * n) + ridge * n) * shore;
}

export class City {
  readonly blocks: Block[] = [];
  readonly buildings: Building[] = [];
  readonly roads: Road[] = [];
  readonly ramps: Ramp[] = [];
  readonly lamps: Prop[] = [];
  readonly trees: Prop[] = [];
  readonly containers: Container[] = [];
  readonly tanks: Tank[] = [];
  readonly cranes: Crane[] = [];
  readonly colliders = new SpatialHash(40);
  /** Terrain heights on a (n x n) grid from -WORLD..WORLD. */
  readonly terrainN: number;
  readonly terrain: Float32Array;
  private nextId = 1;
  private blockIndex: (Block | null)[] = [];

  constructor(readonly seed = 2013) {
    const rng = mulberry32(seed);
    this.terrainN = Math.round((2 * WORLD) / TERRAIN_STEP) + 1;
    this.terrain = new Float32Array(this.terrainN * this.terrainN);
    for (let j = 0; j < this.terrainN; j++) {
      for (let i = 0; i < this.terrainN; i++) {
        this.terrain[j * this.terrainN + i] = terrainHeight(-WORLD + i * TERRAIN_STEP, -WORLD + j * TERRAIN_STEP);
      }
    }
    for (let i = -LINES; i <= LINES; i++) {
      this.roads.push({ axis: "x", index: i, coord: lineCoord(i), width: roadWidth(i), lanes: roadLanes(i) });
      this.roads.push({ axis: "z", index: i, coord: lineCoord(i), width: roadWidth(i), lanes: roadLanes(i) });
    }
    this.buildBlocks(rng);
    this.buildRamps();
    this.buildLamps(rng);
    this.buildBoundaries();
  }

  // ---- generation ------------------------------------------------------------

  private box(minX: number, maxX: number, minZ: number, maxZ: number, top: number): BoxCollider {
    const c: BoxCollider = { kind: "box", id: this.nextId++, minX, maxX, minZ, maxZ, top };
    this.colliders.add(c);
    return c;
  }

  private circle(x: number, z: number, r: number, top: number, breakable = false): CircleCollider {
    const c: CircleCollider = { kind: "circle", id: this.nextId++, x, z, r, top, breakable, broken: false };
    this.colliders.add(c);
    return c;
  }

  private buildBlocks(rng: () => number): void {
    for (let iz = -LINES; iz < LINES; iz++) {
      for (let ix = -LINES; ix < LINES; ix++) {
        const minX = lineCoord(ix) + roadWidth(ix) / 2;
        const maxX = lineCoord(ix + 1) - roadWidth(ix + 1) / 2;
        const minZ = lineCoord(iz) + roadWidth(iz) / 2;
        const maxZ = lineCoord(iz + 1) - roadWidth(iz + 1) / 2;
        const cx = (minX + maxX) / 2;
        const cz = (minZ + maxZ) / 2;
        const district = districtAt(cx, cz);
        const plaza = (district === "midtown" || district === "downtown") && rng() < 0.09;
        const block: Block = { ix, iz, minX, maxX, minZ, maxZ, district, plaza };
        this.blocks.push(block);
        this.blockIndex.push(block);
        if (!plaza) this.fillBlock(block, rng);
        else this.fillPlaza(block, rng);
      }
    }
  }

  /** Splits a block's buildable area into lots, optionally leaving drivable alleys. */
  private lots(
    b: Block,
    nx: number,
    nz: number,
    rng: () => number,
    alleyChance: number,
  ): { minX: number; maxX: number; minZ: number; maxZ: number }[] {
    const x0 = b.minX + SIDEWALK;
    const x1 = b.maxX - SIDEWALK;
    const z0 = b.minZ + SIDEWALK;
    const z1 = b.maxZ - SIDEWALK;
    const xs: number[] = [x0];
    const zs: number[] = [z0];
    const gapsX: number[] = [];
    const gapsZ: number[] = [];
    for (let i = 1; i < nx; i++) {
      xs.push(x0 + ((x1 - x0) * i) / nx);
      gapsX.push(rng() < alleyChance ? 9 : 1.2);
    }
    for (let i = 1; i < nz; i++) {
      zs.push(z0 + ((z1 - z0) * i) / nz);
      gapsZ.push(rng() < alleyChance ? 9 : 1.2);
    }
    xs.push(x1);
    zs.push(z1);
    const out = [];
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        out.push({
          minX: xs[i] + (i > 0 ? gapsX[i - 1] / 2 : 0),
          maxX: xs[i + 1] - (i < nx - 1 ? gapsX[i] / 2 : 0),
          minZ: zs[j] + (j > 0 ? gapsZ[j - 1] / 2 : 0),
          maxZ: zs[j + 1] - (j < nz - 1 ? gapsZ[j] / 2 : 0),
        });
      }
    }
    return out;
  }

  private addBuilding(
    style: BuildingStyle,
    color: string,
    lot: { minX: number; maxX: number; minZ: number; maxZ: number },
    height: number,
    tiers: number,
    rng: () => number,
    opts: { pitched?: boolean; billboard?: boolean; spire?: boolean } = {},
  ): Building {
    const t: Tier[] = [];
    let { minX, maxX, minZ, maxZ } = lot;
    let y0 = 0;
    for (let k = 0; k < tiers; k++) {
      const frac = tiers === 1 ? 1 : k === 0 ? range(rng, 0.45, 0.6) : k === tiers - 1 ? 1 : range(rng, 0.75, 0.85);
      const y1 = k === tiers - 1 ? height : Math.max(y0 + 8, height * frac);
      t.push({ minX, maxX, minZ, maxZ, y0, y1 });
      y0 = y1;
      const w = maxX - minX;
      const d = maxZ - minZ;
      const ix = w * range(rng, 0.1, 0.18);
      const iz = d * range(rng, 0.1, 0.18);
      minX += ix;
      maxX -= ix;
      minZ += iz;
      maxZ -= iz;
    }
    const top = t[t.length - 1];
    const rooftop = [];
    if (!opts.pitched) {
      const n = Math.floor(range(rng, 1, 4));
      for (let k = 0; k < n; k++) {
        const w = range(rng, 2, 5);
        const d = range(rng, 2, 5);
        rooftop.push({
          x: range(rng, top.minX + w, top.maxX - w),
          z: range(rng, top.minZ + d, top.maxZ - d),
          w,
          d,
          h: range(rng, 1.2, 3),
        });
      }
    }
    const b: Building = {
      id: this.buildings.length,
      style,
      color,
      tiers: t,
      pitched: !!opts.pitched,
      height: height + (opts.pitched ? 3 : 0),
      rooftop,
    };
    if (opts.billboard) {
      const face = Math.floor(rng() * 4);
      const w = Math.min(top.maxX - top.minX, top.maxZ - top.minZ) * 0.8;
      b.billboard = {
        x: (top.minX + top.maxX) / 2,
        z: (top.minZ + top.maxZ) / 2,
        w,
        h: w * 0.35,
        face,
        y: height + 1,
        color: pick(rng, ["#ff2d55", "#00d1ff", "#ffb800", "#7cff4f", "#b26bff"]),
      };
    }
    if (opts.spire) b.spire = range(rng, 12, 30);
    this.buildings.push(b);
    this.box(lot.minX, lot.maxX, lot.minZ, lot.maxZ, height);
    return b;
  }

  private fillBlock(b: Block, rng: () => number): void {
    switch (b.district) {
      case "downtown": {
        const n = rng() < 0.5 ? 1 : 2;
        const m = rng() < 0.4 ? 1 : 2;
        for (const lot of this.lots(b, n, m, rng, 0.35)) {
          const h = range(rng, 55, 170) * (1 - (Math.hypot((lot.minX + lot.maxX) / 2, (lot.minZ + lot.maxZ) / 2) / 600) * 0.6);
          const style: BuildingStyle = rng() < 0.6 ? "glass" : "office";
          const color = style === "glass" ? pick(rng, ["#7fa7c9", "#5d7f9e", "#8ab0b8", "#a7b6c9", "#4e6e8e"]) : pick(rng, ["#c9c2b5", "#b5b9bf", "#d6cbb8", "#9ea4ab"]);
          this.addBuilding(style, color, lot, h, h > 90 ? 3 : 2, rng, { billboard: rng() < 0.25, spire: h > 120 && rng() < 0.5 });
        }
        break;
      }
      case "midtown": {
        const n = 2 + Math.floor(rng() * 2);
        for (const lot of this.lots(b, n, 2, rng, 0.3)) {
          if (rng() < 0.08) continue; // gap lot
          const h = range(rng, 14, 48);
          const style: BuildingStyle = rng() < 0.45 ? "brick" : rng() < 0.7 ? "office" : "glass";
          const color =
            style === "brick"
              ? pick(rng, ["#9c4f3c", "#b0644a", "#8a5a44", "#a8735a", "#7d4436"])
              : style === "office"
                ? pick(rng, ["#d9d2c3", "#c4c8cc", "#e0d6c2", "#b9b2a6", "#cfc5b0"])
                : pick(rng, ["#7fa7c9", "#6c8fa8", "#9ab8c4"]);
          this.addBuilding(style, color, lot, h, h > 32 && rng() < 0.5 ? 2 : 1, rng, { billboard: rng() < 0.15 });
        }
        break;
      }
      case "northshore": {
        for (const lot of this.lots(b, 3, 3, rng, 0.15)) {
          const w = lot.maxX - lot.minX;
          const d = lot.maxZ - lot.minZ;
          const hw = Math.min(w * 0.62, 18);
          const hd = Math.min(d * 0.62, 15);
          const cx = (lot.minX + lot.maxX) / 2;
          const cz = (lot.minZ + lot.maxZ) / 2;
          const color = pick(rng, ["#e8e0d0", "#d7e3e8", "#f0d9b5", "#c8d5b9", "#e6c9c0", "#f5f1e8"]);
          this.addBuilding(
            "house",
            color,
            { minX: cx - hw / 2, maxX: cx + hw / 2, minZ: cz - hd / 2, maxZ: cz + hd / 2 },
            range(rng, 5.5, 8),
            1,
            rng,
            { pitched: true },
          );
          // Garden trees in the corners of the lot.
          if (rng() < 0.75) this.addTree(lot.minX + 2.5, lot.minZ + 2.5, rng);
          if (rng() < 0.5) this.addTree(lot.maxX - 2.5, lot.maxZ - 2.5, rng);
        }
        break;
      }
      case "park": {
        for (let k = 0; k < 26; k++) {
          const x = range(rng, b.minX + 6, b.maxX - 6);
          const z = range(rng, b.minZ + 6, b.maxZ - 6);
          // Leave a clear diagonal drive through the park.
          const u = (x - b.minX) / (b.maxX - b.minX);
          const v = (z - b.minZ) / (b.maxZ - b.minZ);
          if (Math.abs(u - v) < 0.18) continue;
          this.addTree(x, z, rng);
        }
        break;
      }
      case "ironworks": {
        const lots = this.lots(b, 2, 1, rng, 0.6);
        for (const lot of lots) {
          if (rng() < 0.45) {
            // Tank farm.
            const r = range(rng, 6, 9);
            const cols = Math.max(1, Math.floor((lot.maxX - lot.minX) / (2 * r + 4)));
            const rows = Math.max(1, Math.floor((lot.maxZ - lot.minZ) / (2 * r + 4)));
            for (let i = 0; i < cols; i++) {
              for (let j = 0; j < rows; j++) {
                if (rng() < 0.25) continue;
                const x = lot.minX + (i + 0.5) * ((lot.maxX - lot.minX) / cols);
                const z = lot.minZ + (j + 0.5) * ((lot.maxZ - lot.minZ) / rows);
                const h = range(rng, 9, 16);
                this.tanks.push({ x, z, r, h });
                this.circle(x, z, r, h);
              }
            }
          } else {
            const color = pick(rng, ["#8d9aa6", "#a39e93", "#6f7f8c", "#b4a68f", "#7c8a7a"]);
            this.addBuilding("warehouse", color, { minX: lot.minX + 2, maxX: lot.maxX - 2, minZ: lot.minZ + 4, maxZ: lot.maxZ - 4 }, range(rng, 9, 15), 1, rng);
          }
        }
        break;
      }
      case "port": {
        const southmost = b.iz === -LINES;
        if (southmost && rng() < 0.7) {
          this.fillContainers(b, rng);
        } else {
          const lots = this.lots(b, rng() < 0.5 ? 1 : 2, 1, rng, 0.7);
          for (const lot of lots) {
            const color = pick(rng, ["#5b7083", "#8d6e63", "#78909c", "#a1887f", "#6d7b6a"]);
            this.addBuilding("warehouse", color, { minX: lot.minX + 2, maxX: lot.maxX - 2, minZ: lot.minZ + 6, maxZ: lot.maxZ - 6 }, range(rng, 10, 16), 1, rng);
          }
        }
        break;
      }
    }
  }

  private fillPlaza(b: Block, rng: () => number): void {
    // Open plaza: a ring of trees, drivable centre.
    const n = 10;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const rx = (b.maxX - b.minX) / 2 - 7;
      const rz = (b.maxZ - b.minZ) / 2 - 7;
      if (Math.abs(Math.cos(a)) > 0.95 || Math.abs(Math.sin(a)) > 0.95) continue; // openings
      this.addTree((b.minX + b.maxX) / 2 + Math.cos(a) * rx, (b.minZ + b.maxZ) / 2 + Math.sin(a) * rz, rng);
    }
  }

  private fillContainers(b: Block, rng: () => number): void {
    const colors = ["#c0392b", "#2471a3", "#d68910", "#1e8449", "#7d3c98", "#b9770e", "#566573", "#a93226"];
    const L = 12.2;
    const W = 2.5;
    const rows = Math.floor((b.maxZ - b.minZ - 2 * SIDEWALK - 10) / (W * 4 + 7));
    const cols = Math.floor((b.maxX - b.minX - 2 * SIDEWALK) / (L + 3));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (rng() < 0.2) continue;
        const x0 = b.minX + SIDEWALK + 1.5 + c * (L + 3);
        const z0 = b.minZ + SIDEWALK + 5 + r * (W * 4 + 7);
        let maxLevel = 0;
        for (let k = 0; k < 4; k++) {
          const levels = 1 + Math.floor(rng() * 3);
          maxLevel = Math.max(maxLevel, levels);
          for (let l = 0; l < levels; l++) {
            this.containers.push({ x: x0 + L / 2, z: z0 + k * W + W / 2, rot: 0, level: l, color: pick(rng, colors) });
          }
        }
        this.box(x0, x0 + L, z0, z0 + 4 * W, maxLevel * 2.6);
      }
    }
    if (rng() < 0.8) {
      this.cranes.push({ x: (b.minX + b.maxX) / 2, z: SEAWALL_Z - 6, rot: 0 });
    }
  }

  private addTree(x: number, z: number, rng: () => number): void {
    const col = this.circle(x, z, 0.45, 8);
    this.trees.push({ x, z, rot: rng() * Math.PI * 2, collider: col });
  }

  private buildRamps(): void {
    const R = (x: number, z: number, heading: number, height = 2.2, length = 10, width = 7): void => {
      this.ramps.push({ x, z, heading, width, length, height });
      // Solid back face, so the ramp is a wall when approached from behind.
      const fx = Math.sin(heading);
      const fz = Math.cos(heading);
      const bx = x + fx * length;
      const bz = z + fz * length;
      const hw = width / 2;
      let c: BoxCollider | null = null;
      if (Math.abs(fz) > 0.99) {
        c = this.box(x - hw, x + hw, Math.min(bz, bz + fz * 0.6), Math.max(bz, bz + fz * 0.6), height);
      } else if (Math.abs(fx) > 0.99) {
        c = this.box(Math.min(bx, bx + fx * 0.6), Math.max(bx, bx + fx * 0.6), z - hw, z + hw, height);
      }
      if (c) c.ramp = true;
    };
    // Street kickers on long arterial straights (centre of the road).
    R(0, 160, 0);
    R(0, -200, Math.PI);
    R(360, -300, Math.PI);
    R(-360, 290, 0);
    R(-200, 360, Math.PI / 2);
    R(220, -360, -Math.PI / 2);
    R(-310, -360, Math.PI / 2, 2.6, 12);
    R(360, 150, 0, 2.6, 12);
    // Ring highway mega-jumps.
    R(-500, CITY, Math.PI / 2, 3.4, 16, 9);
    R(520, -CITY, -Math.PI / 2, 3.4, 16, 9);
    // Ridge Park dirt kicker on the diagonal.
    R(300, 300, Math.PI / 4, 2.4, 10, 8);
  }

  private buildLamps(rng: () => number): void {
    for (const road of this.roads) {
      if (Math.abs(road.index) === LINES) continue; // the ring highway has its own masts
      const off = road.width / 2 + 1.0;
      for (let i = -LINES; i < LINES; i++) {
        const a0 = lineCoord(i) + roadWidth(i) / 2 + 8;
        const a1 = lineCoord(i + 1) - roadWidth(i + 1) / 2 - 8;
        for (let a = a0; a <= a1; a += 28) {
          for (const side of [-1, 1]) {
            const x = road.axis === "x" ? road.coord + side * off : a;
            const z = road.axis === "x" ? a : road.coord + side * off;
            if (this.blockAt(x, z)?.district === "park" && rng() < 0.5) continue;
            const col = this.circle(x, z, 0.22, 7, true);
            this.lamps.push({ x, z, rot: road.axis === "x" ? (side > 0 ? -Math.PI / 2 : Math.PI / 2) : side > 0 ? Math.PI : 0, collider: col });
          }
        }
      }
    }
    // Highway masts on the inner edge of the ring.
    const off = CITY - roadWidth(LINES) / 2 - 1.2;
    for (let a = -CITY + 30; a <= CITY - 30; a += 40) {
      for (const [x, z, rot] of [
        [a, off, Math.PI],
        [a, -off, 0],
        [off, a, -Math.PI / 2],
        [-off, a, Math.PI / 2],
      ] as const) {
        const col = this.circle(x, z, 0.22, 7, true);
        this.lamps.push({ x, z, rot, collider: col });
      }
    }
  }

  private buildBoundaries(): void {
    const W = WORLD;
    this.box(-W - 10, W + 10, W, W + 10, 999);
    this.box(-W - 10, W + 10, -W - 10, -W, 999);
    this.box(W, W + 10, -W, W, 999);
    this.box(-W - 10, -W, -W, W, 999);
    // Sea wall along the docks.
    this.box(-WORLD, WORLD, SEAWALL_Z - 1.2, SEAWALL_Z, 1.1);
  }

  // ---- queries -----------------------------------------------------------------

  /** The city block containing (x, z), or null when on a road / outside. */
  blockAt(x: number, z: number): Block | null {
    if (Math.abs(x) >= CITY || Math.abs(z) >= CITY) return null;
    const ix = Math.floor((x + CITY) / GRID);
    const iz = Math.floor((z + CITY) / GRID);
    const b = this.blockIndex[iz * (2 * LINES) + ix];
    if (!b) return null;
    return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ ? b : null;
  }

  /** The road under (x, z), if any. */
  roadAt(x: number, z: number): Road | null {
    for (const r of this.roads) {
      const d = r.axis === "x" ? Math.abs(x - r.coord) : Math.abs(z - r.coord);
      const along = r.axis === "x" ? z : x;
      if (d <= r.width / 2 && Math.abs(along) <= CITY_EDGE) return r;
    }
    return null;
  }

  districtOf(x: number, z: number): District | "hills" | "sea" {
    if (z < SEAWALL_Z) return "sea";
    if (Math.abs(x) > CITY_EDGE || Math.abs(z) > CITY_EDGE) return "hills";
    return districtAt(x, z);
  }

  private rampHeight(x: number, z: number): number {
    let best = -Infinity;
    for (const r of this.ramps) {
      const dx = x - r.x;
      const dz = z - r.z;
      if (Math.abs(dx) > r.length + r.width || Math.abs(dz) > r.length + r.width) continue;
      const fx = Math.sin(r.heading);
      const fz = Math.cos(r.heading);
      const a = dx * fx + dz * fz;
      const b = dx * fz - dz * fx;
      if (a < 0 || a > r.length || Math.abs(b) > r.width / 2) continue;
      best = Math.max(best, (r.height * a) / r.length);
    }
    return best;
  }

  terrainAt(x: number, z: number): number {
    const n = this.terrainN;
    const gx = clamp((x + WORLD) / TERRAIN_STEP, 0, n - 1.0001);
    const gz = clamp((z + WORLD) / TERRAIN_STEP, 0, n - 1.0001);
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const u = gx - i;
    const v = gz - j;
    const h00 = this.terrain[j * n + i];
    const h10 = this.terrain[j * n + i + 1];
    const h01 = this.terrain[(j + 1) * n + i];
    const h11 = this.terrain[(j + 1) * n + i + 1];
    // Same triangulation as the rendered terrain mesh.
    if (u + v <= 1) return h00 + u * (h10 - h00) + v * (h01 - h00);
    return h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
  }

  ground = (x: number, z: number): number => {
    const ramp = this.rampHeight(x, z);
    let g: number;
    if (Math.abs(x) <= CITY_EDGE && Math.abs(z) <= CITY_EDGE) {
      g = this.blockAt(x, z) ? CURB : 0;
    } else {
      g = this.terrainAt(x, z);
    }
    return ramp > g ? ramp : g;
  };

  surface = (x: number, z: number): Surface => {
    if (this.rampHeight(x, z) > -Infinity) return "road";
    if (Math.abs(x) > CITY_EDGE || Math.abs(z) > CITY_EDGE) return "offroad";
    const b = this.blockAt(x, z);
    if (b && b.district === "park") {
      // Sidewalk ring is paved; the park interior is grass.
      const inner = x > b.minX + SIDEWALK && x < b.maxX - SIDEWALK && z > b.minZ + SIDEWALK && z < b.maxZ - SIDEWALK;
      return inner ? "offroad" : "road";
    }
    return "road";
  };

  get world(): World {
    return { ground: this.ground, surface: this.surface, colliders: this.colliders };
  }

  /** Default spawn: northbound right-hand lane of Main St (x = 0), downtown. */
  static readonly SPAWN = { x: -5, z: 40, heading: 0 };

  /** A point on a road near (x, z), used to recover a stuck / drowned car. */
  nearestRoadPoint(x: number, z: number): { x: number; z: number; heading: number } {
    const cx = clamp(x, -CITY, CITY);
    const cz = clamp(z, -CITY + 20, CITY);
    const lx = Math.round(cx / GRID) * GRID;
    const lz = Math.round(cz / GRID) * GRID;
    if (Math.abs(cx - lx) < Math.abs(cz - lz)) {
      // Closer to a road running along Z.
      const zz = clamp(cz, -CITY, CITY);
      return { x: lx - 3, z: zz, heading: 0 };
    }
    return { x: clamp(cx, -CITY, CITY), z: lz + 3, heading: Math.PI / 2 };
  }
}
