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
  /** Rain: "auto" (weather changes by itself), "off" or "on". */
  rain: "auto" | "off" | "on";
  /** Custom key bindings (action -> key codes); missing actions use defaults. */
  keys: Record<string, string[]>;
  /** The controls card has been shown once on the first drive. */
  seenControls: boolean;
  /** Race records: best time (s) and best finishing position per race id. */
  races: Record<string, { best: number; pos: number; wins: number }>;
  /** Best speed (km/h) per speed camera / trap id. */
  speed: Record<string, number>;
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
    rain: "auto",
    keys: {},
    seenControls: false,
    races: {},
    speed: {},
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
    rain: o.rain === "off" || o.rain === "on" || o.rain === "auto" ? o.rain : d.rain,
    keys: parseKeys(o.keys),
    seenControls: typeof o.seenControls === "boolean" ? o.seenControls : false,
    races: parseRecords(o.races),
    speed: parseSpeeds(o.speed),
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

/** Key codes look like "KeyW", "ArrowUp", "ShiftLeft", "Digit1", "Space". */
const CODE_RE = /^[A-Za-z][A-Za-z0-9]{1,24}$/;

function parseKeys(v: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, codes] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[a-z]{2,16}$/.test(k) || !Array.isArray(codes)) continue;
    const ok = codes.filter((c): c is string => typeof c === "string" && CODE_RE.test(c)).slice(0, 3);
    if (ok.length) out[k] = ok;
  }
  return out;
}

function parseRecords(v: unknown): Record<string, { best: number; pos: number; wins: number }> {
  const out: Record<string, { best: number; pos: number; wins: number }> = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, r] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[a-z0-9-]{2,40}$/.test(k) || !r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    out[k] = { best: num(o.best, 0, 0, 1e5), pos: Math.round(num(o.pos, 0, 0, 10)), wins: Math.round(num(o.wins, 0, 0, 1e5)) };
  }
  return out;
}

function parseSpeeds(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, sp] of Object.entries(v as Record<string, unknown>)) if (/^[a-z0-9-]{2,40}$/.test(k)) out[k] = num(sp, 0, 0, 1000);
  return out;
}
