/**
 * Procedural, stylised car models built from a `BodySpec` - no model files.
 *
 * The body is a loft: ~56 cross-sections along the length, each a rounded
 * "tub" whose width, beltline height and underside follow the spec. The
 * underside rises around each axle, which cuts real wheel arches into the
 * side profile. The greenhouse is a second loft whose faces are split into
 * glass and painted roof / pillars by material group.
 */

import * as THREE from "three";
import { releaseCanvas } from "./textures";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { BodySpec, CarDef } from "../game/cars";
import { clamp, lerp, smoothstep } from "../core/math";
import { grilleTex, headlightTex, plateTex, rimFace, seam, taillightTex, tread, tyreWall } from "./carDetails";

export interface CarVisual {
  root: THREE.Group;
  /** Rolls / pitches with the suspension. */
  body: THREE.Group;
  wheels: { pivot: THREE.Group; spin: THREE.Group; front: boolean; side: number }[];
  paint: THREE.MeshPhysicalMaterial;
  brakeMat: THREE.MeshStandardMaterial;
  reverseMat: THREE.MeshStandardMaterial;
  headMat: THREE.MeshStandardMaterial;
  /** Local positions of the exhaust tips and rear tyre contact points. */
  exhausts: THREE.Vector3[];
  rearContacts: THREE.Vector3[];
  headlightAnchor: THREE.Object3D;
  /** Police light-bar lenses (only on police liveries). */
  sirenRed: THREE.MeshBasicMaterial | null;
  sirenBlue: THREE.MeshBasicMaterial | null;
  dispose(): void;
}

export interface BuildOptions {
  /** Black-and-white Fairbay PD livery: white doors + roof, POLICE lettering, light bar, push bar. */
  police?: boolean;
}

// ---- shared materials ---------------------------------------------------------
let shared: {
  glass: THREE.MeshPhysicalMaterial;
  trim: THREE.MeshStandardMaterial;
  tyre: THREE.MeshStandardMaterial;
  rim: THREE.MeshStandardMaterial;
  rimFace: THREE.MeshStandardMaterial;
  well: THREE.MeshBasicMaterial;
  chrome: THREE.MeshStandardMaterial;
  caliper: THREE.MeshStandardMaterial;
  carbon: THREE.MeshStandardMaterial;
  grille: THREE.MeshStandardMaterial;
  stripe: THREE.MeshPhysicalMaterial;
  shadow: THREE.MeshBasicMaterial;
} | null = null;

function rimTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "#16181b";
  g.fillRect(0, 0, 256, 256);
  g.translate(128, 128);
  const grad = g.createRadialGradient(0, 0, 10, 0, 0, 124);
  grad.addColorStop(0, "#e8ebef");
  grad.addColorStop(0.85, "#aeb4bb");
  grad.addColorStop(1, "#5c6168");
  g.fillStyle = grad;
  // Outer lip.
  g.beginPath();
  g.arc(0, 0, 124, 0, Math.PI * 2);
  g.arc(0, 0, 108, 0, Math.PI * 2, true);
  g.fill();
  // Ten split spokes.
  for (let i = 0; i < 5; i++) {
    g.save();
    g.rotate((i / 5) * Math.PI * 2);
    for (const off of [-0.11, 0.11]) {
      g.save();
      g.rotate(off);
      g.beginPath();
      g.moveTo(-9, 18);
      g.lineTo(9, 18);
      g.lineTo(6, 110);
      g.lineTo(-6, 110);
      g.closePath();
      g.fill();
      g.restore();
    }
    g.restore();
  }
  // Hub and nuts.
  g.beginPath();
  g.arc(0, 0, 26, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#2b2e33";
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    g.beginPath();
    g.arc(Math.cos(a) * 15, Math.sin(a) * 15, 3.5, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = "#c9ccd0";
  g.beginPath();
  g.arc(0, 0, 7, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return releaseCanvas(t);
}

function shadowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 64, 4, 32, 64, 64);
  grad.addColorStop(0, "rgba(0,0,0,0.75)");
  grad.addColorStop(0.55, "rgba(0,0,0,0.45)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.setTransform(1, 0, 0, 2, 0, -64);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 128);
  return releaseCanvas(new THREE.CanvasTexture(c));
}

function materials() {
  if (shared) return shared;
  shared = {
    glass: new THREE.MeshPhysicalMaterial({ color: 0x0b1118, metalness: 0.2, roughness: 0.05, clearcoat: 1, envMapIntensity: 1.6 }),
    trim: new THREE.MeshStandardMaterial({ color: 0x121315, roughness: 0.55, metalness: 0.2 }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x1a1a1b, roughness: 0.92 }),
    rim: new THREE.MeshStandardMaterial({ color: 0x8c9198, roughness: 0.3, metalness: 0.9 }),
    rimFace: new THREE.MeshStandardMaterial({ map: rimTexture(), roughness: 0.28, metalness: 0.85, transparent: false }),
    well: new THREE.MeshBasicMaterial({ color: 0x050505 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.12, metalness: 1 }),
    caliper: new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.4, metalness: 0.3 }),
    carbon: new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.35, metalness: 0.4 }),
    grille: new THREE.MeshStandardMaterial({ color: 0x0c0d0e, roughness: 0.7, metalness: 0.3 }),
    stripe: new THREE.MeshPhysicalMaterial({ color: 0xf4f4f4, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05 }),
    shadow: new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0.85 }),
  };
  return shared;
}

