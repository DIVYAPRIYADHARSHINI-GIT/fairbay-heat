/**
 * Physically-modelled engine sound synthesiser.
 *
 * Instead of playing a tone, it simulates what makes a real engine sound
 * like one:
 *
 *  1. Combustion. A 4-stroke crank turns once per 2 revolutions; each
 *     cylinder fires in its own slot of the 720-degree cycle. Every firing is
 *     a short pressure pulse whose size follows throttle load, and varies a
 *     little per cylinder (fixed manufacturing differences) and per cycle
 *     (combustion randomness). Those small irregularities put energy at the
 *     half-order frequencies and are the main reason real engines sound
 *     "lumpy" and organic rather than synthetic.
 *  2. Exhaust. Each bank of cylinders feeds its own primary pipe, modelled
 *     as a damped waveguide (a feedback delay with a reflection at the open
 *     end), so pipe length sets the resonances. A cross-plane V8 fires
 *     unevenly within each bank - that is where its burble comes from. The
 *     banks merge into a tail pipe (another waveguide) and a muffler
 *     (low-pass whose cut-off opens with throttle).
 *  3. Intake roar, valvetrain/mechanical noise, a turbo whistle that spools
 *     with lag and a blow-off valve "pssh" when the throttle snaps shut,
 *     overrun pops and crackles, and a rev limiter that cuts ignition in
 *     bursts.
 *
 * The class is completely self-contained (no imports, no outer references)
 * because its source text is also injected into an AudioWorklet. It runs
 * unchanged in Node for the unit tests.
 */

export interface EngineSynthSpec {
  cylinders: number;
  idle: number;
  redline: number;
  banks: number[][];
  pipes: [number, number];
  muffler: number;
  turbos: number;
  crackle: number;
  intake: number;
  rough: number;
  /** Header length mismatch between banks (0 = equal-length). Optional. */
  headerMismatch?: number;
}

export interface EngineControl {
  rpm: number;
  /** 0..1 throttle load. */
  load: number;
  limiter: boolean;
  /** Master gain 0..1. */
  gain: number;
}

export class EngineSynth {
  sr: number;
  spec: EngineSynthSpec;
  // smoothed controls
  rpm = 800;
  load = 0;
  gain = 0;
  tRpm = 800;
  tLoad = 0;
  tGain = 0;
  limiter = false;
  // crank
  phase = 0;
  slotOf: number[] = [];
  bankOf: number[] = [];
  cylAmp: number[] = [];
  cylJit: number[] = [];
  nextSlot = 0;
  // per-bank pulse state
  pulseAmp: Float32Array;
  pulseT: Float32Array;
  pulseTau: Float32Array;
  bankIn: Float32Array;
  /** Level of the far exhaust bank relative to the near one. */
  farBank: number;
  // waveguides (one per bank + tail)
  bufs: Float32Array[] = [];
  lens: number[] = [];
  idx: number[] = [];
  lp: number[] = [];
  tail: Float32Array;
  tailLen: number;
  tailIdx = 0;
  tailLp = 0;
  // filters
  muf1 = 0;
  muf2 = 0;
  dcX = 0;
  dcY = 0;
  intakeBp: number[] = [0, 0];
  mechHp = 0;
  // turbo
  boost = 0;
  turboPhase = 0;
  bov = 0;
  bovBp: number[] = [0, 0];
  flutter = 0;
  prevLoad = 0;
  // crackle
  pop = 0;
  popLp = 0;
  // limiter
  cutT = 0;
  // rng
  seed: number;
  constructor(sampleRate: number, spec: EngineSynthSpec, seed = 1) {
    this.sr = sampleRate;
    this.spec = spec;
    this.seed = seed >>> 0 || 1;
    const n = spec.cylinders;
    for (let b = 0; b < spec.banks.length; b++) {
      for (const slot of spec.banks[b]) {
        this.slotOf.push(slot);
        this.bankOf[slot] = b;
      }
    }
    for (let i = 0; i < n; i++) {
      this.cylAmp.push(0.86 + 0.28 * this.rand());
      this.cylJit.push((this.rand() - 0.5) * 0.03);
      if (this.bankOf[i] === undefined) this.bankOf[i] = i % spec.banks.length;
    }
    const nb = spec.banks.length;
    this.pulseAmp = new Float32Array(n);
    this.pulseT = new Float32Array(n).fill(1e9);
    this.pulseTau = new Float32Array(n).fill(0.001);
    this.bankIn = new Float32Array(nb);
    this.farBank = 1 - (spec.headerMismatch ?? 0.06) * 1.6;
    const c = 460; // speed of sound in hot exhaust gas, m/s
    for (let b = 0; b < nb; b++) {
      // Slightly different primary lengths per bank, like real headers.
      // Unequal-length headers per bank (real cars rarely have equal ones).
      const L = spec.pipes[0] * (1 + (spec.headerMismatch ?? 0.06) * b);
      const len = Math.max(8, Math.round(((2 * L) / c) * sampleRate));
      this.bufs.push(new Float32Array(len));
      this.lens.push(len);
      this.idx.push(0);
      this.lp.push(0);
    }
    this.tailLen = Math.max(8, Math.round(((2 * spec.pipes[1]) / c) * sampleRate));
    this.tail = new Float32Array(this.tailLen);
    this.rpm = this.tRpm = spec.idle;
  }

