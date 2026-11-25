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
  /** Engine character for the synthesised sound. */
  engine: { cylinders: number; idle: number; redline: number; tone: number };
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
      tumblehome: 0.72, fenderFlare: 0.04, plan: 0.55, spoiler: "lip",
      sideIntakes: true,
    },
    handling: {
      zeroTo100: 4.2, topSpeed: 305, brake: 13, grip: 9, driftGrip: 2.4, cornering: 21,
      response: 8, drive: "RWD", engine: { cylinders: 12, idle: 850, redline: 7000, tone: 0.55 },
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
      tumblehome: 0.7, fenderFlare: 0.07, plan: 0.75, spoiler: "ducktail",
    },
    handling: {
      zeroTo100: 4.3, topSpeed: 304, brake: 14, grip: 10, driftGrip: 2.6, cornering: 23,
      response: 9, drive: "RWD", engine: { cylinders: 6, idle: 900, redline: 7800, tone: 0.7 },
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
      tumblehome: 0.76, fenderFlare: 0.02, plan: 0.2, spoiler: "lip",
      hoodScoop: true, stripes: true, quadExhaust: true,
    },
    handling: {
      zeroTo100: 4.8, topSpeed: 250, brake: 11.5, grip: 7.5, driftGrip: 1.9, cornering: 19,
      response: 7, drive: "RWD", engine: { cylinders: 8, idle: 750, redline: 6800, tone: 0.35 },
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
      tumblehome: 0.6, fenderFlare: 0.06, plan: 0.3, spoiler: "wing",
      slimLights: true, sideIntakes: true, quadExhaust: false,
    },
    handling: {
      zeroTo100: 2.9, topSpeed: 350, brake: 15, grip: 11, driftGrip: 2.9, cornering: 25,
      response: 9, drive: "AWD", engine: { cylinders: 12, idle: 1000, redline: 8500, tone: 0.75 },
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
      tumblehome: 0.74, fenderFlare: 0.03, plan: 0.25, spoiler: "wing",
      quadExhaust: true,
    },
    handling: {
      zeroTo100: 3.2, topSpeed: 315, brake: 14, grip: 11, driftGrip: 3.2, cornering: 24,
      response: 9, drive: "AWD", engine: { cylinders: 6, idle: 900, redline: 7100, tone: 0.5 },
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
      tumblehome: 0.62, fenderFlare: 0.08, plan: 0.85, spoiler: "lip",
      sideIntakes: true,
    },
    handling: {
      zeroTo100: 2.5, topSpeed: 407, brake: 15, grip: 10, driftGrip: 2.8, cornering: 24,
      response: 8, drive: "AWD", engine: { cylinders: 16, idle: 900, redline: 6600, tone: 0.45 },
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
