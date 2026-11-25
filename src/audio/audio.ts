/**
 * All sound is synthesised live with the Web Audio API - there are no audio
 * files. The engine is a pair of detuned oscillators at the cylinder firing
 * frequency (rpm / 60 x cylinders / 2) through a resonant low-pass whose
 * cutoff opens with throttle, plus a sub-harmonic "rumble". Tyre squeal is
 * band-passed noise, wind is low-passed noise, impacts are short noise bursts.
 *
 * The AudioContext is only created after a key press (browser autoplay rules).
 */

import { clamp } from "../core/math";

export class GameAudio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private engA!: OscillatorNode;
  private engB!: OscillatorNode;
  private engSub!: OscillatorNode;
  private engFilter!: BiquadFilterNode;
  private engGain!: GainNode;
  private squealGain!: GainNode;
  private squealFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private nitroGain!: GainNode;
  private noiseBuf!: AudioBuffer;
  muted = false;
  volume = 0.7;

  /** Safe to call repeatedly; only the first call (inside a key handler) does work. */
  start(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);

    // White-noise buffer shared by every noise source.
    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // Engine.
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = "lowpass";
    this.engFilter.Q.value = 6;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engA = ctx.createOscillator();
    this.engA.type = "sawtooth";
    this.engB = ctx.createOscillator();
    this.engB.type = "square";
    this.engSub = ctx.createOscillator();
    this.engSub.type = "triangle";
    const gA = ctx.createGain();
    gA.gain.value = 0.5;
    const gB = ctx.createGain();
    gB.gain.value = 0.18;
    const gS = ctx.createGain();
    gS.gain.value = 0.7;
    this.engA.connect(gA).connect(this.engFilter);
    this.engB.connect(gB).connect(this.engFilter);
    this.engSub.connect(gS).connect(this.engFilter);
    // Gentle saturation for grit.
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2);
    }
    shaper.curve = curve;
    this.engFilter.connect(shaper).connect(this.engGain).connect(this.master);
    for (const o of [this.engA, this.engB, this.engSub]) o.start();

    // Tyre squeal.
    this.squealFilter = ctx.createBiquadFilter();
    this.squealFilter.type = "bandpass";
    this.squealFilter.frequency.value = 1300;
    this.squealFilter.Q.value = 9;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.loopNoise().connect(this.squealFilter).connect(this.squealGain).connect(this.master);

    // Wind.
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = "lowpass";
    this.windFilter.frequency.value = 500;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.loopNoise().connect(this.windFilter).connect(this.windGain).connect(this.master);

    // Nitro hiss.
    const nf = ctx.createBiquadFilter();
    nf.type = "highpass";
    nf.frequency.value = 2500;
    this.nitroGain = ctx.createGain();
    this.nitroGain.gain.value = 0;
    this.loopNoise().connect(nf).connect(this.nitroGain).connect(this.master);
  }

  private loopNoise(): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.start(0, Math.random() * 1.5);
    return src;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  /** Called every frame with the player's car state. */
  update(s: {
    rpm: number;
    cylinders: number;
    tone: number;
    throttle: number;
    speed: number;
    slip: number;
    grounded: boolean;
    nitro: boolean;
    paused: boolean;
  }): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const k = 0.04;
    if (s.paused) {
      for (const g of [this.engGain, this.squealGain, this.windGain, this.nitroGain]) g.gain.setTargetAtTime(0, t, 0.08);
      return;
    }
    const fire = (s.rpm / 60) * (s.cylinders / 2);
    // Many-cylinder engines sound smoother: fold the fundamental down.
    const base = s.cylinders >= 10 ? fire / 2 : fire;
    this.engA.frequency.setTargetAtTime(base, t, k);
    this.engB.frequency.setTargetAtTime(base * 1.005 * 2, t, k);
    this.engSub.frequency.setTargetAtTime(base / 2, t, k);
    const open = 300 + s.throttle * 1800 * (0.6 + s.tone) + s.rpm * 0.12;
    this.engFilter.frequency.setTargetAtTime(open, t, k);
    this.engGain.gain.setTargetAtTime(0.22 + s.throttle * 0.28, t, k);
    const squeal = s.grounded ? clamp((Math.abs(s.slip) - 0.18) * 1.6, 0, 0.5) * clamp(s.speed / 12, 0, 1) : 0;
    this.squealGain.gain.setTargetAtTime(squeal * 0.35, t, 0.05);
    this.squealFilter.frequency.setTargetAtTime(1100 + squeal * 700, t, 0.1);
    const wind = clamp(s.speed / 90, 0, 1);
    this.windGain.gain.setTargetAtTime(wind * wind * 0.5, t, 0.1);
    this.windFilter.frequency.setTargetAtTime(300 + wind * 1500, t, 0.1);
    this.nitroGain.gain.setTargetAtTime(s.nitro ? 0.12 : 0, t, 0.05);
  }

  /** Short noise burst; `strength` 0..1. */
  impact(strength: number): void {
    const ctx = this.ctx;
    if (!ctx || strength <= 0.02) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 400 + strength * 1600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(clamp(strength, 0, 1) * 0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25 + strength * 0.3);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.7);
    // Metallic clank.
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(180 + Math.random() * 120, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.2);
    const og = ctx.createGain();
    og.gain.setValueAtTime(strength * 0.35, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 0.3);
  }

  /** UI blip for menus. */
  blip(freq = 880, dur = 0.06): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "square";
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.08, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** Rising whoosh when jacking a new car. */
  whoosh(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.Q.value = 3;
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(3000, t + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4, t + 0.3);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 0.8);
  }
}
