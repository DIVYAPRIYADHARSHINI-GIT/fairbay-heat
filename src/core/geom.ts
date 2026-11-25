/**
 * 2D geometry on the XZ ground plane: smooth polylines (centripetal
 * Catmull-Rom), projection onto polylines, oriented boxes, and the
 * intersection tests used by the road network, collision and placement.
 *
 * Conventions: a direction (tx, tz) has its RIGHT-hand side at (-tz, tx).
 * (With +Z north, +X is west, so facing north the right is east = -X.)
 */

export interface V2 {
  x: number;
  z: number;
}

export const v2 = (x: number, z: number): V2 => ({ x, z });

export function dist(a: V2, b: V2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Heading angle (0 = +Z, positive = turning left/towards +X) of a direction. */
export function headingOf(tx: number, tz: number): number {
  return Math.atan2(tx, tz);
}

/**
 * Samples a centripetal Catmull-Rom spline through `pts` at roughly
 * `spacing` metres. Endpoints are included exactly.
 */
export function catmullRom(pts: V2[], spacing: number): V2[] {
  if (pts.length < 3) {
    const out: V2[] = [];
    const a = pts[0];
    const b = pts[pts.length - 1];
    const n = Math.max(1, Math.ceil(dist(a, b) / spacing));
    for (let i = 0; i <= n; i++) out.push({ x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n });
    return out;
  }
  const P = [
    { x: 2 * pts[0].x - pts[1].x, z: 2 * pts[0].z - pts[1].z },
    ...pts,
    { x: 2 * pts[pts.length - 1].x - pts[pts.length - 2].x, z: 2 * pts[pts.length - 1].z - pts[pts.length - 2].z },
  ];
  const out: V2[] = [{ ...pts[0] }];
  for (let i = 1; i < P.length - 2; i++) {
    const p0 = P[i - 1];
    const p1 = P[i];
    const p2 = P[i + 1];
    const p3 = P[i + 2];
    const t0 = 0;
    const t1 = t0 + Math.sqrt(Math.max(1e-6, dist(p0, p1)));
    const t2 = t1 + Math.sqrt(Math.max(1e-6, dist(p1, p2)));
    const t3 = t2 + Math.sqrt(Math.max(1e-6, dist(p2, p3)));
    const n = Math.max(1, Math.ceil(dist(p1, p2) / spacing));
    for (let k = 1; k <= n; k++) {
      const t = t1 + ((t2 - t1) * k) / n;
      const A1 = lerp2(p0, p1, (t1 - t) / (t1 - t0), (t - t0) / (t1 - t0));
      const A2 = lerp2(p1, p2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1));
      const A3 = lerp2(p2, p3, (t3 - t) / (t3 - t2), (t - t2) / (t3 - t2));
      const B1 = lerp2(A1, A2, (t2 - t) / (t2 - t0), (t - t0) / (t2 - t0));
      const B2 = lerp2(A2, A3, (t3 - t) / (t3 - t1), (t - t1) / (t3 - t1));
      out.push(lerp2(B1, B2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1)));
    }
  }
  return out;
}

function lerp2(a: V2, b: V2, wa: number, wb: number): V2 {
  return { x: a.x * wa + b.x * wb, z: a.z * wa + b.z * wb };
}

export interface PolySample {
  x: number;
  z: number;
  /** Unit tangent. */
  tx: number;
  tz: number;
  /** Segment index and fraction. */
  i: number;
  f: number;
}

export interface Projection {
  s: number;
  /** Signed lateral offset, positive to the RIGHT of the direction of travel. */
  lat: number;
  dist: number;
  i: number;
  f: number;
}

/** An arc-length parameterised polyline. */
export class Polyline {
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly s: Float64Array;
  readonly n: number;
  readonly length: number;

