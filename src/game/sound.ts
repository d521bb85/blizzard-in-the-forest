import { mulberry32 } from "./lib/noise";

/*
 * Sound: a generative ambient score, the blizzard, and footsteps crunching in the snow,
 * all made in the browser. Nothing plays until it is switched on.
 *
 * It is rendered like a PlayStation 1 game's audio: every instrument is a short sample
 * built once at 22 kHz with a little bit reduction, then played back at other pitches the
 * way the console's sound chip did, through a long dark reverb and an echo, and the whole
 * mix is rolled off above 9 kHz.
 */

/** Sample rate of every instrument, as the console's samples often were. */
const SR = 22050;
/** Pitch each looped or one-shot sample is built at, in Hz. */
const PAD_BASE = 220;
const DRONE_BASE = 55;
const BELL_BASE = 880;
/** D: the score's home pitch class. */
const HOME = 2;

type Rand = () => number;

const mtof = (m: number) => 440 * 2 ** ((m - 69) / 12);
const mod = (a: number, n: number) => ((a % n) + n) % n;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

function finish(d: Float32Array, peak: number, bits: number): void {
  let max = 0;
  for (let i = 0; i < d.length; i++) max = Math.max(max, Math.abs(d[i]));
  const k = max > 0 ? peak / max : 0;
  const q = 2 ** (bits - 1);
  for (let i = 0; i < d.length; i++) d[i] = Math.round(d[i] * k * q) / q;
}

/** Adds a sine of a whole number of cycles over the buffer, so the buffer loops without a click. */
function addCycles(d: Float32Array, cycles: number, amp: number, phase: number): void {
  const w = (2 * Math.PI * cycles) / d.length;
  for (let i = 0; i < d.length; i++) d[i] += amp * Math.sin(w * i + phase);
}

/** A warm, slowly beating string pad, two seconds long and loopable. */
function padSample(ctx: BaseAudioContext, rand: Rand): AudioBuffer {
  const seconds = 2;
  const buf = ctx.createBuffer(1, SR * seconds, SR);
  const d = buf.getChannelData(0);
  const cycles = PAD_BASE * seconds;
  for (let k = 1; PAD_BASE * k < 6500; k++) {
    // A saw with its top rolled off, three copies drifting apart in pitch the higher they go.
    const amp = Math.exp(-k / 8) / k;
    const spread = Math.max(1, Math.round(k * 0.6));
    addCycles(d, cycles * k, amp, rand() * Math.PI * 2);
    addCycles(d, cycles * k - spread, amp * 0.7, rand() * Math.PI * 2);
    addCycles(d, cycles * k + spread, amp * 0.7, rand() * Math.PI * 2);
  }
  finish(d, 0.8, 12);
  return buf;
}

/** A low organ-like drone with a slow beat in its fundamental, loopable. */
function droneSample(ctx: BaseAudioContext, rand: Rand): AudioBuffer {
  const seconds = 2;
  const buf = ctx.createBuffer(1, SR * seconds, SR);
  const d = buf.getChannelData(0);
  const cycles = DRONE_BASE * seconds;
  const amps = [1, 0.45, 0.3, 0.18, 0.08, 0.1, 0.04, 0.05];
  amps.forEach((a, i) => addCycles(d, cycles * (i + 1), a, rand() * Math.PI * 2));
  addCycles(d, cycles + 1, 0.6, rand() * Math.PI * 2);
  addCycles(d, cycles * 2 + 1, 0.2, rand() * Math.PI * 2);
  finish(d, 0.8, 12);
  return buf;
}

