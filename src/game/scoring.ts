/**
 * Drift and jump scoring (pure logic, unit-tested).
 *
 * Drift: points accrue while sliding, proportional to speed x slip angle.
 * A drift is "banked" after the car has been straight for BANK_DELAY seconds;
 * a hard impact during the drift loses the points.
 *
 * Jump: horizontal distance from take-off to landing.
 */

export const BANK_DELAY = 1.2;
export const MIN_DRIFT_SCORE = 150;
export const MIN_JUMP = 8;

export class DriftScore {
  points = 0;
  private calm = 0;
  active = false;

  /** Returns the banked score when a drift finishes, else 0. */
  update(dt: number, sliding: boolean, speed: number, slip: number, impact: number): number {
    if (impact > 7 && this.points > 0) {
      this.reset();
      return -1; // drift lost
    }
    if (sliding && speed > 8 && Math.abs(slip) > 0.15) {
      this.active = true;
      this.calm = 0;
      this.points += speed * Math.min(Math.abs(slip), 1.2) * dt * 12;
      return 0;
    }
    if (this.points > 0) {
      this.calm += dt;
      this.active = false;
      if (this.calm >= BANK_DELAY) {
        const banked = this.points;
        this.reset();
        return banked >= MIN_DRIFT_SCORE ? banked : 0;
      }
    }
    return 0;
  }

  reset(): void {
    this.points = 0;
    this.calm = 0;
    this.active = false;
  }
}

export class JumpTracker {
  private startX = 0;
  private startZ = 0;
  private flying = false;
  maxHeight = 0;

  /** Returns the jump length in metres on landing, else 0. */
  update(airborne: boolean, x: number, y: number, z: number): number {
    if (airborne && !this.flying) {
      this.flying = true;
      this.startX = x;
      this.startZ = z;
      this.maxHeight = y;
    } else if (airborne) {
      this.maxHeight = Math.max(this.maxHeight, y);
    } else if (this.flying) {
      this.flying = false;
      return Math.hypot(x - this.startX, z - this.startZ);
    }
    return 0;
  }

  cancel(): void {
    this.flying = false;
  }
}

/**
 * Near misses: overtaking or passing a traffic car closely at speed WITHOUT
 * touching it. Each car counts once, when it goes from "in front of / beside
 * you" to "behind you" while the side gap was small and you were fast and
 * faster than it. Rewards nitro, like Most Wanted.
 */
/** Clear air (m) between the bodies that still counts: a pass in the next
 *  lane (4 m lanes leave ~2.2 m) counts a little, a close shave counts most. */
export const NEAR_MISS_GAP = 2.5;
export const NEAR_MISS_SPEED = 22; // m/s (~80 km/h)
export const NEAR_MISS_NITRO = 0.05;

export interface NearMissCar {
  id: number;
  x: number;
  z: number;
  heading: number;
  v: number;
  length: number;
  width: number;
}

export class NearMiss {
  /** Per tracked car: closest side gap while alongside, whether it was ever ahead. */
  private track = new Map<number, { gap: number; ahead: boolean; touched: boolean; seen: number }>();
  private time = 0;
  count = 0;
  /** Consecutive near misses within 4 s (chain bonus). */
  chain = 0;
  private lastT = -99;

  /** Marks a car as touched (rubs and crashes never count as a near miss). */
  touched(id: number): void {
    const t = this.track.get(id);
    if (t) t.touched = true;
    else this.track.set(id, { gap: 0, ahead: false, touched: true, seen: this.time });
  }

  /**
   * @returns the near misses that just happened (car ids), with the nitro each earned.
   */
  update(dt: number, px: number, pz: number, ph: number, speed: number, pLen: number, pWid: number, cars: readonly NearMissCar[]): { id: number; nitro: number; chain: number }[] {
    this.time += dt;
    const out: { id: number; nitro: number; chain: number }[] = [];
    const fx = Math.sin(ph);
    const fz = Math.cos(ph);
    for (const c of cars) {
      const dx = c.x - px;
      const dz = c.z - pz;
      if (dx * dx + dz * dz > 400) continue;
      const along = dx * fx + dz * fz;
      const side = Math.abs(-dx * fz + dz * fx);
      const gap = side - (pWid + c.width) / 2;
      let t = this.track.get(c.id);
      if (!t) this.track.set(c.id, (t = { gap: Infinity, ahead: false, touched: false, seen: this.time }));
      t.seen = this.time;
      const half = (pLen + c.length) / 2;
      if (along > -half && along < half + 2) t.gap = Math.min(t.gap, gap);
      if (along > 0) t.ahead = true;
      // Passed: now fully behind us.
      if (along < -half - 0.5 && t.ahead && !t.touched) {
        const closing = speed - c.v * Math.cos(c.heading - ph);
        if (t.gap < NEAR_MISS_GAP && t.gap > -0.05 && speed > NEAR_MISS_SPEED && closing > 4) {
          this.chain = this.time - this.lastT < 4 ? this.chain + 1 : 1;
          this.lastT = this.time;
          this.count++;
          // Closer = more nitro; chains add a bonus.
          const k = 1 + (1 - Math.max(0, t.gap) / NEAR_MISS_GAP) * 0.9 + Math.min(4, this.chain - 1) * 0.15;
          out.push({ id: c.id, nitro: NEAR_MISS_NITRO * k, chain: this.chain });
        }
        t.ahead = false;
        t.gap = Infinity;
        t.touched = false;
      }
    }
    // Forget cars we have not seen for a while.
    if (this.track.size > 200) for (const [id, t] of this.track) if (this.time - t.seen > 5) this.track.delete(id);
    return out;
  }
}
