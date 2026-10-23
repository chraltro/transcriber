// What the clean-up can do, in the order it does it, and the machinery that runs it: every
// voice in the episode gets its own repair chain (a gated, band-limited guest needs different
// help from the host in a studio), crossfaded by who is talking, then one master stage evens
// out the levels for the whole episode. The page builds its controls from these lists.
import { HighPass, DeHum, DeClick, Dropouts, Spectral, Eq, Compressor, Leveler, RoomTone, Limiter } from './modules.js';
import { Delay, clamp } from './dsp.js';

export const RATE = 44100;

// kind: 'range' (default) | 'choice' | 'auto' (a range that can be left to the analysis)
export const VOICE_MODULES = [
  {
    id: 'highpass', name: 'Rumble filter', group: 'Repair',
    about: 'Cuts low thumps, desk knocks, wind and traffic rumble under the voice.',
    params: [{ id: 'freq', label: 'Cut below', min: 40, max: 200, step: 5, def: 80, unit: 'Hz' }],
  },
  {
    id: 'dehum', name: 'Hum removal', group: 'Repair',
    about: 'Notches out mains hum (50 or 60 Hz) and its overtones.',
    params: [
      { id: 'base', label: 'Mains', kind: 'choice', options: [['auto', 'Auto'], ['50', '50 Hz'], ['60', '60 Hz']], def: 'auto' },
      { id: 'depth', label: 'Depth', min: 6, max: 40, step: 1, def: 24, unit: 'dB' },
      { id: 'harmonics', label: 'Overtones', min: 1, max: 8, step: 1, def: 4 },
    ],
  },
  {
    id: 'declick', name: 'Mouth clicks', group: 'Repair',
    about: 'Finds very short spikes (lip smacks, crackle, digital ticks) and rebuilds the audio under them from both sides.',
    params: [{ id: 'sensitivity', label: 'Sensitivity', min: 0, max: 100, step: 1, def: 50, unit: '%' }],
  },
  {
    id: 'dropouts', name: 'Dropout repair', group: 'Repair',
    about: 'Fills the holes a bad connection punches into speech: the voice carried forward from before the hole and back from after it, crossfaded.',
    params: [
      { id: 'threshold', label: 'Counts as a hole below', min: -90, max: -45, step: 1, def: -65, unit: 'dB' },
      { id: 'maxGap', label: 'Longest hole', min: 20, max: 300, step: 10, def: 150, unit: 'ms' },
    ],
  },
  {
    id: 'denoise', name: 'Noise reduction', group: 'Repair',
    about: 'Learns the background (hiss, fans, air conditioning) from the quiet moments and turns it down.',
    params: [
      { id: 'amount', label: 'Reduction', min: 0, max: 30, step: 1, def: 12, unit: 'dB' },
      { id: 'sensitivity', label: 'Sensitivity', min: 0, max: 100, step: 1, def: 50, unit: '%' },
    ],
  },
  {
    id: 'dereverb', name: 'Room echo', group: 'Repair',
    about: 'Turns down the reflections of a bare room that trail after each word.',
    params: [
      { id: 'amount', label: 'Reduction', min: 0, max: 20, step: 1, def: 8, unit: 'dB' },
      { id: 'decay', label: 'Room size', min: 0.2, max: 1.5, step: 0.05, def: 0.5, unit: 's' },
    ],
  },
  {
    id: 'highs', name: 'Restore highs', group: 'Repair',
    about: "Rebuilds the treble a call or codec cut off from the octave just below the cut, the way streaming codecs do (SBR). Adds air and presence; it can't recover detail that was never sent.",
    params: [
      { id: 'amount', label: 'Level', min: -24, max: 0, step: 1, def: -9, unit: 'dB' },
      { id: 'cutoff', label: 'Cut-off', kind: 'auto', min: 3000, max: 16000, step: 100, def: 'auto', unit: 'Hz' },
    ],
  },
  {
    id: 'deess', name: 'De-esser', group: 'Tone',
    about: 'Tames sharp s, sh and t sounds.',
    params: [
      { id: 'amount', label: 'Up to', min: 1, max: 12, step: 1, def: 6, unit: 'dB' },
      { id: 'threshold', label: 'Sensitivity', min: 0, max: 100, step: 1, def: 50, unit: '%' },
    ],
  },
  {
    id: 'eq', name: 'Tone', group: 'Tone',
    about: 'Four broad tone controls for a voice.',
    params: [
      { id: 'warmth', label: 'Warmth', min: -6, max: 6, step: 0.5, def: 0, unit: 'dB', signed: true },
      { id: 'mud', label: 'Mud (350 Hz)', min: -9, max: 3, step: 0.5, def: 0, unit: 'dB', signed: true },
      { id: 'presence', label: 'Presence', min: -6, max: 9, step: 0.5, def: 0, unit: 'dB', signed: true },
      { id: 'air', label: 'Air', min: -6, max: 9, step: 0.5, def: 0, unit: 'dB', signed: true },
    ],
  },
  {
    id: 'compress', name: 'Compressor', group: 'Tone',
    about: 'Evens out the loud and soft syllables within a sentence.',
    params: [
      { id: 'amount', label: 'Amount', min: 0, max: 100, step: 1, def: 40, unit: '%' },
      { id: 'speed', label: 'Speed', kind: 'choice', options: [['fast', 'Fast'], ['medium', 'Medium'], ['slow', 'Slow']], def: 'medium' },
    ],
  },
];

