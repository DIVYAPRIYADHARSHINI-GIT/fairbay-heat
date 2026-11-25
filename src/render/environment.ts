/**
 * Sky, sun, fog, image-based lighting and the day/night cycle.
 *
 * `timeOfDay` is hours (0-24). The sun follows a simple arc; colours for sun,
 * ambient, fog and exposure are interpolated from keyframes. Reflections come
 * from a PMREM environment map re-captured from the sky dome only when the
 * time of day has moved enough to matter (it is expensive).
 */

import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { clamp, lerp, smoothstep } from "../core/math";

interface Key {
  t: number;
  sun: string;
  sunI: number;
  hemiSky: string;
  hemiGround: string;
  hemiI: number;
  fog: string;
  exposure: number;
  turbidity: number;
  rayleigh: number;
}

// Keyframes over 24 h (wraps).
const KEYS: Key[] = [
  { t: 0, sun: "#8fa6e0", sunI: 0.55, hemiSky: "#4a5c92", hemiGround: "#262c3a", hemiI: 0.85, fog: "#121a2e", exposure: 1.0, turbidity: 2, rayleigh: 0.2 },
  { t: 5.2, sun: "#8fa6e0", sunI: 0.5, hemiSky: "#4d5a8a", hemiGround: "#262a36", hemiI: 0.8, fog: "#1c2236", exposure: 0.9, turbidity: 2, rayleigh: 0.3 },
  { t: 6.4, sun: "#ff9a5a", sunI: 0.99, hemiSky: "#c48a7a", hemiGround: "#3a2e2a", hemiI: 0.29, fog: "#d79a7e", exposure: 0.95, turbidity: 6, rayleigh: 2.6 },
  { t: 8.5, sun: "#ffe0b8", sunI: 1.67, hemiSky: "#a9c8ec", hemiGround: "#5a5248", hemiI: 0.39, fog: "#b8cde0", exposure: 0.85, turbidity: 3.5, rayleigh: 1.4 },
  { t: 13, sun: "#fff4e0", sunI: 1.92, hemiSky: "#a9cdf2", hemiGround: "#5e574c", hemiI: 0.41, fog: "#b9d1e6", exposure: 0.8, turbidity: 3, rayleigh: 1.1 },
  { t: 17, sun: "#ffd6a0", sunI: 1.67, hemiSky: "#a8c0e0", hemiGround: "#5c5246", hemiI: 0.37, fog: "#c8c8cc", exposure: 0.85, turbidity: 4.5, rayleigh: 1.6 },
  { t: 18.9, sun: "#ff7a3a", sunI: 1.05, hemiSky: "#b77a78", hemiGround: "#3a2a28", hemiI: 0.29, fog: "#d98b6a", exposure: 0.95, turbidity: 8, rayleigh: 3 },
  { t: 20.1, sun: "#8f86d0", sunI: 0.5, hemiSky: "#525487", hemiGround: "#262430", hemiI: 0.8, fog: "#2a2840", exposure: 0.95, turbidity: 2, rayleigh: 0.6 },
  { t: 24, sun: "#8fa6e0", sunI: 0.55, hemiSky: "#4a5c92", hemiGround: "#262c3a", hemiI: 0.85, fog: "#121a2e", exposure: 1.0, turbidity: 2, rayleigh: 0.2 },
];

function sample(t: number): Key {
  const h = ((t % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].t <= h) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const f = clamp((h - a.t) / (b.t - a.t), 0, 1);
  const c = (x: string, y: string) => "#" + new THREE.Color(x).lerp(new THREE.Color(y), f).getHexString();
  return {
    t: h,
    sun: c(a.sun, b.sun),
    sunI: lerp(a.sunI, b.sunI, f),
    hemiSky: c(a.hemiSky, b.hemiSky),
    hemiGround: c(a.hemiGround, b.hemiGround),
    hemiI: lerp(a.hemiI, b.hemiI, f),
    fog: c(a.fog, b.fog),
    exposure: lerp(a.exposure, b.exposure, f),
    turbidity: lerp(a.turbidity, b.turbidity, f),
    rayleigh: lerp(a.rayleigh, b.rayleigh, f),
  };
}

/** 0 at full day, 1 at full night. */
export function nightFactor(hours: number): number {
  const h = ((hours % 24) + 24) % 24;
  if (h < 12) return 1 - smoothstep(5.6, 7.2, h);
  return smoothstep(18.6, 20.2, h);
}

/** Unit vector towards the sun (or the moon at night). */
export function sunDirection(hours: number, out = new THREE.Vector3()): THREE.Vector3 {
  const h = ((hours % 24) + 24) % 24;
  // Sun rises in the east (-X... we put it at +X east) at 6, sets at 19.
  const day = (h - 6) / 13; // 0..1 across daylight
  if (day >= 0 && day <= 1) {
    const a = day * Math.PI;
    out.set(Math.cos(a), Math.sin(a) * 0.9 + 0.02, -0.45).normalize();
  } else {
    // Moon: a fixed high-ish light from the west so night still has shape.
    out.set(-0.5, 0.75, 0.35).normalize();
  }
  return out;
}

