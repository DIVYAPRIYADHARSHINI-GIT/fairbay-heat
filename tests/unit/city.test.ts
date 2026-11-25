import { describe, expect, it } from "vitest";
import { City, CITY, CITY_EDGE, CURB, GRID, LINES, SEAWALL_Z, WORLD, roadWidth } from "../../src/game/city";
import { collide } from "../../src/game/collision";

const city = new City();

describe("city generation", () => {
  it("is deterministic for the same seed", () => {
    const again = new City();
    expect(again.buildings.length).toBe(city.buildings.length);
    expect(again.buildings[37]).toEqual(city.buildings[37]);
    expect(again.trees.length).toBe(city.trees.length);
  });

  it("has a full city: 144 blocks, hundreds of buildings, all six districts", () => {
    expect(city.blocks.length).toBe(4 * LINES * LINES);
    expect(city.buildings.length).toBeGreaterThan(300);
    const districts = new Set(city.blocks.map((b) => b.district));
    expect([...districts].sort()).toEqual(["downtown", "ironworks", "midtown", "northshore", "park", "port"]);
  });

  it("downtown towers are tall and Northshore houses are low", () => {
    const tall = city.buildings.filter((b) => b.style === "glass" || b.style === "office").map((b) => b.height);
    const houses = city.buildings.filter((b) => b.style === "house").map((b) => b.height);
    expect(Math.max(...tall)).toBeGreaterThan(100);
    expect(Math.max(...houses)).toBeLessThan(12);
  });

  it("no building collider intrudes onto any road", () => {
    for (const c of city.colliders.all) {
      if (c.kind !== "box" || c.top > 900 || c.ramp) continue;
      if (c.minZ <= SEAWALL_Z && c.maxZ >= SEAWALL_Z - 2) continue; // sea wall
      for (let i = -LINES; i <= LINES; i++) {
        const half = roadWidth(i) / 2;
        const x = i * GRID;
        // Box must not overlap the road strip along X = x...
        expect(c.maxX <= x - half || c.minX >= x + half).toBe(true);
        expect(c.maxZ <= x - half || c.minZ >= x + half).toBe(true);
      }
    }
  });

  it("every road intersection is clear of solid obstacles", () => {
    for (let i = -LINES; i <= LINES; i++) {
      for (let j = -LINES; j <= LINES; j++) {
        const x = i * GRID;
        const z = j * GRID;
        const near = city.colliders.query(x, z, 3);
        for (const c of near) {
          if (c.kind === "circle" && c.breakable) continue;
          expect(collide(x, z, 2.5, c)).toBeNull();
        }
      }
    }
  });

  it("the spawn point is on open road", () => {
    const s = City.SPAWN;
    expect(city.roadAt(s.x, s.z)).not.toBeNull();
    for (const c of city.colliders.query(s.x, s.z, 6)) expect(collide(s.x, s.z, 3, c)).toBeNull();
  });
});

describe("ground and surfaces", () => {
  it("roads are at 0, sidewalks/blocks are a curb above", () => {
    expect(city.ground(0, 60)).toBe(0); // on Main St
    const b = city.blocks.find((bl) => bl.district === "midtown")!;
    expect(city.ground(b.minX + 1, b.minZ + 1)).toBeCloseTo(CURB);
  });

  it("ramps raise the ground along their length", () => {
    const r = city.ramps[0];
    const fx = Math.sin(r.heading);
    const fz = Math.cos(r.heading);
    expect(city.ground(r.x + fx * 1, r.z + fz * 1)).toBeCloseTo(r.height * 0.1, 1);
    expect(city.ground(r.x + fx * (r.length - 0.01), r.z + fz * (r.length - 0.01))).toBeGreaterThan(r.height * 0.95);
  });

  it("hills rise outside the ring highway and the sea lies south of the sea wall", () => {
    let maxH = 0;
    for (let x = -WORLD; x <= WORLD; x += 40) maxH = Math.max(maxH, city.terrainAt(x, WORLD - 40));
    expect(maxH).toBeGreaterThan(25);
    expect(city.terrainAt(0, CITY_EDGE - 10)).toBe(0);
    expect(city.terrainAt(0, SEAWALL_Z - 60)).toBeLessThan(-5);
    expect(city.districtOf(0, SEAWALL_Z - 30)).toBe("sea");
  });

  it("park interiors and hills are off-road; streets are road", () => {
    const park = city.blocks.find((b) => b.district === "park")!;
    expect(city.surface((park.minX + park.maxX) / 2, (park.minZ + park.maxZ) / 2)).toBe("offroad");
    expect(city.surface(CITY + 200, 0)).toBe("offroad");
    expect(city.surface(0, 0)).toBe("road");
  });

  it("districtOf names the places", () => {
    expect(city.districtOf(10, 10)).toBe("downtown");
    expect(city.districtOf(0, CITY - 100)).toBe("northshore");
    expect(city.districtOf(0, CITY + 200)).toBe("hills");
  });
});
