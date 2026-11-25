/**
 * Hand-authored map of Fairbay (not a grid).
 *
 * Authored in (E, N) metres - east and north - which is how a map is read.
 * The game world uses x = -E, z = N (see `toWorld`), because heading 0 faces
 * +Z and a positive heading turns left towards +X.
 *
 * An asymmetric open-world layout in the spirit of GTA / NFS Most Wanted:
 *   - Downtown towers on the waterfront of Fairbay Bay (south-centre).
 *   - Interstate 9 crosses the map west-east on an ELEVATED VIADUCT through
 *     Midtown, with one-way frontage (service) roads underneath on both
 *     sides and on/off ramps at each end; Midtown avenues pass under it.
 *   - Route 7 Bayshore Expressway runs north from the Port to I-9.
 *   - The Coast Highway runs west along Sunset Beach, over the river mouth.
 *   - Old Town (winding streets, a small roundabout square, Central Park),
 *     Hillcrest suburbs, Ridge Parkway along the northern hills, the
 *     Fairbay Airfield with a runway, Ironworks and the container Port.
 *   - The Fair River with bridges to Westside, and the Calder Pass hairpins
 *     over Mount Calder.
 * Where a highway crosses a street without a junction, the road network
 * automatically lifts the highway onto an overpass.
 */

import type { V2 } from "../core/geom";

export type RoadClass = "freeway" | "ramp" | "boulevard" | "avenue" | "street" | "service" | "mountain" | "coast" | "ring" | "runway";

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
  /** One-way freeway on/off ramp (slip road). */
  ramp: { lanes: 1, laneWidth: 4.0, median: 0, shoulder: 1.8, speed: 17, oneWay: true, sidewalk: false, barriers: false, rails: true, lamps: "one" },
  /** One-way frontage / service road running alongside a highway. */
  service: { lanes: 2, laneWidth: 3.4, median: 0, shoulder: 1.0, speed: 13, oneWay: true, sidewalk: true, barriers: false, rails: false, lamps: "one" },
  /** Airfield runway: a 46 m wide, dead-flat straight - the top-speed strip. */
  runway: { lanes: 1, laneWidth: 18, median: 4, shoulder: 3, speed: 14, oneWay: false, sidewalk: false, barriers: false, rails: false, lamps: "none" },
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
  /** Fixed deck height above the natural ground (overpass / elevated junction). */
  lift?: number;
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
// Helpers
// ---------------------------------------------------------------------------

const nodes: NodeDef[] = [];
const roads: RoadDef[] = [];
const N = (id: string, e: number, n: number, kind: JunctionKind, label?: string) => nodes.push({ id, e, n, kind, label });
const R = (id: string, name: string, cls: RoadClass, from: string, to: string, via: [number, number][] = [], main = false) =>
  roads.push({ id, name, cls, from, to, via, main });

/** Interstate 9 through Midtown runs on a straight viaduct line. */
const I9 = (e: number): [number, number] => [e, -40 - 0.0787 * (e + 470)];
/** Frontage roads run 28 m either side of the I-9 viaduct. */
const FN = (e: number): [number, number] => [e, I9(e)[1] + 28];
const FS = (e: number): [number, number] => [e, I9(e)[1] - 28];
const NE = (id: string, p: [number, number], kind: JunctionKind, label?: string) => N(id, p[0], p[1], kind, label);

// ---------------------------------------------------------------------------
// Fairbay Circle - a small 4-exit roundabout in the Old Town square
// ---------------------------------------------------------------------------

export const CIRCLE = { e: -40, n: 400, r: 34, island: 24 };

const EXITS: [string, number][] = [
  ["E", 0],
  ["N", 90],
  ["W", 180],
  ["S", 270],
];

const polar = (deg: number, r: number, c = CIRCLE): [number, number] => [c.e + r * Math.cos((deg * Math.PI) / 180), c.n + r * Math.sin((deg * Math.PI) / 180)];

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
// Highways
// ---------------------------------------------------------------------------

