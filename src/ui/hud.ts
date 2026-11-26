/**
 * In-game HUD: speedometer/tachometer + nitro gauge (canvas), rotating
 * minimap and full-screen map (both drawn from one pre-rendered city image),
 * toasts, district banner, drift counter and the "press E" prompt.
 */

import { WORLD_HALF as WORLD, coastN, freshWaterDistance, type World } from "../game/world";
import type { JackSpot } from "../game/jack";
import { carById } from "../game/cars";
import { clamp } from "../core/math";

const MAP_SCALE = 0.8; // px per metre in the pre-rendered map

const DISTRICT_TINT: Record<string, string> = {
  downtown: "#2f3744",
  midtown: "#2d3440",
  oldtown: "#3a3230",
  southside: "#30343a",
  park: "#2c4a2a",
  hillcrest: "#2c3b2e",
  westside: "#2d3a30",
  ironworks: "#3a3631",
  port: "#33363b",
  beach: "#4c4632",
  highlands: "#2b3a27",
};

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** What the HUD shows about the police. */
export interface PursuitHud {
  state: "calm" | "pursuit" | "cooldown" | "busted" | "escaped";
  heat: number;
  bounty: number;
  /** 0..1 how close you are to slipping out of sight (pursuit). */
  evade: number;
  cooldown: number;
  bust: number;
  units: number;
  /** Police positions for the minimap (units, roadblock cars and patrols). */
  blips: { x: number; z: number; kind: "unit" | "block" | "patrol" }[];
  /** Red / blue phase of the light bars (minimap blips flash with them). */
  red: boolean;
}

/** What the HUD shows during a race. */
export interface RaceHud {
  name: string;
  position: number;
  racers: number;
  lap: number;
  laps: number;
  time: number;
  best: number;
  /** Next checkpoint (for the arrow and the minimap). */
  gx: number;
  gz: number;
  gate: number;
  gates: number;
  wrongWay: boolean;
  /** Rival positions for the minimap. */
  rivals: { x: number; z: number }[];
  route: { x: number; z: number }[];
}

/** A point of interest on the minimap / full map. */
export interface MapMarker {
  x: number;
  z: number;
  kind: "race" | "camera" | "trap";
  label: string;
}

