/** Close-up screenshots of each traffic vehicle type. */
import { join } from "node:path";
import { ROOT, serveDist, launch, gotoGame, waitSim, press } from "./harness.mjs";
const { server, url } = await serveDist();
const { browser, page } = await launch({ width: 1280, height: 800 });
try {
  await gotoGame(page, url);
  await press(page, "Enter", 600);
  await page.evaluate(() => {
    const g = window.__fh;
    g.env.setHours(14); g.env.speed = 0;
    g.traffic.clear(); g.traffic.target = 0; g.traffic.enabled = false;
    const lane = g.city.net.road('fw-5').lanesFwd[2];
    const kinds = ['sedan', 'hatch', 'suv', 'taxi', 'van', 'pickup', 'bus'];
    const models = window.__fh.trafficModels;
    let s = 40;
    for (const k of kinds) { const m = models.find(x => x.kind === k); const c = g.traffic.add(lane, s, m); c.v = 0; s += m.length + 4; }
    const p = lane.poly.sample(20);
    const t = lane.poly.tangent(20);
    g.teleport(p.x - t.tz * 7, p.z + t.tx * 7, Math.atan2(t.tx, t.tz) + 0.5);
    g.car.stop();
  });
  await waitSim(page, 0.4);
  // Freeze and frame each vehicle with a free camera.
  await page.evaluate(() => { window.__fh.state = 'garage-test'; });
  const cars = await page.evaluate(() => window.__fh.traffic.cars.map((c) => ({ kind: c.model.kind, x: c.x, y: c.y, z: c.z, h: c.heading, L: c.model.length })));
  for (const c of cars) {
    for (const [tag, ang] of [['f', 0.7], ['r', 2.6]]) {
      await page.evaluate(({ c, ang }) => {
        const g = window.__fh;
        const a = c.h + ang;
        const r = c.L * 0.9 + 3;
        g.camera.position.set(c.x + Math.sin(a) * r, c.y + 1.7, c.z + Math.cos(a) * r);
        g.camera.lookAt(c.x, c.y + 0.8, c.z);
        g.camera.fov = 50; g.camera.updateProjectionMatrix();
        g.renderer.render(g.scene, g.camera);
      }, { c, ang });
      await page.screenshot({ path: join(ROOT, `tests/out/traffic-${c.kind}-${tag}.png`) });
    }
  }
} finally { await browser.close(); server.close(); }
