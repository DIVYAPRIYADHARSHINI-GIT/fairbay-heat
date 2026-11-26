/**
 * Signature detailing for the player cars: each car gets the light shapes,
 * grille, wheel design, panel seams, aero parts and badges that make the car
 * it is styled after recognisable. Everything is procedural - canvas
 * textures and small meshes - no model files.
 */

import * as THREE from "three";
import { releaseCanvas } from "./textures";
import type { CarDetails, HeadlightStyle, RimStyle, TaillightStyle } from "../game/cars";

const texCache = new Map<string, THREE.CanvasTexture>();

function canvasTex(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true): THREE.CanvasTexture {
  const hit = texCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  draw(g);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  releaseCanvas(t);
  texCache.set(key, t);
  return t;
}

// ---------------------------------------------------------------------------
// Wheels
// ---------------------------------------------------------------------------

/** Alloy face texture for a rim design, in the rim colour. */
export function rimFace(style: RimStyle, color: string): THREE.CanvasTexture {
  return canvasTex(`rim-${style}-${color}`, 256, 256, (g) => {
    g.fillStyle = "#0d0e10";
    g.fillRect(0, 0, 256, 256);
    g.translate(128, 128);
    const base = new THREE.Color(color);
    const hi = base.clone().lerp(new THREE.Color(1, 1, 1), 0.45).getStyle();
    const lo = base.clone().multiplyScalar(0.55).getStyle();
    const grad = g.createRadialGradient(-20, -20, 10, 0, 0, 126);
    grad.addColorStop(0, hi);
    grad.addColorStop(0.8, base.getStyle());
    grad.addColorStop(1, lo);
    g.fillStyle = grad;
    g.strokeStyle = grad;
    // Lip.
    g.beginPath();
    g.arc(0, 0, 124, 0, Math.PI * 2);
    g.arc(0, 0, 110, 0, Math.PI * 2, true);
    g.fill();
    const spoke = (a: number, w0: number, w1: number, r0 = 20, r1 = 110) => {
      g.save();
      g.rotate(a);
      g.beginPath();
      g.moveTo(-w0, r0);
      g.lineTo(w0, r0);
      g.lineTo(w1, r1);
      g.lineTo(-w1, r1);
      g.closePath();
      g.fill();
      g.restore();
    };
    switch (style) {
      case "split5":
        for (let i = 0; i < 5; i++) for (const o of [-0.12, 0.12]) spoke((i / 5) * Math.PI * 2 + o, 8, 5);
        break;
      case "y6":
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          spoke(a, 10, 7, 20, 70);
          spoke(a - 0.2, 5, 5, 66, 110);
          spoke(a + 0.2, 5, 5, 66, 110);
        }
        break;
      case "turbine": {
        // Curved turbine blades.
        g.lineWidth = 9;
        for (let i = 0; i < 12; i++) {
          g.save();
          g.rotate((i / 12) * Math.PI * 2);
          g.beginPath();
          g.moveTo(0, 22);
          g.quadraticCurveTo(38, 60, 18, 110);
          g.stroke();
          g.restore();
        }
        break;
      }
      case "mesh10":
        for (let i = 0; i < 10; i++) spoke((i / 10) * Math.PI * 2, 6, 4);
        g.lineWidth = 4;
        for (let i = 0; i < 10; i++) {
          g.save();
          g.rotate((i / 10) * Math.PI * 2 + Math.PI / 10);
          g.beginPath();
          g.moveTo(0, 50);
          g.lineTo(18, 108);
          g.moveTo(0, 50);
          g.lineTo(-18, 108);
          g.stroke();
          g.restore();
        }
        break;
      case "star7":
        for (let i = 0; i < 7; i++) spoke((i / 7) * Math.PI * 2, 13, 9);
        break;
      case "monoblock": {
        // Solid disc with 10 small round windows (Veyron style).
        g.beginPath();
        g.arc(0, 0, 110, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = "#0d0e10";
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2;
          g.beginPath();
          g.ellipse(Math.cos(a) * 78, Math.sin(a) * 78, 13, 22, a, 0, Math.PI * 2);
          g.fill();
        }
        g.fillStyle = grad;
        break;
      }
    }
    // Hub, nuts, centre badge.
    g.beginPath();
    g.arc(0, 0, 26, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#1f2124";
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      g.beginPath();
      g.arc(Math.cos(a) * 15, Math.sin(a) * 15, 3.5, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = "#e9ecef";
    g.beginPath();
    g.arc(0, 0, 8, 0, Math.PI * 2);
    g.fill();
  });
}

/** Tyre sidewall with a lettered band, so the tyre reads as rubber not plastic. */
export function tyreWall(): THREE.CanvasTexture {
  return canvasTex("tyre-wall", 256, 256, (g) => {
    g.fillStyle = "#1c1c1d";
    g.fillRect(0, 0, 256, 256);
    g.translate(128, 128);
    g.fillStyle = "#2a2a2c";
    g.beginPath();
    g.arc(0, 0, 124, 0, Math.PI * 2);
    g.arc(0, 0, 96, 0, Math.PI * 2, true);
    g.fill();
    g.fillStyle = "rgba(200,200,200,0.55)";
    g.font = "bold 14px system-ui, sans-serif";
    g.textAlign = "center";
    const word = "FAIRBAY  P ZERO  275/35 R20  ";
    for (let i = 0; i < word.length * 2; i++) {
      g.save();
      g.rotate((i / (word.length * 2)) * Math.PI * 2);
      g.fillText(word[i % word.length], 0, -104);
      g.restore();
    }
  });
}

/** Tread pattern for the tyre's rolling surface. */
export function tread(): THREE.CanvasTexture {
  const t = canvasTex(
    "tread",
    64,
    256,
    (g) => {
      g.fillStyle = "#202022";
      g.fillRect(0, 0, 64, 256);
      g.fillStyle = "#0f0f10";
      for (let y = 0; y < 256; y += 16) {
        g.fillRect(6, y, 10, 10);
        g.fillRect(48, y + 6, 10, 10);
        g.fillRect(27, y + 3, 10, 4);
      }
      g.fillRect(20, 0, 3, 256);
      g.fillRect(41, 0, 3, 256);
    },
    true,
  );
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1, 6);
  return t;
}

