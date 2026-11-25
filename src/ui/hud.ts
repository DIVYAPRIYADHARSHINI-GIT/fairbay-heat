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

export class Hud {
  readonly root: HTMLDivElement;
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
    g.restore();
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
