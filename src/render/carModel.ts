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
import type { BodySpec, CarDef } from "../game/cars";
import { clamp, lerp, smoothstep } from "../core/math";

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
  dispose(): void;
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
  return t;
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
  return new THREE.CanvasTexture(c);
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

export function buildCar(def: CarDef, color: string): CarVisual {
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

  // -- lights --
  const headMat = new THREE.MeshStandardMaterial({ color: 0xf2f6ff, emissive: 0xdde8ff, emissiveIntensity: 0.6, roughness: 0.1, metalness: 0.2 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x5a0008, emissive: 0xff1a2a, emissiveIntensity: 0.9, roughness: 0.2 });
  const brakeMat = tailMat;
  const reverseMat = new THREE.MeshStandardMaterial({ color: 0x777777, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.2 });
  const nose = p.L / 2;
  const sNose = nose - 0.05;
  const hY = beltline(p, sNose) - 0.1;
  for (const side of [-1, 1]) {
    const hw = halfWidth(p, sNose);
    const geo = b.slimLights ? new THREE.BoxGeometry(0.42, 0.07, 0.16) : new THREE.SphereGeometry(0.13, 16, 10);
    const lamp = new THREE.Mesh(geo, headMat);
    if (!b.slimLights) lamp.scale.set(1.25, 0.75, 0.6);
    lamp.position.set(side * hw * 0.66, hY, sNose);
    if (b.slimLights) lamp.rotation.y = side * 0.25;
    body.add(lamp);
    // Tail light bar.
    const sTail = -p.L / 2 + 0.01;
    const tw = halfWidth(p, sTail + 0.1);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(tw * 0.55, 0.09, 0.08), tailMat);
    tail.position.set(side * tw * 0.58, beltline(p, sTail) - 0.12, sTail);
    body.add(tail);
    const rev = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 0.08), reverseMat);
    rev.position.set(side * tw * 0.22, beltline(p, sTail) - 0.12, sTail - 0.01);
    body.add(rev);
  }
  // Grille / front intake.
  const gw = halfWidth(p, nose - 0.04) * 1.2;
  const grille = new THREE.Mesh(new THREE.BoxGeometry(gw, 0.16, 0.1), m.grille);
  grille.position.set(0, b.clearance + 0.2, nose - 0.08);
  body.add(grille);
  // Rear diffuser.
  const diff = new THREE.Mesh(new THREE.BoxGeometry(halfWidth(p, -nose) * 1.5, 0.12, 0.16), m.carbon);
  diff.position.set(0, b.clearance + 0.14, -nose + 0.1);
  body.add(diff);

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

  // -- wheels --
  const wheels: CarVisual["wheels"] = [];
  const r = b.wheelRadius;
  const tw = 0.26;
  const tyreGeo = new THREE.CylinderGeometry(r, r, tw, 28, 1, true);
  tyreGeo.rotateZ(Math.PI / 2);
  const sideGeo = new THREE.RingGeometry(r * 0.72, r, 28);
  const faceGeo = new THREE.CircleGeometry(r * 0.72, 28);
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
      const tyre = new THREE.Mesh(tyreGeo, m.tyre);
      tyre.castShadow = true;
      spin.add(tyre);
      const wall = new THREE.Mesh(sideGeo, m.tyre);
      wall.position.x = side * (tw / 2);
      wall.rotation.y = side * (Math.PI / 2);
      spin.add(wall);
      const face = new THREE.Mesh(faceGeo, m.rimFace);
      face.position.x = side * (tw / 2 - 0.03);
      face.rotation.y = side * (Math.PI / 2);
      spin.add(face);
      const barrel = new THREE.Mesh(rimGeo, m.rim);
      spin.add(barrel);
      const caliper = new THREE.Mesh(calGeo, m.caliper);
      caliper.position.set(side * (tw / 2 - 0.08), r * 0.25, front ? -r * 0.35 : r * 0.35);
      pivot.add(caliper);
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
    dispose() {
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
        }
      });
      paint.dispose();
      headMat.dispose();
      tailMat.dispose();
      reverseMat.dispose();
    },
  };
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
  v.brakeMat.emissiveIntensity = state.braking ? 3.2 : state.lightsOn ? 1.2 : 0.6;
  v.reverseMat.emissiveIntensity = state.reversing ? 2.5 : 0;
  v.headMat.emissiveIntensity = state.lightsOn ? 4 : 0.5;
}
