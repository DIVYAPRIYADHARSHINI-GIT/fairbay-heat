/**
 * Stage 3: the wanted system ("heat"), in the spirit of NFS Most Wanted.
 *
 * Pure logic, unit-tested. The flow:
 *
 *   CALM ──offence seen by a cop──▶ PURSUIT ──out of sight long enough──▶ COOLDOWN
 *     ▲                               │  ▲                                  │
 *     │                     stopped & │  └────── a cop spots you again ──────┤
 *     │                     boxed in  ▼                                     ▼
 *     └───────── (4 s) ◀──────── BUSTED                  ESCAPED ──(4 s)──▶ CALM
 *
 * - Offences only count if a police car SEES them (range, field of view, no
 *   building in the way - decided by the police module): speeding past a
 *   cop, ramming traffic or cops, smashing street furniture. Each adds to
 *   the chase's bounty.
 * - Heat level 1-5 rises with the bounty and with how long the chase has
 *   lasted. Higher heat brings more units, faster cars and roadblocks.
 * - Evading: break line of sight with every unit; after a few seconds the
 *   COOLDOWN starts (longer at high heat, faster when far from the units).
 *   Any unit seeing you during cooldown restarts the chase at the same heat.
 *   Escaping banks the bounty.
 * - Busted: while a unit is right on you and you are (nearly) stopped, the
 *   busted meter fills; it drains when you get moving. Busted loses the
 *   chase's bounty.
 */

export type HeatState = "calm" | "pursuit" | "cooldown" | "busted" | "escaped";

export type Offence = "speeding" | "rammed-car" | "rammed-cop" | "property" | "takedown";

/** Bounty for each offence, multiplied by the current heat level. */
export const OFFENCE_BOUNTY: Record<Offence, number> = {
  speeding: 300,
  "rammed-car": 750,
  "rammed-cop": 2500,
  property: 150,
  takedown: 5000,
};

/** Bounty for staying ahead of the police, per 20 s of chase (x heat). */
export const EVADE_BOUNTY = 1000;

/** Bounty needed to reach each heat level (index = level). */
export const HEAT_THRESHOLDS = [0, 0, 6000, 18000, 40000, 80000];

/** Seconds of chase that raise the heat level on their own (pressure builds). */
export const HEAT_TIME = [0, 0, 45, 100, 170, 250];

export const MAX_HEAT = 5;

export interface HeatConfig {
  /** Seconds out of sight of every unit before the cooldown begins. */
  loseSight: number;
  /** Cooldown length in seconds at heat 1 (grows with heat). */
  cooldownBase: number;
  /** Seconds the busted meter takes to fill. */
  bustTime: number;
  /** Speed (m/s) below which a player with a unit on them can be busted. */
  bustSpeed: number;
  /** Distance (m) within which a unit counts as "on you" for busting. */
  bustRange: number;
  /** How long the BUSTED / ESCAPED result stays up (s). */
  endTime: number;
}

export const DEFAULT_HEAT_CONFIG: HeatConfig = {
  loseSight: 5,
  cooldownBase: 12,
  bustTime: 3.2,
  bustSpeed: 3.5,
  bustRange: 7.5,
  endTime: 4,
};

export type HeatEventType = "pursuit-start" | "heat-up" | "offence" | "cooldown" | "spotted" | "escaped" | "busted" | "calm";

export interface HeatEvent {
  type: HeatEventType;
  heat: number;
  offence?: Offence;
  /** Bounty added (offence) or the chase's total (escaped / busted). */
  bounty?: number;
}

export class HeatSystem {
  state: HeatState = "calm";
  heat = 0;
  /** Bounty earned in the current chase. */
  bounty = 0;
  /** Bounty banked from chases you escaped. */
  totalBounty = 0;
  /** Seconds the current chase has lasted. */
  chaseTime = 0;
  /** Seconds since any unit last saw the player. */
  unseen = 0;
  /** 0..1 cooldown progress (1 = escaped). */
  cooldown = 0;
  /** 0..1 busted meter. */
  bust = 0;
  escapes = 0;
  busts = 0;
  /** Time left on the BUSTED / ESCAPED result. */
  endTimer = 0;
  /** Bounty of the chase that just ended (for the result screen). */
  lastBounty = 0;
  private lastOffence = new Map<Offence, number>();
  private time = 0;

  constructor(readonly cfg: HeatConfig = DEFAULT_HEAT_CONFIG) {}

  /** True while the police are after you (pursuit or cooldown). */
  get active(): boolean {
    return this.state === "pursuit" || this.state === "cooldown";
  }

  /** 0..1: how close you are to slipping out of sight (pursuit only). */
  get evade(): number {
    return this.state === "pursuit" ? Math.min(1, this.unseen / this.cfg.loseSight) : this.state === "cooldown" ? 1 : 0;
  }

  /** Cooldown duration in seconds at the current heat. */
  cooldownLength(): number {
    return this.cfg.cooldownBase * (1 + 0.5 * (Math.max(1, this.heat) - 1));
  }

