/**
 * Race and speed-event visuals.
 *
 *  - Race start markers: a glowing chequered beacon at each race's start
 *    (visible from far away, also drawn on the minimap / map).
 *  - During a race: the NEXT checkpoint is a tall glowing gate across the
 *    road (two pylons + a banner), the one after it a faint ghost so you can
 *    see where the route turns; the finish is a chequered arch.
 *  - Speed cameras: a pole with a camera head and a flash; speed traps get
 *    an overhead gantry at each end with a chequered "SPEED TRAP" board.
 *
 * Rival race cars are drawn with the normal car builder (merged body, real
 * spinning wheels) - see `RivalViews`.
 */

import * as THREE from "three";
import type { CameraDef, Gate, RaceDef, Route } from "../game/race";
import type { CarDef } from "../game/cars";
import { buildCar, mergeCarBody, poseCar, type CarVisual } from "./carModel";

function chequer(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const g = c.getContext("2d")!;
  for (let y = 0; y < 4; y++) for (let x = 0; x < 16; x++) {
    g.fillStyle = (x + y) % 2 ? "#111" : "#f5f5f5";
    g.fillRect(x * 16, y * 16, 16, 16);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

function banner(text: string, color: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 96;
  const g = c.getContext("2d")!;
  g.fillStyle = color;
  g.fillRect(0, 0, 512, 96);
  g.fillStyle = "rgba(0,0,0,0.25)";
  g.fillRect(0, 80, 512, 16);
  g.fillStyle = "#fff";
  g.font = "italic 900 54px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 256, 44);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A gate across the road: two pylons and a banner. */
class GateMesh {
  readonly root = new THREE.Group();
  private pylonMat: THREE.MeshBasicMaterial;
  private bannerMat: THREE.MeshBasicMaterial;
  private left: THREE.Mesh;
  private right: THREE.Mesh;
  private top: THREE.Mesh;

  constructor(color: number, tex: THREE.Texture, opacity: number) {
    this.pylonMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, fog: false });
    this.bannerMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, fog: false });
    const pylon = new THREE.CylinderGeometry(0.28, 0.4, 7, 10, 1, true);
    pylon.translate(0, 3.5, 0);
    this.left = new THREE.Mesh(pylon, this.pylonMat);
    this.right = new THREE.Mesh(pylon, this.pylonMat);
    this.top = new THREE.Mesh(new THREE.PlaneGeometry(1, 1.4), this.bannerMat);
    this.root.add(this.left, this.right, this.top);
    this.root.visible = false;
  }

  place(g: Gate, pulse: number): void {
    this.root.visible = true;
    const w = g.hw * 2;
    const rx = -g.hz;
    const rz = g.hx;
    this.left.position.set(g.x - rx * g.hw, g.y, g.z - rz * g.hw);
    this.right.position.set(g.x + rx * g.hw, g.y, g.z + rz * g.hw);
    this.top.position.set(g.x, g.y + 6.2, g.z);
    this.top.scale.set(w, 1, 1);
    // A PlaneGeometry faces +Z; turn it to face the drivers coming towards
    // the gate (they travel along +h, so the banner must face -h).
    this.top.rotation.set(0, Math.atan2(g.hx, g.hz) + Math.PI, 0);
    const s = 1 + pulse * 0.06;
    this.left.scale.set(s, 1, s);
    this.right.scale.set(s, 1, s);
  }

  hide(): void {
    this.root.visible = false;
  }
}

export class RaceView {
  readonly group = new THREE.Group();
  private next: GateMesh;
  private after: GateMesh;
  private finish: GateMesh;
  private beacons = new Map<string, THREE.Group>();
  private cams: THREE.Group;
  private flashMat: THREE.MeshBasicMaterial;
  private flashT = 0;
  private flashPos = new THREE.Vector3();
  private flash: THREE.PointLight;

