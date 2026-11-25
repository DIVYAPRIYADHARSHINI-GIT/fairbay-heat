/**
 * Renders the police: pursuit units and roadblock cars (full physics cars)
 * and the patrol cars that drive in traffic.
 *
 * Each police car type (Interceptor, Enforcer) is built ONCE with the
 * player-car builder in the black-and-white Fairbay PD livery, then split
 * into one merged geometry per material and drawn with InstancedMesh: the
 * whole police force costs a fixed number of draw calls however many cars
 * are on screen (a plain clone would cost ~50 per car).
 *
 *  - Light-bar lenses and brake lights use per-instance colours, so every
 *    car flashes / brakes on its own (patrols have their bars off).
 *  - Wheels are instanced per side, with per-wheel steer + spin.
 *  - Siren glows are one additive point cloud; two shared point lights
 *    splash red / blue onto the street around the nearest unit.
 */

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { CarDef } from "../game/cars";
import { ENFORCER, INTERCEPTOR, type Unit } from "../game/police";
import type { TrafficCar } from "../game/traffic";
import { buildCar, type CarVisual } from "./carModel";
import { radial } from "./textures";

const MAX = 16;

/** Copies a geometry keeping only position / normal / uv, non-indexed, with `m` baked in. */
function normalised(src: THREE.BufferGeometry, m: THREE.Matrix4): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src.clone();
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  if (!g.getAttribute("uv")) g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute("position").count * 2), 2));
  for (const name of Object.keys(g.attributes)) if (name !== "position" && name !== "normal" && name !== "uv") g.deleteAttribute(name);
  g.applyMatrix4(m);
  if (m.determinant() < 0) {
    // Mirrored parts (scale.x = -1): restore the triangle winding.
    for (const name of ["position", "normal", "uv"]) {
      const a = g.getAttribute(name) as THREE.BufferAttribute;
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
  return g;
}

/** Splits every mesh under `root` (transform relative to `root`) into one merged geometry per material. */
function byMaterial(root: THREE.Object3D, include: (o: THREE.Mesh) => boolean): Map<THREE.Material, THREE.BufferGeometry> {
  const lists = new Map<THREE.Material, THREE.BufferGeometry[]>();
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const rel = new THREE.Matrix4();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !include(o)) return;
    rel.multiplyMatrices(inv, o.matrixWorld);
    const g = normalised(o.geometry, rel);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const groups = g.groups.length ? g.groups : [{ start: 0, count: g.getAttribute("position").count, materialIndex: 0 }];
    for (const grp of groups) {
      const mat = mats[grp.materialIndex ?? 0];
      if (!mat) continue;
      const part = new THREE.BufferGeometry();
      for (const name of ["position", "normal", "uv"]) {
        const a = g.getAttribute(name) as THREE.BufferAttribute;
        part.setAttribute(name, new THREE.BufferAttribute((a.array as Float32Array).slice(grp.start * a.itemSize, (grp.start + grp.count) * a.itemSize), a.itemSize));
      }
      let list = lists.get(mat);
      if (!list) lists.set(mat, (list = []));
      list.push(part);
    }
  });
  const out = new Map<THREE.Material, THREE.BufferGeometry>();
  for (const [mat, list] of lists) {
    const g = mergeGeometries(list, false);
    if (g) out.set(mat, g);
  }
  return out;
}

interface WheelSet {
  mesh: THREE.InstancedMesh;
  side: number;
}

interface Kind {
  def: CarDef;
  visual: CarVisual;
  body: THREE.InstancedMesh[];
  lensR: THREE.InstancedMesh | null;
  lensB: THREE.InstancedMesh | null;
  brake: THREE.InstancedMesh;
  blob: THREE.InstancedMesh | null;
  wheels: WheelSet[];
  /** Wheel pivots in car space. */
  pivots: { x: number; y: number; z: number; front: boolean; side: number }[];
  /** Light-bar lens centres (car space) for the glow sprites. */
  glowL: THREE.Vector3;
  glowR: THREE.Vector3;
  count: number;
  /** Wheel instances used per side this frame. */
  wheelCount: Map<number, number>;
}

