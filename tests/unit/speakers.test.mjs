import { test } from 'node:test';
import assert from 'node:assert/strict';
import { framesToTurns, Voices, labelParts, guessNames, speakerName, cosine } from '../../lib/speakers.js';
import { splitTimestamps, coveredUntil } from '../../lib/prompted.js';

test('frame classes become single-speaker turns; overlap and blips drop out', () => {
  // 0.1 s frames: speaker A 1 s, overlap 0.2 s, blip of B 0.1 s, silence, B 1 s
  const classes = [...Array(10).fill(1), 4, 4, 2, 0, 0, ...Array(10).fill(2)];
  const turns = framesToTurns(classes, 0.1);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((t) => t.spk), [0, 1]);
  assert.ok(Math.abs(turns[0].end - 1) < 1e-9);
  assert.ok(Math.abs(turns[1].start - 1.5) < 1e-9);
});

test('turns of one speaker across a short gap are joined', () => {
  const classes = [...Array(10).fill(1), 0, 0, ...Array(10).fill(1)];
  assert.equal(framesToTurns(classes, 0.1).length, 1);
});

test('voices: the same voice matches, a different one is new, and it survives saving', () => {
  const a = [1, 0.1, 0, 0];
  const b = [0, 0, 1, 0.2];
  const v = new Voices();
  assert.equal(v.match(a), 0);
  assert.equal(v.match([0.95, 0.15, 0.05, 0]), 0);
  assert.equal(v.match(b), 1);
  const again = new Voices(JSON.parse(JSON.stringify(v)));
  assert.equal(again.match([0.02, 0, 0.9, 0.3]), 1);
  assert.ok(cosine(again.list[0].c, again.list[0].c) > 0.999);
});

test('text parts take the speaker who talks most during them', () => {
  const parts = [{ start: 0, end: 4, text: 'Welcome.' }, { start: 4, end: 9, text: 'Thanks.' }, { start: 9, end: 10, text: 'Hm.' }];
  const turns = [{ spk: 0, start: 0, end: 4.5 }, { spk: 1, start: 4.5, end: 8.8 }];
  const out = labelParts(parts, turns, { 0: 3, 1: 5 });
  assert.deepEqual(out.map((p) => p.speaker), [3, 5, 5]);
  assert.equal(labelParts([{ start: 0, end: 1, text: 'x' }], [], {}, 2)[0].speaker, 2);
  assert.equal(labelParts([{ start: 0, end: 1, text: 'x' }], [], {})[0].speaker, undefined);
});

test('names come from introductions', () => {
  const segs = [
    { speaker: 0, text: "Welcome to the show. I'm Derek Thompson." },
    { speaker: 0, text: 'This is Plain English. Arvind Narayanan, welcome to the show.' },
    { speaker: 1, text: 'Great to be here.' },
    { speaker: 0, text: 'Sayash Kapoor, welcome to the show.' },
    { speaker: 2, text: "It's fantastic to be here." },
  ];
  const names = guessNames(segs, ['Derek Thompson', 'Arvind Narayanan', 'Sayash Kapoor', 'Plain English', 'OpenAI']);
  assert.deepEqual(names, { 0: 'Derek Thompson', 1: 'Arvind Narayanan', 2: 'Sayash Kapoor' });
  assert.equal(speakerName(1, names), 'Arvind Narayanan');
  assert.equal(speakerName(4, names), 'Speaker 5');
  assert.deepEqual(guessNames(segs, []), {});
});

test('timestamp tokens split a window into timed parts', () => {
  const B = 1000; // timestamp_begin
  const t = (sec) => B + Math.round(sec / 0.02);
  const parts = splitTimestamps([t(0), 1, 2, t(3.5), t(3.5), 3, 4, t(7), t(7.2), 5], B, 10);
  assert.deepEqual(parts.map((p) => [p.start, p.end, p.tokens]), [[0, 3.5, [1, 2]], [3.5, 7, [3, 4]], [7.2, 10, [5]]]);
  assert.equal(parts[2].open, true);
  assert.equal(coveredUntil(parts), 10);
  assert.deepEqual(splitTimestamps([1, 2], B, 5).map((p) => [p.start, p.end]), [[0, 5]]);
  assert.equal(coveredUntil(splitTimestamps([t(0), 1, t(4)], B, 20)), 4);
});
