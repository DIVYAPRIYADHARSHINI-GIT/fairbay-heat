/**
 * A scripted getaway driver for headless police tests: follows the road
 * network flat out, slows for each junction turn in time, prefers the
 * straightest exit (long roads are where you outrun the police), and backs
 * out if it gets wedged. Deterministic for a seed.
 */
import type { World } from "../../../src/game/world";
import type { CarPhysics, Controls } from "../../../src/game/physics";
import type { Road, RNode } from "../../../src/game/roads";
import { clamp, mulberry32, wrapAngle } from "../../../src/core/math";

export function getawayDriver(w: World, car: CarPhysics, vTop: number, seed = 1, straightBias = 0.85) {
  const rng = mulberry32(seed);
  const near = w.net.nearestRoad(car.x, car.z, 40, car.y)!;
  let road: Road = near.road;
  let dir: 1 | -1;
  {
    const t = road.center.tangent(near.s);
    dir = t.tx * Math.sin(car.heading) + t.tz * Math.cos(car.heading) >= 0 ? 1 : -1;
  }
  let next: { road: Road; dir: 1 | -1; turn: number } | null = null;
  let stuck = 0;
  let reverse = 0;
  const endNode = (): RNode => (dir > 0 ? road.to : road.from);
  const plan = () => {
    const node = endNode();
    const inT = road.center.tangent(dir > 0 ? road.length - 1 : 1);
    const inH = Math.atan2(inT.tx * dir, inT.tz * dir);
    const opts = node.ends
      .filter((e) => e.road !== road && e.road.cls !== "runway" && (e.atStart || !e.road.spec.oneWay))
      .map((e) => {
        const t = e.road.center.tangent(e.atStart ? 1 : e.road.length - 1);
        const d: 1 | -1 = e.atStart ? 1 : -1;
        const h = Math.atan2(t.tx * d, t.tz * d);
        return { road: e.road, dir: d, turn: Math.abs(wrapAngle(h - inH)) };
      })
      .sort((a, b) => a.turn - b.turn);
    if (!opts.length) return null;
    return rng() < straightBias ? opts[0] : opts[Math.floor(rng() * opts.length)];
  };
  next = plan();
  return (): Controls => {
    if (reverse > 0) {
      reverse -= 1 / 120;
      return { throttle: 0, brake: 1, steer: 0, handbrake: false, nitro: false };
    }
    const p = road.center.project(car.x, car.z);
    const node = endNode();
    const toNode = Math.hypot(node.x - car.x, node.z - car.z);
    if (toNode < Math.max(9, node.radius * 0.7) && next) {
      road = next.road;
      dir = next.dir;
      next = plan();
    } else if (!next && toNode < 12) {
      dir = dir > 0 ? -1 : 1;
      next = plan();
    }
    const look = 12 + car.speed * 0.45;
    const s = clamp(p.s + dir * look, 1, road.length - 1);
    const lat = road.spec.oneWay ? 0 : road.laneOffset(0) * dir;
    const tp = w.net.pointOn(road.id, s, lat);
    // Past the end of this road: aim into the junction / next road.
    const aim = (dir > 0 ? p.s + look > road.length - 1 : p.s - look < 1) ? { x: node.x, z: node.z } : tp;
    const err = wrapAngle(Math.atan2(aim.x - car.x, aim.z - car.z) - car.heading);
    // Corner speed for the next turn, braking in time (~7 m/s^2).
    const turn = next ? next.turn : Math.PI;
    const vCorner = turn < 0.25 ? vTop : turn < 0.6 ? 26 : turn < 1.2 ? 15 : 9;
    const vAllowed = Math.min(vTop, Math.sqrt(vCorner * vCorner + 2 * 7 * Math.max(0, toNode - 12)));
    const want = Math.abs(err) > 0.6 ? Math.min(vAllowed, 12) : vAllowed;
    const v = car.vLong;
    const ctl: Controls = { throttle: v < want ? 1 : 0, brake: v > want + 2 ? clamp((v - want) / 6, 0.3, 1) : 0, steer: clamp(err * 2.2, -1, 1), handbrake: false, nitro: false };
    stuck = ctl.throttle > 0 && car.speed < 1 ? stuck + 1 / 120 : 0;
    if (stuck > 1) {
      stuck = 0;
      reverse = 0.9;
    }
    return ctl;
  };
}
