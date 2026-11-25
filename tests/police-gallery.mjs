/** Close-ups of the two police cars (day + night, light bar flashing). Usage: node tests/police-gallery.mjs [outDir] */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ROOT, serveDist, launch, gotoGame, press, waitSim } from "./harness.mjs";

const out = process.argv[2] ?? join(ROOT, "tests/out");
await mkdir(out, { recursive: true });
const { server, url } = await serveDist();
const { browser, page } = await launch({ width: 1280, height: 800 });
try {
  const errors = await gotoGame(page, url);
  await press(page, "Enter", 600);
  for (const hours of [13, 22]) {
    for (const k of [0, 1]) {
      for (const [view, ang] of [["front", 2.4], ["side", 1.57], ["rear", -0.6]]) {
        await page.evaluate(({ hours, k, ang }) => {
          const g = window.__fh;
          g.env.setHours(hours);
          g.env.speed = 0;
          g.traffic.clear();
          g.traffic.enabled = false;
          g.police.standDown();
          g.police.patrolTarget = 0;
          g.heat.force(2);
          const r = g.city.net.road("runway");
          const s = r.s0 + (r.s1 - r.s0) * 0.4;
          const p = g.city.net.pointOn("runway", s, 0);
          // Player car parked well behind the camera; unit stands alone.
          g.teleport(p.x - Math.sin(p.heading) * 40, p.z - Math.cos(p.heading) * 40, p.heading);
          const u = g.police.makeUnit(g.policeDefs[k], p.x, p.z, p.heading, g.city.ground(p.x, p.z), "roadblock");
          window.__shot = { x: p.x, y: u.phys.y, z: p.z, h: p.heading + ang };
        }, { hours, k, ang });
        await waitSim(page, 0.3);
        // Freeze the camera on the unit (stop the chase rig for the shot).
        await page.evaluate(() => {
          const g = window.__fh;
          const s = window.__shot;
          g.state = "paused-shot";
          const d = 7.2;
          g.camera.position.set(s.x + Math.sin(s.h) * d, s.y + 1.8, s.z + Math.cos(s.h) * d);
          g.camera.lookAt(s.x, s.y + 0.7, s.z);
        });
        await new Promise((r) => setTimeout(r, 450));
        await page.screenshot({ path: join(out, `police-${k ? "enforcer" : "interceptor"}-${view}-${hours}h.png`) });
        await page.evaluate(() => (window.__fh.state = "drive"));
      }
    }
  }
  console.log("errors:", errors);
} finally {
  await browser.close();
  server.close();
}
