import { test } from 'node:test';
import assert from 'node:assert/strict';
import { framesToTurns, Voices, labelParts, guessNames, speakerName, cosine, sentenceParts, hostFromShow, assignLocals, retimeParts, REPLY, minorVoices } from '../../lib/speakers.js';
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

test('the host comes from the show name, and is whoever welcomes the guest', () => {
  assert.equal(hostFromShow('The Ezra Klein Show'), 'Ezra Klein');
  assert.equal(hostFromShow('Plain English with Derek Thompson'), 'Derek Thompson');
  assert.equal(hostFromShow('The Joe Rogan Experience'), 'Joe Rogan');
  assert.equal(hostFromShow('Lex Fridman Podcast'), 'Lex Fridman');
  assert.equal(hostFromShow('The Daily'), null);
  assert.equal(hostFromShow('Hard Fork'), null);
  const segs = [
    { start: 0, end: 50, speaker: 1, text: 'So really quite a call to arms. Bill Gates, welcome to the show.' },
    { start: 50, end: 120, speaker: 0, text: 'Great to be here. Mostly what we are working on is the computer being a tool.' },
    { start: 120, end: 140, speaker: 1, text: 'What changed your mind?' },
    { start: 140, end: 220, speaker: 0, text: 'The pace of the models.' },
  ];
  assert.deepEqual(guessNames(segs, ['Bill Gates'], { host: 'Ezra Klein' }), { 0: 'Bill Gates', 1: 'Ezra Klein' });
});

test('a question at the end of a turn stays with the person asking it', () => {
  // Ezra (voice 1) asks until 10.6 s, Gates (voice 0) answers. The question's estimated time
  // spills a little into the answer.
  const parts = [
    { start: 0, end: 8, text: 'This is the role of individual CEOs.' },
    { start: 8, end: 10, text: 'How do you see that question?' },
    { start: 10, end: 30, text: "Well, there's never been a product that's less understood than AI." },
  ];
  const turns = [{ spk: 0, start: 0, end: 9.2 }, { spk: 1, start: 9.4, end: 30 }];
  const out = labelParts(parts, turns, { 0: 1, 1: 0 });
  assert.deepEqual(out.map((p) => p.speaker), [1, 1, 0]);
});

test('a short real reply between two turns is kept', () => {
  const parts = [
    { start: 0, end: 6, text: "Yeah, we don't want them to think, do we?" },
    { start: 6, end: 8.5, text: "Not really, I don't think. It's a scary thought." },
    { start: 8.5, end: 20, text: 'So that was 30 years ago. Narrate for me how we got here.' },
  ];
  const turns = [{ spk: 0, start: 0, end: 6 }, { spk: 1, start: 6.1, end: 8.4 }, { spk: 3, start: 8.6, end: 20 }];
  assert.deepEqual(labelParts(parts, turns, { 0: 2, 1: 0, 3: 1 }).map((p) => p.speaker), [2, 0, 1]);
});

test('one sentence does not flip speaker against the evidence around it', () => {
  const parts = [
    { start: 0, end: 10, text: 'A long answer about thresholds.' },
    { start: 10, end: 10.6, text: 'And so.' },
    { start: 10.6, end: 20, text: 'The cyber capability was stunning.' },
  ];
  const turns = [{ spk: 0, start: 0, end: 10.1 }, { spk: 1, start: 10.1, end: 10.5 }, { spk: 0, start: 10.5, end: 20 }];
  assert.deepEqual(labelParts(parts, turns, { 0: 0, 1: 1 }).map((p) => p.speaker), [0, 0, 0]);
});

test('a short snippet joins a voice already heard, never its own piece-mate', () => {
  const v = (a, b) => { const x = new Float32Array(4); x[0] = a; x[1] = b; return x; };
  const voices = new Voices();
  voices.match(v(1, 0), 20); // voice 0: Gates
  voices.match(v(0, 1), 20); // voice 1: Ezra
  // Piece 0 (locals 0..2): Gates talks 9 s, Ezra 0.8 s with a shaky print that leans to Gates.
  const local = assignLocals(voices, { 0: { print: v(1, 0.1), seconds: 9 }, 1: { print: v(0.7, 0.6), seconds: 0.8 } });
  assert.deepEqual(local, { 0: 0, 1: 1 });
  // A short snippet never starts a new voice.
  const fresh = new Voices();
  assert.equal(assignLocals(fresh, { 3: { print: v(1, 0), seconds: 1 } })[3], null);
});

