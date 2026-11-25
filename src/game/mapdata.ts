/**
 * Hand-authored map of Fairbay (not a grid).
 *
 * Authored in (E, N) metres - east and north - which is how a map is read.
 * The game world uses x = -E, z = N (see `toWorld`), because heading 0 faces
 * +Z and a positive heading turns left towards +X.
 *
 *   - Fairbay Circle: a 6-exit roundabout at the heart of Downtown.
 *   - Six curving radial avenues, an inner "Crescent" street ring and an
 *     outer boulevard ring, so blocks are wedges and curves - not squares.
 *   - The Fairbay Loop freeway around everything, with 8 link roads.
 *   - Old Town and Hillcrest to the north, Ironworks east, the Port and
 *     Sunset Beach on the south coast, the Fair River to the west with two
 *     bridges to Westside, and a hairpin mountain road over Mount Calder.
 */

import type { V2 } from "../core/geom";

export type RoadClass = "freeway" | "boulevard" | "avenue" | "street" | "mountain" | "coast" | "ring";

export interface RoadClassSpec {
  /** Lanes per direction (one-way roads use `lanes` in the forward direction only). */
  lanes: number;
  laneWidth: number;
  /** Gap between the two directions (painted or barrier). */
  median: number;
  shoulder: number;
  /** Traffic free-flow speed, m/s. */
  speed: number;
  oneWay: boolean;
  sidewalk: boolean;
  /** Concrete barriers on both edges and in the median. */
  barriers: boolean;
  /** Metal guard rails on both edges. */
  rails: boolean;
  lamps: "both" | "median" | "one" | "none";
}

export const ROAD_CLASSES: Record<RoadClass, RoadClassSpec> = {
  freeway: { lanes: 3, laneWidth: 3.6, median: 3, shoulder: 2.2, speed: 30, oneWay: false, sidewalk: false, barriers: true, rails: false, lamps: "median" },
  boulevard: { lanes: 2, laneWidth: 3.5, median: 2.2, shoulder: 0.6, speed: 17, oneWay: false, sidewalk: true, barriers: false, rails: false, lamps: "both" },
  avenue: { lanes: 2, laneWidth: 3.4, median: 0.5, shoulder: 0.8, speed: 15, oneWay: false, sidewalk: true, barriers: false, rails: false, lamps: "both" },
  street: { lanes: 1, laneWidth: 3.6, median: 0.3, shoulder: 1.6, speed: 12.5, oneWay: false, sidewalk: true, barriers: false, rails: false, lamps: "both" },
  mountain: { lanes: 1, laneWidth: 3.7, median: 0.3, shoulder: 0.9, speed: 14, oneWay: false, sidewalk: false, barriers: false, rails: true, lamps: "none" },
  coast: { lanes: 1, laneWidth: 3.8, median: 0.4, shoulder: 2.2, speed: 19, oneWay: false, sidewalk: false, barriers: false, rails: false, lamps: "one" },
  ring: { lanes: 1, laneWidth: 6.5, median: 0, shoulder: 1.4, speed: 9, oneWay: true, sidewalk: true, barriers: false, rails: false, lamps: "none" },
};

export function roadWidth(c: RoadClass): number {
  const k = ROAD_CLASSES[c];
  const dirs = k.oneWay ? 1 : 2;
  return dirs * k.lanes * k.laneWidth + k.median + 2 * k.shoulder;
}

export type JunctionKind = "signal" | "priority" | "roundabout";

export interface NodeDef {
  id: string;
  e: number;
  n: number;
  kind: JunctionKind;
  label?: string;
}

export interface RoadDef {
  id: string;
  name: string;
  cls: RoadClass;
  from: string;
  to: string;
  /** Intermediate control points (E, N), smoothed with Catmull-Rom. */
  via: [number, number][];
  /** Roads that keep right-of-way through a priority junction. */
  main?: boolean;
}

// ---------------------------------------------------------------------------
// Fairbay Circle (roundabout)
// ---------------------------------------------------------------------------

export const CIRCLE = { e: 120, n: 60, r: 48, island: 38 };

/** Exit angles (degrees CCW from east) and the spoke each exit feeds. */
const EXITS: [string, number][] = [
  ["B", 12],
  ["A", 92],
  ["H", 142],
  ["D", 192],
  ["C", 268],
  ["F", 318],
];

const polar = (deg: number, r: number, c = CIRCLE): [number, number] => [c.e + r * Math.cos((deg * Math.PI) / 180), c.n + r * Math.sin((deg * Math.PI) / 180)];

const nodes: NodeDef[] = [];
const roads: RoadDef[] = [];
const N = (id: string, e: number, n: number, kind: JunctionKind, label?: string) => nodes.push({ id, e, n, kind, label });
const R = (id: string, name: string, cls: RoadClass, from: string, to: string, via: [number, number][] = [], main = false) =>
  roads.push({ id, name, cls, from, to, via, main });

