import { beforeAll, describe, expect, it } from "vitest";
import { World } from "../../src/game/world";
import { Traffic, POLICE_MODEL } from "../../src/game/traffic";
import { Police, INTERCEPTOR, ENFORCER, SPEED_LIMIT_KMH, carContact, holdControls, type PlayerView } from "../../src/game/police";
import { HeatSystem } from "../../src/game/heat";
import { CarPhysics, NO_CONTROLS, KMH, type Controls } from "../../src/game/physics";
import { carById } from "../../src/game/cars";
import { getawayDriver } from "./helpers/getaway";

const view = (c: CarPhysics): PlayerView => ({ x: c.x, y: c.y, z: c.z, vx: c.vx, vz: c.vz, heading: c.heading, speed: c.speed, car: c });

let w: World;
beforeAll(() => {
  w = new World();
});

/** A player car in lane 0 of `road` at fraction t. */
function placePlayer(carId: string, road = "kings-2", t = 0.3) {
  const car = new CarPhysics(carById(carId));
  const r = w.net.road(road);
  const p = w.net.pointOn(road, r.s0 + (r.s1 - r.s0) * t, r.laneOffset(0));
  car.place(p.x, p.z, p.heading, w.ground(p.x, p.z));
  return car;
}

/** Full chase loop at 30 Hz (physics at 120 Hz), like the game. */
function simulate(opts: { car: CarPhysics; heat: number; secs: number; drive?: () => Controls; traffic?: number; seed?: number; unitBehind?: boolean; onStep?: (t: number, pol: Police, h: HeatSystem) => boolean | void }) {
  const tr = new Traffic(w.net, opts.seed ?? 1, w.ground);
  tr.target = opts.traffic ?? 0;
  const pol = new Police(w.net, w.world, w.colliders, tr);
  pol.patrolTarget = 0;
  const h = new HeatSystem();
  const car = opts.car;
  if (opts.traffic) for (let i = 0; i < 300 && tr.cars.length < opts.traffic; i++) tr.spawnNear(car.x, car.z, null, 30, 320);
  h.force(opts.heat);
  pol.lastKnown = { x: car.x, z: car.z };
  if (opts.unitBehind) {
    const u = pol.makeUnit(INTERCEPTOR, car.x - Math.sin(car.heading) * 35, car.z - Math.cos(car.heading) * 35, car.heading, car.y, "pursue");
    u.sees = true;
  }
  const drive = opts.drive ?? (() => NO_CONTROLS);
  let rams = 0;
  let t = 0;
  for (; t < opts.secs; t += 1 / 30) {
    const ctl = drive();
    for (let k = 0; k < 4; k++) {
      car.step(1 / 120, ctl, w.world);
      rams += pol.collide(view(car)).rams.length;
    }
    if (tr.target) tr.step(1 / 30, { x: car.x, z: car.z, vx: car.vx, vz: car.vz, heading: car.heading, radius: car.radius, length: car.def.body.length }, car.x, car.z, car.heading);
    tr.obstacles = pol.trafficObstacles();
    pol.step(1 / 30, view(car), h.heat, h.state);
    h.update(1 / 30, pol.anyoneSees(), pol.nearest(car.x, car.z), car.speed, pol.boxedIn(car.x, car.z));
    if (opts.onStep?.(t, pol, h)) break;
    if (h.state === "busted" || h.state === "escaped") break;
  }
  return { pol, h, tr, rams, t };
}

