/**
 * The game: owns the renderer, scene, player car, parked cars, menus and the
 * main loop. The simulation runs at a fixed 120 Hz, decoupled from the
 * display rate, and the rendered car is interpolated between the last two
 * physics states so motion is smooth at 30, 60 or 144 fps alike.
 */

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

import { Input } from "../core/input";
import { clamp, damp, lerp, wrapAngle } from "../core/math";
import { CARS, carById, ratings, type CarDef } from "./cars";
import { World, DISTRICT_NAMES, type District } from "./world";
import { Traffic, TRAFFIC_MODELS, POLICE_MODEL } from "./traffic";
import { Police, POLICE_CARS, type PlayerView } from "./police";
import { HeatSystem, type HeatEvent, type Offence } from "./heat";
import { CarPhysics, NO_CONTROLS, type Controls } from "./physics";
import { JACK_SPOTS, JACK_SPOT_DEFS, jackable, setJackSpots, type JackSpot } from "./jack";
import { DriftScore, JumpTracker, MIN_JUMP } from "./scoring";
import { defaults, loadSave, writeSave, type Quality, type SaveData } from "./save";
import { collide, type CircleCollider, type Collider } from "./collision";
import { buildCar, poseCar, type CarVisual } from "../render/carModel";
import { buildWorldView, type WorldView } from "../render/worldMesh";
import { TrafficView } from "../render/trafficView";
import { PoliceView } from "../render/policeView";
import { Environment } from "../render/environment";
import { Effects } from "../render/effects";
import { CameraRig, CAMERA_MODES } from "../render/cameraRig";
import { GameAudio } from "../audio/audio";
import { Hud, el } from "../ui/hud";
import { MenuScreen, controlsTable } from "../ui/menus";

export const STEP = 1 / 120;

/** Headlight beam intensity (candela-ish, three.js units) and the most light
 *  a wall straight ahead may receive from both beams before it would
 *  white out (bright facades reflect ~half of it, ACES whites start ~1.0). */
const BEAM = 60;
const BEAM_ON_WALL = 4.5;

type State = "loading" | "title" | "drive" | "paused" | "garage" | "map" | "help" | "settings";

interface ParkedCar {
  spot: JackSpot;
  visual: CarVisual;
  colliders: CircleCollider[];
}

const QUALITY: Record<Quality, { pixelRatio: number; shadow: number; bloom: boolean; aa: boolean }> = {
  high: { pixelRatio: 2, shadow: 2048, bloom: true, aa: true },
  medium: { pixelRatio: 1.25, shadow: 1024, bloom: true, aa: true },
  low: { pixelRatio: 1, shadow: 0, bloom: false, aa: false },
};

const TIME_SPEEDS: [string, number][] = [
  ["Frozen", 0],
  ["Slow (48 min day)", 120],
  ["Normal (24 min day)", 60],
  ["Fast (6 min day)", 15],
];