// Roundabout entry nodes + one-way ring arcs (counter-clockwise for
// right-hand traffic, seen from above with north up).
for (const [to, deg] of EXITS) {
  const [e, n] = polar(deg, CIRCLE.r);
  N(`rb-${to}`, e, n, "roundabout", "Fairbay Circle");
}
for (let i = 0; i < EXITS.length; i++) {
  const [a, d0] = EXITS[i];
  const [b, d1raw] = EXITS[(i + 1) % EXITS.length];
  const d1 = d1raw < d0 ? d1raw + 360 : d1raw;
  const via: [number, number][] = [];
  const steps = Math.max(2, Math.round((d1 - d0) / 10));
  for (let k = 1; k < steps; k++) via.push(polar(d0 + ((d1 - d0) * k) / steps, CIRCLE.r));
  R(`ring-${a}${b}`, "Fairbay Circle", "ring", `rb-${a}`, `rb-${b}`, via, true);
}

// ---------------------------------------------------------------------------
// Downtown: crescent nodes, outer boulevard nodes
// ---------------------------------------------------------------------------

// Crescent junctions (~230 m out along each spoke).
N("mB", 346, 104, "signal");
N("mA", 96, 290, "signal");
N("mH", -58, 206, "signal");
N("mD", -108, 16, "signal");
N("mC", 108, -172, "signal");
N("mF", 300, -90, "signal");

// Outer boulevard junctions.
N("B", 585, 125, "signal");
N("E", 425, 418, "signal");
N("A", 68, 487, "signal");
N("H", -214, 361, "signal");
N("D", -316, -2, "signal");
N("G", -170, -262, "signal");
N("C", 118, -362, "signal");
N("F", 482, -224, "signal");

// Spokes (roundabout -> crescent -> boulevard), gently curving.
R("bay-1", "Bay Street", "boulevard", "rb-B", "mB", [[250, 92]]);
R("bay-2", "Bay Street", "boulevard", "mB", "B", [[470, 122]]);
R("lib-1", "Liberty Avenue", "avenue", "rb-A", "mA", [[110, 190]]);
R("lib-2", "Liberty Avenue", "avenue", "mA", "A", [[80, 390]]);
R("park-1", "Parkway", "avenue", "rb-H", "mH", [[30, 150]]);
R("park-2", "Parkway", "avenue", "mH", "H", [[-140, 290]]);
R("mkt-1", "Market Street", "boulevard", "rb-D", "mD", [[-10, 40]]);
R("mkt-2", "Market Street", "boulevard", "mD", "D", [[-215, 4]]);
R("cen-1", "Centre Street", "avenue", "rb-C", "mC", [[122, -70]]);
R("cen-2", "Centre Street", "avenue", "mC", "C", [[104, -268]]);
R("har-1", "Harbor Boulevard", "boulevard", "rb-F", "mF", [[226, -24]]);
R("har-2", "Harbor Boulevard", "boulevard", "mF", "F", [[392, -158]]);

// Crescent (inner ring street).
R("cr-BA", "Crescent", "street", "mB", "mA", [[310, 220], [210, 290]]);
R("cr-AH", "Crescent", "street", "mA", "mH", [[18, 268]]);
R("cr-HD", "Crescent", "street", "mH", "mD", [[-110, 116]]);
R("cr-DC", "Crescent", "street", "mD", "mC", [[-80, -100], [0, -160]]);
R("cr-CF", "Crescent", "street", "mC", "mF", [[214, -150]]);
R("cr-FB", "Crescent", "street", "mF", "mB", [[352, 2]]);

// Outer boulevard ring ("Ring Road").
R("rr-BE", "Ring Road", "boulevard", "B", "E", [[540, 290]]);
R("rr-EA", "Ring Road", "boulevard", "E", "A", [[250, 480]]);
R("rr-AH", "Ring Road", "boulevard", "A", "H", [[-80, 450]]);
R("rr-HD", "Ring Road", "boulevard", "H", "D", [[-300, 190]]);
R("rr-DG", "Ring Road", "boulevard", "D", "G", [[-270, -150]]);
R("rr-GC", "Ring Road", "boulevard", "G", "C", [[-30, -340]]);
R("rr-CF", "Ring Road", "boulevard", "C", "F", [[310, -330]]);
R("rr-FB", "Ring Road", "boulevard", "F", "B", [[570, -50]]);

// ---------------------------------------------------------------------------
// Outer districts
// ---------------------------------------------------------------------------

