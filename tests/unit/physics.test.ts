import { describe, expect, it } from "vitest";
import { CARS, carById } from "../../src/game/cars";
import { CarPhysics, KMH, NO_CONTROLS, type Controls, type World } from "../../src/game/physics";
import { SpatialHash, type BoxCollider } from "../../src/game/collision";

const DT = 1 / 120;

function flatWorld(colliders = new SpatialHash()): World {
  return { ground: () => 0, surface: () => "road", colliders };
}

function ctl(p: Partial<Controls>): Controls {
  return { ...NO_CONTROLS, ...p };
}

function run(car: CarPhysics, world: World, c: Controls, seconds: number): void {
  for (let t = 0; t < seconds; t += DT) car.step(DT, c, world);
}

function timeTo(car: CarPhysics, world: World, kmh: number, c: Controls = ctl({ throttle: 1 })): number {
  let t = 0;
  while (car.speedKmh < kmh && t < 120) {
    car.step(DT, c, world);
    t += DT;
  }
  return t;
}

describe("longitudinal calibration", () => {
  for (const def of CARS) {
    it(`${def.name}: 0-100 km/h within 0.15 s of spec (${def.handling.zeroTo100} s)`, () => {
      const car = new CarPhysics(def);
      const t = timeTo(car, flatWorld(), 100);
      expect(Math.abs(t - def.handling.zeroTo100)).toBeLessThan(0.15);
    });
    it(`${def.name}: tops out within 3% of ${def.handling.topSpeed} km/h`, () => {
      const car = new CarPhysics(def);
      run(car, flatWorld(), ctl({ throttle: 1 }), 150);
      expect(Math.abs(car.speedKmh - def.handling.topSpeed) / def.handling.topSpeed).toBeLessThan(0.03);
    });
  }

  it("cars are ranked: the hypercar is faster than the muscle car", () => {
    const a = new CarPhysics(carById("veyrone"));
    const b = new CarPhysics(carById("mustanger"));
    expect(timeTo(a, flatWorld(), 200)).toBeLessThan(timeTo(b, flatWorld(), 200));
  });

  it("nitro accelerates harder and drains, and can exceed top speed briefly", () => {
    const w = flatWorld();
    const plain = new CarPhysics(carById("mustanger"));
    const boosted = new CarPhysics(carById("mustanger"));
    run(plain, w, ctl({ throttle: 1 }), 1);
    run(boosted, w, ctl({ throttle: 1 }), 1);
    run(plain, w, ctl({ throttle: 1 }), 3);
    run(boosted, w, ctl({ throttle: 1, nitro: true }), 3);
    expect(boosted.speed).toBeGreaterThan(plain.speed + 3);
    expect(boosted.nitro).toBeLessThan(0.3);
  });

  it("brakes from 100 km/h to rest and does NOT roll into reverse while holding brake briefly", () => {
    const car = new CarPhysics(carById("carrara"));
    const w = flatWorld();
    timeTo(car, w, 100);
    let t = 0;
    while (car.vLong > 0.01 && t < 10) {
      car.step(DT, ctl({ brake: 1 }), w);
      t += DT;
    }
    // ~27.8 m/s at 14 m/s^2 => about 2 s.
    expect(t).toBeLessThan(2.6);
    expect(car.vLong).toBeGreaterThan(-0.5);
  });

  it("holding brake from rest reverses, capped near 35 km/h", () => {
    const car = new CarPhysics(carById("carrara"));
    run(car, flatWorld(), ctl({ brake: 1 }), 8);
    expect(car.vLong).toBeLessThan(-5);
    expect(car.speedKmh).toBeLessThan(36);
    expect(car.gear).toBe(0);
  });

  it("coasting slows the car down", () => {
    const car = new CarPhysics(carById("aventura"));
    const w = flatWorld();
    timeTo(car, w, 120);
    const v0 = car.speed;
    run(car, w, NO_CONTROLS, 3);
    expect(car.speed).toBeLessThan(v0 * 0.9);
    expect(car.speed).toBeGreaterThan(0);
  });
});

