import { describe, expect, it } from "vitest";
import { DEFAULT_BINDINGS, RESERVED_CODES, applyBindings, keyName } from "../../src/core/input";
import { NearMiss, NEAR_MISS_SPEED } from "../../src/game/scoring";
import { parseSave } from "../../src/game/save";
import { CarPhysics, NO_CONTROLS } from "../../src/game/physics";
import { carById } from "../../src/game/cars";
import { SpatialHash } from "../../src/game/collision";

describe("key remapping", () => {
  it("a custom key replaces the primary key, keeps the arrow-key alternative, and is taken off any other action", () => {
    const b = applyBindings({ accelerate: ["KeyI"], nitro: ["KeyN"] });
    expect(b.accelerate[0]).toBe("KeyI");
    expect(b.accelerate).toContain("ArrowUp");
    expect(b.nitro[0]).toBe("KeyN");
    // Binding W to something else frees it from accelerate.
    const b2 = applyBindings({ handbrake: ["KeyW"] });
    expect(b2.handbrake).toEqual(["KeyW"]);
    expect(b2.accelerate).not.toContain("KeyW");
    expect(b2.accelerate).toContain("ArrowUp");
  });

  it("no key ends up on two actions, and reserved keys (Esc, Enter, Tab...) can never be bound", () => {
    const b = applyBindings({ accelerate: ["KeyD"], right: ["KeyL"], brake: ["Escape"] });
    const seen = new Map<string, string>();
    for (const [a, codes] of Object.entries(b)) for (const c of codes) {
      expect(seen.has(c), `${c} on ${a} and ${seen.get(c)}`).toBe(false);
      seen.set(c, a);
    }
    expect(b.brake).toEqual(DEFAULT_BINDINGS.brake);
    expect(RESERVED_CODES.has("Escape")).toBe(true);
  });

  it("names keys for people", () => {
    expect(keyName("KeyW")).toBe("W");
    expect(keyName("ArrowUp")).toBe("\u2191");
    expect(keyName("ShiftLeft")).toBe("Shift");
    expect(keyName("Digit3")).toBe("3");
  });

  it("saved bindings, rain mode, records and the seen-controls flag survive a round trip; junk is dropped", () => {
    const s = parseSave(JSON.stringify({ keys: { accelerate: ["KeyI"], nitro: ["<script>"], bogus: [1] }, rain: "on", seenControls: true, races: { "midtown-sprint": { best: 61.2, pos: 2, wins: 1 }, "bad id!": { best: 1 } }, speed: { "cam-i9": 231 } }));
    expect(s.keys).toEqual({ accelerate: ["KeyI"] });
    expect(s.rain).toBe("on");
    expect(s.seenControls).toBe(true);
    expect(s.races["midtown-sprint"]).toEqual({ best: 61.2, pos: 2, wins: 1 });
    expect(Object.keys(s.races)).toEqual(["midtown-sprint"]);
    expect(s.speed["cam-i9"]).toBe(231);
    const d = parseSave(null);
    expect(d.rain).toBe("auto");
    expect(d.seenControls).toBe(false);
  });
});

describe("near-miss nitro", () => {
  const car = (id: number, x: number, z: number, v = 12) => ({ id, x, z, heading: 0, v, length: 4.7, width: 1.85 });

  it("overtaking a car close at speed without touching it is a near miss that earns nitro", () => {
    const nm = new NearMiss();
    let got: { nitro: number }[] = [];
    // Player passes along +z at 35 m/s, 2.6 m to the side of a car doing 12 m/s (gap ~0.75 m).
    for (let t = 0; t < 2; t += 1 / 60) {
      const pz = -40 + t * 35;
      const cz = t * 12;
      got = got.concat(nm.update(1 / 60, 2.6, pz, 0, 35, 4.6, 1.88, [car(1, 0, cz)]));
    }
    expect(got.length).toBe(1);
    expect(got[0].nitro).toBeGreaterThan(0.05);
  });

  it("passing far away, too slowly, or after touching the car does not count", () => {
    const run = (side: number, speed: number, touch: boolean) => {
      const nm = new NearMiss();
      let n = 0;
      for (let t = 0; t < 3; t += 1 / 60) {
        if (touch && t > 0.5 && t < 0.6) nm.touched(1);
        n += nm.update(1 / 60, side, -40 + t * speed, 0, speed, 4.6, 1.88, [car(1, 0, t * 5, 5)]).length;
      }
      return n;
    };
    expect(run(2.6, 35, false)).toBe(1);
    expect(run(6, 35, false)).toBe(0);
    expect(run(2.6, NEAR_MISS_SPEED - 4, false)).toBe(0);
    expect(run(2.6, 35, true)).toBe(0);
  });
});

describe("rain", () => {
  it("a wet road means less grip: lower cornering limit and longer braking distance", () => {
    const flat = { ground: () => 0, surface: () => "road" as const, colliders: new SpatialHash() };
    const brakeDist = (wet: number) => {
      const c = new CarPhysics(carById("gtarr"));
      c.wet = wet;
      c.place(0, 0, 0, 0);
      c.vz = 100 / 3.6;
      let z0 = c.z;
      for (let i = 0; i < 1200 && c.speed > 0.5; i++) c.step(1 / 120, { ...NO_CONTROLS, brake: 1 }, flat);
      return c.z - z0;
    };
    expect(brakeDist(1)).toBeGreaterThan(brakeDist(0) * 1.15);
    const latAcc = (wet: number) => {
      const c = new CarPhysics(carById("gtarr"));
      c.wet = wet;
      c.place(0, 0, 0, 0);
      c.vz = 25;
      let a = 0;
      for (let i = 0; i < 240; i++) {
        c.step(1 / 120, { ...NO_CONTROLS, throttle: 0.4, steer: 1 }, flat);
        a = Math.abs(c.yawRate * c.vLong);
      }
      return a;
    };
    expect(latAcc(1)).toBeLessThan(latAcc(0) * 0.9);
  });
});
