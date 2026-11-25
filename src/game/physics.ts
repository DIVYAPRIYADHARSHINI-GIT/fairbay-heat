/**
 * Arcade car physics, written from scratch (no physics engine).
 *
 * The model is deliberately "Most Wanted"-style rather than a tyre simulation:
 *  - Longitudinal: an engine curve calibrated per car so the simulated
 *    0-100 km/h time matches the car's spec, plus braking, reverse, coasting
 *    drag and nitro.
 *  - Yaw: a bicycle-model target yaw rate (speed x tan(steer) / wheelbase),
 *    capped by the car's lateral-grip limit, approached at the car's steering
 *    response rate.
 *  - Lateral: world velocity is kept as-is while the body rotates, and the
 *    sideways component is bled off at a grip rate. High grip = it carves,
 *    low grip (handbrake drift) = it slides. Part of the bled-off sideways
 *    speed is handed back to forward speed, so drifting keeps momentum.
 *  - Vertical: follows the ground height (ramps), leaves the ground when the
 *    surface drops away faster than it can follow, and flies ballistically.
 *  - Collisions: three circles along the body against the static world.
 *
 * Coordinate frame: X/Z ground plane, Y up. `heading` = 0 faces +Z; the
 * forward vector is (sin h, cos h) and positive yaw turns LEFT (towards +X).
 */

import type { CarDef } from "./cars";
import { approach, clamp, damp, dampAngle } from "../core/math";
import { collide, type CircleCollider, type Collider, type SpatialHash } from "./collision";

export const KMH = 3.6;
export const GRAVITY = 9.81 * 1.7; // heavier than real for punchy, arcade jumps

export interface Controls {
  throttle: number; // 0..1
  brake: number; // 0..1 (brake when moving forward, reverse when stopped)
  steer: number; // -1..1, positive = LEFT
  handbrake: boolean;
  nitro: boolean;
}

export const NO_CONTROLS: Controls = { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false };

export type Surface = "road" | "offroad";

export interface World {
  ground(x: number, z: number): number;
  surface(x: number, z: number): Surface;
  colliders: SpatialHash;
}

export interface StepEvents {
  /** Strongest impact speed into an obstacle this step, m/s. */
  impact: number;
  impactX: number;
  impactZ: number;
  /** Vertical speed on landing, m/s (0 if no landing). */
  landed: number;
  broken: CircleCollider[];
}

export class CarPhysics {
  // --- state -------------------------------------------------------------
  x = 0;
  y = 0;
  z = 0;
  heading = 0;
  vx = 0;
  vz = 0;
  vy = 0;
  yawRate = 0;
  /** Smoothed steering input, -1..1. */
  steer = 0;
  airborne = false;
  airTime = 0;
  drifting = false;
  /** Seconds the drift-exit condition has held. */
  private driftCalm = 0;
  nitro = 1;
  nitroActive = false;
  /** Longitudinal acceleration this step (for body pitch / brake lights). */
  accelLong = 0;
  braking = false;
  reversing = false;
  surface: Surface = "road";
  /** Visual pitch (rad, + nose up) following ramps / flight. */
  pitch = 0;
  /** Accumulated wheel rotation, rad. */
  wheelSpin = 0;
  /** Simulated engine for the HUD and sound. */
  rpm = 0;
  gear = 1;
  /** Seconds left in the current gear change (clutch open). */
  shiftT = 0;
  shiftDir = 0;
  shifts = 0;
  /** True while bouncing off the rev limiter. */
  limiter = false;
  /** Engine load 0..1 (for the sound: on-throttle vs overrun). */
  load = 0;
  throttle = 0;

  // --- derived constants -------------------------------------------------
  readonly vmax: number;
  readonly engineAccel: number;
  readonly wheelbase: number;
  readonly radius: number;
  readonly circleOffsets: number[];

  private readonly scratch: Collider[] = [];

  constructor(readonly def: CarDef) {
    const b = def.body;
    this.wheelbase = (b.frontAxle - b.rearAxle) * b.length;
    this.radius = (b.width / 2) * 0.96;
    const end = b.length / 2 - this.radius * 0.85;
    this.circleOffsets = [end, 0, -end];
    const cal = calibrateEngine(def.handling.topSpeed / KMH, def.handling.zeroTo100);
    this.engineAccel = cal.peak;
    this.vmax = cal.vmax;
  }

