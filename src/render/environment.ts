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
  { t: 8.5, sun: "#ffe0b8", sunI: 1.67, hemiSky: "#a9c8ec", hemiGround: "#5a5248", hemiI: 0.39, fog: "#a9c4dd", exposure: 0.85, turbidity: 2.4, rayleigh: 1.0 },
  { t: 13, sun: "#fff4e0", sunI: 1.92, hemiSky: "#a9cdf2", hemiGround: "#5e574c", hemiI: 0.41, fog: "#a6c3df", exposure: 0.8, turbidity: 2, rayleigh: 0.85 },
  { t: 17, sun: "#ffd6a0", sunI: 1.67, hemiSky: "#a8c0e0", hemiGround: "#5c5246", hemiI: 0.37, fog: "#b4bfcc", exposure: 0.85, turbidity: 2.8, rayleigh: 1.2 },
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
  private stars: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private moon: THREE.Sprite;
  private moonGlow: THREE.Sprite;
  private ranges: THREE.Mesh[] = [];
  private rangeMats: THREE.MeshBasicMaterial[] = [];
  /** Cloud cover 0..1 (raised by rain). */
  clouds = 0.35;

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

    // Stars: 2600 points with a realistic spread of brightness (lots of faint
    // ones, a few bright), slight colour (blue-white to orange), a band of
    // extra stars for the Milky Way, and gentle twinkle.
    const n = 2600;
    const pos = new Float32Array(n * 3);
    const mag = new Float32Array(n);
    const col = new Float32Array(n * 3);
    const ph = new Float32Array(n);
    let seed = 42;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const tint = [new THREE.Color("#a9c4ff"), new THREE.Color("#ffffff"), new THREE.Color("#fff1d6"), new THREE.Color("#ffcf9a")];
    for (let i = 0; i < n; i++) {
      let u = rnd() * Math.PI * 2;
      let v = Math.acos(rnd() * 0.97);
      if (i < 900) {
        // Milky Way: a tilted great-circle band.
        u = rnd() * Math.PI * 2;
        const off = (rnd() + rnd() + rnd() - 1.5) * 0.18;
        const bx = Math.cos(u);
        const by = Math.sin(u) * 0.55 + off;
        const bz = Math.sin(u) * 0.83 - off * 0.4;
        const l = Math.hypot(bx, by, bz);
        if (by / l < 0.02) {
          v = Math.acos(rnd() * 0.97);
          u = rnd() * Math.PI * 2;
        } else {
          pos.set([(bx / l) * 4000, (Math.abs(by) / l) * 4000, (bz / l) * 4000], i * 3);
          mag[i] = 0.25 + rnd() * 0.45;
          const c = tint[1];
          col.set([c.r, c.g, c.b], i * 3);
          ph[i] = rnd() * 100;
          continue;
        }
      }
      pos[i * 3] = Math.sin(v) * Math.cos(u) * 4000;
      pos[i * 3 + 1] = Math.cos(v) * 4000;
      pos[i * 3 + 2] = Math.sin(v) * Math.sin(u) * 4000;
      const r = rnd();
      mag[i] = r < 0.82 ? 0.35 + rnd() * 0.5 : r < 0.97 ? 0.9 + rnd() * 0.8 : 1.8 + rnd() * 1.2;
      const c = tint[Math.floor(rnd() * tint.length)];
      col.set([c.r, c.g, c.b], i * 3);
      ph[i] = rnd() * 100;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aMag", new THREE.BufferAttribute(mag, 1));
    g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    g.setAttribute("aPhase", new THREE.BufferAttribute(ph, 1));
    this.stars = new THREE.Points(
      g,
      new THREE.ShaderMaterial({
        uniforms: { opacity: { value: 0 }, time: { value: 0 }, pixel: { value: 1 } },
        vertexShader: /* glsl */ `
          attribute float aMag;
          attribute vec3 aColor;
          attribute float aPhase;
          uniform float time;
          uniform float pixel;
          varying vec3 vColor;
          varying float vA;
          void main() {
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * mv;
            float tw = 0.75 + 0.25 * sin(time * (1.3 + fract(aPhase) * 2.4) + aPhase);
            gl_PointSize = (1.2 + aMag * 1.6) * pixel;
            vColor = aColor;
            // Fade stars near the horizon (thicker air).
            float h = normalize(position).y;
            vA = clamp(aMag, 0.0, 1.0) * tw * smoothstep(0.0, 0.18, h);
          }`,
        fragmentShader: /* glsl */ `
          uniform float opacity;
          varying vec3 vColor;
          varying float vA;
          void main() {
            vec2 d = gl_PointCoord - 0.5;
            float f = smoothstep(0.5, 0.0, length(d));
            gl_FragColor = vec4(vColor, f * vA * opacity);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
    );
    this.stars.renderOrder = -1;
    this.stars.frustumCulled = false;
    scene.add(this.stars);

    // Moon: a cratered disc sprite with a soft halo, rising as the sun sets.
    this.moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: moonTexture(), fog: false, depthWrite: false, transparent: true, opacity: 0 }));
    this.moon.scale.setScalar(150);
    this.moon.renderOrder = -1;
    this.moonGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xbcd0ff, fog: false, depthWrite: false, transparent: true, opacity: 0, blending: THREE.AdditiveBlending }));
    this.moonGlow.scale.setScalar(900);
    this.moonGlow.renderOrder = -1;
    scene.add(this.moonGlow, this.moon);

    // Distant mountain ranges all round the horizon, in two layers. They sit
    // far outside the map and take the haze colour, so the world no longer
    // ends in empty land.
    for (let layer = 0; layer < 2; layer++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x8aa0b4, fog: false, transparent: true, opacity: 1, depthWrite: false });
      const mesh = new THREE.Mesh(rangeGeometry(layer === 0 ? 5200 : 4400, layer === 0 ? 420 : 260, layer * 977 + 11, layer === 0 ? 0.9 : 1.6), mat);
      mesh.renderOrder = -1;
      mesh.frustumCulled = false;
      this.ranges.push(mesh);
      this.rangeMats.push(mat);
      scene.add(mesh);
    }
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
    u.turbidity.value = k.turbidity + 8 * clamp((this.clouds - 0.35) / 0.6, 0, 1);
    u.rayleigh.value = k.rayleigh * (1 - 0.6 * clamp((this.clouds - 0.35) / 0.6, 0, 1));
    u.mieCoefficient.value = 0.0016;
    u.mieDirectionalG.value = 0.75;
    u.time.value = timeSeconds;
    // Clouds: fair-weather cumulus by day (thicker in the afternoon), thin at
    // night; rain (this.clouds) closes the sky in.
    const afternoon = smoothstep(10, 15, k.t) * (1 - smoothstep(18, 20, k.t));
    u.cloudCoverage.value = clamp(lerp(0.32 + 0.12 * afternoon, 0.18, this.night) + Math.max(0, this.clouds - 0.35) * 1.3, 0, 0.95);
    u.cloudDensity.value = lerp(0.45, 0.9, clamp((this.clouds - 0.35) * 2, 0, 1));
    u.cloudSpeed.value = 0.00002 + Math.max(0, this.clouds - 0.35) * 0.00004;
    const starsOn = this.night * (1 - clamp((this.clouds - 0.35) * 1.6, 0, 0.9));
    this.stars.material.uniforms.opacity.value = starsOn;
    this.stars.material.uniforms.time.value = timeSeconds;
    this.stars.material.uniforms.pixel.value = this.renderer.getPixelRatio();
    this.stars.position.copy(focus);
    this.stars.visible = starsOn > 0.01;
    // Moon: opposite the sun, low in the east at dusk, high around midnight.
    const mh = ((k.t - 18) / 13) * Math.PI; // 18:00 rise .. 07:00 set
    const md = new THREE.Vector3(-Math.cos(mh) * 0.9, Math.sin(mh) * 0.75 + 0.05, 0.42).normalize();
    this.moon.position.copy(focus).addScaledVector(md, 3600);
    this.moonGlow.position.copy(focus).addScaledVector(md, 3700);
    const moonUp = clamp(md.y * 6, 0, 1) * this.night * (1 - clamp((this.clouds - 0.35) * 1.4, 0, 0.85));
    (this.moon.material as THREE.SpriteMaterial).opacity = moonUp;
    (this.moonGlow.material as THREE.SpriteMaterial).opacity = moonUp * 0.22;
    this.moon.visible = this.moonGlow.visible = moonUp > 0.01;
    // Horizon ranges take the haze colour (the far one paler).
    for (let i = 0; i < this.ranges.length; i++) {
      this.ranges[i].position.set(focus.x, 0, focus.z);
      const fogC = new THREE.Color(k.fog);
      const shade = i === 0 ? 0.86 : 0.7;
      this.rangeMats[i].color.copy(fogC).multiplyScalar(shade).lerp(new THREE.Color(k.hemiGround), 0.18 * (i + 1));
    }

    const storm = clamp((this.clouds - 0.35) / 0.6, 0, 1);
    this.sun.color.set(k.sun);
    this.sun.intensity = k.sunI * (1 - 0.65 * storm);
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 300);
    this.sun.target.position.copy(focus);
    // Snap the shadow camera to texels to stop shimmering while driving.
    if (this.sun.castShadow) {
      const texel = 140 / this.sun.shadow.mapSize.x;
      this.sun.target.position.x = Math.round(focus.x / texel) * texel;
      this.sun.target.position.z = Math.round(focus.z / texel) * texel;
      this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, 300);
    }
    this.hemi.color.set(k.hemiSky).lerp(new THREE.Color("#8a929c"), storm * 0.6);
    this.hemi.groundColor.set(k.hemiGround);
    this.hemi.intensity = k.hemiI * (1 + 0.15 * storm);
    // Rain: grey, closer haze (spray and drizzle in the air).
    this.fog.color.set(k.fog).lerp(new THREE.Color(this.night > 0.5 ? "#1b2027" : "#9aa3ad"), storm * 0.75);
    this.fog.near = lerp(lerp(600, 180, this.night), 90, storm * 0.8);
    this.fog.far = lerp(lerp(3400, 1400, this.night), 900, storm * 0.8);
    this.renderer.toneMappingExposure = k.exposure * (1 - 0.18 * storm);

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


/** A ring of mountain silhouettes at distance `r` (m), up to `h` tall. */
function rangeGeometry(r: number, h: number, seed: number, rough: number): THREE.BufferGeometry {
  const N = 360;
  const pos: number[] = [];
  const idx: number[] = [];
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  // Sum of a few random sines around the circle = rolling peaks.
  const waves = Array.from({ length: 7 }, (_, i) => ({ f: 2 + i * 3 + Math.floor(rnd() * 3), a: (1 / (1 + i * 0.7)) * (0.6 + rnd() * 0.6), p: rnd() * Math.PI * 2 }));
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    let y = 0;
    for (const w of waves) y += Math.sin(a * w.f + w.p) * w.a;
    // Sharper ridges: fold the signal, add fine noise.
    y = Math.abs(y) * 0.6 + 0.25 + (rnd() - 0.5) * 0.08 * rough;
    const top = Math.max(0.08, y) * h;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    pos.push(x, -60, z, x, top, z);
    if (i < N) {
      const b = i * 2;
      idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

function moonTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(118, 112, 10, 128, 128, 110);
  grad.addColorStop(0, "#fbfbf4");
  grad.addColorStop(0.8, "#dcdcd2");
  grad.addColorStop(1, "#b7b9b4");
  g.fillStyle = grad;
  g.beginPath();
  g.arc(128, 128, 110, 0, Math.PI * 2);
  g.fill();
  // Maria (the dark "seas") and a few craters.
  g.fillStyle = "rgba(120,124,130,0.35)";
  for (const [x, y, r] of [[96, 98, 30], [150, 90, 22], [140, 140, 34], [92, 150, 18], [170, 160, 14]]) {
    g.beginPath();
    g.ellipse(x, y, r, r * 0.8, 0.4, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = "rgba(90,92,96,0.35)";
  for (const [x, y, r] of [[70, 120, 7], [120, 60, 6], [180, 120, 8], [115, 185, 9], [160, 200, 5]]) {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,0.9)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.25)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