  rand(): number {
    // xorshift32
    let x = this.seed;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.seed = x;
    return x / 4294967296;
  }

  set(c: EngineControl): void {
    this.tRpm = Math.max(200, c.rpm);
    this.tLoad = Math.min(1, Math.max(0, c.load));
    this.tGain = Math.min(1, Math.max(0, c.gain));
    this.limiter = c.limiter;
  }

  /** Renders `out.length` samples (mono). */
  render(out: Float32Array): void {
    const sp = this.spec;
    const sr = this.sr;
    const n = sp.cylinders;
    const nb = sp.banks.length;
    const kR = 1 - Math.exp(-1 / (0.03 * sr)); // rpm smoothing ~30 ms
    const kL = 1 - Math.exp(-1 / (0.025 * sr));
    const kG = 1 - Math.exp(-1 / (0.05 * sr));
    const redline = sp.redline;
    for (let i = 0; i < out.length; i++) {
      this.rpm += (this.tRpm - this.rpm) * kR;
      this.load += (this.tLoad - this.load) * kL;
      this.gain += (this.tGain - this.gain) * kG;
      const rpm = this.rpm;
      const load = this.load;
      const revFrac = Math.min(1.2, rpm / redline);

      // ---- crank + ignition ----------------------------------------------
      const cycleHz = rpm / 120;
      this.phase += cycleHz / sr;
      // Rev limiter: cut ignition for 35 ms, re-fire for 45 ms (~12 Hz bounce).
      this.cutT -= 1 / sr;
      if (this.limiter && this.cutT <= -0.045) this.cutT = 0.035;
      if (!this.limiter && this.cutT < -1) this.cutT = -1;
      // Fire every slot whose time has come. Slot k fires at phase k/n of the
      // 720-degree cycle; the cycle wraps after the last slot.
      if (this.phase >= 1) {
        this.phase -= 1;
        this.nextSlot = 0;
      }
      while (this.nextSlot < n && this.phase >= Math.max(0, (this.nextSlot + this.cylJit[this.nextSlot]) / n)) {
        this.fire(this.nextSlot, load, revFrac, cycleHz);
        this.nextSlot++;
      }

      // ---- pulses -> primaries ---------------------------------------------
      let merged = 0;
      const bankIn = this.bankIn;
      bankIn.fill(0);
      for (let c = 0; c < n; c++) {
        const t = this.pulseT[c];
        const tau = this.pulseTau[c];
        if (t < 10 * tau) {
          const u = t / tau;
          // Gamma-like pressure pulse: fast rise, exponential decay.
          bankIn[this.bankOf[c]] += this.pulseAmp[c] * u * Math.exp(1 - u);
          this.pulseT[c] = t + 1 / sr;
        }
      }
      for (let b = 0; b < nb; b++) {
        const x = bankIn[b];
        // Waveguide: y = x + r * lowpass(y delayed by round trip).
        const buf = this.bufs[b];
        const j = this.idx[b];
        const delayed = buf[j];
        this.lp[b] += (delayed - this.lp[b]) * 0.42;
        const y = x - 0.62 * this.lp[b];
        buf[j] = y;
        this.idx[b] = (j + 1) % this.lens[b];
        // The listener sits nearer one tail pipe, so banks are not summed
        // evenly - this keeps each bank's uneven firing (V8 burble) audible.
        merged += y * (b === 0 ? 1 : this.farBank);
      }
      merged /= Math.sqrt(nb);

      // ---- tail pipe ----------------------------------------------------------
      const td = this.tail[this.tailIdx];
      this.tailLp += (td - this.tailLp) * 0.3;
      const ty = merged + 0.5 * this.tailLp;
      this.tail[this.tailIdx] = ty;
      this.tailIdx = (this.tailIdx + 1) % this.tailLen;

      // ---- muffler: 2-pole low-pass opening with load and revs ---------------
      const fc = Math.min(sr * 0.45, sp.muffler * (0.28 + 0.55 * load + 0.35 * revFrac));
      const a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
      this.muf1 += (ty - this.muf1) * a;
      this.muf2 += (this.muf1 - this.muf2) * a;
      let s = this.muf2 * (2.2 + 0.9 * load);

      // ---- overrun crackle ------------------------------------------------------
      if (this.pop > 0.0005) {
        const nz = this.rand() * 2 - 1;
        this.popLp += (nz - this.popLp) * 0.35;
        s += this.popLp * this.pop * 3.2;
        this.pop *= 0.9985 - 0.004 * this.rand();
      }

      // ---- intake roar ------------------------------------------------------------
      if (sp.intake > 0) {
        const nz = this.rand() * 2 - 1;
        const f = 250 + 900 * revFrac;
        const q = 2 * Math.sin((Math.PI * f) / sr);
        // Chamberlin state-variable band-pass.
        const low = this.intakeBp[0] + q * this.intakeBp[1];
        const high = nz - low - 0.6 * this.intakeBp[1];
        const band = q * high + this.intakeBp[1];
        this.intakeBp[0] = low;
        this.intakeBp[1] = band;
        const throb = 0.6 + 0.4 * Math.sin(this.phase * Math.PI * 2 * n);
        s += band * sp.intake * load * (0.12 + 0.35 * revFrac) * throb;
      }

      // ---- valvetrain / mechanical whine ------------------------------------------
      const m = this.rand() * 2 - 1;
      this.mechHp += (m - this.mechHp) * 0.08;
      s += (m - this.mechHp) * 0.025 * revFrac * revFrac;

      // ---- turbo -------------------------------------------------------------------
      if (sp.turbos > 0) {
        const want = load > 0.5 ? Math.min(1, Math.max(0, (revFrac - 0.25) / 0.45)) : 0;
        const spool = want > this.boost ? 1 / (0.75 * sr) : 1 / (0.25 * sr);
        this.boost += (want - this.boost) * spool * 6;
        // Blow-off valve: the throttle (target, not the smoothed load) snapping shut under boost.
        if (this.prevLoad > 0.6 && this.tLoad < 0.3 && this.boost > 0.45) {
          this.bov = this.boost;
          this.flutter = this.boost * 0.6;
        }
        const wf = 2400 + 7200 * this.boost;
        this.turboPhase += wf / sr;
        if (this.turboPhase > 1) this.turboPhase -= 1;
        s += Math.sin(this.turboPhase * Math.PI * 2) * this.boost * this.boost * 0.05 * Math.min(2, sp.turbos);
        if (this.bov > 0.002) {
          const nz = this.rand() * 2 - 1;
          const f = 2600;
          const q = 2 * Math.sin((Math.PI * f) / sr);
          const low = this.bovBp[0] + q * this.bovBp[1];
          const high = nz - low - 0.9 * this.bovBp[1];
          const band = q * high + this.bovBp[1];
          this.bovBp[0] = low;
          this.bovBp[1] = band;
          s += band * this.bov * 0.9;
          this.bov *= 1 - 3.5 / sr;
        }
        if (this.flutter > 0.002) {
          // Compressor surge "flutter": chopped low noise at ~22 Hz.
          const chop = Math.sin(this.turboPhase * 0 + (i / sr) * Math.PI * 2 * 22) > 0.3 ? 1 : 0.2;
          s += (this.rand() * 2 - 1) * this.flutter * 0.12 * chop;
          this.flutter *= 1 - 5 / sr;
        }
      }
      this.prevLoad = this.tLoad;

      // ---- DC block, level, soft clip -------------------------------------------
      const dc = s - this.dcX + 0.995 * this.dcY;
      this.dcX = s;
      this.dcY = dc;
      const level = (0.75 + 0.35 * load + 0.25 * revFrac) * this.gain;
      out[i] = Math.tanh(dc * level * 1.6) * 0.9;
    }
  }

