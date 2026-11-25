/**
 * Save data lives in localStorage under one versioned key. Loading is
 * defensive: anything malformed falls back to defaults field by field, so a
 * corrupt save can never stop the game from starting.
 */

import { CARS } from "./cars";

export type Quality = "high" | "medium" | "low";

export interface SaveData {
  version: 1;
  /** Car ids the player has jacked (unlocked in the garage). */
  discovered: string[];
  carId: string;
  colorIndex: number;
  quality: Quality;
  volume: number;
  muted: boolean;
  /** Real seconds per in-game hour (0 = frozen). */
  timeSpeed: number;
  hours: number;
  camera: number;
  showFps: boolean;
  /** Steering sensitivity multiplier (0.6 - 1.6). */
  steering: number;
  /** Police chases on (off = free roam). */
  police: boolean;
  /** Bests. */
  topSpeedKmh: number;
  longestJump: number;
  bestDrift: number;
  distanceKm: number;
  /** Police record: banked bounty, escapes, busts, best single-chase bounty. */
  bounty: number;
  escapes: number;
  busts: number;
  bestBounty: number;
  /** Last position, so the player resumes where they parked. */
  pos: { x: number; z: number; heading: number } | null;
}

export const SAVE_KEY = "fairbay-heat.save.v1";

export function defaults(): SaveData {
  return {
    version: 1,
    discovered: ["mustanger"],
    carId: "mustanger",
    colorIndex: 0,
    quality: "high",
    volume: 0.7,
    muted: false,
    timeSpeed: 60,
    hours: 17.2,
    camera: 0,
    showFps: false,
    steering: 1,
    police: true,
    topSpeedKmh: 0,
    longestJump: 0,
    bestDrift: 0,
    distanceKm: 0,
    bounty: 0,
    escapes: 0,
    busts: 0,
    bestBounty: 0,
    pos: null,
  };
}

const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

export function parseSave(raw: string | null): SaveData {
  const d = defaults();
  if (!raw) return d;
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return d;
    o = parsed as Record<string, unknown>;
  } catch {
    return d;
  }
  const ids = new Set(CARS.map((c) => c.id));
  const discovered = Array.isArray(o.discovered) ? [...new Set(o.discovered.filter((x): x is string => typeof x === "string" && ids.has(x)))] : d.discovered;
  if (!discovered.includes("mustanger")) discovered.unshift("mustanger");
  const carId = typeof o.carId === "string" && discovered.includes(o.carId) ? o.carId : "mustanger";
  const car = CARS.find((c) => c.id === carId)!;
  const quality: Quality = o.quality === "low" || o.quality === "medium" || o.quality === "high" ? o.quality : d.quality;
  let pos: SaveData["pos"] = null;
  if (o.pos && typeof o.pos === "object") {
    const p = o.pos as Record<string, unknown>;
    if (typeof p.x === "number" && typeof p.z === "number" && typeof p.heading === "number" && [p.x, p.z, p.heading].every(Number.isFinite)) {
      pos = { x: p.x, z: p.z, heading: p.heading };
    }
  }
  return {
    version: 1,
    discovered,
    carId,
    colorIndex: Math.round(num(o.colorIndex, 0, 0, car.colors.length - 1)),
    quality,
    volume: num(o.volume, d.volume, 0, 1),
    muted: typeof o.muted === "boolean" ? o.muted : d.muted,
    timeSpeed: num(o.timeSpeed, d.timeSpeed, 0, 600),
    hours: num(o.hours, d.hours, 0, 23.999),
    camera: Math.round(num(o.camera, 0, 0, 2)),
    showFps: typeof o.showFps === "boolean" ? o.showFps : d.showFps,
    steering: num(o.steering, d.steering, 0.6, 1.6),
    police: typeof o.police === "boolean" ? o.police : d.police,
    topSpeedKmh: num(o.topSpeedKmh, 0, 0, 1000),
    longestJump: num(o.longestJump, 0, 0, 1000),
    bestDrift: num(o.bestDrift, 0, 0, 1e7),
    distanceKm: num(o.distanceKm, 0, 0, 1e6),
    bounty: num(o.bounty, 0, 0, 1e12),
    escapes: Math.round(num(o.escapes, 0, 0, 1e6)),
    busts: Math.round(num(o.busts, 0, 0, 1e6)),
    bestBounty: num(o.bestBounty, 0, 0, 1e12),
    pos,
  };
}

export function loadSave(storage: Pick<Storage, "getItem"> | null = safeStorage()): SaveData {
  try {
    return parseSave(storage?.getItem(SAVE_KEY) ?? null);
  } catch {
    return defaults();
  }
}

export function writeSave(s: SaveData, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(SAVE_KEY, JSON.stringify(s));
  } catch {
    /* storage full or blocked (private mode) - the game keeps running */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
