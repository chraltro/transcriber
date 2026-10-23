import test from 'node:test';
import assert from 'node:assert/strict';
import { alignEnvelopes } from '../../ui/studio.js';
import { Rand } from '../../lib/enhance/dsp.js';

test('the regenerated audio is lined up by its loudness envelope, even re-synthesised', () => {
  const R = 44100;
  const n = 6 * R;
  const rnd = new Rand(3);
  // A voice: vocal-fold pulses (jittered pitch) shaped into syllables. The "regenerated" copy
  // keeps the pulse timing, as a re-synthesised voice does, but every pulse is a different
  // waveform (a different noise burst).
  const env = (i) => Math.max(0, Math.sin((2 * Math.PI * 2.7 * i) / R)) ** 0.7;
  const total = n + 2 * R;
  const a = new Float32Array(total);
  const b = new Float32Array(total);
  for (let t = 0; t < total;) {
    const burstA = Array.from({ length: 60 }, (_, k) => rnd.gauss() * Math.exp(-k / 12));
    const burstB = Array.from({ length: 60 }, (_, k) => rnd.gauss() * Math.exp(-k / 12));
    for (let k = 0; k < 60 && t + k < total; k++) { a[t + k] += env(t) * burstA[k]; b[t + k] += env(t) * burstB[k]; }
    t += Math.round(R / (110 + 25 * Math.sin(t / R) + 6 * rnd.gauss()));
  }
  const maxLag = Math.round(0.25 * R);
  for (const shift of [0, 137, -900, 4000]) {
    const at = R;
    const x = a.subarray(at, at + n);
    const y = new Float32Array(n + 2 * maxLag);
    for (let i = 0; i < y.length; i++) { const j = at - maxLag + i - shift; if (j >= 0 && j < total) y[i] = b[j]; }
    const found = alignEnvelopes(x, y, maxLag);
    assert.ok(Math.abs(found - shift) <= 25, `shift ${shift}: found ${found}`);
  }
});
