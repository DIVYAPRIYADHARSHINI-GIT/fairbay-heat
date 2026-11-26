/**
 * Rain.
 *
 *  - Weather state: `rain` 0..1 eases towards a target. In "auto" mode the
 *    target changes by itself every few in-game hours (mostly dry spells,
 *    sometimes a shower or a downpour); Settings can force it on or off.
 *    Road wetness follows the rain more slowly (roads stay wet for a while
 *    after the rain stops) and is what the car physics uses for grip.
 *  - Streaks: one LineSegments cloud of 3,000 drops in a box that moves
 *    with the camera; each drop falls in the vertex shader (no per-frame
 *    CPU work), slanted by wind and stretched by the car's speed so it
 *    streaks towards you when you drive fast.
 *  - Splashes: small rings popping up on the road around the car.
 *  - Wet look: road / pavement materials get darker and much glossier as
 *    the wetness rises (set by the world view through `wetness`).
 */

import * as THREE from "three";
import { clamp, damp, mulberry32 } from "../core/math";

export type RainMode = "auto" | "off" | "on";

const DROPS = 3000;
const BOX = 46; // m, half size of the rain box around the camera

export class Weather {
  readonly group = new THREE.Group();
  /** Current rain intensity 0..1. */
  rain = 0;
  /** Road wetness 0..1 (lags the rain). */
  wetness = 0;
  mode: RainMode = "auto";
  private target = 0;
  /** In-game hours until the weather may change (the first spell is always dry). */
  private nextChange = 2.5;
  private rng = mulberry32(2026);
  private lines: THREE.LineSegments;
  private mat: THREE.ShaderMaterial;
  private splashes: THREE.InstancedMesh;
  private splashLife: Float32Array;
  private splashPos: Float32Array;
  private m = new THREE.Matrix4();
  private nextSplash = 0;

