/**
 * Car catalogue. Every car is a stylised, fictional take on a real car from
 * Need for Speed: Most Wanted (2013), with a name that resembles - but is not -
 * the real trademark. Body numbers drive the procedural model; handling
 * numbers drive the arcade physics (and are loosely based on the real car's
 * published 0-100 km/h time and top speed).
 */

export type Spoiler = "none" | "lip" | "ducktail" | "wing" | "bigwing";
export type Drive = "RWD" | "AWD" | "FWD";

export interface BodySpec {
  /** Overall length / width in metres. */
  length: number;
  width: number;
  /** Roof height above the ground. */
  height: number;
  /** Ground clearance under the sills. */
  clearance: number;
  wheelRadius: number;
  /** Axle positions as a fraction of length from the centre (+ is front). */
  frontAxle: number;
  rearAxle: number;
  /** Beltline (top of the body sides) height at the nose, cowl and tail. */
  noseHeight: number;
  cowlHeight: number;
  tailHeight: number;
  /** Greenhouse span as fractions of length (+ is front): base of rear glass,
   *  rear of the flat roof, front of the flat roof, base of the windscreen. */
  cabinRear: number;
  roofRear: number;
  roofFront: number;
  cabinFront: number;
  /** Roof half-width as a fraction of body half-width. */
  tumblehome: number;
  /** Extra width over the wheels (0 = slab sides). */
  fenderFlare: number;
  /** How rounded the nose/tail are in plan view (0..1). */
  plan: number;
  spoiler: Spoiler;
  hoodScoop?: boolean;
  stripes?: boolean;
  /** Wedge-style lights (supercars) instead of round ones. */
  slimLights?: boolean;
  sideIntakes?: boolean;
  quadExhaust?: boolean;
  /** Signature detailing, matched to the real car each one is styled after. */
  details: CarDetails;
}

export type HeadlightStyle = "round" | "swept" | "oval" | "y-slit" | "boomerang" | "horseshoe";
export type TaillightStyle = "tribar" | "strip" | "ring" | "y" | "slim" | "band";
export type GrilleStyle = "vane" | "mesh" | "none" | "hex" | "horseshoe" | "bar";
export type RimStyle = "split5" | "turbine" | "y6" | "mesh10" | "star7" | "monoblock";

export interface CarDetails {
  headlight: HeadlightStyle;
  taillight: TaillightStyle;
  grille: GrilleStyle;
  rim: RimStyle;
  /** Rim finish colour. */
  rimColor: string;
  caliper: string;
  /** Two-tone body: contrasting colour on the front half (Veyrone). */
  twoTone?: string;
  /** Front splitter / side skirt depth (0 = none). */
  aero: number;
  /** Visible roof scoop (Aventura). */
  roofScoop?: boolean;
  /** Wide rear haunches (911, Vantis). */
  haunch?: number;
}

export interface Handling {
  /** Published-ish 0-100 km/h time, seconds. */
  zeroTo100: number;
  /** Top speed, km/h. */
  topSpeed: number;
  /** Braking deceleration, m/s^2. */
  brake: number;
  /** Lateral grip (higher = sticks to the road). */
  grip: number;
  /** Lateral grip while drifting (lower = longer, lazier drifts). */
  driftGrip: number;
  /** Maximum lateral acceleration while gripping, m/s^2. */
  cornering: number;
  /** Steering responsiveness, 1/s. */
  response: number;
  drive: Drive;
  /** Steering feel - every car is different. */
  steering: SteeringFeel;
  /** Engine character for the synthesised sound. */
  engine: EngineSpec;
}

/**
 * How a car's steering feels on the keyboard:
 *  - `lock`: front-wheel angle at full input at low speed (rad). Bigger =
 *    tighter turning circle.
 *  - `rate`: how fast the wheel winds on when you press A/D (1/s). Bigger =
 *    twitchier / more immediate.
 *  - `centre`: how fast it self-centres when you let go (1/s).
 *  - `speedFalloff`: speed (m/s) at which lock has halved - lower means the
 *    steering gets calmer sooner at speed (stable GT); higher keeps it sharp
 *    (darty supercar).
 *  - `rear`: rear-end looseness 0..1 - how readily throttle/lift swings the
 *    tail out (power oversteer).
 */
