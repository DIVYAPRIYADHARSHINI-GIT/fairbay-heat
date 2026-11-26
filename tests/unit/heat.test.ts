import { describe, expect, it } from "vitest";
import { DEFAULT_HEAT_CONFIG, HEAT_THRESHOLDS, HeatSystem, OFFENCE_BOUNTY, enforcerShare, roadblocksAt, unitsForHeat } from "../../src/game/heat";

const DT = 1 / 30;
/** Advances the heat system `secs` seconds with fixed inputs; returns every event. */
function run(h: HeatSystem, secs: number, seen: boolean, nearest = Infinity, speed = 20, boxed = false) {
  const ev = [];
  for (let t = 0; t < secs; t += DT) ev.push(...h.update(DT, seen, nearest, speed, boxed));
  return ev;
}

describe("heat / wanted system", () => {
  it("an offence nobody sees changes nothing", () => {
    const h = new HeatSystem();
    expect(h.offence("speeding", false)).toEqual([]);
    expect(h.state).toBe("calm");
    expect(h.bounty).toBe(0);
  });

  it("an offence a cop sees starts a pursuit at heat 1 and adds bounty", () => {
    const h = new HeatSystem();
    const ev = h.offence("speeding", true);
    expect(ev.map((e) => e.type)).toEqual(["pursuit-start", "offence"]);
    expect(h.state).toBe("pursuit");
    expect(h.heat).toBe(1);
    expect(h.bounty).toBe(OFFENCE_BOUNTY.speeding);
  });

  it("one long speeding run is one offence (rate-limited), but a new kind of offence counts at once", () => {
    const h = new HeatSystem();
    h.offence("speeding", true);
    h.offence("speeding", true);
    run(h, 2, true);
    h.offence("speeding", true);
    expect(h.bounty).toBe(OFFENCE_BOUNTY.speeding);
    h.offence("rammed-car", true);
    expect(h.bounty).toBe(OFFENCE_BOUNTY.speeding + OFFENCE_BOUNTY["rammed-car"]);
  });

  it("heat rises with the bounty, and on its own as the chase drags on", () => {
    const h = new HeatSystem();
    h.offence("speeding", true); // 300 at heat 1
    // Taking out police cars: 300 + 5000 (heat 1) = 5300, still heat 1;
    // + 5000 more = 10300 > 8000 -> heat 2; + 10000 (x2) = 20300, still 2;
    // + 10000 more = 30300 > 24000 -> heat 3.
    h.offence("takedown", true);
    expect(h.heat).toBe(1);
    h.offence("takedown", true);
    expect(h.heat).toBe(2);
    h.offence("takedown", true);
    expect(h.heat).toBe(2);
    h.offence("takedown", true);
    expect(h.bounty).toBeGreaterThanOrEqual(HEAT_THRESHOLDS[3]);
    expect(h.heat).toBe(3);
    const slow = new HeatSystem();
    slow.offence("property", true);
    const ev = run(slow, 65, true);
    expect(slow.heat).toBe(2);
    expect(ev.some((e) => e.type === "heat-up" && e.heat === 2)).toBe(true);
  });

  it("losing sight of every unit starts the cooldown; being spotted again resumes the pursuit", () => {
    const h = new HeatSystem();
    h.offence("speeding", true);
    run(h, DEFAULT_HEAT_CONFIG.loseSight - 0.5, false);
    expect(h.state).toBe("pursuit");
    expect(h.evade).toBeGreaterThan(0.8);
    const ev = run(h, 1, false);
    expect(h.state).toBe("cooldown");
    expect(ev.some((e) => e.type === "cooldown")).toBe(true);
    run(h, 2, false, 300);
    expect(h.cooldown).toBeGreaterThan(0);
    const back = run(h, DT, true);
    expect(h.state).toBe("pursuit");
    expect(back.some((e) => e.type === "spotted")).toBe(true);
    expect(h.cooldown).toBe(0);
  });

  it("staying hidden through the cooldown escapes, banks the bounty, then returns to calm", () => {
    const h = new HeatSystem();
    h.offence("rammed-car", true);
    const bounty = h.bounty;
    const ev = run(h, 40, false, 500);
    expect(ev.some((e) => e.type === "escaped" && e.bounty === bounty)).toBe(true);
    expect(h.escapes).toBe(1);
    expect(h.totalBounty).toBe(bounty);
    expect(h.state).toBe("calm");
    expect(h.heat).toBe(0);
  });

  it("higher heat means a longer cooldown, and hiding far away cools faster", () => {
    const h = new HeatSystem();
    h.force(1);
    const c1 = h.cooldownLength();
    h.force(4);
    expect(h.cooldownLength()).toBeGreaterThan(c1 * 2);
    const near = new HeatSystem();
    const far = new HeatSystem();
    for (const x of [near, far]) {
      x.offence("speeding", true);
      run(x, DEFAULT_HEAT_CONFIG.loseSight + 0.1, false);
    }
    run(near, 3, false, 80);
    run(far, 3, false, 600);
    expect(far.cooldown).toBeGreaterThan(near.cooldown * 1.3);
  });

  it("a unit right on a stopped player fills the busted meter; driving away drains it", () => {
    const h = new HeatSystem();
    h.offence("speeding", true);
    run(h, DEFAULT_HEAT_CONFIG.bustTime * 0.5, true, 4, 0);
    expect(h.bust).toBeGreaterThan(0.4);
    expect(h.state).toBe("pursuit");
    run(h, 3, true, 4, 25);
    expect(h.bust).toBe(0);
    const ev = run(h, DEFAULT_HEAT_CONFIG.bustTime + 0.2, true, 4, 0);
    expect(ev.some((e) => e.type === "busted")).toBe(true);
    expect(h.state).toBe("busted");
  });

  it("busted loses the chase bounty (nothing banked) and counts a bust", () => {
    const h = new HeatSystem();
    h.offence("rammed-cop", true);
    const ev = run(h, DEFAULT_HEAT_CONFIG.bustTime + 0.2, true, 3, 0.5);
    const b = ev.find((e) => e.type === "busted");
    expect(b?.bounty).toBe(OFFENCE_BOUNTY["rammed-cop"]);
    expect(h.state).toBe("busted");
    expect(h.busts).toBe(1);
    run(h, DEFAULT_HEAT_CONFIG.endTime + 0.1, false);
    expect(h.state).toBe("calm");
    expect(h.totalBounty).toBe(0);
  });

  it("boxed in by units, even crawling along gets you busted", () => {
    const h = new HeatSystem();
    h.offence("speeding", true);
    run(h, DEFAULT_HEAT_CONFIG.bustTime + 0.3, true, 5, 3.5, true);
    expect(h.state).toBe("busted");
    const free = new HeatSystem();
    free.offence("speeding", true);
    run(free, DEFAULT_HEAT_CONFIG.bustTime + 0.3, true, 5, 3.5, false);
    expect(free.state).toBe("pursuit");
  });

  it("the police are forgiving: busting takes over 4 s stopped, and a few seconds out of sight starts the cooldown", () => {
    expect(DEFAULT_HEAT_CONFIG.bustTime).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_HEAT_CONFIG.loseSight).toBeLessThanOrEqual(4);
    // Rolling at a walking pace (3 m/s, not boxed in) never gets you busted.
    const h = new HeatSystem();
    h.offence("speeding", true);
    run(h, 20, true, 4, 3, false);
    expect(h.state).toBe("pursuit");
    expect(h.bust).toBe(0);
    // A heat-1 escape takes under 15 s of hiding.
    const e = new HeatSystem();
    e.offence("speeding", true);
    const ev = run(e, DEFAULT_HEAT_CONFIG.loseSight + 15, false, 250);
    expect(ev.some((x) => x.type === "escaped")).toBe(true);
  });

  it("more heat brings more units, faster cars and roadblocks", () => {
    for (let k = 1; k < 5; k++) {
      expect(unitsForHeat(k + 1)).toBeGreaterThanOrEqual(unitsForHeat(k));
      expect(enforcerShare(k + 1)).toBeGreaterThanOrEqual(enforcerShare(k));
    }
    expect(unitsForHeat(5)).toBeGreaterThan(unitsForHeat(1) * 2);
    expect(unitsForHeat(1)).toBe(1);
    expect(roadblocksAt(3)).toBe(false);
    expect(roadblocksAt(4)).toBe(true);
  });
});