// Interstate 9: Westside -> over the Fair River -> elevated through Midtown
// -> north-east past Ironworks -> the Airfield.
N("W9", -980, -150, "priority", "Westside Interchange");
N("X1", -470, -40, "priority", "Midtown West Interchange");
N("X2", 610, -125, "priority", "Midtown East Interchange");
N("J79", 770, 30, "priority", "Bayshore Interchange");
N("N9", 900, 430, "priority", "Airfield Interchange");
R("i9-1", "Interstate 9", "freeway", "W9", "X1", [[-860, -120], [-720, -70], [-600, -50]], true);
R("i9-2", "Interstate 9", "freeway", "X1", "X2", [I9(-200), I9(100), I9(400)], true);
R("i9-3", "Interstate 9", "freeway", "X2", "J79", [[700, -70]], true);
R("i9-4", "Interstate 9", "freeway", "J79", "N9", [[850, 180], [900, 320]], true);

// Route 7 Bayshore Expressway: the Port -> Ironworks -> I-9.
N("R7S", 830, -620, "priority", "Port Interchange");
N("R7M", 800, -320, "priority", "Foundry Interchange");
R("r7-1", "Bayshore Expressway", "freeway", "R7S", "R7M", [[820, -470]], true);
R("r7-2", "Bayshore Expressway", "freeway", "R7M", "J79", [[790, -150]], true);

// I-9 frontage (service) roads along the Midtown viaduct, with on/off ramps.
// Eastbound runs on the south side, westbound on the north side.
const AV = [-250, -60, 130, 320, 470]; // Midtown avenues passing under I-9
NE("SF0", FS(-330), "priority");
NE("NF0", FN(-330), "priority");
AV.forEach((e, i) => {
  NE(`SF${i + 1}`, FS(e), "signal");
  NE(`NF${i + 1}`, FN(e), "signal");
});
R("ramp-x1-eb", "I-9 Exit 4", "ramp", "X1", "SF0", [[-400, -62]]);
R("ramp-x1-wb", "I-9 Entrance 4", "ramp", "NF0", "X1", [[-400, -18]]);
R("ramp-x2-eb", "I-9 Entrance 7", "ramp", "SF5", "X2", [[545, -150]]);
R("ramp-x2-wb", "I-9 Exit 7", "ramp", "X2", "NF5", [[545, -100]]);
R("sf-0", "Midtown Frontage Road", "service", "SF0", "SF1");
R("nf-0", "Midtown Frontage Road", "service", "NF1", "NF0");
for (let i = 1; i < AV.length; i++) {
  R(`sf-${i}`, "Midtown Frontage Road", "service", `SF${i}`, `SF${i + 1}`);
  R(`nf-${i}`, "Midtown Frontage Road", "service", `NF${i + 1}`, `NF${i}`);
}

// ---------------------------------------------------------------------------
// Midtown (between I-9 and Downtown) - irregular blocks, a diagonal avenue
// ---------------------------------------------------------------------------

N("K1", -250, -250, "signal");
N("K2", -60, -270, "signal");
N("K3", 130, -250, "signal");
N("K4", 320, -235, "signal");
N("K5", 470, -270, "signal");
N("G2", -60, -335, "signal");
N("G3", 130, -310, "signal");
N("U1", -250, -410, "signal");
N("U2", -60, -420, "signal");
N("U3", 130, -405, "signal");
N("U4", 320, -420, "signal");
N("U5", 470, -400, "signal");

// Avenues (north-south, each with its own gentle tilt).
R("a1-0", "Riverside Avenue", "avenue", "NF1", "SF1");
R("a1-1", "Riverside Avenue", "avenue", "SF1", "K1");
R("a1-2", "Riverside Avenue", "avenue", "K1", "U1");
R("main-0", "Main Street", "boulevard", "NF2", "SF2");
R("main-1", "Main Street", "boulevard", "SF2", "K2");
R("main-2", "Main Street", "boulevard", "K2", "G2");
R("main-3", "Main Street", "boulevard", "G2", "U2");
R("a3-0", "Lexington Avenue", "avenue", "NF3", "SF3");
R("a3-1", "Lexington Avenue", "avenue", "SF3", "K3");
R("a3-2", "Lexington Avenue", "avenue", "K3", "G3");
R("a3-3", "Lexington Avenue", "avenue", "G3", "U3");
R("a4-0", "Commerce Avenue", "avenue", "NF4", "SF4");
R("a4-1", "Commerce Avenue", "avenue", "SF4", "K4");
R("a4-2", "Commerce Avenue", "avenue", "K4", "U4");
R("a5-0", "Harbor Avenue", "avenue", "NF5", "SF5");
R("a5-1", "Harbor Avenue", "avenue", "SF5", "K5");
R("a5-2", "Harbor Avenue", "avenue", "K5", "U5");

