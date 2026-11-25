/**
 * Renders traffic. Each traffic model (sedan, hatch, SUV, taxi, van, pickup,
 * bus) is a small set of merged parts drawn with InstancedMesh, so 60 cars
 * cost ~30 draw calls total. Per-instance colour gives each car its paint.
 * Brake lights and indicators are separate instanced "lamp" meshes whose
 * per-instance colour is switched every frame.
 */

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { TRAFFIC_MODELS, axlesOf, type TrafficCar, type TrafficKind, type TrafficModel } from "../game/traffic";

const MAX_PER_KIND = 48;

interface KindMeshes {
  model: TrafficModel;
  body: THREE.InstancedMesh;
  glass: THREE.InstancedMesh;
  dark: THREE.InstancedMesh;
  wheels: THREE.InstancedMesh;
  rims: THREE.InstancedMesh;
  tail: THREE.InstancedMesh;
  blinkL: THREE.InstancedMesh;
  blinkR: THREE.InstancedMesh;
  head: THREE.InstancedMesh;
  extra: THREE.InstancedMesh | null;
}

function box(w: number, h: number, l: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, l);
  g.translate(x, y, z);
  return g;
}

/**
 * Side-profile extrusion: a 2D silhouette (z along the car, y up) extruded
 * across the width with bevelled edges. Gives sloped windscreens, rounded
 * noses and proper rooflines instead of stacked boxes.
 */
function profile(points: [number, number][], width: number, bevel = 0.08): THREE.BufferGeometry {
  // The bevel grows the outline by `bevel`, so pull every point towards the
  // centroid first: the finished body then matches the intended silhouette.
  let cz = 0;
  let cy = 0;
  for (const [z, y] of points) {
    cz += z;
    cy += y;
  }
  cz /= points.length;
  cy /= points.length;
  const pts = points.map(([z, y]) => {
    const dz = z - cz;
    const dy = y - cy;
    const l = Math.hypot(dz, dy) || 1;
    return [z - (dz / l) * bevel, y - (dy / l) * bevel] as [number, number];
  });
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (const [z, y] of pts.slice(1)) shape.lineTo(z, y);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: width - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 4 });
  // Shape is in XY: map shape-x -> car z, extrude-z -> car x (centred).
  g.translate(0, 0, -(width - 2 * bevel) / 2);
  g.rotateY(-Math.PI / 2);
  return g;
}

