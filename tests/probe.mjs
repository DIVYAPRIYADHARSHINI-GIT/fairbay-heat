/**
 * Visual probe: loads the build, starts driving, and takes screenshots at a
 * few places / times of day. Usage: node tests/probe.mjs [outDir]
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ROOT, serveDist, launch, gotoGame, snap, holdSim, press } from "./harness.mjs";

const out = process.argv[2] ?? join(ROOT, "tests/out");
await mkdir(out, { recursive: true });
const { server, url } = await serveDist();
const { browser, page } = await launch();
try {
  const errors = await gotoGame(page, url);
  const gl = await page.evaluate(() => {
    const g = window.__fh.renderer.getContext();
    const ext = g.getExtension("WEBGL_debug_renderer_info");
    return ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  console.log("GL:", gl);
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: join(out, "01-title.png") });
  await press(page, "Enter", 600);
  console.log(await snap(page));
  await page.screenshot({ path: join(out, "02-drive-start.png") });
  await holdSim(page, ["KeyW"], 3);
  await page.screenshot({ path: join(out, "03-accel.png") });
  await holdSim(page, ["KeyW", "KeyA", "Space"], 0.6);
  await holdSim(page, ["KeyW", "KeyA"], 0.8);
  await page.screenshot({ path: join(out, "04-drift.png") });
  console.log(await snap(page));
  await page.evaluate(() => {
    window.__fh.env.setHours(21.5);
    window.__fh.env.speed = 0;
  });
  await page.evaluate(() => window.__fh.teleport(-5, -100, 0));
  await holdSim(page, ["KeyW"], 2.5);
  await page.screenshot({ path: join(out, "05-night.png") });
  await page.evaluate(() => {
    window.__fh.env.setHours(12);
    window.__fh.teleport(-560, 400, Math.PI);
  });
  await holdSim(page, ["KeyW"], 2);
  await page.screenshot({ path: join(out, "06-northshore-noon.png") });
  const s = await snap(page);
  console.log({ fps: s.fps, drawCalls: s.drawCalls, tris: s.triangles, errors: s.errors });
  console.log("console errors:", errors);
} finally {
  await browser.close();
  server.close();
}