// Kingsway - a long, slightly curving cross-town street.
N("RV2", -590, -250, "signal");
R("kings-1", "Kingsway", "avenue", "RV2", "K1", [[-420, -238]]);
R("kings-2", "Kingsway", "avenue", "K1", "K2", [[-155, -268]]);
R("kings-3", "Kingsway", "avenue", "K2", "K3", [[35, -262]]);
R("kings-4", "Kingsway", "avenue", "K3", "G4");
R("kings-5", "Kingsway", "avenue", "G4", "K4");
R("kings-6", "Kingsway", "avenue", "K4", "K5", [[400, -258]]);
// Grand Avenue continues north-east from Kingsway to the frontage road.
R("grand-4", "Grand Avenue", "boulevard", "G4", "SF4", [[275, -190]]);

// Union Street.
N("S1", -450, -420, "signal");
R("union-0", "Union Street", "street", "S1", "U1");
R("union-1", "Union Street", "street", "U1", "U2");
R("union-2", "Union Street", "street", "U2", "U3");
R("union-3", "Union Street", "street", "U3", "U4");
R("union-4", "Union Street", "street", "U4", "U5");

// Grand Avenue - a diagonal boulevard cutting across the blocks.
R("grand-1", "Grand Avenue", "boulevard", "U1", "G2");
R("grand-2", "Grand Avenue", "boulevard", "G2", "G3");
// Grand Avenue meets Kingsway at its own junction, 110 m east of Lexington.
N("G4", 240, -244, "signal");
R("grand-3", "Grand Avenue", "boulevard", "G3", "G4", [[190, -285]]);

// ---------------------------------------------------------------------------
// Downtown waterfront
// ---------------------------------------------------------------------------

N("D11", -60, -560, "signal");
N("D12", 110, -580, "signal");
N("D13", 250, -590, "signal");
N("D14", 380, -600, "signal");
N("D21", -60, -700, "signal");
N("D22", 100, -720, "signal");
N("D23", 240, -730, "signal");
N("W1", -60, -880, "signal");
N("W2", 100, -850, "signal");
N("W3", 250, -805, "signal");
N("W4", 440, -680, "signal");
N("S2", -260, -620, "signal");
N("S3", -270, -750, "signal");

R("main-4", "Main Street", "boulevard", "U2", "D11");
R("main-5", "Main Street", "boulevard", "D11", "D21");
R("main-6", "Main Street", "boulevard", "D21", "W1");
R("a3-4", "Lexington Avenue", "avenue", "U3", "D12");
R("a3-5", "Lexington Avenue", "avenue", "D12", "D22");
R("a3-6", "Lexington Avenue", "avenue", "D22", "W2");
R("a4-3", "Commerce Avenue", "avenue", "U4", "D13", [[290, -505]]);
R("a4-4", "Commerce Avenue", "avenue", "D13", "D23");
R("a4-5", "Commerce Avenue", "avenue", "D23", "W3");
R("bay-st", "Bay Street", "avenue", "U5", "D14", [[430, -500]]);
R("bay-st-2", "Bay Street", "avenue", "D14", "W4");
R("market-0", "Market Street", "street", "S2", "D11", [[-160, -585]]);
R("market-1", "Market Street", "street", "D11", "D12");
R("market-2", "Market Street", "street", "D12", "D13");
R("market-3", "Market Street", "street", "D13", "D14");
R("harbor-0", "Harbor Street", "street", "S3", "D21", [[-165, -722]]);
R("harbor-1", "Harbor Street", "street", "D21", "D22");
R("harbor-2", "Harbor Street", "street", "D22", "D23");
R("water-1", "Waterfront Drive", "boulevard", "W1", "W2", [[20, -870]]);
R("water-2", "Waterfront Drive", "boulevard", "W2", "W3", [[175, -832]]);
R("water-3", "Waterfront Drive", "boulevard", "W3", "W4", [[340, -752]]);
R("baydr", "Bay Drive", "boulevard", "W4", "R7S", [[570, -700], [700, -690]]);

