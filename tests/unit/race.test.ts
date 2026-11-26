import { beforeAll, describe, expect, it } from "vitest";
import { World } from "../../src/game/world";
import { RACES, Race, SpeedEvents, SPEED_EVENTS, buildRoute, crossedGate, medalFor } from "../../src/game/race";
import { carById } from "../../src/game/cars";
import { CarPhysics, NO_CONTROLS, KMH } from "../../src/game/physics";
import { Traffic } from "../../src/game/traffic";
import { wrapAngle } from "../../src/core/math";

let w: World;
beforeAll(() => {
  w = new World();
});

describe("race routes", () => {
  it("every race builds a continuous route through its roads, with checkpoints and a 4-car grid", () => {
    for (const def of RACES) {
      const r = buildRoute(w.net, def);
      expect(r.length, def.id).toBeGreaterThan(800);
      expect(r.gates.length, def.id).toBeGreaterThanOrEqual(6);
      expect(r.grid.length).toBe(4);
      // No gaps: consecutive line points are close together.
      const L = r.line;
      for (let i = 1; i < L.n; i++) expect(Math.hypot(L.x[i] - L.x[i - 1], L.z[i] - L.z[i - 1]), def.id).toBeLessThan(8);
      // Gates are in order along the route.
      for (let i = 1; i < r.gates.length; i++) expect(r.gates[i].s).toBeGreaterThan(r.gates[i - 1].s);
      // Circuits close: the end of the line meets the start.
      if (def.kind === "circuit") expect(Math.hypot(L.x[L.n - 1] - L.x[0], L.z[L.n - 1] - L.z[0])).toBeLessThan(6);
    }
  });

  it("the racing line has no hairpin kinks: junction turns are smooth arcs (radius > 10 m)", () => {
    for (const def of RACES) {
      const L = buildRoute(w.net, def).line;
      for (let s = 8; s < L.length - 8; s += 4) {
        const a = L.tangent(s - 6);
        const b = L.tangent(s + 6);
        const dh = Math.abs(wrapAngle(Math.atan2(b.tx, b.tz) - Math.atan2(a.tx, a.tz)));
        expect(12 / Math.max(dh, 1e-6), `${def.id} @ ${s}`).toBeGreaterThan(10);
      }
    }
  });

  it("the whole route is drivable road: every point is on a carriageway or in a junction", () => {
    for (const def of RACES) {
      const r = buildRoute(w.net, def);
      for (let s = 0; s < r.length; s += 5) {
        const p = r.line.sample(s);
        const ok = w.net.roadAt(p.x, p.z, 1.5) || w.net.nodeAt(p.x, p.z);
        expect(!!ok, `${def.id} @ ${s.toFixed(0)}`).toBe(true);
      }
    }
  });

  it("a gate counts only when crossed in the driving direction and within its width", () => {
    const g = { x: 0, z: 0, y: 0, hx: 0, hz: 1, hw: 6, s: 0 };
    expect(crossedGate(g, 0, -1, 0, 1)).toBe(true);
    expect(crossedGate(g, 0, 1, 0, -1)).toBe(false); // wrong way
    expect(crossedGate(g, 10, -1, 10, 1)).toBe(false); // beside the gate
    expect(crossedGate(g, 0, -3, 0, -1)).toBe(false); // not yet
  });
});