describe("police: the two pursuit cars", () => {
  it("are real physics cars with sensible performance (Enforcer faster than Interceptor)", () => {
    const a = new CarPhysics(INTERCEPTOR);
    const b = new CarPhysics(ENFORCER);
    expect(b.vmax).toBeGreaterThan(a.vmax);
    expect(a.vmax * KMH).toBeGreaterThan(200);
    // The top player cars are faster than any police car: you can outrun them.
    expect(new CarPhysics(carById("veyrone")).vmax).toBeGreaterThan(b.vmax);
  });

  it("a parked police car holds still (brake at a standstill would mean reverse)", () => {
    const c = new CarPhysics(INTERCEPTOR);
    c.place(0, 0, 0, 0);
    const flat = { ground: () => 0, surface: () => "road" as const, colliders: w.colliders };
    for (let i = 0; i < 240; i++) c.step(1 / 120, holdControls(c), flat);
    expect(c.speed).toBeLessThan(0.05);
  });

  it("car-to-car contact separates along the line between the cars", () => {
    const a = new CarPhysics(INTERCEPTOR);
    const b = new CarPhysics(ENFORCER);
    a.place(0, 0, 0, 0);
    b.place(1.5, 0.5, 0, 0);
    const hit = carContact(a, b)!;
    expect(hit).not.toBeNull();
    expect(hit.nx).toBeGreaterThan(0.5);
    b.place(10, 0, 0, 0);
    expect(carContact(a, b)).toBeNull();
  });
});