// ---------------------------------------------------------------------------
// Southside and Sunset Beach
// ---------------------------------------------------------------------------

N("S4", -470, -650, "signal");
N("BCH", -300, -860, "priority", "Sunset Beach");
N("CH2", -520, -800, "priority");
R("ocean-1", "Ocean Avenue", "avenue", "U1", "S2", [[-252, -515]]);
R("ocean-2", "Ocean Avenue", "avenue", "S2", "S3");
R("ocean-3", "Ocean Avenue", "avenue", "S3", "BCH", [[-285, -805]]);
R("beach-rd", "Sunset Boulevard", "coast", "BCH", "W1", [[-180, -905], [-110, -895]]);
R("palm", "Palm Street", "street", "S4", "S3", [[-370, -705]]);
R("riverside-s", "Riverbank Road", "street", "RV2", "S1", [[-540, -340]]);
R("south-1", "Southside Road", "street", "S1", "S4", [[-475, -540]]);
R("south-2", "Southside Road", "street", "S4", "CH2", [[-490, -730]]);
R("coast-1", "Coast Highway", "coast", "CH2", "BCH", [[-410, -840]], true);

// ---------------------------------------------------------------------------
// Westside (across the Fair River) and the coast highway
// ---------------------------------------------------------------------------

N("WS", -960, -520, "priority");
N("WM", -1000, 30, "signal");
N("WN", -990, 200, "priority");
R("coast-w", "Coast Highway", "coast", "WS", "CH2", [[-860, -740], [-700, -800]], true);
R("westside-s", "Westside Avenue", "avenue", "WS", "W9", [[-990, -340]]);
R("westside-m", "Westside Avenue", "avenue", "W9", "WM", [[-995, -60]]);
R("westside-n", "Westside Avenue", "avenue", "WM", "WN", [[-1000, 120]]);
R("maple", "Maple Drive", "street", "WM", "W9", [[-1110, 10], [-1160, -90], [-1080, -175]]);

// ---------------------------------------------------------------------------
// North of I-9: Park Row, Central Park, Old Town
// ---------------------------------------------------------------------------

N("RV1", -600, 40, "signal");
N("O1", -250, 120, "signal");
N("O2", -60, 140, "signal");
N("O3", 130, 130, "signal");
N("O4", 320, 110, "signal");
N("O9", 520, 80, "signal");
R("riverside-n", "Riverbank Road", "street", "RV1", "RV2", [[-610, -120]]);
R("parkrow-0", "Park Row", "avenue", "RV1", "O1", [[-430, 90]]);
R("parkrow-1", "Park Row", "avenue", "O1", "O2");
R("parkrow-2", "Park Row", "avenue", "O2", "O3");
R("parkrow-3", "Park Row", "avenue", "O3", "O4");
R("parkrow-4", "Park Row", "avenue", "O4", "O9", [[420, 100]]);
R("a1-n", "Riverside Avenue", "avenue", "O1", "NF1");
R("main-n", "Main Street", "boulevard", "O2", "NF2");
R("a3-n", "Lexington Avenue", "avenue", "O3", "NF3");
R("a4-n", "Commerce Avenue", "avenue", "O4", "NF4");
R("a5-n", "Harbor Avenue", "avenue", "O9", "NF5");

N("O5", 200, 430, "signal");
N("O6", -230, 410, "signal");
N("O7", -20, 600, "signal");
N("O8", 380, 430, "signal");
N("O10", 600, 350, "signal");
R("cathedral", "Cathedral Road", "avenue", "O2", "rb-S", [[-55, 250]]);
R("queen-w", "Queen Street", "street", "rb-E", "O5", [[100, 418]]);
R("queen", "Queen Street", "street", "O5", "O8", [[290, 440]]);
R("parkside", "Parkside Drive", "street", "O3", "O5", [[150, 280]]);
R("parkeast", "Park East Drive", "street", "O4", "O8", [[355, 280]]);
R("oldmill", "Old Mill Road", "street", "O6", "O1", [[-215, 260]]);
R("bell-w", "Bell Lane", "street", "rb-W", "O6", [[-150, 395]]);
R("chapel", "Chapel Street", "street", "rb-N", "O7", [[-45, 510]]);
R("eastgate", "Eastgate Road", "avenue", "O9", "O10", [[575, 210]]);
R("tannery", "Tannery Lane", "street", "O8", "O10", [[490, 405]]);
R("airport-rd", "Airport Road", "avenue", "O10", "N9", [[760, 370]]);