// ---------------------------------------------------------------------------
// Lights
// ---------------------------------------------------------------------------

/** Headlight cluster texture: housing, projector lenses and LED signature. */
export function headlightTex(style: HeadlightStyle): THREE.CanvasTexture {
  return canvasTex(`head-${style}`, 256, 128, (g) => {
    g.fillStyle = "#14171c";
    g.fillRect(0, 0, 256, 128);
    const chrome = g.createLinearGradient(0, 0, 0, 128);
    chrome.addColorStop(0, "#8b939c");
    chrome.addColorStop(1, "#2c3138");
    g.fillStyle = chrome;
    g.fillRect(4, 4, 248, 120);
    g.fillStyle = "#0e1013";
    g.fillRect(10, 10, 236, 108);
    const lens = (x: number, y: number, r: number) => {
      const gr = g.createRadialGradient(x - r * 0.3, y - r * 0.3, 1, x, y, r);
      gr.addColorStop(0, "#ffffff");
      gr.addColorStop(0.4, "#cfd8e3");
      gr.addColorStop(1, "#4a5562");
      g.fillStyle = gr;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    };
    g.strokeStyle = "#f4fbff";
    g.lineWidth = 7;
    g.lineCap = "round";
    switch (style) {
      case "round":
        lens(70, 64, 40);
        lens(180, 64, 28);
        g.beginPath();
        g.arc(70, 64, 48, 0, Math.PI * 2);
        g.stroke();
        break;
      case "oval":
        lens(128, 64, 36);
        g.beginPath();
        g.ellipse(128, 64, 100, 44, 0, 0, Math.PI * 2);
        g.stroke();
        for (const x of [60, 196]) {
          g.beginPath();
          g.arc(x, 64, 6, 0, Math.PI * 2);
          g.stroke();
        }
        break;
      case "swept":
        lens(90, 66, 26);
        lens(160, 62, 24);
        g.beginPath();
        g.moveTo(20, 100);
        g.lineTo(230, 30);
        g.stroke();
        break;
      case "y-slit":
        g.beginPath();
        g.moveTo(20, 64);
        g.lineTo(130, 64);
        g.lineTo(200, 22);
        g.moveTo(130, 64);
        g.lineTo(200, 106);
        g.stroke();
        lens(222, 64, 16);
        break;
      case "boomerang":
        lens(80, 60, 22);
        lens(140, 60, 22);
        lens(200, 60, 22);
        g.beginPath();
        g.moveTo(20, 30);
        g.lineTo(60, 100);
        g.lineTo(236, 100);
        g.stroke();
        break;
      case "horseshoe":
        for (let i = 0; i < 4; i++) lens(54 + i * 50, 64, 18);
        g.beginPath();
        g.moveTo(24, 104);
        g.lineTo(232, 104);
        g.stroke();
        break;
    }
  });
}

