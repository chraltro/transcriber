import test from 'node:test';
import assert from 'node:assert/strict';
import { HighPass, DeClick, Dropouts, Spectral, Leveler, RoomTone, Limiter, LoudnessMeter, Compressor, STFT_SIZE } from '../../lib/enhance/modules.js';
import { Renderer, renderBuffer, voiceDefaults, masterDefaults, VoiceWeights, applyPreset, RATE } from '../../lib/enhance/chain.js';
import { RealFFT, Rand } from '../../lib/enhance/dsp.js';

const R = RATE;
const rms = (a, s = 0, e = a.length) => { let x = 0; for (let i = s; i < e; i++) x += a[i] * a[i]; return Math.sqrt(x / Math.max(1, e - s)); };
const db = (v) => 20 * Math.log10(v + 1e-12);

// Speech-like: a gliding pitch with formant-weighted harmonics, in syllables with pauses.
function voice(seconds, { f0 = 140, seed = 1, level = 0.2, pauses = true, maxHz = 9000, noise = 0.0005 } = {}) {
  const n = Math.round(seconds * R);
  const x = new Float32Array(n);
  const rnd = new Rand(seed);
  // Real voices have their harmonics' phases spread out (not one sharp pulse per period).
  const off = Array.from({ length: 80 }, () => 2 * Math.PI * rnd.next());
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / R;
    const f = f0 * (1 + 0.08 * Math.sin(2 * Math.PI * 0.7 * t));
    ph += (2 * Math.PI * f) / R;
    let v = 0;
    for (let h = 1; h * f < maxHz; h++) {
      const hf = h * f;
      const formant = Math.exp(-((hf - 600) ** 2) / 2e5) + 0.6 * Math.exp(-((hf - 1800) ** 2) / 4e5) + 0.3 * Math.exp(-((hf - 3000) ** 2) / 8e5) + 0.02;
      v += Math.sin(h * ph + off[h]) * formant / h;
    }
    const syl = pauses ? Math.max(0, Math.sin(2 * Math.PI * 2.2 * t)) ** 0.5 : 1;
    x[i] = level * 0.5 * v * syl + noise * rnd.gauss();
  }
  return x;
}

// out[i] lines up with x[i - latency]: compare after shifting.
function aligned(mod, x) {
  const y = new Float32Array(x.length + mod.latency);
  let o = 0;
  for (let i = 0; i < y.length; i += 4096) {
    const part = new Float32Array(Math.min(4096, y.length - i));
    part.set(x.subarray(i, Math.min(i + 4096, x.length)));
    const out = mod.process(part);
    y.set(out, o);
    o += out.length;
  }
  return y.subarray(mod.latency);
}

test('every module that should leave clean audio alone does, at its stated latency', () => {
  const x = voice(3, { pauses: false });
  const cases = [
    ['dropout repair', new Dropouts({}, { rate: R })],
    ['click repair', new DeClick({ sensitivity: 50 }, { rate: R })],
    ['spectral, 0 dB', new Spectral({ denoise: { amount: 0, sensitivity: 50 } }, { rate: R, profile: { noisePsd: new Float64Array(STFT_SIZE / 2 + 1).fill(1e-6) } })],
    ['leveler, 0 %', new Leveler({ strength: 0 }, { rate: R })],
    ['room tone', new RoomTone({}, { rate: R })],
    ['limiter', new Limiter({ ceiling: -0.1 }, { rate: R })],
  ];
  for (const [name, mod] of cases) {
    const y = aligned(mod, x);
    let err = 0;
    // (the end is left out: the harness feeds silence after it, which room tone answers)
    for (let i = 0; i < x.length - 0.05 * R; i++) err = Math.max(err, Math.abs(y[i] - x[i]));
    // (the leveler's floor of 4 dB of travel is allowed to move nothing at 0 % strength)
    assert.ok(err < 1e-4, `${name}: off by ${err}`);
  }
});

test('the chain gives the same result whatever size the blocks are (previews match exports)', () => {
  const x = voice(6);
  for (let i = 0; i < 3; i++) x.fill(0, R * (1.3 + i) | 0, (R * (1.3 + i) | 0) + 1500); // a few holes
  const settings = { voices: { a: applyPreset('call') }, master: masterDefaults() };
  Object.assign(settings.master.modules.roomtone, { on: true });
  settings.voices.a.modules.declick.on = true;
  settings.voices.a.modules.dehum.on = true;
  settings.voices.a.modules.dereverb.on = true;
  const make = () => new Renderer({ settings, voices: [{ id: 'a' }], timeline: [{ start: 0, end: 6, voice: 0 }], profiles: { a: { cutoffHz: 8000, humHz: 50 } } });
  const a = renderBuffer(make(), x, null, { block: 8192 });
  const b = renderBuffer(make(), x, null, { block: 1000 });
  let err = 0;
  for (let i = 0; i < a.length; i++) err = Math.max(err, Math.abs(a[i] - b[i]));
  assert.ok(err < 1e-6, `differs by ${err}`);
  assert.ok(rms(a) > 0.01, 'and it made sound');
});