  private fire(slot: number, load: number, revFrac: number, cycleHz: number): void {
    const sp = this.spec;
    const b = this.bankOf[slot];
    let amp = this.cylAmp[slot] * (0.45 + 0.55 * load);
    // Combustion randomness: larger at idle and with lumpy cams.
    const lump = sp.rough * (1.2 - revFrac);
    amp *= 1 + (this.rand() - 0.5) * 2 * (0.08 + lump);
    // Occasional weak firing at idle on a rough engine.
    if (load < 0.1 && revFrac < 0.2 && this.rand() < sp.rough * 0.08) amp *= 0.35;
    // Limiter / overrun ignition cut.
    if (this.cutT > 0) amp *= 0.05;
    // Overrun: almost no combustion, plus unburnt-fuel pops in the exhaust.
    if (load < 0.05 && revFrac > 0.42) {
      amp *= 0.25;
      if (this.rand() < sp.crackle * 0.07 * revFrac) this.pop = Math.max(this.pop, 0.25 + 0.75 * this.rand() * sp.crackle);
    }
    if (this.limiter && this.cutT > 0 && this.rand() < 0.25) this.pop = Math.max(this.pop, 0.4 * sp.crackle);
    this.pulseAmp[slot] = amp;
    this.pulseT[slot] = 0;
    // The exhaust valve is open for ~240 crank degrees; the pressure pulse
    // peaks early in that window. Width scales with the time per revolution.
    const rev = 1 / (cycleHz * 2);
    this.pulseTau[slot] = Math.max(0.0004, rev * 0.06);
    void b;
  }
}
