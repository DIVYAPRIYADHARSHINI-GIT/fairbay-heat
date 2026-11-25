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
