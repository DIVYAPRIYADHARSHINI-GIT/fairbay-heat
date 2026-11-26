/**
 * Third-person chase camera (Most Wanted style), a far chase and a bumper cam.
 *
 * The chase camera trails the car's heading with lag (so drifts show the car
 * side-on), pulls back and widens its field of view with speed, punches in on
 * nitro, shakes on impacts, and is pulled in front of any building it would
 * otherwise clip into.
 */

import * as THREE from "three";
import { clamp, damp, dampAngle } from "../core/math";
import type { CarPhysics } from "../game/physics";
import { collide, type SpatialHash, type Collider } from "../game/collision";

export const CAMERA_MODES = ["Chase", "Far chase", "Bumper"] as const;

export class CameraRig {
  mode = 0;
  private yaw = 0;
  private fov = 62;
  private shake = 0;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private initialised = false;
  private scratch: Collider[] = [];

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  cycle(): string {
    this.mode = (this.mode + 1) % CAMERA_MODES.length;
    this.initialised = false;
    return CAMERA_MODES[this.mode];
  }

  bump(strength: number): void {
    this.shake = Math.min(1.2, this.shake + strength);
  }

  snap(): void {
    this.initialised = false;
  }

  update(dt: number, car: CarPhysics, rx: number, ry: number, rz: number, heading: number, colliders: SpatialHash, time: number): void {
    const speed = car.speed;
    const speedFrac = clamp(speed / 80, 0, 1);
    const cam = this.camera;

    if (!this.initialised) {
      this.yaw = heading;
      this.fov = 62;
    }
    // Trail the heading; when reversing, keep looking forward.
    const lag = this.mode === 2 ? 30 : car.drifting ? 3.2 : 6;
    this.yaw = dampAngle(this.yaw, heading, lag, dt);
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);

    let targetFov: number;
    if (this.mode === 2) {
      // Bumper cam: on the front bumper, ahead of the bodywork, so the road
      // rushes at you with nothing in the way.
      const hf = Math.sin(heading);
      const hz = Math.cos(heading);
      const nose = car.def.body.length / 2 + 0.15;
      const y = ry + car.def.body.noseHeight + 0.12;
      this.pos.set(rx + hf * nose, y, rz + hz * nose);
      this.look.set(rx + hf * (nose + 30), y - 0.4, rz + hz * (nose + 30));
      targetFov = 70 + speedFrac * 14;
    } else {
      const far = this.mode === 1;
      const dist = (far ? 9.5 : 6.2) + speedFrac * (far ? 2.5 : 1.6) + car.def.body.length * 0.25;
      const height = (far ? 3.4 : 2.05) + speedFrac * 0.15;
      const want = new THREE.Vector3(rx - fx * dist, ry + height, rz - fz * dist);
      // Keep the camera out of buildings: march from the car towards it.
      const pulled = this.unclip(rx, ry, rz, want, colliders);
      if (!this.initialised) this.pos.copy(pulled);
      const k = 1 - Math.exp(-14 * dt);
      this.pos.lerp(pulled, k);
      // Never sink below the ground near the car.
      this.pos.y = Math.max(this.pos.y, ry + 0.8);
      this.look.set(rx + fx * 2.5, ry + 1.0, rz + fz * 2.5);
      targetFov = 62 + speedFrac * 16;
    }
    if (car.nitroActive) targetFov += 8;
    this.fov = damp(this.fov, targetFov, 4, dt);

    // Shake: speed rumble + impact decay.
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const rumble = speedFrac > 0.6 ? (speedFrac - 0.6) * 0.06 : 0;
    const s = this.shake * 0.25 + rumble + (car.nitroActive ? 0.025 : 0);
    const sx = (Math.sin(time * 47.3) + Math.sin(time * 31.1)) * s;
    const sy = (Math.sin(time * 53.7) + Math.cos(time * 27.9)) * s;

    cam.position.copy(this.pos);
    cam.position.x += sx;
    cam.position.y += sy;
    cam.lookAt(this.look);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
    this.initialised = true;
  }

  private unclip(rx: number, ry: number, rz: number, want: THREE.Vector3, colliders: SpatialHash): THREE.Vector3 {
    const steps = 12;
    const near = colliders.query((rx + want.x) / 2, (rz + want.z) / 2, 14, this.scratch);
    if (near.length === 0) return want;
    let ok = 1;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = rx + (want.x - rx) * t;
      const z = rz + (want.z - rz) * t;
      const y = ry + (want.y - ry) * t;
      let blocked = false;
      for (const c of near) {
        // Only obstacles at the camera's height block it: not low kerbs it
        // looks over, and not a bridge's parapets passing OVER it (they
        // start well above the camera when driving under a viaduct).
        if (c.kind === "circle" || c.base + c.top < y || c.base > y + 0.5 || c.top > 900) continue;
        if (collide(x, z, 0.4, c)) {
          blocked = true;
          break;
        }
      }
      if (blocked) break;
      ok = t;
    }
    if (ok >= 1) return want;
    const t = Math.max(0.25, ok - 0.05);
    return new THREE.Vector3(rx + (want.x - rx) * t, ry + (want.y - ry) * t + (1 - t) * 1.2, rz + (want.z - rz) * t);
  }
}
