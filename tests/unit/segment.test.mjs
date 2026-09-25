import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_RATE, MAX_SEG, MIN_SEG, nextCut, rms } from '../../lib/segment.js';

const tone = (secs, silences = []) => {
  const a = new Float32Array(Math.round(secs * SAMPLE_RATE));
  for (let i = 0; i < a.length; i++) {
    const t = i / SAMPLE_RATE;
    a[i] = silences.some(([s, e]) => t >= s && t < e) ? 0 : 0.3 * Math.sin(i * 0.1);
  }
  return a;
};

test('waits for more audio unless it is the end', () => {
  const a = tone(20);
  assert.equal(nextCut(a, 0, false), null);
  assert.equal(nextCut(a, 0, true), a.length);
  assert.equal(nextCut(a, a.length, true), null);
});

test('cuts inside the quietest moment between 18 and 29.5 seconds', () => {
  const a = tone(60, [[23.4, 23.9]]);
  const cut = nextCut(a, 0, false) / SAMPLE_RATE;
  assert.ok(cut > 23.4 && cut < 23.9, `cut at ${cut}`);
});

test('never cuts outside the window, even without pauses', () => {
  const a = tone(60);
  const cut = nextCut(a, 0, false);
  assert.ok(cut >= MIN_SEG && cut <= MAX_SEG);
});

test('rms', () => {
  assert.equal(rms(new Float32Array(100), 0, 100), 0);
  assert.ok(Math.abs(rms(new Float32Array(100).fill(0.5), 0, 100) - 0.5) < 1e-6);
});
