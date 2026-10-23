import test from 'node:test';
import assert from 'node:assert/strict';
import { Analyzer } from '../../lib/enhance/analyze.js';
import { Biquad, Rand } from '../../lib/enhance/dsp.js';
import { RATE } from '../../lib/enhance/chain.js';

const R = RATE;

// Noise-excited "speech" in syllables, band-limited by a steep low-pass at `cut`.
function talker(seconds, cut, { seed = 1, level = 0.15, gate = false } = {}) {
  const rnd = new Rand(seed);
  const n = Math.round(seconds * R);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = rnd.gauss();
  // A voice-like tilt, then the cut.
  new Biquad('lowpass', R, 1200, 0.5).run(x);
  // 16th-order Butterworth: eight sections with their own Qs (-3 dB at `cut`, then a cliff).
  for (let k = 1; k <= 8; k++) new Biquad('lowpass', R, cut, 1 / (2 * Math.sin(((2 * k - 1) * Math.PI) / 32))).run(x);
  for (let i = 0; i < n; i++) {
    const t = i / R;
    const syl = Math.max(0, Math.sin(2 * Math.PI * 2.3 * t)) ** 0.6;
    x[i] *= level * 3 * syl;
    // A noise gate shuts completely between syllables; an open mic keeps a little room.
    if (gate && syl < 0.15) x[i] = 0;
    else if (!gate) x[i] += 0.0006 * rnd.gauss();
  }
  return x;
}

function episode() {
  const a1 = talker(40, 16000, { seed: 1 });
  const b = talker(40, 4000, { seed: 2, gate: true });
  const a2 = talker(20, 16000, { seed: 3 });
  // Twenty dropouts of 40 ms in the gated voice, in the middle of syllables.
  for (let k = 0; k < 20; k++) {
    const t = (4 + 4 * k + 0.25) / 2.3 - 0.02; // at a syllable's peak
    const s = Math.round(t * R);
    b.fill(0, s, s + Math.round(0.04 * R));
  }
  const x = new Float32Array(a1.length + b.length + a2.length);
  x.set(a1);
  x.set(b, a1.length);
  x.set(a2, a1.length + b.length);
  return x;
}

function analyse(x, opts) {
  const a = new Analyzer();
  for (let i = 0; i < x.length; i += 30000) a.push(x.subarray(i, i + 30000));
  return a.finish(opts);
}

test('the analysis tells a full-band voice from a cut-off, gated one by the sound alone', () => {
  const r = analyse(episode());
  assert.equal(r.by, 'sound');
  assert.equal(r.voices.length, 2, `two voices (${r.voices.map((v) => v.name).join(', ')})`);
  const [full, cut] = r.voices;
  assert.ok(!full.cutoffHz || full.cutoffHz > 14000, `full voice: cut-off ${full.cutoffHz}`);
  assert.ok(Math.abs(cut.cutoffHz - 4000) < 700, `cut voice: cut-off ${cut.cutoffHz}`);
  assert.ok(cut.dropouts >= 15, `dropouts found (${cut.dropouts})`);
  assert.ok(full.dropouts <= 2, `none in the clean voice (${full.dropouts})`);
  assert.ok(cut.gatedShare > 0.1 && full.gatedShare < 0.02, `gate: ${cut.gatedShare.toFixed(2)} / ${full.gatedShare.toFixed(2)}`);
  const at = (t) => r.timeline.find((s) => s.start <= t && s.end > t).voice;
  assert.equal(at(20), 0);
  assert.equal(at(60), 1);
  assert.equal(at(90), 0);
  const change = r.timeline.find((s) => s.voice === 1);
  assert.ok(Math.abs(change.start - 40) <= 3 && Math.abs(change.end - 80) <= 3, `changes at ${change.start.toFixed(1)} and ${change.end.toFixed(1)}`);
  // Suggestions follow from that.
  const on = (v) => Object.entries(v.suggested.modules).filter(([, m]) => m.on).map(([k]) => k);
  assert.ok(on(cut).includes('dropouts') && on(cut).includes('highs'), `cut voice gets repair (${on(cut)})`);
  assert.ok(!on(full).includes('dropouts') && !on(full).includes('highs'), `clean voice is left alone (${on(full)})`);
  // The worst stretch of the cut voice is inside its own time.
  assert.ok(cut.worst.start >= 38 && cut.worst.end <= 82, `worst stretch ${cut.worst.start}-${cut.worst.end}`);
});

test('with a transcript, the voices are its speakers, named', () => {
  const x = episode();
  const speakers = [];
  for (let t = 0; t < 40; t += 5) speakers.push({ start: t, end: t + 5, speaker: 0 });
  for (let t = 40; t < 80; t += 5) speakers.push({ start: t, end: t + 5, speaker: 1 });
  for (let t = 80; t < 100; t += 5) speakers.push({ start: t, end: t + 5, speaker: 0 });
  const r = analyse(x, { speakers, names: { 0: 'Dan Pfeiffer', 1: 'Amy Walter' } });
  assert.equal(r.by, 'speaker');
  assert.deepEqual(r.voices.map((v) => v.name), ['Dan Pfeiffer', 'Amy Walter']);
  const amy = r.voices[1];
  assert.ok(Math.abs(amy.cutoffHz - 4000) < 700, `Amy's cut-off ${amy.cutoffHz}`);
  assert.ok(r.profiles[amy.id] && r.profiles[amy.id].cutoffHz, 'a profile for the chain');
});

test('one voice when there is only one', () => {
  const r = analyse(talker(30, 16000));
  assert.equal(r.voices.length, 1);
  assert.equal(r.timeline.length, 1);
});
