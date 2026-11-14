import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuietFinder, cutsFor, cutIndex, cutSeconds } from '../../lib/quiet.js';

const RATE = 8000;

// A recording: talk (a warbling tone with the unevenness of speech) over a background, with
// pauses where only the background is left. plan: [['talk', seconds] | ['pause', seconds], ...]
function recording(plan, { voice = 0.25, background = 0.002, seed = 7 } = {}) {
  let s = seed;
  const noise = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 31 - 1; };
  const out = new Float32Array(Math.round(plan.reduce((n, [, sec]) => n + sec, 0) * RATE));
  let i = 0;
  for (const [what, sec] of plan) {
    const n = Math.round(sec * RATE);
    for (let k = 0; k < n; k++, i++) {
      const t = i / RATE;
      const talk = what === 'talk' ? Math.sin(2 * Math.PI * (170 + 40 * Math.sin(t * 3)) * t) * voice * (0.6 + 0.4 * Math.sin(t * 9)) : 0;
      out[i] = talk + noise() * background;
    }
  }
  return out;
}
const find = (samples, chunk = 0) => {
  const f = new QuietFinder(RATE);
  if (!chunk) f.push(samples);
  else for (let i = 0; i < samples.length; i += chunk) f.push(samples.subarray(i, i + chunk));
  return f.finish();
};
const near = (range, a, b, tol = 0.06) => Math.abs(range[0] - a) <= tol && Math.abs(range[1] - b) <= tol;

test('pauses are found where the talk stops, to within a few hundredths of a second', () => {
  const quiet = find(recording([['talk', 5], ['pause', 0.6], ['talk', 4], ['pause', 2.5], ['talk', 6], ['pause', 1.2], ['talk', 3]]));
  assert.equal(quiet.length, 3, JSON.stringify(quiet));
  assert.ok(near(quiet[0], 5, 5.6), JSON.stringify(quiet[0]));
  assert.ok(near(quiet[1], 9.6, 12.1), JSON.stringify(quiet[1]));
  assert.ok(near(quiet[2], 18.1, 19.3), JSON.stringify(quiet[2]));
});

test('it makes no difference how the audio is handed over', () => {
  const audio = recording([['talk', 3], ['pause', 1], ['talk', 3], ['pause', 0.5], ['talk', 2]]);
  assert.deepEqual(find(audio, 777), find(audio));
  assert.deepEqual(find(audio, 16000), find(audio));
});

test('a gap between two sounds of a word is not a pause', () => {
  const quiet = find(recording([['talk', 4], ['pause', 0.12], ['talk', 4], ['pause', 0.2], ['talk', 4], ['pause', 0.8], ['talk', 4]]));
  assert.equal(quiet.length, 1, JSON.stringify(quiet));
  assert.ok(near(quiet[0], 12.32, 13.12), JSON.stringify(quiet[0]));
});

test('silence that is silence all the way down (a call with the microphones gated) counts', () => {
  const quiet = find(recording([['talk', 5], ['pause', 2], ['talk', 5]], { background: 0 }));
  assert.equal(quiet.length, 1);
  assert.ok(near(quiet[0], 5, 7));
});

test('a recording in a loud room still shows its pauses, as long as the talk stands clear of the room', () => {
  const quiet = find(recording([['talk', 5], ['pause', 2], ['talk', 5], ['pause', 1], ['talk', 4]], { background: 0.012 }));
  assert.equal(quiet.length, 2, JSON.stringify(quiet));
});

test('where talk and background cannot be told apart, nothing is called a pause', () => {
  assert.deepEqual(find(recording([['talk', 5], ['pause', 2], ['talk', 5]], { background: 0.12 })), []);
  // Music, or anything else that never lets up.
  assert.deepEqual(find(recording([['talk', 20]])), []);
  // Too little to judge by.
  assert.deepEqual(find(recording([['talk', 0.3], ['pause', 0.4]])), []);
});

test('music under a pause keeps it from being cut', () => {
  // A bed 14 dB under the voice: quieter, and still something to listen to.
  const audio = recording([['talk', 6], ['pause', 3], ['talk', 6], ['pause', 2], ['talk', 6]]);
  for (let i = 6 * RATE; i < 9 * RATE; i++) audio[i] += Math.sin(2 * Math.PI * 330 * (i / RATE)) * 0.05;
  const quiet = find(audio);
  assert.equal(quiet.length, 1, JSON.stringify(quiet));
  assert.ok(near(quiet[0], 15, 17), JSON.stringify(quiet));
});

test('pauses longer than the limit are cut down to it, shorter ones are left as they are', () => {
  const quiet = [[5, 5.6], [9.6, 12.1], [18.1, 19.3], [30, 30.9]];
  // Half the limit stays after the last word and half before the next.
  assert.deepEqual(cutsFor(quiet, 0.8), [[10, 11.7], [18.5, 18.9]]);
  assert.deepEqual(cutsFor(quiet, 2), [[10.6, 11.1]]);
  assert.deepEqual(cutsFor(quiet, 3), []);
  assert.deepEqual(cutsFor(quiet, 0), []);
  assert.deepEqual(cutsFor(null, 0.8), []);
  // What is left of a pause that was cut is the limit.
  for (const limit of [0.5, 0.8, 1.2, 2]) {
    for (const [from, to] of cutsFor([[100, 104]], limit)) assert.ok(Math.abs(4 - (to - from) - limit) < 0.011, `${limit}`);
  }
});

test('a jump that takes a moment itself is made later and lands later, and not at all when it gains nothing', () => {
  const quiet = [[10, 12.5], [20, 21]];
  // 0.2 s for the jump: that much less is left before the next word (never less than 0.12 s).
  assert.deepEqual(cutsFor(quiet, 0.8, 0.2), [[10.4, 12.3], [20.4, 20.8]]);
  assert.deepEqual(cutsFor(quiet, 0.8, 0.5), [[10.4, 12.38]]);
  // A pause only just over the limit gains less than the jump costs: left alone.
  assert.deepEqual(cutsFor([[20, 21.1]], 0.8), [[20.4, 20.7]]);
  assert.deepEqual(cutsFor([[20, 20.9]], 0.8, 0.2), []);
  // A slow player (a second per jump) only shortens the long ones.
  assert.deepEqual(cutsFor([[10, 11.5], [20, 26]], 0.5, 1), [[20.25, 25.88]]);
});

test('finding the cut the player is in', () => {
  const cuts = [[10, 11.7], [18.5, 18.9], [40, 45]];
  assert.equal(cutIndex(cuts, 0), 0);
  assert.equal(cutIndex(cuts, 10.5), 0);
  assert.equal(cutIndex(cuts, 11.7), 1);
  assert.equal(cutIndex(cuts, 30), 2);
  assert.equal(cutIndex(cuts, 44.9), 2);
  assert.equal(cutIndex(cuts, 45), 3);
  assert.equal(cutIndex([], 5), 0);
  assert.ok(Math.abs(cutSeconds(cuts) - 7.1) < 1e-9);
  assert.equal(cutSeconds(null), 0);
});
