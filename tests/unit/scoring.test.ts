import { describe, expect, it } from "vitest";
import { BANK_DELAY, DriftScore, JumpTracker, MIN_DRIFT_SCORE } from "../../src/game/scoring";

describe("drift score", () => {
  it("accrues while sliding and banks after the car straightens", () => {
    const d = new DriftScore();
    let banked = 0;
    for (let t = 0; t < 2; t += 0.01) banked ||= d.update(0.01, true, 25, 0.6, 0);
    expect(banked).toBe(0);
    expect(d.points).toBeGreaterThan(MIN_DRIFT_SCORE);
    const pts = d.points;
    for (let t = 0; t < BANK_DELAY + 0.05; t += 0.01) banked ||= d.update(0.01, false, 25, 0, 0);
    expect(banked).toBeCloseTo(pts, 5);
    expect(d.points).toBe(0);
  });

  it("a crash mid-drift loses the points", () => {
    const d = new DriftScore();
    for (let t = 0; t < 1; t += 0.01) d.update(0.01, true, 25, 0.6, 0);
    expect(d.update(0.01, true, 25, 0.6, 12)).toBe(-1);
    expect(d.points).toBe(0);
  });

  it("a tiny wiggle is not worth banking", () => {
    const d = new DriftScore();
    d.update(0.05, true, 10, 0.2, 0);
    let banked = 0;
    for (let t = 0; t < 2; t += 0.01) banked ||= d.update(0.01, false, 10, 0, 0);
    expect(banked).toBe(0);
  });

  it("slow or straight driving scores nothing", () => {
    const d = new DriftScore();
    for (let t = 0; t < 2; t += 0.01) d.update(0.01, true, 4, 0.8, 0);
    for (let t = 0; t < 2; t += 0.01) d.update(0.01, true, 30, 0.05, 0);
    expect(d.points).toBe(0);
  });
});

describe("jump tracker", () => {
  it("measures take-off to landing distance", () => {
    const j = new JumpTracker();
    expect(j.update(false, 0, 0, 0)).toBe(0);
    expect(j.update(true, 0, 2, 10)).toBe(0);
    expect(j.update(true, 0, 5, 30)).toBe(0);
    expect(j.update(false, 0, 0, 52)).toBeCloseTo(42);
    expect(j.maxHeight).toBe(5);
  });
});
