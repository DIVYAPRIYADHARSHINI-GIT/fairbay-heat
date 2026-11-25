/**
 * Visual probe: loads the build, drives to named places on the map and
 * takes screenshots. Usage: node tests/probe.mjs [outDir]
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ROOT, serveDist, launch, gotoGame, snap, holdSim, waitSim, press } from "./harness.mjs";

const out = process.argv[2] ?? join(ROOT, "tests/out");
await mkdir(out, { recursive: true });
const { server, url } = await serveDist();
const { browser, page } = await launch();

/** Teleport into a lane of road `id` at fraction t. */
async function onRoad(id, t, lane = 0, hours = 13) {
  await page.evaluate(
    ({ id, t, lane, hours }) => {
      const g = window.__fh;
      const r = g.city.net.road(id);
      const s = r.s0 + (r.s1 - r.s0) * t;
      const p = g.city.net.pointOn(id, s, r.laneOffset(Math.min(lane, r.spec.lanes - 1)));
      g.env.setHours(hours);
      g.env.speed = 0;
      g.teleport(p.x, p.z, p.heading);
      g.traffic.clear();
    },
    { id, t, lane, hours },
  );
  await waitSim(page, 1.2); // let traffic repopulate
}

try {
  const errors = await gotoGame(page, url);
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: join(out, "01-title.png") });
  await press(page, "Enter", 600);
  await holdSim(page, ["KeyW"], 3);
  await page.screenshot({ path: join(out, "02-bay-street.png") });

  const shots = [
    ["03-roundabout", "ring-DC", 0.3, 0, 13],
    ["04-downtown-avenue", "mkt-1", 0.1, 1, 15],
    ["05-freeway", "fw-2", 0.3, 1, 11],
    ["06-bridge", "bridge-n", 0.15, 0, 17.5],
    ["07-mountain", "mt-up", 0.55, 0, 10],
    ["08-coast", "coast-2", 0.25, 0, 18.6],
    ["09-oldtown", "cath", 0.3, 0, 9],
    ["10-port", "hfront", 0.4, 0, 14],
    ["11-hillcrest", "hc-1", 0.4, 0, 16],
    ["12-night-downtown", "lib-1", 0.1, 0, 22],
  ];
  for (const [name, road, t, lane, hours] of shots) {
    await onRoad(road, t, lane, hours);
    await holdSim(page, ["KeyW"], 2);
    await page.screenshot({ path: join(out, `${name}.png`) });
    const s = await snap(page);
    console.log(name, { district: s.district, traffic: s.traffic, fps: Math.round(s.fps), y: s.y.toFixed(1), speed: Math.round(s.speedKmh) });
  }
  await press(page, "Tab", 500);
  await page.screenshot({ path: join(out, "13-map.png") });
  await press(page, "Tab", 300);
  const s = await snap(page);
  console.log({ fps: s.fps, drawCalls: s.drawCalls, tris: s.triangles, errors: s.errors });
  console.log("console errors:", errors);
} finally {
  await browser.close();
  server.close();
}
