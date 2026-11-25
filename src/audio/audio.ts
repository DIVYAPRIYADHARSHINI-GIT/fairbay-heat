/**
 * Game audio. Everything is synthesised live - there are no audio files.
 *
 *  - Player engine: the physically-modelled `EngineSynth` (engineSynth.ts)
 *    running in an AudioWorklet on the audio thread, fed the real gearbox
 *    rpm, throttle load and rev-limiter state every frame.
 *  - Exhaust space: a synthetic impulse-response convolver adds the
 *    slap-back of nearby buildings; its level follows how built-up the
 *    surroundings are (city canyon vs open country).
 *  - Tyres: squeal is band-limited noise whose pitch and level follow slip;
 *    rolling road noise follows speed and surface (asphalt vs gravel).
 *  - Wind rises with speed. Impacts are noise bursts plus panel resonances.
 *  - Traffic: up to 6 nearby cars get a light engine voice with distance
 *    attenuation, stereo pan and Doppler shift; horns are two-tone.
 *
 * The AudioContext is only created on the first key press (autoplay rules).
 */

import { clamp } from "../core/math";
import { EngineSynth, type EngineSynthSpec } from "./engineSynth";

const WORKLET_NAME = "fairbay-engine";

function workletSource(): string {
  // The synth class is self-contained, so its source text runs in the worklet.
  // Bind the class source to a fixed name: a minifier may rename the class or
  // emit it as an anonymous class expression.
  return `
const EngineSynth = (${EngineSynth.toString()});
class EngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.synth = null;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "spec") this.synth = new EngineSynth(sampleRate, m.spec, m.seed || 1);
      else if (m.type === "ctl" && this.synth) this.synth.set(m.ctl);
    };
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    if (this.synth) this.synth.render(out); else out.fill(0);
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}
registerProcessor("${WORKLET_NAME}", EngineProcessor);
`;
}

interface TrafficVoice {
  osc: OscillatorNode;
  osc2: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  pan: StereoPannerNode;
  id: number;
}

export interface TrafficSound {
  id: number;
  /** Position relative to the listener: right (m), forward (m). */
  right: number;
  fwd: number;
  /** Closing speed towards the listener, m/s (positive = approaching). */
  closing: number;
  speed: number;
}

export class GameAudio {
  ctx: AudioContext | null = null;
  ready = false;
  muted = false;
  volume = 0.7;
  /** Which engine model is loaded (car id) - read by the tests. */
  engineId = "";
  engineMode: "worklet" | "script" | "none" = "none";
  workletError = "";
  private node: AudioWorkletNode | null = null;
  private fallback: { synth: EngineSynth; proc: ScriptProcessorNode } | null = null;
  private master!: GainNode;
  private engineGain!: GainNode;
  private reverbSend!: GainNode;
  private squealGain!: GainNode;
  private squealFilter!: BiquadFilterNode;
  private squealFilter2!: BiquadFilterNode;
  private roadGain!: GainNode;
  private roadFilter!: BiquadFilterNode;
  private gravelGain!: GainNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private noiseBuf!: AudioBuffer;
  private voices: TrafficVoice[] = [];
  private meter: AnalyserNode | null = null;
  private meterBuf = new Float32Array(2048);
  private pendingSpec: { id: string; spec: EngineSynthSpec } | null = null;