/** Body + glasshouse silhouettes for each traffic model (length L, height H). */
function bodyParts(m: TrafficModel): { body: THREE.BufferGeometry; glass: THREE.BufferGeometry; dark: THREE.BufferGeometry; extra: THREE.BufferGeometry | null } {
  const L = m.length;
  const W = m.width;
  const H = m.height;
  const h = L / 2;
  const cl = 0.26;
  const dark: THREE.BufferGeometry[] = [];
  let extra: THREE.BufferGeometry | null = null;
  let body: [number, number][];
  let glass: [number, number][];
  const k = m.kind;
  if (k === "bus") {
    body = [[-h, cl], [h, cl], [h, H - 0.25], [h - 0.25, H], [-h + 0.2, H], [-h, H - 0.2]];
    glass = [[-h + 0.4, H - 1.3], [h - 0.05, H - 1.3], [h - 0.05, H - 0.3], [-h + 0.4, H - 0.3]];
  } else if (k === "van") {
    body = [[-h, cl], [h, cl], [h, 0.95], [h - 0.55, 1.35], [h - 1.1, H], [-h + 0.1, H], [-h, H - 0.1]];
    glass = [[h - 1.25, 1.35], [h - 0.6, 1.33], [h - 1.08, H - 0.12], [h - 1.9, H - 0.12], [h - 1.9, 1.35]];
  } else if (k === "pickup") {
    const cabR = -0.3;
    body = [[-h, cl], [h, cl], [h, 0.98], [h - 1.1, 1.12], [h - 1.65, H], [cabR, H], [cabR - 0.1, 1.1], [-h, 1.1]];
    glass = [[h - 1.7, 1.18], [h - 1.18, 1.16], [h - 1.62, H - 0.08], [cabR + 0.12, H - 0.08], [cabR + 0.12, 1.18]];
  } else if (k === "suv") {
    body = [[-h, cl + 0.05], [h, cl + 0.05], [h, 0.95], [h - 0.95, 1.12], [h - 1.65, H], [-h + 0.35, H], [-h, H - 0.4], [-h, 0.95]];
    glass = [[h - 1.7, 1.18], [h - 1.02, 1.16], [h - 1.62, H - 0.08], [-h + 0.42, H - 0.08], [-h + 0.12, H - 0.42], [-h + 0.12, 1.18]];
  } else if (k === "hatch") {
    body = [[-h, cl], [h, cl], [h, 0.78], [h - 0.85, 0.92], [h - 1.65, H], [-h + 0.45, H], [-h, 0.95]];
    glass = [[h - 1.7, 0.98], [h - 0.92, 0.96], [h - 1.6, H - 0.07], [-h + 0.5, H - 0.07], [-h + 0.12, 0.98]];
  } else {
    // sedan / taxi
    body = [[-h, cl], [h, cl], [h, 0.74], [h - 1.1, 0.86], [h - 1.9, H], [-h + 1.35, H], [-h + 0.6, 0.9], [-h, 0.86]];
    glass = [[h - 1.95, 0.92], [h - 1.18, 0.9], [h - 1.87, H - 0.07], [-h + 1.38, H - 0.07], [-h + 0.7, 0.92]];
    if (k === "taxi") extra = box(0.7, 0.22, 0.3, 0, H + 0.11, -0.25);
  }
  const bodyG = profile(body, W, 0.1);
  // Glass: same silhouette, a hair wider than the body so the side windows
  // and screens show through it.
  const glassG = profile(glass, W + 0.03, 0.03);
  // Bumpers, sills and grille.
  dark.push(box(W * 0.98, 0.22, 0.14, 0, cl + 0.12, h + 0.02));
  dark.push(box(W * 0.98, 0.22, 0.14, 0, cl + 0.12, -h - 0.02));
  dark.push(box(W + 0.03, 0.12, L * 0.62, 0, cl + 0.06, 0));
  dark.push(box(W * 0.5, 0.14, 0.04, 0, cl + 0.36, h + 0.03));
  // Mirrors.
  if (k !== "bus") for (const s of [-1, 1]) dark.push(box(0.2, 0.12, 0.1, s * (W / 2 + 0.08), k === "van" || k === "suv" || k === "pickup" ? 1.25 : 0.98, h - (k === "van" ? 1.15 : 1.75)));
  if (k === "suv") for (const s of [-1, 1]) dark.push(box(0.05, 0.05, L * 0.55, s * W * 0.38, H + 0.03, -0.1));
  if (k === "bus") dark.push(box(W * 0.9, 0.35, 0.05, 0, H - 0.25, h + 0.01)); // destination board
  // Wheel arches (dark wells so the wheels sit inside the body).
  const wr = k === "bus" ? 0.62 : k === "van" || k === "pickup" || k === "suv" ? 0.5 : 0.44;
  const axles = axlesOf(m);
  for (const z of axles) {
    for (const sd of [-1, 1]) {
      // A dark half-disc on each body side behind the wheel = wheel well.
      const arch = new THREE.CircleGeometry(wr, 16, 0, Math.PI);
      arch.rotateY((sd * Math.PI) / 2);
      arch.translate(sd * (W / 2 + 0.005), wr * 0.72, z);
      dark.push(arch);
    }
  }
  const merge = (list: THREE.BufferGeometry[]) => {
    const g = mergeGeometries(list.map((x) => x.toNonIndexed()), false)!;
    g.computeVertexNormals();
    return g;
  };
  return { body: bodyG, glass: glassG, dark: merge(dark), extra };
}

export class TrafficView {
  readonly group = new THREE.Group();
  private kinds = new Map<TrafficKind, KindMeshes>();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private c = new THREE.Color();
  private night = 0;