export const MASTER_MODULES = [
  {
    id: 'leveler', name: 'Leveler', group: 'Master',
    about: 'Rides the volume over seconds so every voice sits at the same loudness, and sets the loudness of the whole episode.',
    params: [
      { id: 'target', label: 'Loudness', min: -24, max: -12, step: 0.5, def: -16, unit: 'LUFS' },
      { id: 'strength', label: 'Strength', min: 0, max: 100, step: 1, def: 70, unit: '%' },
      { id: 'speed', label: 'Speed', kind: 'choice', options: [['gentle', 'Gentle'], ['normal', 'Normal'], ['fast', 'Fast']], def: 'normal' },
    ],
  },
  {
    id: 'roomtone', name: 'Room tone', group: 'Master',
    about: "Lays a quiet, steady background under the dead silences a call's noise gate leaves, so a voice stops switching between room and vacuum.",
    params: [
      { id: 'level', label: 'Level', min: -80, max: -45, step: 1, def: -60, unit: 'dB' },
      { id: 'tone', label: 'Colour', kind: 'choice', options: [['dark', 'Dark'], ['neutral', 'Neutral'], ['bright', 'Bright']], def: 'neutral' },
    ],
  },
  {
    id: 'limiter', name: 'Limiter', group: 'Master',
    about: 'Catches peaks so nothing clips.',
    params: [{ id: 'ceiling', label: 'Ceiling', min: -6, max: -0.1, step: 0.1, def: -1, unit: 'dB' }],
  },
];

const BUILD = {
  highpass: HighPass, dehum: DeHum, declick: DeClick, dropouts: Dropouts, eq: Eq, compress: Compressor,
  leveler: Leveler, roomtone: RoomTone, limiter: Limiter,
};
const SPECTRAL = ['denoise', 'dereverb', 'highs', 'deess'];

const paramDefaults = (mod) => Object.fromEntries(mod.params.map((p) => [p.id, p.def]));

// A module's settings: { on, ...params }.
export function moduleDefaults(list, on = []) {
  return Object.fromEntries(list.map((m) => [m.id, { on: on.includes(m.id), ...paramDefaults(m) }]));
}

export const voiceDefaults = () => ({ bypass: false, regen: false, modules: moduleDefaults(VOICE_MODULES) });
export const masterDefaults = () => ({ modules: moduleDefaults(MASTER_MODULES, ['leveler', 'limiter']) });

/* ---------- presets ---------- */