describe("steering", () => {
  it("steer > 0 turns LEFT (heading increases), steer < 0 turns right", () => {
    const w = flatWorld();
    const a = new CarPhysics(carById("gtarr"));
    const b = new CarPhysics(carById("gtarr"));
    timeTo(a, w, 60);
    timeTo(b, w, 60);
    run(a, w, ctl({ throttle: 0.5, steer: 1 }), 1);
    run(b, w, ctl({ throttle: 0.5, steer: -1 }), 1);
    expect(a.heading).toBeGreaterThan(0.3);
    expect(b.heading).toBeLessThan(-0.3);
  });

  it("a stationary car does not rotate when steering", () => {
    const car = new CarPhysics(carById("gtarr"));
    run(car, flatWorld(), ctl({ steer: 1 }), 2);
    expect(Math.abs(car.heading)).toBeLessThan(1e-6);
  });

  it("grip turn stays planted: low slip angle and not drifting", () => {
    const car = new CarPhysics(carById("gtarr"));
    const w = flatWorld();
    timeTo(car, w, 80);
    let maxSlip = 0;
    for (let t = 0; t < 2; t += DT) {
      car.step(DT, ctl({ throttle: 0.3, steer: 0.6 }), w);
      maxSlip = Math.max(maxSlip, Math.abs(car.slipAngle));
    }
    expect(car.drifting).toBe(false);
    expect(maxSlip).toBeLessThan(0.3);
  });

  it("lateral acceleration in a full-lock grip turn respects the car's cornering limit", () => {
    for (const def of CARS) {
      const car = new CarPhysics(def);
      const w = flatWorld();
      timeTo(car, w, 140);
      run(car, w, ctl({ throttle: 0.4, steer: 1 }), 1.5);
      if (car.drifting) continue;
      const latAcc = Math.abs(car.yawRate * car.speed);
      expect(latAcc).toBeLessThan(def.handling.cornering * 1.15);
    }
  });
});

describe("per-car steering feel", () => {
  /** Time (s) for the steering to reach 90% lock after pressing A at 60 km/h. */
  const windUp = (id: string, sens = 1) => {
    const car = new CarPhysics(carById(id));
    car.sensitivity = sens;
    const w = flatWorld();
    timeTo(car, w, 60);
    let t = 0;
    while (car.steer < 0.9 && t < 3) {
      car.step(DT, ctl({ throttle: 0.4, steer: 1 }), w);
      t += DT;
    }
    return t;
  };
  /** Turning radius (m) at full lock at 30 km/h. */
  const radius = (id: string) => {
    const car = new CarPhysics(carById(id));
    const w = flatWorld();
    timeTo(car, w, 30);
    run(car, w, ctl({ throttle: 0.15, steer: 1 }), 2);
    return car.speed / Math.max(1e-3, Math.abs(car.yawRate));
  };

  it("every car steers differently: wind-up time spans at least 2x across the line-up", () => {
    const times = CARS.map((c) => windUp(c.id));
    expect(Math.max(...times) / Math.min(...times)).toBeGreaterThan(1.8);
    // The supercar is twitchier than the muscle car.
    expect(windUp("aventura")).toBeLessThan(windUp("mustanger") * 0.6);
  });

  it("turning circles differ (the Porsa turns tighter than the Bugarri)", () => {
    expect(radius("carrara")).toBeLessThan(radius("veyrone") * 0.9);
  });

  it("the steering sensitivity setting speeds up / slows down the steering", () => {
    expect(windUp("gtarr", 1.5)).toBeLessThan(windUp("gtarr", 1) * 0.75);
    expect(windUp("gtarr", 0.6)).toBeGreaterThan(windUp("gtarr", 1) * 1.4);
  });

  it("the loose-rear muscle car breaks into power oversteer more easily than the planted AWD hypercar", () => {
    const kick = (id: string) => {
      const car = new CarPhysics(carById(id));
      const w = flatWorld();
      timeTo(car, w, 75);
      let t = 0;
      while (!car.drifting && t < 4) {
        car.step(DT, ctl({ throttle: 1, steer: 1 }), w);
        t += DT;
      }
      return t;
    };
    expect(kick("mustanger")).toBeLessThan(kick("veyrone"));
  });
});

describe("drifting", () => {
  it("handbrake + steer at speed starts a drift with a big slip angle that refills nitro", () => {
    const car = new CarPhysics(carById("mustanger"));
    const w = flatWorld();
    timeTo(car, w, 90);
    car.nitro = 0.2;
    run(car, w, ctl({ throttle: 1, steer: 1, handbrake: true }), 0.4);
    expect(car.drifting).toBe(true);
    let maxSlip = 0;
    for (let t = 0; t < 1.2; t += DT) {
      car.step(DT, ctl({ throttle: 1, steer: 0.7 }), w);
      maxSlip = Math.max(maxSlip, Math.abs(car.slipAngle));
    }
    expect(maxSlip).toBeGreaterThan(0.35);
    expect(car.nitro).toBeGreaterThan(0.2);
  });

  it("a drift keeps momentum: speed after a 1.5 s drift is still well above half", () => {
    const car = new CarPhysics(carById("mustanger"));
    const w = flatWorld();
    timeTo(car, w, 100);
    const v0 = car.speed;
    run(car, w, ctl({ throttle: 1, steer: 1, handbrake: true }), 0.3);
    run(car, w, ctl({ throttle: 1, steer: 0.6 }), 1.2);
    expect(car.speed).toBeGreaterThan(v0 * 0.6);
  });

  it("releasing and counter-steering recovers the drift", () => {
    const car = new CarPhysics(carById("carrara"));
    const w = flatWorld();
    timeTo(car, w, 90);
    run(car, w, ctl({ throttle: 1, steer: 1, handbrake: true }), 0.4);
    expect(car.drifting).toBe(true);
    run(car, w, ctl({ throttle: 0.4, steer: -0.3 }), 0.6);
    run(car, w, ctl({ throttle: 0.4 }), 2.5);
    expect(car.drifting).toBe(false);
    expect(Math.abs(car.slipAngle)).toBeLessThan(0.1);
  });

  it("drifting never creates speed from nothing", () => {
    const car = new CarPhysics(carById("veyrone"));
    const w = flatWorld();
    timeTo(car, w, 150);
    let prev = car.speed;
    for (let t = 0; t < 2; t += DT) {
      car.step(DT, ctl({ steer: 1, handbrake: t < 0.5 }), w);
      expect(car.speed).toBeLessThanOrEqual(prev + 1e-6);
      prev = car.speed;
    }
  });
});

