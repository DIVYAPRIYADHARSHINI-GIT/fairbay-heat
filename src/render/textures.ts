/**
 * Every texture in the game is drawn at load time on a <canvas> - no image
 * files, no asset licences. Each generator is seeded so the city looks the
 * same on every visit.
 */

import * as THREE from "three";
import { mulberry32, pick, range } from "../core/math";

function canvas(w: number, h = w): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  return [c, ctx];
}

function tex(c: HTMLCanvasElement, srgb = true, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return releaseCanvas(t);
}

/**
 * Once WebGL has a texture, its source canvas (4 bytes a pixel of CPU-side
 * memory, plus the browser's own backing store) is no longer needed: shrink
 * it to 1x1 right after the upload. Textures are drawn once at load and
 * never redrawn, so nothing needs the pixels again.
 */
export function releaseCanvas<X extends THREE.Texture>(t: X): X {
  const prev = t.onUpdate;
  t.onUpdate = (tx: THREE.Texture) => {
    prev?.(tx);
    const img = tx.image as HTMLCanvasElement | undefined;
    if (img && "getContext" in img && img.width > 1) {
      // Keep the real size known to Three.js (mip levels, sampler setup).
      tx.userData.size = [img.width, img.height];
      img.width = 1;
      img.height = 1;
    }
  };
  return t;
}

/** One shared instance per generator (concrete, sidewalk, grass... were drawn up to 7 times). */
const shared = new Map<string, THREE.CanvasTexture>();
function once(key: string, make: () => THREE.CanvasTexture): THREE.CanvasTexture {
  let t = shared.get(key);
  if (!t) shared.set(key, (t = make()));
  return t;
}