// Each preset says which modules to turn on and what to change from the defaults.
export const VOICE_PRESETS = {
  off: { name: 'Off', on: {} },
  gentle: { name: 'Gentle', on: { highpass: { freq: 70 }, denoise: { amount: 8 }, eq: { presence: 1 } } },
  call: {
    name: 'Bad call',
    on: {
      highpass: { freq: 90 }, dropouts: {}, denoise: { amount: 10 }, highs: { amount: -9 },
      deess: { amount: 4 }, eq: { mud: -2, presence: 2 }, compress: { amount: 35 },
    },
  },
  noisy: { name: 'Noisy room', on: { highpass: { freq: 90 }, dehum: {}, denoise: { amount: 18, sensitivity: 60 }, eq: { presence: 1.5 } } },
  echo: { name: 'Echoey room', on: { highpass: { freq: 80 }, dereverb: { amount: 10, decay: 0.6 }, denoise: { amount: 8 }, eq: { mud: -2 } } },
  radio: {
    name: 'Radio voice',
    on: { highpass: { freq: 70 }, denoise: { amount: 8 }, deess: { amount: 5 }, eq: { warmth: 2, mud: -2, presence: 3, air: 2 }, compress: { amount: 60, speed: 'fast' } },
  },
};

export function applyPreset(name, base = voiceDefaults()) {
  const preset = VOICE_PRESETS[name];
  const out = voiceDefaults();
  out.bypass = false;
  out.regen = base.regen;
  if (!preset) return out;
  for (const [id, changes] of Object.entries(preset.on)) Object.assign(out.modules[id], { on: true }, changes);
  return out;
}

// What the analysis of a voice suggests (lib/enhance/analyze.js gives the stats).
export function suggest(stats) {
  const s = voiceDefaults();
  const m = s.modules;
  const on = (id, changes = {}) => Object.assign(m[id], { on: true }, changes);
  if (!stats) return s;
  if (stats.rumble) on('highpass', { freq: 80 });
  if (stats.humHz) on('dehum', { base: String(stats.humHz) });
  if (stats.dropoutsPerMin >= 3) on('dropouts');
  const snr = (stats.level ?? -20) - (stats.noiseDb ?? -140);
  if (stats.noiseDb > -58 || snr < 40) on('denoise', { amount: clamp(Math.round((50 - snr) * 0.6 + 8), 6, 18) });
  if (stats.cutoffHz && stats.cutoffHz < 14000) on('highs', { amount: stats.cutoffHz < 8000 ? -6 : -9 });
  if (stats.cutoffHz && stats.cutoffHz < 14000) on('eq', { presence: 1.5 });
  if (stats.gatedShare > 0.04 || stats.dropoutsPerMin >= 3) on('compress', { amount: 30 });
  return s;
}

/* ---------- running it ---------- */

// One voice's chain: the modules that are on, in order, the spectral ones sharing one STFT.
export function buildVoiceChain(vs, { rate = RATE, profile = null } = {}) {
  const mods = [];
  const m = vs.modules;
  for (const def of VOICE_MODULES) {
    const id = def.id;
    if (!m[id]?.on) continue;
    if (SPECTRAL.includes(id)) {
      if (mods.some((x) => x instanceof Spectral)) continue;
      const opts = {};
      for (const sid of SPECTRAL) if (m[sid]?.on) opts[sid] = m[sid];
      mods.push(new Spectral(opts, { rate, profile }));
    } else {
      mods.push(new BUILD[id](m[id], { rate, profile }));
    }
  }
  return mods;
}

export function buildMasterChain(ms, { rate = RATE, lufs = null } = {}) {
  return MASTER_MODULES.filter((d) => ms.modules[d.id]?.on).map((d) => new BUILD[d.id](ms.modules[d.id], { rate, lufs }));
}

const latencyOf = (mods) => mods.reduce((s, m) => s + m.latency, 0);
const runAll = (mods, x) => mods.reduce((y, m) => m.process(y), x);

// Per-sample weight of each voice, from a timeline of { start, end, voice } (seconds), with
// raised-cosine crossfades of `fade` seconds at every change of voice.
export class VoiceWeights {
  constructor(timeline, voices, rate = RATE, fade = 0.08) {
    this.t = [...timeline].sort((a, b) => a.start - b.start);
    this.voices = voices;
    this.rate = rate;
    this.half = (fade * rate) / 2;
  }