/** White door panel with POLICE lettering and the Fairbay PD star. */
function policeDoorTex(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f3f4f6";
  g.fillRect(0, 0, 512, 128);
  // Thin blue pinstripe along the bottom.
  g.fillStyle = "#1d3f8f";
  g.fillRect(0, 104, 512, 7);
  // Gold star badge.
  g.save();
  g.translate(62, 58);
  g.fillStyle = "#d4a017";
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 15 : 34;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
  g.fill();
  g.fillStyle = "#7a5a00";
  g.beginPath();
  g.arc(0, 0, 8, 0, Math.PI * 2);
  g.fill();
  g.restore();
  g.fillStyle = "#0d0f13";
  g.font = "italic 900 64px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("POLICE", 290, 52);
  g.font = "700 19px system-ui, sans-serif";
  g.fillStyle = "#1d3f8f";
  g.fillText("FAIRBAY PD  ·  TO PROTECT AND SERVE", 290, 90);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return releaseCanvas(t);
}

// ---- body profile functions ----------------------------------------------------

interface Profile {
  L: number;
  hw: number;
  front: number;
  rear: number;
  /** Arch radius. */
  R: number;
  b: BodySpec;
}

/** Half-width of the lower body at longitudinal position s (metres, + front). */
function halfWidth(p: Profile, s: number): number {
  const u = Math.abs(s) / (p.L / 2);
  const end = smoothstep(0.62, 1, u);
  let w = p.hw * (1 - (0.06 + 0.16 * p.b.plan) * end * end);
  // Fender flares over the wheels.
  for (const ax of [p.front, p.rear]) {
    const d = Math.abs(s - ax) / (p.R * 1.6);
    if (d < 1) w += p.hw * p.b.fenderFlare * (0.5 + 0.5 * Math.cos(d * Math.PI));
  }
  return w;
}

/** Beltline (top of the lower body) at s. */
function beltline(p: Profile, s: number): number {
  const b = p.b;
  const nose = p.L / 2;
  const cf = b.cabinFront * p.L;
  const cr = b.cabinRear * p.L;
  const tail = -p.L / 2;
  let h: number;
  if (s >= cf) {
    // Bonnet: rises from the nose to the cowl with a gentle convex curve.
    const t = (nose - s) / (nose - cf);
    h = lerp(b.noseHeight, b.cowlHeight, Math.sin((t * Math.PI) / 2));
  } else if (s <= cr) {
    const t = (s - tail) / (cr - tail);
    h = lerp(b.tailHeight * 0.94, b.tailHeight, smoothstep(0, 0.35, t));
  } else {
    const t = (s - cr) / (cf - cr);
    h = lerp(b.tailHeight, b.cowlHeight, t);
  }
  // Round the very nose and tail down.
  const u = Math.abs(s) / (p.L / 2);
  h -= 0.1 * smoothstep(0.9, 1, u);
  return h;
}

/** Underside height at s, including the wheel-arch cut-outs. */
function underside(p: Profile, s: number): number {
  let y = p.b.clearance;
  const ar = p.R;
  for (const ax of [p.front, p.rear]) {
    const d = Math.abs(s - ax);
    if (d < ar) y = Math.max(y, p.b.wheelRadius + Math.sqrt(ar * ar - d * d) * 0.92);
  }
  // Nose / tail lift.
  const u = Math.abs(s) / (p.L / 2);
  y += 0.12 * smoothstep(0.88, 1, u);
  return y;
}

function roofline(p: Profile, s: number): number {
  const b = p.b;
  const cf = b.cabinFront * p.L;
  const cr = b.cabinRear * p.L;
  const rf = b.roofFront * p.L;
  const rr = b.roofRear * p.L;
  const belt = beltline(p, s);
  if (s >= rf) return lerp(b.height, belt, Math.pow(clamp((s - rf) / (cf - rf), 0, 1), 1.15));
  if (s <= rr) return lerp(b.height, belt, Math.pow(clamp((rr - s) / (rr - cr), 0, 1), 1.3));
  // Slight roof crown.
  return b.height + 0.015 * Math.cos(((s - (rf + rr) / 2) / (rf - rr)) * Math.PI);
}

// ---- loft builder ---------------------------------------------------------------

/**
 * Builds a closed loft. `section(s)` returns ring points (x, y) going from the
 * right-hand bottom, over the top, to the left-hand bottom. `group(i, j)`
 * picks the material group for the quad between ring points j..j+1 and
 * stations i..i+1.
 */