  constructor(pts: V2[]) {
    // Drop duplicate consecutive points.
    const clean: V2[] = [];
    for (const p of pts) {
      const last = clean[clean.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.z - last.z) > 1e-4) clean.push(p);
    }
    if (clean.length < 2) clean.push({ x: clean[0].x + 1e-3, z: clean[0].z });
    this.n = clean.length;
    this.x = new Float64Array(this.n);
    this.z = new Float64Array(this.n);
    this.s = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      this.x[i] = clean[i].x;
      this.z[i] = clean[i].z;
      if (i > 0) this.s[i] = this.s[i - 1] + Math.hypot(this.x[i] - this.x[i - 1], this.z[i] - this.z[i - 1]);
    }
    this.length = this.s[this.n - 1];
  }

  /** Index of the segment containing arc length s (binary search). */
  segmentAt(s: number): number {
    if (s <= 0) return 0;
    if (s >= this.length) return this.n - 2;
    let lo = 0;
    let hi = this.n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.s[m] <= s) lo = m;
      else hi = m;
    }
    return lo;
  }

  sample(s: number, out: PolySample = { x: 0, z: 0, tx: 0, tz: 1, i: 0, f: 0 }): PolySample {
    const i = this.segmentAt(s);
    const L = this.s[i + 1] - this.s[i];
    const f = L > 0 ? Math.min(1, Math.max(0, (s - this.s[i]) / L)) : 0;
    const dx = this.x[i + 1] - this.x[i];
    const dz = this.z[i + 1] - this.z[i];
    out.x = this.x[i] + dx * f;
    out.z = this.z[i] + dz * f;
    const l = Math.hypot(dx, dz) || 1;
    out.tx = dx / l;
    out.tz = dz / l;
    out.i = i;
    out.f = f;
    return out;
  }

  /** Smooth tangent at s (blends neighbouring segments near vertices). */
  tangent(s: number): { tx: number; tz: number } {
    const a = this.sample(Math.max(0, s - 1.5));
    const b = this.sample(Math.min(this.length, s + 1.5));
    let tx = b.x - a.x;
    let tz = b.z - a.z;
    const l = Math.hypot(tx, tz);
    if (l < 1e-6) {
      const p = this.sample(s);
      return { tx: p.tx, tz: p.tz };
    }
    tx /= l;
    tz /= l;
    return { tx, tz };
  }

  /** Projection of a point onto segment i. */
  projectSegment(px: number, pz: number, i: number): Projection {
    const ax = this.x[i];
    const az = this.z[i];
    const dx = this.x[i + 1] - ax;
    const dz = this.z[i + 1] - az;
    const L2 = dx * dx + dz * dz || 1e-9;
    let f = ((px - ax) * dx + (pz - az) * dz) / L2;
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    const cx = ax + dx * f;
    const cz = az + dz * f;
    const L = Math.sqrt(L2);
    // Right of (dx,dz) is (-dz, dx).
    const lat = ((px - cx) * -dz + (pz - cz) * dx) / L;
    return { s: this.s[i] + L * f, lat, dist: Math.hypot(px - cx, pz - cz), i, f };
  }

  project(px: number, pz: number): Projection {
    let best: Projection | null = null;
    for (let i = 0; i < this.n - 1; i++) {
      const p = this.projectSegment(px, pz, i);
      if (!best || p.dist < best.dist) best = p;
    }
    return best!;
  }

  /** Points offset `off` to the right, between arc lengths s0..s1 (inclusive ends). */
  offsetRange(off: number, s0: number, s1: number): V2[] {
    const out: V2[] = [];
    const push = (s: number) => {
      const p = this.sample(s);
      const t = this.tangent(s);
      out.push({ x: p.x - t.tz * off, z: p.z + t.tx * off });
    };
    push(s0);
    for (let i = 0; i < this.n; i++) if (this.s[i] > s0 + 0.5 && this.s[i] < s1 - 0.5) push(this.s[i]);
    push(s1);
    return out;
  }

  reversed(): Polyline {
    const pts: V2[] = [];
    for (let i = this.n - 1; i >= 0; i--) pts.push({ x: this.x[i], z: this.z[i] });
    return new Polyline(pts);
  }

  /** Signed curvature (1/m) at vertex i (0 at the ends). */
  curvature(i: number): number {
    if (i <= 0 || i >= this.n - 1) return 0;
    const ax = this.x[i] - this.x[i - 1];
    const az = this.z[i] - this.z[i - 1];
    const bx = this.x[i + 1] - this.x[i];
    const bz = this.z[i + 1] - this.z[i];
    const la = Math.hypot(ax, az);
    const lb = Math.hypot(bx, bz);
    if (la < 1e-6 || lb < 1e-6) return 0;
    const cross = ax * bz - az * bx;
    const dot = ax * bx + az * bz;
    return Math.atan2(cross, dot) / ((la + lb) / 2);
  }
}