  // Float32Array per voice for input samples [from, from + n).
  block(from, n) {
    const out = this.voices.map(() => new Float32Array(n));
    if (!this.t.length) { out[0]?.fill(1); return out; }
    const rate = this.rate;
    const h = this.half;
    // Segments that touch this block (with the fade margin).
    const a = (from - h) / rate;
    const b = (from + n + h) / rate;
    for (let si = 0; si < this.t.length; si++) {
      const seg = this.t[si];
      if (seg.end < a || seg.start > b) continue;
      const vi = seg.voice;
      if (!out[vi]) continue;
      const first = si === 0;
      const last = si === this.t.length - 1;
      const s0 = seg.start * rate;
      const s1 = seg.end * rate;
      const lo = Math.max(from, Math.floor(first ? from : s0 - h));
      const hi = Math.min(from + n, Math.ceil(last ? from + n : s1 + h));
      const w = out[vi];
      for (let i = lo; i < hi; i++) {
        let v = 1;
        if (!first && i < s0 + h) v *= 0.5 - 0.5 * Math.cos((Math.PI * (i - (s0 - h))) / (2 * h));
        if (!last && i > s1 - h) v *= 0.5 + 0.5 * Math.cos((Math.PI * (i - (s1 - h))) / (2 * h));
        w[i - from] += clamp(v, 0, 1);
      }
    }
    // Normalise (two crossfades can overlap on very short segments).
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (const w of out) s += w[i];
      if (s > 0 && Math.abs(s - 1) > 1e-6) for (const w of out) w[i] /= s;
      else if (s === 0 && out[0]) out[0][i] = 1;
    }
    return out;
  }
}

// The whole clean-up for one episode. process(x, alt) takes the next block of the episode
// (mono, RATE) and, for voices set to use it, the same stretch of the regenerated version;
// it returns the processed block `latency` samples late.
export class Renderer {
  constructor({ settings, voices, timeline, profiles = {}, rate = RATE, hasAlt = false, lufs = null }) {
    this.rate = rate;
    this.voices = voices;
    this.weights = new VoiceWeights(timeline, voices, rate);
    this.paths = voices.map((v) => {
      const vs = settings.voices[v.id] || voiceDefaults();
      const mods = vs.bypass ? [] : buildVoiceChain(vs, { rate, profile: profiles[v.id] });
      return { mods, alt: hasAlt && !!vs.regen, latency: latencyOf(mods) };
    });
    this.voiceLatency = Math.max(0, ...this.paths.map((p) => p.latency));
    for (const p of this.paths) p.pad = new Delay(this.voiceLatency - p.latency);
    this.master = buildMasterChain(settings.master, { rate, lufs });
    this.latency = this.voiceLatency + latencyOf(this.master);
    this.pos = 0; // input samples taken so far
  }

  process(x, alt = null) {
    const n = x.length;
    const mix = new Float32Array(n);
    // The voice outputs come out voiceLatency late: weigh them with the weights of that time.
    const w = this.weights.block(this.pos - this.voiceLatency, n);
    this.paths.forEach((p, vi) => {
      const input = p.alt && alt ? alt : x;
      const y = p.pad.process(runAll(p.mods, input));
      const wv = w[vi];
      for (let i = 0; i < n; i++) mix[i] += y[i] * wv[i];
    });
    this.pos += n;
    return runAll(this.master, mix);
  }
}

// Runs a renderer over a whole buffer and returns the output lined up with the input (the
// first `skip` samples, used to settle the chain, are left out).
export function renderBuffer(renderer, x, alt = null, { skip = 0, block = 8192 } = {}) {
  const L = renderer.latency;
  const total = x.length + L;
  const out = new Float32Array(Math.max(0, x.length - skip));
  let o = -L - skip;
  for (let i = 0; i < total; i += block) {
    const n = Math.min(block, total - i);
    const inX = new Float32Array(n);
    inX.set(x.subarray(Math.min(i, x.length), Math.min(i + n, x.length)));
    let inA = null;
    if (alt) { inA = new Float32Array(n); inA.set(alt.subarray(Math.min(i, alt.length), Math.min(i + n, alt.length))); }
    const y = renderer.process(inX, inA);
    for (let j = 0; j < n; j++, o++) if (o >= 0 && o < out.length) out[o] = y[j];
  }
  return out;
}

// Settings that only differ in ways that don't change the sound compare equal (for caching).
export function settingsKey(settings) {
  return JSON.stringify(settings, (k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v));
}