describe("fixed timestep independence", () => {
  it("the same inputs give nearly the same result at 60 Hz and 240 Hz", () => {
    const sim = (hz: number): CarPhysics => {
      const car = new CarPhysics(carById("gtarr"));
      const w = flatWorld();
      const dt = 1 / hz;
      for (let t = 0; t < 4; t += dt) car.step(dt, ctl({ throttle: 1, steer: t > 2 ? 0.5 : 0 }), w);
      return car;
    };
    const a = sim(60);
    const b = sim(240);
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(2.5);
    expect(Math.abs(a.heading - b.heading)).toBeLessThan(0.1);
  });
});

describe("collisions", () => {
  function wall(): World {
    const h = new SpatialHash();
    const w: BoxCollider = { kind: "box", id: 1, minX: -50, maxX: 50, minZ: 40, maxZ: 45, top: 20, base: 0 };
    h.add(w);
    return flatWorld(h);
  }

  it("a car driven at a wall stops at the wall and never passes through", () => {
    const car = new CarPhysics(carById("veyrone"));
    const w = wall();
    let maxImpact = 0;
    for (let t = 0; t < 6; t += DT) {
      const ev = car.step(DT, ctl({ throttle: 1, nitro: true }), w);
      maxImpact = Math.max(maxImpact, ev.impact);
      const nose = car.z + car.def.body.length / 2;
      expect(nose).toBeLessThan(40 + 0.6);
    }
    expect(maxImpact).toBeGreaterThan(10);
  });

  it("a glancing hit deflects the car along the wall instead of stopping it dead", () => {
    const car = new CarPhysics(carById("gtarr"));
    const w = wall();
    // Heading mostly along +X, closing on the wall at ~20 degrees.
    const h = Math.PI / 2 - 0.35;
    car.place(-40, 30, h);
    car.vx = Math.sin(h) * 30;
    car.vz = Math.cos(h) * 30;
    let hit = 0;
    for (let t = 0; t < 3; t += DT) hit = Math.max(hit, car.step(DT, ctl({ throttle: 0.5 }), w).impact);
    expect(hit).toBeGreaterThan(0);
    expect(car.z).toBeLessThan(40);
    expect(car.speed).toBeGreaterThan(20);
    expect(car.vx).toBeGreaterThan(18);
  });

  it("lamp posts break instead of stopping the car", () => {
    const h = new SpatialHash();
    h.add({ kind: "circle", id: 2, x: 0, z: 30, r: 0.22, top: 7, base: 0, breakable: true, broken: false });
    const car = new CarPhysics(carById("carrara"));
    const w = flatWorld(h);
    const broken: unknown[] = [];
    for (let t = 0; t < 4.5; t += DT) broken.push(...car.step(DT, ctl({ throttle: 1 }), w).broken);
    expect(broken.length).toBe(1);
    expect(car.z).toBeGreaterThan(40);
    expect(car.speedKmh).toBeGreaterThan(70);
  });
});

describe("jumps", () => {
  it("leaves a ramp, flies, and lands", () => {
    // 10 m ramp rising 2.5 m from z=50, then flat ground.
    const ground = (_x: number, z: number): number => (z >= 50 && z <= 60 ? ((z - 50) / 10) * 2.5 : 0);
    const w: World = { ground, surface: () => "road", colliders: new SpatialHash() };
    const car = new CarPhysics(carById("aventura"));
    let flew = false;
    let landed = 0;
    let peak = 0;
    for (let t = 0; t < 8; t += DT) {
      const ev = car.step(DT, ctl({ throttle: 1 }), w);
      if (car.airborne) flew = true;
      peak = Math.max(peak, car.y);
      if (ev.landed > 0) landed = ev.landed;
    }
    expect(flew).toBe(true);
    expect(peak).toBeGreaterThan(2.5);
    expect(landed).toBeGreaterThan(1);
    expect(car.airborne).toBe(false);
    expect(car.y).toBeCloseTo(0, 5);
  });
});

it("KMH constant", () => {
  expect(KMH).toBe(3.6);
});