/** A celesta-like bell: a few inharmonic partials, each dying away at its own rate. */
function bellSample(ctx: BaseAudioContext): AudioBuffer {
  const seconds = 3.2;
  const buf = ctx.createBuffer(1, Math.round(SR * seconds), SR);
  const d = buf.getChannelData(0);
  const partials: [number, number, number][] = [
    // ratio, amplitude, decay (s)
    [1, 1, 1.6],
    [2, 0.18, 0.9],
    [2.76, 0.34, 0.6],
    [5.4, 0.14, 0.3],
    [8.93, 0.07, 0.15]
  ];
  for (let i = 0; i < d.length; i++) {
    const t = i / SR;
    let s = 0;
    for (const [ratio, amp, decay] of partials) s += amp * Math.exp(-t / decay) * Math.sin(2 * Math.PI * BELL_BASE * ratio * t);
    d[i] = s * Math.min(1, t / 0.004);
  }
  finish(d, 0.9, 10);
  return buf;
}

function reversed(ctx: BaseAudioContext, src: AudioBuffer): AudioBuffer {
  const buf = ctx.createBuffer(1, src.length, src.sampleRate);
  const from = src.getChannelData(0);
  const to = buf.getChannelData(0);
  for (let i = 0; i < from.length; i++) to[i] = from[from.length - 1 - i];
  return buf;
}

/** One step into deep snow: a soft thump, then the crackle of crystals packing down. */
function crunchSample(ctx: BaseAudioContext, rand: Rand): AudioBuffer {
  const seconds = 0.34;
  const buf = ctx.createBuffer(1, Math.round(SR * seconds), SR);
  const d = buf.getChannelData(0);
  let lp = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / SR;
    lp += (rand() * 2 - 1 - lp) * 0.06;
    d[i] = lp * 2.6 * Math.exp(-t / 0.05) * Math.min(1, t / 0.006);
  }
  // Grains: dense as the foot lands, thinning as the snow settles.
  const grains = 90 + Math.floor(rand() * 70);
  for (let g = 0; g < grains; g++) {
    const t0 = 0.004 + rand() ** 1.7 * 0.24;
    const amp = (0.25 + 0.75 * rand()) * Math.exp(-t0 / 0.11);
    const len = Math.round((0.0006 + rand() * 0.0035) * SR);
    const start = Math.round(t0 * SR);
    let prev = 0;
    for (let j = 0; j < len && start + j < d.length; j++) {
      const n = rand() * 2 - 1;
      // Differenced noise: brighter, like ice crystals breaking.
      d[start + j] += (n - prev) * amp * 0.5 * Math.exp(-j / (len * 0.35));
      prev = n;
    }
  }
  // Fade out the last few milliseconds.
  const tail = Math.round(0.03 * SR);
  for (let i = 0; i < tail; i++) d[d.length - 1 - i] *= i / tail;
  finish(d, 0.9, 10);
  return buf;
}

/**
 * A roar from a big chest: a low, rough voice that rises and falls, its pitch
 * wavering and its edge torn by noise, through a mouth that opens and closes.
 */
function growlSample(ctx: BaseAudioContext, rand: Rand): AudioBuffer {
  const seconds = 2.2;
  const buf = ctx.createBuffer(1, Math.round(SR * seconds), SR);
  const d = buf.getChannelData(0);
  let phase = 0;
  let rough = 0;
  let lp = 0;
  let lp2 = 0;
  let breath = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.18) * Math.exp(-Math.max(0, t - 1.1) / 0.35) * (0.8 + 0.2 * Math.sin(t * 7.3));
    // About 70-95 Hz, sliding up into the roar and sagging at its end, shaking all the while.
    const f0 = 72 + 22 * Math.sin(Math.min(1, t / 1.3) * Math.PI) + Math.sin(t * 41) * 5 + (rand() - 0.5) * 9;
    phase += f0 / SR;
    rough += (rand() * 2 - 1 - rough) * 0.25;
    // A buzzing pulse wave, each cycle a little different: a voice with gravel in it.
    const frac = phase % 1;
    const pulse = (frac < 0.18 ? 1 : -0.22) * (1 + rough * 0.8);
    // The mouth: a lowpass that opens to the middle of the roar.
    const open = 0.05 + 0.18 * Math.sin(Math.min(1, t / 1.5) * Math.PI);
    lp += (pulse - lp) * open;
    lp2 += (lp - lp2) * open * 1.3;
    breath += (rand() * 2 - 1 - breath) * 0.5;
    d[i] = (lp2 * 1.4 + breath * 0.18 * open * 3) * env;
  }
  finish(d, 0.9, 9);
  return buf;
}

