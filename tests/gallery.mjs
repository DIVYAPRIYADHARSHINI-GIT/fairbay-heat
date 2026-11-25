/** Garage turntable screenshots of every car. Usage: node tests/gallery.mjs [outDir] [hours] */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ROOT, serveDist, launch, gotoGame, press } from "./harness.mjs";

const out = process.argv[2] ?? join(ROOT, "tests/out");
const hours = Number(process.argv[3] ?? 13);
await mkdir(out, { recursive: true });
const { server, url } = await serveDist();
const { browser, page } = await launch({ width: 1280, height: 800 });
try {
  const errors = await gotoGame(page, url);
  await page.evaluate((h) => {
    const g = window.__fh;
    g.save.discovered = ["mustanger", "carrara", "vantis", "aventura", "gtarr", "veyrone"];
    g.env.setHours(h);
    g.env.speed = 0;
  }, hours);
  await press(page, "ArrowDown");
  await press(page, "Enter", 800);
  for (let i = 0; i < 6; i++) {
    const id = await page.evaluate(() => window.__fh.car.def.id);
    // Fixed 3/4 front angle for comparable shots.
    await page.evaluate(() => (window.__fh.titleAngle = 0.55));
    await new Promise((r) => setTimeout(r, 250));
    await page.screenshot({ path: join(out, `car-${id}-front.png`) });
    await page.evaluate(() => (window.__fh.titleAngle = 2.6));
    await new Promise((r) => setTimeout(r, 250));
    await page.screenshot({ path: join(out, `car-${id}-rear.png`) });
    await press(page, "ArrowRight", 400);
  }
  console.log("errors:", errors);
} finally {
  await browser.close();
  server.close();
}