// ---------------------------------------------------------------------------
// Hillcrest suburbs, Ridge Parkway, the Airfield
// ---------------------------------------------------------------------------

N("H0", -470, 240, "signal");
N("H1", -420, 430, "signal");
N("H2", -560, 520, "priority");
N("H3", -330, 560, "priority");
N("RP2", 430, 690, "signal");
N("RP3", 60, 720, "signal");
N("RP4", -280, 680, "priority");
N("RP5", -480, 620, "priority");
R("hill-rd", "Hill Road", "street", "O1", "H0", [[-360, 190]]);
R("hc-1", "Hillcrest Drive", "street", "RV1", "H0", [[-560, 150]]);
R("hc-2", "Hillcrest Drive", "street", "H0", "H1", [[-470, 340]]);
R("hc-3", "Hillcrest Drive", "street", "O6", "H1", [[-320, 445]]);
R("hc-4", "Hillcrest Drive", "street", "H1", "H2", [[-500, 450]]);
R("hc-5", "Lakeview Road", "street", "H2", "RP5");
R("hc-6", "Lakeview Road", "street", "H1", "H3", [[-390, 510]]);
R("bell", "Bell Lane", "street", "H3", "O7", [[-230, 610], [-110, 575]]);
R("rp-1", "Ridge Parkway", "boulevard", "N9", "RP2", [[720, 610], [560, 660]]);
R("rp-2", "Ridge Parkway", "boulevard", "RP2", "RP3", [[240, 735]]);
R("rp-3", "Ridge Parkway", "boulevard", "RP3", "RP4", [[-110, 715]]);
R("rp-4", "Ridge Parkway", "boulevard", "RP4", "RP5");
R("rp-o7", "North Road", "street", "O7", "RP3", [[30, 660]]);
R("rp-o8", "Hangar Way", "avenue", "O8", "RP2", [[410, 560]]);
R("rp-h3", "Crest Road", "street", "H3", "RP4");

N("AF1", 540, 860, "priority", "Fairbay Airfield");
N("AF2", 1000, 860, "priority");
N("AF5", 900, 640, "priority");
R("runway", "Runway 09/27", "runway", "AF1", "AF2");
R("af-rd", "Airfield Road", "avenue", "N9", "AF5");
R("taxi-e", "Taxiway Echo", "street", "AF5", "AF2", [[985, 720]]);
R("taxi-w", "Taxiway Whiskey", "street", "AF5", "AF1", [[720, 720], [600, 770]]);
R("hangar", "Hangar Road", "street", "AF1", "RP2", [[480, 770]]);

// ---------------------------------------------------------------------------
// Ironworks and Port Fairbay
// ---------------------------------------------------------------------------

N("F1", 620, -360, "signal");
N("F3", 980, -310, "priority");
R("foundry-w", "Foundry Road", "avenue", "U5", "F1", [[545, -385]]);
R("foundry-m", "Foundry Road", "avenue", "F1", "R7M");
R("foundry-e", "Foundry Road", "avenue", "R7M", "F3", [[890, -312]]);
R("steel", "Steel Street", "street", "F1", "K5", [[545, -310]]);
R("smelter", "Smelter Way", "avenue", "F3", "J79", [[985, -120], [900, 10]]);
R("port-rd", "Port Road", "avenue", "R7S", "F3", [[900, -790], [1030, -760], [1045, -560], [1010, -420]]);

// ---------------------------------------------------------------------------
// Mount Calder: hairpins from Hillcrest over the summit down to Westside
// ---------------------------------------------------------------------------