/** A heavy foot coming down in deep snow: a thud you feel more than hear. */
function stompSample(ctx: BaseAudioContext, rand: Rand): AudioBuffer {
  const seconds = 0.45;
  const buf = ctx.createBuffer(1, Math.round(SR * seconds), SR);
  const d = buf.getChannelData(0);
  let lp = 0;
  let ph = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / SR;
    lp += (rand() * 2 - 1 - lp) * 0.035;
    ph += (48 * Math.exp(-t / 0.2) + 28) / SR;
    const thud = Math.sin(ph * Math.PI * 2) * Math.exp(-t / 0.09);
    d[i] = (thud * 0.9 + lp * 3.2 * Math.exp(-t / 0.07)) * Math.min(1, t / 0.004);
  }
  finish(d, 0.9, 10);
  return buf;
}

/** Old hinges: the stick and slip of dry iron, slow then quick, a groan sliding up in pitch. */
function creakSample(ctx: BaseAudioContext, rand: Rand): AudioBuffer {
  const seconds = 1.3;
  const buf = ctx.createBuffer(1, Math.round(SR * seconds), SR);
  const d = buf.getChannelData(0);
  let t = 0.02;
  while (t < seconds - 0.1) {
    const u = t / seconds;
    const rate = 22 + 70 * u * u + Math.sin(u * 19) * 8;
    const start = Math.round(t * SR);
    const amp = Math.sin(Math.min(1, u * 1.4) * Math.PI) * (0.6 + rand() * 0.4);
    const ring = 700 + 500 * u + rand() * 80;
    for (let j = 0; j < 0.012 * SR && start + j < d.length; j++) {
      const tt = j / SR;
      d[start + j] += Math.sin(tt * ring * Math.PI * 2) * Math.exp(-tt / 0.0035) * amp + Math.sin(tt * ring * 2.7 * Math.PI * 2) * Math.exp(-tt / 0.0015) * amp * 0.3;
    }
    t += 1 / rate;
  }
  finish(d, 0.85, 9);
  return buf;
}

function noiseSample(ctx: BaseAudioContext, rand: Rand): AudioBuffer {
  const buf = ctx.createBuffer(1, SR * 4, SR);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = rand() * 2 - 1;
  return buf;
}

/** A long, dark hall: decaying noise that grows duller as it fades, after a few early echoes. */
function reverbImpulse(ctx: BaseAudioContext, rand: Rand, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const n = Math.round(rate * seconds);
  const buf = ctx.createBuffer(2, n, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const k = 0.5 * Math.exp(-t * 1.4) + 0.03;
      lp += (rand() * 2 - 1 - lp) * k;
      d[i] = (lp / Math.sqrt(k)) * Math.exp((-6.9 * t) / seconds) * Math.min(1, t / 0.03);
    }
    for (const ms of [11, 19, 29, 41, 53, 67]) {
      const i = Math.round(((ms + (ch ? 3 : 0)) / 1000) * rate);
      d[i] += (rand() < 0.5 ? -1 : 1) * 0.5;
    }
  }
  return buf;
}

interface Chords {
  /** Pitch classes relative to the key, root first. */
  chords: number[][];
}

const PROGRESSIONS: Chords[] = [
  // Calm: i9, VImaj7, III, VIIsus2.
  { chords: [[0, 3, 7, 2], [8, 0, 3, 7], [3, 7, 10, 5], [10, 0, 5, 2]] },
  // Uneasy: iv9 and a Phrygian II leaning back onto the tonic.
  { chords: [[0, 3, 7, 2], [5, 8, 0, 7], [0, 3, 7, 10], [1, 5, 8, 0]] },
  // Sad: i, VI, iv9, v.
  { chords: [[0, 3, 7, 2], [8, 0, 3], [5, 8, 0, 7], [7, 10, 2]] },
  // Ominous: a minor-major chord and a diminished one a tritone away.
  { chords: [[0, 3, 7, 11], [8, 0, 3, 7], [6, 9, 0, 3], [7, 0, 2]] },
  // Open: no thirds at all, just fourths and fifths.
  { chords: [[0, 7, 2, 5], [10, 2, 5, 0], [8, 0, 3, 10], [5, 0, 7, 10]] }
];