// ---- segments ----------------------------------------------------------------

/** Proper intersection of segments ab and cd (touching endpoints excluded by eps). */
export function segmentsIntersect(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number, eps = 1e-9): boolean {
  const d1 = cross3(cx, cz, dx, dz, ax, az);
  const d2 = cross3(cx, cz, dx, dz, bx, bz);
  const d3 = cross3(ax, az, bx, bz, cx, cz);
  const d4 = cross3(ax, az, bx, bz, dx, dz);
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

function cross3(ax: number, az: number, bx: number, bz: number, px: number, pz: number): number {
  return (bx - ax) * (pz - az) - (bz - az) * (px - ax);
}

export function pointSegmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const L2 = dx * dx + dz * dz || 1e-9;
  let t = ((px - ax) * dx + (pz - az) * dz) / L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

// ---- polygons ----------------------------------------------------------------

export function pointInPolygon(x: number, z: number, poly: readonly V2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

export function convexHull(points: V2[]): V2[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  if (p.length < 3) return p;
  const cross = (o: V2, a: V2, b: V2) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: V2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: V2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

// ---- oriented boxes ------------------------------------------------------------

/** Oriented rectangle: half extents hx along axis (c, s), hz along (-s, c). */
export interface OBB {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  c: number;
  s: number;
}

export function obb(cx: number, cz: number, hx: number, hz: number, angle: number): OBB {
  return { cx, cz, hx, hz, c: Math.cos(angle), s: Math.sin(angle) };
}

export function obbCorners(b: OBB): V2[] {
  const ux = b.c * b.hx;
  const uz = b.s * b.hx;
  const vx = -b.s * b.hz;
  const vz = b.c * b.hz;
  return [
    { x: b.cx + ux + vx, z: b.cz + uz + vz },
    { x: b.cx - ux + vx, z: b.cz - uz + vz },
    { x: b.cx - ux - vx, z: b.cz - uz - vz },
    { x: b.cx + ux - vx, z: b.cz + uz - vz },
  ];
}

/** Separating-axis overlap test for two oriented rectangles. */
export function obbOverlap(a: OBB, b: OBB): boolean {
  const axes = [
    [a.c, a.s],
    [-a.s, a.c],
    [b.c, b.s],
    [-b.s, b.c],
  ];
  const dx = b.cx - a.cx;
  const dz = b.cz - a.cz;
  for (const [ax, az] of axes) {
    const ra = a.hx * Math.abs(a.c * ax + a.s * az) + a.hz * Math.abs(-a.s * ax + a.c * az);
    const rb = b.hx * Math.abs(b.c * ax + b.s * az) + b.hz * Math.abs(-b.s * ax + b.c * az);
    if (Math.abs(dx * ax + dz * az) > ra + rb) return false;
  }
  return true;
}

export function pointInOBB(x: number, z: number, b: OBB): boolean {
  const dx = x - b.cx;
  const dz = z - b.cz;
  return Math.abs(dx * b.c + dz * b.s) <= b.hx && Math.abs(-dx * b.s + dz * b.c) <= b.hz;
}