function noise(ctx: CanvasRenderingContext2D, w: number, h: number, rng: () => number, base: number, amp: number, tint: [number, number, number] = [1, 1, 1]): void {
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = base + (rng() - 0.5) * amp;
    img.data[i * 4] = v * tint[0];
    img.data[i * 4 + 1] = v * tint[1];
    img.data[i * 4 + 2] = v * tint[2];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

export function asphalt(): THREE.CanvasTexture {
  const rng = mulberry32(11);
  const [c, ctx] = canvas(512);
  noise(ctx, 512, 512, rng, 92, 34);
  // Aggregate speckles.
  for (let i = 0; i < 2600; i++) {
    const v = rng() < 0.5 ? range(rng, 40, 70) : range(rng, 120, 160);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(rng() * 512, rng() * 512, 1 + rng() * 2, 1 + rng() * 2);
  }
  // Patches and tar seams.
  ctx.globalAlpha = 0.1;
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = rng() < 0.5 ? "#000" : "#888";
    ctx.beginPath();
    ctx.ellipse(rng() * 512, rng() * 512, range(rng, 20, 90), range(rng, 10, 50), rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = 1.3;
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    let x = rng() * 512;
    let y = rng() * 512;
    ctx.moveTo(x, y);
    for (let k = 0; k < 8; k++) {
      x += range(rng, -24, 24);
      y += range(rng, -24, 24);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return tex(c);
}

export function sidewalk(): THREE.CanvasTexture {
  return once("sidewalk", draw_sidewalk);
}

function draw_sidewalk(): THREE.CanvasTexture {
  const rng = mulberry32(12);
  const [c, ctx] = canvas(256);
  noise(ctx, 256, 256, rng, 168, 22);
  ctx.strokeStyle = "rgba(60,60,60,0.55)";
  ctx.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath();
    ctx.moveTo(i * 64, 0);
    ctx.lineTo(i * 64, 256);
    ctx.moveTo(0, i * 64);
    ctx.lineTo(256, i * 64);
    ctx.stroke();
  }
  for (let i = 0; i < 16; i++) {
    ctx.fillStyle = `rgba(0,0,0,${range(rng, 0.02, 0.07)})`;
    ctx.fillRect(Math.floor(rng() * 4) * 64, Math.floor(rng() * 4) * 64, 64, 64);
  }
  return tex(c);
}

export function grass(): THREE.CanvasTexture {
  return once("grass", draw_grass);
}

function draw_grass(): THREE.CanvasTexture {
  const rng = mulberry32(13);
  const [c, ctx] = canvas(256);
  noise(ctx, 256, 256, rng, 150, 70, [0.62, 0.86, 0.36]);
  for (let i = 0; i < 1400; i++) {
    ctx.fillStyle = `rgba(${range(rng, 40, 90)},${range(rng, 90, 150)},${range(rng, 30, 60)},0.6)`;
    ctx.fillRect(rng() * 256, rng() * 256, 1, 2 + rng() * 3);
  }
  return tex(c);
}

export function gravel(): THREE.CanvasTexture {
  return once("gravel", draw_gravel);
}

function draw_gravel(): THREE.CanvasTexture {
  const rng = mulberry32(14);
  const [c, ctx] = canvas(256);
  noise(ctx, 256, 256, rng, 140, 60, [1, 0.96, 0.9]);
  return tex(c);
}

export function concrete(): THREE.CanvasTexture {
  return once("concrete", draw_concrete);
}

function draw_concrete(): THREE.CanvasTexture {
  const rng = mulberry32(15);
  const [c, ctx] = canvas(256);
  noise(ctx, 256, 256, rng, 178, 18);
  ctx.strokeStyle = "rgba(80,80,80,0.5)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(0, 0, 256, 256);
  return tex(c);
}

export interface Facade {
  map: THREE.CanvasTexture;
  emissive: THREE.CanvasTexture;
  rough: THREE.CanvasTexture;
  /** Metres per texture tile horizontally / vertically. */
  tileW: number;
  tileH: number;
}

/**
 * A facade atlas of 8 x 8 window bays. The albedo is near-white on walls so
 * the per-building vertex tint shows through; the emissive map holds a random
 * set of lit windows for night; the roughness map makes glass glossy.
 */
export function facade(style: "glass" | "office" | "brick" | "house" | "warehouse"): Facade {
  const rng = mulberry32(100 + style.length * 7 + style.charCodeAt(0));
  const N = 8;
  const S = 512;
  const cell = S / N;
  const [c, ctx] = canvas(S);
  const [e, ectx] = canvas(S);
  const [r, rctx] = canvas(S);
  ectx.fillStyle = "#000";
  ectx.fillRect(0, 0, S, S);
  let tileW = 3.5 * N;
  let tileH = 3.5 * N;

  const lit = (x: number, y: number, w: number, h: number): void => {
    if (rng() < 0.38) {
      const warm = rng();
      ectx.fillStyle = warm < 0.6 ? "#ffd89a" : warm < 0.85 ? "#fff1d6" : "#bfe0ff";
      ectx.globalAlpha = range(rng, 0.55, 1);
      ectx.fillRect(x, y, w, h);
      ectx.globalAlpha = 1;
    }
  };

  if (style === "glass") {
    tileW = 4 * N;
    // Curtain wall: glass with thin mullions and spandrel bands.
    ctx.fillStyle = "#c9d6e2";
    ctx.fillRect(0, 0, S, S);
    rctx.fillStyle = "#e0e0e0";
    rctx.fillRect(0, 0, S, S);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = i * cell;
        const y = j * cell;
        const g = range(rng, 40, 70);
        ctx.fillStyle = `rgb(${g},${g + 18},${g + 34})`;
        ctx.fillRect(x + 2, y + 10, cell - 4, cell - 12);
        rctx.fillStyle = "#151515";
        rctx.fillRect(x + 2, y + 10, cell - 4, cell - 12);
        lit(x + 2, y + 10, cell - 4, cell - 12);
      }
    }
  } else if (style === "office") {
    // Punched windows in a concrete grid.
    ctx.fillStyle = "#e8e5df";
    ctx.fillRect(0, 0, S, S);
    rctx.fillStyle = "#d8d8d8";
    rctx.fillRect(0, 0, S, S);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = i * cell;
        const y = j * cell;
        ctx.fillStyle = "#3c4752";
        ctx.fillRect(x + 8, y + 14, cell - 16, cell - 22);
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        ctx.fillRect(x + 8, y + 14, (cell - 16) / 2, cell - 22);
        ctx.fillStyle = "#c9c4bb";
        ctx.fillRect(x + 4, y + cell - 8, cell - 8, 4);
        rctx.fillStyle = "#262626";
        rctx.fillRect(x + 8, y + 14, cell - 16, cell - 22);
        lit(x + 8, y + 14, cell - 16, cell - 22);
      }
    }
  } else if (style === "brick") {
    ctx.fillStyle = "#e9d6cc";
    ctx.fillRect(0, 0, S, S);
    // Brick courses.
    ctx.strokeStyle = "rgba(90,60,50,0.35)";
    ctx.lineWidth = 1;
    for (let y = 0; y < S; y += 6) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(S, y);
      ctx.stroke();
      for (let x = (y / 6) % 2 ? 0 : 7; x < S; x += 14) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + 6);
        ctx.stroke();
      }
    }
    rctx.fillStyle = "#e8e8e8";
    rctx.fillRect(0, 0, S, S);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = i * cell;
        const y = j * cell;
        ctx.fillStyle = "#f3efe8";
        ctx.fillRect(x + 14, y + 10, cell - 28, cell - 16);
        ctx.fillStyle = "#2f3438";
        ctx.fillRect(x + 17, y + 13, cell - 34, cell - 22);
        ctx.fillStyle = "#f3efe8";
        ctx.fillRect(x + 17, y + 13 + (cell - 22) / 2 - 1, cell - 34, 2);
        rctx.fillStyle = "#303030";
        rctx.fillRect(x + 17, y + 13, cell - 34, cell - 22);
        lit(x + 17, y + 13, cell - 34, cell - 22);
      }
    }
    tileH = 3.2 * N;
  } else if (style === "house") {
    ctx.fillStyle = "#f4f1ea";
    ctx.fillRect(0, 0, S, S);
    // Horizontal siding.
    ctx.strokeStyle = "rgba(0,0,0,0.08)";
    for (let y = 0; y < S; y += 5) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(S, y);
      ctx.stroke();
    }
    rctx.fillStyle = "#eeeeee";
    rctx.fillRect(0, 0, S, S);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        if ((i + j * 3) % 3 === 2) continue;
        const x = i * cell;
        const y = j * cell;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x + 16, y + 16, cell - 32, cell - 26);
        ctx.fillStyle = "#33414c";
        ctx.fillRect(x + 19, y + 19, cell - 38, cell - 32);
        rctx.fillStyle = "#333";
        rctx.fillRect(x + 19, y + 19, cell - 38, cell - 32);
        lit(x + 19, y + 19, cell - 38, cell - 32);
      }
    }
    tileW = 3.2 * N;
    tileH = 3.0 * N;
  } else {
    // Warehouse: vertical corrugated cladding, a band of high windows.
    ctx.fillStyle = "#e6e6e6";
    ctx.fillRect(0, 0, S, S);
    for (let x = 0; x < S; x += 4) {
      ctx.fillStyle = x % 8 === 0 ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.2)";
      ctx.fillRect(x, 0, 2, S);
    }
    rctx.fillStyle = "#b0b0b0";
    rctx.fillRect(0, 0, S, S);
    for (let j = 0; j < N; j += 4) {
      for (let i = 0; i < N; i++) {
        const x = i * cell;
        const y = j * cell;
        ctx.fillStyle = "#4a5560";
        ctx.fillRect(x + 4, y + 20, cell - 8, 18);
        rctx.fillStyle = "#202020";
        rctx.fillRect(x + 4, y + 20, cell - 8, 18);
        if (rng() < 0.4) {
          ectx.fillStyle = "#ffe6b0";
          ectx.fillRect(x + 4, y + 20, cell - 8, 18);
        }
      }
    }
    tileW = 5 * N;
    tileH = 4 * N;
  }
  const rough = tex(r, false);
  return { map: tex(c), emissive: tex(e), rough, tileW, tileH };
}

