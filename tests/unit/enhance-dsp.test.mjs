import test from 'node:test';
import assert from 'node:assert/strict';
import { FFT, RealFFT, Stft, Biquad, Delay } from '../../lib/enhance/dsp.js';

const rand = (n, seed = 3) => {
  let s = seed;
  return Float64Array.from({ length: n }, () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; });
};

test('complex FFT matches a direct DFT', () => {
  const n = 64;
  const x = rand(n);
  const re = Float64Array.from(x);
  const im = new Float64Array(n);
  new FFT(n).transform(re, im);
  for (const k of [0, 1, 5, 31, 32, 63]) {
    let r = 0;
    let i = 0;
    for (let t = 0; t < n; t++) { r += x[t] * Math.cos((2 * Math.PI * k * t) / n); i -= x[t] * Math.sin((2 * Math.PI * k * t) / n); }
    assert.ok(Math.abs(r - re[k]) < 1e-9 && Math.abs(i - im[k]) < 1e-9, `bin ${k}`);
  }
});

test('real FFT matches the complex FFT and inverts exactly', () => {
  const n = 512;
  const x = rand(n, 9);
  const re = new Float64Array(n / 2 + 1);
  const im = new Float64Array(n / 2 + 1);
  const r = new RealFFT(n);
  r.forward(x, re, im);
  const cr = Float64Array.from(x);
  const ci = new Float64Array(n);
  new FFT(n).transform(cr, ci);
  for (let k = 0; k <= n / 2; k++) assert.ok(Math.abs(cr[k] - re[k]) < 1e-9 && Math.abs(ci[k] - im[k]) < 1e-9, `bin ${k}`);
  const back = new Float64Array(n);
  r.inverse(re, im, back);
  for (let t = 0; t < n; t++) assert.ok(Math.abs(back[t] - x[t]) < 1e-12);
});

test('streaming STFT gives back the input, delayed by its latency, whatever the block sizes', () => {
  const x = Float32Array.from(rand(20000, 5));
  const s = new Stft(1024, 256);
  const parts = [];
  for (let i = 0, b = 1; i < x.length; i += b, b = (b * 7) % 997 + 1) parts.push(s.process(x.subarray(i, i + b)));
  const y = new Float32Array(x.length);
  let o = 0;
  for (const p of parts) { y.set(p, o); o += p.length; }
  const L = s.latency;
  let err = 0;
  for (let i = L; i < x.length; i++) err = Math.max(err, Math.abs(y[i] - x[i - L]));
  assert.ok(err < 1e-5, `max error ${err}`);
});

test('biquads: a high-pass passes highs and stops lows; a shelf reaches its gain', () => {
  const hp = new Biquad('highpass', 44100, 100);
  assert.ok(Math.abs(hp.responseDb(44100, 100) + 3.01) < 0.05);
  assert.ok(hp.responseDb(44100, 25) < -22);
  assert.ok(Math.abs(hp.responseDb(44100, 2000)) < 0.05);
  const shelf = new Biquad('highshelf', 44100, 8000, 1, 6);
  assert.ok(Math.abs(shelf.responseDb(44100, 18000) - 6) < 0.3);
  assert.ok(Math.abs(shelf.responseDb(44100, 200)) < 0.1);
  // and filtering a sine agrees with the response
  const x = Float32Array.from({ length: 44100 }, (_, i) => Math.sin((2 * Math.PI * 50 * i) / 44100));
  const y = new Biquad('highpass', 44100, 100).run(x.slice());
  const rms = (a) => Math.sqrt(a.subarray(22050).reduce((s, v) => s + v * v, 0) / 22050);
  const db = 20 * Math.log10(rms(y) / rms(x));
  assert.ok(Math.abs(db - hp.responseDb(44100, 50)) < 0.2, `${db}`);
});

test('delay line delays', () => {
  const d = new Delay(3);
  assert.deepEqual([...d.process(Float32Array.from([1, 2, 3, 4, 5]))], [0, 0, 0, 1, 2]);
  assert.deepEqual([...d.process(Float32Array.from([6]))], [3]);
});