  get forwardX(): number {
    return Math.sin(this.heading);
  }
  get forwardZ(): number {
    return Math.cos(this.heading);
  }
  /** Speed along the car's nose, m/s (negative when reversing). */
  get vLong(): number {
    return this.vx * this.forwardX + this.vz * this.forwardZ;
  }
  /** Sideways speed, m/s (positive towards the car's right). */
  get vLat(): number {
    return this.vx * -Math.cos(this.heading) + this.vz * Math.sin(this.heading);
  }
  get speed(): number {
    return Math.hypot(this.vx, this.vz);
  }
  get speedKmh(): number {
    return this.speed * KMH;
  }
  /** Angle between where the car points and where it travels, rad. */
  get slipAngle(): number {
    if (this.speed < 2) return 0;
    return Math.atan2(this.vLat, Math.abs(this.vLong));
  }

  place(x: number, z: number, heading: number, y = 0): void {
    this.x = x;
    this.z = z;
    this.y = y;
    this.heading = heading;
    this.stop();
  }

  stop(): void {
    this.vx = this.vz = this.vy = 0;
    this.yawRate = 0;
    this.steer = 0;
    this.drifting = false;
    this.airborne = false;
    this.airTime = 0;
    this.pitch = 0;
  }

  step(dt: number, c: Controls, world: World): StepEvents {
    const ev: StepEvents = { impact: 0, impactX: 0, impactZ: 0, landed: 0, broken: [] };
    const h = this.def.handling;
    this.throttle = c.throttle;

    // Steering input is smoothed so keyboard taps don't snap the wheel.
    const steerRate = Math.abs(c.steer) > Math.abs(this.steer) ? 6 : 9;
    this.steer = approach(this.steer, c.steer, steerRate * dt);

    let fx = this.forwardX;
    let fz = this.forwardZ;
    let rx = -fz; // right vector = (-cos h, sin h)
    let rz = fx;
    let vLong = this.vx * fx + this.vz * fz;
    let vLat = this.vx * rx + this.vz * rz;
    const speed = Math.hypot(vLong, vLat);

    this.surface = world.surface(this.x, this.z);
    const offroad = this.surface === "offroad";

    // ---- nitro --------------------------------------------------------------
    this.nitroActive = c.nitro && this.nitro > 0.01 && c.throttle > 0 && vLong > 3 && !this.airborne;
    if (this.nitroActive) this.nitro = Math.max(0, this.nitro - 0.25 * dt);

    if (!this.airborne) {
      // ---- longitudinal ---------------------------------------------------
      const vmax = this.vmax * (this.nitroActive ? 1.12 : 1) * (offroad ? 0.72 : 1);
      let a = 0;
      this.braking = false;
      this.reversing = false;
      if (c.brake > 0 && vLong > 0.5) {
        a -= h.brake * c.brake;
        this.braking = true;
      } else if (c.brake > 0) {
        // Reverse up to ~35 km/h.
        this.reversing = true;
        a -= this.engineAccel * 0.55 * c.brake * clamp(1 - -vLong / 9.5, 0, 1);
      }
      if (c.throttle > 0 && vLong >= -0.5) {
        a += c.throttle * engineForce(this.engineAccel, vLong, vmax) * (this.shiftT > 0 ? 0.55 : 1);
        if (this.nitroActive) a += 7.5 * clamp(1 - vLong / vmax, 0.15, 1);
      } else if (c.throttle > 0 && vLong < -0.5) {
        a += h.brake * c.throttle; // throttle while rolling back = brake
      }
      // Rolling resistance + aero drag, plus engine braking when coasting.
      const drag = 0.25 + 0.00022 * vLong * vLong + (c.throttle === 0 && c.brake === 0 ? 1.3 : 0);
      const offDrag = offroad ? 2.2 + 0.0015 * vLong * vLong : 0;
      const handbrakeDrag = c.handbrake ? (this.drifting ? 1.6 : 5) : 0;
      const resist = drag + offDrag + handbrakeDrag;
      // Gravity along the slope: climbing slows you, descending speeds you up.
      const ahead = world.ground(this.x + fx * 1.5, this.z + fz * 1.5);
      const behind = world.ground(this.x - fx * 1.5, this.z - fz * 1.5);
      const grade = clamp((ahead - behind) / 3, -0.4, 0.4);
      a -= 9.81 * grade;
      const before = vLong;
      vLong += a * dt;
      // Resistances oppose motion but never reverse it.
      vLong = approach(vLong, 0, resist * dt);
      if (before > 0 && c.brake > 0 && vLong < 0 && c.throttle === 0 && this.braking) vLong = 0;
      this.accelLong = (vLong - before) / dt;

      // ---- drift state ---------------------------------------------------
      const slip = speed > 2 ? Math.atan2(vLat, Math.abs(vLong)) : 0;
      if (!this.drifting) {
        const kick = c.handbrake && speed > 11 && Math.abs(this.steer) > 0.15;
        const powerOver = h.drive !== "FWD" && c.throttle > 0 && Math.abs(slip) > 0.32 && speed > 13;
        if (kick || powerOver) {
          this.drifting = true;
          this.driftCalm = 0;
          if (kick) this.yawRate += this.steer * 0.9;
        }
      } else {
        const calm = !c.handbrake && Math.abs(slip) < 0.1;
        this.driftCalm = calm ? this.driftCalm + dt : 0;
        if (this.driftCalm > 0.15 || speed < 5) this.drifting = false;
      }

      // ---- yaw -------------------------------------------------------------
      const maxSteer = 0.58 / (1 + Math.abs(vLong) / 22);
      const steerAngle = this.steer * maxSteer;
      let targetYaw = (vLong * Math.tan(steerAngle)) / this.wheelbase;
      if (this.drifting) {
        // Steering holds the drift angle; counter-steer straightens it out.
        const auth = clamp(speed / 18, 0.3, 1);
        targetYaw = this.steer * 1.7 * auth;
      } else {
        const limit = h.cornering / Math.max(Math.abs(vLong), 4);
        targetYaw = clamp(targetYaw, -limit, limit);
      }
      const response = this.drifting ? 3.2 : h.response;
      this.yawRate = damp(this.yawRate, targetYaw, response, dt);

      // ---- lateral grip ----------------------------------------------------
      let grip = this.drifting ? h.driftGrip : h.grip;
      if (c.handbrake) grip = Math.min(grip, h.driftGrip * 0.8);
      if (offroad) grip *= 0.6;
      const total = Math.hypot(vLong, vLat);
      const newLat = vLat * Math.exp(-grip * dt);
      const lost = Math.abs(vLat - newLat);
      vLat = newLat;
      // Hand part of the scrubbed sideways speed back to forward speed (keeps
      // momentum through drifts) without ever gaining total speed.
      if (Math.abs(vLong) > 1) {
        vLong += Math.sign(vLong) * lost * (this.drifting ? 0.55 : 0.3);
        const now = Math.hypot(vLong, vLat);
        if (now > total && now > 0) {
          vLong *= total / now;
          vLat *= total / now;
        }
      }

      this.vx = fx * vLong + rx * vLat;
      this.vz = fz * vLong + rz * vLat;

      // ---- nitro refill ------------------------------------------------------
      if (this.drifting) this.nitro += 0.13 * clamp(speed / 25, 0, 1) * dt;
      else if (speed > 30 && !this.nitroActive) this.nitro += 0.012 * dt;
    } else {
      // In the air: no traction, gentle yaw decay, keep velocity.
      this.yawRate *= Math.exp(-1.2 * dt);
      this.accelLong = 0;
      this.nitro += 0.15 * dt;
      this.airTime += dt;
    }
    this.nitro = clamp(this.nitro, 0, 1);

    this.heading += this.yawRate * dt;
    this.x += this.vx * dt;
    this.z += this.vz * dt;

    // ---- vertical ------------------------------------------------------------
    const g = world.ground(this.x, this.z);
    if (!this.airborne) {
      if (g < this.y - 0.3) {
        this.airborne = true;
        this.airTime = 0;
      } else {
        this.vy = clamp((g - this.y) / dt, -20, 20);
        this.y = g;
      }
    }
    if (this.airborne) {
      this.vy -= GRAVITY * dt;
      this.y += this.vy * dt;
      if (this.y <= g) {
        ev.landed = -this.vy;
        this.y = g;
        this.vy = 0;
        this.airborne = false;
        this.airTime = 0;
        // A hard landing scrubs a little speed.
        const k = 1 - clamp(ev.landed * 0.012, 0, 0.12);
        this.vx *= k;
        this.vz *= k;
      }
    }

    // ---- collisions ----------------------------------------------------------
    this.resolveCollisions(world, ev);

    // ---- cosmetic state ------------------------------------------------------
    fx = this.forwardX;
    fz = this.forwardZ;
    rx = -fz;
    rz = fx;
    vLong = this.vx * fx + this.vz * fz;
    const half = this.wheelbase / 2;
    let targetPitch: number;
    if (this.airborne) {
      targetPitch = clamp(Math.atan2(this.vy, Math.max(Math.abs(vLong), 1)) * 0.6, -0.5, 0.5);
    } else {
      const gf = world.ground(this.x + fx * half, this.z + fz * half);
      const gr = world.ground(this.x - fx * half, this.z - fz * half);
      targetPitch = Math.atan2(gf - gr, this.wheelbase);
    }
    this.pitch = damp(this.pitch, targetPitch, this.airborne ? 3 : 14, dt);
    this.wheelSpin += (vLong / this.def.body.wheelRadius) * dt;
    this.updateEngine(c, vLong, dt);
    return ev;
  }