  constructor() {
    // Each drop is a line segment; both ends share a seed and the vertex
    // shader moves them (end 0 = head, end 1 = tail).
    const pos = new Float32Array(DROPS * 2 * 3);
    const seed = new Float32Array(DROPS * 2 * 4);
    const r = mulberry32(7);
    for (let i = 0; i < DROPS; i++) {
      const x = (r() * 2 - 1) * BOX;
      const z = (r() * 2 - 1) * BOX;
      const y0 = r();
      const sp = 0.8 + r() * 0.4;
      for (let e = 0; e < 2; e++) {
        pos.set([x, 0, z], (i * 2 + e) * 3);
        seed.set([y0, sp, e, r()], (i * 2 + e) * 4);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 4));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        center: { value: new THREE.Vector3() },
        wind: { value: new THREE.Vector2(1.5, 0.6) },
        stretch: { value: new THREE.Vector3() },
        intensity: { value: 0 },
        color: { value: new THREE.Color(0xc8d4e2) },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed;
        uniform float time;
        uniform vec3 center;
        uniform vec2 wind;
        uniform vec3 stretch;
        uniform float intensity;
        varying float vA;
        void main() {
          // Wrap the drop's x/z into the box around the camera.
          vec3 p = position;
          p.xz = mod(p.xz - center.xz + ${BOX.toFixed(1)}, ${(BOX * 2).toFixed(1)}) - ${BOX.toFixed(1)} + center.xz;
          // Fall 9 m/s * speed seed through a 30 m column, looping.
          float h = fract(aSeed.x - time * 0.3 * aSeed.y);
          p.y = center.y - 6.0 + h * 30.0;
          p.xz += wind * (h - 0.5) * 2.0;
          // The tail end trails behind the fall + the car's motion (streaks).
          float tail = aSeed.z;
          p += tail * (vec3(-wind.x * 0.06, 1.1, -wind.y * 0.06) + stretch);
          // Only some drops show at light rain.
          vA = step(aSeed.w, intensity) * (0.35 + 0.45 * intensity) * smoothstep(0.0, 0.08, h) * (1.0 - tail * 0.5);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 color;
        varying float vA;
        void main() {
          if (vA < 0.01) discard;
          gl_FragColor = vec4(color, vA);
        }`,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.lines = new THREE.LineSegments(g, this.mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 5;
    this.group.add(this.lines);

    // Splash rings on the ground.
    const ring = new THREE.RingGeometry(0.06, 0.1, 10);
    ring.rotateX(-Math.PI / 2);
    this.splashes = new THREE.InstancedMesh(ring, new THREE.MeshBasicMaterial({ color: 0xdfe8f2, transparent: true, opacity: 0.5, depthWrite: false }), 220);
    this.splashes.frustumCulled = false;
    this.splashes.count = 0;
    this.splashLife = new Float32Array(220);
    this.splashPos = new Float32Array(220 * 3);
    this.group.add(this.splashes);
  }

  /** Forces a rain level instantly (tests, Settings). */
  set(level: number): void {
    this.rain = this.target = clamp(level, 0, 1);
    this.wetness = this.rain;
  }

  /**
   * @param dt        real seconds
   * @param gameHours in-game hours passed this frame (auto weather changes with game time)
   * @param cam       camera (rain box follows it)
   * @param carVel    player velocity (streak stretch)
   * @param ground    ground height for splashes
   */
  update(dt: number, gameHours: number, cam: THREE.Camera, carVel: THREE.Vector3, time: number, ground: (x: number, z: number) => number): void {
    if (this.mode === "off") this.target = 0;
    else if (this.mode === "on") this.target = Math.max(this.target, 0.85);
    else {
      this.nextChange -= gameHours;
      if (this.nextChange <= 0) {
        const r = this.rng();
        // ~65% dry, 22% shower, 13% downpour.
        this.target = r < 0.65 ? 0 : r < 0.87 ? 0.4 + this.rng() * 0.25 : 0.8 + this.rng() * 0.2;
        this.nextChange = 2 + this.rng() * 4; // in-game hours
      }
    }
    this.rain = damp(this.rain, this.target, 0.35, dt);
    if (Math.abs(this.rain - this.target) < 0.002) this.rain = this.target;
    // Roads wet up quickly, dry slowly.
    this.wetness = damp(this.wetness, this.rain > 0.05 ? Math.min(1, this.rain * 1.4) : 0, this.rain > this.wetness ? 0.6 : 0.05, dt);
    const on = this.rain > 0.02;
    this.lines.visible = on;
    const u = this.mat.uniforms;
    u.time.value = time;
    u.intensity.value = this.rain;
    (u.center.value as THREE.Vector3).copy(cam.position);
    // Streaks stretch against the car's motion (you drive into the rain).
    (u.stretch.value as THREE.Vector3).set(-carVel.x * 0.035, 0, -carVel.z * 0.035);
    // Splashes around the camera's ground point.
    if (on) {
      const n = Math.floor(this.rain * 180 * dt * 6);
      for (let k = 0; k < n; k++) {
        const i = this.nextSplash;
        this.nextSplash = (this.nextSplash + 1) % 220;
        const a = this.rng() * Math.PI * 2;
        const d = 2 + this.rng() * 22;
        const x = cam.position.x + Math.cos(a) * d;
        const z = cam.position.z + Math.sin(a) * d;
        this.splashPos.set([x, ground(x, z) + 0.03, z], i * 3);
        this.splashLife[i] = 0.35;
      }
    }
    let live = 0;
    for (let i = 0; i < 220; i++) {
      if (this.splashLife[i] <= 0) continue;
      this.splashLife[i] -= dt;
      const t = 1 - this.splashLife[i] / 0.35;
      const sc = 0.5 + t * 2.2;
      this.m.makeScale(sc, 1, sc).setPosition(this.splashPos[i * 3], this.splashPos[i * 3 + 1], this.splashPos[i * 3 + 2]);
      this.splashes.setMatrixAt(live++, this.m);
    }
    this.splashes.count = live;
    this.splashes.instanceMatrix.needsUpdate = true;
    this.splashes.visible = live > 0;
  }
}