/** Keys the score moves to, relative to D. */
const KEYS = [0, 0, -2, 3, 5, -4];
const BARS = [8, 9.5, 11, 12.5];
const STEPS = 8;

interface Section {
  prog: Chords;
  key: number;
  /** Seconds per chord. */
  bar: number;
  cycles: number;
  /** Bell steps: an index into the chord's tones, or null for a rest. */
  motif: (number | null)[];
  bells: number;
  drone: boolean;
  /** The drone holds the key's root under every chord instead of following the chords. */
  pedal: boolean;
}

/**
 * The score: a repeating figure of four chords with a sparse bell motif over it, a drone
 * under it. Every couple of minutes the figure changes a lot: a new progression, a new key,
 * a different pace, other instruments in and out, sometimes after a pause.
 */
export class Score {
  private section!: Section;
  private next = 0;
  private step = 0;
  private chord = 0;
  private cycle = 0;
  private sections = 0;
  private droneVoice: ((at: number) => void) | null = null;

  constructor(private engine: Engine, private rand: Rand) {}

  start(t: number): void {
    this.next = t;
    this.section = this.newSection(true);
  }

  /** Schedules every step that starts before `until`. */
  scheduleUntil(until: number): void {
    while (this.next < until) this.play(this.next);
  }

  private pick<T>(list: T[]): T {
    return list[Math.floor(this.rand() * list.length)];
  }

  private newSection(first = false): Section {
    const r = this.rand;
    const prev = this.section;
    let prog = first ? PROGRESSIONS[0] : this.pick(PROGRESSIONS);
    while (prev && prog === prev.prog) prog = this.pick(PROGRESSIONS);
    const key = first ? 0 : this.pick(KEYS.filter((k) => k !== prev?.key));
    const motif: (number | null)[] = [];
    const density = 0.22 + r() * 0.25;
    let idx = Math.floor(r() * 3);
    for (let s = 0; s < STEPS; s++) {
      if (r() < density || (s === 0 && r() < 0.5)) {
        idx = clamp(idx + this.pick([-2, -1, 0, 1, 1, 2]), 0, 4);
        motif.push(idx);
      } else motif.push(null);
    }
    if (motif.filter((m) => m !== null).length < 2) motif[3] = 2;
    this.sections++;
    return {
      prog,
      key,
      bar: first ? 10 : this.pick(BARS),
      cycles: 2 + Math.floor(r() * 3),
      motif,
      bells: first ? 0.8 : r() < 0.8 ? 0.6 + r() * 0.4 : 0,
      drone: first || r() < 0.8,
      pedal: r() < 0.5
    };
  }

  /** Absolute pitch class of a chord tone in the section's key. */
  private pc(rel: number): number {
    return mod(HOME + this.section.key + rel, 12);
  }