  private resolveCollisions(world: World, ev: StepEvents): void {
    const fx = this.forwardX;
    const fz = this.forwardZ;
    const near = world.colliders.query(this.x, this.z, this.def.body.length / 2 + 2, this.scratch);
    if (near.length === 0) return;
    let stepImpact = 0;
    for (let iter = 0; iter < 2; iter++) {
      for (const off of this.circleOffsets) {
        const cx = this.x + fx * off;
        const cz = this.z + fz * off;
        for (const col of near) {
          if (col.kind === "circle" && col.broken) continue;
          if (this.y > col.base + col.top) continue; // flying over it
          if (col.kind !== "circle" && col.ramp && this.y > col.base + col.top * 0.4) continue; // on the ramp itself
          const hit = collide(cx, cz, this.radius, col);
          if (!hit) continue;
          const vn = this.vx * hit.nx + this.vz * hit.nz;
          if (col.kind === "circle" && col.breakable) {
            // Knock the lamp post over and plough on, slightly slower.
            col.broken = true;
            ev.broken.push(col);
            this.vx *= 0.88;
            this.vz *= 0.88;
            continue;
          }
          this.x += hit.nx * hit.depth;
          this.z += hit.nz * hit.depth;
          if (vn < 0) {
            const impact = -vn;
            if (impact > ev.impact) {
              ev.impact = impact;
              ev.impactX = cx - hit.nx * this.radius;
              ev.impactZ = cz - hit.nz * this.radius;
            }
            const restitution = 0.22;
            this.vx -= (1 + restitution) * vn * hit.nx;
            this.vz -= (1 + restitution) * vn * hit.nz;
            stepImpact = Math.max(stepImpact, impact);
            // An off-centre hit spins the car: torque = r x F.
            // Arcade wall-ride: a glancing hit turns the car to run along the
            // wall (like NFS) instead of pinning it nose-first. A head-on hit
            // (velocity mostly into the wall) just stops it.
            const tx = -hit.nz;
            const tz = hit.nx;
            const vt = this.vx * tx + this.vz * tz;
            if (Math.abs(vt) > 2 && Math.abs(vt) > impact * 0.35) {
              const s = Math.sign(vt) * (this.vLong >= 0 ? 1 : -1);
              const along = Math.atan2(tx * s, tz * s);
              this.heading = dampAngle(this.heading, along, 9, 1 / 60);
              this.yawRate *= 0.5;
            }
            if (impact > 6) this.drifting = false;
          }
        }
      }
    }
    if (stepImpact > 0) {
      // Scrape friction along the wall, applied once per step.
      const scrape = clamp(1 - stepImpact * 0.015, 0.65, 0.985);
      this.vx *= scrape;
      this.vz *= scrape;
    }
  }