export function roofTex(): THREE.CanvasTexture {
  const rng = mulberry32(16);
  const [c, ctx] = canvas(256);
  noise(ctx, 256, 256, rng, 120, 40);
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  for (let i = 0; i < 6; i++) {
    ctx.strokeRect(rng() * 200, rng() * 200, 30 + rng() * 40, 20 + rng() * 40);
  }
  return tex(c);
}

export function shingles(): THREE.CanvasTexture {
  const rng = mulberry32(17);
  const [c, ctx] = canvas(256);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 16) {
    for (let x = (y / 16) % 2 ? -8 : 0; x < 256; x += 16) {
      const v = range(rng, 150, 230);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(x + 1, y + 1, 14, 14);
    }
  }
  return tex(c);
}

export function corrugated(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 128, 128);
  for (let x = 0; x < 128; x += 8) {
    const g = ctx.createLinearGradient(x, 0, x + 8, 0);
    g.addColorStop(0, "#9a9a9a");
    g.addColorStop(0.5, "#ffffff");
    g.addColorStop(1, "#9a9a9a");
    ctx.fillStyle = g;
    ctx.fillRect(x, 4, 8, 120);
  }
  ctx.fillStyle = "#777";
  ctx.fillRect(0, 0, 128, 4);
  ctx.fillRect(0, 124, 128, 4);
  return tex(c);
}