export interface SteeringFeel {
  lock: number;
  rate: number;
  centre: number;
  speedFalloff: number;
  rear: number;
}

/**
 * Physical description of the engine that the sound synthesiser models:
 * cylinder count, firing pattern per exhaust bank, exhaust pipe lengths,
 * muffler openness, forced induction and overrun crackle.
 */
export interface EngineSpec {
  cylinders: number;
  idle: number;
  redline: number;
  /** Which 720/N-degree firing slots feed each exhaust bank. Uneven slot
   *  spacing within a bank (cross-plane V8) is what makes a V8 burble. */
  banks: number[][];
  /** Exhaust primary and tail pipe lengths, metres. */
  pipes: [number, number];
  /** Muffler cut-off at full throttle, Hz (higher = rawer, louder). */
  muffler: number;
  /** Number of turbochargers (0 = naturally aspirated). */
  turbos: number;
  /** Overrun pops and crackles, 0..1. */
  crackle: number;
  /** Intake roar mix, 0..1. */
  intake: number;
  /** Combustion randomness (lumpy cams = higher), 0..1. */
  rough: number;
  /** Exhaust header length mismatch between banks (0 = equal length). */
  headerMismatch?: number;
}

export interface CarDef {
  id: string;
  name: string;
  /** The real car this one is inspired by (shown in the garage). */
  inspiredBy: string;
  klass: "Sports" | "Muscle" | "Super" | "Hyper" | "Rally" | "Off-road";
  colors: string[];
  body: BodySpec;
  handling: Handling;
}