  private play(t: number): void {
    const sec = this.section;
    const chord = sec.prog.chords[this.chord];
    const stepDur = sec.bar / STEPS;

    if (this.step === 0) {
      const first = this.chord === 0 && this.cycle === 0;
      // Pads: the root low, the rest above it.
      chord.forEach((rel, i) => {
        const pc = this.pc(rel);
        const note = i === 0 ? 45 + mod(pc - 45, 12) : 55 + mod(pc - 55, 12);
        this.engine.pad(note, t, sec.bar, i === 0 ? 0.06 : 0.045, (i % 2 ? 1 : -1) * (0.15 + 0.1 * i));
      });
      if (sec.drone) {
        if (first && sec.pedal) this.droneVoice = this.engine.drone(33 + mod(this.pc(0) - 33, 12), t);
        if (!sec.pedal) {
          this.droneVoice?.(t);
          this.droneVoice = this.engine.drone(33 + mod(this.pc(chord[0]) - 33, 12), t);
        }
      }
    }

    // The bells: the same figure every time round, its notes taken from whichever chord is playing.
    const m = sec.motif[this.step];
    if (m !== null && sec.bells > 0 && !(this.sections === 1 && this.cycle === 0)) {
      const tones = [...new Set(chord.map((rel) => 72 + mod(this.pc(rel) - 72, 12)))].sort((a, b) => a - b);
      tones.push(tones[0] + 12);
      // Later rounds drop a note here and there, or lift one an octave.
      const drop = this.cycle > 0 && this.rand() < 0.22;
      if (!drop) {
        const note = tones[m % tones.length] + (this.cycle > 0 && this.rand() < 0.08 ? 12 : 0);
        this.engine.bell(note, t + (this.rand() - 0.5) * 0.04, 0.05 * sec.bells, (this.rand() - 0.5) * 0.7);
      }
    }

    this.next = t + stepDur;
    if (++this.step < STEPS) return;
    this.step = 0;
    if (++this.chord < sec.prog.chords.length) return;
    this.chord = 0;
    if (++this.cycle < sec.cycles) return;

    // A big change.
    this.cycle = 0;
    this.droneVoice?.(this.next);
    this.droneVoice = null;
    // Sometimes a pause first, with only the wind.
    if (this.rand() < 0.4) this.next += sec.bar * (0.6 + this.rand() * 0.8);
    this.section = this.newSection();
    // A reversed bell swells into the new section.
    this.engine.swell(72 + mod(this.pc(0) - 72, 12), this.next, 0.035);
  }
}

/** All the nodes and samples; works on a live or an offline audio context. */
export class Engine {
  readonly master: GainNode;
  readonly music: GainNode;
  readonly wind: GainNode;
  readonly steps: GainNode;
  /** The yeti and the hut door. */
  readonly cues: GainNode;
  readonly score: Score;

  private rand: Rand;
  private padBuf: AudioBuffer;
  private droneBuf: AudioBuffer;
  private bellBuf: AudioBuffer;
  private swellBuf: AudioBuffer;
  private crunches: AudioBuffer[];
  private growlBuf: AudioBuffer;
  private stompBuf: AudioBuffer;
  private creakBuf: AudioBuffer;
  private padBus: BiquadFilterNode;
  private bellBus: GainNode;
  private droneBus: GainNode;
  private reverb: ConvolverNode;
  private windBody: BiquadFilterNode;
  private windHowl: BiquadFilterNode;
  private bodyGain: GainNode;
  private howlGain: GainNode;
  private hissGain: GainNode;
  private rumbleGain: GainNode;
  private bodyPan: StereoPannerNode;
  private howlPan: StereoPannerNode;
  private lastCrunch = -1;
  private foot = 1;