export function hazardStripes(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128);
  ctx.fillStyle = "#f2b705";
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = "#151515";
  for (let i = -128; i < 256; i += 32) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 16, 0);
    ctx.lineTo(i + 16 + 128, 128);
    ctx.lineTo(i + 128, 128);
    ctx.fill();
  }
  return tex(c);
}

/** Soft radial gradient: blob shadows, lamp light pools, glows. */
export function radial(inner = "rgba(255,255,255,1)", outer = "rgba(255,255,255,0)", size = 128): THREE.CanvasTexture {
  const [c, ctx] = canvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return tex(c, true, false);
}

export function smokePuff(): THREE.CanvasTexture {
  const rng = mulberry32(18);
  const [c, ctx] = canvas(128);
  for (let i = 0; i < 18; i++) {
    const x = 64 + range(rng, -22, 22);
    const y = 64 + range(rng, -22, 22);
    const r = range(rng, 18, 36);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  }
  return tex(c, true, false);
}

/** Tileable normal map for the sea, derived from summed sine waves. */
export function waterNormals(): THREE.CanvasTexture {
  const S = 256;
  const rng = mulberry32(19);
  const waves = Array.from({ length: 9 }, () => ({
    kx: Math.round(range(rng, -6, 6)),
    ky: Math.round(range(rng, 1, 7)),
    a: range(rng, 0.3, 1),
    p: rng() * Math.PI * 2,
  }));
  const [c, ctx] = canvas(S);
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let dx = 0;
      let dy = 0;
      for (const w of waves) {
        const ph = ((w.kx * x + w.ky * y) / S) * Math.PI * 2 + w.p;
        const d = Math.cos(ph) * w.a;
        dx += d * w.kx * 0.06;
        dy += d * w.ky * 0.06;
      }
      const len = Math.hypot(dx, dy, 1);
      const i = (y * S + x) * 4;
      img.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return tex(c, false);
}

/** Bright neon billboard artwork (fictional brands). */
export function billboard(color: string, seed: number): THREE.CanvasTexture {
  const rng = mulberry32(seed);
  const [c, ctx] = canvas(512, 180);
  ctx.fillStyle = "#0d0d14";
  ctx.fillRect(0, 0, 512, 180);
  const g = ctx.createLinearGradient(0, 0, 512, 180);
  g.addColorStop(0, color);
  g.addColorStop(1, "#ffffff");
  ctx.strokeStyle = g;
  ctx.lineWidth = 10;
  ctx.strokeRect(10, 10, 492, 160);
  ctx.fillStyle = color;
  ctx.font = "bold 76px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const word = pick(rng, ["NITRO", "FAIRBAY", "APEX", "TORQUE", "VELO", "DRIFT", "HEAT", "REDLINE", "OCTANE", "TURBO"]);
  ctx.fillText(word, 256, 84);
  ctx.font = "600 24px system-ui, sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(pick(rng, ["ENERGY DRINK", "MOTOR OIL", "TYRES", "RADIO 98.4", "GARAGE & TUNING", "FUEL"]), 256, 140);
  const t = tex(c, true, false);
  return t;
}