export class Environment {
  readonly sky: Sky;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly fog: THREE.Fog;
  hours = 17.2;
  /** Real seconds per in-game hour; 0 freezes time. */
  speed = 60;
  night = 0;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envScene = new THREE.Scene();
  private envSky: Sky;
  private lastEnvHours = -99;
  private sunDir = new THREE.Vector3();
  private stars: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;

  constructor(
    private scene: THREE.Scene,
    private renderer: THREE.WebGLRenderer,
    shadowSize: number,
  ) {
    this.sky = new Sky();
    this.sky.scale.setScalar(9000);
    this.sky.material.uniforms.cloudCoverage.value = 0.35;
    this.sky.material.uniforms.cloudDensity.value = 0.45;
    this.sky.material.uniforms.cloudScale.value = 0.00022;
    scene.add(this.sky);

    this.envSky = new Sky();
    this.envSky.scale.setScalar(1000);
    this.envScene.add(this.envSky);
    this.pmrem = new THREE.PMREMGenerator(renderer);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = shadowSize > 0;
    if (shadowSize > 0) {
      this.sun.shadow.mapSize.set(shadowSize, shadowSize);
      const s = 70;
      const cam = this.sun.shadow.camera;
      cam.left = -s;
      cam.right = s;
      cam.top = s;
      cam.bottom = -s;
      cam.near = 1;
      cam.far = 600;
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.6;
    }
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xa9cdf2, 0x5e574c, 1);
    scene.add(this.hemi);

    this.fog = new THREE.Fog(0xb9d1e6, 250, 1500);
    scene.fog = this.fog;

    // Stars.
    const n = 1500;
    const pos = new Float32Array(n * 3);
    let seed = 42;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const u = rnd() * Math.PI * 2;
      const v = Math.acos(rnd() * 0.95);
      pos[i * 3] = Math.sin(v) * Math.cos(u) * 4000;
      pos[i * 3 + 1] = Math.cos(v) * 4000;
      pos[i * 3 + 2] = Math.sin(v) * Math.sin(u) * 4000;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
    this.stars.renderOrder = -1;
    scene.add(this.stars);
  }

  /** Follows the focus point so shadows stay crisp around the player. */
  update(dt: number, focus: THREE.Vector3, timeSeconds: number): void {
    if (this.speed > 0) this.hours = (this.hours + dt / this.speed) % 24;
    const k = sample(this.hours);
    this.night = nightFactor(this.hours);
    sunDirection(this.hours, this.sunDir);

    const trueSun = this.night < 0.99 ? this.sunDir : this.sunDir;
    const u = this.sky.material.uniforms;
    const elev = new THREE.Vector3();
    if (this.night > 0.5) elev.set(this.sunDir.x, -0.2, this.sunDir.z).normalize();
    else elev.copy(trueSun);
    u.sunPosition.value.copy(elev);
    u.turbidity.value = k.turbidity;
    u.rayleigh.value = k.rayleigh;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.85;
    u.time.value = timeSeconds;
    u.cloudCoverage.value = lerp(0.35, 0.2, this.night);
    this.stars.material.opacity = this.night;
    this.stars.position.copy(focus);

    this.sun.color.set(k.sun);
    this.sun.intensity = k.sunI;
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 300);
    this.sun.target.position.copy(focus);
    // Snap the shadow camera to texels to stop shimmering while driving.
    if (this.sun.castShadow) {
      const texel = 140 / this.sun.shadow.mapSize.x;
      this.sun.target.position.x = Math.round(focus.x / texel) * texel;
      this.sun.target.position.z = Math.round(focus.z / texel) * texel;
      this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, 300);
    }
    this.hemi.color.set(k.hemiSky);
    this.hemi.groundColor.set(k.hemiGround);
    this.hemi.intensity = k.hemiI;
    this.fog.color.set(k.fog);
    this.fog.near = lerp(380, 160, this.night);
    this.fog.far = lerp(2600, 1300, this.night);
    this.renderer.toneMappingExposure = k.exposure;

    if (Math.abs(this.hours - this.lastEnvHours) > 0.25 || this.envRT === null) {
      this.refreshEnv(elev, k);
    }
  }

  private refreshEnv(sunPos: THREE.Vector3, k: Key): void {
    this.lastEnvHours = this.hours;
    const u = this.envSky.material.uniforms;
    u.sunPosition.value.copy(sunPos);
    u.turbidity.value = k.turbidity;
    u.rayleigh.value = k.rayleigh;
    u.cloudCoverage.value = 0;
    u.showSunDisc.value = false;
    const old = this.envRT;
    this.envRT = this.pmrem.fromScene(this.envScene, 0, 0.1, 2000);
    this.scene.environment = this.envRT.texture;
    // At night, darken reflections so cars do not glow.
    this.scene.environmentIntensity = lerp(0.42, 0.18, this.night);
    old?.dispose();
  }

  setHours(h: number): void {
    this.hours = ((h % 24) + 24) % 24;
    this.lastEnvHours = -99;
  }
}
