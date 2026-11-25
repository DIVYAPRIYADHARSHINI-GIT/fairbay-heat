/**
 * Driving effects: tyre smoke, skid marks, collision sparks, nitro flames and
 * speed lines. Every effect uses a fixed-size pool allocated up front, so a
 * long drift never allocates memory mid-game.
 */

import * as THREE from "three";
import { radial, smokePuff } from "./textures";

/** Billboard particles in one InstancedMesh-like Points cloud with per-particle size/alpha. */
class ParticlePool {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private size: Float32Array;
  private grow: Float32Array;
  private alpha: Float32Array;
  private color: Float32Array;
  private next = 0;
  private geo: THREE.BufferGeometry;

  constructor(
    readonly capacity: number,
    map: THREE.Texture,
    blending: THREE.Blending,
    private gravity: number,
    private drag: number,
  ) {
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity).fill(1);
    this.size = new Float32Array(capacity);
    this.grow = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.color = new Float32Array(capacity * 3).fill(1);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("aAlpha", new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("aColor", new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: map }, scale: { value: 600 } },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aAlpha;
        attribute vec3 aColor;
        uniform float scale;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * scale / max(-mv.z, 0.1);
          vAlpha = aAlpha;
          vColor = aColor;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vec4 t = texture2D(map, gl_PointCoord);
          gl_FragColor = vec4(vColor * t.rgb, t.a * vAlpha);
          if (gl_FragColor.a < 0.004) discard;
        }`,
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
  }

  setScale(viewportHeight: number, fovDeg: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.scale.value = viewportHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, grow: number, r = 1, g = 1, b = 1): void {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.grow[i] = grow;
    this.color[i * 3] = r;
    this.color[i * 3 + 1] = g;
    this.color[i * 3 + 2] = b;
  }

  update(dt: number, peakAlpha: number): void {
    const k = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.gravity * dt;
      this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] += this.grow[i] * dt;
      const t = this.life[i] / this.maxLife[i];
      // Fade in quickly, fade out slowly.
      this.alpha[i] = peakAlpha * Math.min(1, (1 - t) * 6) * t;
    }
    for (const name of ["position", "aSize", "aAlpha", "aColor"]) this.geo.getAttribute(name).needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    this.alpha.fill(0);
  }
}

/** Ring buffer of quads laid on the road behind each rear tyre. */
class SkidMarks {
  readonly mesh: THREE.Mesh;
  private pos: Float32Array;
  private alpha: Float32Array;
  private next = 0;
  private last: (THREE.Vector3 | null)[] = [];
  private geo: THREE.BufferGeometry;

  constructor(private capacity: number) {
    this.pos = new Float32Array(capacity * 4 * 3);
    this.alpha = new Float32Array(capacity * 4);
    const idx = new Uint32Array(capacity * 6);
    for (let i = 0; i < capacity; i++) {
      const b = i * 4;
      idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("aAlpha", new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        varying float vA;
        #include <common>
        #include <fog_pars_vertex>
        void main() {
          vA = aAlpha;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        varying float vA;
        #include <common>
        #include <fog_pars_fragment>
        void main() {
          gl_FragColor = vec4(0.03, 0.03, 0.03, vA);
          #include <fog_fragment>
        }`,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
      fog: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /** Extends the mark of tyre `i` to `p`. Pass strength 0 to lift the tyre. */
  add(i: number, p: THREE.Vector3, dirX: number, dirZ: number, strength: number, width = 0.26): void {
    const prev = this.last[i];
    if (strength <= 0.02) {
      this.last[i] = null;
      return;
    }
    if (!prev) {
      this.last[i] = p.clone();
      return;
    }
    const dx = p.x - prev.x;
    const dz = p.z - prev.z;
    if (dx * dx + dz * dz < 0.25) return; // segment every 0.5 m
    const len = Math.hypot(dx, dz) || 1;
    // Perpendicular to the segment (fallback to car direction).
    const nx = len > 0.01 ? -dz / len : -dirZ;
    const nz = len > 0.01 ? dx / len : dirX;
    const w = width / 2;
    const q = this.next;
    this.next = (this.next + 1) % this.capacity;
    const y0 = prev.y + 0.02;
    const y1 = p.y + 0.02;
    const v = [
      prev.x - nx * w, y0, prev.z - nz * w,
      prev.x + nx * w, y0, prev.z + nz * w,
      p.x + nx * w, y1, p.z + nz * w,
      p.x - nx * w, y1, p.z - nz * w,
    ];
    this.pos.set(v, q * 12);
    const a = Math.min(0.6, strength * 0.6);
    this.alpha.set([a, a, a, a], q * 4);
    prev.copy(p);
    this.geo.getAttribute("position").needsUpdate = true;
    this.geo.getAttribute("aAlpha").needsUpdate = true;
  }

  clear(): void {
    this.alpha.fill(0);
    this.last = [];
    this.geo.getAttribute("aAlpha").needsUpdate = true;
  }
}