test('dropout repair fills punched holes far better than leaving them silent', () => {
  const clean = voice(4, { pauses: false, seed: 3 });
  const holed = clean.slice();
  const holes = [[0.5, 0.03], [1.2, 0.05], [2.1, 0.02], [2.9, 0.08]].map(([t, d]) => [Math.round(t * R), Math.round((t + d) * R)]);
  for (const [a, b] of holes) holed.fill(0, a, b);
  const mod = new Dropouts({}, { rate: R });
  const y = aligned(mod, holed);
  assert.equal(mod.count, holes.length, 'every hole found');
  for (const [a, b] of holes) {
    const level = db(rms(y, a, b)) - db(rms(clean, a, b));
    assert.ok(Math.abs(level) < 6, `filled hole within 6 dB of the original level (${level.toFixed(1)})`);
  }
});

test('click repair removes clicks and leaves the rest', () => {
  const clean = voice(3, { pauses: false, seed: 5 });
  const clicked = clean.slice();
  const at = [0.4, 0.9, 1.5, 2.2, 2.7].map((t) => Math.round(t * R));
  for (const i of at) { clicked[i] += 0.7; clicked[i + 1] -= 0.5; }
  const mod = new DeClick({ sensitivity: 50 }, { rate: R });
  const y = aligned(mod, clicked);
  for (const i of at) {
    const before = Math.max(...[0, 1].map((k) => Math.abs(clicked[i + k] - clean[i + k])));
    const after = Math.max(...[0, 1].map((k) => Math.abs(y[i + k] - clean[i + k])));
    assert.ok(after < before / 5, `click at ${i}: ${before.toFixed(3)} -> ${after.toFixed(3)}`);
  }
  assert.ok(mod.count <= at.length + 1, `no false alarms to speak of (${mod.count})`);
});

test('noise reduction turns the background down by about the set amount', () => {
  const rnd = new Rand(4);
  const n = R * 4;
  const noise = Float32Array.from({ length: n }, () => 0.01 * rnd.gauss());
  // Noise profile, as the analysis measures it: mean power per bin of the noise.
  const fft = new RealFFT(STFT_SIZE);
  const psd = new Float64Array(STFT_SIZE / 2 + 1);
  const re = new Float64Array(psd.length);
  const im = new Float64Array(psd.length);
  const fr = new Float64Array(STFT_SIZE);
  let frames = 0;
  for (let s = 0; s + STFT_SIZE < R; s += 256, frames++) {
    for (let i = 0; i < STFT_SIZE; i++) fr[i] = noise[s + i] * Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / STFT_SIZE));
    fft.forward(fr, re, im);
    for (let k = 0; k < psd.length; k++) psd[k] += re[k] ** 2 + im[k] ** 2;
  }
  for (let k = 0; k < psd.length; k++) psd[k] /= frames;
  const x = noise.slice();
  const v = voice(2, { pauses: false, seed: 8 });
  for (let i = 0; i < v.length; i++) x[2 * R + i] += v[i];
  const y = aligned(new Spectral({ denoise: { amount: 15, sensitivity: 50 } }, { rate: R, profile: { noisePsd: psd } }), x);
  const drop = db(rms(y, R, 2 * R)) - db(rms(x, R, 2 * R));
  assert.ok(drop < -11 && drop > -17, `noise down ${drop.toFixed(1)} dB`);
  const keep = db(rms(y, 2.5 * R, 3.5 * R)) - db(rms(x, 2.5 * R, 3.5 * R));
  assert.ok(keep > -1.5, `voice kept (${keep.toFixed(1)} dB)`);
});

test('restore highs adds treble above the cut-off while someone talks, not in the pauses', () => {
  const band = voice(3, { seed: 9, maxHz: 3900, noise: 0 });
  const fft = new RealFFT(4096);
  const hiDb = (a, at) => {
    const re = new Float64Array(2049); const im = new Float64Array(2049); const fr = new Float64Array(4096);
    const s = Math.round(at * R);
    for (let i = 0; i < 4096; i++) fr[i] = a[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 4096));
    fft.forward(fr, re, im);
    let hi = 0; let lo = 0;
    for (let k = Math.round(4300 / (R / 4096)); k < Math.round(7500 / (R / 4096)); k++) hi += re[k] ** 2 + im[k] ** 2;
    for (let k = Math.round(2000 / (R / 4096)); k < Math.round(3800 / (R / 4096)); k++) lo += re[k] ** 2 + im[k] ** 2;
    return 10 * Math.log10((hi + 1e-20) / (lo + 1e-20));
  };
  const y = aligned(new Spectral({ highs: { amount: -9, cutoff: 4000 } }, { rate: R }), band);
  // Syllables are loud around 0.11 s + k/2.2 s.
  const before = hiDb(band, 1.0);
  const after = hiDb(y, 1.0);
  assert.ok(before < -60, `nothing up there to begin with (${before.toFixed(0)} dB)`);
  assert.ok(after > before + 30 && after > -40 && after < -6, `treble restored, below the band under it (${after.toFixed(1)} dB)`);
  // A pause in the syllables (signal zero): nothing added.
  const z = new Float32Array(R);
  const yz = aligned(new Spectral({ highs: { amount: -9, cutoff: 4000 } }, { rate: R }), z);
  assert.ok(Math.max(...yz.map(Math.abs)) === 0, 'silence stays silent');
});