  constructor(readonly ctx: BaseAudioContext, seed: number) {
    this.rand = mulberry32(seed);
    const r = this.rand;
    this.padBuf = padSample(ctx, r);
    this.droneBuf = droneSample(ctx, r);
    this.bellBuf = bellSample(ctx);
    this.swellBuf = reversed(ctx, this.bellBuf);
    this.crunches = Array.from({ length: 6 }, () => crunchSample(ctx, r));
    this.growlBuf = growlSample(ctx, r);
    this.stompBuf = stompSample(ctx, r);
    this.creakBuf = creakSample(ctx, r);

    // Master: the console's muffled top end, and a gentle limiter.
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 9000;
    tone.Q.value = 0.5;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 8;
    limiter.ratio.value = 6;
    this.master.connect(tone).connect(limiter).connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = reverbImpulse(ctx, r, 5.5);
    const wet = ctx.createGain();
    wet.gain.value = 0.7;
    this.reverb.connect(wet).connect(this.master);
    const send = (from: AudioNode, amount: number) => {
      const g = ctx.createGain();
      g.gain.value = amount;
      from.connect(g).connect(this.reverb);
    };

    this.music = ctx.createGain();
    this.music.gain.value = 0.8;
    this.music.connect(this.master);
    send(this.music, 0.9);

    // Pads through a filter that slowly opens and closes.
    this.padBus = ctx.createBiquadFilter();
    this.padBus.type = "lowpass";
    this.padBus.frequency.value = 1300;
    this.padBus.Q.value = 0.7;
    this.padBus.connect(this.music);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.031;
    const depth = ctx.createGain();
    depth.gain.value = 550;
    lfo.connect(depth).connect(this.padBus.frequency);
    lfo.start();

    // Bells, with a dark echo.
    this.bellBus = ctx.createGain();
    this.bellBus.connect(this.music);
    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.62;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.42;
    const dull = ctx.createBiquadFilter();
    dull.type = "lowpass";
    dull.frequency.value = 2200;
    const echo = ctx.createGain();
    echo.gain.value = 0.55;
    this.bellBus.connect(delay);
    delay.connect(dull).connect(feedback).connect(delay);
    dull.connect(echo).connect(this.music);

    this.droneBus = ctx.createGain();
    this.droneBus.connect(this.music);

    // The blizzard: looping noise through filters that follow the gusts.
    this.wind = ctx.createGain();
    this.wind.connect(this.master);
    send(this.wind, 0.25);
    const noise = noiseSample(ctx, r);
    const source = (offset: number, rate: number) => {
      const s = ctx.createBufferSource();
      s.buffer = noise;
      s.loop = true;
      s.playbackRate.value = rate;
      s.start(0, offset);
      return s;
    };
    const filter = (type: BiquadFilterType, f: number, q: number) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    const gain = () => {
      const g = ctx.createGain();
      g.gain.value = 0;
      return g;
    };
    this.windBody = filter("bandpass", 450, 0.6);
    this.bodyGain = gain();
    this.bodyPan = ctx.createStereoPanner();
    const a = source(0, 1);
    a.connect(this.windBody).connect(this.bodyGain).connect(this.bodyPan).connect(this.wind);
    this.rumbleGain = gain();
    a.connect(filter("lowpass", 170, 0.7)).connect(this.rumbleGain).connect(this.wind);
    this.windHowl = filter("bandpass", 900, 7);
    this.howlGain = gain();
    this.howlPan = ctx.createStereoPanner();
    source(1.7, 0.93).connect(this.windHowl).connect(this.howlGain).connect(this.howlPan).connect(this.wind);
    this.hissGain = gain();
    source(3.1, 1.07).connect(filter("highpass", 3200, 0.7)).connect(this.hissGain).connect(this.wind);

    // Footsteps sit well under the wind: about 10 dB quieter than the crunch samples' full level.
    this.steps = ctx.createGain();
    this.steps.gain.value = 0.32;
    this.steps.connect(this.master);
    send(this.steps, 0.12);

    // The yeti is heard through the same dark reverb as everything else, a good deal wetter.
    this.cues = ctx.createGain();
    this.cues.gain.value = 0.9;
    this.cues.connect(this.master);
    send(this.cues, 0.45);

    this.score = new Score(this, r);
  }

  private voice(buf: AudioBuffer, rate: number, bus: AudioNode, pan: number, loop: boolean): [AudioBufferSourceNode, GainNode] {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = 0;
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    src.connect(g).connect(p).connect(bus);
    src.onended = () => {
      src.disconnect();
      g.disconnect();
      p.disconnect();
    };
    return [src, g];
  }