  /** Safe to call repeatedly; only the first call (inside a key handler) does work. */
  start(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor({ latencyHint: "interactive" });
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 8;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    this.master.connect(comp).connect(ctx.destination);
    // Level meter on the output (used by the HUD-less automated tests).
    this.meter = ctx.createAnalyser();
    this.meter.fftSize = 2048;
    comp.connect(this.meter);

    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // Engine bus: dry + building slap-back.
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineGain.connect(this.master);
    const conv = ctx.createConvolver();
    conv.buffer = this.makeImpulse(ctx, 0.9);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.15;
    this.engineGain.connect(this.reverbSend).connect(conv).connect(this.master);

    // Tyre squeal: noise through two resonant band-passes.
    this.squealFilter = ctx.createBiquadFilter();
    this.squealFilter.type = "bandpass";
    this.squealFilter.frequency.value = 900;
    this.squealFilter.Q.value = 14;
    this.squealFilter2 = ctx.createBiquadFilter();
    this.squealFilter2.type = "bandpass";
    this.squealFilter2.frequency.value = 1900;
    this.squealFilter2.Q.value = 10;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    const sq = this.loopNoise();
    sq.connect(this.squealFilter).connect(this.squealGain);
    sq.connect(this.squealFilter2).connect(this.squealGain);
    this.squealGain.connect(this.master);
    this.squealGain.connect(this.reverbSend);

    // Rolling road noise (asphalt) and gravel crunch (off-road).
    this.roadFilter = ctx.createBiquadFilter();
    this.roadFilter.type = "lowpass";
    this.roadFilter.frequency.value = 300;
    this.roadGain = ctx.createGain();
    this.roadGain.gain.value = 0;
    this.loopNoise().connect(this.roadFilter).connect(this.roadGain).connect(this.master);
    const gf = ctx.createBiquadFilter();
    gf.type = "bandpass";
    gf.frequency.value = 2200;
    gf.Q.value = 0.7;
    this.gravelGain = ctx.createGain();
    this.gravelGain.gain.value = 0;
    this.loopNoise().connect(gf).connect(this.gravelGain).connect(this.master);

    // Wind.
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = "bandpass";
    this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.loopNoise().connect(this.windFilter).connect(this.windGain).connect(this.master);

    void this.initEngine(ctx);
  }

