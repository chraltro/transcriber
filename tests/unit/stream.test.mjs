import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamingTranscriber } from '../../lib/stream.js';
import { SAMPLE_RATE } from '../../lib/segment.js';

const speech = (secs) => {
  const a = new Float32Array(Math.round(secs * SAMPLE_RATE));
  for (let i = 0; i < a.length; i++) a[i] = (i / SAMPLE_RATE) % 10 > 9 ? 0 : 0.3 * Math.sin(i * 0.1);
  return a;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

function harness({ delay = 0, text = (a) => `len ${a.length}` } = {}) {
  const posted = [];
  const calls = [];
  const s = new StreamingTranscriber({
    post: (m) => posted.push(m),
    transcribe: async (samples, language) => { calls.push({ n: samples.length, language }); if (delay) await new Promise((r) => setTimeout(r, delay)); return text(samples); },
    now: () => 0,
  });
  return { s, posted, calls, segments: (id) => posted.filter((m) => m.type === 'segment' && m.id === id) };
}

test('pieces become contiguous segments covering all audio, then done', async () => {
  const { s, posted, segments } = harness();
  s.start(1, { language: 'norwegian' });
  await s.ready(1);
  for (let k = 0; k < 4; k++) await s.push(1, speech(60));
  await s.push(1, new Float32Array(0), true);
  const segs = segments(1);
  assert.equal(segs[0].start, 0);
  for (let k = 1; k < segs.length; k++) assert.equal(segs[k].start, segs[k - 1].end);
  assert.ok(Math.abs(segs.at(-1).end - 240) < 1e-6);
  assert.deepEqual(posted.at(-1), { type: 'done', id: 1 });
});

test('audio that arrives before the model is ready is kept', async () => {
  const { s, segments } = harness();
  s.start(1, { language: 'english' });
  await s.push(1, speech(90));
  assert.equal(segments(1).length, 0);
  await s.ready(1);
  assert.ok(segments(1).length >= 2);
});

test('resume offset carries into segment times', async () => {
  const { s, segments } = harness();
  s.start(1, { language: 'english', offsetSec: 600 });
  await s.ready(1);
  await s.push(1, speech(40), true);
  assert.equal(segments(1)[0].start, 600);
  assert.ok(Math.abs(segments(1).at(-1).end - 640) < 1e-6);
});

test('silence is skipped without calling the model', async () => {
  const { s, calls, segments } = harness();
  s.start(1, { language: 'english' });
  await s.ready(1);
  await s.push(1, new Float32Array(40 * SAMPLE_RATE), true);
  assert.equal(calls.length, 0);
  assert.ok(segments(1).every((m) => m.text === ''));
});

test('hallucinated credits and repeats are cleaned', async () => {
  const { s, segments } = harness({ text: () => 'Teksting av Nicolai Winther' });
  s.start(1, { language: 'norwegian' });
  await s.ready(1);
  await s.push(1, speech(20), true);
  assert.equal(segments(1)[0].text, '');
});

test('a replaced job never touches the new job (review finding #2)', async () => {
  const { s, posted, segments } = harness({ delay: 20 });
  s.start(1, { language: 'english' });
  await s.ready(1);
  const old = s.push(1, speech(120));      // job 1 is mid-transcription
  await tick();
  s.start(2, { language: 'danish' });      // a new episode starts in the same worker
  await s.ready(2);
  await s.push(2, speech(40), true);
  await old;
  await s.push(1, speech(30), true);        // late audio for the old job is ignored
  const two = segments(2);
  assert.equal(two[0].start, 0);
  assert.ok(Math.abs(two.at(-1).end - 40) < 1e-6);
  for (let k = 1; k < two.length; k++) assert.equal(two[k].start, two[k - 1].end);
  assert.ok(!posted.some((m) => m.type === 'done' && m.id === 1));
  assert.ok(posted.some((m) => m.type === 'done' && m.id === 2));
});

test('language is passed through to the model', async () => {
  const { s, calls } = harness();
  s.start(7, { language: 'danish' });
  await s.ready(7);
  await s.push(7, speech(20), true);
  assert.ok(calls.every((c) => c.language === 'danish'));
});

test('cancel stops a job', async () => {
  const { s, posted } = harness({ delay: 5 });
  s.start(1, { language: 'english' });
  await s.ready(1);
  const p = s.push(1, speech(90));
  s.cancel(1);
  await p;
  await s.push(1, new Float32Array(0), true);
  assert.ok(!posted.some((m) => m.type === 'done'));
});

test('speaker-only pass: windows cut as when transcribing, turns in episode time', async () => {
  const { StreamingTranscriber } = await import('../../lib/stream.js');
  const msgs = [];
  let transcribed = 0;
  const st = new StreamingTranscriber({
    post: (m) => msgs.push(m),
    transcribe: async () => { transcribed++; return 'x'; },
    diarize: async (samples) => ({ turns: [{ spk: 0, start: 0, end: samples.length / 16000 }], prints: { 0: { print: [1, 0, 0], seconds: 5 } } }),
    now: () => 0,
  });
  const audio = new Float32Array(16000 * 50).map((_, i) => Math.sin(i / 5) * 0.1);
  st.start(1, { diarizeOnly: true, offsetSec: 100 });
  await st.push(1, audio, true);
  await st.ready(1);
  const segs = msgs.filter((m) => m.type === 'segment');
  assert.equal(transcribed, 0);
  assert.ok(segs.length >= 2);
  assert.equal(segs[0].speakers.turns[0].start, 100);
  assert.equal(segs[1].speakers.turns[0].start, segs[1].start);
  assert.deepEqual(segs[0].speakers.local, { 0: 0 });
  assert.ok(msgs.some((m) => m.type === 'done'));
});

test('a window in another language is marked (English-only model) or transcribed in its language', async () => {
  for (const mode of ['mark', 'transcribe']) {
    const posted = [];
    const calls = [];
    let n = 0;
    const s = new StreamingTranscriber({
      post: (m) => posted.push(m),
      transcribe: async (samples, language, { previous }) => { calls.push({ language, previous }); return `words in ${language}`; },
      // The second window is Norwegian.
      detect: async () => (n++ === 1 ? { no: 0.94, en: 0.01, da: 0.05 } : { en: 0.97, de: 0.03 }),
      now: () => 0,
    });
    s.start(1, { language: 'english', detectLanguage: mode });
    await s.ready(1);
    for (let k = 0; k < 3; k++) await s.push(1, speech(30));
    await s.push(1, new Float32Array(0), true);
    const texts = posted.filter((m) => m.type === 'segment').map((m) => m.text);
    if (mode === 'mark') {
      assert.equal(texts[1], '[Speech in Norwegian]');
      assert.ok(!calls.some((c) => c.language !== 'english'));
    } else {
      assert.equal(texts[1], 'words in no');
      assert.equal(calls[1].previous, ''); // no English context for the Norwegian window
      assert.equal(calls[2].previous, 'words in english'); // and no Norwegian context after it
    }
    assert.equal(texts[0], 'words in english');
  }
});

test('without a language check, or when it fails, windows transcribe as before', async () => {
  const posted = [];
  const s = new StreamingTranscriber({
    post: (m) => posted.push(m),
    transcribe: async (samples, language) => `words in ${language}`,
    detect: async () => { throw new Error('model missing'); },
    now: () => 0,
  });
  s.start(1, { language: 'english', detectLanguage: 'mark' });
  await s.ready(1);
  await s.push(1, speech(30), true);
  assert.equal(posted.find((m) => m.type === 'segment').text, 'words in english');
});
