import test from 'node:test';
import assert from 'node:assert/strict';
import { makeShape, readShape, validShape, voiceAt, bars, hasVoices, hasLoudness, Loudness, SHAPE_VERSION } from '../../lib/shape.js';
import { encodeLevels, secondLevels } from '../../lib/levels.js';

const seg = (start, end, speaker) => ({ start, end, speaker, text: 'x' });

test('voices are ordered by how much they speak, and named as the transcript names them', () => {
  const segments = [seg(0, 10, 0), seg(10, 40, 1), seg(40, 50, 0), seg(50, 100, 1)];
  const shape = makeShape({ segments, levels: new Uint8Array(100).fill(50), total: 100 }, { 0: 'Tom Aldous' });
  assert.deepEqual(shape.voices, ['Speaker 2', 'Tom Aldous']);
  assert.equal(shape.other, -1);
  assert.equal(shape.v, SHAPE_VERSION);
  assert.ok(validShape(shape));
  const s = readShape(shape);
  assert.equal(voiceAt(s, 5), 1);
  assert.equal(voiceAt(s, 20), 0);
  assert.equal(voiceAt(s, 45), 1);
});

test('voices heard only in passing are one "other", after the others', () => {
  // 600 s of talk between two, and a voice of 15 s (an ad) nobody named.
  const segments = [];
  for (let t = 0; t < 600; t += 20) segments.push(seg(t, t + 19, (t / 20) % 2));
  segments.push(seg(600, 615, 2));
  const shape = makeShape({ segments, total: 620 });
  assert.deepEqual(shape.voices, ['Speaker 1', 'Speaker 2', 'Other voice']);
  assert.equal(shape.other, 2);
  assert.equal(voiceAt(readShape(shape), 605), 2);
  // Named, it is a voice of its own.
  assert.deepEqual(makeShape({ segments, total: 620 }, { 2: 'Ad voice' }).voices, ['Speaker 1', 'Speaker 2', 'Ad voice']);
});

test('more voices than colours: the least heard share the "other"', () => {
  const segments = [];
  for (let k = 0; k < 8; k++) segments.push(seg(k * 100, k * 100 + 90 - k, k));
  const shape = makeShape({ segments, total: 800 });
  assert.equal(shape.voices.length, 6);
  assert.equal(shape.other, 5);
  const s = readShape(shape);
  assert.equal(voiceAt(s, 50), 0);
  assert.equal(voiceAt(s, 750), 5);
});

test('turns: one voice across a short gap is one turn; in a pause the last voice holds', () => {
  const shape = makeShape({ segments: [seg(0, 4, 0), seg(5, 9, 0), seg(12, 15, 1), seg(20.04, 30, 0)], total: 30 });
  assert.deepEqual(shape.turns, [0, 90, 0, 30, 30, 1, 50, 100, 0]);
  const s = readShape(shape);
  assert.equal(voiceAt(s, 4.5), 0);
  assert.equal(voiceAt(s, 17), 1);
  assert.equal(voiceAt(s, 17, { hold: 1 }), -1);
  assert.equal(voiceAt(s, 31, { hold: 0.5 }), -1);
});

