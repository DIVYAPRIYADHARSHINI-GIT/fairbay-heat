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

/** Presses ArrowDown/ArrowUp until the open menu highlights row `id` (real key presses). */
async function menuTo(screen, id) {
  for (let i = 0; i < 30; i++) {
    const cur = await page.evaluate((sc) => document.querySelector(`[data-screen="${sc}"] .menu-item.active`)?.dataset.id ?? null, screen);
    if (cur === id) return true;
    const order = await page.evaluate((sc) => [...document.querySelectorAll(`[data-screen="${sc}"] .menu-item`)].map((e) => e.dataset.id), screen);
    await press(page, order.indexOf(id) > order.indexOf(cur) ? "ArrowDown" : "ArrowUp", 50);
  }
  return false;
}

/** Puts the car in a lane of a named road, with traffic cleared and paused for a clean test. */
async function onRoad(id, t = 0.1, lane = 0, traffic = false) {
  await page.evaluate(
    ({ id, t, lane, traffic }) => {
      const g = window.__fh;
      const r = g.city.net.road(id);
      const s = r.s0 + (r.s1 - r.s0) * t;
      const p = g.city.net.pointOn(id, s, r.laneOffset(Math.min(lane, r.spec.lanes - 1)));
      g.traffic.clear();
      g.traffic.enabled = traffic;
      g.teleport(p.x, p.z, p.heading);
    },
    { id, t, lane, traffic },
  );
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
  check("the first drive shows the controls card automatically", s.controlsCard === true);
  await shot("02b-controls-card");
  await press(page, "KeyW", 200);
  check("...and a driving key closes it (it does not come back)", (await snap(page)).controlsCard === false && (await page.evaluate(() => window.__fh.save.seenControls)) === true);
  check("starts in the Fjord Mustanger GT", s.car === "mustanger");
  check("HUD is visible while driving", await page.$eval(".hud", (e) => !e.classList.contains("hidden")));

  section("Driving with W A S D");
  // A long, nearly straight stretch of the Fairbay Loop with traffic paused.
  await onRoad("i9-2", 0.22, 1);
  s = await snap(page);
  const x0 = s.x;
  const z0 = s.z;
  const h00 = s.heading;
  await holdSim(page, ["KeyW"], 3);
  s = await snap(page);
  check("holding W accelerates past 60 km/h in 3 s", s.speedKmh > 60, `${s.speedKmh.toFixed(1)} km/h`);
  const fwd = (s.x - x0) * Math.sin(h00) + (s.z - z0) * Math.cos(h00);
  const side = Math.abs(-(s.x - x0) * Math.cos(h00) + (s.z - z0) * Math.sin(h00));
  check("the car drives straight ahead in the direction it faces", fwd > 20 && side < 3, `forward ${fwd.toFixed(1)} m, sideways ${side.toFixed(1)} m`);
  await holdSim(page, ["KeyW"], 1.2);
  s = await snap(page);
  check("the gearbox has shifted up (1st runs to ~80 km/h, like the real car)", s.gear >= 2, `gear ${s.gear} at ${s.speedKmh.toFixed(0)} km/h`);
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

  await onRoad("i9-2", 0.22, 1);
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
  await onRoad("i9-2", 0.22, 1);
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
  // The 46 m wide airfield runway: nothing to clip mid-drift.
  await onRoad("runway", 0.08, 0);
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
  check("the drift counter shows on screen", drift.show && /DRIFT [0-9]/.test(drift.text) && parseInt(drift.text.replace(/\D/g, ""), 10) >= 50, drift.text);
  await brakeToStop(page);
  await onRoad("i9-2", 0.22, 1);
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
    // A big downtown building: approach its street-facing side head-on.
    const b = g.city.buildings.filter((x) => x.district === "downtown" && x.box.hx > 12).sort((p, q) => q.box.hx - p.box.hx)[0];
    const { cx, cz, hz, c, s } = b.box;
    // Outward normal of the -v face is (s, -c) in world terms.
    const nx = s;
    const nz = -c;
    const face = { x: cx + nx * hz, z: cz + nz * hz };
    return { start: { x: face.x + nx * 26, z: face.z + nz * 26 }, heading: Math.atan2(-nx, -nz), face, nx, nz };
  });
  check("found a building to crash into", wall !== null);
  if (wall) {
    await page.evaluate(() => {
      window.__fh.traffic.clear();
      window.__fh.traffic.enabled = false;
    });
    await teleport(wall.start.x, wall.start.z, wall.heading);
    let minD = Infinity;
    await page.keyboard.down("KeyW");
    for (let i = 0; i < 25; i++) {
      await waitSim(page, 0.15);
      const p = await snap(page);
      // Signed distance of the car centre from the facade plane (positive = outside).
      minD = Math.min(minD, (p.x - wall.face.x) * wall.nx + (p.z - wall.face.z) * wall.nz);
    }
    await page.keyboard.up("KeyW");
    check("driving into a building stops at the wall (no tunnelling)", minD > 0.5, `closest centre ${minD.toFixed(2)} m from facade`);
    await shot("06-crash");
  }
  const ramp = await page.evaluate(() => window.__fh.city.ramps.find((r) => r.label === "Quay launch"));
  await teleport(ramp.x - Math.sin(ramp.heading) * 90, ramp.z - Math.cos(ramp.heading) * 90, ramp.heading);
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
  // Start 25 m back in the nearest lane of the road the car is parked beside.
  const start = await page.evaluate((sp) => {
    const g = window.__fh;
    g.traffic.clear();
    g.traffic.enabled = false;
    const near = g.city.net.nearestRoad(sp.x, sp.z, 30);
    const r = near.road;
    const t = r.center.tangent(near.s);
    const dir = Math.sign(t.tx * Math.sin(sp.heading) + t.tz * Math.cos(sp.heading)) || 1;
    const s = near.s - dir * 25;
    const lat = r.laneOffset(r.spec.lanes - 1);
    return dir > 0 ? g.city.net.pointOn(r.id, s, lat) : (() => { const p = g.city.net.pointOn(r.id, s, -lat); return { x: p.x, z: p.z, heading: p.heading + Math.PI }; })();
  }, spot);
  await teleport(start.x, start.z, start.heading);
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
  await teleport(-30, 380, 0.3); // in the middle of Central Park
  await press(page, "KeyR", 300);
  s = await snap(page);
  const onLane = await page.evaluate((p) => window.__fh.city.net.roadAt(p.x, p.z) !== null, { x: s.x, z: s.z });
  check("R resets the car back onto a road", onLane, `${s.x.toFixed(1)}, ${s.z.toFixed(1)}`);

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


  section("Realistic engine sound (Web Audio, synthesised)");
  await onRoad("i9-2", 0.22, 1);
  await page.waitForFunction(() => window.__fh.audio.ready, { timeout: 15000 }).catch(() => {});
  s = await snap(page);
  check("audio started on the first key press", s.audioState === "running", s.audioState);
  check("the engine model runs on the audio thread (AudioWorklet)", s.audioMode === "worklet", s.audioMode);
  check("the loaded engine model matches the car being driven", s.audioEngine === s.car, `${s.audioEngine} vs ${s.car}`);
  await waitSim(page, 0.6);
  const idleLevel = (await snap(page)).audioLevel;
  check("the idling engine is audible", idleLevel > 0.005, idleLevel.toFixed(4));
  await page.keyboard.down("KeyW");
  await waitSim(page, 1.2);
  const pull = await snap(page);
  check("full throttle is louder than idle", pull.audioLevel > idleLevel * 1.3, `${idleLevel.toFixed(4)} -> ${pull.audioLevel.toFixed(4)}`);
  const rpmTrace = [];
  for (let i = 0; i < 24; i++) {
    await waitSim(page, 0.12);
    const p = await snap(page);
    rpmTrace.push({ rpm: p.rpm, gear: p.gearRaw });
  }
  await page.keyboard.up("KeyW");
  // A shift takes 0.16 s and the samples are 0.12 s apart, so a sample can
  // land mid-shift: look at the lowest revs over the two samples after it.
  const drops = rpmTrace.filter((p, i) => i > 0 && p.gear > rpmTrace[i - 1].gear && Math.min(p.rpm, rpmTrace[i + 1]?.rpm ?? p.rpm) < rpmTrace[i - 1].rpm - 300).length;
  check("the gearbox upshifts and the revs drop on each shift", drops >= 1, rpmTrace.map((p) => `${p.gear}:${Math.round(p.rpm)}`).join(" "));
  await press(page, "KeyM", 300);
  const mutedLevel = (await snap(page)).audioLevel;
  check("M mutes the sound", mutedLevel < 0.003, mutedLevel.toFixed(4));
  await press(page, "KeyM", 150);
  await brakeToStop(page);

  section("Stage 2: traffic");
  await page.evaluate(() => {
    window.__fh.traffic.enabled = true;
    window.__fh.env.setHours(13);
    window.__fh.env.speed = 0;
  });
  await onRoad("kings-2", 0.3, 0, true);
  await waitSim(page, 3);
  s = await snap(page);
  check("traffic populates around the player (48-car budget, 25% lighter than Stage 2)", s.traffic >= 30 && s.traffic <= 48, `${s.traffic} cars`);
  const flow = await page.evaluate(async () => {
    const g = window.__fh;
    const before = new Map(g.traffic.cars.map((c) => [c.id, [c.x, c.z]]));
    await new Promise((r) => setTimeout(r, 2500));
    let moved = 0;
    for (const c of g.traffic.cars) {
      const b = before.get(c.id);
      if (b && Math.hypot(c.x - b[0], c.z - b[1]) > 3) moved++;
    }
    return { moved, total: g.traffic.cars.length, kinds: [...new Set(g.traffic.cars.map((c) => c.model.kind))] };
  });
  check("traffic is moving", flow.moved > flow.total * 0.4, `${flow.moved}/${flow.total} moved`);
  check("several kinds of vehicle (cars, taxis, vans, buses...)", flow.kinds.length >= 4, flow.kinds.join(", "));
  const onLanes = await page.evaluate(() => {
    const g = window.__fh;
    let ok = 0;
    for (const c of g.traffic.cars) if (c.wrecked > 0 || g.city.net.roadAt(c.x, c.z, 0.5) || g.city.net.nodeAt(c.x, c.z)) ok++;
    return [ok, g.traffic.cars.length];
  });
  check("every traffic car is on the road network", onLanes[0] === onLanes[1], `${onLanes[0]}/${onLanes[1]}`);
  await shot("17-traffic");
  // Ram a car: put the player behind a traffic car in its lane and floor it.
  const target = await page.evaluate(() => {
    const g = window.__fh;
    const c = g.traffic.cars.find((k) => k.seg.kind === "lane" && k.s > 40 && k.s < k.seg.length - 20 && !k.wrecked && k.model.kind !== "bus");
    if (!c) return null;
    c.temper = 0.001; // slow it right down so we catch it
    // Start 30 m behind it in its lane, aimed straight at it (lanes curve).
    const p = c.seg.poly.sample(c.s - 30);
    g.teleport(p.x, p.z, Math.atan2(c.x - p.x, c.z - p.z));
    return c.id;
  });
  check("found a traffic car to ram", target !== null);
  const hits0 = (await snap(page)).trafficHits;
  await page.keyboard.down("KeyW");
  // Capture the hit state in the same tick it happens.
  const wrecked = await page
    .waitForFunction(
      (h, id) => {
        const g = window.__fh;
        if (g.trafficHits <= h) return false;
        const c = g.traffic.cars.find((k) => k.id === id);
        return { wrecked: !!c && c.wrecked > 0 };
      },
      { timeout: 20000, polling: "raf" },
      hits0,
      target,
    )
    .then((h) => h.jsonValue())
    .then((v) => v.wrecked)
    .catch(() => false);
  await page.keyboard.up("KeyW");
  s = await snap(page);
  check("ramming a traffic car registers a hit and knocks it out of its lane", s.trafficHits > hits0 && wrecked, `hits ${s.trafficHits - hits0}, wrecked ${wrecked}`);
  await shot("18-traffic-crash");
  await brakeToStop(page);
  // Signals: traffic lights cycle in the rendered world.
  const lights = await page.evaluate(() => {
    const g = window.__fh;
    const n = [...g.city.net.nodes.values()].find((x) => x.kind === "signal" && x.groups === 2);
    return n ? n.id : null;
  });
  check("signalised junctions exist on the map", lights !== null);

  section("Custom map");
  const mapInfo = await page.evaluate(() => {
    const g = window.__fh;
    return { roads: g.city.net.roads.length, km: g.city.net.roads.reduce((a, r) => a + r.length, 0) / 1000, roundabout: [...g.city.net.nodes.values()].some((n) => n.kind === "roundabout"), bridges: g.city.net.roads.filter((r) => r.bridges.length).length, summit: g.city.net.nodes.get("SU").elev };
  });
  check("the city is a hand-made road network (no grid)", mapInfo.roads > 120 && mapInfo.km > 25, `${mapInfo.roads} roads, ${mapInfo.km.toFixed(1)} km`);
  check("it has a roundabout, river bridges and a mountain pass", mapInfo.roundabout && mapInfo.bridges >= 2 && mapInfo.summit > 100);
  const hw = await page.evaluate(() => {
    const g = window.__fh;
    const c = (k) => g.city.net.roads.filter((r) => r.cls === k).length;
    return { freeway: c("freeway"), ramp: c("ramp"), service: c("service"), overpasses: g.city.net.overpassCount };
  });
  check("it has highways, on/off ramps, service roads and overpasses", hw.freeway >= 6 && hw.ramp >= 4 && hw.service >= 8 && hw.overpasses >= 4, JSON.stringify(hw));
  await onRoad("mt-up", 0.7, 0);
  await holdSim(page, ["KeyW"], 2.5);
  s = await snap(page);
  check("you can drive up the mountain pass", s.y > 60 && s.speedKmh > 20, `y=${s.y.toFixed(1)} ${s.speedKmh.toFixed(0)} km/h`);
  await shot("19-mountain");
  await brakeToStop(page);
  const bridge = await page.evaluate(() => {
    const g = window.__fh;
    const r = g.city.net.road("i9-1");
    const [b0, b1] = r.bridges[0];
    return { id: r.id, t: ((b0 + b1) / 2 - r.s0) / (r.s1 - r.s0) };
  });
  await onRoad(bridge.id, bridge.t, 1);
  s = await snap(page);
  const overWater = await page.evaluate((p) => [-40, -25, 25, 40].some((d) => window.__fh.city.isWater(p.x + d, p.z) || window.__fh.city.isWater(p.x, p.z + d)), { x: s.x, z: s.z });
  check("Interstate 9 crosses the Fair River on a bridge", overWater && s.y > 0);
  // Drive the elevated viaduct, then the frontage road underneath it.
  // Mid-span of the viaduct, directly over the frontage road.
  await onRoad("i9-2", 0.4, 1);
  await holdSim(page, ["KeyW"], 1.2);
  const top = await snap(page);
  await brakeToStop(page);
  await onRoad("sf-2", 0.4, 1);
  await holdSim(page, ["KeyW"], 1.2);
  const below = await snap(page);
  await shot("20-under-viaduct");
  check("the I-9 viaduct runs above the Midtown frontage road", top.y - below.y > 5, `deck ${top.y.toFixed(1)} m vs street ${below.y.toFixed(1)} m`);
  check("you stay on your own level (viaduct vs underneath) and keep driving", below.speedKmh > 20 && top.speedKmh > 20 && top.y > 10, `deck ${top.speedKmh.toFixed(0)} km/h, street ${below.speedKmh.toFixed(0)} km/h`);
  await brakeToStop(page);

  section("Stage 3: police chases");
  // A patrol car in traffic, 70 m ahead in the opposite lane, facing us.
  await page.evaluate(() => {
    const g = window.__fh;
    g.env.setHours(13);
    g.env.speed = 0;
    g.traffic.clear();
    g.traffic.enabled = true;
    g.traffic.target = 0;
    g.police.standDown();
    g.police.patrolTarget = 0;
    g.heat.reset();
    const r = g.city.net.road("kings-2");
    const s = r.s0 + (r.s1 - r.s0) * 0.25;
    const p = g.city.net.pointOn("kings-2", s, r.laneOffset(0));
    g.teleport(p.x, p.z, p.heading);
    const lane = r.lanesBwd[0];
    const proj = lane.poly.project(p.x, p.z);
    g.traffic.add(lane, Math.max(5, proj.s - 150), g.policeModel);
  });
  s = await snap(page);
  check("a police patrol drives in traffic", s.patrols === 1 && s.heatState === "calm", `${s.patrols} patrols, ${s.heatState}`);
  // Speed past it: hold W (and nitro) until the chase starts.
  await page.keyboard.down("KeyW");
  await page.keyboard.down("ShiftLeft");
  const started = await page
    .waitForFunction(() => window.__fh.heat.state === "pursuit", { timeout: 30000, polling: 100 })
    .then(() => true)
    .catch(() => false);
  await page.keyboard.up("ShiftLeft");
  await page.keyboard.up("KeyW");
  s = await snap(page);
  check("speeding past the patrol starts a pursuit (heat 1)", started && s.heat >= 1, `${s.heatState}, ${s.speedKmh.toFixed(0)} km/h`);
  check("the patrol car joins the chase as a pursuit unit", s.units >= 1 && s.patrols === 0, `${s.units} units`);
  const heatUi = await page.$eval(".heat", (e) => ({ show: e.classList.contains("show"), stars: e.querySelectorAll(".star.on").length, text: e.textContent }));
  check("the HUD shows the heat meter with stars and the bounty", heatUi.show && heatUi.stars >= 1 && /BOUNTY/.test(heatUi.text), heatUi.text);
  const toastP = await page.$$eval(".toast .t-title", (n) => n.map((e) => e.textContent));
  check("a PURSUIT alert appears", toastP.includes("PURSUIT"), toastP.join(" | "));
  await brakeToStop(page);
  await waitSim(page, 1.5);
  await shot("22-pursuit");
  // Stop and let them box you in: the busted meter fills.
  const busted = await page
    .waitForFunction(() => window.__fh.heat.state === "busted", { timeout: 90000, polling: 200 })
    .then(() => true)
    .catch(() => false);
  s = await snap(page);
  check("stopping with a unit alongside gets you busted", busted, `${s.heatState} bust=${s.bust.toFixed(2)} units=${s.units}`);
  if (busted) await shot("23-busted");
  const res = await page.$eval(".result", (e) => ({ show: e.classList.contains("show"), text: e.textContent }));
  check("a BUSTED screen is shown", res.show && /BUSTED/.test(res.text), res.text);
  await page.waitForFunction(() => window.__fh.heat.state === "calm", { timeout: 20000 });
  s = await snap(page);
  check("after a bust the chase is over and the police leave", s.heatState === "calm" && s.units === 0 && s.busts === 1, `${s.heatState}, ${s.units} units`);

  // Heat 4: roadblocks (from heat 4 since the police were toned down), sirens, units on the roads.
  await onRoad("main-2", 0.15, 0, true);
  await page.evaluate(() => {
    const g = window.__fh;
    g.traffic.target = 48;
    g.heat.force(4);
    g.police.blockCool = 0;
  });
  await page.keyboard.down("KeyW");
  const block = await page
    .waitForFunction(() => window.__fh.police.roadblocks.length > 0, { timeout: 30000, polling: 200 })
    .then(() => true)
    .catch(() => false);
  await page.keyboard.up("KeyW");
  s = await snap(page);
  check("at heat 4 a roadblock is set up on the road ahead", block && s.roadblocks === 1, `${s.roadblocks} roadblocks`);
  const rbInfo = await page.evaluate(() => {
    const g = window.__fh;
    const rb = g.police.roadblocks[0];
    if (!rb) return null;
    return { d: Math.hypot(rb.x - g.car.x, rb.z - g.car.z), cars: rb.units.length, x: rb.x, z: rb.z, h: rb.heading };
  });
  check("...ahead of you and out of sight, with at least two police cars", !!rbInfo && rbInfo.d > 100 && rbInfo.cars >= 2, JSON.stringify(rbInfo));
  if (rbInfo) {
    await page.evaluate((rb) => {
      const g = window.__fh;
      g.teleport(rb.x - Math.sin(rb.h) * 30, rb.z - Math.cos(rb.h) * 30, rb.h);
    }, rbInfo);
    await waitSim(page, 0.6);
    await shot("24-roadblock");
  }
  // Reinforcements arrive every ~6 s now (was 2.5 s).
  await page.waitForFunction(() => window.__fh.police.units.filter((u) => u.mode === "pursue" || u.mode === "search").length >= 2, { timeout: 30000, polling: 250 }).catch(() => {});
  s = await snap(page);
  check("more units join at higher heat", s.units >= 2, `${s.units} units at heat ${s.heat}`);
  const sirens = await page.evaluate(() => window.__fh.audio.sirenCount);
  check("police sirens are playing", sirens >= 1, `${sirens} siren voices`);
  const blips = await page.evaluate(() => window.__fh.police.units.length);
  check("police cars appear on the minimap", blips >= 2);
  // Escape: get far away and out of sight (teleport across the map), the cooldown runs out.
  await page.evaluate(() => {
    const g = window.__fh;
    const r = g.city.net.road("runway");
    const p = g.city.net.pointOn("runway", r.s0 + (r.s1 - r.s0) * 0.5, 0);
    g.teleport(p.x, p.z, p.heading);
  });
  const cooled = await page
    .waitForFunction(() => window.__fh.heat.state === "cooldown", { timeout: 30000, polling: 200 })
    .then(() => true)
    .catch(() => false);
  check("breaking line of sight starts the cooldown", cooled, (await snap(page)).heatState);
  const escaped = await page
    .waitForFunction(() => window.__fh.heat.state === "escaped", { timeout: 90000, polling: 200 })
    .then(() => true)
    .catch(() => false);
  s = await snap(page);
  check("staying hidden through the cooldown escapes and banks the bounty", escaped && s.totalBounty > 0 && s.escapes === 1, `${s.heatState}, bank ${s.totalBounty}`);
  if (escaped) await shot("25-escaped");
  await page.waitForFunction(() => window.__fh.heat.state === "calm", { timeout: 20000 });

  section("Stage 4: races, speed cameras, near misses, rubbing past cars");
  await page.evaluate(() => {
    const g = window.__fh;
    g.police.setEnabled(false);
    g.env.setHours(15);
    g.env.speed = 0;
    g.traffic.enabled = true;
    g.traffic.target = 48;
  });
  const rstart = await page.evaluate(() => {
    const r = window.__fh.raceStarts.find((x) => x.def.id === "midtown-sprint");
    window.__fh.teleport(r.x, r.z, r.heading);
    return { x: r.x, z: r.z };
  });
  await waitSim(page, 3);
  s = await snap(page);
  check("race starts are on the map and the minimap (4 races, 6 speed events)", (await page.evaluate(() => [window.__fh.raceStarts.length, window.__fh.speedEvents.events.length])).join() === "4,6");
  const rp = await page.$eval(".prompt", (e) => ({ show: e.classList.contains("show"), text: e.textContent }));
  check("parking at a race beacon shows the E prompt to start it", s.raceHere === "midtown-sprint" && rp.show && /Start Midtown Rush/.test(rp.text), rp.text);
  const trafficFree = s.traffic;
  await press(page, "KeyE", 400);
  s = await snap(page);
  check("pressing E starts the race with a countdown and 3 rivals on the grid", s.race && s.race.state === "countdown" && s.race.racers === 4, JSON.stringify(s.race));
  check("traffic is reduced during the race (about a third of normal)", s.traffic <= Math.round(48 * 0.35) && (await page.evaluate(() => window.__fh.traffic.target)) === Math.round(48 * 0.35), `${trafficFree} -> ${s.traffic} cars`);
  await waitSim(page, 1.3);
  const cd = await page.$eval(".countdown", (e) => e.textContent);
  check("the countdown is shown (3, 2, 1)", /^[123]$/.test(cd), cd);
  await shot("26-race-countdown");
  await page.waitForFunction(() => window.__fh.race && window.__fh.race.state === "racing", { timeout: 20000 });
  check("GO: the race is running and the race panel shows position, lap and time", await page.$eval(".race", (e) => e.classList.contains("show") && /LAP/.test(e.textContent) && /\d(st|nd|rd|th)/.test(e.textContent)));
  // Drive the route with the keyboard: steer towards the checkpoint arrow.
  const drove = await page.evaluate(async () => {
    const g = window.__fh;
    const keys = { KeyW: false, KeyA: false, KeyD: false, KeyS: false };
    const set = (code, on) => {
      if (keys[code] === on) return;
      keys[code] = on;
      window.dispatchEvent(new KeyboardEvent(on ? "keydown" : "keyup", { code, bubbles: true }));
    };
    const t0 = g.simTime;
    const L = g.race.route.line;
    let cursor = 0;
    while (g.race && !g.race.player.finished && g.simTime - t0 < 140) {
      const c = g.car;
      const pr = L.project(c.x, c.z);
      if (Math.abs(pr.s - cursor) < 60) cursor = pr.s;
      const aim = L.sample(Math.min(L.length, cursor + 10 + c.speed * 0.5));
      let err = Math.atan2(aim.x - c.x, aim.z - c.z) - c.heading;
      while (err > Math.PI) err -= 2 * Math.PI;
      while (err < -Math.PI) err += 2 * Math.PI;
      set("KeyA", err > 0.04);
      set("KeyD", err < -0.04);
      const fast = c.speed > (Math.abs(err) > 0.3 ? 14 : 30);
      set("KeyW", !fast);
      set("KeyS", c.speed > (Math.abs(err) > 0.3 ? 18 : 36));
      await new Promise((r) => requestAnimationFrame(r));
    }
    for (const k of Object.keys(keys)) set(k, false);
    return { finished: !!g.race?.player.finished, passed: g.race?.player.passed ?? -1, time: g.race?.time ?? 0, gates: g.race?.totalGates ?? 0, best: g.save.races["midtown-sprint"]?.best ?? 0 };
  });
  check("driving the route with W/A/D passes every checkpoint and finishes the race", drove.finished || drove.best > 0, JSON.stringify(drove));
  await waitSim(page, 2.2);
  await shot("27-race-results");
  const board = await page.$eval(".board", (e) => ({ show: e.classList.contains("show"), text: e.textContent }));
  check("a results board lists all 4 racers with times", board.show && (board.text.match(/\d:\d\d\.\d\d/g) ?? []).length >= 2 && /You/.test(board.text), board.text.slice(0, 120));
  const rec = await page.evaluate(() => window.__fh.save.races["midtown-sprint"]);
  check("the best time is saved", !!rec && rec.best > 30, JSON.stringify(rec));
  await page.waitForFunction(() => window.__fh.race === null, { timeout: 15000 }).catch(() => {});
  check("after the race, normal traffic returns", (await page.evaluate(() => window.__fh.traffic.target)) === 48);

  // Speed camera: drive through the I-9 viaduct camera flat out.
  const camRes = await page.evaluate(async () => {
    const g = window.__fh;
    g.traffic.clear();
    g.traffic.enabled = false;
    const e = g.speedEvents.events.find((x) => x.def.id === "cam-i9");
    const r = g.city.net.road("i9-2");
    const proj = r.center.project(e.a.x, e.a.z);
    const p = g.city.net.pointOn("i9-2", proj.s - 260, r.laneOffset(1));
    g.teleport(p.x, p.z, p.heading);
    g.car.vx = Math.sin(p.heading) * 55;
    g.car.vz = Math.cos(p.heading) * 55;
    g.speedEvents.reset(g.car.x, g.car.z);
    return { best: g.save.speed["cam-i9"] ?? 0 };
  });
  await page.keyboard.down("KeyW");
  const flashed = await page
    .waitForFunction((b) => (window.__fh.save.speed["cam-i9"] ?? 0) > b, { timeout: 20000 }, camRes.best)
    .then(() => true)
    .catch(() => false);
  await page.keyboard.up("KeyW");
  const camSpeed = await page.evaluate(() => window.__fh.save.speed["cam-i9"] ?? 0);
  const pop = await page.$$eval(".popup .p-sub", (n) => n.map((e) => e.textContent).join(" | "));
  check("a speed camera photographs your speed (popup with medal, record saved)", flashed && camSpeed > 150 && /SPEED CAMERA/.test(pop), `${camSpeed.toFixed(0)} km/h ${pop}`);
  await shot("28-speed-camera");
  await brakeToStop(page);

  // Near miss: overtake a slow traffic car closely at speed.
  const nmBefore = (await snap(page)).nearMisses;
  await page.evaluate(() => {
    const g = window.__fh;
    g.traffic.clear();
    g.traffic.enabled = true;
    g.traffic.target = 0;
    const lane = g.city.net.road("i9-2").lanesFwd[0];
    const t = g.traffic.add(lane, 400);
    t.temper = 0.4;
    t.v = 10;
    const back = lane.poly.sample(400 - 120);
    const p = g.city.net.road("i9-2");
    const pr = p.center.project(back.x, back.z);
    const q = g.city.net.pointOn("i9-2", pr.s, p.laneOffset(1));
    g.teleport(q.x, q.z, q.heading);
    g.car.vx = Math.sin(q.heading) * 35;
    g.car.vz = Math.cos(q.heading) * 35;
    g.car.nitro = 0.2;
  });
  await page.keyboard.down("KeyW");
  await waitSim(page, 6);
  await page.keyboard.up("KeyW");
  s = await snap(page);
  check("overtaking a car closely at speed is a NEAR MISS that tops up nitro", s.nearMisses > nmBefore && s.nitro > 0.2, `near misses ${s.nearMisses - nmBefore}, nitro ${s.nitro.toFixed(2)}`);
  await brakeToStop(page);

  // Rubbing: brush past a car alongside - no crash, it stays in its lane.
  const rubbed = await page.evaluate(async () => {
    const g = window.__fh;
    g.traffic.clear();
    g.traffic.target = 0;
    const lane = g.city.net.road("i9-2").lanesFwd[0];
    const t = g.traffic.add(lane, 300);
    t.temper = 0.6;
    t.v = 18;
    g.traffic.step(1 / 60, null, t.x, t.z, null);
    const h = t.heading;
    const rx = -Math.cos(h);
    const rz = Math.sin(h);
    // Alongside, slightly behind, overlapping its side by 0.15 m, drifting in at 1.5 m/s.
    const lat = (t.model.width + g.car.def.body.width) / 2 - 0.15;
    g.teleport(t.x + rx * lat - Math.sin(h) * 1, t.z + rz * lat - Math.cos(h) * 1, h);
    g.car.vx = Math.sin(h) * 24 - rx * 1.5;
    g.car.vz = Math.cos(h) * 24 - rz * 1.5;
    const hits0 = g.trafficHits;
    const rubs0 = g.rubs;
    await new Promise((r) => setTimeout(r, 400));
    return { hits: g.trafficHits - hits0, rubs: g.rubs - rubs0, wrecked: t.wrecked > 0, alive: t.alive };
  });
  check("brushing past a car is a rub, not a crash (no knock-out, no crash effects)", rubbed.rubs > 0 && rubbed.hits === 0 && !rubbed.wrecked, JSON.stringify(rubbed));
  await brakeToStop(page);

  // A firm tap from behind (~25 km/h closing) is a BUMP: the traffic car is
  // shoved along its lane and drives on; we keep most of our speed.
  const bumped = await page.evaluate(async () => {
    const g = window.__fh;
    g.traffic.clear();
    g.traffic.target = 0;
    const lane = g.city.net.road("i9-2").lanesFwd[1];
    const t = g.traffic.add(lane, 300);
    t.temper = 0.5;
    t.v = 14;
    g.traffic.step(1 / 60, null, t.x, t.z, null);
    const h = t.heading;
    const gap = (t.model.length + g.car.def.body.length) / 2 + 0.6;
    g.teleport(t.x - Math.sin(h) * gap, t.z - Math.cos(h) * gap, h);
    g.car.vx = Math.sin(h) * 21;
    g.car.vz = Math.cos(h) * 21;
    const hits0 = g.trafficHits;
    const bumps0 = g.bumps;
    await new Promise((r) => setTimeout(r, 500));
    return { hits: g.trafficHits - hits0, bumps: g.bumps - bumps0, wrecked: t.wrecked > 0, tv: +t.v.toFixed(1), myKmh: +g.car.speedKmh.toFixed(0) };
  });
  check("a firm tap from behind is a bump: the car is shoved along its lane and drives on, you keep going", bumped.bumps > 0 && bumped.hits === 0 && !bumped.wrecked && bumped.tv > 14 && bumped.myKmh > 40, JSON.stringify(bumped));
  await brakeToStop(page);

  // Driving under the I-9 viaduct: no invisible wall, no jolt, the chase
  // camera holds its distance, and the deck's underside is drawn overhead.
  const under = await page.evaluate(async () => {
    const g = window.__fh;
    g.traffic.clear();
    const r = g.city.net.road("main-0");
    const p = g.city.net.pointOn("main-0", r.s0 + 1, r.laneOffset(0));
    g.teleport(p.x, p.z, p.heading);
    return { y0: g.car.y };
  });
  await waitSim(page, 0.4);
  await page.keyboard.down("KeyW");
  const samples = [];
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 110));
    samples.push(await page.evaluate(() => { const g = window.__fh; const c = g.car; return { v: c.speedKmh, y: c.y, cam: Math.hypot(g.camera.position.x - c.x, g.camera.position.z - c.z) }; }));
    if (i === 9) await shot("31-under-viaduct");
  }
  await page.keyboard.up("KeyW");
  const vDrop = samples.slice(3).some((q, i) => q.v < samples.slice(3)[Math.max(0, i - 1)].v - 8);
  const yJump = Math.max(...samples.map((q) => Math.abs(q.y - under.y0)));
  const cams = samples.slice(4).map((q) => q.cam);
  check("driving under the viaduct: no invisible wall, no jump onto the deck, the camera holds steady", !vDrop && yJump < 0.6 && Math.max(...cams) - Math.min(...cams) < 1.5, `y ${yJump.toFixed(2)} m, camera ${Math.min(...cams).toFixed(1)}..${Math.max(...cams).toFixed(1)} m, speeds ${samples.map((q) => q.v.toFixed(0)).join(",")}`);
  // The deck underside is visible from below: sample the top of the screen (sky would be bright blue).
  const roof = await page.evaluate(async () => {
    const g = window.__fh;
    g.car.vx = g.car.vz = 0;
    const r = g.city.net.road("main-0");
    const i9 = g.city.net.road("i9-2");
    // Stand right under the deck.
    let best = { s: r.s0, d: 1e9 };
    for (let s = r.s0; s < r.s1; s += 0.5) { const p = r.center.sample(s); const q = i9.center.project(p.x, p.z); if (q.dist < best.d) best = { s, d: q.dist }; }
    const p = g.city.net.pointOn("main-0", best.s, r.laneOffset(0));
    g.teleport(p.x, p.z, p.heading, r.heightAt(best.s) + 0.3); // on the street, under the deck
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    // Look straight up from the car.
    g.camera.position.set(g.car.x, g.car.y + 1.5, g.car.z);
    g.camera.lookAt(g.car.x, g.car.y + 50, g.car.z + 0.01);
    g.renderer.render(g.scene, g.camera);
    const gl = g.renderer.getContext();
    const px = new Uint8Array(4);
    gl.readPixels(gl.drawingBufferWidth >> 1, gl.drawingBufferHeight >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { rgb: [...px.slice(0, 3)], under: g.car.y < 6 };
  });
  const skyish = roof.rgb[2] > 150 && roof.rgb[2] > roof.rgb[0] + 30;
  check("looking up from under the viaduct you see the concrete deck, not open sky", roof.under && !skyish, `rgb ${roof.rgb.join(",")}, on the street: ${roof.under}`);
  await page.evaluate(() => window.__fh.rig.snap());
  await page.evaluate(() => {
    const g = window.__fh;
    g.traffic.target = 48;
    g.police.setEnabled(true);
  });

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
  for (let i = 0; i < 5; i++) await press(page, "ArrowDown", 60);
  const sens0 = await page.evaluate(() => window.__fh.save.steering);
  await press(page, "ArrowRight", 200);
  const sens1 = await page.evaluate(() => [window.__fh.save.steering, window.__fh.car.sensitivity]);
  check("steering sensitivity can be raised in Settings and applies to the car", sens1[0] > sens0 && sens1[1] === sens1[0], `${sens0} -> ${sens1[0]} (car ${sens1[1]})`);
  await press(page, "ArrowLeft", 200);
  await press(page, "ArrowDown", 60);
  await press(page, "ArrowRight", 200);
  const polOff = await page.evaluate(() => [window.__fh.save.police, window.__fh.police.enabled]);
  await press(page, "ArrowRight", 200);
  const polOn = await page.evaluate(() => [window.__fh.save.police, window.__fh.police.enabled]);
  check("Police chases can be switched off (free roam) and back on in Settings", polOff[0] === false && polOff[1] === false && polOn[0] === true && polOn[1] === true, JSON.stringify({ polOff, polOn }));
  await press(page, "ArrowDown", 60);
  await press(page, "ArrowRight", 250);
  const rainOn = await page.evaluate(() => [window.__fh.save.rain, window.__fh.weather.rain]);
  check("Rain can be turned on in Settings", rainOn[0] === "on" && rainOn[1] > 0.5, JSON.stringify(rainOn));
  await press(page, "Escape", 200);
  await press(page, "Escape", 300);
  await onRoad("main-5", 0.3, 0, true);
  await holdSim(page, ["KeyW"], 2);
  s = await snap(page);
  check("in the rain the road is wet and the car feels it (wet grip)", s.rain > 0.5 && s.wet > 0.5 && (await page.evaluate(() => window.__fh.car.wet)) > 0.5, `rain ${s.rain.toFixed(2)} wet ${s.wet.toFixed(2)}`);
  await shot("29-rain");
  await brakeToStop(page);
  await press(page, "Escape", 300);
  await menuTo("pause", "settings");
  await press(page, "Enter", 300);
  await menuTo("settings", "rain");
  await press(page, "ArrowLeft", 250);
  await press(page, "ArrowLeft", 250);
  check("...and back to dry", (await page.evaluate(() => window.__fh.save.rain)) === "off");
  await menuTo("settings", "keys");
  await press(page, "Enter", 300);
  check("Controls opens the key-remap screen", (await snap(page)).state === "keys");
  await shot("30-remap");
  // Rebind Nitro to N.
  await menuTo("keys", "key-nitro");
  await press(page, "Enter", 200);
  await press(page, "KeyN", 300);
  const nitroKeys = await page.evaluate(() => [window.__fh.input.bindings.nitro, window.__fh.save.keys.nitro]);
  check("Enter then a key rebinds an action (Nitro -> N), saved", nitroKeys[0][0] === "KeyN" && nitroKeys[1]?.[0] === "KeyN", JSON.stringify(nitroKeys));
  await press(page, "Escape", 300);
  await press(page, "Escape", 200);
  await press(page, "Escape", 300);
  await onRoad("i9-2", 0.22, 1);
  await page.evaluate(() => (window.__fh.car.nitro = 1));
  await holdSim(page, ["KeyW"], 1);
  await page.keyboard.down("KeyW");
  await page.keyboard.down("KeyN");
  await waitSim(page, 0.4);
  const nOn = (await snap(page)).nitroActive;
  await page.keyboard.up("KeyN");
  await page.keyboard.up("KeyW");
  check("the remapped key works in the car (N fires nitro)", nOn);
  await brakeToStop(page);
  // Reset bindings to defaults again for the rest of the run.
  await press(page, "Escape", 300);
  await menuTo("pause", "settings");
  await press(page, "Enter", 300);
  await menuTo("settings", "keys");
  await press(page, "Enter", 300);
  await menuTo("keys", "keys-reset");
  await press(page, "Enter", 250);
  check("Reset to defaults restores Shift for nitro", (await page.evaluate(() => window.__fh.input.bindings.nitro[0])) === "ShiftLeft");
  // Back out: keys -> settings -> pause -> driving.
  for (let i = 0; i < 4 && (await snap(page)).state !== "drive"; i++) await press(page, "Escape", 300);
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
  });
  await onRoad("main-5", 0.15, 0, true);
  await page.evaluate(() => {});
  await holdSim(page, ["KeyW"], 2.5);
  s = await snap(page);
  check("night mode is active at 22:00", s.night > 0.9);
  // Night visibility WITHOUT headlights: moonlight, sky glow and street
  // lights must show the road and the city (the world part of the frame
  // used to be ~70-95% near-black).
  const nightVis = await page.evaluate(() => {
    const g = window.__fh;
    const hls = g.scene.children.filter((o) => o.isSpotLight);
    for (const h of hls) h.visible = false;
    g.renderer.render(g.scene, g.camera);
    const gl = g.renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (const l of hls) l.visible = true;
    let sum = 0;
    let n = 0;
    let dark = 0;
    for (let y = 0; y < Math.floor(h * 0.62); y += 3) {
      for (let x = 0; x < w; x += 3) {
        const i = (y * w + x) * 4;
        const L = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        sum += L;
        n++;
        if (L < 12) dark++;
      }
    }
    return { mean: sum / n, dark: dark / n };
  });
  check("at night the road and city are visible without headlights (moon, sky glow, street lights)", nightVis.mean > 25 && nightVis.dark < 0.4, `mean luma ${nightVis.mean.toFixed(1)}, ${(nightVis.dark * 100).toFixed(0)}% near-black`);
  // Night glare: right behind a traffic car and facing a wall, the view
  // ahead must not wash out to white.
  const glare = async () => {
    const b64 = await page.screenshot({ encoding: "base64", clip: { x: 360, y: 250, width: 720, height: 300 } });
    return page.evaluate(async (b64) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let white = 0;
      for (let i = 0; i < d.length; i += 4) if (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] > 235) white++;
      return white / (d.length / 4);
    }, b64);
  };
  await page.evaluate(() => {
    const g = window.__fh;
    const c = g.traffic.cars.filter((k) => k.seg.kind === "lane" && k.s > 20 && k.model.kind !== "bus")[0];
    g.traffic.enabled = false;
    const p = c.seg.poly.sample(c.s - 6.5);
    g.teleport(p.x, p.z, Math.atan2(c.x - p.x, c.z - p.z));
  });
  await waitSim(page, 0.5);
  const gA = await glare();
  await shot("21-night-behind-traffic");
  await page.evaluate(() => {
    const g = window.__fh;
    const b = g.city.buildings.filter((x) => x.district === "downtown" && x.box.hx > 12)[0];
    const { cx, cz, hz, c, s } = b.box;
    g.teleport(cx + s * (hz + 9), cz - c * (hz + 9), Math.atan2(-s, c));
  });
  await waitSim(page, 0.5);
  const gB = await glare();
  check("night headlights never white out the view (behind traffic / facing a wall)", gA < 0.08 && gB < 0.08, `white ${(gA * 100).toFixed(1)}% / ${(gB * 100).toFixed(1)}%`);
  await page.evaluate(() => (window.__fh.traffic.enabled = true));
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
  // The browser may be capped below 60 Hz (e.g. macOS Low Power Mode on
  // battery caps requestAnimationFrame at 30). Measure the cap with an empty
  // rAF loop and require the game to hold >= 85% of it.
  const cap = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else res(n / ((performance.now() - t0) / 1000)); }; requestAnimationFrame(f); }));
  console.log(`  (display refresh cap measured at ${cap.toFixed(0)} Hz)`);
  if (gpu) check("holds the display's full frame rate while driving (>= 85% of the refresh cap)", fps >= cap * 0.85, `${fps.toFixed(1)} fps of ${cap.toFixed(0)} Hz`);
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