  /**
   * Gearbox + engine speed. Gear ratios are geometric (like a real box), so
   * each upshift drops the revs by a realistic ratio. Shifts happen at ~92%
   * of redline under throttle (earlier when cruising), downshifts when revs
   * fall low, and every shift takes a short time during which the clutch is
   * open - the sound model uses `shiftT` to make the revs fall and catch.
   */
  private updateEngine(c: Controls, vLong: number, dt: number): void {
    const e = this.def.handling.engine;
    const v = Math.abs(vLong);
    // Overall ratio: rpm per (m/s) in each gear. Top gear hits redline at vmax.
    const ratios = GEAR_SPREAD.map((k) => (e.redline / this.vmax) * k);
    const wheelRpm = (g: number) => v * ratios[g - 1];
    this.shiftT = Math.max(0, this.shiftT - dt);
    if (vLong < -0.5) this.gear = 0;
    else if (this.gear === 0) this.gear = 1;
    if (this.gear >= 1 && this.shiftT === 0 && !this.airborne) {
      const r = wheelRpm(this.gear);
      const up = c.throttle > 0 ? e.redline * 0.93 : e.redline * 0.55;
      if (r > up && this.gear < 6) {
        this.gear++;
        this.shiftT = SHIFT_TIME;
        this.shiftDir = 1;
        this.shifts++;
      } else if (this.gear > 1 && wheelRpm(this.gear - 1) < e.redline * (c.brake > 0 ? 0.8 : 0.62)) {
        this.gear--;
        this.shiftT = SHIFT_TIME * 0.7;
        this.shiftDir = -1;
        this.shifts++;
      }
    }
    const g = Math.max(1, this.gear);
    // Engine speed follows the wheels in gear; free-revs with the clutch
    // open (launch, shifts, airborne, wheelspin in drifts).
    let target = Math.max(e.idle, wheelRpm(g));
    const launch = v < 6 && c.throttle > 0;
    if (launch) target = Math.max(target, e.idle + (e.redline - e.idle) * 0.45);
    if (this.drifting && c.throttle > 0) target = Math.min(e.redline, target * 1.18 + 600);
    if (this.airborne && c.throttle > 0) target = e.redline;
    let rate = 9;
    if (this.shiftT > 0) {
      // Clutch open: revs fall freely (or blip up on a downshift).
      target = this.shiftDir > 0 ? Math.max(e.idle, this.rpm * 0.9) : Math.min(e.redline, target * 1.08);
      rate = 14;
    }
    this.limiter = c.throttle > 0 && target >= e.redline * 0.995;
    target = Math.min(target, e.redline);
    this.rpm = this.rpm === 0 ? target : this.rpm + (target - this.rpm) * (1 - Math.exp(-rate * dt));
    this.load = c.throttle > 0 ? (this.shiftT > 0 ? 0.15 : 1) : 0;
  }
}