export class Effects {
  readonly group = new THREE.Group();
  readonly smoke: ParticlePool;
  readonly sparks: ParticlePool;
  readonly flames: ParticlePool;
  readonly dust: ParticlePool;
  readonly skids: SkidMarks;
  readonly speedLines: THREE.LineSegments;
  private speedLinePos: Float32Array;
  private speedLineSeed: Float32Array;

  constructor() {
    this.smoke = new ParticlePool(700, smokePuff(), THREE.NormalBlending, -0.4, 1.2);
    this.dust = new ParticlePool(300, smokePuff(), THREE.NormalBlending, -0.2, 1.5);
    this.sparks = new ParticlePool(300, radial("rgba(255,240,200,1)", "rgba(255,140,30,0)", 32), THREE.AdditiveBlending, 9.8, 0.6);
    this.flames = new ParticlePool(200, radial("rgba(170,220,255,1)", "rgba(40,90,255,0)", 64), THREE.AdditiveBlending, 0, 3);
    this.skids = new SkidMarks(2400);
    this.group.add(this.skids.mesh, this.smoke.points, this.dust.points, this.sparks.points, this.flames.points);

    // Speed lines: streaks in a tube around the camera, drawn in camera space.
    const n = 70;
    this.speedLinePos = new Float32Array(n * 6);
    this.speedLineSeed = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 2.2 + Math.random() * 3;
      this.speedLineSeed.set([Math.cos(a) * r, Math.sin(a) * r * 0.65, Math.random()], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.speedLinePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.speedLines = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
    );
    this.speedLines.frustumCulled = false;
    this.speedLines.renderOrder = 10;
  }

  setViewport(h: number, fov: number): void {
    for (const p of [this.smoke, this.sparks, this.flames, this.dust]) p.setScale(h, fov);
  }

  update(dt: number, time: number, speedFrac: number, camera: THREE.PerspectiveCamera): void {
    this.smoke.update(dt, 0.55);
    this.dust.update(dt, 0.45);
    this.sparks.update(dt, 1);
    this.flames.update(dt, 1);
    // Speed lines live in camera space so they always streak towards the viewer.
    const strength = Math.max(0, (speedFrac - 0.55) / 0.45);
    const mat = this.speedLines.material as THREE.LineBasicMaterial;
    mat.opacity = strength * 0.35;
    this.speedLines.visible = strength > 0.01;
    if (this.speedLines.visible) {
      const n = this.speedLineSeed.length / 3;
      for (let i = 0; i < n; i++) {
        const sx = this.speedLineSeed[i * 3];
        const sy = this.speedLineSeed[i * 3 + 1];
        const ph = (this.speedLineSeed[i * 3 + 2] + time * (1.4 + strength * 2.5)) % 1;
        const z = -2 - ph * 30;
        const len = 2 + strength * 5;
        this.speedLinePos.set([sx, sy, z, sx, sy, z + len], i * 6);
      }
      this.speedLines.geometry.getAttribute("position").needsUpdate = true;
      this.speedLines.position.copy(camera.position);
      this.speedLines.quaternion.copy(camera.quaternion);
    }
  }

  clear(): void {
    this.smoke.clear();
    this.sparks.clear();
    this.flames.clear();
    this.dust.clear();
    this.skids.clear();
  }
}
