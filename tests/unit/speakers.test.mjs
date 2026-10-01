import { test } from 'node:test';
import assert from 'node:assert/strict';
import { framesToTurns, Voices, labelParts, guessNames, speakerName, cosine, sentenceParts, clusterVoices } from '../../lib/speakers.js';
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

test('an address mid-way through the last lines of a turn counts, and misspelled first names too', () => {
  const segs = [
    { start: 0, end: 4, speaker: 0, text: "I'm Derek Thompson." },
    { start: 4, end: 8, speaker: 0, text: 'Sayyash, what is the worldview?' },
    { start: 8, end: 12, speaker: 0, text: 'And how did you get there?' },
    { start: 12, end: 30, speaker: 2, text: 'There is this major point.' },
    { start: 30, end: 34, speaker: 0, text: 'Arvind, what is the strongest piece of evidence today?' },
    { start: 34, end: 36, speaker: 0, text: 'That you are right?' },
    { start: 36, end: 40, speaker: 0, text: 'And what is the single thing you got wrong?' },
    { start: 40, end: 60, speaker: 3, text: 'Let us start with the latter.' },
    { start: 60, end: 64, speaker: 0, text: 'Right. Sayash, same question to you.' },
    { start: 64, end: 80, speaker: 2, text: 'Sure.' },
    { start: 80, end: 84, speaker: 0, text: 'Thanks, Arvind.' },
    { start: 84, end: 90, speaker: 3, text: 'Of course.' },
  ];
  assert.deepEqual(guessNames(segs, ['Derek Thompson', 'Arvind Narayanan', 'Sayash Kapoor']), { 0: 'Derek Thompson', 2: 'Sayash Kapoor', 3: 'Arvind Narayanan' });
});

test('one clear address names a voice nobody else claims, but not a passing one', () => {
  const segs = [
    { start: 0, end: 4, speaker: 0, text: "I'm Derek Thompson." },
    { start: 4, end: 8, speaker: 0, text: 'Arvind, what is the strongest evidence?' },
    { start: 8, end: 120, speaker: 3, text: 'Let us start with the latter.' },
    { start: 120, end: 124, speaker: 0, text: 'Sayash, what do you think?' },
    { start: 124, end: 150, speaker: 2, text: 'Briefly.' },
  ];
  assert.deepEqual(guessNames(segs, ['Derek Thompson', 'Arvind Narayanan', 'Sayash Kapoor']), { 0: 'Derek Thompson', 3: 'Arvind Narayanan' });
});

test('broken window text is recognised, ordinary text is not', async () => {
  const { windowTrouble, speechSeconds } = await import('../../lib/prompted.js');
  assert.deepEqual(windowTrouble('Så jeg synes faktisk, at vores performance har været ganske god.', 4), []);
  assert.ok(windowTrouble('Sæææææææææ', 3).includes('stuck'));
  assert.ok(windowTrouble('Det er der rigtig mange årsager til. Det er der rigtig mange årsager til. Det er der rigtig mange årsager til.', 5).includes('repeats'));
  assert.ok(windowTrouble('i hvert', 25).includes('sparse'));
  assert.deepEqual(windowTrouble('', 2), []);
  const loud = new Float32Array(16000 * 3).map((_, i) => Math.sin(i / 3) * 0.2);
  assert.equal(speechSeconds(loud), 3);
  assert.equal(speechSeconds(new Float32Array(16000)), 0);
});

test('introductions and welcomes in French, German, Spanish and Italian name voices', () => {
  const people = ['Marie Dubois', 'Jonas Weber', 'Lucía Pérez', 'Marco Rossi'];
  const segs = [
    { start: 0, end: 70, speaker: 0, text: 'Bonjour, je suis Marie Dubois et voici le podcast.' },
    { start: 70, end: 140, speaker: 1, text: 'Hallo, ich bin Jonas Weber.' },
    { start: 140, end: 141, speaker: 0, text: 'Bienvenida, Lucía Pérez.' },
    { start: 141, end: 210, speaker: 2, text: 'Gracias por invitarme.' },
    { start: 210, end: 211, speaker: 0, text: 'Benvenuto Marco Rossi.' },
    { start: 211, end: 290, speaker: 3, text: 'Grazie mille.' },
    { start: 290, end: 291, speaker: 0, text: 'Lucía, ¿qué opinas?' },
    { start: 291, end: 300, speaker: 2, text: 'Creo que sí.' },
    { start: 300, end: 301, speaker: 0, text: 'Herzlich willkommen, Marco.' },
    { start: 301, end: 310, speaker: 3, text: 'Danke.' },
  ];
  assert.deepEqual(guessNames(segs, people), { 0: 'Marie Dubois', 1: 'Jonas Weber', 2: 'Lucía Pérez', 3: 'Marco Rossi' });
});

test('clustering with hindsight undoes an early wrong split', () => {
  const v = (a, b, noise) => { const x = new Float32Array(8); x[0] = a; x[1] = b; x[2 + (noise % 6)] = 0.3; return x; };
  // Host (axis 0) and guest (axis 1); a few host prints lean a little towards the guest.
  const items = [
    { print: v(1, 0, 0), seconds: 20 }, { print: v(0, 1, 1), seconds: 25 }, { print: v(1, 0.5, 2), seconds: 6 },
    { print: v(0.1, 1, 3), seconds: 30 }, { print: v(1, 0.1, 4), seconds: 15 }, { print: v(0.6, 0.5, 5), seconds: 1 },
  ];
  const ids = clusterVoices(items);
  assert.equal(ids[0], ids[2]);
  assert.equal(ids[0], ids[4]);
  assert.equal(ids[1], ids[3]);
  assert.notEqual(ids[0], ids[1]);
  assert.equal(ids[1], 0); // the guest talks most
});