N("SU", -860, 1010, "priority", "Calder Summit");
R("mt-up", "Calder Pass", "mountain", "RP5", "SU", [
  [-470, 730],
  [-520, 830],
  [-620, 835],
  [-690, 885],
  [-620, 945],
  [-560, 995],
  [-640, 1055],
  [-760, 1065],
]);
R("mt-down", "Calder Pass", "mountain", "SU", "WN", [
  [-960, 965],
  [-1040, 860],
  [-1000, 760],
  [-1080, 640],
  [-1025, 500],
  [-1065, 380],
  [-1010, 290],
]);
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
  [-790, 400],
  [-760, 200],
  [-740, 0],
  [-720, -200],
  [-700, -420],
  [-680, -640],
  [-660, -820],
  [-650, -1000],
];
export const RIVER_HALF = 19;
export const LAKE = { e: -720, n: 730, r: 55 };

/**
 * Coastline (E, N), west to east. The sea lies south of it. Irregular on
 * purpose: Fairbay Bay bites into the coast below Downtown, a headland
 * holds the Port, and the shore swings north past Sunset Beach.
 */
export const COAST: [number, number][] = [
  [-1400, -660],
  [-1150, -700],
  [-950, -800],
  [-760, -880],
  [-640, -960],
  [-460, -930],
  [-300, -925],
  [-160, -960],
  [-40, -965],
  [90, -930],
  [220, -880],
  [330, -830],
  [470, -770],
  [560, -790],
  [650, -860],
  [800, -900],
  [960, -880],
  [1100, -840],
  [1400, -820],
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
  | "highlands"
  | "airfield";

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
  airfield: "Fairbay Airfield",
};

/** District regions as polygons (E, N); the first match wins. */
export const DISTRICT_POLYS: [District, [number, number][]][] = [
  ["downtown", [[-200, -480], [520, -480], [520, -660], [470, -760], [250, -830], [100, -880], [-120, -920], [-200, -900]]],
  ["midtown", [[-560, 40], [560, -40], [560, -480], [-560, -480]]],
  ["park", [[130, 150], [320, 130], [355, 420], [200, 430], [140, 300]]],
  ["oldtown", [[-300, 130], [600, 70], [640, 460], [300, 560], [-300, 640]]],
  ["airfield", [[380, 760], [1150, 760], [1150, 1000], [380, 1000]]],
  ["hillcrest", [[-640, 60], [-300, 130], [-300, 780], [-700, 780]]],
  ["ironworks", [[560, 60], [1150, 60], [1150, -560], [560, -560]]],
  ["port", [[520, -560], [1150, -560], [1150, -900], [520, -900]]],
  ["beach", [[-640, -760], [-200, -760], [-200, -1000], [-640, -1000]]],
  ["southside", [[-640, -480], [-200, -480], [-200, -760], [-640, -760]]],
];

/** Central Park: between Parkside and Park East, Park Row to Queen Street. */
export const PARK_POLY: [number, number][] = [
  [160, 160],
  [300, 140],
  [335, 300],
  [350, 410],
  [215, 412],
  [170, 300],
];

/** Off-road jump ramps (never in a traffic lane): position, heading (deg, 0 = north, CW to east), size. */
export const RAMPS: { e: number; n: number; bearing: number; length: number; height: number; width: number; label: string }[] = [
  { e: -650, n: -330, bearing: 268, length: 14, height: 3.2, width: 9, label: "River jump" },
  { e: -420, n: -900, bearing: 270, length: 11, height: 2.4, width: 8, label: "Beach kicker" },
  { e: 720, n: -770, bearing: 90, length: 12, height: 2.8, width: 8, label: "Quay launch" },
  { e: 900, n: -200, bearing: 0, length: 10, height: 2.3, width: 7, label: "Smelter ramp" },
  { e: 255, n: 330, bearing: 330, length: 9, height: 2.0, width: 7, label: "Park hop" },
  { e: -1110, n: 520, bearing: 200, length: 10, height: 2.6, width: 8, label: "Calder drop" },
  { e: 760, n: 900, bearing: 90, length: 16, height: 3.4, width: 10, label: "Runway launch" },
];

export const toWorld = (e: number, n: number): V2 => ({ x: -e, z: n });
export const toMapEN = (x: number, z: number): [number, number] => [-x, z];