test('the bars for a stretch: height on the episode\'s scale, voice of whoever speaks most', () => {
  const levels = new Uint8Array(100);
  for (let i = 0; i < 100; i++) levels[i] = 10 + i; // louder and louder
  const s = readShape(makeShape({ segments: [seg(0, 30, 0), seg(30, 100, 1)], levels, total: 100 }));
  const { h, v } = bars(s, { from: 0, to: 100, count: 10 });
  // (The second voice speaks more: it is the first colour.)
  assert.deepEqual([...v], [1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(h[9], 1); // the loudest bar is the top
  assert.equal(h[0], 0); // the quietest is the floor
  for (let i = 1; i < 10; i++) assert.ok(h[i] > h[i - 1]);
  // A bar a second, for three minutes around a point: past the end there is nothing.
  const z = bars(s, { from: 50, to: 230, count: 180 });
  assert.equal(z.h.length, 180);
  assert.ok(z.h[0] > 0 && z.h[49] === 1 && z.h[50] === -1);
  assert.equal(z.v[0], 0);
  assert.equal(z.v[60], -1);
  // A bar mostly one voice is theirs.
  assert.deepEqual([...bars(s, { from: 25, to: 40, count: 1 }).v], [0]);
  assert.deepEqual([...bars(s, { from: 15, to: 35, count: 1 }).v], [1]);
});

test('loudness without voices, and neither', () => {
  const s = readShape(makeShape({ levels: new Uint8Array([20, 40, 60, 80]) }));
  assert.ok(hasLoudness(s) && !hasVoices(s));
  assert.equal(s.total, 4);
  const { h, v } = bars(s, { count: 4 });
  assert.deepEqual([...v], [-1, -1, -1, -1]);
  assert.ok(h[3] === 1 && h[0] === 0);
  assert.equal(voiceAt(s, 1), -1);
  const none = readShape(makeShape({ segments: [seg(0, 5, 0)], total: 10 }));
  assert.ok(hasVoices(none) && !hasLoudness(none));
  assert.deepEqual([...bars(none, { count: 2 }).h], [-1, -1]);
});

test('what is read back is checked', () => {
  const good = makeShape({ segments: [seg(0, 5, 0)], levels: new Uint8Array(5).fill(9) });
  assert.ok(readShape(JSON.parse(JSON.stringify(good))));
  assert.equal(readShape({ ...good, v: 99 }), null);
  assert.equal(readShape({ ...good, turns: [0, 10, 3] }), null);
  assert.equal(readShape({ ...good, turns: [0, -1, 0] }), null);
  assert.equal(readShape(null), null);
});

test('an hour is a few kilobytes', () => {
  const levels = new Uint8Array(3600);
  for (let i = 0; i < 3600; i++) levels[i] = 30 + ((i * 37) % 90);
  const segments = [];
  // A turn every 8 seconds on average, two voices and the odd third.
  for (let t = 0, k = 0; t < 3590; t += 3 + ((k * 7) % 11), k++) segments.push(seg(t, t + 2.5 + ((k * 5) % 8), k % 7 === 6 ? 2 : k % 2));
  const shape = makeShape({ segments, levels, total: 3600 });
  const size = JSON.stringify(shape).length;
  assert.ok(size < 16000, `${size} bytes`);
});

test('loudness counted piece by piece is what the whole file gives', () => {
  const rate = 100;
  const samples = Float32Array.from({ length: 1050 }, (_, i) => Math.sin(i / 3) * (0.1 + (i % 400) / 1000));
  const meter = new Loudness(rate);
  for (let i = 0; i < samples.length; i += 37) meter.push(samples.subarray(i, i + 37));
  assert.deepEqual([...meter.finish()], [...secondLevels(samples, rate)]);
  assert.equal(encodeLevels(meter.finish()).length > 0, true);
});

test('a voice has the colour the transcript side gives that speaker, whoever speaks most', () => {
  // Speaker 1 talks most, so is first in `voices`; its colour is still speaker 1's.
  const shape = makeShape({ total: 60, segments: [{ start: 0, end: 10, speaker: 0 }, { start: 10, end: 50, speaker: 1 }, { start: 50, end: 58, speaker: 0 }] }, { 0: 'Host', 1: 'Guest' });
  assert.deepEqual(shape.voices, ['Guest', 'Host']);
  assert.deepEqual(shape.hues, [1, 0]);
  assert.ok(validShape(shape));
  assert.deepEqual(readShape(shape).hues, [1, 0]);
  // One stored before hues were, or with loudness only, reads in order.
  const { hues, ...old } = shape;
  assert.deepEqual(readShape(old).hues, [0, 1]);
});