  constructor() {
    const bodyMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0.4, roughness: 0.42, clearcoat: 0.8, clearcoatRoughness: 0.12, envMapIntensity: 0.8 });
    const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x0f161e, metalness: 0.3, roughness: 0.08, envMapIntensity: 1.3 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.7 });
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xa7adb4, metalness: 0.85, roughness: 0.3 });
    const taxiMat = new THREE.MeshStandardMaterial({ color: 0xfff6c8, emissive: 0xffd34a, emissiveIntensity: 0.6 });
    for (const model of TRAFFIC_MODELS) {
      const parts = bodyParts(model);
      const n = MAX_PER_KIND;
      const L = model.length;
      const W = model.width;
      const r = model.kind === "bus" ? 0.5 : model.kind === "van" || model.kind === "pickup" || model.kind === "suv" ? 0.38 : 0.33;
      const wheelGeo = new THREE.CylinderGeometry(r, r, 0.24, 14);
      wheelGeo.rotateZ(Math.PI / 2);
      const axles = axlesOf(model);
      const wheelList: THREE.BufferGeometry[] = [];
      for (const z of axles) for (const s of [-1, 1]) wheelList.push(wheelGeo.clone().translate(s * (W / 2 - 0.09), r, z));
      const wheels = mergeGeometries(wheelList)!;
      const rimGeo = new THREE.CylinderGeometry(r * 0.62, r * 0.62, 0.22, 12);
      rimGeo.rotateZ(Math.PI / 2);
      const rimList: THREE.BufferGeometry[] = [];
      for (const z of axles) for (const s of [-1, 1]) rimList.push(rimGeo.clone().translate(s * (W / 2 - 0.075), r, z));
      const rims = mergeGeometries(rimList)!;
      const lampY = model.kind === "bus" ? 0.85 : model.kind === "van" || model.kind === "suv" || model.kind === "pickup" ? 0.82 : 0.66;
      const tailGeo = mergeGeometries([box(0.42, 0.16, 0.05, W / 2 - 0.3, lampY, -L / 2 - 0.08), box(0.42, 0.16, 0.05, -W / 2 + 0.3, lampY, -L / 2 - 0.08)])!;
      const headGeo = mergeGeometries([box(0.38, 0.13, 0.05, W / 2 - 0.3, lampY - 0.06, L / 2 + 0.08), box(0.38, 0.13, 0.05, -W / 2 + 0.3, lampY - 0.06, L / 2 + 0.08)])!;
      // Indicators at both ends; left side is +X when facing +Z.
      const bl = mergeGeometries([box(0.12, 0.08, 0.05, W / 2 - 0.06, lampY - 0.14, L / 2 + 0.08), box(0.12, 0.08, 0.05, W / 2 - 0.06, lampY - 0.14, -L / 2 - 0.08)])!;
      const br = mergeGeometries([box(0.12, 0.08, 0.05, -W / 2 + 0.06, lampY - 0.14, L / 2 + 0.08), box(0.12, 0.08, 0.05, -W / 2 + 0.06, lampY - 0.14, -L / 2 - 0.08)])!;
      const mk = (g: THREE.BufferGeometry, mat: THREE.Material, shadow: boolean) => {
        const im = new THREE.InstancedMesh(g, mat, n);
        im.count = 0;
        im.castShadow = shadow;
        im.receiveShadow = false;
        im.frustumCulled = false;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(im);
        return im;
      };
      const k: KindMeshes = {
        model,
        body: mk(parts.body, bodyMat, true),
        glass: mk(parts.glass, glassMat, false),
        dark: mk(parts.dark, darkMat, false),
        wheels: mk(wheels, tyreMat, false),
        rims: mk(rims, rimMat, false),
        tail: mk(tailGeo, lampMat, false),
        blinkL: mk(bl, lampMat, false),
        blinkR: mk(br, lampMat, false),
        head: mk(headGeo, lampMat, false),
        extra: parts.extra ? mk(parts.extra, taxiMat, false) : null,
      };
      // Prime instance colours.
      for (const im of [k.body, k.tail, k.blinkL, k.blinkR, k.head]) im.setColorAt(0, new THREE.Color(1, 1, 1));
      this.kinds.set(model.kind, k);
    }
  }

  setNight(n: number): void {
    this.night = n;
  }

  update(cars: readonly TrafficCar[], time: number): void {
    const counts = new Map<TrafficKind, number>();
    const blinkOn = Math.floor(time * 2.6) % 2 === 0;
    const tailOff = new THREE.Color(0.35, 0.02, 0.03);
    const tailOn = new THREE.Color(0.95, 0.04, 0.04);
    const tailNight = new THREE.Color(0.55, 0.02, 0.02);
    const amber = new THREE.Color(1.0, 0.55, 0.05);
    const amberOff = new THREE.Color(0.35, 0.2, 0.05);
    const headDay = new THREE.Color(0.75, 0.75, 0.72);
    const headNight = new THREE.Color(1.0, 0.97, 0.88);
    for (const car of cars) {
      const k = this.kinds.get(car.model.kind);
      if (!k) continue; // police patrols are drawn by the police renderer
      const i = counts.get(car.model.kind) ?? 0;
      if (i >= MAX_PER_KIND) continue;
      counts.set(car.model.kind, i + 1);
      this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, car.heading);
      this.v.set(car.x, car.y, car.z);
      this.m.compose(this.v, this.q, this.one);
      for (const im of [k.body, k.glass, k.dark, k.wheels, k.rims, k.tail, k.blinkL, k.blinkR, k.head]) im.setMatrixAt(i, this.m);
      if (k.extra) k.extra.setMatrixAt(i, this.m);
      k.body.setColorAt(i, this.c.set(car.color));
      k.tail.setColorAt(i, car.braking ? tailOn : this.night > 0.3 ? tailNight : tailOff);
      k.head.setColorAt(i, this.night > 0.3 ? headNight : headDay);
      const hazard = car.wrecked > 0;
      k.blinkL.setColorAt(i, (car.blink < 0 || hazard) && blinkOn ? amber : amberOff);
      k.blinkR.setColorAt(i, (car.blink > 0 || hazard) && blinkOn ? amber : amberOff);
    }
    for (const [kind, k] of this.kinds) {
      const n = counts.get(kind) ?? 0;
      for (const im of [k.body, k.glass, k.dark, k.wheels, k.rims, k.tail, k.blinkL, k.blinkR, k.head, k.extra]) {
        if (!im) continue;
        im.count = n;
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
    }
  }
}