test('the limiter never goes over its ceiling', () => {
  const x = voice(2, { level: 2.5, pauses: false });
  const y = aligned(new Limiter({ ceiling: -1 }, { rate: R }), x);
  const peak = Math.max(...y.map(Math.abs));
  assert.ok(peak <= 10 ** (-1 / 20) + 1e-6, `peak ${db(peak).toFixed(2)} dB`);
});

test('loudness meter: a 1 kHz sine at -20 dBFS reads about -23 LUFS', () => {
  const m = new LoudnessMeter(R);
  m.push(Float32Array.from({ length: R * 3 }, (_, i) => 0.1 * Math.sin((2 * Math.PI * 1000 * i) / R)));
  assert.ok(Math.abs(m.integrated() + 23.0) < 0.25, `${m.integrated().toFixed(2)}`);
});

test('the leveler brings a quiet and a loud voice to the same loudness', () => {
  const quiet = voice(12, { level: 0.3, seed: 2 });
  const loud = voice(12, { level: 1.5, seed: 3 });
  const x = new Float32Array(quiet.length + loud.length);
  x.set(quiet); x.set(loud, quiet.length);
  const y = aligned(new Leveler({ target: -16, strength: 100, speed: 'normal' }, { rate: R }), x);
  const lufs = (a) => { const m = new LoudnessMeter(R); m.push(a); return m.integrated(); };
  const a = lufs(y.subarray(6 * R, 12 * R));
  const b = lufs(y.subarray(18 * R, 24 * R));
  assert.ok(Math.abs(a + 16) < 2 && Math.abs(b + 16) < 2, `${a.toFixed(1)} and ${b.toFixed(1)} LUFS`);
});

test('room tone fills dead silence at the set level and leaves speech alone', () => {
  const x = voice(2, { pauses: false });
  x.fill(0, R * 0.8, R * 1.2);
  const y = aligned(new RoomTone({ level: -55, tone: 'neutral' }, { rate: R }), x);
  const level = db(rms(y, R * 0.85, R * 1.15));
  assert.ok(Math.abs(level + 55) < 1.5, `room tone at ${level.toFixed(1)} dB`);
  let err = 0;
  for (let i = 0; i < R * 0.7; i++) err = Math.max(err, Math.abs(y[i] - x[i]));
  assert.ok(err < 1e-6, 'speech untouched');
});

test('voice weights sum to one and crossfade at changes', () => {
  const w = new VoiceWeights([{ start: 0, end: 1, voice: 0 }, { start: 1, end: 2, voice: 1 }], [{ id: 'a' }, { id: 'b' }], R, 0.08);
  const [a, b] = w.block(0, 2 * R);
  for (let i = 0; i < 2 * R; i += 97) assert.ok(Math.abs(a[i] + b[i] - 1) < 1e-6);
  assert.ok(a[Math.round(0.9 * R)] === 1 && b[Math.round(1.1 * R)] === 1);
  assert.ok(Math.abs(a[R] - 0.5) < 0.01, `halfway at the change (${a[R]})`);
});

test('a bypassed voice comes out untouched while the other is processed', () => {
  const x = voice(4, { pauses: false });
  const settings = { voices: { host: { ...voiceDefaults(), bypass: true }, guest: applyPreset('radio') }, master: { modules: {} } };
  const r = new Renderer({ settings, voices: [{ id: 'host' }, { id: 'guest' }], timeline: [{ start: 0, end: 2, voice: 0 }, { start: 2, end: 4, voice: 1 }] });
  const y = renderBuffer(r, x);
  let err = 0;
  for (let i = 0; i < Math.round(1.9 * R); i++) err = Math.max(err, Math.abs(y[i] - x[i]));
  assert.ok(err < 1e-6, `host untouched (${err})`);
  let diff = 0;
  for (let i = Math.round(2.2 * R); i < 3.8 * R; i++) diff = Math.max(diff, Math.abs(y[i] - x[i]));
  assert.ok(diff > 0.01, 'guest processed');
});

test('compressor: louder input gets less louder output', () => {
  const c = new Compressor({ amount: 80, speed: 'medium' }, { rate: R });
  const lo = c.curve(-30);
  const hi = c.curve(-6);
  assert.ok(hi < lo - 6, `${lo.toFixed(1)} / ${hi.toFixed(1)}`);
  void HighPass;
});