  private async initEngine(ctx: AudioContext): Promise<void> {
    try {
      if (!ctx.audioWorklet) throw new Error("no AudioWorklet");
      const url = URL.createObjectURL(new Blob([workletSource()], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.node = new AudioWorkletNode(ctx, WORKLET_NAME, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      this.node.connect(this.engineGain);
      this.engineMode = "worklet";
    } catch (e) {
      this.workletError = String(e);
      // Older browsers: run the same synth on the main thread.
      const proc = ctx.createScriptProcessor(1024, 0, 1);
      const synth = new EngineSynth(ctx.sampleRate, { cylinders: 4, idle: 800, redline: 7000, banks: [[0, 1, 2, 3]], pipes: [1, 2], muffler: 2000, turbos: 0, crackle: 0, intake: 0.3, rough: 0.1 });
      this.fallback = { synth, proc };
      proc.onaudioprocess = (e) => this.fallback!.synth.render(e.outputBuffer.getChannelData(0));
      proc.connect(this.engineGain);
      this.engineMode = "script";
    }
    this.ready = true;
    if (this.pendingSpec) {
      const p = this.pendingSpec;
      this.pendingSpec = null;
      this.setEngine(p.id, p.spec);
    }
  }

  /** Loads the engine model for a car (called whenever the player changes car). */
  setEngine(id: string, spec: EngineSynthSpec): void {
    if (!this.ctx || !this.ready) {
      this.pendingSpec = { id, spec };
      return;
    }
    if (id === this.engineId) return;
    this.engineId = id;
    const plain: EngineSynthSpec = JSON.parse(JSON.stringify(spec));
    if (this.node) this.node.port.postMessage({ type: "spec", spec: plain, seed: id.length * 977 + 13 });
    else if (this.fallback) this.fallback.synth = new EngineSynth(this.ctx.sampleRate, plain, 13);
  }

  /** A short decaying impulse with early facade reflections. */
  private makeImpulse(ctx: AudioContext, seconds: number): AudioBuffer {
    const n = Math.round(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let k = 0; k < 7; k++) {
        const t = Math.round(ctx.sampleRate * (0.018 + 0.009 * k + Math.random() * 0.012));
        if (t < n) d[t] += (Math.random() < 0.5 ? -1 : 1) * (0.55 - k * 0.06);
      }
      for (let i = 0; i < n; i++) d[i] += (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3.2) * 0.25;
    }
    return buf;
  }

  private loopNoise(): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.start(0, Math.random() * 1.5);
    return src;
  }

  /** RMS of the current audio output (0 when not started). */
  level(): number {
    if (!this.meter) return 0;
    this.meter.getFloatTimeDomainData(this.meterBuf);
    let s = 0;
    for (const v of this.meterBuf) s += v * v;
    return Math.sqrt(s / this.meterBuf.length);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  private sendEngine(ctl: { rpm: number; load: number; limiter: boolean; gain: number }): void {
    this.node?.port.postMessage({ type: "ctl", ctl });
    this.fallback?.synth.set(ctl);
  }

  /** Called every frame with the player's car state. */
  update(s: {
    rpm: number;
    load: number;
    limiter: boolean;
    speed: number;
    slip: number;
    grounded: boolean;
    offroad: boolean;
    braking: boolean;
    /** 0 = open country, 1 = city canyon. */
    enclosure: number;
    paused: boolean;
    camera: number;
  }): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    if (s.paused) {
      for (const g of [this.engineGain, this.squealGain, this.windGain, this.roadGain, this.gravelGain]) g.gain.setTargetAtTime(0, t, 0.08);
      this.sendEngine({ rpm: s.rpm, load: 0, limiter: false, gain: 0 });
      for (const v of this.voices) v.gain.gain.setTargetAtTime(0, t, 0.08);
      return;
    }
    this.sendEngine({ rpm: s.rpm, load: s.load, limiter: s.limiter, gain: 1 });
    const camK = s.camera === 2 ? 0.75 : 1;
    this.engineGain.gain.setTargetAtTime(0.85 * camK, t, 0.05);
    this.reverbSend.gain.setTargetAtTime(0.06 + 0.32 * s.enclosure, t, 0.3);

    const v = s.speed;
    const slipAmt = s.grounded && !s.offroad ? clamp((Math.abs(s.slip) - 0.14) * 2.2, 0, 1) * clamp(v / 10, 0, 1) : 0;
    const brakeSq = s.braking && s.grounded && !s.offroad && v > 18 ? 0.25 : 0;
    const sq = Math.max(slipAmt, brakeSq);
    this.squealGain.gain.setTargetAtTime(sq * 0.22, t, 0.04);
    this.squealFilter.frequency.setTargetAtTime(760 + sq * 420 + Math.sin(t * 9) * 25, t, 0.05);
    this.squealFilter2.frequency.setTargetAtTime(1650 + sq * 700, t, 0.05);
    const roll = clamp(v / 40, 0, 1);
    this.roadGain.gain.setTargetAtTime(s.grounded ? roll * (s.offroad ? 0.5 : 0.28) : 0, t, 0.1);
    this.roadFilter.frequency.setTargetAtTime(120 + roll * 380, t, 0.2);
    this.gravelGain.gain.setTargetAtTime(s.grounded && s.offroad ? clamp(v / 25, 0, 1) * 0.12 : 0, t, 0.08);
    const wind = clamp(v / 85, 0, 1);
    this.windGain.gain.setTargetAtTime(wind * wind * (s.camera === 2 ? 0.5 : 0.32), t, 0.15);
    this.windFilter.frequency.setTargetAtTime(350 + wind * 1400, t, 0.2);
  }

  /** Updates the nearest traffic engines (call each frame). */
  updateTraffic(cars: TrafficSound[]): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const keep = new Set(cars.map((c) => c.id));
    for (const v of this.voices) if (!keep.has(v.id)) v.gain.gain.setTargetAtTime(0, t, 0.15);
    for (const c of cars) {
      let v = this.voices.find((x) => x.id === c.id);
      if (!v) {
        v = this.voices.find((x) => !keep.has(x.id));
        if (!v && this.voices.length < 6) v = this.makeVoice();
        if (!v) continue;
        v.id = c.id;
      }
      const d = Math.hypot(c.right, c.fwd);
      const att = clamp(1 / (1 + (d / 9) ** 1.6), 0, 1);
      // Doppler: f' = f * c / (c - v_closing).
      const doppler = 343 / (343 - clamp(c.closing, -60, 60));
      const rpm = 900 + c.speed * 95;
      const f = (rpm / 60) * 2 * doppler;
      v.osc.frequency.setTargetAtTime(f, t, 0.06);
      v.osc2.frequency.setTargetAtTime(f * 0.5, t, 0.06);
      v.filter.frequency.setTargetAtTime(380 + c.speed * 22, t, 0.1);
      v.gain.gain.setTargetAtTime(att * 0.16, t, 0.1);
      v.pan.pan.setTargetAtTime(clamp(c.right / Math.max(4, d), -0.9, 0.9), t, 0.1);
    }
  }