/** Shop windows: 4 different shopfronts side by side (glazing with displays, a door); lit at night. */
export function shopfront(): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const rng = mulberry32(77);
  const W = 512;
  const H = 128;
  const [c, ctx] = canvas(W, H);
  const [e, ectx] = canvas(W, H);
  ectx.fillStyle = "#000";
  ectx.fillRect(0, 0, W, H);
  for (let i = 0; i < 4; i++) {
    const x0 = i * 128;
    // Frame.
    ctx.fillStyle = "#2b2f33";
    ctx.fillRect(x0, 0, 128, H);
    // Glass with an interior and goods on shelves.
    const glass = ctx.createLinearGradient(0, 0, 0, H);
    glass.addColorStop(0, "#5d6b78");
    glass.addColorStop(1, "#2e3842");
    ctx.fillStyle = glass;
    ctx.fillRect(x0 + 6, 6, 80, H - 12);
    for (let k = 0; k < 14; k++) {
      ctx.fillStyle = `hsl(${Math.floor(rng() * 360)},${40 + rng() * 30}%,${45 + rng() * 25}%)`;
      ctx.fillRect(x0 + 10 + rng() * 66, 30 + Math.floor(rng() * 4) * 22, 6 + rng() * 10, 10 + rng() * 8);
    }
    // Reflection streak.
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.beginPath();
    ctx.moveTo(x0 + 20, 6);
    ctx.lineTo(x0 + 40, 6);
    ctx.lineTo(x0 + 14, H - 6);
    ctx.lineTo(x0 + 6, H - 6);
    ctx.fill();
    // Door.
    ctx.fillStyle = "#3b4651";
    ctx.fillRect(x0 + 92, 14, 30, H - 14);
    ctx.fillStyle = "#c9ced3";
    ctx.fillRect(x0 + 115, 66, 3, 14);
    // Night: warm interior light.
    const warm = ["#ffe2a8", "#fff4dc", "#d8ecff", "#ffd0a0"][i];
    ectx.fillStyle = warm;
    ectx.globalAlpha = 0.85;
    ectx.fillRect(x0 + 6, 6, 80, H - 12);
    ectx.globalAlpha = 0.5;
    ectx.fillRect(x0 + 92, 14, 30, H - 14);
    ectx.globalAlpha = 1;
  }
  return { map: tex(c, true, false), emissive: tex(e, true, false) };
}

/** Classic striped awning canvas (tinted per shop by vertex colour). */
export function awningStripes(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 64);
  for (let x = 0; x < 128; x += 16) {
    ctx.fillStyle = (x / 16) % 2 ? "#ffffff" : "#d8d8d8";
    ctx.fillRect(x, 0, 16, 64);
  }
  // Scalloped valance edge.
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  for (let x = 0; x < 128; x += 16) {
    ctx.beginPath();
    ctx.arc(x + 8, 60, 8, 0, Math.PI);
    ctx.fill();
  }
  return tex(c);
}

/** Rooftop AC unit: louvred sides with a fan grille on top. */
export function hvacTex(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128);
  ctx.fillStyle = "#cfd2d4";
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  for (let y = 10; y < 118; y += 8) ctx.fillRect(8, y, 112, 3);
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(64, 64, 34, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    ctx.moveTo(64, 64);
    ctx.lineTo(64 + Math.cos(a) * 32, 64 + Math.sin(a) * 32);
  }
  ctx.stroke();
  return tex(c);
}


/** Bark: vertical fissures in grey-brown (trees, wood posts). */
export function bark(): THREE.CanvasTexture {
  const rng = mulberry32(31);
  const [c, ctx] = canvas(64, 128);
  ctx.fillStyle = "#5b4433";
  ctx.fillRect(0, 0, 64, 128);
  for (let i = 0; i < 40; i++) {
    const x = rng() * 64;
    ctx.strokeStyle = rng() < 0.5 ? "rgba(30,20,14,0.55)" : "rgba(140,115,95,0.35)";
    ctx.lineWidth = 1 + rng() * 2.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    let y = 0;
    let xx = x;
    while (y < 128) {
      y += 6 + rng() * 10;
      xx += (rng() - 0.5) * 4;
      ctx.lineTo(xx, y);
    }
    ctx.stroke();
  }
  return tex(c);
}
