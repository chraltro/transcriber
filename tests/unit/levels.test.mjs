import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secondLevels, encodeLevels, decodeLevels, barHeights } from '../../lib/levels.js';

test('one level per second, silence is 1 (0 means unknown), loud is higher', () => {
  const sr = 16000;
  const a = new Float32Array(sr * 2.5);
  for (let i = sr; i < 2 * sr; i++) a[i] = Math.sin(i / 10) * 0.2;
  const lv = secondLevels(a, sr);
  assert.equal(lv.length, 3);
  assert.equal(lv[0], 1);
  assert.ok(lv[1] > 100);
  assert.equal(lv[2], 1);
});

test('levels survive base64 round trips; garbage decodes to empty', () => {
  const lv = Uint8Array.from({ length: 70000 }, (_, i) => (i * 7) % 256);
  assert.deepEqual(decodeLevels(encodeLevels(lv)), lv);
  assert.equal(decodeLevels('%%%').length, 0);
  assert.equal(decodeLevels(undefined).length, 0);
});

test('bars: unknown stays -1, heights are relative to the loud end', () => {
  const lv = new Uint8Array(100);
  for (let i = 0; i < 50; i++) lv[i] = 10 + (i % 5) * 10;
  lv[10] = 255; // one spike
  const bars = barHeights(lv, 10);
  assert.equal(bars.length, 10);
  for (let b = 5; b < 10; b++) assert.equal(bars[b], -1);
  assert.ok(bars[0] <= 1 && bars[1] === 1 && bars[2] > 0.5);
  assert.deepEqual([...barHeights(new Uint8Array(0), 4)], [-1, -1, -1, -1]);
});
