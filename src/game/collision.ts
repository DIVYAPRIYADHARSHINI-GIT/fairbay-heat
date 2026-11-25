/**
 * Static collision world: axis-aligned boxes (buildings, barriers) and circles
 * (trees, lamp posts, tanks) in the XZ plane, indexed by a uniform spatial
 * hash so a car only tests the handful of obstacles near it.
 */

export interface BoxCollider {
  kind: "box";
  id: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Height of the obstacle's top; a car flying higher passes over it. */
  top: number;
  /** Back face of a jump ramp: ignored by a car already driving up it. */
  ramp?: boolean;
}

export interface CircleCollider {
  kind: "circle";
  id: number;
  x: number;
  z: number;
  r: number;
  top: number;
  /** Breakable props (lamp posts) get knocked over instead of stopping the car. */
  breakable: boolean;
  broken: boolean;
}

export type Collider = BoxCollider | CircleCollider;

export interface Contact {
  /** Unit normal pointing from the obstacle towards the circle. */
  nx: number;
  nz: number;
  depth: number;
}

/** Penetration of a circle into a box, or null when they do not touch. */
export function circleVsBox(x: number, z: number, r: number, b: BoxCollider): Contact | null {
  const cx = x < b.minX ? b.minX : x > b.maxX ? b.maxX : x;
  const cz = z < b.minZ ? b.minZ : z > b.maxZ ? b.maxZ : z;
  const dx = x - cx;
  const dz = z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 > 0) {
    if (d2 >= r * r) return null;
    const d = Math.sqrt(d2);
    return { nx: dx / d, nz: dz / d, depth: r - d };
  }
  // Centre is inside the box: push out through the nearest face.
  const left = x - b.minX;
  const right = b.maxX - x;
  const top = z - b.minZ;
  const bottom = b.maxZ - z;
  const m = Math.min(left, right, top, bottom);
  if (m === left) return { nx: -1, nz: 0, depth: left + r };
  if (m === right) return { nx: 1, nz: 0, depth: right + r };
  if (m === top) return { nx: 0, nz: -1, depth: top + r };
  return { nx: 0, nz: 1, depth: bottom + r };
}

export function circleVsCircle(x: number, z: number, r: number, c: CircleCollider): Contact | null {
  const dx = x - c.x;
  const dz = z - c.z;
  const rr = r + c.r;
  const d2 = dx * dx + dz * dz;
  if (d2 >= rr * rr) return null;
  const d = Math.sqrt(d2);
  if (d < 1e-6) return { nx: 1, nz: 0, depth: rr };
  return { nx: dx / d, nz: dz / d, depth: rr - d };
}

export function collide(x: number, z: number, r: number, c: Collider): Contact | null {
  return c.kind === "box" ? circleVsBox(x, z, r, c) : circleVsCircle(x, z, r, c);
}

export class SpatialHash {
  private cells = new Map<number, Collider[]>();
  private stamp = new Map<number, number>();
  private queryId = 0;
  readonly all: Collider[] = [];

  constructor(readonly cellSize = 40) {}

  private key(ix: number, iz: number): number {
    return (ix + 2048) * 4096 + (iz + 2048);
  }

  add(c: Collider): void {
    this.all.push(c);
    const [minX, maxX, minZ, maxZ] =
      c.kind === "box" ? [c.minX, c.maxX, c.minZ, c.maxZ] : [c.x - c.r, c.x + c.r, c.z - c.r, c.z + c.r];
    const s = this.cellSize;
    for (let ix = Math.floor(minX / s); ix <= Math.floor(maxX / s); ix++) {
      for (let iz = Math.floor(minZ / s); iz <= Math.floor(maxZ / s); iz++) {
        const k = this.key(ix, iz);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(c);
      }
    }
  }

  /** Every collider whose cell overlaps the query square; each appears once. */
  query(x: number, z: number, r: number, out: Collider[] = []): Collider[] {
    out.length = 0;
    const id = ++this.queryId;
    const s = this.cellSize;
    for (let ix = Math.floor((x - r) / s); ix <= Math.floor((x + r) / s); ix++) {
      for (let iz = Math.floor((z - r) / s); iz <= Math.floor((z + r) / s); iz++) {
        const list = this.cells.get(this.key(ix, iz));
        if (!list) continue;
        for (const c of list) {
          if (this.stamp.get(c.id) === id) continue;
          this.stamp.set(c.id, id);
          out.push(c);
        }
      }
    }
    return out;
  }
}
