/**
 * Renders traffic. Each traffic model (sedan, hatch, SUV, taxi, van, pickup,
 * bus) is a small set of merged parts drawn with InstancedMesh, so 60 cars
 * cost ~30 draw calls total. Per-instance colour gives each car its paint.
 * Brake lights and indicators are separate instanced "lamp" meshes whose
 * per-instance colour is switched every frame.
 */

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { TRAFFIC_MODELS, type TrafficCar, type TrafficKind, type TrafficModel } from "../game/traffic";

const MAX_PER_KIND = 48;

interface KindMeshes {
  model: TrafficModel;
  body: THREE.InstancedMesh;
  glass: THREE.InstancedMesh;
  dark: THREE.InstancedMesh;
  wheels: THREE.InstancedMesh;
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

/** Simple chamfered body: lower box + cabin, with a few bevels via scaling. */
function bodyParts(m: TrafficModel): { body: THREE.BufferGeometry; glass: THREE.BufferGeometry; dark: THREE.BufferGeometry; extra: THREE.BufferGeometry | null } {
  const L = m.length;
  const W = m.width;
  const H = m.height;
  const clear = 0.28;
  const parts: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  const dark: THREE.BufferGeometry[] = [];
  let extra: THREE.BufferGeometry | null = null;
  const k = m.kind;
  if (k === "bus") {
    parts.push(box(W, H - clear - 0.15, L, 0, clear + (H - clear) / 2 - 0.05, 0));
    glass.push(box(W + 0.02, 0.9, L - 1.4, 0, H - 1.05, -0.2));
    glass.push(box(W - 0.3, 1.2, 0.05, 0, H - 1.2, L / 2 + 0.01));
    dark.push(box(W + 0.03, 0.25, L, 0, clear + 0.1, 0));
  } else if (k === "van") {
    parts.push(box(W, H - clear - 0.1, L - 0.9, 0, clear + (H - clear) / 2, -0.45));
    parts.push(box(W, (H - clear) * 0.5, 1.0, 0, clear + (H - clear) * 0.25, L / 2 - 0.5));
    glass.push(box(W - 0.15, 0.6, 0.05, 0, H - 0.75, L / 2 - 0.92));
    glass.push(box(W + 0.02, 0.5, 1.1, 0, H - 0.75, L / 2 - 1.5));
    dark.push(box(W + 0.03, 0.2, L, 0, clear + 0.08, 0));
  } else if (k === "pickup") {
    const cabL = 2.2;
    parts.push(box(W, 0.75, L, 0, clear + 0.45, 0));
    parts.push(box(W - 0.1, H - clear - 0.8, cabL, 0, clear + 0.8 + (H - clear - 0.8) / 2, 0.35));
    glass.push(box(W - 0.05, 0.45, cabL - 0.3, 0, H - 0.35, 0.35));
    // Bed walls.
    dark.push(box(W - 0.3, 0.05, L / 2 - 1.2, 0, clear + 0.84, -L / 4 - 0.4));
    dark.push(box(W + 0.03, 0.2, L, 0, clear + 0.06, 0));
  } else {
    const cabL = k === "hatch" ? L * 0.55 : k === "suv" ? L * 0.62 : L * 0.48;
    const cabZ = k === "hatch" ? -L * 0.12 : k === "suv" ? -L * 0.1 : -L * 0.04;
    const beltH = k === "suv" ? 0.95 : 0.78;
    parts.push(box(W, beltH - clear, L, 0, clear + (beltH - clear) / 2, 0));
    // Cabin narrower than body (tumblehome).
    const cab = box(W * 0.86, H - beltH, cabL, 0, beltH + (H - beltH) / 2, cabZ);
    parts.push(cab);
    glass.push(box(W * 0.87, (H - beltH) * 0.72, cabL * 0.92, 0, beltH + (H - beltH) * 0.42, cabZ));
    dark.push(box(W + 0.02, 0.18, L, 0, clear + 0.07, 0));
    if (k === "taxi") extra = box(0.7, 0.22, 0.28, 0, H + 0.11, cabZ);
    if (k === "suv") dark.push(box(W * 0.8, 0.06, cabL * 0.8, 0, H + 0.03, cabZ)); // roof rails
  }
  // Bumpers.
  dark.push(box(W * 0.96, 0.22, 0.12, 0, clear + 0.18, L / 2 + 0.03));
  dark.push(box(W * 0.96, 0.22, 0.12, 0, clear + 0.18, -L / 2 - 0.03));
  const merge = (list: THREE.BufferGeometry[]) => {
    const g = mergeGeometries(list.map((x) => x.toNonIndexed()), false)!;
    g.computeVertexNormals();
    return g;
  };
  return { body: merge(parts), glass: merge(glass), dark: merge(dark), extra };
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
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const taxiMat = new THREE.MeshStandardMaterial({ color: 0xfff6c8, emissive: 0xffd34a, emissiveIntensity: 0.6 });
    for (const model of TRAFFIC_MODELS) {
      const parts = bodyParts(model);
      const n = MAX_PER_KIND;
      const L = model.length;
      const W = model.width;
      const r = model.kind === "bus" ? 0.5 : model.kind === "van" || model.kind === "pickup" || model.kind === "suv" ? 0.38 : 0.33;
      const wheelGeo = new THREE.CylinderGeometry(r, r, 0.24, 14);
      wheelGeo.rotateZ(Math.PI / 2);
      const axles = model.kind === "bus" ? [L / 2 - 2.2, -L / 2 + 2.6] : [L / 2 - 0.85, -L / 2 + 0.85];
      const wheelList: THREE.BufferGeometry[] = [];
      for (const z of axles) for (const s of [-1, 1]) wheelList.push(wheelGeo.clone().translate(s * (W / 2 - 0.12), r, z));
      const wheels = mergeGeometries(wheelList)!;
      const clear = 0.28;
      const tailGeo = mergeGeometries([box(0.32, 0.12, 0.05, W / 2 - 0.25, clear + 0.45, -L / 2 - 0.05), box(0.32, 0.12, 0.05, -W / 2 + 0.25, clear + 0.45, -L / 2 - 0.05)])!;
      const headGeo = mergeGeometries([box(0.3, 0.1, 0.05, W / 2 - 0.25, clear + 0.42, L / 2 + 0.06), box(0.3, 0.1, 0.05, -W / 2 + 0.25, clear + 0.42, L / 2 + 0.06)])!;
      // Indicators at both ends; left side is +X when facing +Z.
      const bl = mergeGeometries([box(0.12, 0.08, 0.05, W / 2 - 0.05, clear + 0.32, L / 2 + 0.06), box(0.12, 0.08, 0.05, W / 2 - 0.05, clear + 0.32, -L / 2 - 0.06)])!;
      const br = mergeGeometries([box(0.12, 0.08, 0.05, -W / 2 + 0.05, clear + 0.32, L / 2 + 0.06), box(0.12, 0.08, 0.05, -W / 2 + 0.05, clear + 0.32, -L / 2 - 0.06)])!;
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
    const tailOn = new THREE.Color(1.0, 0.05, 0.05);
    const tailNight = new THREE.Color(0.7, 0.03, 0.03);
    const amber = new THREE.Color(1.0, 0.55, 0.05);
    const amberOff = new THREE.Color(0.35, 0.2, 0.05);
    const headDay = new THREE.Color(0.75, 0.75, 0.72);
    const headNight = new THREE.Color(1.6, 1.55, 1.4);
    for (const car of cars) {
      const k = this.kinds.get(car.model.kind)!;
      const i = counts.get(car.model.kind) ?? 0;
      if (i >= MAX_PER_KIND) continue;
      counts.set(car.model.kind, i + 1);
      this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, car.heading);
      this.v.set(car.x, car.y, car.z);
      this.m.compose(this.v, this.q, this.one);
      for (const im of [k.body, k.glass, k.dark, k.wheels, k.tail, k.blinkL, k.blinkR, k.head]) im.setMatrixAt(i, this.m);
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
      for (const im of [k.body, k.glass, k.dark, k.wheels, k.tail, k.blinkL, k.blinkR, k.head, k.extra]) {
        if (!im) continue;
        im.count = n;
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
    }
  }
}