// Freeway junctions (priority: the freeway keeps right of way).
N("FN", 40, 960, "priority", "Northgate Interchange");
N("FNE", 700, 760, "priority", "Old Town Interchange");
N("FE", 1030, 150, "priority", "Eastport Interchange");
N("FSE", 850, -480, "priority", "Foundry Interchange");
N("FS", 150, -690, "priority", "Harbor Interchange");
N("FSW", -420, -600, "priority", "Southwest Interchange");
N("FW", -560, 40, "priority", "Riverside Interchange");
N("FNW", -430, 700, "priority", "Hillcrest Interchange");

R("fw-1", "Fairbay Loop", "freeway", "FN", "FNE", [[380, 900]], true);
R("fw-2", "Fairbay Loop", "freeway", "FNE", "FE", [[950, 500]], true);
R("fw-3", "Fairbay Loop", "freeway", "FE", "FSE", [[1010, -200]], true);
R("fw-4", "Fairbay Loop", "freeway", "FSE", "FS", [[500, -640]], true);
R("fw-5", "Fairbay Loop", "freeway", "FS", "FSW", [[-140, -690]], true);
R("fw-6", "Fairbay Loop", "freeway", "FSW", "FW", [[-540, -280]], true);
R("fw-7", "Fairbay Loop", "freeway", "FW", "FNW", [[-560, 380]], true);
R("fw-8", "Fairbay Loop", "freeway", "FNW", "FN", [[-200, 880]], true);

// Mid-link junctions.
N("O1", 55, 720, "signal");
N("O2", 560, 590, "signal");
N("H2", -300, 500, "signal");
N("I1", 810, 140, "signal");
N("I2", 660, -360, "signal");
N("S1", 135, -530, "signal");
N("S2", -300, -440, "signal");

// Link roads (boulevard -> freeway).
R("ng-1", "Northgate Avenue", "avenue", "A", "O1", [[62, 600]]);
R("ng-2", "Northgate Avenue", "avenue", "O1", "FN", [[48, 840]]);
R("ot-1", "Old Town Road", "avenue", "E", "O2", [[490, 500]]);
R("ot-2", "Old Town Road", "avenue", "O2", "FNE", [[640, 670]]);
R("be-1", "Bay Street East", "avenue", "B", "I1", [[700, 140]]);
R("be-2", "Bay Street East", "avenue", "I1", "FE", [[920, 150]]);
R("fd-1", "Foundry Road", "avenue", "F", "I2", [[570, -300]]);
R("fd-2", "Foundry Road", "avenue", "I2", "FSE", [[760, -420]]);
R("ha-1", "Harbor Avenue", "avenue", "C", "S1", [[128, -450]]);
R("ha-2", "Harbor Avenue", "avenue", "S1", "FS", [[142, -610]]);
R("sw-1", "Southwest Parkway", "avenue", "G", "S2", [[-232, -350]]);
R("sw-2", "Southwest Parkway", "avenue", "S2", "FSW", [[-360, -520]]);
R("wm", "West Market", "boulevard", "D", "FW", [[-440, 20]]);
R("hc-1", "Hillcrest Drive", "avenue", "H", "H2", [[-270, 450]]);
R("hc-2", "Hillcrest Drive", "avenue", "H2", "FNW", [[-330, 590], [-300, 660], [-370, 690]]);

// Cross streets.
R("cath", "Cathedral Street", "street", "O1", "O2", [[200, 735], [400, 680]]);
R("elm", "Elm Crescent", "street", "O1", "H2", [[-60, 680], [-220, 610]]);
R("smelt", "Smelter Way", "street", "I1", "I2", [[830, 0], [780, -220]]);
R("canal", "Canal Street", "street", "S1", "S2", [[0, -560], [-170, -520]]);
R("mill", "Mill Street", "street", "S1", "I2", [[300, -520], [500, -440]]);

// South coast.
N("BCH", -390, -780, "priority", "Sunset Beach");
N("P1", 650, -790, "priority", "Port Fairbay");
R("ocean", "Ocean Drive", "coast", "FS", "BCH", [[20, -790], [-200, -835]]);
R("coast-1", "Coast Highway", "coast", "FSW", "BCH", [[-380, -690]], true);
R("coast-2", "Coast Highway", "coast", "BCH", "W2", [[-480, -840], [-590, -860], [-720, -820], [-860, -700]], true);
R("hfront", "Harbor Front", "avenue", "FS", "P1", [[300, -760], [480, -795]]);
R("dock", "Dock Street", "avenue", "P1", "FSE", [[860, -760], [935, -620]]);