describe("race AI and flow", () => {
  it("rivals drive every race to the finish on the racing line, within realistic times", () => {
    for (const def of RACES) {
      const race = new Race(def, w.net, w.world, def.rivals.map(carById), "You");
      const player = new CarPhysics(carById("mustanger"));
      const ps = race.playerStart;
      player.place(ps.x, ps.z, ps.heading, w.ground(ps.x, ps.z, ps.y + 0.5));
      let maxOff = 0;
      for (let t = 0; t < 300; t += 1 / 30) {
        for (let k = 0; k < 4; k++) player.step(1 / 120, NO_CONTROLS, w.world);
        race.step(1 / 30, player, null);
        for (const r of race.racers) if (r.phys && race.time > 2) maxOff = Math.max(maxOff, race.route.line.project(r.phys.x, r.phys.z).dist);
        if (race.racers.filter((r) => !r.player).every((r) => r.finished)) break;
      }
      const rivals = race.racers.filter((r) => !r.player);
      expect(rivals.every((r) => r.finished), def.id).toBe(true);
      const avgKmh = ((race.route.length * def.laps) / Math.max(...rivals.map((r) => r.finishTime))) * KMH;
      expect(avgKmh, `${def.id} average speed`).toBeGreaterThan(60);
      expect(avgKmh, `${def.id} average speed`).toBeLessThan(220);
      expect(maxOff, `${def.id} max distance from the racing line`).toBeLessThan(18);
    }
  });

  it("countdown holds everyone on the grid, then GO; positions rank by checkpoints then distance", () => {
    const def = RACES[0];
    const race = new Race(def, w.net, w.world, def.rivals.map(carById), "You");
    const player = new CarPhysics(carById("mustanger"));
    const ps = race.playerStart;
    player.place(ps.x, ps.z, ps.heading, w.ground(ps.x, ps.z, ps.y + 0.5));
    const x0 = race.racers[0].phys!.x;
    const ev: string[] = [];
    for (let t = 0; t < 2.9; t += 1 / 30) ev.push(...race.step(1 / 30, player, null).map((e) => e.type));
    expect(race.state).toBe("countdown");
    expect(Math.abs(race.racers[0].phys!.x - x0)).toBeLessThan(0.3);
    for (let t = 0; t < 0.3; t += 1 / 30) ev.push(...race.step(1 / 30, player, null).map((e) => e.type));
    expect(ev).toContain("go");
    expect(race.state).toBe("racing");
    // The player starts at the back of the grid.
    expect(race.positionOf(race.player, player.x, player.z)).toBe(4);
  });

  it("a player driving the route finishes, gets a position and time; driving backwards triggers WRONG WAY", () => {
    const def = RACES[0];
    const race = new Race(def, w.net, w.world, def.rivals.map(carById), "You");
    const player = new CarPhysics(carById("veyrone"));
    const ps = race.playerStart;
    player.place(ps.x, ps.z, ps.heading, w.ground(ps.x, ps.z, ps.y + 0.5));
    // A simple line-follower for the player.
    const L = race.route.line;
    let cursor = 0;
    let wrong = false;
    let finish = null as null | { position?: number; time?: number };
    for (let t = 0; t < 200 && !finish; t += 1 / 30) {
      const pr = L.project(player.x, player.z);
      if (Math.abs(pr.s - cursor) < 60) cursor = pr.s;
      const aim = L.sample(Math.min(L.length, cursor + 10 + player.speed * 0.45));
      const err = wrapAngle(Math.atan2(aim.x - player.x, aim.z - player.z) - player.heading);
      const ctl = { throttle: player.speed < 24 ? 1 : 0, brake: player.speed > 26 ? 0.5 : 0, steer: Math.max(-1, Math.min(1, err * 2.2)), handbrake: false, nitro: false };
      for (let k = 0; k < 4; k++) player.step(1 / 120, race.state === "countdown" ? NO_CONTROLS : ctl, w.world);
      for (const e of race.step(1 / 30, player, null)) if (e.type === "finish") finish = e;
    }
    expect(finish).not.toBeNull();
    expect(finish!.position).toBeGreaterThanOrEqual(1);
    expect(finish!.time).toBeGreaterThan(30);
    // Wrong way: a fresh race, turn round and drive away from the first gate.
    const r2 = new Race(def, w.net, w.world, def.rivals.map(carById), "You");
    const p2 = new CarPhysics(carById("gtarr"));
    const s2 = r2.playerStart;
    p2.place(s2.x, s2.z, s2.heading + Math.PI, w.ground(s2.x, s2.z, s2.y + 0.5));
    for (let t = 0; t < 8; t += 1 / 30) {
      for (let k = 0; k < 4; k++) p2.step(1 / 120, r2.state === "countdown" ? NO_CONTROLS : { ...NO_CONTROLS, throttle: 1 }, w.world);
      for (const e of r2.step(1 / 30, p2, null)) if (e.type === "wrong-way") wrong = true;
    }
    expect(wrong).toBe(true);
  });

  it("rivals weave through traffic instead of ploughing into it", () => {
    const def = RACES[0];
    const tr = new Traffic(w.net, 5, w.ground);
    tr.target = 16;
    const race = new Race(def, w.net, w.world, def.rivals.map(carById), "You");
    const player = new CarPhysics(carById("mustanger"));
    const ps = race.playerStart;
    player.place(ps.x, ps.z, ps.heading, w.ground(ps.x, ps.z, ps.y + 0.5));
    for (let i = 0; i < 200 && tr.cars.length < 16; i++) tr.spawnNear(ps.x + 300, ps.z, null, 20, 400);
    let crashes = 0;
    const before = new Map<number, number>();
    for (let t = 0; t < 70; t += 1 / 30) {
      for (let k = 0; k < 4; k++) player.step(1 / 120, NO_CONTROLS, w.world);
      tr.step(1 / 30, null, ps.x + 300, ps.z, null);
      race.step(1 / 30, player, tr);
      for (const c of tr.cars) {
        if (c.wrecked > 0 && !before.has(c.id)) {
          before.set(c.id, 1);
          crashes++;
        }
      }
      if (race.racers.filter((r) => !r.player).every((r) => r.finished)) break;
    }
    expect(race.racers.filter((r) => !r.player).every((r) => r.finished)).toBe(true);
    expect(crashes).toBeLessThanOrEqual(4);
  });
});