/** Taillight texture with the car's signature graphic. */
export function taillightTex(style: TaillightStyle): THREE.CanvasTexture {
  return canvasTex(`tail-${style}`, 256, 96, (g) => {
    g.fillStyle = "#2a0004";
    g.fillRect(0, 0, 256, 96);
    g.fillStyle = "#560008";
    g.fillRect(4, 4, 248, 88);
    // Lit LED graphic in bright red (the emissive map multiplies this).
    g.strokeStyle = "#ff3a3a";
    g.fillStyle = "#ff3a3a";
    g.lineWidth = 9;
    g.lineCap = "round";
    switch (style) {
      case "tribar":
        for (let i = 0; i < 3; i++) g.fillRect(28 + i * 72, 18, 54, 60);
        break;
      case "strip":
        g.fillRect(10, 38, 236, 20);
        break;
      case "ring":
        for (const x of [70, 186]) {
          g.beginPath();
          g.arc(x, 48, 30, 0, Math.PI * 2);
          g.stroke();
        }
        break;
      case "y":
        g.beginPath();
        g.moveTo(16, 48);
        g.lineTo(120, 48);
        g.lineTo(220, 14);
        g.moveTo(120, 48);
        g.lineTo(220, 82);
        g.stroke();
        break;
      case "slim":
        g.beginPath();
        g.moveTo(14, 70);
        g.quadraticCurveTo(128, 20, 242, 34);
        g.stroke();
        break;
      case "band":
        g.fillRect(10, 30, 236, 12);
        g.fillRect(10, 58, 236, 6);
        break;
    }
  });
}

// ---------------------------------------------------------------------------
// Body details
// ---------------------------------------------------------------------------

export function grilleTex(style: string): THREE.CanvasTexture {
  return canvasTex(`grille-${style}`, 256, 96, (g) => {
    g.fillStyle = "#0b0c0d";
    g.fillRect(0, 0, 256, 96);
    g.strokeStyle = "#2c3036";
    g.fillStyle = "#2c3036";
    g.lineWidth = 3;
    if (style === "mesh" || style === "hex") {
      const r = style === "hex" ? 9 : 6;
      for (let y = 0; y < 110; y += r * 1.6) {
        for (let x = (Math.round(y / (r * 1.6)) % 2) * r; x < 270; x += r * 2) {
          g.beginPath();
          for (let k = 0; k < 6; k++) {
            const a = (k / 6) * Math.PI * 2;
            const px = x + Math.cos(a) * r * 0.8;
            const py = y + Math.sin(a) * r * 0.8;
            if (k === 0) g.moveTo(px, py);
            else g.lineTo(px, py);
          }
          g.closePath();
          g.stroke();
        }
      }
    } else if (style === "vane" || style === "horseshoe") {
      for (let y = 10; y < 96; y += 12) g.fillRect(6, y, 244, 4);
      g.strokeStyle = "#b9c0c8";
      g.lineWidth = 5;
      g.strokeRect(4, 4, 248, 88);
    } else if (style === "bar") {
      g.fillRect(6, 40, 244, 14);
      g.strokeStyle = "#7f868e";
      g.strokeRect(6, 40, 244, 14);
    }
  });
}

/** Number plate. */
export function plateTex(text: string): THREE.CanvasTexture {
  return canvasTex(`plate-${text}`, 256, 64, (g) => {
    g.fillStyle = "#f2f2ee";
    g.fillRect(0, 0, 256, 64);
    g.strokeStyle = "#20242a";
    g.lineWidth = 4;
    g.strokeRect(3, 3, 250, 58);
    g.fillStyle = "#1a3a8f";
    g.fillRect(3, 3, 22, 58);
    g.fillStyle = "#20242a";
    g.font = "bold 40px ui-monospace, monospace";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, 140, 34);
  });
}

export interface DetailMats {
  carbon: THREE.Material;
  trim: THREE.Material;
  chrome: THREE.Material;
}

/** A thin dark line (panel gap / door shut line) as a strip mesh. */
export function seam(points: THREE.Vector3[], mat: THREE.Material, width = 0.012): THREE.Mesh {
  const pts: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    pts.push(p.x, p.y + width, p.z, p.x, p.y - width, p.z);
    if (i > 0) {
      const a = (i - 1) * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}

export function detailSummary(d: CarDetails): string {
  return `${d.headlight} headlights, ${d.taillight} tail lights, ${d.rim} wheels`;
}