  pad(note: number, t: number, dur: number, level: number, pan: number): void {
    const [src, g] = this.voice(this.padBuf, mtof(note) / PAD_BASE, this.padBus, pan, true);
    src.detune.value = (this.rand() - 0.5) * 10;
    const attack = Math.min(3, dur * 0.4);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + attack);
    g.gain.setValueAtTime(level, t + dur);
    g.gain.setTargetAtTime(0, t + dur, 1.2);
    src.start(t, this.rand() * this.padBuf.duration);
    src.stop(t + dur + 6);
  }

  /** Starts a drone; the returned function fades it away from a given time. */
  drone(note: number, t: number): (at: number) => void {
    const [src, g] = this.voice(this.droneBuf, mtof(note) / DRONE_BASE, this.droneBus, 0, true);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.08, t + 5);
    src.start(t, this.rand() * this.droneBuf.duration);
    let stopped = false;
    return (end: number) => {
      if (stopped) return;
      stopped = true;
      const at = Math.max(end, t + 5);
      g.gain.setValueAtTime(0.08, at);
      g.gain.setTargetAtTime(0, at, 2);
      src.stop(at + 12);
    };
  }

  bell(note: number, t: number, level: number, pan: number): void {
    const [src, g] = this.voice(this.bellBuf, mtof(note) / BELL_BASE, this.bellBus, pan, false);
    g.gain.setValueAtTime(level, t);
    src.start(t);
  }

  swell(note: number, at: number, level: number): void {
    const rate = mtof(note) / BELL_BASE;
    const t = at - this.swellBuf.duration / rate + 0.05;
    if (t < this.ctx.currentTime) return;
    const [src, g] = this.voice(this.swellBuf, rate, this.bellBus, 0, false);
    g.gain.setValueAtTime(level, t);
    src.start(t);
  }

  /** Follows the weather: gust strength 0..1 and where the wind comes from relative to the view. */
  setWind(t: number, gust: number, pan: number, speed: number): void {
    const k = 0.35;
    const g = gust;
    const wander = Math.sin(t * 0.17) * 0.5 + Math.sin(t * 0.071 + 1.3) * 0.5;
    this.windBody.frequency.setTargetAtTime(320 + 520 * g + speed * 20, t, k);
    this.bodyGain.gain.setTargetAtTime(0.06 + 0.2 * g + Math.min(speed, 6) * 0.006, t, k);
    this.rumbleGain.gain.setTargetAtTime(0.1 + 0.18 * g, t, k);
    this.windHowl.frequency.setTargetAtTime(620 + 700 * g + wander * 160, t, k);
    this.howlGain.gain.setTargetAtTime(0.012 + 0.12 * g * g, t, k);
    this.hissGain.gain.setTargetAtTime(0.008 + 0.022 * g, t, k);
    this.bodyPan.pan.setTargetAtTime(pan * 0.35, t, 0.6);
    this.howlPan.pan.setTargetAtTime(pan * 0.65, t, 0.6);
  }

  /** The yeti's roar or snarl, from a direction (+ is right), at a level 0..1. */
  growl(t: number, pan: number, level: number): void {
    const [src, g] = this.voice(this.growlBuf, 0.92 + this.rand() * 0.16, this.cues, pan * 0.7, false);
    g.gain.setValueAtTime(level, t);
    src.start(t);
  }

  /** One of the yeti's footfalls, with the snow crunching under it. */
  stomp(t: number, pan: number, level: number): void {
    const [src, g] = this.voice(this.stompBuf, 0.9 + this.rand() * 0.2, this.cues, pan * 0.7, false);
    g.gain.setValueAtTime(level * 0.9, t);
    src.start(t);
    const i = Math.floor(this.rand() * this.crunches.length);
    const [c, cg] = this.voice(this.crunches[i], 0.55 + this.rand() * 0.1, this.cues, pan * 0.7, false);
    cg.gain.setValueAtTime(level * 0.5, t);
    c.start(t);
  }

  creak(t: number, pan: number, level: number): void {
    const [src, g] = this.voice(this.creakBuf, 0.95 + this.rand() * 0.1, this.cues, pan, false);
    g.gain.setValueAtTime(level, t);
    src.start(t);
  }

  /** One of the yeti's own footfalls, heard from inside it: a thud under the feet, the snow giving. */
  tread(t: number, speed: number): void {
    this.foot = -this.foot;
    const pace = clamp(speed / 7, 0, 1);
    const [src, g] = this.voice(this.stompBuf, 0.85 + this.rand() * 0.15, this.steps, this.foot * 0.15, false);
    g.gain.setValueAtTime(0.55 + 0.45 * pace, t);
    src.start(t);
    const i = Math.floor(this.rand() * this.crunches.length);
    const [c, cg] = this.voice(this.crunches[i], 0.6 + this.rand() * 0.1 + pace * 0.1, this.steps, this.foot * 0.15, false);
    cg.gain.setValueAtTime(0.4 + 0.4 * pace, t);
    c.start(t);
  }

  /** One footstep at walking speed `speed` (m/s). */
  step(t: number, speed: number): void {
    let i = Math.floor(this.rand() * this.crunches.length);
    if (i === this.lastCrunch) i = (i + 1) % this.crunches.length;
    this.lastCrunch = i;
    this.foot = -this.foot;
    const pace = clamp(speed / 4, 0, 1);
    const [src, g] = this.voice(this.crunches[i], 0.86 + this.rand() * 0.22 + pace * 0.08, this.steps, this.foot * 0.12, false);
    g.gain.setValueAtTime(0.28 + 0.5 * pace, t);
    src.start(t);
  }
}

