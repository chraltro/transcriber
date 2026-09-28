import { test } from 'node:test';
import assert from 'node:assert/strict';
import { framesToTurns, Voices, labelParts, guessNames, speakerName, cosine, sentenceParts } from '../../lib/speakers.js';
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
  assert.equal(v.match(a, 5), 0);
  assert.equal(v.match([0.95, 0.15, 0.05, 0], 5), 0);
  assert.equal(v.match(b, 5), 1);
  const again = new Voices(JSON.parse(JSON.stringify(v)));
  assert.equal(again.match([0.02, 0, 0.9, 0.3], 5), 1);
  // A short snippet joins a close voice but never starts a new one.
  assert.equal(again.match([0.9, 0.3, 0.1, 0], 1), 0);
  assert.equal(again.match([0, 1, 0, 0], 1), null);
  assert.equal(again.list.length, 2);
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
    { start: 0, end: 5, speaker: 0, text: "Welcome to the show. I'm Derek Thompson." },
    { start: 5, end: 9, speaker: 0, text: 'This is Plain English. Arvind Narayanan, welcome to the show.' },
    { start: 9, end: 11, speaker: 1, text: 'Great to be here.' },
    { start: 11, end: 14, speaker: 0, text: 'Sayash Kapoor, welcome to the show.' },
    { start: 14, end: 16, speaker: 2, text: "It's fantastic to be here." },
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

test('long parts split into sentences with times shared out by length', () => {
  const out = sentenceParts([{ start: 10, end: 20, text: 'Sayash Kapoor, welcome to the show. It is fantastic to be here.' }, { start: 20, end: 22, text: 'Yes.' }]);
  assert.deepEqual(out.map((p) => p.text), ['Sayash Kapoor, welcome to the show.', 'It is fantastic to be here.', 'Yes.']);
  assert.equal(out[0].start, 10);
  assert.equal(out[1].end, 20);
  assert.ok(out[0].end > 14 && out[0].end < 16);
  assert.equal(sentenceParts([{ start: 0, end: 5, text: 'Mr. smith went. e.g. this' }]).length, 1);
});

test('a short reply lost to the host does not hand the guest the wrong name', () => {
  // The Plain English case: Arvind's "Hi Derek, great to be here" was too short to place, so
  // the next new voice after his welcome was Sayash's. Being addressed by name decides it.
  const segs = [
    { start: 0, end: 4, speaker: 0, text: "I'm Derek Thompson." },
    { start: 4, end: 8, speaker: 0, text: 'Arvind Narayanan, welcome to the show. Hi Derek, great to be here.' },
    { start: 8, end: 12, speaker: 0, text: 'Sayash Kapoor, welcome to the show.' },
    { start: 12, end: 14, speaker: 2, text: 'Fantastic to be here.' },
    { start: 14, end: 18, speaker: 0, text: 'Sayash, what is the worldview you are arguing against?' },
    { start: 18, end: 30, speaker: 2, text: 'There is this major point of discussion.' },
    { start: 30, end: 36, speaker: 0, text: 'So Arvind, your co-author explained it. Arvind, what is the strongest evidence?' },
    { start: 36, end: 50, speaker: 3, text: 'Let us start with the latter.' },
    { start: 50, end: 55, speaker: 0, text: 'That is fair, Arvind.' },
    { start: 55, end: 60, speaker: 3, text: 'Thanks.' },
  ];
  assert.deepEqual(guessNames(segs, ['Derek Thompson', 'Arvind Narayanan', 'Sayash Kapoor']), { 0: 'Derek Thompson', 2: 'Sayash Kapoor', 3: 'Arvind Narayanan' });
});