  /**
   * Reports an offence. It only counts if a cop saw it (`seen`), and each kind
   * is rate-limited (one long speeding run is one offence, not fifty).
   */
  offence(o: Offence, seen: boolean): HeatEvent[] {
    if (!seen || this.state === "busted" || this.state === "escaped") return [];
    const last = this.lastOffence.get(o) ?? -Infinity;
    const gap = o === "speeding" ? 6 : o === "property" ? 0.6 : o === "takedown" ? 0 : 1.2;
    if (this.time - last < gap) return [];
    this.lastOffence.set(o, this.time);
    const ev: HeatEvent[] = [];
    if (this.state === "calm") {
      this.state = "pursuit";
      this.heat = 1;
      this.bounty = 0;
      this.chaseTime = 0;
      this.unseen = 0;
      this.cooldown = 0;
      this.bust = 0;
      ev.push({ type: "pursuit-start", heat: 1, offence: o });
    } else if (this.state === "cooldown") {
      this.state = "pursuit";
      this.cooldown = 0;
      this.unseen = 0;
      ev.push({ type: "spotted", heat: this.heat });
    }
    const add = OFFENCE_BOUNTY[o] * this.heat;
    this.bounty += add;
    ev.push({ type: "offence", heat: this.heat, offence: o, bounty: add });
    ev.push(...this.updateHeatLevel());
    return ev;
  }

  /** Raises the heat level when the bounty or the chase length calls for it (never lowers it). */
  private updateHeatLevel(): HeatEvent[] {
    let lvl = Math.max(1, this.heat);
    for (let k = 2; k <= MAX_HEAT; k++) if (this.bounty >= HEAT_THRESHOLDS[k] || this.chaseTime >= HEAT_TIME[k]) lvl = Math.max(lvl, k);
    if (lvl > this.heat) {
      this.heat = lvl;
      return [{ type: "heat-up", heat: lvl }];
    }
    return [];
  }

  /**
   * Advances the chase.
   * @param seen     any police unit currently has line of sight to the player
   * @param nearest  distance (m) to the nearest active unit (Infinity if none)
   * @param speed    player speed (m/s)
   * @param boxed    units are on two or more sides of the player
   */
  update(dt: number, seen: boolean, nearest: number, speed: number, boxed: boolean): HeatEvent[] {
    this.time += dt;
    const ev: HeatEvent[] = [];
    if (this.state === "busted" || this.state === "escaped") {
      this.endTimer -= dt;
      if (this.endTimer <= 0) {
        this.reset();
        ev.push({ type: "calm", heat: 0 });
      }
      return ev;
    }
    if (!this.active) return ev;
    this.chaseTime += dt;
    // Busted meter: a unit right on you while you are (nearly) stopped -
    // boxed in by two or more units, crawling counts too.
    const slow = speed < this.cfg.bustSpeed || (boxed && speed < this.cfg.bustSpeed * 2);
    const pinned = nearest < this.cfg.bustRange && slow;
    if (pinned && this.state === "pursuit") this.bust = Math.min(1, this.bust + dt / this.cfg.bustTime);
    else this.bust = Math.max(0, this.bust - dt / (this.cfg.bustTime * 0.6));
    if (this.bust >= 1) {
      this.state = "busted";
      this.busts++;
      this.lastBounty = this.bounty;
      this.endTimer = this.cfg.endTime;
      ev.push({ type: "busted", heat: this.heat, bounty: this.bounty });
      return ev;
    }
    if (this.state === "pursuit") {
      this.unseen = seen ? 0 : this.unseen + dt;
      // Staying ahead of the police pays.
      if (Math.floor(this.chaseTime / 20) > Math.floor((this.chaseTime - dt) / 20)) this.bounty += EVADE_BOUNTY * this.heat;
      ev.push(...this.updateHeatLevel());
      if (this.unseen >= this.cfg.loseSight) {
        this.state = "cooldown";
        this.cooldown = 0;
        ev.push({ type: "cooldown", heat: this.heat });
      }
    } else {
      // Cooldown.
      if (seen) {
        this.state = "pursuit";
        this.unseen = 0;
        this.cooldown = 0;
        ev.push({ type: "spotted", heat: this.heat });
      } else {
        // Hiding far from the units cools you down faster.
        const far = Number.isFinite(nearest) ? Math.min(1.6, 0.7 + nearest / 400) : 1.6;
        this.cooldown = Math.min(1, this.cooldown + (dt / this.cooldownLength()) * far);
        if (this.cooldown >= 1) {
          this.state = "escaped";
          this.escapes++;
          this.totalBounty += this.bounty;
          this.lastBounty = this.bounty;
          this.endTimer = this.cfg.endTime;
          ev.push({ type: "escaped", heat: this.heat, bounty: this.bounty });
        }
      }
    }
    return ev;
  }

  /** Back to calm (no chase). Banked bounty and the escape / bust counts are kept. */
  reset(): void {
    this.state = "calm";
    this.heat = 0;
    this.bounty = 0;
    this.chaseTime = 0;
    this.unseen = 0;
    this.cooldown = 0;
    this.bust = 0;
    this.endTimer = 0;
    this.lastOffence.clear();
  }

  /** Test / debug helper: jump straight into a chase at a heat level. */
  force(heat: number): void {
    if (!this.active) {
      this.reset();
      this.state = "pursuit";
    }
    this.heat = Math.max(1, Math.min(MAX_HEAT, Math.round(heat)));
    this.bounty = Math.max(this.bounty, HEAT_THRESHOLDS[this.heat]);
  }
}

/** Police units allowed in the chase at a heat level (roadblock cars not counted). */
export function unitsForHeat(heat: number): number {
  return [0, 2, 3, 4, 5, 6][Math.max(0, Math.min(MAX_HEAT, Math.round(heat)))];
}

/** Share of chasing units that are fast Enforcers (the rest are Interceptors). */
export function enforcerShare(heat: number): number {
  return [0, 0, 0, 0.34, 0.5, 0.67][Math.max(0, Math.min(MAX_HEAT, Math.round(heat)))];
}

/** Roadblocks are set up from heat 3. */
export function roadblocksAt(heat: number): boolean {
  return heat >= 3;
}