export class PoliceView {
  readonly group = new THREE.Group();
  private kinds = new Map<string, Kind>();
  private splashR: THREE.PointLight;
  private splashB: THREE.PointLight;
  private glow: THREE.Points;
  private glowPos: Float32Array;
  private glowCol: Float32Array;
  /** Current phase of the light bars (true = red side lit), for the minimap. */
  redPhase = true;
  private night = 0;
  private m = new THREE.Matrix4();
  private w = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, "YXZ");
  private v = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private drawnCount = 0;

  constructor() {
    for (const def of [INTERCEPTOR, ENFORCER]) this.kinds.set(def.id, this.buildKind(def));
    // Siren glows: one additive point cloud for every car.
    this.glowPos = new Float32Array(MAX * 4 * 3);
    this.glowCol = new Float32Array(MAX * 4 * 3);
    const gg = new THREE.BufferGeometry();
    gg.setAttribute("position", new THREE.BufferAttribute(this.glowPos, 3).setUsage(THREE.DynamicDrawUsage));
    gg.setAttribute("color", new THREE.BufferAttribute(this.glowCol, 3).setUsage(THREE.DynamicDrawUsage));
    gg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.glow = new THREE.Points(
      gg,
      new THREE.PointsMaterial({ size: 3, map: radial("rgba(255,255,255,1)", "rgba(255,255,255,0)", 64), vertexColors: true, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, sizeAttenuation: true }),
    );
    this.glow.frustumCulled = false;
    this.group.add(this.glow);
    // Two shared point lights splash the flashing red / blue onto the street
    // around the nearest siren (lights are expensive: only two).
    this.splashR = new THREE.PointLight(0xff2020, 0, 28, 1.6);
    this.splashB = new THREE.PointLight(0x2050ff, 0, 28, 1.6);
    this.group.add(this.splashR, this.splashB);
  }

  private buildKind(def: CarDef): Kind {
    const visual = buildCar(def, def.colors[0], { police: true });
    const mk = (g: THREE.BufferGeometry, mat: THREE.Material, n: number, shadow = false) => {
      const im = new THREE.InstancedMesh(g, mat, n);
      im.count = 0;
      im.visible = false;
      im.castShadow = shadow;
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(im);
      return im;
    };
    const parts = byMaterial(visual.body, () => true);
    const body: THREE.InstancedMesh[] = [];
    let lensR: THREE.InstancedMesh | null = null;
    let lensB: THREE.InstancedMesh | null = null;
    let brakeGeo: THREE.BufferGeometry | null = null;
    for (const [mat, g] of parts) {
      if (mat === visual.sirenRed || mat === visual.sirenBlue) {
        // Lenses: white material x per-instance colour (lit / dim per car).
        const im = mk(g, new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX);
        im.setColorAt(0, new THREE.Color(1, 1, 1));
        if (mat === visual.sirenRed) lensR = im;
        else lensB = im;
        continue;
      }
      if (mat === visual.brakeMat) brakeGeo = g.clone();
      // Only the big painted shell casts a shadow (cheap and enough).
      body.push(mk(g, mat, MAX, mat === visual.paint));
    }
    // Brake-light glow overlay: additive, per-instance colour (black = off),
    // pushed a hair behind the tail-light planes.
    if (brakeGeo) brakeGeo.translate(0, 0, -0.004);
    const brake = mk(brakeGeo ?? new THREE.PlaneGeometry(0.01, 0.01), new THREE.MeshBasicMaterial({ color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }), MAX);
    brake.setColorAt(0, new THREE.Color(0, 0, 0));
    // Contact shadow blob.
    let blob: THREE.InstancedMesh | null = null;
    const blobMesh = visual.root.children.find((o) => o instanceof THREE.Mesh && (o.material as THREE.Material).transparent) as THREE.Mesh | undefined;
    if (blobMesh) {
      blobMesh.updateMatrix();
      blob = mk(normalised(blobMesh.geometry, blobMesh.matrix), blobMesh.material as THREE.Material, MAX);
      blob.renderOrder = -1;
    }
    // Wheels: one wheel per side (the faces differ left / right), without the
    // brake disc (a thin cylinder hidden behind the rim at chase distance).
    const wheels: WheelSet[] = [];
    const pivots: Kind["pivots"] = [];
    for (const wv of visual.wheels) pivots.push({ x: wv.pivot.position.x, y: wv.pivot.position.y, z: wv.pivot.position.z, front: wv.front, side: wv.side });
    for (const side of [-1, 1]) {
      const wv = visual.wheels.find((x) => x.side === side && x.front);
      if (!wv) continue;
      const mats = byMaterial(wv.spin, (o) => {
        const p = (o.geometry as THREE.BufferGeometry & { parameters?: { height?: number } }).parameters;
        return !(p && p.height !== undefined && p.height < 0.05);
      });
      for (const [mat, g] of mats) wheels.push({ mesh: mk(g, mat, MAX * 2), side });
    }
    const b = def.body;
    const wt = (b.width / 2 - 0.03) * b.tumblehome;
    const zb = ((b.roofRear + b.roofFront) / 2) * b.length - 0.05;
    const yb = b.height + 0.16;
    return {
      def,
      visual,
      body,
      lensR,
      lensB,
      brake,
      blob,
      wheels,
      pivots,
      glowL: new THREE.Vector3(wt * 0.42, yb, zb),
      glowR: new THREE.Vector3(-wt * 0.42, yb, zb),
      count: 0,
      wheelCount: new Map(),
    };
  }

  setNight(n: number): void {
    this.night = n;
  }

  /**
   * Places every police car for this frame.
   * @param units   pursuit / roadblock units (physics cars)
   * @param patrols patrol cars driving in traffic
   * @param focusX  the player's position: the street splash follows the nearest siren
   */
  update(units: readonly Unit[], patrols: readonly TrafficCar[], time: number, focusX: number, focusZ: number): void {
    // Light bar: double-flash red, then double-flash blue.
    const t = (time * 2.2) % 2;
    const f = t % 1;
    const flash = f < 0.7 && Math.floor(f * 6) % 2 === 0;
    this.redPhase = t < 1;
    const redOn = this.redPhase && flash;
    const blueOn = !this.redPhase && flash;
    for (const k of this.kinds.values()) {
      k.count = 0;
      k.wheelCount.clear();
    }
    let gi = 0;
    let best: { x: number; y: number; z: number; d: number } | null = null;
    const brakeOn = new THREE.Color(1.4, 0.06, 0.04);
    const off = new THREE.Color(0, 0, 0);
    const dimR = new THREE.Color(0.28, 0.04, 0.04);
    const dimB = new THREE.Color(0.04, 0.07, 0.28);
    const litR = new THREE.Color(2.2, 0.18, 0.15);
    const litB = new THREE.Color(0.25, 0.5, 2.4);
    (this.glow.material as THREE.PointsMaterial).size = 2.2 + this.night * 2.8;

    const place = (def: CarDef, x: number, y: number, z: number, heading: number, pitch: number, steer: number, spin: number, braking: boolean, siren: boolean) => {
      const k = this.kinds.get(def.id)!;
      if (k.count >= MAX) return;
      const i = k.count++;
      this.e.set(-pitch, heading, 0, "YXZ");
      this.q.setFromEuler(this.e);
      this.v.set(x, y, z);
      this.m.compose(this.v, this.q, this.one);
      for (const im of k.body) im.setMatrixAt(i, this.m);
      k.blob?.setMatrixAt(i, this.m);
      k.brake.setMatrixAt(i, this.m);
      k.brake.setColorAt(i, braking ? brakeOn : off);
      if (k.lensR) {
        k.lensR.setMatrixAt(i, this.m);
        k.lensR.setColorAt(i, siren && redOn ? litR : dimR);
      }
      if (k.lensB) {
        k.lensB.setMatrixAt(i, this.m);
        k.lensB.setColorAt(i, siren && blueOn ? litB : dimB);
      }
      // Wheels: car matrix x pivot offset x steer x spin.
      for (const pv of k.pivots) {
        this.e.set(spin, pv.front ? steer * 0.5 : 0, 0, "YXZ");
        this.q.setFromEuler(this.e);
        this.v.set(pv.x, pv.y, pv.z);
        this.w.compose(this.v, this.q, this.one).premultiply(this.m);
        const n = k.wheelCount.get(pv.side) ?? 0;
        if (n >= MAX * 2) continue;
        k.wheelCount.set(pv.side, n + 1);
        for (const ws of k.wheels) if (ws.side === pv.side) ws.mesh.setMatrixAt(n, this.w);
      }
      // Siren glows (only when lit).
      if (siren) {
        for (const [p, on, col] of [
          [k.glowL, redOn, litR],
          [k.glowR, blueOn, litB],
        ] as const) {
          if (!on || gi >= MAX * 4) continue;
          this.v.copy(p).applyMatrix4(this.m);
          this.glowPos.set([this.v.x, this.v.y, this.v.z], gi * 3);
          this.glowCol.set([col.r * 0.5, col.g * 0.5, col.b * 0.5], gi * 3);
          gi++;
        }
        const d = Math.hypot(x - focusX, z - focusZ);
        if (!best || d < best.d) best = { x, y, z, d };
      }
    };
    for (const u of units) {
      const c = u.phys;
      place(c.def, c.x, c.y, c.z, c.heading, c.pitch, c.steer, c.wheelSpin, u.ctl.brake > 0 && c.vLong > 0.5, u.siren && u.mode !== "wrecked");
    }
    for (const car of patrols) place(INTERCEPTOR, car.x, car.y, car.z, car.heading, 0, 0, 0, car.braking, false);
    let drawn = 0;
    for (const k of this.kinds.values()) {
      drawn += k.count;
      const all = [...k.body, k.brake, k.lensR, k.lensB, k.blob].filter((x): x is THREE.InstancedMesh => !!x);
      for (const im of all) {
        im.count = k.count;
        im.visible = k.count > 0;
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
      for (const ws of k.wheels) {
        const n = k.wheelCount.get(ws.side) ?? 0;
        ws.mesh.count = n;
        ws.mesh.visible = n > 0;
        ws.mesh.instanceMatrix.needsUpdate = true;
      }
    }
    this.drawnCount = drawn;
    const gg = this.glow.geometry;
    gg.setDrawRange(0, gi);
    (gg.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (gg.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    this.glow.visible = gi > 0;
    // Street splash of the nearest siren (stronger at night).
    const b = best as { x: number; y: number; z: number; d: number } | null;
    const lvl = b && b.d < 120 ? 5 + 30 * this.night : 0;
    this.splashR.intensity = redOn ? lvl : 0;
    this.splashB.intensity = blueOn ? lvl : 0;
    if (b) {
      this.splashR.position.set(b.x, b.y + 2.2, b.z);
      this.splashB.position.set(b.x, b.y + 2.2, b.z);
    }
  }

  /** Number of police cars drawn this frame (tests). */
  get drawn(): number {
    return this.drawnCount;
  }
}