export function fmtTime(t: number): string {
  if (!Number.isFinite(t) || t <= 0) return "--:--.--";
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(2)}`;
}

export class Hud {
  readonly root: HTMLDivElement;
  private heatEl: HTMLDivElement;
  private heatStars: HTMLSpanElement[] = [];
  private heatLabel: HTMLDivElement;
  private heatBounty: HTMLDivElement;
  private heatBar: HTMLDivElement;
  private heatBarFill: HTMLElement;
  private bustEl: HTMLDivElement;
  private bustFill: HTMLElement;
  private result: HTMLDivElement;
  private pursuit: PursuitHud | null = null;
  private raceEl: HTMLDivElement;
  private raceBig: HTMLDivElement;
  private countdownEl: HTMLDivElement;
  private arrow: HTMLDivElement;
  private popups: HTMLDivElement;
  private board: HTMLDivElement;
  private trapEl: HTMLDivElement;
  private race: RaceHud | null = null;
  private markers: MapMarker[] = [];
  private speedo: HTMLCanvasElement;
  private sctx: CanvasRenderingContext2D;
  private mini: HTMLCanvasElement;
  private mctx: CanvasRenderingContext2D;
  private mapImg: HTMLCanvasElement;
  private toasts: HTMLDivElement;
  private banner: HTMLDivElement;
  private drift: HTMLDivElement;
  private prompt: HTMLDivElement;
  private carName: HTMLDivElement;
  private fps: HTMLDivElement;
  private flash: HTMLDivElement;
  private bannerTimer = 0;
  private dpr = Math.min(2, window.devicePixelRatio || 1);

  constructor(
    parent: HTMLElement,
    private city: World,
  ) {
    this.root = el("div", "hud");
    this.root.setAttribute("aria-hidden", "true");
    parent.appendChild(this.root);

    this.speedo = el("canvas", "speedo");
    this.speedo.width = this.speedo.height = 240 * this.dpr;
    this.sctx = this.speedo.getContext("2d")!;
    this.root.appendChild(this.speedo);

    const miniWrap = el("div", "minimap");
    this.mini = el("canvas");
    this.mini.width = this.mini.height = 200 * this.dpr;
    this.mctx = this.mini.getContext("2d")!;
    miniWrap.appendChild(this.mini);
    this.root.appendChild(miniWrap);

    this.carName = el("div", "carname");
    this.root.appendChild(this.carName);
    this.toasts = el("div", "toasts");
    this.root.appendChild(this.toasts);
    this.banner = el("div", "banner");
    this.root.appendChild(this.banner);
    this.drift = el("div", "drift");
    this.root.appendChild(this.drift);
    this.prompt = el("div", "prompt");
    this.root.appendChild(this.prompt);
    this.fps = el("div", "fps");
    this.root.appendChild(this.fps);
    this.flash = el("div", "flash");
    parent.appendChild(this.flash);

    // Pursuit: heat stars + bounty, evade / cooldown bar, busted meter, result.
    this.heatEl = el("div", "heat");
    this.heatEl.dataset.state = "calm";
    const stars = el("div", "heat-stars");
    for (let i = 0; i < 5; i++) {
      const st = el("span", "star", "★");
      this.heatStars.push(st);
      stars.appendChild(st);
    }
    this.heatLabel = el("div", "heat-label");
    this.heatBounty = el("div", "heat-bounty");
    this.heatBar = el("div", "heat-bar");
    this.heatBarFill = el("i");
    this.heatBar.appendChild(this.heatBarFill);
    this.heatEl.append(stars, this.heatLabel, this.heatBar, this.heatBounty);
    this.root.appendChild(this.heatEl);
    this.bustEl = el("div", "bust");
    this.bustEl.appendChild(el("span", "bust-label", "BUSTED"));
    const bb = el("div", "bust-bar");
    this.bustFill = el("i");
    bb.appendChild(this.bustFill);
    this.bustEl.appendChild(bb);
    this.root.appendChild(this.bustEl);
    this.result = el("div", "result");
    this.root.appendChild(this.result);

    // Race: position / lap / time panel, big messages, countdown, checkpoint
    // arrow, results board; popups (near miss, speed camera); trap timer.
    this.raceEl = el("div", "race");
    this.root.appendChild(this.raceEl);
    this.raceBig = el("div", "race-big");
    this.root.appendChild(this.raceBig);
    this.countdownEl = el("div", "countdown");
    this.root.appendChild(this.countdownEl);
    this.arrow = el("div", "cp-arrow");
    this.arrow.innerHTML = '<svg viewBox="0 0 40 40"><path d="M20 3 L35 34 L20 26 L5 34 Z"/></svg><span></span>';
    this.root.appendChild(this.arrow);
    this.popups = el("div", "popups");
    this.root.appendChild(this.popups);
    this.board = el("div", "board");
    this.root.appendChild(this.board);
    this.trapEl = el("div", "trap");
    this.root.appendChild(this.trapEl);

    this.mapImg = this.renderMap();
  }

  set visible(v: boolean) {
    this.root.classList.toggle("hidden", !v);
  }

  // ---- map image ----------------------------------------------------------

  /** Map pixel coordinates: north (+Z) up, east (-X) right. */
  static toMap(x: number, z: number, scale = MAP_SCALE): [number, number] {
    return [(WORLD - x) * scale, (WORLD - z) * scale];
  }

  private renderMap(): HTMLCanvasElement {
    const S = Math.round(WORLD * 2 * MAP_SCALE);
    const c = el("canvas");
    c.width = c.height = S;
    const g = c.getContext("2d")!;
    // Land / water / districts, sampled on a coarse grid.
    const step = 8;
    for (let py = 0; py < S; py += step) {
      for (let px = 0; px < S; px += step) {
        const x = WORLD - (px + step / 2) / MAP_SCALE;
        const z = WORLD - (py + step / 2) / MAP_SCALE;
        const e = -x;
        let col: string;
        if (z < coastN(e) || freshWaterDistance(e, z) < 0) col = "#163a52";
        else {
          const d = this.city.districtOf(x, z);
          col = DISTRICT_TINT[d] ?? "#2a3826";
          const h = this.city.terrainAt(x, z);
          if (h > 60) col = h > 115 ? "#59605c" : "#34432f";
        }
        g.fillStyle = col;
        g.fillRect(px, py, step, step);
      }
    }
    // Buildings.
    g.fillStyle = "rgba(255,255,255,0.09)";
    for (const b of this.city.buildings) {
      const pts = [
        [b.box.hx, b.box.hz],
        [-b.box.hx, b.box.hz],
        [-b.box.hx, -b.box.hz],
        [b.box.hx, -b.box.hz],
      ].map(([u, v]) => Hud.toMap(b.box.cx + u * b.box.c - v * b.box.s, b.box.cz + u * b.box.s + v * b.box.c));
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (const p of pts.slice(1)) g.lineTo(p[0], p[1]);
      g.closePath();
      g.fill();
    }
    // Roads: casing then fill, widest last so freeways sit on top.
    const roads = [...this.city.net.roads].sort((a, b) => a.hw - b.hw);
    const stroke = (lw: number, color: string, filter: (r: (typeof roads)[number]) => boolean) => {
      g.strokeStyle = color;
      g.lineCap = "round";
      g.lineJoin = "round";
      for (const r of roads) {
        if (!filter(r)) continue;
        g.lineWidth = Math.max(2, r.hw * 2 * MAP_SCALE) + lw;
        g.beginPath();
        const cl = r.center;
        for (let i = 0; i < cl.n; i++) {
          const [x, y] = Hud.toMap(cl.x[i], cl.z[i]);
          if (i === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();
      }
    };
    stroke(3, "rgba(0,0,0,0.55)", () => true);
    stroke(0, "#8a919c", (r) => r.cls !== "freeway" && r.cls !== "ramp" && r.cls !== "service" && r.cls !== "mountain" && r.cls !== "coast");
    stroke(0, "#b39a63", (r) => r.cls === "mountain" || r.cls === "coast");
    stroke(0, "#d9a441", (r) => r.cls === "freeway" || r.cls === "ramp");
    stroke(0, "#a4abb5", (r) => r.cls === "service");
    // Junction discs.
    for (const n of this.city.net.nodes.values()) {
      if (n.kind === "roundabout") continue;
      const [x, y] = Hud.toMap(n.x, n.z);
      g.fillStyle = n.ends.some((e) => e.road.cls === "freeway") ? "#d9a441" : "#8a919c";
      g.beginPath();
      g.arc(x, y, Math.max(2, n.radius * MAP_SCALE * 0.7), 0, Math.PI * 2);
      g.fill();
    }
    // Roundabout island.
    {
      const [x, y] = Hud.toMap(this.city.circle.x, this.city.circle.z);
      g.fillStyle = "#3d6b3a";
      g.beginPath();
      g.arc(x, y, this.city.islandR * MAP_SCALE, 0, Math.PI * 2);
      g.fill();
    }
    // Ramps.
    g.fillStyle = "#ffb000";
    for (const r of this.city.ramps) {
      const [x, y] = Hud.toMap(r.x, r.z);
      g.beginPath();
      g.arc(x, y, 4, 0, Math.PI * 2);
      g.fill();
    }
    // Labels.
    g.font = "600 15px system-ui, sans-serif";
    g.textAlign = "center";
    g.fillStyle = "rgba(255,255,255,0.55)";
    // Labels at (x, z) world positions (x = -east).
    const labels: [string, number, number][] = [
      ["DOWNTOWN", -130, -700],
      ["MIDTOWN", -100, -330],
      ["OLD TOWN", -150, 300],
      ["CENTRAL PARK", -250, 280],
      ["HILLCREST", 450, 450],
      ["AIRFIELD", -760, 920],
      ["IRONWORKS", -860, -280],
      ["PORT FAIRBAY", -780, -720],
      ["SUNSET BEACH", 420, -870],
      ["SOUTHSIDE", 420, -600],
      ["WESTSIDE", 1030, -250],
      ["MOUNT CALDER", 860, 1100],
      ["I-9", 200, -60],
      ["RT 7", -860, -480],
    ];
    for (const [t, x, z] of labels) {
      const [px, py] = Hud.toMap(x, z);
      g.fillText(t, px, py);
    }
    return c;
  }

  // ---- per-frame updates --------------------------------------------------

  update(s: {
    speedKmh: number;
    rpm: number;
    redline: number;
    gear: number;
    nitro: number;
    nitroActive: boolean;
    x: number;
    z: number;
    heading: number;
    spots: readonly JackSpot[];
    discovered: readonly string[];
    hiddenSpot: string | null;
    fps: number | null;
  }): void {
    this.drawSpeedo(s);
    this.drawMinimap(s);
    this.fps.textContent = s.fps === null ? "" : `${Math.round(s.fps)} FPS`;
    this.fps.style.display = s.fps === null ? "none" : "block";
  }

  /** Race panel + checkpoint arrow (null hides them). `camHeading` turns the arrow. */
  setRace(r: RaceHud | null, px: number, pz: number, camHeading: number): void {
    this.race = r;
    this.raceEl.classList.toggle("show", !!r);
    this.arrow.classList.toggle("show", !!r);
    if (!r) return;
    const ord = (n: number) => `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`;
    this.raceEl.innerHTML = `<div class="rc-name">${r.name}</div><div class="rc-pos"><b>${ord(r.position)}</b><span>/ ${r.racers}</span></div><div class="rc-row"><span>LAP</span><b>${Math.min(r.lap, r.laps)} / ${r.laps}</b></div><div class="rc-row"><span>TIME</span><b>${fmtTime(Math.max(0, r.time))}</b></div><div class="rc-row dim"><span>BEST</span><b>${fmtTime(r.best)}</b></div><div class="rc-row dim"><span>CHECKPOINT</span><b>${Math.min(r.gate, r.gates)} / ${r.gates}</b></div>`;
    // Arrow pointing at the next checkpoint, relative to the camera.
    const ang = Math.atan2(r.gx - px, r.gz - pz) - camHeading;
    const d = Math.hypot(r.gx - px, r.gz - pz);
    (this.arrow.querySelector("svg") as SVGElement).style.transform = `rotate(${-ang}rad)`;
    (this.arrow.querySelector("span") as HTMLSpanElement).textContent = `${Math.round(d)} m`;
    this.arrow.classList.toggle("wrong", r.wrongWay);
  }

  /** Big centred race message ("WRONG WAY", "FINAL LAP"...), or null. */
  setRaceBig(text: string | null, kind: "warn" | "info" = "info"): void {
    this.raceBig.textContent = text ?? "";
    this.raceBig.dataset.kind = kind;
    this.raceBig.classList.toggle("show", !!text);
  }

  /** Countdown digit (3, 2, 1, GO) or null. */
  setCountdown(text: string | null): void {
    if (this.countdownEl.dataset.text === (text ?? "")) return;
    this.countdownEl.dataset.text = text ?? "";
    this.countdownEl.textContent = text ?? "";
    this.countdownEl.classList.remove("pop");
    if (text) {
      void this.countdownEl.offsetWidth;
      this.countdownEl.classList.add("pop");
    }
  }

  /** Floating score popup (near miss, speed camera). */
  popup(title: string, sub = "", kind: "nitro" | "gold" | "silver" | "bronze" | "none" = "nitro"): void {
    const p = el("div", `popup ${kind}`);
    p.appendChild(el("div", "p-title", title));
    if (sub) p.appendChild(el("div", "p-sub", sub));
    this.popups.appendChild(p);
    while (this.popups.children.length > 3) this.popups.firstElementChild?.remove();
    setTimeout(() => p.remove(), 1900);
  }

  /** Race results board (null hides it). */
  setBoard(title: string | null, rows: { pos: number; name: string; time: number; you: boolean }[] = [], foot = ""): void {
    if (!title) {
      this.board.classList.remove("show");
      return;
    }
    this.board.replaceChildren();
    this.board.appendChild(el("div", "b-title", title));
    const t = el("div", "b-rows");
    for (const r of rows) {
      const row = el("div", `b-row${r.you ? " you" : ""}`);
      row.append(el("span", "b-pos", String(r.pos)), el("span", "b-name", r.name), el("span", "b-time", r.time > 0 ? fmtTime(r.time) : "DNF"));
      t.appendChild(row);
    }
    this.board.appendChild(t);
    if (foot) this.board.appendChild(el("div", "b-foot", foot));
    this.board.classList.add("show");
  }

  /** Live speed-trap readout (average so far), or null. */
  setTrap(name: string | null, kmh = 0, target = 0): void {
    this.trapEl.classList.toggle("show", !!name);
    if (name) this.trapEl.innerHTML = `<div class="t-name">${name}</div><div class="t-val">${Math.round(kmh)} <small>km/h avg</small></div><div class="t-tgt">gold ${target} km/h</div>`;
  }

  /** Race starts, cameras and traps for the minimap / map. */
  setMarkers(m: MapMarker[]): void {
    this.markers = m;
  }

  /** Heat meter, evade / cooldown bar, busted meter and police blips. */
  setPursuit(p: PursuitHud): void {
    this.pursuit = p;
    const e = this.heatEl;
    e.dataset.state = p.state;
    e.classList.toggle("show", p.state !== "calm");
    this.heatStars.forEach((st, i) => st.classList.toggle("on", i < p.heat));
    const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
    if (p.state === "pursuit") {
      this.heatLabel.textContent = p.evade > 0.02 ? "LOSING THEM" : `PURSUIT · ${p.units} ${p.units === 1 ? "UNIT" : "UNITS"}`;
      this.heatBarFill.style.width = `${Math.round(p.evade * 100)}%`;
    } else if (p.state === "cooldown") {
      this.heatLabel.textContent = "COOLDOWN · STAY HIDDEN";
      this.heatBarFill.style.width = `${Math.round(p.cooldown * 100)}%`;
    } else {
      this.heatLabel.textContent = p.state === "busted" ? "BUSTED" : p.state === "escaped" ? "ESCAPED" : "";
      this.heatBarFill.style.width = p.state === "escaped" ? "100%" : "0%";
    }
    this.heatBounty.textContent = p.state === "calm" ? "" : `BOUNTY ${fmt(p.bounty)}`;
    this.bustEl.classList.toggle("show", p.state === "pursuit" && p.bust > 0.02);
    this.bustFill.style.width = `${Math.round(p.bust * 100)}%`;
  }

  /** Big BUSTED / ESCAPED result card (null hides it). */
  setResult(kind: "busted" | "escaped" | null, title = "", sub = ""): void {
    if (!kind) {
      this.result.classList.remove("show");
      return;
    }
    this.result.dataset.kind = kind;
    this.result.replaceChildren(el("div", "r-title", title), el("div", "r-sub", sub));
    this.result.classList.add("show");
  }

  private drawSpeedo(s: { speedKmh: number; rpm: number; redline: number; gear: number; nitro: number; nitroActive: boolean }): void {
    const g = this.sctx;
    const d = this.dpr;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, 240, 240);
    const cx = 120;
    const cy = 128;
    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;
    // Backplate.
    const bg = g.createRadialGradient(cx, cy, 20, cx, cy, 110);
    bg.addColorStop(0, "rgba(10,12,18,0.75)");
    bg.addColorStop(1, "rgba(10,12,18,0.15)");
    g.fillStyle = bg;
    g.beginPath();
    g.arc(cx, cy, 108, 0, Math.PI * 2);
    g.fill();
    // Tach track.
    g.lineCap = "butt";
    g.lineWidth = 10;
    g.strokeStyle = "rgba(255,255,255,0.12)";
    g.beginPath();
    g.arc(cx, cy, 92, a0, a1);
    g.stroke();
    const rf = clamp(s.rpm / (s.redline * 1.05), 0, 1);
    const redStart = s.redline * 0.88 / (s.redline * 1.05);
    g.strokeStyle = "rgba(255,60,60,0.45)";
    g.beginPath();
    g.arc(cx, cy, 92, a0 + (a1 - a0) * redStart, a1);
    g.stroke();
    const grad = g.createLinearGradient(20, 0, 220, 0);
    grad.addColorStop(0, "#ffd166");
    grad.addColorStop(0.7, "#ff8a00");
    grad.addColorStop(1, "#ff2e3a");
    g.strokeStyle = grad;
    g.beginPath();
    g.arc(cx, cy, 92, a0, a0 + (a1 - a0) * rf);
    g.stroke();
    // Ticks (x1000 rpm).
    g.fillStyle = "rgba(255,255,255,0.7)";
    g.font = "600 11px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    const maxK = Math.ceil((s.redline * 1.05) / 1000);
    for (let k = 0; k <= maxK; k++) {
      const a = a0 + (a1 - a0) * clamp((k * 1000) / (s.redline * 1.05), 0, 1);
      g.fillText(String(k), cx + Math.cos(a) * 74, cy + Math.sin(a) * 74);
    }
    // Nitro arc (inner).
    g.lineWidth = 6;
    g.strokeStyle = "rgba(80,170,255,0.18)";
    g.beginPath();
    g.arc(cx, cy, 60, Math.PI * 0.85, Math.PI * 2.15);
    g.stroke();
    g.strokeStyle = s.nitroActive ? "#9ff3ff" : "#3aa0ff";
    g.shadowColor = "#3aa0ff";
    g.shadowBlur = s.nitroActive ? 14 : 6;
    g.beginPath();
    g.arc(cx, cy, 60, Math.PI * 0.85, Math.PI * 0.85 + Math.PI * 1.3 * clamp(s.nitro, 0, 1));
    g.stroke();
    g.shadowBlur = 0;
    // Speed.
    g.fillStyle = "#ffffff";
    g.font = "italic 800 46px system-ui, sans-serif";
    g.fillText(String(Math.round(s.speedKmh)), cx, cy - 4);
    g.font = "600 11px system-ui, sans-serif";
    g.fillStyle = "rgba(255,255,255,0.65)";
    g.fillText("KM/H", cx, cy + 24);
    // Gear.
    g.font = "italic 800 22px system-ui, sans-serif";
    g.fillStyle = s.gear === 0 ? "#ff6b6b" : "#ffb000";
    g.fillText(s.gear === 0 ? "R" : String(s.gear), cx, cy + 62);
    g.font = "600 9px system-ui, sans-serif";
    g.fillStyle = "rgba(160,215,255,0.9)";
    g.fillText("NITRO", cx, cy + 82);
  }

  private drawMinimap(s: { x: number; z: number; heading: number; spots: readonly JackSpot[]; discovered: readonly string[]; hiddenSpot: string | null }): void {
    const g = this.mctx;
    const d = this.dpr;
    const R = 100;
    const zoom = 0.6; // screen px per metre
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, 200, 200);
    g.save();
    g.beginPath();
    g.arc(R, R, R - 2, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = "#1b2418";
    g.fillRect(0, 0, 200, 200);
    g.translate(R, R + 30); // player sits below centre to show more ahead
    g.rotate(s.heading);
    const k = zoom / MAP_SCALE;
    g.scale(k, k);
    const [px, py] = Hud.toMap(s.x, s.z);
    g.drawImage(this.mapImg, -px, -py);
    // Jack spots.
    for (const sp of s.spots) {
      if (sp.id === s.hiddenSpot) continue;
      const [x, y] = Hud.toMap(sp.x, sp.z);
      const known = s.discovered.includes(sp.carId);
      g.fillStyle = known ? "#7ee081" : "#ffb000";
      g.beginPath();
      g.arc(x - px, y - py, 7 / k, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "#111";
      g.lineWidth = 2 / k;
      g.stroke();
    }
    // Race: route line, next checkpoint, rivals.
    const rc = this.race;
    if (rc) {
      g.strokeStyle = "rgba(60,200,255,0.9)";
      g.lineWidth = 6 / k;
      g.lineJoin = "round";
      g.beginPath();
      rc.route.forEach((p, i) => {
        const [x, y] = Hud.toMap(p.x, p.z);
        if (i === 0) g.moveTo(x - px, y - py);
        else g.lineTo(x - px, y - py);
      });
      g.stroke();
      const [cx, cy] = Hud.toMap(rc.gx, rc.gz);
      g.fillStyle = "#3cd0ff";
      g.beginPath();
      g.arc(cx - px, cy - py, 9 / k, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "#fff";
      g.lineWidth = 2 / k;
      g.stroke();
      for (const r of rc.rivals) {
        const [x, y] = Hud.toMap(r.x, r.z);
        g.fillStyle = "#ffd166";
        g.beginPath();
        g.arc(x - px, y - py, 6 / k, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = "#111";
        g.stroke();
      }
    } else {
      for (const mk of this.markers) {
        const [x, y] = Hud.toMap(mk.x, mk.z);
        if (Math.abs(x - px) > 400 || Math.abs(y - py) > 400) continue;
        drawMarker(g, x - px, y - py, mk.kind, 1 / k);
      }
    }
    // Police blips: flashing red / blue (roadblocks steady red, patrols dim blue).
    const pur = this.pursuit;
    if (pur) {
      for (const b of pur.blips) {
        const [x, y] = Hud.toMap(b.x, b.z);
        const col = b.kind === "block" ? "#ff3b3b" : b.kind === "patrol" ? "#6f8fd8" : pur.red ? "#ff3b3b" : "#3b7bff";
        g.fillStyle = col;
        g.beginPath();
        g.arc(x - px, y - py, (b.kind === "patrol" ? 5 : 7) / k, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = "#fff";
        g.lineWidth = 1.5 / k;
        g.stroke();
      }
    }
    g.restore();
    // Pursuit: red rim pulse on the minimap edge.
    if (pur && pur.state === "pursuit") {
      g.strokeStyle = pur.red ? "rgba(255,50,50,0.85)" : "rgba(60,120,255,0.85)";
      g.lineWidth = 6;
      g.beginPath();
      g.arc(R, R, R - 4, 0, Math.PI * 2);
      g.stroke();
    }
    // Player arrow (always points up).
    g.save();
    g.translate(R, R + 30);
    g.fillStyle = "#ffffff";
    g.strokeStyle = "#0b0d12";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, -11);
    g.lineTo(8, 9);
    g.lineTo(0, 4);
    g.lineTo(-8, 9);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
    // Rim + north marker.
    g.strokeStyle = "rgba(255,255,255,0.35)";
    g.lineWidth = 3;
    g.beginPath();
    g.arc(R, R, R - 2, 0, Math.PI * 2);
    g.stroke();
    const na = -Math.PI / 2 + s.heading;
    const nx = R + Math.cos(na) * (R - 12);
    const ny = R + Math.sin(na) * (R - 12);
    g.fillStyle = "#ff4d4d";
    g.font = "800 12px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("N", nx, ny);
  }

  /** Draws the full city map into `canvas` (for the Tab map screen). */
  drawFullMap(canvas: HTMLCanvasElement, s: { x: number; z: number; heading: number; spots: readonly JackSpot[]; discovered: readonly string[]; hiddenSpot: string | null }): void {
    const dpr = this.dpr;
    const rect = canvas.getBoundingClientRect();
    const size = Math.max(10, Math.min(rect.width, rect.height));
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const g = canvas.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const k = size / this.mapImg.width;
    g.drawImage(this.mapImg, 0, 0, size, size);
    for (const sp of s.spots) {
      if (sp.id === s.hiddenSpot) continue;
      const [x, y] = Hud.toMap(sp.x, sp.z, MAP_SCALE * k);
      const known = s.discovered.includes(sp.carId);
      g.fillStyle = known ? "#7ee081" : "#ffb000";
      g.beginPath();
      g.arc(x, y, 6, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "#111";
      g.lineWidth = 2;
      g.stroke();
      g.font = "600 11px system-ui, sans-serif";
      g.fillStyle = "#fff";
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.fillText(known ? carById(sp.carId).name.split(" ").slice(0, 2).join(" ") : "???", x + 9, y);
    }
    for (const mk of this.markers) {
      const [mx, my] = Hud.toMap(mk.x, mk.z, MAP_SCALE * k);
      drawMarker(g, mx, my, mk.kind, 1);
      g.font = "600 11px system-ui, sans-serif";
      g.fillStyle = mk.kind === "race" ? "#ffd166" : "#ffffff";
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.fillText(mk.label, mx + 10, my);
    }
    const [x, y] = Hud.toMap(s.x, s.z, MAP_SCALE * k);
    g.save();
    g.translate(x, y);
    // World forward (sin h, cos h) is (-sin h, -cos h) on the map; an arrow
    // drawn pointing up (0, -1) rotated by -h points exactly there.
    g.rotate(-s.heading);
    g.fillStyle = "#fff";
    g.strokeStyle = "#000";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, -12);
    g.lineTo(8, 9);
    g.lineTo(0, 4);
    g.lineTo(-8, 9);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }

  // ---- messages ---------------------------------------------------------------

  toast(title: string, sub = "", kind: "info" | "gold" | "warn" = "info"): void {
    const t = el("div", `toast ${kind}`);
    t.appendChild(el("div", "t-title", title));
    if (sub) t.appendChild(el("div", "t-sub", sub));
    this.toasts.appendChild(t);
    while (this.toasts.children.length > 3) this.toasts.firstElementChild?.remove();
    setTimeout(() => t.classList.add("out"), 2600);
    setTimeout(() => t.remove(), 3200);
  }

  showBanner(text: string): void {
    this.banner.textContent = text;
    this.banner.classList.remove("show");
    void this.banner.offsetWidth; // restart the animation
    this.banner.classList.add("show");
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.banner.classList.remove("show"), 2600);
  }

  setDrift(points: number, active: boolean): void {
    if (points < 50) {
      this.drift.classList.remove("show");
      return;
    }
    this.drift.textContent = `DRIFT ${Math.round(points).toLocaleString("en-US")}`;
    this.drift.classList.add("show");
    this.drift.classList.toggle("banked", !active);
  }

  setPrompt(html: string | null): void {
    if (html === null) {
      this.prompt.classList.remove("show");
      return;
    }
    if (this.prompt.dataset.text !== html) {
      this.prompt.dataset.text = html;
      this.prompt.replaceChildren();
      const [key, ...rest] = html.split("|");
      this.prompt.appendChild(el("kbd", "", key));
      this.prompt.appendChild(el("span", "", rest.join("|")));
    }
    this.prompt.classList.add("show");
  }

  setCarName(name: string, klass: string): void {
    this.carName.replaceChildren(el("div", "cn-class", klass.toUpperCase()), el("div", "cn-name", name));
  }

  flashScreen(): void {
    this.flash.classList.remove("go");
    void this.flash.offsetWidth;
    this.flash.classList.add("go");
  }
}

/** Map icon: chequered flag (race), camera (speed camera), gauge (trap). */
function drawMarker(g: CanvasRenderingContext2D, x: number, y: number, kind: MapMarker["kind"], u: number): void {
  g.save();
  g.translate(x, y);
  g.scale(u, u);
  g.fillStyle = kind === "race" ? "#ffb000" : kind === "camera" ? "#e9eef5" : "#ff4d4d";
  g.strokeStyle = "#111";
  g.lineWidth = 2;
  g.beginPath();
  g.arc(0, 0, 8, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.fillStyle = "#111";
  if (kind === "race") {
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) if ((i + j) % 2 === 0) g.fillRect(-4 + i * 4, -4 + j * 4, 4, 4);
  } else if (kind === "camera") {
    g.fillRect(-4, -2.5, 8, 5);
    g.beginPath();
    g.arc(0, 0, 1.6, 0, Math.PI * 2);
    g.fillStyle = "#e9eef5";
    g.fill();
  } else {
    g.font = "900 9px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("S", 0, 0.5);
  }
  g.restore();
}