export const GEAR_SPREAD = [3.35, 2.25, 1.68, 1.33, 1.13, 1.0];
export const SHIFT_TIME = 0.16;

/** Engine thrust curve: full at standstill, tapering to zero at vmax. */
export function engineForce(peak: number, v: number, vmax: number): number {
  const r = clamp(v / vmax, 0, 1.2);
  return Math.max(0, peak * (1 - r * r * r));
}

/**
 * Calibrates the engine so the simulated car (same drag terms as `step`)
 * reaches 100 km/h in `zeroTo100` seconds AND settles exactly at the
 * published top speed. Returns the peak thrust and the internal speed at
 * which thrust fades to zero (slightly above the real top speed, because
 * drag has to be overcome there).
 */
export function calibrateEngine(topSpeed: number, zeroTo100: number): { peak: number; vmax: number } {
  const target = 100 / KMH;
  const drag = (v: number): number => 0.25 + 0.00022 * v * v;
  const timeTo = (peak: number, vmax: number): number => {
    let v = 0;
    let t = 0;
    const dt = 1 / 120;
    while (v < target && t < 60) {
      v += engineForce(peak, v, vmax) * dt;
      v = approach(v, 0, drag(v) * dt);
      t += dt;
    }
    return t;
  };
  let vmax = topSpeed;
  let peak = 10;
  for (let outer = 0; outer < 6; outer++) {
    let lo = 2;
    let hi = 40;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (timeTo(mid, vmax) > zeroTo100) lo = mid;
      else hi = mid;
    }
    peak = (lo + hi) / 2;
    // Thrust must equal drag at the published top speed.
    vmax = topSpeed / Math.cbrt(Math.max(0.05, 1 - drag(topSpeed) / peak));
  }
  return { peak, vmax };
}
