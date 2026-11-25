import { describe, expect, it } from "vitest";
import { World } from "../../src/game/world";
import { collide } from "../../src/game/collision";
import { JACK_SPOTS, JACK_SPOT_DEFS, JACK_RANGE, jackable, nearestSpot, discoveredCount, setJackSpots } from "../../src/game/jack";
import { CARS, carById, ratings } from "../../src/game/cars";
import { defaults, parseSave, loadSave, writeSave, SAVE_KEY } from "../../src/game/save";
import { actionsFor, DEFAULT_BINDINGS, gameCodes } from "../../src/core/input";
import { mulberry32, wrapAngle } from "../../src/core/math";

const city = new World({ jackSpots: JACK_SPOT_DEFS });
setJackSpots(city.jackSpots);

describe("jack spots", () => {
  it("every car in the catalogue can be found somewhere in the city", () => {
    for (const c of CARS) expect(JACK_SPOTS.some((s) => s.carId === c.id)).toBe(true);
  });

  it("every spot is kerbside: just off the carriageway, on solid level ground, clear of obstacles and junctions", () => {
    expect(JACK_SPOTS.length).toBe(JACK_SPOT_DEFS.length);
    for (const s of JACK_SPOTS) {
      // Not in a traffic lane...
      expect(city.net.roadAt(s.x, s.z), s.id).toBeNull();
      // ...but right next to one.
      expect(city.net.nearestRoad(s.x, s.z, 14)?.dist ?? 99, s.id).toBeLessThan(city.net.nearestRoad(s.x, s.z, 14)!.road.hw + 6.5);
      expect(city.isWater(s.x, s.z), s.id).toBe(false);
      for (const c of city.colliders.query(s.x, s.z, 6)) {
        if (c.kind === "circle" && c.breakable) continue;
        expect(collide(s.x, s.z, 2.4, c), s.id).toBeNull();
      }
      for (const n of city.net.nodes.values()) expect(Math.hypot(s.x - n.x, s.z - n.z), s.id).toBeGreaterThan(n.radius + 4);
      // Level enough to park on.
      const fx = Math.sin(s.heading) * 2;
      const fz = Math.cos(s.heading) * 2;
      expect(Math.abs(city.ground(s.x + fx, s.z + fz) - city.ground(s.x - fx, s.z - fz)), s.id).toBeLessThan(0.9);
    }
  });

  it("spots are spread out (at least 100 m apart) and colours are valid", () => {
    for (const a of JACK_SPOTS) {
      expect(a.color).toBeLessThan(carById(a.carId).colors.length);
      for (const b of JACK_SPOTS) if (a !== b) expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(100);
    }
  });

  it("can jack only when close AND slow", () => {
    const s = JACK_SPOTS[0];
    expect(jackable(s.x + 3, s.z, 10, "mustanger")).toBe(s);
    expect(jackable(s.x + 3, s.z, 90, "mustanger")).toBeNull();
    expect(jackable(s.x + JACK_RANGE + 1, s.z, 0, "mustanger")).toBeNull();
    expect(nearestSpot(s.x, s.z)!.dist).toBe(0);
  });

  it("counts discovered cars, ignoring junk ids", () => {
    expect(discoveredCount(["mustanger", "carrara", "nope"])).toEqual({ found: 2, total: CARS.length });
  });
});

describe("save data", () => {
  it("round-trips", () => {
    const store = new Map<string, string>();
    const st = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const s = defaults();
    s.discovered.push("veyrone");
    s.carId = "veyrone";
    s.pos = { x: 10, z: 20, heading: 1 };
    writeSave(s, st);
    expect(store.has(SAVE_KEY)).toBe(true);
    expect(loadSave(st)).toEqual(s);
  });

  it("survives corrupt, hostile or partial data", () => {
    expect(parseSave("{not json")).toEqual(defaults());
    expect(parseSave("null")).toEqual(defaults());
    expect(parseSave("42")).toEqual(defaults());
    const p = parseSave(JSON.stringify({ discovered: ["veyrone", 7, "hax"], carId: "aventura", volume: 9, quality: "ultra", pos: { x: "a" }, colorIndex: 99 }));
    expect(p.discovered).toEqual(["mustanger", "veyrone"]);
    expect(p.carId).toBe("mustanger"); // not discovered -> refused
    expect(p.volume).toBe(1);
    expect(p.quality).toBe("high");
    expect(p.pos).toBeNull();
    expect(p.colorIndex).toBe(carById("mustanger").colors.length - 1);
  });

  it("blocked storage never throws", () => {
    const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } };
    expect(loadSave(bad)).toEqual(defaults());
    expect(() => writeSave(defaults(), bad)).not.toThrow();
  });
});

describe("cars catalogue", () => {
  it("has unique ids and names that resemble (but are not) the real car", () => {
    expect(new Set(CARS.map((c) => c.id)).size).toBe(CARS.length);
    for (const c of CARS) {
      expect(c.name).not.toBe(c.inspiredBy);
      expect(c.colors.length).toBeGreaterThanOrEqual(3);
      for (const col of c.colors) expect(col).toMatch(/^#[0-9a-f]{6}$/i);
      const r = ratings(c.handling);
      for (const v of Object.values(r)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("body proportions are sane (cabin inside the body, wheels inside the length)", () => {
    for (const c of CARS) {
      const b = c.body;
      expect(b.cabinRear).toBeLessThan(b.roofRear);
      expect(b.roofRear).toBeLessThan(b.roofFront);
      expect(b.roofFront).toBeLessThan(b.cabinFront);
      expect(b.frontAxle).toBeLessThan(0.5);
      expect(b.rearAxle).toBeGreaterThan(-0.5);
      expect(b.height).toBeGreaterThan(b.cowlHeight);
    }
  });
});

describe("input bindings", () => {
  it("maps WASD and arrows to driving and has no key bound to two conflicting driving actions", () => {
    expect(actionsFor("KeyW", DEFAULT_BINDINGS)).toEqual(["accelerate"]);
    expect(actionsFor("ArrowLeft", DEFAULT_BINDINGS)).toEqual(["left"]);
    expect(actionsFor("Space", DEFAULT_BINDINGS)).toEqual(["handbrake"]);
    for (const code of gameCodes(DEFAULT_BINDINGS)) expect(actionsFor(code, DEFAULT_BINDINGS).length).toBe(1);
  });
});

describe("math", () => {
  it("mulberry32 is deterministic and in [0,1)", () => {
    const a = mulberry32(1);
    const b = mulberry32(1);
    for (let i = 0; i < 1000; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it("wrapAngle stays in (-PI, PI]", () => {
    for (const a of [-10, -Math.PI, 0, 3, 7, 100]) {
      const w = wrapAngle(a);
      expect(w).toBeGreaterThanOrEqual(-Math.PI);
      expect(w).toBeLessThanOrEqual(Math.PI);
      expect(Math.cos(w)).toBeCloseTo(Math.cos(a));
    }
  });
});
