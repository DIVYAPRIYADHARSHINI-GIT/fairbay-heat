import { describe, expect, it } from "vitest";
import { EngineSynth } from "../../src/audio/engineSynth";
import { CARS, carById } from "../../src/game/cars";

const SR = 22050;

/** Hann-windowed single-bin DFT amplitude. */
function amp(x: ArrayLike<number>, f: number): number {
  let re = 0;
  let im = 0;
  const N = x.length;
  for (let i = 0; i < N; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    const a = (2 * Math.PI * f * i) / SR;
    re += w * x[i] * Math.cos(a);
    im -= w * x[i] * Math.sin(a);
  }
  return (2 * Math.hypot(re, im)) / N;
}

function render(id: string, rpm: number, load: number, seconds: number, limiter = false): Float32Array {
  const e = carById(id).handling.engine;
  const s = new EngineSynth(SR, e, 5);
  const out = new Float32Array(Math.round(SR * seconds));
  s.set({ rpm, load, limiter, gain: 1 });
  s.rpm = rpm;
  s.load = load;
  s.gain = 1;
  s.render(out);
  return out;
}

const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);

describe("engine synthesiser", () => {
  it("is stable for every car across the rev range (finite, never clips past 0.9)", () => {
    for (const c of CARS) {
      const e = c.handling.engine;
      for (const [rpm, load] of [
        [e.idle, 0],
        [e.redline * 0.5, 1],
        [e.redline, 1],
        [e.redline * 0.8, 0],
      ]) {
        const x = render(c.id, rpm, load, 0.6);
        expect(x.every(Number.isFinite), c.id).toBe(true);
        expect(Math.max(...x.map(Math.abs)), c.id).toBeLessThanOrEqual(0.9);
        expect(rms(x), `${c.id} silent at ${rpm}`).toBeGreaterThan(0.02);
      }
    }
  });

  it("the dominant tone is the cylinder firing frequency (rpm/60 x cylinders/2)", () => {
    for (const c of CARS) {
      const e = c.handling.engine;
      const rpm = 3000;
      const x = render(c.id, rpm, 0.6, 1.2).subarray(SR * 0.4);
      const fire = (rpm / 60) * (e.cylinders / 2);
      const a = amp(x, fire);
      for (const f of [fire * 0.77, fire * 1.31, fire * 0.61]) expect(a, `${c.id} @ ${f.toFixed(0)} Hz`).toBeGreaterThan(amp(x, f) * 3);
    }
  });

  it("pitch follows rpm: doubling rpm doubles the firing frequency", () => {
    const e = carById("carrara").handling.engine;
    for (const rpm of [2000, 4000]) {
      const x = render("carrara", rpm, 0.6, 1.2).subarray(SR * 0.4);
      const fire = (rpm / 60) * (e.cylinders / 2);
      expect(amp(x, fire)).toBeGreaterThan(amp(x, fire * 0.5) * 2);
    }
  });

  it("a cross-plane V8 burbles: much more energy between firing harmonics than a V12 or W16", () => {
    const side = (id: string) => {
      const e = carById(id).handling.engine;
      const crank = e.idle / 60;
      const x = render(id, e.idle, 0.05, 2).subarray(SR * 0.5);
      const fo = e.cylinders / 2;
      let s = 0;
      let m = 0;
      for (let o = fo; o <= 4 * fo + 1e-6; o += 0.5) {
        const p = amp(x, crank * o) ** 2;
        if (Math.abs(o / fo - Math.round(o / fo)) < 1e-6) m += p;
        else s += p;
      }
      return s / m;
    };
    const v8 = side("mustanger");
    expect(v8).toBeGreaterThan(side("vantis") * 3);
    expect(v8).toBeGreaterThan(side("veyrone") * 3);
  });

  it("full throttle is louder than overrun at the same revs", () => {
    for (const c of CARS) {
      const r = c.handling.engine.redline * 0.6;
      expect(rms(render(c.id, r, 1, 0.8).subarray(SR * 0.3)), c.id).toBeGreaterThan(rms(render(c.id, r, 0, 0.8).subarray(SR * 0.3)) * 1.15);
    }
  });

  it("the rev limiter chops the sound (strong ~10-30 Hz amplitude modulation)", () => {
    const e = carById("aventura").handling.engine;
    const env = (lim: boolean) => {
      const x = render("aventura", e.redline, 1, 1.5, lim).subarray(SR * 0.3);
      const blk = Math.round(SR * 0.005);
      const vals: number[] = [];
      for (let i = 0; i + blk < x.length; i += blk) vals.push(rms(x.subarray(i, i + blk)));
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      return Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) / mean;
    };
    expect(env(true)).toBeGreaterThan(env(false) * 1.5);
  });

  it("turbo cars whistle when boosted and blow off when the throttle snaps shut", () => {
    const e = carById("gtarr").handling.engine;
    const s = new EngineSynth(SR, e, 9);
    const buf = new Float32Array(SR * 2);
    s.set({ rpm: e.redline * 0.8, load: 1, limiter: false, gain: 1 });
    s.render(buf);
    expect(s.boost).toBeGreaterThan(0.6);
    s.set({ rpm: e.redline * 0.8, load: 0, limiter: false, gain: 1 });
    s.render(new Float32Array(Math.round(SR * 0.08)));
    expect(s.bov).toBeGreaterThan(0.2);
    const na = new EngineSynth(SR, carById("carrara").handling.engine, 9);
    na.set({ rpm: 6000, load: 1, limiter: false, gain: 1 });
    na.render(buf);
    expect(na.boost).toBe(0);
  });

  it("lifting off at high revs makes overrun crackles on cars tuned for it", () => {
    const e = carById("aventura").handling.engine;
    const s = new EngineSynth(SR, e, 11);
    s.set({ rpm: e.redline * 0.85, load: 0, limiter: false, gain: 1 });
    s.load = 0;
    let pops = 0;
    const b = new Float32Array(256);
    for (let i = 0; i < 300; i++) {
      s.render(b);
      if (s.pop > 0.2) pops++;
    }
    expect(pops).toBeGreaterThan(5);
  });

  it("different cars sound different (spectral centroid at the same rpm/load differs)", () => {
    const centroid = (id: string) => {
      const x = render(id, 4500, 1, 1).subarray(SR * 0.3);
      let num = 0;
      let den = 0;
      for (let f = 40; f < 4000; f += 40) {
        const a = amp(x, f);
        num += f * a;
        den += a;
      }
      return num / den;
    };
    const cs = CARS.map((c) => centroid(c.id));
    const sorted = [...cs].sort((a, b) => a - b);
    expect(sorted[sorted.length - 1] / sorted[0]).toBeGreaterThan(1.3);
  });
});