/**
 * The page's sound: off until enable() is called from a click or key press (browsers
 * only start audio then). Pauses while the tab is hidden.
 */
export class Soundscape {
  private engine: Engine | null = null;
  private ctx: AudioContext | null = null;
  private on = false;
  private timer = 0;
  private suspendTimer = 0;
  private lastSteps = -1;
  private nextWind = 0;

  constructor() {
    document.addEventListener("visibilitychange", () => this.sync());
  }

  get enabled(): boolean {
    return this.on;
  }

  enable(): void {
    if (this.on) return;
    this.on = true;
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.engine = new Engine(this.ctx, (Math.random() * 2 ** 31) | 0);
      this.engine.score.start(this.ctx.currentTime + 0.3);
    }
    window.clearTimeout(this.suspendTimer);
    const g = this.engine!.master.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0.9, now + 2.5);
    this.sync();
  }

  disable(): void {
    if (!this.on) return;
    this.on = false;
    if (!this.ctx || !this.engine) return;
    const g = this.engine.master.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + 0.5);
    window.clearTimeout(this.suspendTimer);
    this.suspendTimer = window.setTimeout(() => this.sync(), 600);
  }

  /** Runs the context and the score only while switched on and the tab is visible. */
  private sync(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const run = this.on && document.visibilityState === "visible";
    if (run) {
      void ctx.resume();
      if (!this.timer) {
        const tick = () => this.engine!.score.scheduleUntil(ctx.currentTime + 2);
        tick();
        this.timer = window.setInterval(tick, 250);
      }
    } else {
      // Paused, the context's clock stops too, so the score carries on where it was.
      void ctx.suspend();
      window.clearInterval(this.timer);
      this.timer = 0;
    }
  }

  /** A sound the story asks for: from a direction (+ is right), at a level 0..1. */
  cue(name: "growl" | "stomp" | "creak", pan: number, level: number): void {
    const ctx = this.ctx;
    const engine = this.engine;
    if (!ctx || !engine || !this.on || ctx.state !== "running") return;
    engine[name](ctx.currentTime + 0.01, clamp(pan, -1, 1), clamp(level, 0, 1));
  }

  /** Called every frame with the weather and the walker (`heavy`: the walker is the yeti). */
  frame(gust: number, windX: number, windZ: number, yaw: number, speed: number, steps: number, heavy = false): void {
    const ctx = this.ctx;
    const engine = this.engine;
    const stepped = steps !== this.lastSteps;
    this.lastSteps = steps;
    if (!ctx || !engine || !this.on || ctx.state !== "running") return;
    const now = ctx.currentTime;
    if (stepped && speed > 0.15) {
      if (heavy) engine.tread(now + 0.01, speed);
      else engine.step(now + 0.01, speed);
    }
    if (now < this.nextWind) return;
    this.nextWind = now + 0.1;
    // The wind is heard from where it blows from: + is the right of the view.
    const len = Math.hypot(windX, windZ) || 1;
    const pan = (-windX * Math.cos(yaw) + windZ * Math.sin(yaw)) / len;
    engine.setWind(now, gust, pan, speed);
  }
}
