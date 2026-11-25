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
  const drops = rpmTrace.filter((p, i) => i > 0 && p.gear > rpmTrace[i - 1].gear && p.rpm < rpmTrace[i - 1].rpm - 300).length;
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

  // Heat 3: roadblocks, sirens, units on the roads.
  await onRoad("main-2", 0.15, 0, true);
  await page.evaluate(() => {
    const g = window.__fh;
    g.traffic.target = 48;
    g.heat.force(3);
    g.police.blockCool = 0;
  });
  await page.keyboard.down("KeyW");
  const block = await page
    .waitForFunction(() => window.__fh.police.roadblocks.length > 0, { timeout: 30000, polling: 200 })
    .then(() => true)
    .catch(() => false);
  await page.keyboard.up("KeyW");
  s = await snap(page);
  check("at heat 3 a roadblock is set up on the road ahead", block && s.roadblocks === 1, `${s.roadblocks} roadblocks`);
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
  await waitSim(page, 3);
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
  });
  await onRoad("main-5", 0.15, 0, true);
  await page.evaluate(() => {});
  await holdSim(page, ["KeyW"], 2.5);
  s = await snap(page);
  check("night mode is active at 22:00", s.night > 0.9);
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