// Westside (across the Fair River).
N("W1", -950, 110, "signal");
N("W3", -1000, -200, "priority");
N("W2", -930, -500, "priority");
R("bridge-n", "Riverside Bridge", "boulevard", "FW", "W1", [[-720, 70], [-850, 96]]);
R("wa-1", "Westside Avenue", "street", "W1", "W3", [[-990, -40]], true);
R("wa-2", "Westside Avenue", "street", "W3", "W2", [[-975, -360]], true);
R("maple", "Maple Loop", "street", "W3", "W3", [[-1110, -110], [-1190, -250], [-1110, -380]]);

// Mount Calder hairpins: Hillcrest -> summit -> Westside.
N("SU", -860, 1010, "priority", "Calder Summit");
R("mt-up", "Calder Pass", "mountain", "FNW", "SU", [
  [-470, 820],
  [-560, 860],
  [-640, 835],
  [-690, 885],
  [-620, 945],
  [-560, 995],
  [-640, 1055],
  [-760, 1065],
]);
R("mt-down", "Calder Pass", "mountain", "SU", "W1", [
  [-960, 965],
  [-1040, 860],
  [-1000, 760],
  [-1080, 640],
  [-1025, 500],
  [-1065, 380],
  [-995, 250],
]);
// A short spur to the summit lookout keeps SU a real junction.
N("LOOK", -760, 1180, "priority", "Calder Lookout");
R("look", "Lookout Road", "mountain", "SU", "LOOK", [[-880, 1080], [-830, 1150]]);

export const NODES: readonly NodeDef[] = nodes;
export const ROADS: readonly RoadDef[] = roads;

// ---------------------------------------------------------------------------
// Water and land
// ---------------------------------------------------------------------------

/** Fair River centreline from the Calder spring lake to the sea. */
export const RIVER: [number, number][] = [
  [-720, 730],
  [-760, 560],
  [-770, 400],
  [-735, 180],
  [-725, 0],
  [-690, -250],
  [-650, -450],
  [-612, -700],
  [-588, -880],
  [-575, -1060],
];
export const RIVER_HALF = 19;
export const LAKE = { e: -720, n: 730, r: 55 };

/** Coastline (E, N), west to east. The sea lies south of it. */
export const COAST: [number, number][] = [
  [-1400, -700],
  [-1100, -760],
  [-900, -860],
  [-700, -930],
  [-575, -965],
  [-400, -935],
  [-200, -912],
  [0, -900],
  [200, -925],
  [400, -935],
  [600, -935],
  [800, -925],
  [1000, -895],
  [1400, -860],
];

export const WATER_LEVEL = -1.4;
export const WORLD_HALF = 1300;

/** Mount Calder. */
export const MOUNTAIN = { e: -860, n: 1010, height: 135, sigma: 240 };

export type District =
  | "downtown"
  | "midtown"
  | "park"
  | "oldtown"
  | "hillcrest"
  | "ironworks"
  | "port"
  | "southside"
  | "beach"
  | "westside"
  | "highlands";

export const DISTRICT_NAMES: Record<District, string> = {
  downtown: "Downtown",
  midtown: "Midtown",
  park: "Central Park",
  oldtown: "Old Town",
  hillcrest: "Hillcrest",
  ironworks: "Ironworks",
  port: "Port Fairbay",
  southside: "Southside",
  beach: "Sunset Beach",
  westside: "Westside",
  highlands: "Mount Calder",
};

/** Central Park: the wedge between Parkway and Liberty, Crescent to Ring Road. */
export const PARK_POLY: [number, number][] = [
  [96, 300],
  [80, 390],
  [68, 470],
  [-80, 440],
  [-200, 360],
  [-140, 290],
  [-62, 215],
  [18, 270],
];

/** Off-road jump ramps (never in a traffic lane): position, heading (deg, 0 = north, CW to east), size. */
export const RAMPS: { e: number; n: number; bearing: number; length: number; height: number; width: number; label: string }[] = [
  { e: -660, n: -110, bearing: 262, length: 14, height: 3.2, width: 9, label: "River jump" },
  { e: -300, n: -870, bearing: 270, length: 11, height: 2.4, width: 8, label: "Beach kicker" },
  { e: 470, n: -860, bearing: 90, length: 12, height: 2.8, width: 8, label: "Quay launch" },
  { e: 760, n: -110, bearing: 0, length: 10, height: 2.3, width: 7, label: "Smelter ramp" },
  { e: -60, n: 370, bearing: 300, length: 9, height: 2.0, width: 7, label: "Park hop" },
  { e: -1110, n: 520, bearing: 200, length: 10, height: 2.6, width: 8, label: "Calder drop" },
  { e: 330, n: 820, bearing: 80, length: 10, height: 2.4, width: 7, label: "Old Town gap" },
];

export const toWorld = (e: number, n: number): V2 => ({ x: -e, z: n });
export const toMapEN = (x: number, z: number): [number, number] => [-x, z];
