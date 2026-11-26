import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { World } from "../../src/game/world";
import { CarPhysics } from "../../src/game/physics";
import { carById } from "../../src/game/cars";
import { collide } from "../../src/game/collision";
import { CameraRig } from "../../src/render/cameraRig";
import { Traffic } from "../../src/game/traffic";

// Driving UNDER bridges and the I-9 viaduct.
const w = new World();
const net = w.net;

/** Every lane path (incl. junction connectors) that passes beneath a raised deck. */
const underLanes = net.lanes.filter((seg) => {
  if (!seg.road) return false;
  for (let s = 0; s < seg.length; s += 3) {
    const p = seg.poly.sample(s);
    const here = seg.road.heightAt(seg.road.center.project(p.x, p.z).s);
    if (net.roadsAt(p.x, p.z).some((o) => o.road.heightAt(o.s) > here + 4)) return true;
  }
  return false;
});

describe("driving under bridges", () => {
  it("there are lanes under the viaduct to test (Midtown avenues, frontage roads)", () => {
    expect(underLanes.length).toBeGreaterThan(10);
  });

  it("anywhere under a deck - on the road or beside it - the ground is the street, never the deck above", () => {
    let samples = 0;
    const bad: string[] = [];
    for (const u of net.roads) {
      for (let s = u.s0 + 1; s < u.s1 - 1; s += 1.5) {
        const y0 = u.heightAt(s);
        for (const lat of [0, u.hw - 1, u.hw + 1.5, u.hw + 3.5, u.hw + 6, -(u.hw + 2.5), -(u.hw + 5)]) {
          const p = net.pointOn(u.id, s, lat);
          if (!net.roadsAt(p.x, p.z).some((o) => o.road.heightAt(o.s) > y0 + 4)) continue;
          samples++;
          const g = w.ground(p.x, p.z, y0 + 0.05);
          if (g > y0 + 1.2) bad.push(`${u.id} s=${s.toFixed(0)} lat=${lat.toFixed(1)}: ground ${g.toFixed(1)} vs street ${y0.toFixed(1)}`);
        }
      }
    }
    expect(samples).toBeGreaterThan(400);
    expect(bad).toEqual([]);
  });

  it("a car drives every lane under a deck without hitting anything, jolting or taking off", () => {
    const def = carById("carrara");
    for (const seg of underLanes) {
      const p0 = seg.poly.sample(0);
      const t0 = seg.poly.tangent(0);
      const h0 = Math.atan2(t0.tx, t0.tz);
      const car = new CarPhysics(def);
      car.place(p0.x, p0.z, h0, w.ground(p0.x, p0.z, seg.road!.heightAt(seg.road!.center.project(p0.x, p0.z).s) + 0.1));
      car.vx = Math.sin(h0) * 22;
      car.vz = Math.cos(h0) * 22;
      let impact = 0;
      let jolt = 0;
      let air = 0;
      let lastY = car.y;
      for (let k = 0; k < 120 * 6; k++) {
        const pr = seg.poly.project(car.x, car.z);
        if (pr.s > seg.length - 2) break;
        const q = seg.poly.sample(Math.min(seg.length, pr.s + 10));
        let err = Math.atan2(q.x - car.x, q.z - car.z) - car.heading;
        while (err > Math.PI) err -= 2 * Math.PI;
        while (err < -Math.PI) err += 2 * Math.PI;
        const ev = car.step(1 / 120, { throttle: car.speed < 22 ? 1 : 0, brake: 0, steer: Math.max(-1, Math.min(1, err * 2.5)), handbrake: false, nitro: false }, w.world);
        impact = Math.max(impact, ev.impact);
        jolt = Math.max(jolt, Math.abs(car.y - lastY));
        lastY = car.y;
        if (car.airborne) air++;
      }
      expect(impact, `${seg.road!.id} seg ${seg.id}`).toBeLessThan(0.5);
      expect(jolt, `${seg.road!.id} seg ${seg.id}`).toBeLessThan(0.12);
      expect(air, `${seg.road!.id} seg ${seg.id}`).toBeLessThan(4);
    }
  });

  it("the chase camera does not lurch towards the car when a deck passes overhead", () => {
    const def = carById("carrara");
    for (const seg of underLanes) {
      const cam = new THREE.PerspectiveCamera(62, 16 / 9, 0.3, 9000);
      const rig = new CameraRig(cam);
      const p0 = seg.poly.sample(0);
      const t0 = seg.poly.tangent(0);
      const h0 = Math.atan2(t0.tx, t0.tz);
      const car = new CarPhysics(def);
      car.place(p0.x, p0.z, h0, w.ground(p0.x, p0.z, seg.road!.heightAt(seg.road!.center.project(p0.x, p0.z).s) + 0.1));
      car.vx = Math.sin(h0) * 20;
      car.vz = Math.cos(h0) * 20;
      let lo = 99;
      let hi = 0;
      for (let k = 0; k < 120 * 6; k++) {
        const pr = seg.poly.project(car.x, car.z);
        if (pr.s > seg.length - 2) break;
        const q = seg.poly.sample(Math.min(seg.length, pr.s + 10));
        let err = Math.atan2(q.x - car.x, q.z - car.z) - car.heading;
        while (err > Math.PI) err -= 2 * Math.PI;
        while (err < -Math.PI) err += 2 * Math.PI;
        car.step(1 / 120, { throttle: car.speed < 20 ? 1 : 0, brake: 0, steer: Math.max(-1, Math.min(1, err * 2.5)), handbrake: false, nitro: false }, w.world);
        if (k % 2 === 0) {
          rig.update(1 / 60, car, car.x, car.y, car.z, car.heading, w.colliders, k / 120);
          if (k > 40) {
            const d = Math.hypot(cam.position.x - car.x, cam.position.z - car.z);
            lo = Math.min(lo, d);
            hi = Math.max(hi, d);
          }
        }
      }
      expect(hi - lo, `${seg.road!.id} seg ${seg.id}: camera ${lo.toFixed(1)}..${hi.toFixed(1)} m`).toBeLessThan(1.2);
    }
  });

  it("overpass columns are solid, and stand clear of every lane below them", () => {
    expect(w.piers.length).toBeGreaterThan(40);
    const solid = w.piers.filter((p) => w.colliders.query(p.x, p.z, 2).some((c) => c.kind === "obb" && collide(p.x, p.z, 0.3, c) && c.base <= p.y0 + 0.1));
    expect(solid.length).toBe(w.piers.length);
    const clash: string[] = [];
    for (const seg of net.lanes) {
      for (let s = 0; s < seg.length; s += 1) {
        const p = seg.poly.sample(s);
        const y = seg.road ? seg.road.heightAt(seg.road.center.project(p.x, p.z).s) : w.ground(p.x, p.z, 999);
        for (const pr of w.piers) {
          if (Math.hypot(p.x - pr.x, p.z - pr.z) > 4 || y > pr.y1 - 0.5) continue;
          const c = { kind: "obb" as const, id: 0, cx: pr.x, cz: pr.z, hx: 0.8, hz: 0.8, c: Math.cos(pr.ang), s: Math.sin(pr.ang), top: 9, base: 0 };
          if (collide(p.x, p.z, 1.1, c)) clash.push(`${seg.id}@${s}`);
        }
      }
    }
    expect(clash).toEqual([]);
  });

  it("a car on the viaduct and a car on the street below never touch (no phantom crash through the deck)", () => {
    const tr = new Traffic(net, 3, w.ground);
    const deck = net.road("i9-2");
    const ave = net.road("main-0");
    // The point where Main Street passes under I-9.
    let best = { s: 0, su: 0, d: Infinity };
    for (let s = 0; s < deck.length; s += 1) {
      const p = deck.center.sample(s);
      const pr = ave.center.project(p.x, p.z);
      if (pr.dist < best.d) best = { s, su: pr.s, d: pr.dist };
    }
    const seg = ave.lanesFwd[0];
    const car = tr.add(seg, seg.poly.project(deck.center.sample(best.s).x, deck.center.sample(best.s).z).s);
    const p = deck.center.sample(best.s);
    const y = deck.heightAt(best.s);
    expect(y - car.y).toBeGreaterThan(5);
    // The player's car on the deck right above the traffic car, crossing it at speed.
    const ev = tr.collide({ x: car.x, y, z: car.z, vx: 30, vz: 0, heading: Math.PI / 2, radius: 0.9, length: 4.5, width: 1.9 });
    expect(ev.hits.length + ev.rubs.length).toBe(0);
    expect(car.wrecked).toBe(0);
    // Same spot, same level: that IS a crash.
    const ev2 = tr.collide({ x: car.x, y: car.y, z: car.z, vx: 30, vz: 0, heading: Math.PI / 2, radius: 0.9, length: 4.5, width: 1.9 });
    expect(ev2.hits.length).toBe(1);
    void p;
  });
});