describe("police AI", () => {
  it("dispatched units drive along the roads to a stopped player and make the bust without ramming them", () => {
    const car = placePlayer("mustanger");
    let samples = 0;
    let onRoad = 0;
    let maxPush = 0;
    const x0 = car.x;
    const z0 = car.z;
    const r = simulate({
      car,
      heat: 3,
      secs: 60,
      onStep: (_t, pol) => {
        for (const u of pol.units) {
          samples++;
          if (w.net.roadAt(u.phys.x, u.phys.z, 5, u.phys.y) || w.net.nodeAt(u.phys.x, u.phys.z)) onRoad++;
        }
        maxPush = Math.max(maxPush, Math.hypot(car.x - x0, car.z - z0));
      },
    });
    expect(r.h.state).toBe("busted");
    expect(onRoad / samples).toBeGreaterThan(0.97);
    // Pulled up alongside, not shoved down the street.
    expect(maxPush).toBeLessThan(3);
  });

  it("a fast car driven well escapes (cooldown, then escaped with the bounty banked)", () => {
    const car = placePlayer("veyrone");
    let first = true;
    const r = simulate({
      car,
      heat: 1,
      secs: 120,
      drive: getawayDriver(w, car, 330 / KMH, 1),
      unitBehind: true,
      onStep: (_t, _p, h) => {
        // The chase starts with an offence the unit saw.
        if (first) h.offence("speeding", true);
        first = false;
      },
    });
    expect(r.h.state).toBe("escaped");
    expect(r.h.totalBounty).toBeGreaterThan(0);
  });

  it("toned down: a mid-range car at 150-180 km/h gets away at heats 1-3, and units never ram you head-on", () => {
    const runs: [string, number, number, number][] = [
      ["mustanger", 150, 1, 1],
      ["mustanger", 150, 2, 2],
      ["mustanger", 150, 3, 1],
      ["carrara", 180, 3, 2],
    ];
    for (const [id, kmh, heat, seed] of runs) {
      const car = placePlayer(id);
      let maxRam = 0;
      const r = simulate({
        car,
        heat,
        secs: 240,
        seed,
        drive: getawayDriver(w, car, kmh / KMH, seed),
        unitBehind: true,
        onStep: (_t, pol) => {
          for (const u of pol.units) {
            // A unit coming the other way within a car length: how fast are they closing?
            const d = Math.hypot(u.phys.x - car.x, u.phys.z - car.z);
            if (d < 6) maxRam = Math.max(maxRam, -((u.phys.vx - car.vx) * (u.phys.x - car.x) + (u.phys.vz - car.vz) * (u.phys.z - car.z)) / (d || 1));
          }
        },
      });
      expect(r.h.state, `${id} ${kmh} km/h at heat ${heat}`).toBe("escaped");
      // Never a full-speed head-on (used to close at 50-65 m/s).
      expect(maxRam, `${id} ${kmh} km/h at heat ${heat}`).toBeLessThan(30);
    }
  });

  it("units keep up with a slow getaway: it never shakes them off (they stay close), and stopping gets it busted", () => {
    const car = placePlayer("mustanger");
    let near = 0;
    let n = 0;
    const r = simulate({
      car,
      heat: 3,
      secs: 120,
      drive: getawayDriver(w, car, 90 / KMH, 3),
      unitBehind: true,
      onStep: (_t, pol) => {
        n++;
        if (pol.nearest(car.x, car.z) < 25) near++;
      },
    });
    expect(r.h.state === "pursuit" || r.h.state === "busted").toBe(true);
    expect(near / n).toBeGreaterThan(0.4);
    // Then the getaway car stops (engine off, handbrake): the units pull up and make the bust.
    car.vx = car.vz = 0;
    const r2 = simulate({ car, heat: 3, secs: 45, unitBehind: true, drive: () => ({ throttle: 0, brake: 0, steer: 0, handbrake: true, nitro: false }) });
    expect(r2.h.state).toBe("busted");
  });

  it("at heat 1 units tail you but do not ram; from heat 2 they PIT", () => {
    const car1 = placePlayer("gtarr");
    const d1 = getawayDriver(w, car1, 120 / KMH, 5);
    const r1 = simulate({ car: car1, heat: 1, secs: 30, drive: d1, unitBehind: true });
    const car2 = placePlayer("gtarr");
    const d2 = getawayDriver(w, car2, 120 / KMH, 5);
    const r2 = simulate({ car: car2, heat: 3, secs: 30, drive: d2, unitBehind: true });
    expect(r1.rams).toBeLessThanOrEqual(1);
    expect(r2.rams).toBeGreaterThan(r1.rams);
  });

  it("roadblocks block the road ahead of the player out of sight, leaving one gap at a kerb", () => {
    const car = placePlayer("gtarr", "main-2", 0.2);
    const tr = new Traffic(w.net, 2, w.ground);
    tr.target = 0;
    const pol = new Police(w.net, w.world, w.colliders, tr);
    let rb = null;
    for (let i = 0; i < 20 && !rb; i++) rb = pol.placeRoadblock(view(car));
    expect(rb).not.toBeNull();
    const block = rb!;
    const d = Math.hypot(block.x - car.x, block.z - car.z);
    expect(d).toBeGreaterThan(120);
    expect(block.units.length).toBeGreaterThanOrEqual(2);
    // Sample across the carriageway at the block: some width is blocked, and
    // there is a gap at least a car wide.
    const r = block.road;
    const s = r.center.project(block.x, block.z).s;
    const p = r.center.sample(s);
    const t = r.center.tangent(s);
    let gap = 0;
    let best = 0;
    let blocked = 0;
    for (let lat = -r.hw; lat <= r.hw; lat += 0.25) {
      const x = p.x - t.tz * lat;
      const z = p.z + t.tx * lat;
      const hit = block.units.some((u) => {
        const dx = x - u.phys.x;
        const dz = z - u.phys.z;
        const along = Math.abs(dx * u.phys.forwardX + dz * u.phys.forwardZ);
        const side = Math.abs(-dx * u.phys.forwardZ + dz * u.phys.forwardX);
        return along < u.phys.def.body.length / 2 && side < u.phys.def.body.width / 2;
      });
      if (hit) {
        blocked += 0.25;
        gap = 0;
      } else best = Math.max(best, (gap += 0.25));
    }
    expect(blocked).toBeGreaterThan(r.hw);
    expect(best).toBeGreaterThan(2.1);
  });

  it("a patrol in traffic that sees you speeding turns into a pursuit unit; one that cannot see you does nothing", () => {
    const car = placePlayer("gtarr", "kings-2", 0.5);
    const tr = new Traffic(w.net, 4, w.ground);
    tr.target = 1;
    const pol = new Police(w.net, w.world, w.colliders, tr);
    pol.patrolTarget = 0;
    // A patrol 60 m ahead in the opposite lane, facing the player.
    const lane = w.net.road("kings-2").lanesBwd[0];
    const proj = lane.poly.project(car.x, car.z);
    const patrol = tr.add(lane, Math.max(5, proj.s - 60), POLICE_MODEL);
    expect(pol.patrols()).toContain(patrol);
    car.vx = Math.sin(car.heading) * ((SPEED_LIMIT_KMH + 30) / KMH);
    car.vz = Math.cos(car.heading) * ((SPEED_LIMIT_KMH + 30) / KMH);
    const ev = pol.step(1 / 30, view(car), 0, "calm");
    expect(ev.witnessed).toContain("speeding");
    expect(ev.joined.length).toBe(1);
    expect(pol.patrols().length).toBe(0);
    // Legal speed: nothing happens.
    const tr2 = new Traffic(w.net, 4, w.ground);
    const pol2 = new Police(w.net, w.world, w.colliders, tr2);
    pol2.patrolTarget = 0;
    tr2.add(lane, Math.max(5, proj.s - 60), POLICE_MODEL);
    car.vx = Math.sin(car.heading) * (60 / KMH);
    car.vz = Math.cos(car.heading) * (60 / KMH);
    expect(pol2.step(1 / 30, view(car), 0, "calm").witnessed).toEqual([]);
  });

  it("buildings block police vision", () => {
    const tr = new Traffic(w.net, 4, w.ground);
    const pol = new Police(w.net, w.world, w.colliders, tr);
    const b = w.buildings.filter((x) => x.district === "downtown" && x.box.hx > 12)[0];
    const { cx, cz, hx, c, s } = b.box;
    // Two points on opposite sides of the building, along its long axis.
    const ax = cx - c * (hx + 6);
    const az = cz - s * (hx + 6);
    const bx = cx + c * (hx + 6);
    const bz = cz + s * (hx + 6);
    expect(pol.lineOfSight(ax, az, bx, bz)).toBe(false);
    // Along the open road: clear.
    const r = w.net.road("i9-2");
    const p0 = r.center.sample(r.length * 0.3);
    const p1 = r.center.sample(r.length * 0.3 + 60);
    expect(pol.lineOfSight(p0.x, p0.z, p1.x, p1.z)).toBe(true);
  });

  it("traffic brakes for police cars instead of driving through them", () => {
    const tr = new Traffic(w.net, 9, w.ground);
    tr.target = 0;
    const pol = new Police(w.net, w.world, w.colliders, tr);
    const lane = w.net.road("kings-2").lanesFwd[0];
    const car = tr.add(lane, 20);
    car.v = 12;
    const p = lane.poly.sample(60);
    const tan = lane.poly.tangent(60);
    const u = pol.makeUnit(INTERCEPTOR, p.x, p.z, Math.atan2(tan.tx, tan.tz) + Math.PI / 2, w.ground(p.x, p.z), "roadblock");
    let minGap = Infinity;
    for (let t = 0; t < 20; t += 1 / 30) {
      tr.obstacles = pol.trafficObstacles();
      tr.step(1 / 30, null, car.x, car.z, null);
      minGap = Math.min(minGap, Math.hypot(car.x - u.phys.x, car.z - u.phys.z));
    }
    expect(car.v).toBeLessThan(0.5);
    expect(minGap).toBeGreaterThan(2.5);
  });

  it("a chase through traffic: units stay on the roads and the player never ends up inside a police car", () => {
    const car = placePlayer("gtarr");
    let worstOverlap = 0;
    let samples = 0;
    let onRoad = 0;
    simulate({
      car,
      heat: 3,
      secs: 60,
      traffic: 30,
      seed: 6,
      drive: getawayDriver(w, car, 150 / KMH, 6),
      unitBehind: true,
      onStep: (_t, pol) => {
        for (const u of pol.units) {
          if (u.mode === "roadblock" || u.mode === "wrecked") continue;
          samples++;
          if (w.net.roadAt(u.phys.x, u.phys.z, 6, u.phys.y) || w.net.nodeAt(u.phys.x, u.phys.z)) onRoad++;
          const hit = carContact(car, u.phys);
          if (hit) worstOverlap = Math.max(worstOverlap, hit.depth);
        }
      },
    });
    expect(onRoad / Math.max(1, samples)).toBeGreaterThan(0.93);
    expect(worstOverlap).toBeLessThan(0.6);
  });
});