export class Game {
  state: State = "loading";
  readonly save: SaveData;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.3, 9000);
  readonly city: World;
  readonly traffic: Traffic;
  readonly police: Police;
  readonly heat = new HeatSystem();
  readonly input: Input;
  readonly audio = new GameAudio();
  readonly rig: CameraRig;
  car!: CarPhysics;
  carVisual!: CarVisual;
  hud!: Hud;
  env!: Environment;
  cityView!: WorldView;
  trafficView!: TrafficView;
  policeView!: PoliceView;
  effects!: Effects;
  parked: ParkedCar[] = [];
  /** Jack spot whose car the player is currently driving (hidden from the street). */
  hiddenSpot: string | null = null;
  simTime = 0;
  frames = 0;
  private composer!: EffectComposer;
  private bloom!: UnrealBloomPass;
  private acc = 0;
  private last = 0;
  private prev = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
  private renderPos = new THREE.Vector3();
  private renderHeading = 0;
  private headlight!: THREE.SpotLight;
  private headlight2!: THREE.SpotLight;
  private drift = new DriftScore();
  private jump = new JumpTracker();
  private district = "";
  private fpsSmoothed = 60;
  private saveTimer = 0;
  private menus: Record<string, MenuScreen> = {};
  private overlay!: HTMLDivElement;
  private titleEl!: HTMLDivElement;
  private mapEl!: HTMLDivElement;
  private mapCanvas!: HTMLCanvasElement;
  private helpEl!: HTMLDivElement;
  private garageInfo!: HTMLDivElement;
  private garageCar = "";
  private garageColor = 0;
  private resetConfirm = false;
  private roll = 0;
  private bodyPitch = 0;
  private titleAngle = 0;
  private distanceM = 0;
  private stuckTime = 0;
  private lastImpactSound = 0;
  /** Headlight auto-dim factor (0..1) for walls / cars close ahead. */
  beamDim = 1;
  private beamScratch: Collider[] = [];
  trafficHits = 0;
  /** Police log for the tests: every heat event so far. */
  readonly heatLog: HeatEvent[] = [];
  private resultTimer = 0;
  /** Exposed for tests. */
  readonly trafficModels = TRAFFIC_MODELS;
  readonly policeDefs = POLICE_CARS;
  readonly policeModel = POLICE_MODEL;
  readonly errors: string[] = [];

  constructor(private container: HTMLElement) {
    this.save = loadSave();
    const q = QUALITY[this.save.quality];
    this.renderer = new THREE.WebGLRenderer({ antialias: q.aa, powerPreference: "high-performance", stencil: false });
    this.renderer.info.autoReset = false;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = "game-canvas";
    this.renderer.domElement.setAttribute("aria-label", "Fairbay Heat - 3D driving game");
    container.appendChild(this.renderer.domElement);
    this.city = new World({ jackSpots: JACK_SPOT_DEFS });
    setJackSpots(this.city.jackSpots);
    this.traffic = new Traffic(this.city.net, 77, this.city.ground);
    this.police = new Police(this.city.net, this.city.world, this.city.colliders, this.traffic);
    this.police.enabled = this.save.police;
    this.heat.totalBounty = this.save.bounty;
    this.heat.escapes = this.save.escapes;
    this.heat.busts = this.save.busts;
    this.input = new Input(window);
    this.rig = new CameraRig(this.camera);
    this.rig.mode = this.save.camera;
  }

  // ===========================================================================
  // Loading
  // ===========================================================================

  async load(progress: (f: number, label: string) => void): Promise<void> {
    const tick = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const q = QUALITY[this.save.quality];
    progress(0.1, "Paving the streets");
    await tick();
    this.env = new Environment(this.scene, this.renderer, q.shadow);
    this.env.setHours(this.save.hours);
    this.env.speed = this.save.timeSpeed;
    progress(0.25, "Raising Fairbay");
    await tick();
    this.cityView = buildWorldView(this.city, Math.min(8, this.renderer.capabilities.getMaxAnisotropy()));
    this.scene.add(this.cityView.group);
    progress(0.6, "Parking the cars");
    await tick();
    this.trafficView = new TrafficView();
    this.scene.add(this.trafficView.group);
    progress(0.7, "Calling the Fairbay PD");
    await tick();
    this.policeView = new PoliceView();
    this.scene.add(this.policeView.group);
    this.effects = new Effects();
    this.scene.add(this.effects.group, this.effects.speedLines);
    for (const spot of JACK_SPOTS) this.addParked(spot);
    // Two dipped-beam headlights. Real-world inverse-square falloff (decay 2)
    // makes anything a few metres ahead ~100x brighter than the road at
    // 40 m, so we use a gentle decay over a limited range and aim the beams
    // down at the road - surfaces right in front get lit, never blown out.
    // (A wall straight ahead is also auto-dimmed: see `beamDim`.)
    const mkBeam = () => {
      const l = new THREE.SpotLight(0xfff1dc, 0, 70, 0.42, 0.65, 0.9);
      l.castShadow = false;
      this.scene.add(l, l.target);
      return l;
    };
    this.headlight = mkBeam();
    this.headlight2 = mkBeam();
    this.spawnPlayer(this.save.carId, this.save.colorIndex);
    if (this.save.pos) {
      const p = this.save.pos;
      const safe = this.city.nearestRoadPoint(p.x, p.z);
      // Resume where the player parked, but only if it is still a free spot.
      const free = this.city.colliders.query(p.x, p.z, 4).every((c) => c.kind === "circle" && c.breakable);
      if (free && !this.city.isWater(p.x, p.z) && this.city.surface(p.x, p.z) === "road") this.car.place(p.x, p.z, p.heading, this.city.ground(p.x, p.z));
      else this.car.place(safe.x, safe.z, safe.heading);
    }
    this.snapPrev();
    progress(0.8, "Warming up the engine");
    await tick();
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.35, 0.5, 0.86);
    this.bloom.enabled = q.bloom;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.buildUi();
    this.resize();
    window.addEventListener("resize", () => this.resize());
    // Compile every shader up front so the first seconds of driving don't hitch.
    this.env.update(0, this.renderPos, 0);
    this.renderer.compile(this.scene, this.camera);
    progress(1, "Ready");
    await tick();
    this.input.onPress = (code) => this.onKey(code);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && this.state === "drive") this.pause();
      if (document.hidden) this.persist();
    });
    window.addEventListener("pagehide", () => this.persist());
    this.setState("title");
    this.last = performance.now();
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  private addParked(spot: JackSpot): void {
    const def = carById(spot.carId);
    const visual = buildCar(def, def.colors[spot.color]);
    visual.root.position.set(spot.x, this.city.ground(spot.x, spot.z), spot.z);
    visual.root.rotation.y = spot.heading;
    visual.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    poseCar(visual, { steer: 0, wheelSpin: 0, roll: 0, pitch: 0, bodyPitch: 0, braking: false, reversing: false, lightsOn: false });
    this.scene.add(visual.root);
    const fx = Math.sin(spot.heading);
    const fz = Math.cos(spot.heading);
    const r = def.body.width / 2;
    const off = def.body.length / 2 - r;
    const colliders: CircleCollider[] = [-off, 0, off].map((o, i) => ({
      kind: "circle" as const,
      id: 1_000_000 + JACK_SPOTS.indexOf(spot) * 10 + i,
      x: spot.x + fx * o,
      z: spot.z + fz * o,
      r,
      top: def.body.height,
      base: this.city.ground(spot.x, spot.z),
      breakable: false,
      broken: false,
    }));
    for (const c of colliders) this.city.colliders.add(c);
    this.parked.push({ spot, visual, colliders });
  }

  private setParkedVisible(id: string | null, visible: boolean): void {
    const p = this.parked.find((pc) => pc.spot.id === id);
    if (!p) return;
    p.visual.root.visible = visible;
    // A "broken" circle is skipped by the physics: that is how a hidden car's
    // colliders are switched off.
    for (const c of p.colliders) c.broken = !visible;
  }

  private spawnPlayer(carId: string, colorIndex: number): void {
    const def = carById(carId);
    const old = this.car;
    this.car = new CarPhysics(def);
    this.car.sensitivity = this.save.steering;
    if (old) {
      this.car.place(old.x, old.z, old.heading, old.y);
      this.car.nitro = old.nitro;
    } else {
      const sp = this.city.spawn;
      this.car.place(sp.x, sp.z, sp.heading, this.city.ground(sp.x, sp.z));
    }
    if (this.carVisual) {
      this.scene.remove(this.carVisual.root);
      this.carVisual.dispose();
    }
    this.carVisual = buildCar(def, def.colors[colorIndex] ?? def.colors[0]);
    this.carVisual.root.rotation.order = "YXZ";
    this.carVisual.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    this.scene.add(this.carVisual.root);
    this.save.carId = def.id;
    this.save.colorIndex = colorIndex;
    this.hud?.setCarName(def.name, def.klass);
    this.audio.setEngine(def.id, def.handling.engine);
    this.drift.reset();
    this.jump.cancel();
    this.rig.snap();
  }

  private snapPrev(): void {
    this.prev = { x: this.car.x, y: this.car.y, z: this.car.z, heading: this.car.heading, pitch: this.car.pitch };
  }

  // ===========================================================================
  // UI
  // ===========================================================================

  private buildUi(): void {
    const c = this.container;
    this.hud = new Hud(c, this.city);
    this.hud.setCarName(this.car.def.name, this.car.def.klass);
    this.overlay = el("div", "overlay hidden");
    c.appendChild(this.overlay);

    // Title.
    this.titleEl = el("div", "screen title-screen hidden");
    this.titleEl.dataset.screen = "title";
    this.titleEl.innerHTML = `
      <div class="logo"><span class="l1">FAIRBAY</span><span class="l2">HEAT</span></div>
      <p class="tag">An open-world street racer. No game engine - just code.</p>`;
    c.appendChild(this.titleEl);
    const title = new MenuScreen(c, "title-menu", "", [
      { id: "drive", label: "Drive", action: () => this.startDriving() },
      { id: "garage", label: "Garage", action: () => this.openGarage("title") },
      { id: "controls", label: "Controls", action: () => this.openHelp("title") },
      { id: "settings", label: "Settings", action: () => this.openSettings("title") },
    ]);
    title.root.classList.add("title-menu");
    this.menus.title = title;

    // Pause.
    this.menus.pause = new MenuScreen(
      c,
      "pause",
      "Paused",
      [
        { id: "resume", label: "Resume", action: () => this.resume() },
        { id: "garage", label: "Garage", action: () => this.openGarage("paused") },
        { id: "map", label: "City map", action: () => this.openMap("paused") },
        { id: "reset", label: "Reset car to road", action: () => (this.resetCar(), this.resume()) },
        { id: "controls", label: "Controls", action: () => this.openHelp("paused") },
        { id: "settings", label: "Settings", action: () => this.openSettings("paused") },
        { id: "quit", label: "Quit to title", action: () => (this.persist(), this.setState("title")) },
      ],
      "",
      () => this.resume(),
    );

    // Settings.
    const ti = () => {
      const i = TIME_SPEEDS.findIndex(([, v]) => v === this.save.timeSpeed);
      return i < 0 ? 2 : i;
    };
    this.menus.settings = new MenuScreen(
      c,
      "settings",
      "Settings",
      [
        {
          id: "quality",
          label: "Graphics quality",
          value: () => this.save.quality[0].toUpperCase() + this.save.quality.slice(1),
          adjust: (d) => {
            const order: Quality[] = ["low", "medium", "high"];
            const i = clamp(order.indexOf(this.save.quality) + d, 0, 2);
            this.setQuality(order[i]);
          },
        },
        {
          id: "volume",
          label: "Volume",
          value: () => (this.save.muted ? "Muted" : `${Math.round(this.save.volume * 100)}%`),
          adjust: (d) => {
            this.save.volume = clamp(Math.round((this.save.volume + d * 0.1) * 10) / 10, 0, 1);
            this.audio.volume = this.save.volume;
            this.setMuted(false);
          },
        },
        {
          id: "time",
          label: "Day / night cycle",
          value: () => TIME_SPEEDS[ti()][0],
          adjust: (d) => {
            const i = clamp(ti() + d, 0, TIME_SPEEDS.length - 1);
            this.save.timeSpeed = TIME_SPEEDS[i][1];
            this.env.speed = this.save.timeSpeed;
          },
        },
        {
          id: "hour",
          label: "Time of day",
          value: () => fmtHours(this.env.hours),
          adjust: (d) => this.env.setHours(Math.round(this.env.hours) + d),
        },
        {
          id: "camera",
          label: "Camera",
          value: () => CAMERA_MODES[this.rig.mode],
          adjust: (d) => {
            this.rig.mode = (this.rig.mode + d + CAMERA_MODES.length) % CAMERA_MODES.length;
            this.save.camera = this.rig.mode;
          },
        },
        {
          id: "steering",
          label: "Steering sensitivity",
          value: () => `${Math.round(this.save.steering * 100)}%`,
          adjust: (d) => {
            this.save.steering = clamp(Math.round((this.save.steering + d * 0.1) * 10) / 10, 0.6, 1.6);
            this.car.sensitivity = this.save.steering;
          },
          hint: "How quickly the steering responds to A/D (each car also has its own feel)",
        },
        {
          id: "police",
          label: "Police chases",
          value: () => (this.save.police ? "On" : "Off (free roam)"),
          adjust: () => this.setPolice(!this.save.police),
          hint: "Turn the police off to cruise the city without being chased",
        },
        { id: "fps", label: "FPS counter", value: () => (this.save.showFps ? "On" : "Off"), adjust: () => (this.save.showFps = !this.save.showFps) },
        {
          id: "wipe",
          label: "Reset progress",
          value: () => (this.resetConfirm ? "Press Enter again" : ""),
          action: () => {
            if (!this.resetConfirm) {
              this.resetConfirm = true;
              return;
            }
            this.resetConfirm = false;
            this.wipeProgress();
          },
        },
        { id: "back", label: "Back", action: () => this.back() },
      ],
      "Saved automatically in this browser.",
      () => this.back(),
    );

    // Garage.
    this.menus.garage = new MenuScreen(
      c,
      "garage",
      "Garage",
      [
        {
          id: "car",
          label: "Car",
          value: () => carById(this.garageCar).name,
          adjust: (d) => {
            const owned = CARS.filter((k) => this.save.discovered.includes(k.id));
            const i = owned.findIndex((k) => k.id === this.garageCar);
            this.garageCar = owned[(i + d + owned.length) % owned.length].id;
            this.garageColor = 0;
            this.previewGarage();
          },
        },
        {
          id: "paint",
          label: "Paint",
          value: () => `${this.garageColor + 1} / ${carById(this.garageCar).colors.length}`,
          adjust: (d) => {
            const n = carById(this.garageCar).colors.length;
            this.garageColor = (this.garageColor + d + n) % n;
            this.previewGarage();
          },
        },
        { id: "drive", label: "Drive it", action: () => this.closeGarage() },
      ],
      "",
      () => this.closeGarage(),
    );
    this.menus.garage.root.classList.add("garage-screen");
    this.garageInfo = el("div", "garage-info");
    this.menus.garage.root.querySelector(".panel")!.appendChild(this.garageInfo);

    // Help.
    this.helpEl = el("div", "screen help-screen hidden");
    this.helpEl.dataset.screen = "help";
    const hp = el("div", "panel");
    hp.appendChild(el("h2", "", "Controls"));
    hp.appendChild(controlsTable());
    hp.appendChild(
      el(
        "p",
        "sub",
        "Drift (Space + steer) to fill your nitro. Find parked cars around Fairbay (orange dots on the map) and press E next to one to take it. Police: speeding past a patrol (over 95 km/h in town, 140 on highways), hitting cars or smashing lamp posts in sight of a cop starts a chase. Break line of sight and stay hidden until the cooldown bar fills to escape; stop with a cop alongside and you are busted. Heat 3+ brings roadblocks - look for the gap at the kerb. Police can be switched off in Settings.",
      ),
    );
    const hf = el("div", "menu-foot");
    hf.innerHTML = "<span><kbd>Esc</kbd> back</span>";
    hp.appendChild(hf);
    this.helpEl.appendChild(hp);
    c.appendChild(this.helpEl);

    // Map.
    this.mapEl = el("div", "screen map-screen hidden");
    this.mapEl.dataset.screen = "map";
    const mp = el("div", "panel map-panel");
    mp.appendChild(el("h2", "", "Fairbay"));
    this.mapCanvas = el("canvas", "map-canvas");
    mp.appendChild(this.mapCanvas);
    const legend = el("div", "legend");
    legend.innerHTML =
      '<span><i class="dot me"></i>You</span><span><i class="dot new"></i>Undiscovered car</span><span><i class="dot owned"></i>Car in your garage</span><span><i class="dot ramp"></i>Jump</span>';
    mp.appendChild(legend);
    const mf = el("div", "menu-foot");
    mf.innerHTML = "<span><kbd>Tab</kbd> / <kbd>Esc</kbd> close</span>";
    mp.appendChild(mf);
    this.mapEl.appendChild(mp);
    c.appendChild(this.mapEl);
  }

  private returnTo: State = "title";

  private setState(s: State): void {
    this.state = s;
    for (const m of Object.values(this.menus)) m.hide();
    this.titleEl.classList.add("hidden");
    this.helpEl.classList.add("hidden");
    this.mapEl.classList.add("hidden");
    this.overlay.classList.toggle("hidden", s === "drive" || s === "title" || s === "garage");
    this.hud.visible = s === "drive";
    document.body.dataset.state = s;
    switch (s) {
      case "title":
        this.titleEl.classList.remove("hidden");
        this.menus.title.show();
        this.input.clear();
        break;
      case "paused":
        this.menus.pause.show();
        break;
      case "settings":
        this.menus.settings.show();
        break;
      case "garage":
        this.menus.garage.show();
        break;
      case "help":
        this.helpEl.classList.remove("hidden");
        break;
      case "map":
        this.mapEl.classList.remove("hidden");
        this.drawMap();
        break;
    }
  }

  private startDriving(): void {
    this.audio.start();
    this.audio.setMuted(this.save.muted);
    this.rig.snap();
    this.setState("drive");
    this.district = "";
    this.acc = 0;
  }

  pause(): void {
    if (this.state !== "drive") return;
    this.input.clear();
    this.setState("paused");
    // Pausing from the road always lands on "Resume", so Esc then Enter gets
    // you straight back; sub-menus return to wherever you were.
    this.menus.pause.show(true);
    this.persist();
  }

  resume(): void {
    this.input.clear();
    this.rig.snap();
    this.setState("drive");
  }

  private back(): void {
    this.resetConfirm = false;
    this.persist();
    if (this.returnTo === "drive") this.resume();
    else this.setState(this.returnTo);
  }

  private openSettings(from: State): void {
    this.returnTo = from;
    this.setState("settings");
  }

  private openHelp(from: State): void {
    this.returnTo = from;
    this.setState("help");
  }

  private openMap(from: State): void {
    this.returnTo = from;
    this.setState("map");
  }

  private garageFrom: State = "title";

  private openGarage(from: State): void {
    this.garageFrom = from;
    this.garageCar = this.save.carId;
    this.garageColor = this.save.colorIndex;
    this.setState("garage");
    this.previewGarage();
  }

  private previewGarage(): void {
    if (this.garageCar !== this.car.def.id || this.garageColor !== this.save.colorIndex) {
      this.spawnPlayer(this.garageCar, this.garageColor);
      this.snapPrev();
    }
    const def = carById(this.garageCar);
    const r = ratings(def.handling);
    const bar = (label: string, v: number) => `<div class="stat"><span>${label}</span><div class="bar"><i style="width:${Math.round(v * 100)}%"></i></div></div>`;
    const owned = this.save.discovered.length;
    this.garageInfo.innerHTML = `
      <div class="gi-class">${def.klass} · ${def.handling.drive}</div>
      <div class="gi-name">${def.name}</div>
      <div class="gi-inspired">Stylised after the ${def.inspiredBy}</div>
      ${bar("Top speed", r.speed)}${bar("Acceleration", r.accel)}${bar("Handling", r.handling)}${bar("Steering", clamp((def.handling.steering.rate - 3.5) / 6, 0, 1))}${bar("Tail-happy", def.handling.steering.rear)}
      <div class="gi-feel">${steeringBlurb(def)}</div>
      <div class="gi-specs"><span>${def.handling.topSpeed} km/h</span><span>0-100 in ${def.handling.zeroTo100.toFixed(1)} s</span></div>
      <div class="gi-swatches">${def.colors.map((c, i) => `<i class="${i === this.garageColor ? "on" : ""}" style="background:${c}"></i>`).join("")}</div>
      <div class="gi-owned">${owned} of ${CARS.length} cars found${owned < CARS.length ? " - find the rest parked around Fairbay" : ""}</div>`;
    this.menus.garage.render();
  }

  private closeGarage(): void {
    // A garage car is "delivered", so the jack spot it came from (if any) is
    // back on the street.
    if (this.hiddenSpot) this.setParkedVisible(this.hiddenSpot, true);
    this.hiddenSpot = null;
    this.persist();
    if (this.garageFrom === "title") this.startDriving();
    else this.resume();
  }

  private drawMap(): void {
    this.hud.drawFullMap(this.mapCanvas, {
      x: this.car.x,
      z: this.car.z,
      heading: this.car.heading,
      spots: JACK_SPOTS,
      discovered: this.save.discovered,
      hiddenSpot: this.hiddenSpot,
    });
  }

  // ===========================================================================
  // Input
  // ===========================================================================

  private onKey(code: string): void {
    this.audio.start();
    const s = this.state;
    if (s === "title") {
      if (this.menus.title.key(code)) this.audio.blip(660);
      return;
    }
    if (s === "paused" || s === "settings" || s === "garage") {
      const m = s === "paused" ? this.menus.pause : s === "settings" ? this.menus.settings : this.menus.garage;
      if (m.key(code)) this.audio.blip(660);
      return;
    }
    if (s === "help") {
      if (code === "Escape" || code === "KeyH" || code === "Enter" || code === "Backspace") this.back();
      return;
    }
    if (s === "map") {
      if (code === "Escape" || code === "Tab" || code === "KeyP") this.back();
      return;
    }
    if (s !== "drive") return;
    const b = this.input.bindings;
    const is = (a: keyof typeof b) => b[a].includes(code);
    if (is("pause")) this.pause();
    else if (is("camera")) {
      this.hud.toast(`Camera: ${this.rig.cycle()}`);
      this.save.camera = this.rig.mode;
    }
    else if (is("map")) {
      this.input.clear();
      this.openMap("drive");
    } else if (is("reset")) this.resetCar();
    else if (is("mute")) this.setMuted(!this.save.muted);
    else if (is("time")) {
      this.env.setHours(this.env.hours + 3);
      this.hud.toast("Time skipped", fmtHours(this.env.hours));
    } else if (is("garage")) {
      if (this.car.speedKmh > 15) this.hud.toast("Slow down to open the garage", "", "warn");
      else {
        this.input.clear();
        this.openGarage("drive");
      }
    } else if (is("help")) {
      this.input.clear();
      this.openHelp("drive");
    } else if (is("fps")) this.save.showFps = !this.save.showFps;
    else if (is("jack")) this.tryJack();
  }

  private controls(): Controls {
    if (this.state !== "drive") return NO_CONTROLS;
    // Busted: the car is held while the cops make the arrest.
    if (this.heat.state === "busted") return { ...NO_CONTROLS, handbrake: true };
    const i = this.input;
    return {
      throttle: i.isDown("accelerate") ? 1 : 0,
      brake: i.isDown("brake") ? 1 : 0,
      steer: (i.isDown("left") ? 1 : 0) - (i.isDown("right") ? 1 : 0),
      handbrake: i.isDown("handbrake"),
      nitro: i.isDown("nitro"),
    };
  }

  // ===========================================================================
  // Actions
  // ===========================================================================

  private availableSpots(): JackSpot[] {
    return JACK_SPOTS.filter((s) => s.id !== this.hiddenSpot);
  }

  tryJack(): boolean {
    const spot = jackable(this.car.x, this.car.z, this.car.speedKmh, this.car.def.id, this.availableSpots());
    if (!spot) return false;
    const fresh = !this.save.discovered.includes(spot.carId);
    // The old jacked car goes back to its kerb; the new one leaves the street.
    if (this.hiddenSpot) this.setParkedVisible(this.hiddenSpot, true);
    this.setParkedVisible(spot.id, false);
    this.hiddenSpot = spot.id;
    this.spawnPlayer(spot.carId, spot.color);
    this.car.place(spot.x, spot.z, spot.heading);
    this.snapPrev();
    if (fresh) this.save.discovered.push(spot.carId);
    const def = carById(spot.carId);
    this.hud.flashScreen();
    this.audio.whoosh();
    if (fresh) this.hud.toast("NEW CAR FOUND", `${def.name} added to your garage`, "gold");
    else this.hud.toast(def.name, "Jacked");
    this.persist();
    return true;
  }

  resetCar(): void {
    const p = this.city.nearestRoadPoint(this.car.x, this.car.z);
    this.car.place(p.x, p.z, p.heading);
    this.snapPrev();
    this.drift.reset();
    this.jump.cancel();
    this.rig.snap();
    this.effects.skids.clear();
  }

  /** Police chases on / off (Settings). Turning them off ends any chase. */
  setPolice(on: boolean): void {
    this.save.police = on;
    this.police.setEnabled(on);
    if (!on) {
      this.heat.reset();
      this.hud?.setResult(null);
    }
  }

  private setMuted(m: boolean): void {
    this.save.muted = m;
    this.audio.setMuted(m);
    if (this.state === "drive") this.hud.toast(m ? "Sound off" : "Sound on");
  }

  setQuality(q: Quality): void {
    this.save.quality = q;
    const cfg = QUALITY[q];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cfg.pixelRatio));
    this.bloom.enabled = cfg.bloom;
    const sun = this.env.sun;
    sun.castShadow = cfg.shadow > 0;
    if (cfg.shadow > 0 && sun.shadow.mapSize.x !== cfg.shadow) {
      sun.shadow.mapSize.set(cfg.shadow, cfg.shadow);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    this.resize();
  }

  private wipeProgress(): void {
    const keep = { quality: this.save.quality, volume: this.save.volume, muted: this.save.muted };
    Object.assign(this.save, defaults(), keep);
    if (this.hiddenSpot) this.setParkedVisible(this.hiddenSpot, true);
    this.hiddenSpot = null;
    this.heat.reset();
    this.heat.totalBounty = 0;
    this.heat.escapes = 0;
    this.heat.busts = 0;
    this.police.standDown();
    this.spawnPlayer("mustanger", 0);
    const sp = this.city.spawn;
    this.car.place(sp.x, sp.z, sp.heading, this.city.ground(sp.x, sp.z));
    this.snapPrev();
    this.cityView.resetLamps();
    this.persist();
  }

  persist(): void {
    if (!this.car) return;
    this.save.hours = this.env?.hours ?? this.save.hours;
    this.save.pos = { x: this.car.x, z: this.car.z, heading: this.car.heading };
    this.save.distanceKm += this.distanceM / 1000;
    this.distanceM = 0;
    writeSave(this.save);
  }

  // ===========================================================================
  // Main loop
  // ===========================================================================

  private frame(now: number): void {
    try {
      this.tick(now);
    } catch (e) {
      // Surface a clear error rather than freezing silently.
      this.errors.push(String(e));
      console.error(e);
      this.renderer.setAnimationLoop(null);
      const box = el("div", "fatal");
      box.textContent = `Something went wrong: ${String(e)}. Reload the page to continue.`;
      this.container.appendChild(box);
    }
  }

  private tick(now: number): void {
    this.renderer.info.reset();
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.frames++;
    if (dt > 0) this.fpsSmoothed = lerp(this.fpsSmoothed, 1 / dt, 0.05);
    const time = now / 1000;

    if (this.state === "drive") {
      const c = this.controls();
      this.acc += dt;
      let steps = 0;
      while (this.acc >= STEP && steps < 24) {
        this.snapPrev();
        const ev = this.car.step(STEP, c, this.city.world);
        this.applyTrafficHits(this.traffic.collide(this.playerState()));
        this.applyPoliceHits(this.police.collide(this.playerView()));
        this.simTime += STEP;
        this.acc -= STEP;
        steps++;
        this.handleStepEvents(ev, c);
      }
      if (steps === 24) this.acc = 0; // way behind: drop time rather than spiral
      this.stepTraffic(dt);
      this.stepPolice(dt);
      this.gameplay(dt, c);
    }

    // Interpolated render pose.
    const a = this.state === "drive" ? clamp(this.acc / STEP, 0, 1) : 1;
    const p = this.prev;
    this.renderPos.set(lerp(p.x, this.car.x, a), lerp(p.y, this.car.y, a), lerp(p.z, this.car.z, a));
    this.renderHeading = p.heading + wrapAngle(this.car.heading - p.heading) * a;
    this.updateCarVisual(dt);

    // Camera.
    if (this.state === "title") {
      this.titleAngle += dt * 0.05;
      const r = 260;
      this.camera.position.set(Math.sin(this.titleAngle) * r, 120, Math.cos(this.titleAngle) * r);
      this.camera.lookAt(0, 30, 0);
      if (this.camera.fov !== 55) {
        this.camera.fov = 55;
        this.camera.updateProjectionMatrix();
      }
      this.rig.snap();
    } else if (this.state === "garage") {
      this.titleAngle += dt * 0.35;
      const L = this.car.def.body.length;
      const r = L * 1.35;
      const ga = this.titleAngle + this.renderHeading;
      this.camera.position.set(this.renderPos.x + Math.sin(ga) * r, this.renderPos.y + 1.4, this.renderPos.z + Math.cos(ga) * r);
      // Aim a little to the car's left (from the camera's view) so the car
      // sits in the right half of the screen, clear of the garage panel.
      const cx = this.renderPos.x - this.camera.position.x;
      const cz = this.renderPos.z - this.camera.position.z;
      const cl = Math.hypot(cx, cz) || 1;
      const shift = r * 0.32;
      this.camera.lookAt(this.renderPos.x + (cz / cl) * shift, this.renderPos.y + 0.5, this.renderPos.z - (cx / cl) * shift);
      if (this.camera.fov !== 50) {
        this.camera.fov = 50;
        this.camera.updateProjectionMatrix();
      }
      this.rig.snap();
    } else if (this.state === "drive" || this.rig) {
      if (this.state === "drive") this.rig.update(dt, this.car, this.renderPos.x, this.renderPos.y, this.renderPos.z, this.renderHeading, this.city.colliders, time);
    }

    const focus = this.state === "title" ? new THREE.Vector3(0, 0, 0) : this.renderPos;
    this.env.update(this.state === "drive" || this.state === "title" ? dt : 0, focus, time);
    const night = this.env.night;
    this.cityView.setNight(night);
    this.trafficView.setNight(night);
    this.trafficView.update(this.traffic.cars, time);
    this.policeView.setNight(night);
    this.policeView.update(this.police.units, this.police.patrols(), time, this.renderPos.x, this.renderPos.z);
    this.cityView.update(time, this.traffic.time);
    if (this.bloom.enabled) {
      // By day only very hot highlights bloom; at night lights and windows do.
      // The bright daytime sky sits near 1.0 after tone mapping, so a day
      // bloom smears it over everything. Bloom is a night effect (lamps,
      // windows, tail lights): off by day, fading in at dusk.
      this.bloom.strength = lerp(0, 0.4, night);
      this.bloom.threshold = 1.1;
      this.bloom.radius = 0.35;
    }
    this.effects.update(this.state === "drive" ? dt : 0, time, this.state === "drive" ? this.car.speed / this.car.vmax : 0, this.camera);

    // Headlights follow the car at night (left + right dipped beams).
    // A wall or car straight ahead is lit head-on and reflects ~20x more of
    // the beam back than the road does at its grazing angle, so it would
    // white out. Dim the beams as an obstacle closes in - like your eyes
    // adapting - keeping the light ON the obstacle at a fixed, safe level.
    // The open road keeps the full beams.
    if (night > 0.15 && this.state === "drive") {
      const d = Math.max(2, this.obstacleAhead(45));
      const onWall = 2 * BEAM * Math.pow(d, -0.9); // both beams, decay 0.9, head-on
      this.beamDim = damp(this.beamDim, Math.min(1, BEAM_ON_WALL / onWall), 8, dt);
    } else this.beamDim = 1;
    const beamI = night > 0.15 ? night * BEAM * this.beamDim : 0;
    const fx = Math.sin(this.renderHeading);
    const fz = Math.cos(this.renderHeading);
    const half = this.car.def.body.width * 0.32;
    const nose = this.car.def.body.length / 2;
    [this.headlight, this.headlight2].forEach((hl, i) => {
      hl.intensity = beamI;
      hl.visible = beamI > 0;
      if (!hl.visible) return;
      const side = i === 0 ? 1 : -1;
      const ox = fz * half * side;
      const oz = -fx * half * side;
      hl.position.set(this.renderPos.x + fx * nose + ox, this.renderPos.y + 0.7, this.renderPos.z + fz * nose + oz);
      // Dipped: aimed at the road ~22 m ahead, slightly towards the kerb.
      hl.target.position.set(this.renderPos.x + fx * 22 + ox * 1.6, this.renderPos.y - 0.4, this.renderPos.z + fz * 22 + oz * 1.6);
    });

    // HUD + sound.
    if (this.state === "drive") {
      this.hud.setPursuit(this.pursuitHud());
      this.hud.update({
        speedKmh: this.car.speedKmh,
        rpm: this.car.rpm,
        redline: this.car.def.handling.engine.redline,
        gear: this.car.gear,
        nitro: this.car.nitro,
        nitroActive: this.car.nitroActive,
        x: this.car.x,
        z: this.car.z,
        heading: this.renderHeading,
        spots: JACK_SPOTS,
        discovered: this.save.discovered,
        hiddenSpot: this.hiddenSpot,
        fps: this.save.showFps ? this.fpsSmoothed : null,
      });
    }
    this.audio.update({
      rpm: this.car.rpm,
      load: this.car.load,
      limiter: this.car.limiter,
      speed: this.car.speed,
      slip: this.car.slipAngle,
      grounded: !this.car.airborne,
      offroad: this.car.surface === "offroad",
      braking: this.car.braking,
      enclosure: this.enclosure(),
      paused: this.state !== "drive",
      camera: this.rig.mode,
    });
    if (this.state === "drive") {
      this.audio.updateTraffic(this.trafficSounds());
      this.audio.updateSirens(this.sirenSounds());
    } else {
      this.audio.updateTraffic([]);
      this.audio.updateSirens([]);
    }

    if (this.bloom.enabled && this.bloom.strength > 0.01) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
    this.input.endFrame();
  }

  private handleStepEvents(ev: ReturnType<CarPhysics["step"]>, c: Controls): void {
    if (ev.impact > 3) {
      const s = clamp(ev.impact / 25, 0, 1);
      if (this.simTime - this.lastImpactSound > 0.15) {
        this.audio.impact(s);
        this.lastImpactSound = this.simTime;
      }
      this.rig.bump(s * 0.9);
      const n = Math.round(6 + s * 30);
      for (let i = 0; i < n; i++) {
        this.effects.sparks.emit(
          ev.impactX,
          this.car.y + 0.4 + Math.random() * 0.5,
          ev.impactZ,
          (Math.random() - 0.5) * 9 + this.car.vx * 0.3,
          Math.random() * 5 + 1,
          (Math.random() - 0.5) * 9 + this.car.vz * 0.3,
          0.35 + Math.random() * 0.35,
          0.14,
          -0.1,
          1,
          0.8,
          0.4,
        );
      }
    }
    for (const lamp of ev.broken) {
      this.cityView.breakLamp(lamp);
      this.audio.impact(0.35);
      this.rig.bump(0.2);
      this.offence("property");
    }
    if (ev.landed > 4) {
      this.rig.bump(clamp(ev.landed / 20, 0, 0.8));
      this.audio.land(clamp(ev.landed / 20, 0.1, 0.8));
    }
    // Drift scoring (once per step).
    const banked = this.drift.update(STEP, this.car.drifting || Math.abs(this.car.slipAngle) > 0.25, this.car.speed, this.car.slipAngle, ev.impact);
    if (banked > 0) {
      this.hud.toast(`DRIFT +${Math.round(banked).toLocaleString("en-US")}`, banked > this.save.bestDrift ? "New best drift!" : "", banked > this.save.bestDrift ? "gold" : "info");
      this.save.bestDrift = Math.max(this.save.bestDrift, banked);
    } else if (banked < 0) {
      this.hud.toast("Drift lost", "You crashed", "warn");
    }
    const jumped = this.jump.update(this.car.airborne, this.car.x, this.car.y, this.car.z);
    if (jumped >= MIN_JUMP) {
      const best = jumped > this.save.longestJump;
      this.hud.toast(`JUMP ${jumped.toFixed(1)} m`, best ? "New longest jump!" : "", best ? "gold" : "info");
      this.save.longestJump = Math.max(this.save.longestJump, jumped);
    }
    void c;
  }

  private gameplay(dt: number, c: Controls): void {
    const car = this.car;
    this.distanceM += car.speed * dt;
    this.save.topSpeedKmh = Math.max(this.save.topSpeedKmh, car.speedKmh);

    // District banner.
    const d = this.city.districtOf(car.x, car.z);
    if (d !== this.district) {
      if (this.district !== "" && d !== "sea" && d !== "river") this.hud.showBanner(DISTRICT_NAMES[d as District]);
      this.district = d;
    }

    // Fell in the sea / out of the world.
    if (car.y < -1.5 || !Number.isFinite(car.x + car.z)) {
      this.hud.toast("Splash!", "Car recovered to the road", "warn");
      this.resetCar();
    }
    // Stuck (e.g. wedged): offer the reset prompt.
    this.stuckTime = c.throttle > 0 && car.speed < 1 ? this.stuckTime + dt : 0;

    // Jack prompt.
    const spot = jackable(car.x, car.z, car.speedKmh, car.def.id, this.availableSpots());
    if (spot) {
      const def = carById(spot.carId);
      const fresh = !this.save.discovered.includes(spot.carId);
      this.hud.setPrompt(`E|${fresh ? "Jack the" : "Switch to the"} ${def.name}${fresh ? " - NEW" : ""}`);
    } else if (this.stuckTime > 2.5) {
      this.hud.setPrompt("R|Stuck? Reset your car to the road");
    } else {
      this.hud.setPrompt(null);
    }

    this.hud.setDrift(this.drift.points, this.drift.active);

    this.saveTimer += dt;
    if (this.saveTimer > 10) {
      this.saveTimer = 0;
      this.persist();
    }
  }

  private updateCarVisual(dt: number): void {
    const car = this.car;
    const v = this.carVisual;
    v.root.position.copy(this.renderPos);
    v.root.rotation.y = this.renderHeading;
    v.root.rotation.x = -lerp(this.prev.pitch, car.pitch, 1);
    const live = this.state === "drive";
    const latAcc = live && !car.airborne ? car.yawRate * car.vLong : 0;
    this.roll = damp(this.roll, clamp(latAcc * 0.0045, -0.07, 0.07), 8, dt);
    this.bodyPitch = damp(this.bodyPitch, live && !car.airborne ? clamp(car.accelLong * 0.0035, -0.05, 0.035) : 0, 7, dt);
    poseCar(v, {
      steer: car.steer,
      wheelSpin: car.wheelSpin,
      roll: this.roll,
      pitch: car.pitch,
      bodyPitch: this.bodyPitch,
      braking: car.braking,
      reversing: car.reversing,
      lightsOn: this.env.night > 0.3,
    });
    if (!live || dt <= 0) return;

    // Tyre smoke, skid marks, dust, nitro flames.
    const slip = Math.abs(car.slipAngle);
    const burnout = car.throttle > 0 && car.speed < 8 && car.speed > 0.3 && car.def.handling.drive !== "FWD" && car.braking === false && car.accelLong > 6;
    const sliding = !car.airborne && (slip > 0.2 || burnout || (car.braking && car.speed > 15 && car.accelLong < -10));
    const strength = car.airborne ? 0 : clamp((slip - 0.15) * 2.2, 0, 1) + (burnout ? 0.6 : 0) + (car.braking && car.speed > 15 ? 0.35 : 0);
    const m = v.root.matrixWorld;
    v.root.updateMatrixWorld();
    const tmp = new THREE.Vector3();
    v.rearContacts.forEach((pt, i) => {
      tmp.copy(pt).applyMatrix4(m);
      tmp.y = this.city.ground(tmp.x, tmp.z);
      const offroad = car.surface === "offroad";
      this.effects.skids.add(i, tmp, Math.sin(car.heading), Math.cos(car.heading), sliding && !offroad ? strength : 0);
      if (offroad && car.speed > 6 && !car.airborne) {
        if (Math.random() < 0.5) this.effects.dust.emit(tmp.x, tmp.y + 0.3, tmp.z, -car.vx * 0.15, 1.2, -car.vz * 0.15, 1.4, 1.2, 2.5, 0.75, 0.66, 0.5);
      } else if (sliding && strength > 0.2) {
        const n = strength > 0.6 ? 2 : 1;
        for (let k = 0; k < n; k++) {
          this.effects.smoke.emit(
            tmp.x + (Math.random() - 0.5) * 0.4,
            tmp.y + 0.25,
            tmp.z + (Math.random() - 0.5) * 0.4,
            -car.vx * 0.12 + (Math.random() - 0.5) * 1.5,
            0.8 + Math.random(),
            -car.vz * 0.12 + (Math.random() - 0.5) * 1.5,
            1.6 + Math.random() * 0.8,
            1.1,
            3.2,
            0.92,
            0.92,
            0.95,
          );
        }
      }
    });
    if (car.nitroActive) {
      for (const ex of v.exhausts) {
        tmp.copy(ex).applyMatrix4(v.body.matrixWorld);
        const bx = -Math.sin(car.heading);
        const bz = -Math.cos(car.heading);
        this.effects.flames.emit(tmp.x, tmp.y, tmp.z, car.vx + bx * 9, 0, car.vz + bz * 9, 0.09, 0.55, -2);
      }
    }
  }

  private resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.effects?.setViewport(h * this.renderer.getPixelRatio(), this.camera.fov);
    if (this.state === "map") this.drawMap();
  }

  /** How built-up the surroundings are (0 open country .. 1 city canyon), for reverb. */
  private enclosure(): number {
    const d = this.city.districtOf(this.car.x, this.car.z);
    if (d === "downtown") return 1;
    if (d === "midtown" || d === "oldtown") return 0.7;
    if (d === "southside" || d === "ironworks" || d === "port") return 0.45;
    return 0.1;
  }

  /**
   * Distance (m) from the nose to the first solid thing in the headlight
   * beams - a building, wall, container or a car - up to `max` (returned when
   * nothing is in the way). Three rays across the beam, 2 m steps.
   */
  obstacleAhead(max: number): number {
    const car = this.car;
    const h = this.renderHeading;
    const fx = Math.sin(h);
    const fz = Math.cos(h);
    const nose = car.def.body.length / 2;
    const ox = this.renderPos.x + fx * nose;
    const oz = this.renderPos.z + fz * nose;
    let best = max;
    for (const a of [-0.17, 0, 0.17]) {
      const dx = Math.sin(h + a);
      const dz = Math.cos(h + a);
      for (let d = 1; d < best; d += 2) {
        const x = ox + dx * d;
        const z = oz + dz * d;
        let hit = false;
        for (const col of this.city.colliders.query(x, z, 1.5, this.beamScratch)) {
          if (col.kind === "circle" && (col.broken || col.r < 1)) continue; // posts, trees, hidden cars
          if (col.top < 1.5) continue; // kerbs, low barriers
          if (car.y > col.base + col.top || car.y + 2 < col.base) continue; // another level
          if (collide(x, z, 0.4, col)) {
            hit = true;
            break;
          }
        }
        if (hit) {
          best = d;
          break;
        }
      }
    }
    const cars: { x: number; y: number; z: number; length: number; width: number }[] = this.traffic.cars.map((c) => ({ x: c.x, y: c.y, z: c.z, length: c.model.length, width: c.model.width }));
    for (const u of this.police.units) cars.push({ x: u.phys.x, y: u.phys.y, z: u.phys.z, length: u.phys.def.body.length, width: u.phys.def.body.width });
    for (const c of cars) {
      const dx = c.x - ox;
      const dz = c.z - oz;
      // Police cars park at any angle: use the larger half-extent both ways.
      const ext = Math.max(c.length, c.width) / 2;
      const ahead = dx * fx + dz * fz - ext;
      if (ahead <= 0 || ahead >= best || Math.abs(c.y - car.y) > 3) continue;
      if (Math.abs(-dx * fz + dz * fx) < ext + 1.2) best = ahead;
    }
    return best;
  }

  // ===========================================================================
  // Police
  // ===========================================================================

  playerView(): PlayerView {
    const c = this.car;
    return { x: c.x, y: c.y, z: c.z, vx: c.vx, vz: c.vz, heading: c.heading, speed: c.speed, car: c };
  }

  /** An offence happened: it only counts if a police car saw it. */
  private offence(o: Offence): void {
    const seen = o === "takedown" || o === "rammed-cop" || this.police.witness(this.playerView());
    this.onHeat(this.heat.offence(o, seen));
  }

  private stepPolice(dt: number): void {
    const h = this.heat;
    const d = Math.min(dt, 0.05);
    const wasActive = h.active;
    const ev = this.police.step(d, this.playerView(), h.heat, h.state);
    for (const o of ev.witnessed) this.onHeat(h.offence(o, true));
    if (wasActive) for (const u of ev.joined) this.hud.toast("UNIT RESPONDING", `${u.phys.def.name} joins the pursuit`, "warn");
    if (ev.roadblock) this.hud.toast("ROADBLOCK AHEAD", `${ev.roadblock.road.name} is blocked - look for the gap`, "warn");
    this.onHeat(h.update(d, this.police.anyoneSees(), this.police.nearest(this.car.x, this.car.z), this.car.speed, this.police.boxedIn(this.car.x, this.car.z)));
    this.traffic.obstacles = this.police.trafficObstacles();
    // Result card.
    if (this.resultTimer > 0) {
      this.resultTimer -= dt;
      if (this.resultTimer <= 0) this.hud.setResult(null);
    }
  }

  private onHeat(events: HeatEvent[]): void {
    const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
    const what: Record<Offence, string> = { speeding: "Speeding", "rammed-car": "Hit and run", "rammed-cop": "Ramming a police car", property: "Damage to property", takedown: "Police car taken out" };
    for (const e of events) {
      this.heatLog.push(e);
      switch (e.type) {
        case "pursuit-start":
          this.hud.toast("PURSUIT", `${what[e.offence!]} - the police are after you`, "warn");
          this.audio.sting("alert");
          break;
        case "heat-up":
          this.hud.toast(`HEAT LEVEL ${e.heat}`, e.heat >= 3 ? "More units, roadblocks ahead" : "More units joining", "warn");
          this.audio.sting("heat");
          break;
        case "offence":
          if (e.offence === "takedown") this.hud.toast("TAKEDOWN", `+${fmt(e.bounty!)} bounty`, "gold");
          break;
        case "cooldown":
          this.hud.toast("COOLDOWN", "They lost you - stay out of sight", "info");
          break;
        case "spotted":
          this.hud.toast("SPOTTED", "Pursuit back on", "warn");
          this.audio.sting("alert");
          break;
        case "escaped": {
          this.audio.sting("escaped");
          this.hud.setResult("escaped", "ESCAPED", `Bounty +${fmt(e.bounty!)} · total ${fmt(this.heat.totalBounty)}`);
          this.resultTimer = 3.6;
          this.save.bounty = this.heat.totalBounty;
          this.save.escapes = this.heat.escapes;
          this.save.bestBounty = Math.max(this.save.bestBounty, e.bounty!);
          break;
        }
        case "busted":
          this.audio.sting("busted");
          this.hud.setResult("busted", "BUSTED", `Bounty of ${fmt(e.bounty!)} lost`);
          this.resultTimer = 3.6;
          this.save.busts = this.heat.busts;
          break;
        case "calm":
          // After a bust you get your car back on the road nearby, police gone.
          if (this.heat.busts > 0 && this.heatLog.at(-2)?.type === "busted") this.resetCar();
          this.police.standDown();
          break;
      }
    }
  }

  private applyPoliceHits(ev: ReturnType<Police["collide"]>): void {
    for (const r of ev.rams) {
      const s = clamp(r.impact / 25, 0, 1);
      if (this.simTime - this.lastImpactSound > 0.12) {
        this.audio.impact(clamp(s * 1.2, 0.15, 1));
        this.lastImpactSound = this.simTime;
      }
      this.rig.bump(s * 0.8);
      for (let i = 0; i < 6 + s * 24; i++) {
        this.effects.sparks.emit(r.x, this.car.y + 0.5 + Math.random() * 0.4, r.z, (Math.random() - 0.5) * 8, Math.random() * 4 + 1, (Math.random() - 0.5) * 8, 0.3 + Math.random() * 0.3, 0.13, -0.1, 1, 0.8, 0.4);
      }
      if (this.drift.points > 0 && r.impact > 7) this.drift.reset();
    }
    for (const o of ev.witnessed) this.onHeat(this.heat.offence(o, true));
    for (const hn of ev.horns) {
      const [right, fwd] = this.relative(hn.car.x, hn.car.z);
      this.audio.horn(right, fwd, hn.long);
    }
  }

  private sirenSounds() {
    const out = [];
    const near = this.police.units
      .filter((u) => u.siren && u.mode !== "wrecked")
      .map((u) => ({ u, d: Math.hypot(u.phys.x - this.car.x, u.phys.z - this.car.z) }))
      .filter((o) => o.d < 260)
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);
    for (const { u, d } of near) {
      const [right, fwd] = this.relative(u.phys.x, u.phys.z);
      const dx = (this.car.x - u.phys.x) / (d || 1);
      const dz = (this.car.z - u.phys.z) / (d || 1);
      const closing = (u.phys.vx - this.car.vx) * dx + (u.phys.vz - this.car.vz) * dz;
      out.push({ id: u.id, right, fwd, closing, yelp: d < 40 && u.mode === "pursue" });
    }
    return out;
  }

  private pursuitHud() {
    const h = this.heat;
    const blips: { x: number; z: number; kind: "unit" | "block" | "patrol" }[] = [];
    for (const u of this.police.units) if (u.mode !== "wrecked") blips.push({ x: u.phys.x, z: u.phys.z, kind: u.mode === "roadblock" ? "block" : "unit" });
    for (const c of this.police.patrols()) blips.push({ x: c.x, z: c.z, kind: "patrol" });
    return {
      state: h.state,
      heat: h.heat,
      bounty: h.bounty,
      evade: h.evade,
      cooldown: h.cooldown,
      bust: h.bust,
      units: this.police.units.filter((u) => u.mode === "pursue" || u.mode === "search").length,
      blips,
      red: this.policeView.redPhase,
    };
  }

  private playerState() {
    const car = this.car;
    return { x: car.x, z: car.z, vx: car.vx, vz: car.vz, heading: car.heading, radius: car.radius, length: car.def.body.length };
  }

  /** Steps traffic AI once per frame (collisions are handled per physics sub-step). */
  private stepTraffic(dt: number): void {
    const car = this.car;
    const ev = this.traffic.step(Math.min(dt, 0.05), this.playerState(), car.x, car.z, this.renderHeading);
    this.applyTrafficHits(ev);
  }

  private applyTrafficHits(ev: { hits: { car: { x: number; z: number }; impact: number; x: number; z: number }[]; horns: { car: { x: number; z: number }; long: boolean }[] }): void {
    const car = this.car;
    for (const h of ev.hits) {
      // The player's car loses some speed and gets nudged away.
      const s = clamp(h.impact / 25, 0, 1);
      const dx = car.x - h.car.x;
      const dz = car.z - h.car.z;
      const d = Math.hypot(dx, dz) || 1;
      const nx = dx / d;
      const nz = dz / d;
      const vn = car.vx * nx + car.vz * nz;
      if (vn < 0) {
        car.vx -= vn * nx * 1.2;
        car.vz -= vn * nz * 1.2;
      }
      car.vx *= 1 - 0.18 * s;
      car.vz *= 1 - 0.18 * s;
      car.x += nx * 0.15;
      car.z += nz * 0.15;
      if (h.impact > 2) {
        if (this.simTime - this.lastImpactSound > 0.12) {
          this.audio.impact(clamp(s * 1.2, 0.15, 1));
          this.lastImpactSound = this.simTime;
        }
        this.rig.bump(s * 0.8);
        for (let i = 0; i < 6 + s * 24; i++) {
          this.effects.sparks.emit(h.x, car.y + 0.5 + Math.random() * 0.4, h.z, (Math.random() - 0.5) * 8, Math.random() * 4 + 1, (Math.random() - 0.5) * 8, 0.3 + Math.random() * 0.3, 0.13, -0.1, 1, 0.8, 0.4);
        }
        this.trafficHits++;
        if (this.drift.points > 0 && h.impact > 7) this.drift.reset();
        if (h.impact > 4) this.offence("rammed-car");
      }
    }
    for (const hn of ev.horns) {
      const [right, fwd] = this.relative(hn.car.x, hn.car.z);
      this.audio.horn(right, fwd, hn.long);
    }
  }

  /** (right, forward) offset of a world point from the camera's view. */
  private relative(x: number, z: number): [number, number] {
    const h = this.renderHeading;
    const dx = x - this.renderPos.x;
    const dz = z - this.renderPos.z;
    const fx = Math.sin(h);
    const fz = Math.cos(h);
    return [dx * -fz + dz * fx, dx * fx + dz * fz];
  }

  private trafficSounds() {
    const out = [];
    const pvx = this.car.vx;
    const pvz = this.car.vz;
    const near = [...this.traffic.cars]
      .map((c) => ({ c, d: Math.hypot(c.x - this.car.x, c.z - this.car.z) }))
      .filter((o) => o.d < 70)
      .sort((a, b) => a.d - b.d)
      .slice(0, 6);
    for (const { c, d } of near) {
      const [right, fwd] = this.relative(c.x, c.z);
      const cvx = Math.sin(c.heading) * c.v;
      const cvz = Math.cos(c.heading) * c.v;
      const dx = (this.car.x - c.x) / (d || 1);
      const dz = (this.car.z - c.z) / (d || 1);
      const closing = (cvx - pvx) * dx + (cvz - pvz) * dz;
      out.push({ id: c.id, right, fwd, closing, speed: c.v });
    }
    return out;
  }

  /** Read-only snapshot for the automated tests (window.__fh). */
  snapshot() {
    const c = this.car;
    return {
      state: this.state,
      car: c.def.id,
      carName: c.def.name,
      x: c.x,
      y: c.y,
      z: c.z,
      heading: c.heading,
      speedKmh: c.speedKmh,
      vLong: c.vLong,
      steer: c.steer,
      yawRate: c.yawRate,
      drifting: c.drifting,
      airborne: c.airborne,
      nitro: c.nitro,
      nitroActive: c.nitroActive,
      gear: c.gear,
      simTime: this.simTime,
      frames: this.frames,
      hours: this.env.hours,
      night: this.env.night,
      cameraMode: this.rig.mode,
      discovered: [...this.save.discovered],
      hiddenSpot: this.hiddenSpot,
      muted: this.save.muted,
      quality: this.save.quality,
      fps: this.fpsSmoothed,
      errors: [...this.errors],
      traffic: this.traffic.cars.length,
      trafficHits: this.trafficHits,
      rpm: c.rpm,
      limiter: c.limiter,
      shifts: c.shifts,
      audioEngine: this.audio.engineId,
      audioMode: this.audio.engineMode,
      audioState: this.audio.ctx?.state ?? "none",
      audioLevel: this.audio.level(),
      gearRaw: c.gear,
      district: this.city.districtOf(c.x, c.z),
      heatState: this.heat.state,
      heat: this.heat.heat,
      bounty: this.heat.bounty,
      totalBounty: this.heat.totalBounty,
      bust: this.heat.bust,
      cooldown: this.heat.cooldown,
      escapes: this.heat.escapes,
      busts: this.heat.busts,
      units: this.police.units.filter((u) => u.mode === "pursue" || u.mode === "search").length,
      roadblocks: this.police.roadblocks.length,
      patrols: this.police.patrols().length,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
    };
  }

  /** Test-only: put the car somewhere specific. */
  teleport(x: number, z: number, heading: number): void {
    this.car.place(x, z, heading, this.city.ground(x, z));
    this.snapPrev();
    this.rig.snap();
  }
}

/** A one-line description of how a car steers, from its numbers. */
function steeringBlurb(def: CarDef): string {
  const f = def.handling.steering;
  const quick = f.rate >= 8 ? "Razor-sharp, darty steering" : f.rate >= 6.5 ? "Precise, quick steering" : f.rate >= 5 ? "Weighty, progressive steering" : "Heavy, slow steering";
  const rear = f.rear >= 0.7 ? "a loose rear that loves power oversteer" : f.rear >= 0.45 ? "a playful rear end" : "a planted, stable rear";
  const speed = f.speedFalloff <= 20 ? ", very calm at high speed" : f.speedFalloff >= 28 ? ", stays twitchy at speed" : "";
  return `${quick} with ${rear}${speed}.`;
}

function fmtHours(h: number): string {
  const hh = Math.floor(h) % 24;
  const mm = Math.floor((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export type { CarDef };