  private makeVoice(): TrafficVoice {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    const osc2 = ctx.createOscillator();
    osc2.type = "triangle";
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 2;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const pan = ctx.createStereoPanner();
    const g2 = ctx.createGain();
    g2.gain.value = 0.6;
    osc.connect(filter);
    osc2.connect(g2).connect(filter);
    filter.connect(gain).connect(pan).connect(this.master);
    osc.start();
    osc2.start();
    const v: TrafficVoice = { osc, osc2, filter, gain, pan, id: -1 };
    this.voices.push(v);
    return v;
  }

  /** Two-tone car horn from a position relative to the listener. */
  horn(right: number, fwd: number, long = false): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const d = Math.hypot(right, fwd);
    const att = clamp(1 / (1 + (d / 12) ** 1.5), 0.05, 1);
    const pan = ctx.createStereoPanner();
    pan.pan.value = clamp(right / Math.max(4, d), -0.9, 0.9);
    const g = ctx.createGain();
    const dur = long ? 0.9 : 0.35;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12 * att, t + 0.02);
    g.gain.setValueAtTime(0.12 * att, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.05);
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 900;
    f.Q.value = 1.2;
    for (const hz of [405, 510]) {
      const o = ctx.createOscillator();
      o.type = "square";
      o.frequency.value = hz * (0.97 + Math.random() * 0.06);
      o.connect(f);
      o.start(t);
      o.stop(t + dur + 0.1);
    }
    f.connect(g).connect(pan).connect(this.master);
  }

  /** Crash: noise burst + panel resonances; `strength` 0..1. */
  impact(strength: number, metal = true): void {
    const ctx = this.ctx;
    if (!ctx || strength <= 0.02) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 500 + strength * 2500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(clamp(strength, 0, 1) * 0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18 + strength * 0.35);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.7);
    if (!metal) return;
    for (const hz of [180, 413, 697]) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(hz * (0.9 + Math.random() * 0.2), t);
      o.frequency.exponentialRampToValueAtTime(hz * 0.8, t + 0.3);
      const og = ctx.createGain();
      og.gain.setValueAtTime(strength * 0.12, t);
      og.gain.exponentialRampToValueAtTime(0.0005, t + 0.25 + Math.random() * 0.2);
      o.connect(og).connect(this.master);
      o.start(t);
      o.stop(t + 0.5);
    }
  }

  /** Thud of a hard landing. */
  land(strength: number): void {
    const ctx = this.ctx;
    if (!ctx || strength <= 0.02) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(clamp(strength, 0, 1) * 0.6, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.35);
    this.impact(strength * 0.4, false);
  }

  /** UI blip for menus. */
  blip(freq = 880, dur = 0.06): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.07, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** Door slam + starter motor when jacking a car. */
  whoosh(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 380;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.7, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 0.2);
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(28, t + 0.25);
    o.frequency.linearRampToValueAtTime(42, t + 0.7);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0, t + 0.25);
    sg.gain.linearRampToValueAtTime(0.12, t + 0.3);
    sg.gain.linearRampToValueAtTime(0, t + 0.72);
    const sf = ctx.createBiquadFilter();
    sf.type = "lowpass";
    sf.frequency.value = 600;
    o.connect(sf).connect(sg).connect(this.master);
    o.start(t + 0.25);
    o.stop(t + 0.75);
  }
}