  constructor(starts: { def: RaceDef; x: number; y: number; z: number; heading: number }[], speed: { def: CameraDef; a: { x: number; z: number; tx: number; tz: number; hw: number; y: number }; b: { x: number; z: number; tx: number; tz: number; hw: number; y: number } | null }[]) {
    const ch = chequer();
    this.next = new GateMesh(0x39d0ff, banner("CHECKPOINT", "#0b84c9"), 0.85);
    this.after = new GateMesh(0x39d0ff, banner("", "#0b84c9"), 0.18);
    this.finish = new GateMesh(0xffffff, ch, 0.95);
    this.group.add(this.next.root, this.after.root, this.finish.root);

    // Race start beacons: a light column with a chequered collar.
    const colGeo = new THREE.CylinderGeometry(1.2, 1.2, 60, 16, 1, true);
    colGeo.translate(0, 30, 0);
    const colMat = new THREE.MeshBasicMaterial({ color: 0xffb000, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false });
    const ringMat = new THREE.MeshBasicMaterial({ map: ch, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false });
    for (const s of starts) {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(colGeo, colMat));
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 0.9, 24, 1, true), ringMat);
      ring.position.y = 1.2;
      g.add(ring);
      g.position.set(s.x, s.y, s.z);
      this.beacons.set(s.def.id, g);
      this.group.add(g);
    }

    // Speed cameras and trap gantries.
    this.cams = new THREE.Group();
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x5b6168, roughness: 0.5, metalness: 0.7 });
    const boxMat = new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.5 });
    this.flashMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (const e of speed) {
      if (e.def.kind === "camera") {
        const g = new THREE.Group();
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 5.5, 8), poleMat);
        pole.position.y = 2.75;
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.55, 0.9), boxMat);
        head.position.set(0, 5.6, 0);
        const lens = new THREE.Mesh(new THREE.CircleGeometry(0.16, 12), this.flashMat);
        lens.position.set(0, 5.6, -0.46);
        lens.rotation.y = Math.PI;
        g.add(pole, head, lens);
        // Roadside, facing oncoming cars.
        const rx = -e.a.tz;
        const rz = e.a.tx;
        g.position.set(e.a.x + rx * (e.a.hw + 1), e.a.y, e.a.z + rz * (e.a.hw + 1));
        g.rotation.y = Math.atan2(e.a.tx, e.a.tz);
        this.cams.add(g);
      } else {
        for (const end of [e.a, e.b!]) {
          const g = new THREE.Group();
          const span = end.hw * 2 + 2;
          for (const sd of [-1, 1]) {
            const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 7, 8), poleMat);
            leg.position.set(sd * (span / 2), 3.5, 0);
            g.add(leg);
          }
          const beam = new THREE.Mesh(new THREE.BoxGeometry(span, 0.5, 0.5), poleMat);
          beam.position.y = 7;
          const board = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(span - 2, 14), 1.6), new THREE.MeshBasicMaterial({ map: banner("SPEED TRAP", "#d9262c"), side: THREE.DoubleSide }));
          board.position.y = 6;
          g.add(beam, board);
          g.position.set(end.x, end.y, end.z);
          g.rotation.y = Math.atan2(end.tx, end.tz);
          this.cams.add(g);
        }
      }
    }
    this.group.add(this.cams);
    this.flash = new THREE.PointLight(0xffffff, 0, 40, 1.5);
    this.group.add(this.flash);
  }

  /** Shows / hides the start beacons (hidden during a race or a chase). */
  setBeacons(visible: boolean, time: number): void {
    for (const g of this.beacons.values()) {
      g.visible = visible;
      g.rotation.y = time * 0.6;
    }
  }

  /** Shows the next gate (and a ghost of the one after), or the finish. */
  setGates(route: Route | null, nextIndex: number, lastLapGates: boolean, total: number, passed: number, time: number): void {
    if (!route) {
      this.next.hide();
      this.after.hide();
      this.finish.hide();
      return;
    }
    const n = route.gates.length;
    const pulse = Math.sin(time * 6) * 0.5 + 0.5;
    const isFinish = passed === total - 1;
    const g = route.gates[nextIndex % n];
    if (isFinish) {
      this.finish.place(g, pulse);
      this.next.hide();
      this.after.hide();
      return;
    }
    this.finish.hide();
    this.next.place(g, pulse);
    if (passed + 1 < total) this.after.place(route.gates[(nextIndex + 1) % n], 0);
    else this.after.hide();
    void lastLapGates;
  }

  /** Speed camera flash. */
  flashAt(x: number, y: number, z: number): void {
    this.flashT = 0.25;
    this.flashPos.set(x, y + 5.6, z);
  }

  update(dt: number): void {
    this.flashT = Math.max(0, this.flashT - dt);
    this.flash.intensity = this.flashT > 0 ? 400 * (this.flashT / 0.25) : 0;
    this.flash.position.copy(this.flashPos);
    this.flashMat.color.setScalar(this.flashT > 0 ? 3 : 0.4);
  }
}

/** Rival race cars: built once per race with merged bodies (~25 draw calls each). */
export class RivalViews {
  readonly group = new THREE.Group();
  private visuals: CarVisual[] = [];

  setCars(defs: { def: CarDef; color: string }[]): void {
    this.clear();
    for (const d of defs) {
      const v = buildCar(d.def, d.color);
      mergeCarBody(v);
      v.root.rotation.order = "YXZ";
      v.root.traverse((o) => {
        if (o instanceof THREE.Mesh) o.castShadow = true;
      });
      this.group.add(v.root);
      this.visuals.push(v);
    }
  }

  update(cars: { x: number; y: number; z: number; heading: number; pitch: number; steer: number; spin: number; braking: boolean }[], lightsOn: boolean): void {
    cars.forEach((c, i) => {
      const v = this.visuals[i];
      if (!v) return;
      v.root.position.set(c.x, c.y, c.z);
      v.root.rotation.y = c.heading;
      v.root.rotation.x = -c.pitch;
      poseCar(v, { steer: c.steer, wheelSpin: c.spin, roll: 0, pitch: c.pitch, bodyPitch: 0, braking: c.braking, reversing: false, lightsOn });
    });
  }

  clear(): void {
    for (const v of this.visuals) {
      this.group.remove(v.root);
      v.dispose();
    }
    this.visuals = [];
  }
}