test('sentence times skip the pause at a change of speaker', () => {
  const parts = sentenceParts([{ start: 0, end: 20, text: 'This is the role of individual CEOs here. Well, never was a product less understood.' }]);
  // By length alone the first sentence runs to about 10 s, well into the answer.
  assert.ok(parts[0].end > 9);
  // The first speaker talks 0 to 5 s, a pause, then the answer from 15 s.
  const turns = [{ spk: 0, start: 0, end: 5 }, { spk: 1, start: 15, end: 20 }];
  const timed = retimeParts(parts, turns);
  assert.ok(Math.abs(timed[0].end - 5) < 0.6, JSON.stringify(timed));
  assert.equal(labelParts(parts, turns, { 0: 1, 1: 0 }).map((p) => p.speaker).join(), '1,0');
});

test("a sentence's own voice print outweighs a segmentation that missed the change", () => {
  const v = (a, b) => { const x = new Float32Array(4); x[0] = a; x[1] = b; return x; };
  const voices = new Voices();
  voices.match(v(1, 0), 40); // 0: Gates
  voices.match(v(0, 1), 40); // 1: Ezra
  const parts = [
    { start: 0, end: 2.1, text: 'How do you see that question?' },
    { start: 2.1, end: 8.5, text: "Well, there's never been a product that's less understood." },
  ];
  // The segmentation heard one speaker throughout.
  const turns = [{ spk: 1, start: 0.9, end: 8.5 }];
  assert.deepEqual(labelParts(parts, turns, { 1: 0 }, 1).map((p) => p.speaker), [0, 0]);
  const spanPrints = [v(0.1, 1), v(1, 0.05)];
  assert.deepEqual(labelParts(parts, turns, { 1: 0 }, 1, { voices, spanPrints }).map((p) => p.speaker), [1, 0]);
  // A voice heard only briefly (an ad, a clip) is too rough to compare with.
  const few = new Voices();
  few.match(v(1, 0), 40);
  few.match(v(0, 1), 5);
  assert.deepEqual(labelParts(parts, turns, { 1: 0 }, 1, { voices: few, spanPrints }).map((p) => p.speaker), [0, 0]);
  // An unclear print (as close to both) changes nothing.
  assert.deepEqual(labelParts(parts, turns, { 1: 0 }, 1, { voices, spanPrints: [v(1, 1), null] }).map((p) => p.speaker), [0, 0]);
});

test('organisations are never speaker names', () => {
  const segs = [
    { start: 0, end: 70, speaker: 0, text: 'Our work at the Gates Foundation, the Gates Foundation, matters.' },
    { start: 70, end: 140, speaker: 1, text: 'So, Gates Foundation, welcome.' },
  ];
  const names = guessNames(segs, ['Gates Foundation', 'York Times']);
  assert.ok(!Object.values(names).includes('Gates Foundation'), JSON.stringify(names));
});

test('a short reply inside another turn goes to whoever its voice says', () => {
  const v = (a, b) => { const x = new Float32Array(4); x[0] = a; x[1] = b; return x; };
  const voices = new Voices();
  voices.match(v(1, 0), 40); // 0: host
  voices.match(v(0, 1), 40); // 1: guest
  const parts = [
    { start: 0, end: 6, text: 'So we used to think the valley between critics and bands was wide.' },
    { start: 6, end: 6.6, text: 'Hmm.' },
    { start: 6.6, end: 14, text: 'And now it has shrunk to nothing at all.' },
  ];
  const turns = [{ spk: 0, start: 0, end: 14 }];
  // A weak lean towards the guest is enough for a reply ...
  const out = labelParts(parts, turns, { 0: 0 }, 0, { voices, spanPrints: [null, v(0.6, 0.8), null] });
  assert.deepEqual(out.map((p) => p.speaker), [0, 1, 0]);
  // ... but not for an ordinary sentence of the same length.
  const plain = [parts[0], { ...parts[1], text: 'And then.' }, parts[2]];
  assert.deepEqual(labelParts(plain, turns, { 0: 0 }, 0, { voices, spanPrints: [null, v(0.6, 0.8), null] }).map((p) => p.speaker), [0, 0, 0]);
  assert.ok(REPLY.test('Great to see you.') && REPLY.test('Yeah, yeah.') && REPLY.test('Thanks for having me.') && !REPLY.test('Yeah, so the point is this.'));
});

test('voices heard only in passing become "other voices", named ones never do', () => {
  const segs = [
    { start: 0, end: 300, speaker: 0, text: 'a' }, { start: 300, end: 500, speaker: 1, text: 'b' },
    { start: 500, end: 505, speaker: 2, text: 'ad' }, { start: 505, end: 512, speaker: 3, text: 'clip' },
  ];
  assert.deepEqual([...minorVoices(segs)].sort(), [2, 3]);
  assert.deepEqual([...minorVoices(segs, { 3: 'Bill Gates' })], [2]);
  // Too little talk yet to tell a minor voice from a host who hasn't spoken much.
  assert.equal(minorVoices(segs.map((x) => ({ ...x, end: x.start + 5 }))).size, 0);
});
