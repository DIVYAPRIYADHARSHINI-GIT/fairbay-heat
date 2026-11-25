import { describe, expect, it } from "vitest";
import { World } from "../../src/game/world";
import { Traffic, idmAccel, IDM } from "../../src/game/traffic";
import { signalState } from "../../src/game/roads";

const world = new World({ bare: true });
const DT = 1 / 30;

describe("IDM car-following", () => {
  it("accelerates on a free road and settles at the desired speed", () => {
    let v = 0;
    for (let t = 0; t < 60; t += 0.1) v += idmAccel(v, 15, Infinity, 0) * 0.1;
    expect(v).toBeGreaterThan(14);
    expect(v).toBeLessThanOrEqual(15.01);
  });

  it("brakes for a stopped car ahead and stops before it", () => {
    let v = 14;
    let x = 0;
    const obstacle = 90;
    for (let t = 0; t < 40; t += 0.05) {
      v = Math.max(0, v + idmAccel(v, 15, obstacle - x, v) * 0.05);
      x += v * 0.05;
    }
    expect(v).toBeLessThan(0.2);
    expect(x).toBeLessThan(obstacle - IDM.s0 * 0.5);
    expect(x).toBeGreaterThan(obstacle - 8);
  });

  it("keeps roughly a T-second gap behind a car at steady speed", () => {
    let v = 12;
    let gap = 60;
    for (let t = 0; t < 120; t += 0.05) {
      v = Math.max(0, v + idmAccel(v, 20, gap, v - 12) * 0.05);
      gap += (12 - v) * 0.05;
    }
    expect(Math.abs(v - 12)).toBeLessThan(0.3);
    expect(gap).toBeGreaterThan(IDM.s0 + 12 * IDM.T * 0.8);
  });
});

function soak(seconds: number, count: number, seed: number) {
  const tr = new Traffic(world.net, seed, world.ground);
  tr.target = count;
  const fx = world.circle.x;
  const fz = world.circle.z;
  for (let i = 0; i < count * 4 && tr.cars.length < count; i++) tr.spawnNear(fx, fz, null, 0, 700);
  let overlaps = 0;
  let redRuns = 0;
  const still = new Map<number, number>();
  let maxStill = 0;
  let distance = 0;
  let steps = 0;
  const prev = new Map<number, number>();
  for (let t = 0; t < seconds; t += DT) {
    for (const c of tr.cars) prev.set(c.id, c.seg.id);
    tr.step(DT, null, fx, fz, null);
    steps++;
    for (const c of tr.cars) {
      distance += c.v * DT;
      if (prev.get(c.id) !== c.seg.id && c.seg.kind === "conn" && c.seg.group >= 0) {
        // A real violation: the light was already red 1.6 s ago (not a yellow-light crossing).
        if (signalState(c.seg.node!, c.seg.group, tr.time) === "red" && signalState(c.seg.node!, c.seg.group, tr.time - 1.6) === "red") redRuns++;
      }
      const s = c.v < 0.3 ? (still.get(c.id) ?? 0) + DT : 0;
      still.set(c.id, s);
      maxStill = Math.max(maxStill, s);
    }
    if (steps % 15 === 0) {
      const cs = tr.cars;
      for (let i = 0; i < cs.length; i++) {
        for (let j = i + 1; j < cs.length; j++) {
          const a = cs[i];
          const b = cs[j];
          if (Math.abs(a.y - b.y) > 3) continue;
          if (Math.hypot(a.x - b.x, a.z - b.z) < Math.min(a.model.width, b.model.width) * 0.8) overlaps++;
        }
      }
    }
  }
  return { tr, overlaps, redRuns, maxStill, distance };
}

describe("traffic simulation (headless soak)", () => {
  const r = soak(300, 110, 5);

  it("keeps the population alive", () => {
    expect(r.tr.cars.length).toBeGreaterThan(90);
  });

  it("cars never drive through each other", () => {
    expect(r.overlaps).toBe(0);
  });

  it("nobody runs a red light", () => {
    expect(r.redRuns).toBe(0);
  });

  it("no gridlock: no car waits more than 2 minutes, and the fleet keeps moving", () => {
    expect(r.maxStill).toBeLessThan(120);
    // 110 cars x 300 s: at least ~3 m/s average.
    expect(r.distance / (110 * 300)).toBeGreaterThan(3);
  });

  it("is deterministic for a seed", () => {
    const a = soak(20, 30, 9).tr.snapshot();
    const b = soak(20, 30, 9).tr.snapshot();
    expect(a).toEqual(b);
  });
});

describe("traffic vs player", () => {
  it("cars brake for the player's car parked in their lane", () => {
    const tr = new Traffic(world.net, 3, world.ground);
    tr.target = 0;
    const lane = world.net.road("bay-2").lanesFwd[0];
    const car = tr.add(lane, 10);
    car.v = 12;
    const p0 = lane.poly.sample(80);
    const player = { x: p0.x, z: p0.z, vx: 0, vz: 0, heading: car.heading, radius: 0.9, length: 4.5 };
    for (let t = 0; t < 15; t += DT) tr.step(DT, player, p0.x, p0.z, null);
    expect(car.v).toBeLessThan(0.3);
    expect(Math.hypot(car.x - p0.x, car.z - p0.z)).toBeGreaterThan(4.5);
  });

  it("ramming a car knocks it away, reports the hit and makes the driver honk", () => {
    const tr = new Traffic(world.net, 4, world.ground);
    tr.target = 0;
    const lane = world.net.road("bay-2").lanesFwd[0];
    const car = tr.add(lane, 60);
    car.v = 0;
    const back = lane.poly.sample(55);
    const t = lane.poly.tangent(55);
    const player = { x: back.x, z: back.z, vx: t.tx * 25, vz: t.tz * 25, heading: Math.atan2(t.tx, t.tz), radius: 0.9, length: 4.5 };
    let hit = false;
    let honk = false;
    for (let k = 0; k < 10; k++) {
      player.x += player.vx * DT;
      player.z += player.vz * DT;
      tr.step(DT, player, player.x, player.z, null);
      const ev = tr.collide(player);
      if (ev.hits.length) hit = true;
      if (ev.horns.length) honk = true;
    }
    expect(hit).toBe(true);
    expect(honk).toBe(true);
    expect(car.wrecked).toBeGreaterThan(0);
    expect(Math.hypot(car.wvx, car.wvz)).toBeGreaterThan(5);
  });
});
