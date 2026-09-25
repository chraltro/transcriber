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
