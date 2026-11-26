import { describe, expect, it } from "vitest";
import { CarPhysics } from "../../src/game/physics";
import { carById } from "../../src/game/cars";
import { RUB_SPEED, resolveCars } from "../../src/game/contact";
import { Traffic } from "../../src/game/traffic";
import { World } from "../../src/game/world";

function car(id: string, x: number, z: number, heading: number, v: number): CarPhysics {
  const c = new CarPhysics(carById(id));
  c.place(x, z, heading, 0);
  c.vx = Math.sin(heading) * v;
  c.vz = Math.cos(heading) * v;
  return c;
}

describe("car-to-car contact: rubs vs crashes", () => {
  it("a side-swipe at a shallow angle is a rub: cars slide past with no bounce and no speed lost", () => {
    // Overtaking at +25 m/s, easing 4 degrees into the car alongside
    // (~3 m/s sideways - a brush while weaving through traffic).
    const a = car("gtarr", 0, 0, 0.07, 45);
    const b = car("mustanger", 1.75, 0.5, 0, 20);
    const before = a.speed;
    const r = resolveCars(a, b)!;
    expect(r).not.toBeNull();
    expect(r.rel).toBeLessThan(RUB_SPEED);
    expect(r.crash).toBe(false);
    // Only the into-each-other component was removed (tiny for a shallow angle).
    expect(a.speed).toBeGreaterThan(before * 0.95);
    // No bounce: afterwards they no longer close, but do not fly apart either.
    const after = r.hit;
    const sep = (b.vx - a.vx) * after.nx + (b.vz - a.vz) * after.nz;
    expect(sep).toBeGreaterThanOrEqual(-1e-6);
    expect(sep).toBeLessThan(0.05);
  });

  it("a rear-ending at 30 km/h closing speed is a crash (with a little bounce)", () => {
    const a = car("gtarr", 0, 0, 0, 25);
    const b = car("mustanger", 0, 4.4, 0, 16.7);
    const r = resolveCars(a, b)!;
    expect(r.crash).toBe(true);
    const sep = (b.vx - a.vx) * r.hit.nx + (b.vz - a.vz) * r.hit.nz;
    expect(sep).toBeGreaterThan(0.5);
  });

  it("brushing a traffic car is a rub (it stays in its lane); hitting one squarely knocks it out", () => {
    const w = new World({ bare: true });
    const tr = new Traffic(w.net, 3, w.ground);
    tr.target = 0;
    const lane = w.net.road("kings-2").lanesFwd[0];
    const t = tr.add(lane, 60);
    t.v = 12;
    tr.step(1 / 30, null, t.x, t.z, null);
    // Player alongside, 2 m to the side, same direction, a bit faster, drifting in slowly.
    const h = t.heading;
    const rx = -Math.cos(h);
    const rz = Math.sin(h);
    const p = { x: t.x + rx * 1.7, z: t.z + rz * 1.7, vx: Math.sin(h) * 20 - rx * 1.5, vz: Math.cos(h) * 20 - rz * 1.5, heading: h, radius: 0.9, length: 4.6, width: 1.88 };
    const ev = tr.collide(p);
    expect(ev.hits.length).toBe(0);
    expect(ev.rubs.length).toBe(1);
    expect(t.wrecked).toBe(0);
    // Head-on into its side at 15 m/s: a crash.
    const p2 = { x: t.x + rx * 2.6, z: t.z + rz * 2.6, vx: -rx * 15, vz: -rz * 15, heading: h - Math.PI / 2, radius: 0.9, length: 4.6, width: 1.88 };
    const ev2 = tr.collide(p2);
    expect(ev2.hits.length).toBe(1);
    expect(t.wrecked).toBeGreaterThan(0);
  });
});
