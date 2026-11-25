/**
 * Shared headless-Chrome harness: serves `dist/` exactly like a static host,
 * launches Chrome (hardware GL via ANGLE/Metal on macOS when available,
 * SwiftShader otherwise), and offers real keyboard helpers.
 */

import puppeteer from "puppeteer";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

export function resolveChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try {
    const p = puppeteer.executablePath();
    if (typeof p === "string" && existsSync(p)) return p;
  } catch {
    /* fall through */
  }
  for (const c of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"]) if (existsSync(c)) return c;
  throw new Error("No Chrome found; set CHROME_PATH");
}

export async function serveDist() {
  const server = createServer(async (req, res) => {
    try {
      let p = normalize(decodeURIComponent(req.url.split("?")[0]));
      if (p === "/" || p.endsWith("/")) p += "index.html";
      const file = join(DIST, p);
      if (!file.startsWith(DIST)) return void res.writeHead(403).end();
      await stat(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

export async function launch({ gpu = process.env.FH_GPU !== "0", width = 1440, height = 900 } = {}) {
  const args = ["--autoplay-policy=no-user-gesture-required", "--no-sandbox", `--window-size=${width},${height}`];
  if (gpu && process.platform === "darwin") args.push("--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist");
  else args.push("--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader");
  const browser = await puppeteer.launch({ headless: true, executablePath: resolveChrome(), args, protocolTimeout: 240000 });
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  return { browser, page };
}

export async function gotoGame(page, url, { clearSave = true } = {}) {
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  if (clearSave) {
    await page.goto(url + "#blank");
    await page.evaluate(() => localStorage.clear());
  }
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => window.__fh && window.__fh.state === "title", { timeout: 120000 });
  return errors;
}

export const snap = (page) => page.evaluate(() => window.__fh.snapshot());

/** Holds keys for `ms` of real time (real keydown/keyup events). */
export async function hold(page, keys, ms) {
  for (const k of keys) await page.keyboard.down(k);
  await new Promise((r) => setTimeout(r, ms));
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
}

/** Waits until the simulation has advanced `seconds` of game time. */
export async function waitSim(page, seconds, timeout = 60000) {
  const t0 = (await snap(page)).simTime;
  await page.waitForFunction((t) => window.__fh.simTime >= t, { timeout }, t0 + seconds);
}

/** Holds keys until `seconds` of SIMULATED time pass (robust on slow GL). */
export async function holdSim(page, keys, seconds) {
  for (const k of keys) await page.keyboard.down(k);
  await waitSim(page, seconds);
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
}

export async function press(page, key, after = 120) {
  await page.keyboard.press(key);
  await new Promise((r) => setTimeout(r, after));
}

export function checker() {
  let pass = 0;
  let fail = 0;
  const failures = [];
  return {
    check(name, cond, detail = "") {
      if (cond) {
        pass++;
        console.log(`  \u2714 ${name}`);
      } else {
        fail++;
        failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
        console.log(`  \u2716 ${name}${detail ? ` - ${detail}` : ""}`);
      }
    },
    section(t) {
      console.log(`\n\u2500\u2500 ${t}`);
    },
    summary() {
      console.log(`\n${pass} passed, ${fail} failed`);
      if (failures.length) console.log(failures.map((f) => `  - ${f}`).join("\n"));
      return fail;
    },
  };
}

/** Holds S/brake only until the car is (nearly) stopped, then releases. */
export async function brakeToStop(page, key = "KeyS") {
  await page.keyboard.down(key);
  await page.waitForFunction(() => window.__fh.car.speedKmh < 2 || window.__fh.car.vLong < 0.3, { timeout: 60000 });
  await page.keyboard.up(key);
}
