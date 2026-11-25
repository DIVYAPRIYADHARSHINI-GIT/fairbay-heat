/**
 * Fairbay Heat - end-to-end suite.
 *
 * Drives the REAL production build in Chrome with REAL key events
 * (keydown/keyup through the browser's input pipeline) and asserts on the
 * game's state. Fails on any console error.
 *
 * Usage: node tests/e2e.mjs [baseUrl]
 *   FH_GPU=0 forces software GL (SwiftShader) instead of the Mac GPU.
 */

import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { ROOT, serveDist, launch, gotoGame, snap, holdSim, waitSim, press, checker, brakeToStop } from "./harness.mjs";

const SHOTS = join(ROOT, "docs/screenshots");
await mkdir(SHOTS, { recursive: true });
const { check, section, summary } = checker();
const external = process.argv[2];
const { server, url } = external ? { server: null, url: external.endsWith("/") ? external : external + "/" } : await serveDist();
const { browser, page } = await launch();
const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Puts the car somewhere and lets one frame settle. */
async function teleport(x, z, heading) {
  await page.evaluate((a) => window.__fh.teleport(a.x, a.z, a.heading), { x, z, heading });
  await waitSim(page, 0.05);
}

try {
  section("Boot");
  const errors = await gotoGame(page, url);
  const info = await page.evaluate(() => {
    const g = window.__fh.renderer.getContext();
    const ext = g.getExtension("WEBGL_debug_renderer_info");
    return { gl: ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "?", webgl2: g instanceof WebGL2RenderingContext };
  });
  console.log(`  (renderer: ${info.gl})`);
  check("loads to the title screen with WebGL 2", info.webgl2);
  check("title menu is visible", await page.$eval('[data-screen="title-menu"]', (e) => !e.classList.contains("hidden")));
  await sleep(800);
  await shot("01-title");

  section("Title menu is keyboard-driven");
  await press(page, "ArrowDown");
  check("ArrowDown moves the selection to Garage", (await page.$eval('[data-screen="title-menu"] .menu-item.active', (e) => e.dataset.id)) === "garage");
  await press(page, "KeyS");
  check("S also moves down (to Controls)", (await page.$eval('[data-screen="title-menu"] .menu-item.active', (e) => e.dataset.id)) === "controls");
  await press(page, "Enter", 300);
  check("Enter opens the Controls screen", (await snap(page)).state === "help");
  await shot("02-controls");
  await press(page, "Escape", 200);
  check("Esc returns to the title", (await snap(page)).state === "title");
  await press(page, "ArrowUp");
  await press(page, "ArrowUp");
  await press(page, "Enter", 500);
  let s = await snap(page);
  check("Drive starts the game", s.state === "drive", s.state);
  check("starts in the Fjord Mustanger GT", s.car === "mustanger");
  check("HUD is visible while driving", await page.$eval(".hud", (e) => !e.classList.contains("hidden")));

  section("Driving with W A S D");
  const x0 = s.x;
  const z0 = s.z;
  await holdSim(page, ["KeyW"], 3);
  s = await snap(page);
  check("holding W accelerates past 60 km/h in 3 s", s.speedKmh > 60, `${s.speedKmh.toFixed(1)} km/h`);
  check("the car drives forward (north, +Z)", s.z - z0 > 20 && Math.abs(s.x - x0) < 3, `dz=${(s.z - z0).toFixed(1)} dx=${(s.x - x0).toFixed(1)}`);
  check("the gearbox has shifted up", s.gear >= 2, `gear ${s.gear}`);
  await shot("03-accelerating");
  const vCoast = s.speedKmh;
  await waitSim(page, 1.5);
  s = await snap(page);
  check("releasing W coasts the car down", s.speedKmh < vCoast - 3, `${vCoast.toFixed(0)} -> ${s.speedKmh.toFixed(0)}`);
  const vBrake = (await snap(page)).speedKmh;
  const tBrake = (await snap(page)).simTime;
  await brakeToStop(page);
  s = await snap(page);
  const brakeT = s.simTime - tBrake;
  check("holding S brakes to a stop", s.speedKmh < 5 && brakeT < 3, `${vBrake.toFixed(0)} km/h -> stop in ${brakeT.toFixed(2)} s`);
  await holdSim(page, ["KeyS"], 2);
  s = await snap(page);
  check("keeping S held reverses (gear R)", s.vLong < -2 && s.gear === 0, `vLong=${s.vLong.toFixed(2)} gear=${s.gear}`);
  await holdSim(page, ["KeyW"], 0.6);

  await teleport(-5, -300, 0);
  await holdSim(page, ["KeyW"], 2);
  const h0 = (await snap(page)).heading;
  await holdSim(page, ["KeyW", "KeyA"], 0.7);
  s = await snap(page);
  check("W + A turns left (heading increases)", s.heading - h0 > 0.2, `dHeading=${(s.heading - h0).toFixed(2)}`);
  const h1 = s.heading;
  await holdSim(page, ["KeyW", "KeyD"], 1.2);
  s = await snap(page);
  check("W + D turns right (heading decreases)", s.heading - h1 < -0.25, `dHeading=${(s.heading - h1).toFixed(2)}`);

  section("Arrow keys work the same");
  await teleport(-5, -300, 0);
  await holdSim(page, ["ArrowUp"], 2);
  s = await snap(page);
  check("ArrowUp accelerates", s.speedKmh > 40, `${s.speedKmh.toFixed(1)}`);
  const ha = s.heading;
  await holdSim(page, ["ArrowUp", "ArrowLeft"], 0.6);
  s = await snap(page);
  check("ArrowLeft steers left", s.heading - ha > 0.15);
  await brakeToStop(page, "ArrowDown");
  check("ArrowDown brakes", (await snap(page)).speedKmh < 5);

  section("Handbrake drift and nitro");
  await teleport(-5, -300, 0);
  await holdSim(page, ["KeyW"], 3.5);
  await page.evaluate(() => (window.__fh.car.nitro = 0.3));
  await holdSim(page, ["KeyW", "KeyA", "Space"], 0.4);
  s = await snap(page);
  check("Space + A at speed kicks the car into a drift", s.drifting, `speed ${s.speedKmh.toFixed(0)}`);
  await holdSim(page, ["KeyW", "KeyA"], 0.6);
  await shot("04-drift");
  s = await snap(page);
  check("drifting refills nitro", s.nitro > 0.3, s.nitro.toFixed(3));
  const drift = await page.$eval(".drift", (e) => ({ show: e.classList.contains("show"), text: e.textContent }));
  check("the drift counter shows on screen", drift.show && /DRIFT \d/.test(drift.text), drift.text);
  await brakeToStop(page);
  await teleport(-5, -300, 0);
  await page.evaluate(() => (window.__fh.car.nitro = 1));
  await holdSim(page, ["KeyW"], 1);
  await page.keyboard.down("KeyW");
  await page.keyboard.down("ShiftLeft");
  await waitSim(page, 0.4);
  s = await snap(page);
  check("Shift fires nitro", s.nitroActive);
  await shot("05-nitro");
  await waitSim(page, 0.6);
  await page.keyboard.up("ShiftLeft");
  await page.keyboard.up("KeyW");
  s = await snap(page);
  check("nitro drains while boosting", s.nitro < 0.85, s.nitro.toFixed(2));

  section("Collisions and jumps");
  const wall = await page.evaluate(() => {
    const g = window.__fh;
    // A building whose west face fronts a sidewalk, so the road in front is clear.
    for (const b of g.city.blocks) {
      if (b.district !== "downtown" && b.district !== "midtown") continue;
      for (const c of g.city.colliders.query((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2, 60)) {
        if (c.kind === "box" && c.top > 10 && c.top < 900 && Math.abs(c.minX - (b.minX + 4)) < 0.01 && c.maxZ - c.minZ > 20) {
          return { face: c.minX, z: (c.minZ + c.maxZ) / 2, roadX: b.minX - 6 };
        }
      }
    }
    return null;
  });
  check("found a building to crash into", wall !== null);
  if (wall) {
    await teleport(wall.roadX - 30, wall.z, Math.PI / 2);
    let maxX = -Infinity;
    await page.keyboard.down("KeyW");
    for (let i = 0; i < 25; i++) {
      await waitSim(page, 0.15);
      maxX = Math.max(maxX, (await snap(page)).x);
    }
    await page.keyboard.up("KeyW");
    const half = await page.evaluate(() => window.__fh.car.def.body.length / 2);
    check("driving into a building stops at the wall (no tunnelling)", maxX + half < wall.face + 0.7, `nose ${(maxX + half).toFixed(2)} vs wall ${wall.face.toFixed(2)}`);
    await shot("06-crash");
  }
  const ramp = await page.evaluate(() => window.__fh.city.ramps[0]);
  await teleport(ramp.x - 3, ramp.z - 110, ramp.heading);
  let flew = false;
  let maxY = 0;
  await page.keyboard.down("KeyW");
  await page.keyboard.down("ShiftLeft");
  for (let i = 0; i < 60 && !flew; i++) {
    await waitSim(page, 0.1);
    s = await snap(page);
    flew ||= s.airborne;
    maxY = Math.max(maxY, s.y);
  }
  if (flew) await shot("07-jump");
  await page.keyboard.up("ShiftLeft");
  for (let i = 0; i < 30; i++) {
    await waitSim(page, 0.1);
    s = await snap(page);
    maxY = Math.max(maxY, s.y);
    if (!s.airborne) break;
  }
  await page.keyboard.up("KeyW");
  check("hitting a ramp at speed launches the car into the air", flew && maxY > 2, `maxY=${maxY.toFixed(2)}`);
  check("...and it lands again", !(await snap(page)).airborne);
  await brakeToStop(page);

  section("Jacking parked cars (E)");
  const spot = await page.evaluate(() => {
    const g = window.__fh;
    return [...g.parked.map((p) => p.spot)].find((sp) => sp.carId === "aventura");
  });
  // Approach in the traffic lane beside the parked car, 25 m back, then
  // drive up and stop alongside it - exactly what a player does.
  const lane = await page.evaluate((sp) => {
    const r = window.__fh.city.roadAt(sp.x, sp.z);
    return r.axis === "x" ? { x: sp.x + (r.coord - sp.x) * 0.55, z: sp.z } : { x: sp.x, z: sp.z + (r.coord - sp.z) * 0.55 };
  }, spot);
  const bx = Math.sin(spot.heading);
  const bz = Math.cos(spot.heading);
  await teleport(lane.x - bx * 25, lane.z - bz * 25, spot.heading);
  await page.keyboard.down("KeyW");
  await page.waitForFunction((sp) => {
    const c = window.__fh.car;
    return (c.x - sp.x) * Math.sin(sp.heading) + (c.z - sp.z) * Math.cos(sp.heading) > -9;
  }, { timeout: 60000 }, spot);
  await page.keyboard.up("KeyW");
  await brakeToStop(page);
  s = await snap(page);
  const prompt = await page.$eval(".prompt", (e) => ({ show: e.classList.contains("show"), text: e.textContent }));
  check("pulling up next to a parked car shows the E prompt", prompt.show && /Lamborgino Aventura/.test(prompt.text), prompt.text);
  await shot("08-jack-prompt");
  await press(page, "KeyE", 400);
  s = await snap(page);
  check("pressing E jacks the car", s.car === "aventura", s.car);
  check("the new car is added to the garage", s.discovered.includes("aventura"));
  check("the parked copy is removed from the street", s.hiddenSpot === spot.id);
  const toast = await page.$$eval(".toast .t-title", (n) => n.map((e) => e.textContent));
  check("a NEW CAR FOUND toast appears", toast.some((t) => t === "NEW CAR FOUND"), toast.join(" | "));
  await shot("09-new-car");
  await holdSim(page, ["KeyW"], 2);
  check("the jacked car is drivable", (await snap(page)).speedKmh > 50);
  await brakeToStop(page);

  section("Camera, map, pause, time, mute, reset");
  const cam0 = (await snap(page)).cameraMode;
  await press(page, "KeyC", 300);
  check("C changes the camera", (await snap(page)).cameraMode === (cam0 + 1) % 3);
  await shot("10-camera-far");
  await press(page, "KeyC", 300);
  await shot("11-camera-bumper");
  await press(page, "KeyC", 200);
  await press(page, "Tab", 400);
  check("Tab opens the city map", (await snap(page)).state === "map");
  await shot("12-map");
  await press(page, "Tab", 300);
  check("Tab closes the map back to driving", (await snap(page)).state === "drive");
  await press(page, "Escape", 300);
  s = await snap(page);
  check("Esc pauses", s.state === "paused");
  const tPaused = s.simTime;
  const pPaused = { x: s.x, z: s.z };
  await page.keyboard.down("KeyW");
  await sleep(600);
  await page.keyboard.up("KeyW");
  s = await snap(page);
  check("the simulation is frozen while paused (W does nothing)", s.simTime === tPaused && s.x === pPaused.x && s.z === pPaused.z);
  await shot("13-pause");
  await press(page, "Escape", 300);
  check("Esc resumes", (await snap(page)).state === "drive");
  await press(page, "KeyP", 200);
  check("P also pauses", (await snap(page)).state === "paused");
  await press(page, "Enter", 300); // "Resume" is the first item
  check("Enter on Resume returns to driving", (await snap(page)).state === "drive");
  const hBefore = (await snap(page)).hours;
  await press(page, "KeyT", 200);
  const dh = ((await snap(page)).hours - hBefore + 24) % 24;
  check("T skips the clock forward 3 hours", Math.abs(dh - 3) < 0.05, dh.toFixed(2));
  const m0 = (await snap(page)).muted;
  await press(page, "KeyM", 150);
  check("M toggles mute", (await snap(page)).muted === !m0);
  await press(page, "KeyM", 150);
  await teleport(55, 55, 0.3); // in the middle of a downtown block
  await press(page, "KeyR", 300);
  s = await snap(page);
  const onRoad = await page.evaluate((p) => window.__fh.city.roadAt(p.x, p.z) !== null, { x: s.x, z: s.z });
  check("R resets the car back onto a road", onRoad, `${s.x.toFixed(1)}, ${s.z.toFixed(1)}`);

  section("Garage (G)");
  await holdSim(page, ["KeyW"], 2);
  await press(page, "KeyG", 300);
  check("G is refused while moving fast", (await snap(page)).state === "drive");
  await brakeToStop(page);
  await press(page, "KeyG", 500);
  check("G opens the garage when stopped", (await snap(page)).state === "garage");
  await shot("14-garage");
  await press(page, "ArrowRight", 400);
  s = await snap(page);
  check("Right arrow cycles to another owned car", s.car !== "aventura" && s.discovered.includes(s.car), s.car);
  await press(page, "ArrowDown");
  await press(page, "ArrowRight", 300);
  check("paint can be changed", (await page.evaluate(() => window.__fh.save.colorIndex)) === 1);
  await press(page, "ArrowDown");
  await press(page, "Enter", 400);
  check("Drive it returns to the street", (await snap(page)).state === "drive");

  section("Browser behaviour");
  const scroll = await page.evaluate(() => {
    document.body.style.height = "3000px"; // make the page scrollable on purpose
    document.documentElement.style.overflow = "auto";
    document.body.style.overflow = "auto";
    return window.scrollY;
  });
  await press(page, "Space", 50);
  await press(page, "ArrowDown", 50);
  const scrolled = await page.evaluate(() => {
    const y = window.scrollY;
    document.body.style.height = "";
    document.documentElement.style.overflow = "";
    document.body.style.overflow = "";
    return y;
  });
  check("Space and arrow keys never scroll the page", scrolled === scroll, `scrollY ${scrolled}`);
  await page.keyboard.down("KeyW");
  await waitSim(page, 0.5);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const vBlur = (await snap(page)).speedKmh;
  await waitSim(page, 1);
  await page.keyboard.up("KeyW");
  check("losing window focus releases held keys (no runaway car)", (await snap(page)).speedKmh < vBlur, `${vBlur.toFixed(1)} -> ${(await snap(page)).speedKmh.toFixed(1)}`);

  section("Settings + persistence");
  await press(page, "Escape", 300);
  for (let i = 0; i < 5; i++) await press(page, "ArrowDown", 60);
  await press(page, "Enter", 300);
  check("Settings opens from the pause menu", (await snap(page)).state === "settings");
  await shot("15-settings");
  await press(page, "ArrowLeft", 600);
  check("Left arrow lowers graphics quality", (await snap(page)).quality === "medium");
  await press(page, "ArrowRight", 600);
  check("...and Right raises it again", (await snap(page)).quality === "high");
  await press(page, "Escape", 200);
  await press(page, "Escape", 300);
  check("back out to driving", (await snap(page)).state === "drive");
  const before = await snap(page);
  await page.evaluate(() => window.__fh.persist());
  const errs2 = [];
  page.on("pageerror", (e) => errs2.push(String(e)));
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.__fh && window.__fh.state === "title", { timeout: 120000 });
  s = await snap(page);
  check("after reload the garage keeps the jacked car", s.discovered.includes("aventura"));
  check("after reload you are in the same car", s.car === before.car, `${s.car} vs ${before.car}`);
  check("after reload you resume near where you parked", Math.hypot(s.x - before.x, s.z - before.z) < 30, `${Math.hypot(s.x - before.x, s.z - before.z).toFixed(1)} m`);

  section("Night + performance");
  await press(page, "Enter", 500);
  await page.evaluate(() => {
    window.__fh.env.setHours(22);
    window.__fh.env.speed = 0;
    window.__fh.teleport(-5, -500, 0);
  });
  await holdSim(page, ["KeyW"], 2.5);
  s = await snap(page);
  check("night mode is active at 22:00", s.night > 0.9);
  await shot("16-night");
  await brakeToStop(page);
  const f0 = await page.evaluate(() => window.__fh.frames);
  const t0 = Date.now();
  await page.keyboard.down("KeyW");
  await sleep(4000);
  await page.keyboard.up("KeyW");
  const fps = ((await page.evaluate(() => window.__fh.frames)) - f0) / ((Date.now() - t0) / 1000);
  const gpu = !/SwiftShader/i.test(info.gl);
  console.log(`  (measured ${fps.toFixed(1)} fps at 1440x900 on ${gpu ? "GPU" : "software GL"}, ${s.drawCalls} draw calls)`);
  if (gpu) check("holds >= 50 fps while driving at 1440x900", fps >= 50, `${fps.toFixed(1)} fps`);
  else check("runs on software GL without stalling (>= 5 fps)", fps >= 5, `${fps.toFixed(1)} fps`);

  section("Console");
  const gameErrors = (await snap(page)).errors;
  check("no game-loop errors", gameErrors.length === 0, gameErrors.join("; "));
  check("zero console errors for the whole session", errors.length === 0 && errs2.length === 0, [...errors, ...errs2].join(" | "));
} catch (e) {
  console.error(e);
  check("suite ran to completion", false, String(e));
} finally {
  await browser.close();
  server?.close();
  process.exitCode = summary() ? 1 : 0;
}