export const CARS: CarDef[] = [
  {
    id: "vantis",
    name: "Ashton Marvin V12 Vantis",
    inspiredBy: "Aston Martin V12 Vantage",
    klass: "Sports",
    colors: ["#9aa3ad", "#1f4d3a", "#0e1726", "#b8122b"],
    body: {
      length: 4.38, width: 1.87, height: 1.24, clearance: 0.13, wheelRadius: 0.35,
      frontAxle: 0.31, rearAxle: -0.31,
      noseHeight: 0.62, cowlHeight: 0.86, tailHeight: 0.9,
      cabinRear: -0.36, roofRear: -0.16, roofFront: 0.05, cabinFront: 0.2,
      tumblehome: 0.72, fenderFlare: 0.04, plan: 0.55, spoiler: "lip", details: { headlight: "swept", taillight: "slim", grille: "vane", rim: "y6", rimColor: "#2b2e33", caliper: "#c8102e", aero: 0.4, haunch: 0.05 },
      sideIntakes: true,
    },
    handling: {
      zeroTo100: 4.2, topSpeed: 305, brake: 13, grip: 9, driftGrip: 2.4, cornering: 21,
      response: 8, drive: "RWD", steering: { lock: 0.56, rate: 5.5, centre: 8, speedFalloff: 24, rear: 0.45 }, engine: { cylinders: 12, idle: 850, redline: 7000, banks: [[0, 2, 4, 6, 8, 10], [1, 3, 5, 7, 9, 11]], pipes: [0.9, 2.3], muffler: 2600, turbos: 0, crackle: 0.45, intake: 0.5, rough: 0.12 },
    },
  },
  {
    id: "carrara",
    name: "Porsa 911 Carrara S",
    inspiredBy: "Porsche 911 Carrera S (991)",
    klass: "Sports",
    colors: ["#d8d8d4", "#f2b705", "#14213d", "#2a2a2a"],
    body: {
      length: 4.49, width: 1.81, height: 1.3, clearance: 0.12, wheelRadius: 0.34,
      frontAxle: 0.27, rearAxle: -0.25,
      noseHeight: 0.6, cowlHeight: 0.84, tailHeight: 0.86,
      cabinRear: -0.44, roofRear: -0.12, roofFront: 0.04, cabinFront: 0.18,
      tumblehome: 0.7, fenderFlare: 0.07, plan: 0.75, spoiler: "ducktail", details: { headlight: "oval", taillight: "band", grille: "none", rim: "split5", rimColor: "#c7cbd0", caliper: "#e3b505", aero: 0.2, haunch: 0.08 },
    },
    handling: {
      zeroTo100: 4.3, topSpeed: 304, brake: 14, grip: 10, driftGrip: 2.6, cornering: 23,
      response: 9, drive: "RWD", steering: { lock: 0.6, rate: 8, centre: 11, speedFalloff: 26, rear: 0.6 }, engine: { cylinders: 6, idle: 900, redline: 7800, banks: [[0, 2, 4], [1, 3, 5]], pipes: [0.6, 1.7], muffler: 3200, turbos: 0, crackle: 0.35, intake: 0.75, rough: 0.1, headerMismatch: 0.15 },
    },
  },
  {
    id: "mustanger",
    name: "Fjord Mustanger GT",
    inspiredBy: "Ford Mustang GT (2013)",
    klass: "Muscle",
    colors: ["#c1121f", "#1d3557", "#f4a261", "#111111"],
    body: {
      length: 4.78, width: 1.88, height: 1.4, clearance: 0.15, wheelRadius: 0.36,
      frontAxle: 0.29, rearAxle: -0.3,
      noseHeight: 0.8, cowlHeight: 0.98, tailHeight: 0.98,
      cabinRear: -0.32, roofRear: -0.12, roofFront: 0.04, cabinFront: 0.14,
      tumblehome: 0.76, fenderFlare: 0.02, plan: 0.2, spoiler: "lip", details: { headlight: "round", taillight: "tribar", grille: "mesh", rim: "star7", rimColor: "#1c1d20", caliper: "#c8102e", aero: 0.3 },
      hoodScoop: true, stripes: true, quadExhaust: true,
    },
    handling: {
      zeroTo100: 4.8, topSpeed: 250, brake: 11.5, grip: 7.5, driftGrip: 1.9, cornering: 19,
      response: 7, drive: "RWD", steering: { lock: 0.52, rate: 4.2, centre: 6.5, speedFalloff: 20, rear: 0.85 }, engine: { cylinders: 8, idle: 750, redline: 6800, banks: [[0, 2, 3, 5], [1, 4, 6, 7]], pipes: [0.8, 2.6], muffler: 1500, turbos: 0, crackle: 0.55, intake: 0.35, rough: 0.3, headerMismatch: 0.3 },
    },
  },
  {
    id: "aventura",
    name: "Lamborgino Aventura LP700",
    inspiredBy: "Lamborghini Aventador LP700-4",
    klass: "Super",
    colors: ["#9bd400", "#ff6a00", "#f5f5f5", "#151515"],
    body: {
      length: 4.78, width: 2.03, height: 1.14, clearance: 0.11, wheelRadius: 0.36,
      frontAxle: 0.3, rearAxle: -0.28,
      noseHeight: 0.5, cowlHeight: 0.78, tailHeight: 0.9,
      cabinRear: -0.3, roofRear: -0.12, roofFront: 0.02, cabinFront: 0.3,
      tumblehome: 0.6, fenderFlare: 0.06, plan: 0.3, spoiler: "wing", details: { headlight: "y-slit", taillight: "y", grille: "hex", rim: "turbine", rimColor: "#18191b", caliper: "#f2c230", aero: 0.9, roofScoop: true },
      slimLights: true, sideIntakes: true, quadExhaust: false,
    },
    handling: {
      zeroTo100: 2.9, topSpeed: 350, brake: 15, grip: 11, driftGrip: 2.9, cornering: 25,
      response: 9, drive: "AWD", steering: { lock: 0.5, rate: 9, centre: 12, speedFalloff: 30, rear: 0.3 }, engine: { cylinders: 12, idle: 1000, redline: 8500, banks: [[0, 2, 4, 6, 8, 10], [1, 3, 5, 7, 9, 11]], pipes: [0.7, 1.5], muffler: 3800, turbos: 0, crackle: 0.85, intake: 0.6, rough: 0.12 },
    },
  },
  {
    id: "gtarr",
    name: "Nissun GT-Arr Premium",
    inspiredBy: "Nissan GT-R (R35)",
    klass: "Sports",
    colors: ["#e8e8e8", "#20242c", "#2b59c3", "#8a8f96"],
    body: {
      length: 4.67, width: 1.9, height: 1.37, clearance: 0.13, wheelRadius: 0.35,
      frontAxle: 0.3, rearAxle: -0.3,
      noseHeight: 0.72, cowlHeight: 0.94, tailHeight: 1.0,
      cabinRear: -0.37, roofRear: -0.16, roofFront: 0.04, cabinFront: 0.18,
      tumblehome: 0.74, fenderFlare: 0.03, plan: 0.25, spoiler: "wing", details: { headlight: "boomerang", taillight: "ring", grille: "bar", rim: "mesh10", rimColor: "#3a3d42", caliper: "#2b59c3", aero: 0.6 },
      quadExhaust: true,
    },
    handling: {
      zeroTo100: 3.2, topSpeed: 315, brake: 14, grip: 11, driftGrip: 3.2, cornering: 24,
      response: 9, drive: "AWD", steering: { lock: 0.55, rate: 7, centre: 10, speedFalloff: 25, rear: 0.25 }, engine: { cylinders: 6, idle: 900, redline: 7100, banks: [[0, 2, 4], [1, 3, 5]], pipes: [1.0, 2.4], muffler: 1700, turbos: 2, crackle: 0.25, intake: 0.4, rough: 0.08, headerMismatch: 0.12 },
    },
  },
  {
    id: "veyrone",
    name: "Bugarri Veyrone 16.4",
    inspiredBy: "Bugatti Veyron 16.4",
    klass: "Hyper",
    colors: ["#1b2a4a", "#c8102e", "#f0f0f0", "#d9a400"],
    body: {
      length: 4.46, width: 1.99, height: 1.21, clearance: 0.1, wheelRadius: 0.36,
      frontAxle: 0.3, rearAxle: -0.28,
      noseHeight: 0.56, cowlHeight: 0.82, tailHeight: 0.95,
      cabinRear: -0.24, roofRear: -0.08, roofFront: 0.04, cabinFront: 0.27,
      tumblehome: 0.62, fenderFlare: 0.08, plan: 0.85, spoiler: "lip", details: { headlight: "horseshoe", taillight: "strip", grille: "horseshoe", rim: "monoblock", rimColor: "#d4d7db", caliper: "#c8102e", aero: 0.3, twoTone: "#1a1c20" },
      sideIntakes: true,
    },
    handling: {
      zeroTo100: 2.5, topSpeed: 407, brake: 15, grip: 10, driftGrip: 2.8, cornering: 24,
      response: 8, drive: "AWD", steering: { lock: 0.46, rate: 4.8, centre: 7.5, speedFalloff: 19, rear: 0.2 }, engine: { cylinders: 16, idle: 900, redline: 6600, banks: [[0, 2, 4, 6, 8, 10, 12, 14], [1, 3, 5, 7, 9, 11, 13, 15]], pipes: [1.1, 2.8], muffler: 1400, turbos: 4, crackle: 0.15, intake: 0.35, rough: 0.06 },
    },
  },
];

export function carById(id: string): CarDef {
  return CARS.find((c) => c.id === id) ?? CARS[0];
}

/** Normalised 0..1 ratings for the garage bars. */
export function ratings(h: Handling): { speed: number; accel: number; handling: number } {
  return {
    speed: Math.min(1, (h.topSpeed - 180) / (420 - 180)),
    accel: Math.min(1, (7 - h.zeroTo100) / (7 - 2.3)),
    handling: Math.min(1, (h.cornering - 14) / (27 - 14)),
  };
}
