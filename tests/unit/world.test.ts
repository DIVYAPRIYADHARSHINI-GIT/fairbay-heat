import { describe, expect, it } from "vitest";
import { World, WATER_LEVEL, coastN } from "../../src/game/world";
import { JACK_SPOT_DEFS } from "../../src/game/jack";
import { collide } from "../../src/game/collision";
import { obbOverlap } from "../../src/core/geom";
import { signalState, SIGNAL } from "../../src/game/roads";
import { ROADS, NODES } from "../../src/game/mapdata";

const world = new World({ jackSpots: JACK_SPOT_DEFS });
const net = world.net;

describe("hand-made map", () => {
  it("is deterministic", () => {
    const again = new World({ jackSpots: JACK_SPOT_DEFS });
    expect(again.buildings.length).toBe(world.buildings.length);
    expect(again.buildings[123]).toEqual(world.buildings[123]);
    expect(again.trees.length).toBe(world.trees.length);
  });

  it("is a real network, not a grid or rings: curved roads, varied junction angles, 25+ km of road", () => {
    expect(net.roads.length).toBe(ROADS.length);
    expect(net.nodes.size).toBe(NODES.length);
    const km = net.roads.reduce((a, r) => a + r.length, 0) / 1000;
    expect(km).toBeGreaterThan(25);
    // Many roads curve: heading changes by > 20 degrees along them.
    let curved = 0;
    for (const r of net.roads) {
      const a = r.center.tangent(r.s0 + 2);
      const b = r.center.tangent(r.s1 - 2);
      if (Math.acos(Math.max(-1, Math.min(1, a.tx * b.tx + a.tz * b.tz))) > (20 * Math.PI) / 180) curved++;
    }
    expect(curved).toBeGreaterThan(20);
    // Junction approach angles are not all multiples of 90 degrees.
    let oblique = 0;
    for (const n of net.nodes.values()) {
      for (const e of n.ends) {
        const d = ((((e.angle * 180) / Math.PI) % 90) + 90) % 90;
        if (d > 12 && d < 78) oblique++;
      }
    }
    expect(oblique).toBeGreaterThan(40);
  });

  it("has highways, ramps, service roads, overpasses, a roundabout, bridges and a mountain pass", () => {
    const cls = (c: string) => net.roads.filter((r) => r.cls === c).length;
    expect(cls("freeway")).toBeGreaterThanOrEqual(6);
    expect(cls("ramp")).toBeGreaterThanOrEqual(4);
    expect(cls("service")).toBeGreaterThanOrEqual(8);
    expect(net.overpassCount).toBeGreaterThanOrEqual(4);
    expect([...net.nodes.values()].filter((n) => n.kind === "roundabout").length).toBe(4);
    expect(net.roads.filter((r) => r.bridges.length > 0).length).toBeGreaterThanOrEqual(2);
    expect(net.nodes.get("SU")!.elev).toBeGreaterThan(100);
    const districts = new Set(world.buildings.map((b) => b.district));
    for (const d of ["downtown", "midtown", "oldtown", "hillcrest", "westside", "ironworks", "port", "southside"]) expect(districts.has(d as never), d).toBe(true);
    expect(world.buildings.length).toBeGreaterThan(700);
  });

  it("is asymmetric: no single centre - roads are spread unevenly in every quadrant", () => {
    // Road length per quadrant around the map centre differs a lot (rings would be even).
    const q = [0, 0, 0, 0];
    for (const r of net.roads) {
      for (let i = 1; i < r.center.n; i++) {
        const x = r.center.x[i];
        const z = r.center.z[i];
        q[(x > 0 ? 1 : 0) + (z > 0 ? 2 : 0)] += r.center.s[i] - r.center.s[i - 1];
      }
    }
    expect(Math.max(...q) / Math.min(...q)).toBeGreaterThan(1.3);
  });

  it("the I-9 viaduct passes OVER the Midtown avenues with real clearance, and you can drive underneath", () => {
    const i9 = net.road("i9-2");
    const ave = net.road("main-0");
    // Find where Main Street passes under I-9.
    let best = { s: 0, su: 0, d: Infinity };
    for (let s = 0; s < i9.length; s += 1) {
      const p = i9.center.sample(s);
      const pr = ave.center.project(p.x, p.z);
      if (pr.dist < best.d) best = { s, su: pr.s, d: pr.dist };
    }
    expect(best.d).toBeLessThan(1);
    const deck = i9.heightAt(best.s);
    const under = ave.heightAt(best.su);
    expect(deck - under).toBeGreaterThan(6.5);
    const p = i9.center.sample(best.s);
    // A car on the deck stays on the deck, a car below stays below.
    expect(world.ground(p.x, p.z, deck + 0.2)).toBeCloseTo(deck, 0);
    expect(world.ground(p.x, p.z, under + 0.2)).toBeLessThan(under + 1);
  });

  it("every lane is reachable from every other (one strongly-connected network)", () => {
    const start = net.road("main-5").lanesFwd[0];
    const reach = (from: typeof start, rev: boolean) => {
      const seen = new Set([from.id]);
      const q = [from];
      const prev = new Map<number, typeof start[]>();
      if (rev) for (const s of net.segs) for (const n of s.next) prev.set(n.id, [...(prev.get(n.id) ?? []), s]);
      while (q.length) {
        const s = q.pop()!;
        for (const n of rev ? prev.get(s.id) ?? [] : s.next) {
          if (!seen.has(n.id)) {
            seen.add(n.id);
            q.push(n);
          }
        }
      }
      return seen;
    };
    const fwd = reach(start, false);
    const back = reach(start, true);
    for (const l of net.lanes) {
      expect(fwd.has(l.id), `${l.road!.id} unreachable`).toBe(true);
      expect(back.has(l.id), `${l.road!.id} is a trap`).toBe(true);
    }
  });

  it("road grades are drivable (<= 10%, mountain pass <= 15%)", () => {
    for (const r of net.roads) {
      const lim = r.cls === "mountain" ? 0.151 : 0.101;
      for (let i = 1; i < r.center.n; i++) {
        const g = Math.abs(r.elev[i] - r.elev[i - 1]) / (r.center.s[i] - r.center.s[i - 1]);
        expect(g, r.id).toBeLessThanOrEqual(lim);
      }
    }
  });

  it("no building sits on a road, in water or overlaps another building", () => {
    for (const b of world.buildings) {
      const { cx, cz } = b.box;
      expect(world.net.roadAt(cx, cz, 1), `building ${b.id} on road`).toBeNull();
      expect(world.isWater(cx, cz), `building ${b.id} in water`).toBe(false);
    }
    for (let i = 0; i < world.buildings.length; i++) {
      for (let j = i + 1; j < world.buildings.length; j++) {
        const a = world.buildings[i].box;
        const b = world.buildings[j].box;
        if (Math.abs(a.cx - b.cx) > 120 || Math.abs(a.cz - b.cz) > 120) continue;
        expect(obbOverlap(a, b), `${i} overlaps ${j}`).toBe(false);
      }
    }
  });

  it("carriageways are clear of solid obstacles (every 6 m along every lane)", () => {
    for (const lane of net.lanes) {
      for (let s = 3; s < lane.length - 3; s += 6) {
        const p = lane.poly.sample(s);
        const y = world.ground(p.x, p.z, lane.road!.heightAt(lane.road!.center.project(p.x, p.z).s));
        for (const c of world.colliders.query(p.x, p.z, 3)) {
          if (c.kind === "circle" && c.breakable) continue;
          // Obstacles on a deck overhead (or below a viaduct) are not in the way.
          if (c.base > y + 2.5 || c.base + c.top < y) continue;
          const hit = collide(p.x, p.z, 0.9, c);
          expect(hit, `${lane.road!.id} @ ${s.toFixed(0)} hits ${c.kind}`).toBeNull();
        }
      }
    }
  });

  it("the driving surface is continuous along every lane and junction path (no bumps > 25 cm per metre)", () => {
    for (const seg of net.segs) {
      let prev = NaN;
      for (let s = 0; s <= seg.length; s += 1) {
        const p = seg.poly.sample(s);
        // Ask with the previous height, as a car driving along does (starting
        // from the surface it arrives on, not whatever deck is overhead).
        const from = seg.from?.road;
        const start = seg.road
          ? seg.road.heightAt(seg.road.center.project(p.x, p.z).s)
          : world.ground(p.x, p.z, from!.heightAt(seg.from!.dir > 0 ? from!.s1 : from!.s0));
        const g = world.ground(p.x, p.z, Number.isNaN(prev) ? start : prev);
        if (!Number.isNaN(prev)) expect(Math.abs(g - prev), `${seg.kind} ${seg.road?.id ?? seg.node?.id} @ ${s}`).toBeLessThan(0.25);
        prev = g;
      }
    }
  });

  it("the driving surface follows the road profile and bridges span the river above the water", () => {
    const r = net.roads.find((x) => x.bridges.length > 0 && x.cls !== "freeway")!;
    const [b0, b1] = r.bridges[0];
    const mid = (b0 + b1) / 2;
    const p = r.center.sample(mid);
    expect(world.ground(p.x, p.z)).toBeCloseTo(r.heightAt(mid), 1);
    expect(world.ground(p.x, p.z)).toBeGreaterThan(WATER_LEVEL + 2);
    // Beside the bridge is water.
    const t = r.center.tangent(mid);
    expect(world.isWater(p.x - t.tz * 40, p.z + t.tx * 40) || world.isWater(p.x + t.tz * 40, p.z - t.tx * 40)).toBe(true);
  });

  it("the sea is south of the coast and the terrain dips below the water there", () => {
    const e = 0;
    const z = coastN(e) - 80;
    expect(world.isWater(-e, z)).toBe(true);
    expect(world.terrainAt(-e, z)).toBeLessThan(WATER_LEVEL);
    expect(world.districtOf(-e, z)).toBe("sea");
  });

  it("spawn is in a lane of Main Street downtown, on the road surface", () => {
    const s = world.spawn;
    expect(net.roadAt(s.x, s.z)?.road.id).toBe("main-5");
    expect(world.surface(s.x, s.z)).toBe("road");
  });

  it("ramps are off the traffic lanes", () => {
    for (const r of world.ramps) {
      for (let a = 0; a <= r.length; a += 2) {
        const x = r.x + Math.sin(r.heading) * a;
        const z = r.z + Math.cos(r.heading) * a;
        expect(net.roadAt(x, z, 1), r.label).toBeNull();
      }
    }
  });

  it("traffic signals cycle green -> yellow -> red and two groups are never green together", () => {
    const n = [...net.nodes.values()].find((x) => x.kind === "signal" && x.groups === 2)!;
    const cycle = 2 * (SIGNAL.green + SIGNAL.yellow + SIGNAL.allRed);
    let sawYellow = false;
    for (let t = 0; t < cycle; t += 0.25) {
      const a = signalState(n, 0, t);
      const b = signalState(n, 1, t);
      expect(a === "green" && b === "green").toBe(false);
      if (a === "yellow") sawYellow = true;
    }
    expect(sawYellow).toBe(true);
  });
});