describe("speed cameras and traps", () => {
  it("medals by speed", () => {
    expect(medalFor(150, [160, 200, 240])).toBe("none");
    expect(medalFor(170, [160, 200, 240])).toBe("bronze");
    expect(medalFor(210, [160, 200, 240])).toBe("silver");
    expect(medalFor(250, [160, 200, 240])).toBe("gold");
  });

  it("a camera photographs the speed as you pass it (either direction); a trap averages speed between its two gates", () => {
    const se = new SpeedEvents(w.net);
    const cam = se.events.find((e) => e.def.kind === "camera")!;
    // Drives a straight line at a steady speed, height interpolated (bridges climb).
    const drive = (x0: number, z0: number, x1: number, z1: number, speed: number, y0: number, y1 = y0) => {
      const out = [];
      const steps = 400;
      se.reset(x0, z0);
      const dist = Math.hypot(x1 - x0, z1 - z0);
      for (let i = 1; i <= steps; i++) out.push(...se.update(x0 + ((x1 - x0) * i) / steps, z0 + ((z1 - z0) * i) / steps, y0 + ((y1 - y0) * i) / steps, speed, dist / speed / steps));
      return out;
    };
    const a = cam.a;
    let res = drive(a.x - a.tx * 30, a.z - a.tz * 30, a.x + a.tx * 30, a.z + a.tz * 30, 60, a.y);
    expect(res.length).toBe(1);
    expect(res[0].kmh).toBeCloseTo(216, 0);
    expect(res[0].medal).toBe(medalFor(216, cam.def.targets));
    res = drive(a.x + a.tx * 30, a.z + a.tz * 30, a.x - a.tx * 30, a.z - a.tz * 30, 30, a.y);
    expect(res.length).toBe(1);
    // Trap: from before gate a to past gate b at a steady 50 m/s = 180 km/h average.
    const trap = se.events.find((e) => e.def.kind === "trap")!;
    const ta = trap.a;
    const tb = trap.b!;
    res = drive(ta.x - ta.tx * 20, ta.z - ta.tz * 20, tb.x + tb.tx * 20, tb.z + tb.tz * 20, 50, ta.y, tb.y);
    const t = res.find((r) => r.def.kind === "trap")!;
    expect(t).toBeDefined();
    expect(t.kmh).toBeGreaterThan(170);
    expect(t.kmh).toBeLessThan(190);
  });

  it("every speed event sits on a real road", () => {
    for (const d of SPEED_EVENTS) expect(() => w.net.road(d.road)).not.toThrow();
  });
});