function loft(
  stations: number[],
  section: (s: number) => [number, number][],
  group: (i: number, j: number) => number = () => 0,
  capEnds = true,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const rings: [number, number][][] = stations.map(section);
  const n = rings[0].length;
  const byGroup = new Map<number, number[]>();
  // Non-indexed faces with explicit duplicated vertices per group, then
  // smooth normals inside each group.
  const tri = (g: number, a: number[], b: number[], c: number[]) => {
    let list = byGroup.get(g);
    if (!list) byGroup.set(g, (list = []));
    list.push(...a, ...b, ...c);
  };
  for (let i = 0; i < stations.length - 1; i++) {
    const r0 = rings[i];
    const r1 = rings[i + 1];
    const z0 = stations[i];
    const z1 = stations[i + 1];
    for (let j = 0; j < n - 1; j++) {
      const a = [r0[j][0], r0[j][1], z0];
      const b = [r0[j + 1][0], r0[j + 1][1], z0];
      const c = [r1[j + 1][0], r1[j + 1][1], z1];
      const d = [r1[j][0], r1[j][1], z1];
      const g = group(i, j);
      tri(g, a, b, c);
      tri(g, a, c, d);
    }
  }
  if (capEnds) {
    for (const [idx, flip] of [
      [0, false],
      [stations.length - 1, true],
    ] as const) {
      const r = rings[idx];
      const z = stations[idx];
      let cx = 0;
      let cy = 0;
      for (const p of r) {
        cx += p[0];
        cy += p[1];
      }
      cx /= r.length;
      cy /= r.length;
      for (let j = 0; j < n; j++) {
        const a = r[j];
        const b = r[(j + 1) % n];
        // Emit both windings: the cap is a flat fan, so this is cheap and
        // guarantees it is solid from outside regardless of ring direction.
        tri(0, [cx, cy, z], [b[0], b[1], z], [a[0], a[1], z]);
        tri(0, [cx, cy, z], [a[0], a[1], z], [b[0], b[1], z]);
        void flip;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  const groups = [...byGroup.keys()].sort();
  let start = 0;
  for (const g of groups) {
    const list = byGroup.get(g)!;
    pos.push(...list);
    geo.addGroup(start, list.length / 3, g);
    start += list.length / 3;
  }
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  // Merge-by-position for smooth shading, but keep groups separate.
  const merged = smoothNormals(geo);
  return merged;
}

/** Computes smooth vertex normals across duplicated vertices (by position). */
function smoothNormals(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const normals = new Float32Array(pos.count * 3);
  const acc = new Map<string, THREE.Vector3>();
  const key = (i: number) => `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const faceN: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    const n = new THREE.Vector3().subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b));
    faceN.push(n.clone().normalize());
    for (let k = 0; k < 3; k++) {
      const kk = key(i + k);
      let v = acc.get(kk);
      if (!v) acc.set(kk, (v = new THREE.Vector3()));
      v.add(n);
    }
  }
  for (let i = 0; i < pos.count; i++) {
    const v = acc.get(key(i))!.clone().normalize();
    const f = faceN[Math.floor(i / 3)];
    // Keep hard edges where the smooth normal deviates > ~50 degrees.
    const use = v.dot(f) > 0.64 ? v : f;
    normals[i * 3] = use.x;
    normals[i * 3 + 1] = use.y;
    normals[i * 3 + 2] = use.z;
  }
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  return geo;
}

function stationsFor(from: number, to: number, count: number, extra: number[] = []): number[] {
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push(lerp(from, to, i / count));
  for (const e of extra) if (e > Math.min(from, to) && e < Math.max(from, to)) out.push(e);
  out.sort((x, y) => x - y);
  return out.filter((v, i) => i === 0 || v - out[i - 1] > 1e-4);
}

// ---- car assembly ---------------------------------------------------------------

export function buildCar(def: CarDef, color: string, opts: BuildOptions = {}): CarVisual {
  const m = materials();
  const b = def.body;
  const p: Profile = {
    L: b.length,
    hw: b.width / 2 - 0.03,
    front: b.frontAxle * b.length,
    rear: b.rearAxle * b.length,
    R: b.wheelRadius * 1.16,
    b,
  };
  const paint = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color),
    metalness: 0.35,
    roughness: 0.4,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    envMapIntensity: 0.9,
  });
  const root = new THREE.Group();
  root.name = def.id;
  const body = new THREE.Group();
  root.add(body);

  // -- lower body loft (Z = length axis, + front) --
  const archPts: number[] = [];
  for (const ax of [p.front, p.rear]) for (let k = -8; k <= 8; k++) archPts.push(ax + (k / 8) * p.R);
  const st = stationsFor(-p.L / 2, p.L / 2, 40, archPts);
  const tub = (s: number): [number, number][] => {
    const w = halfWidth(p, s);
    const top = beltline(p, s);
    const bot = Math.min(underside(p, s), top - 0.06);
    const h = top - bot;
    const crown = 0.03 + 0.02 * (1 - Math.abs(s) / (p.L / 2));
    const right: [number, number][] = [
      [w * 0.86, bot],
      [w * 0.97, bot + h * 0.12],
      [w, bot + h * 0.4],
      [w * 0.985, bot + h * 0.72],
      [w * 0.93, top - 0.035],
      [w * 0.78, top],
      [w * 0.4, top + crown * 0.8],
    ];
    const left = right.map(([x, y]) => [-x, y] as [number, number]).reverse();
    return [...right, [0, top + crown], ...left];
  };
  const lower = new THREE.Mesh(loft(st, tub), paint);
  lower.castShadow = true;
  lower.receiveShadow = true;
  body.add(lower);

  // Bottom pan + wheel wells (dark), so you cannot see through the arches.
  const pan = new THREE.Mesh(new THREE.BoxGeometry(p.hw * 1.7, 0.06, p.L * 0.9), m.well);
  pan.position.y = b.clearance + 0.03;
  body.add(pan);
  for (const ax of [p.front, p.rear]) {
    const well = new THREE.Mesh(new THREE.BoxGeometry(p.hw * 2 - 0.5, p.R * 1.1, p.R * 1.9), m.well);
    well.position.set(0, b.wheelRadius + p.R * 0.45, ax);
    body.add(well);
  }

  // -- greenhouse loft --
  const cf = b.cabinFront * p.L;
  const cr = b.cabinRear * p.L;
  const rf = b.roofFront * p.L;
  const rr = b.roofRear * p.L;
  const cst = stationsFor(cr, cf, 30, [rr, rf]);
  const bpillar = (rr + rf) / 2 - 0.02;
  const cabin = (s: number): [number, number][] => {
    const belt = beltline(p, s) - 0.01;
    const roof = Math.max(roofline(p, s), belt + 0.005);
    const wb = halfWidth(p, s) * 0.88;
    const wt = p.hw * b.tumblehome;
    const t = 0.82; // height of the roof rail as a fraction
    const yr = lerp(belt, roof, t);
    const wr = lerp(wb, wt, t);
    return [
      [wb, belt],
      [wr, yr],
      [wt * 0.96, roof - 0.01],
      [0, roof + 0.012],
      [-wt * 0.96, roof - 0.01],
      [-wr, yr],
      [-wb, belt],
    ];
  };
  const cabinGroup = (i: number, j: number): number => {
    const s0 = cst[i];
    const s1 = cst[i + 1];
    const mid = (s0 + s1) / 2;
    const onRoof = mid > rr - 0.02 && mid < rf + 0.02;
    if (j === 1 || j === 4) return 1; // roof rails / A & C pillars
    if (j === 2 || j === 3) return onRoof ? 1 : 0; // roof panel vs screens
    // Side windows: a B-pillar and the rear quarter in paint.
    if (Math.abs(mid - bpillar) < 0.05) return 1;
    if (mid < rr - (rr - cr) * 0.55) return 1;
    return 0;
  };
  const greenhouse = new THREE.Mesh(loft(cst, cabin, cabinGroup, false), [m.glass, paint]);
  greenhouse.castShadow = true;
  body.add(greenhouse);

  // -- racing stripes --
  if (b.stripes) {
    const sst = stationsFor(-p.L / 2 + 0.05, cf, 20);
    const stripe = (s: number): [number, number][] => {
      const top = beltline(p, s);
      const crown = 0.03 + 0.02 * (1 - Math.abs(s) / (p.L / 2));
      const y = top + crown + 0.006;
      return [
        [0.26, y - 0.004],
        [0.06, y],
        [-0.06, y],
        [-0.26, y - 0.004],
      ];
    };
    const sg = (_i: number, j: number) => (j === 1 ? 1 : 0);
    // Two white bands with a body-colour gap between them.
    const stripes = new THREE.Mesh(loft(sst, stripe, sg, false), [m.stripe, paint]);
    body.add(stripes);
  }

  // -- lights (signature clusters, textured) --
  const d = b.details;
  const headMat = new THREE.MeshStandardMaterial({ map: headlightTex(d.headlight), emissiveMap: headlightTex(d.headlight), emissive: 0xffffff, emissiveIntensity: 0.25, roughness: 0.08, metalness: 0.3 });
  const tailMat = new THREE.MeshStandardMaterial({ map: taillightTex(d.taillight), emissiveMap: taillightTex(d.taillight), emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.15 });
  const brakeMat = tailMat;
  const reverseMat = new THREE.MeshStandardMaterial({ color: 0x777777, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.2 });
  const lensMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, roughness: 0, metalness: 0, clearcoat: 1 });
  const nose = p.L / 2;
  const sNose = nose - 0.06;
  const hY = beltline(p, sNose) - 0.11;
  const hwN = halfWidth(p, sNose);
  const headW = b.slimLights ? 0.5 : d.headlight === "round" ? 0.36 : 0.44;
  const headH = b.slimLights ? 0.1 : d.headlight === "round" ? 0.2 : 0.15;
  const sTail = -p.L / 2 + 0.02;
  const twT = halfWidth(p, sTail + 0.1);
  const tailY = beltline(p, sTail) - 0.13;
  const fullBar = d.taillight === "strip" || d.taillight === "band";
  for (const side of [-1, 1]) {
    // Headlight: textured cluster on a plane angled with the nose plan + a clear lens.
    const hg = new THREE.PlaneGeometry(headW, headH);
    const head = new THREE.Mesh(hg, headMat);
    // Sit just proud of the flat nose cap so nothing hides the cluster.
    head.position.set(side * hwN * 0.6, hY, nose + 0.008);
    head.rotation.y = side * 0.06;
    if (side < 0) head.scale.x = -1;
    body.add(head);
    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), lensMat);
    lens.scale.set(headW * 1.05, headH * 0.6, 0.06);
    lens.rotation.x = Math.PI / 2;
    lens.position.copy(head.position);
    lens.rotation.z = -head.rotation.y;
    body.add(lens);
    if (!fullBar) {
      const tail = new THREE.Mesh(new THREE.PlaneGeometry(twT * 0.7, 0.15), tailMat);
      tail.position.set(side * twT * 0.58, tailY, -nose - 0.008);
      tail.rotation.y = Math.PI - side * 0.05;
      if (side < 0) tail.scale.x = -1;
      body.add(tail);
    }
    const rev = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.04), reverseMat);
    rev.position.set(side * twT * 0.2, tailY - 0.1, -nose - 0.01);
    body.add(rev);
  }
  if (fullBar) {
    // Full-width light bar across the tail (911 band / Veyron strip).
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(twT * 1.85, 0.12), tailMat);
    bar.position.set(0, tailY, -nose - 0.008);
    bar.rotation.y = Math.PI;
    body.add(bar);
  }
  // Grille / front intake, with the car's own pattern.
  const gw = halfWidth(p, nose - 0.04) * (d.grille === "horseshoe" ? 0.6 : 1.2);
  const gh = d.grille === "horseshoe" ? 0.32 : d.grille === "none" ? 0.1 : 0.2;
  const gMat = new THREE.MeshStandardMaterial({ map: grilleTex(d.grille), roughness: 0.6, metalness: 0.4 });
  const grille = new THREE.Mesh(new THREE.PlaneGeometry(gw, gh), gMat);
  grille.position.set(0, b.clearance + 0.12 + gh / 2, nose + 0.005);
  body.add(grille);
  if (d.grille === "horseshoe") {
    // Chrome horseshoe surround.
    const shoe = new THREE.Mesh(new THREE.TorusGeometry(gw * 0.5, 0.025, 6, 20, Math.PI), m.chrome);
    shoe.rotation.z = Math.PI;
    shoe.position.set(0, b.clearance + 0.12 + gh, nose + 0.01);
    body.add(shoe);
  }
  // Lower intakes either side of the grille.
  for (const side of [-1, 1]) {
    const li = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.12), gMat);
    li.position.set(side * hwN * 0.62, b.clearance + 0.16, nose - 0.02);
    li.rotation.y = side * 0.3;
    body.add(li);
  }
  // Rear diffuser with fins.
  const dw = halfWidth(p, -nose) * 1.5;
  const diff = new THREE.Mesh(new THREE.BoxGeometry(dw, 0.12, 0.2), m.carbon);
  diff.position.set(0, b.clearance + 0.12, -nose + 0.1);
  body.add(diff);
  for (let k = -2; k <= 2; k++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.14, 0.28), m.carbon);
    fin.position.set((k / 2) * dw * 0.4, b.clearance + 0.07, -nose + 0.05);
    body.add(fin);
  }
  // Number plates.
  const plateMat = new THREE.MeshStandardMaterial({ map: plateTex(`FB ${def.id.slice(0, 2).toUpperCase()}${(def.name.length * 37) % 900 + 100}`), roughness: 0.5 });
  const plateR = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.13), plateMat);
  plateR.position.set(0, tailY - 0.2, -nose - 0.012);
  plateR.rotation.y = Math.PI;
  body.add(plateR);
  const plateF = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.13), plateMat);
  plateF.position.set(0, b.clearance + 0.32, nose + 0.012);
  if (d.grille !== "horseshoe") body.add(plateF);

  // Panel seams: door shut lines, bonnet and boot lines.
  {
    const seamMat = new THREE.MeshBasicMaterial({ color: 0x08090a });
    const doorF = cf - 0.05;
    const doorR = Math.max(cr + 0.1, (cr + rr) / 2 + 0.05);
    for (const side of [-1, 1]) {
      const at = (s: number, fy: number) => {
        const top = beltline(p, s);
        const bot = underside(p, s) + 0.08;
        const y = lerp(bot, top - 0.04, fy);
        // Body side surface: widest around 40% height.
        const w = halfWidth(p, s) * (fy < 0.15 ? 0.95 : fy > 0.85 ? 0.95 : 1.0) + 0.006;
        return new THREE.Vector3(side * w, y, s);
      };
      const line = (pts: THREE.Vector3[]) => {
        const m2 = seam(pts, seamMat);
        body.add(m2);
      };
      const v = (s: number) => [0.12, 0.35, 0.6, 0.85].map((fy) => at(s, fy));
      line(v(doorF));
      line(v(doorR));
      // Door handle.
      const hs = doorR + 0.15;
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.18), m.chrome);
      handle.position.copy(at(hs, 0.72));
      handle.position.x += side * 0.01;
      body.add(handle);
      // Side skirt.
      if (d.aero > 0) {
        const sk = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, Math.abs(p.front - p.rear) - p.R * 2.1), m.carbon);
        const sm = (p.front + p.rear) / 2;
        sk.position.set(side * (halfWidth(p, sm) - 0.01), b.clearance + 0.03, sm);
        body.add(sk);
      }
    }
    // Bonnet shut line across the cowl, and boot line.
    const across = (s: number, lift: number) => {
      const pts: THREE.Vector3[] = [];
      const w = halfWidth(p, s) * 0.75;
      for (let k = 0; k <= 8; k++) {
        const x = -w + (2 * w * k) / 8;
        const crown = 0.03 + 0.02 * (1 - Math.abs(s) / (p.L / 2));
        const y = beltline(p, s) + crown * (1 - (x / (halfWidth(p, s) || 1)) ** 2) + lift;
        pts.push(new THREE.Vector3(x, y, s));
      }
      const g = seam(pts, seamMat, 0.008);
      g.rotation.x = 0;
      body.add(g);
    };
    across(cf + 0.12, 0.004);
    across(cr - 0.08, 0.004);
  }

  // Front splitter.
  if (d.aero > 0) {
    const sw = halfWidth(p, nose - 0.05) * 1.9;
    const sp = new THREE.Mesh(new THREE.BoxGeometry(sw, 0.025, 0.12 + d.aero * 0.12), m.carbon);
    sp.position.set(0, b.clearance + 0.02, nose - 0.02 + d.aero * 0.04);
    body.add(sp);
  }
  // Roof scoop (Aventura).
  if (d.roofScoop) {
    const rs = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.06, 0.5), m.carbon);
    rs.position.set(0, b.height + 0.02, rr - 0.15);
    body.add(rs);
  }
  // Two-tone front (Veyrone): a darker clam shell over the nose.
  if (d.twoTone) {
    const tt = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(d.twoTone), metalness: 0.5, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.06 });
    const sst = stationsFor(cf - 0.1, nose - 0.05, 16);
    const shell = (s: number): [number, number][] => {
      const w = halfWidth(p, s) + 0.004;
      const top = beltline(p, s) + 0.004;
      const crown = 0.03 + 0.02 * (1 - Math.abs(s) / (p.L / 2)) + 0.004;
      return [
        [w * 0.98, top - 0.18],
        [w, top - 0.06],
        [w * 0.8, top],
        [0, top + crown],
        [-w * 0.8, top],
        [-w, top - 0.06],
        [-w * 0.98, top - 0.18],
      ];
    };
    body.add(new THREE.Mesh(loft(sst, shell, () => 0, false), tt));
  }

  // Exhausts.
  const exhausts: THREE.Vector3[] = [];
  const exGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.16, 14);
  exGeo.rotateX(Math.PI / 2);
  const exX = b.quadExhaust ? [-0.42, -0.3, 0.3, 0.42] : def.body.length > 4.7 && b.slimLights ? [-0.1, 0.1] : [-0.38, 0.38];
  for (const x of exX) {
    const ex = new THREE.Mesh(exGeo, m.chrome);
    ex.position.set(x, b.clearance + 0.16, -nose + 0.02);
    body.add(ex);
    exhausts.push(new THREE.Vector3(x, b.clearance + 0.16, -nose - 0.06));
  }

  // Side intakes.
  if (b.sideIntakes) {
    for (const side of [-1, 1]) {
      const s = p.rear + p.R * 1.25;
      const w = halfWidth(p, s);
      const intake = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.16, 0.5), m.grille);
      intake.position.set(side * (w - 0.005), lerp(b.clearance, beltline(p, s), 0.55), s + 0.25);
      body.add(intake);
    }
  }

  // Bonnet scoop.
  if (b.hoodScoop) {
    const s = (cf + nose) / 2 + 0.1;
    const scoop = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.07, 0.6), paint);
    scoop.position.set(0, beltline(p, s) + 0.06, s);
    scoop.rotation.x = -0.05;
    body.add(scoop);
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 0.02), m.grille);
    mouth.position.set(0, beltline(p, s) + 0.06, s + 0.31);
    body.add(mouth);
  }

  // Mirrors.
  for (const side of [-1, 1]) {
    const s = cf - 0.12;
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.09, 0.12), paint);
    mirror.position.set(side * (halfWidth(p, s) * 0.92 + 0.08), beltline(p, s) + 0.08, s);
    body.add(mirror);
  }

  // Spoilers.
  const sTop = -p.L / 2 + 0.22;
  const yTop = beltline(p, sTop) + 0.04;
  if (b.spoiler === "lip") {
    const lip = new THREE.Mesh(new THREE.BoxGeometry(halfWidth(p, sTop) * 1.6, 0.03, 0.12), m.carbon);
    lip.position.set(0, yTop + 0.01, sTop - 0.1);
    lip.rotation.x = 0.15;
    body.add(lip);
  } else if (b.spoiler === "ducktail") {
    const duck = new THREE.Mesh(new THREE.BoxGeometry(halfWidth(p, sTop) * 1.5, 0.05, 0.32), paint);
    duck.position.set(0, yTop + 0.05, sTop - 0.06);
    duck.rotation.x = 0.22;
    body.add(duck);
  } else if (b.spoiler === "wing" || b.spoiler === "bigwing") {
    const big = b.spoiler === "bigwing";
    const lift = big ? 0.32 : 0.18;
    const wing = new THREE.Mesh(new THREE.BoxGeometry(p.hw * (big ? 1.9 : 1.6), 0.035, big ? 0.34 : 0.26), def.klass === "Super" ? m.carbon : paint);
    wing.position.set(0, yTop + lift, sTop - 0.04);
    wing.rotation.x = 0.1;
    body.add(wing);
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.04, lift, 0.12), m.carbon);
      post.position.set(side * p.hw * 0.5, yTop + lift / 2, sTop - 0.02);
      body.add(post);
    }
  }

  // -- police livery --
  let sirenRed: THREE.MeshBasicMaterial | null = null;
  let sirenBlue: THREE.MeshBasicMaterial | null = null;
  if (opts.police) {
    const white = new THREE.MeshPhysicalMaterial({ color: 0xf3f4f6, metalness: 0.2, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.08 });
    // Body side at height y (the tub's cross-section, as lofted above).
    const sideX = (s: number, y: number): number => {
      const w = halfWidth(p, s);
      const top = beltline(p, s);
      const bot = Math.min(underside(p, s), top - 0.06);
      const h = top - bot;
      const pts: [number, number][] = [
        [bot, w * 0.86],
        [bot + h * 0.12, w * 0.97],
        [bot + h * 0.4, w],
        [bot + h * 0.72, w * 0.985],
        [top - 0.035, w * 0.93],
      ];
      if (y <= pts[0][0]) return pts[0][1];
      for (let i = 0; i < pts.length - 1; i++) {
        const [y0, x0] = pts[i];
        const [y1, x1] = pts[i + 1];
        if (y <= y1) return lerp(x0, x1, (y - y0) / Math.max(1e-4, y1 - y0));
      }
      return pts[pts.length - 1][1];
    };
    // White door panels with POLICE lettering, conforming to the body side.
    const decal = new THREE.MeshStandardMaterial({ map: policeDoorTex(), roughness: 0.35, metalness: 0.1, side: THREE.DoubleSide });
    const ds0 = cr + 0.12;
    const ds1 = cf - 0.04;
    const NS = 14;
    const NY = 6;
    for (const side of [-1, 1]) {
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      for (let i = 0; i <= NS; i++) {
        const s = lerp(ds0, ds1, i / NS);
        const top = beltline(p, s) - 0.05;
        const bot = underside(p, s) + 0.1;
        for (let j = 0; j <= NY; j++) {
          const y = lerp(bot, top, j / NY);
          pos.push(side * (sideX(s, y) + 0.007), y, s);
          // Text reads front-to-back on the left side, back-to-front on the right.
          uv.push(side > 0 ? 1 - i / NS : i / NS, j / NY);
        }
      }
      for (let i = 0; i < NS; i++) {
        for (let j = 0; j < NY; j++) {
          const a = i * (NY + 1) + j;
          const b2 = a + NY + 1;
          idx.push(a, b2, b2 + 1, a, b2 + 1, a + 1);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      body.add(new THREE.Mesh(g, decal));
    }
    // White roof.
    const roofSt = stationsFor(rr - 0.06, rf + 0.06, 12);
    const roofSec = (s: number): [number, number][] => {
      const roof = Math.max(roofline(p, s), beltline(p, s) + 0.005);
      const wt = p.hw * b.tumblehome;
      return [
        [wt * 0.9, roof - 0.004],
        [wt * 0.45, roof + 0.012],
        [0, roof + 0.017],
        [-wt * 0.45, roof + 0.012],
        [-wt * 0.9, roof - 0.004],
      ];
    };
    body.add(new THREE.Mesh(loft(roofSt, roofSec, () => 0, false), white));
    // Light bar across the roof: dark housing, red (left) and blue (right) lenses.
    const sb = (rr + rf) / 2 - 0.05;
    const yb = roofline(p, sb) + 0.02;
    const wt = p.hw * b.tumblehome;
    const housing = new THREE.Mesh(new THREE.BoxGeometry(wt * 1.62, 0.06, 0.3), m.trim);
    housing.position.set(0, yb + 0.03, sb);
    body.add(housing);
    sirenRed = new THREE.MeshBasicMaterial({ color: 0xff2a2a });
    sirenBlue = new THREE.MeshBasicMaterial({ color: 0x2a6bff });
    for (const side of [-1, 1]) {
      const lens = new THREE.Mesh(new THREE.BoxGeometry(wt * 0.7, 0.085, 0.24), side > 0 ? sirenRed : sirenBlue);
      lens.position.set(side * wt * 0.42, yb + 0.1, sb);
      body.add(lens);
    }
    // Push bar in front of the grille.
    const pbz = nose + 0.09;
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.42, 0.06), m.trim);
      post.position.set(side * 0.34, b.clearance + 0.36, pbz);
      body.add(post);
    }
    for (const y of [b.clearance + 0.22, b.clearance + 0.52]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.05, 0.05), m.trim);
      bar.position.set(0, y, pbz + 0.01);
      body.add(bar);
    }
  }

  // -- wheels --
  const wheels: CarVisual["wheels"] = [];
  const r = b.wheelRadius;
  const tw = 0.26;
  const tyreGeo = new THREE.CylinderGeometry(r, r, tw, 28, 1, true);
  tyreGeo.rotateZ(Math.PI / 2);
  const sideGeo = new THREE.CircleGeometry(r, 32);
  const faceGeo = new THREE.CircleGeometry(r * 0.74, 32);
  const wallMat = new THREE.MeshStandardMaterial({ map: tyreWall(), roughness: 0.85, transparent: false });
  const treadMat = new THREE.MeshStandardMaterial({ map: tread(), roughness: 0.95 });
  const faceMat = new THREE.MeshStandardMaterial({ map: rimFace(d.rim, d.rimColor), roughness: 0.25, metalness: 0.85 });
  const caliperMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(d.caliper), roughness: 0.35, metalness: 0.3 });
  const discMat = new THREE.MeshStandardMaterial({ color: 0x8a8d91, roughness: 0.45, metalness: 0.9 });
  const discGeo = new THREE.CylinderGeometry(r * 0.62, r * 0.62, 0.03, 24);
  discGeo.rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(r * 0.72, r * 0.72, tw * 0.9, 24, 1, true);
  rimGeo.rotateZ(Math.PI / 2);
  const calGeo = new THREE.BoxGeometry(0.06, r * 0.45, r * 0.3);
  const rearContacts: THREE.Vector3[] = [];
  for (const [ax, front] of [
    [p.front, true],
    [p.rear, false],
  ] as const) {
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      const x = side * (p.hw + (front ? 0 : 0.01) - tw / 2 + 0.02);
      pivot.position.set(x, r, ax);
      const spin = new THREE.Group();
      pivot.add(spin);
      const tyre = new THREE.Mesh(tyreGeo, treadMat);
      tyre.castShadow = true;
      spin.add(tyre);
      const wall = new THREE.Mesh(sideGeo, wallMat);
      // Sidewall sits just inside the rim face so the alloy shows on top.
      wall.position.x = side * (tw / 2 - 0.035);
      wall.rotation.y = side * (Math.PI / 2);
      spin.add(wall);
      const face = new THREE.Mesh(faceGeo, faceMat);
      face.position.x = side * (tw / 2 - 0.02);
      face.rotation.y = side * (Math.PI / 2);
      spin.add(face);
      const barrel = new THREE.Mesh(rimGeo, m.rim);
      spin.add(barrel);
      const caliper = new THREE.Mesh(calGeo, caliperMat);
      caliper.position.set(side * (tw / 2 - 0.08), r * 0.25, front ? -r * 0.35 : r * 0.35);
      pivot.add(caliper);
      const disc = new THREE.Mesh(discGeo, discMat);
      disc.position.x = side * (tw / 2 - 0.1);
      spin.add(disc);
      body.parent?.add(pivot);
      root.add(pivot);
      wheels.push({ pivot, spin, front, side });
      if (!front) rearContacts.push(new THREE.Vector3(x, 0.02, ax));
    }
  }

  // Blob contact shadow (softens the car into the ground even outside the
  // real shadow-map range).
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(b.width * 1.35, b.length * 1.2), m.shadow);
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.03;
  blob.renderOrder = -1;
  root.add(blob);

  const headlightAnchor = new THREE.Object3D();
  headlightAnchor.position.set(0, hY, sNose);
  body.add(headlightAnchor);

  return {
    root,
    body,
    wheels,
    paint,
    brakeMat,
    reverseMat,
    headMat,
    exhausts,
    rearContacts,
    headlightAnchor,
    sirenRed,
    sirenBlue,
    dispose() {
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
        }
      });
      paint.dispose();
      headMat.dispose();
      tailMat.dispose();
      lensMat.dispose();
      reverseMat.dispose();
    },
  };
}

/**
 * Merges a built car's static body into one mesh per material (wheels kept
 * as separate groups so they can still turn). A detailed car is ~150 meshes;
 * merged it is ~20 draw calls. Used for parked cars and race rivals, whose
 * paint never changes.
 */
export function mergeCarBody(v: CarVisual, opts: { staticWheels?: boolean } = {}): void {
  const body = v.body;
  body.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(body.matrixWorld).invert();
  const rel = new THREE.Matrix4();
  const lists = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const meshes: THREE.Mesh[] = [];
  body.traverse((o) => {
    if (o instanceof THREE.Mesh) meshes.push(o);
  });
  for (const o of meshes) {
    rel.multiplyMatrices(inv, o.matrixWorld);
    const src = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    if (!src.getAttribute("normal")) src.computeVertexNormals();
    if (!src.getAttribute("uv")) src.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(src.getAttribute("position").count * 2), 2));
    for (const name of Object.keys(src.attributes)) if (name !== "position" && name !== "normal" && name !== "uv") src.deleteAttribute(name);
    src.applyMatrix4(rel);
    if (rel.determinant() < 0) {
      for (const name of ["position", "normal", "uv"]) {
        const a = src.getAttribute(name) as THREE.BufferAttribute;
        const arr = a.array as Float32Array;
        const n = a.itemSize;
        for (let i = 0; i < a.count; i += 3) {
          for (let k = 0; k < n; k++) {
            const t = arr[(i + 1) * n + k];
            arr[(i + 1) * n + k] = arr[(i + 2) * n + k];
            arr[(i + 2) * n + k] = t;
          }
        }
      }
    }
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const groups = src.groups.length ? src.groups : [{ start: 0, count: src.getAttribute("position").count, materialIndex: 0 }];
    for (const grp of groups) {
      const mat = mats[grp.materialIndex ?? 0];
      if (!mat) continue;
      const part = new THREE.BufferGeometry();
      for (const name of ["position", "normal", "uv"]) {
        const a = src.getAttribute(name) as THREE.BufferAttribute;
        part.setAttribute(name, new THREE.BufferAttribute((a.array as Float32Array).slice(grp.start * a.itemSize, (grp.start + grp.count) * a.itemSize), a.itemSize));
      }
      let list = lists.get(mat);
      if (!list) lists.set(mat, (list = []));
      list.push(part);
    }
    o.parent?.remove(o);
  }
  for (const [mat, list] of lists) {
    const g = mergeGeometries(list, false);
    if (!g) continue;
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = true;
    body.add(mesh);
  }
  // Wheels: all four into one mesh per material, parented to the root (they
  // no longer spin or steer - fine for parked cars). Saves ~40 draw calls.
  if (opts.staticWheels) {
    const wl = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const rootInv = new THREE.Matrix4().copy(v.root.matrixWorld).invert();
    v.root.updateMatrixWorld(true);
    for (const w of v.wheels) {
      const ws: THREE.Mesh[] = [];
      w.pivot.traverse((o) => {
        if (o instanceof THREE.Mesh) ws.push(o);
      });
      for (const o of ws) {
        rel.multiplyMatrices(rootInv, o.matrixWorld);
        const src = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
        if (!src.getAttribute("uv")) src.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(src.getAttribute("position").count * 2), 2));
        for (const name of Object.keys(src.attributes)) if (name !== "position" && name !== "normal" && name !== "uv") src.deleteAttribute(name);
        src.applyMatrix4(rel);
        const mat = o.material as THREE.Material;
        let list = wl.get(mat);
        if (!list) wl.set(mat, (list = []));
        list.push(src);
      }
      w.pivot.parent?.remove(w.pivot);
    }
    for (const [mat, list] of wl) {
      const g = mergeGeometries(list, false);
      if (g) v.root.add(new THREE.Mesh(g, mat));
    }
    v.wheels.length = 0;
  }
}

/** Updates wheels, body roll / pitch and lights from the physics state. */
export function poseCar(
  v: CarVisual,
  state: { steer: number; wheelSpin: number; roll: number; pitch: number; bodyPitch: number; braking: boolean; reversing: boolean; lightsOn: boolean },
): void {
  for (const w of v.wheels) {
    w.spin.rotation.x = state.wheelSpin;
    w.pivot.rotation.y = w.front ? state.steer * 0.5 : 0;
  }
  v.body.rotation.z = state.roll;
  v.body.rotation.x = -state.bodyPitch;
  v.brakeMat.emissiveIntensity = state.braking ? 2.2 : state.lightsOn ? 0.9 : 0.5;
  v.reverseMat.emissiveIntensity = state.reversing ? 2.5 : 0;
  v.headMat.emissiveIntensity = state.lightsOn ? 1.6 : 0.25;
}
