// The shape of an episode: how loud each second is and who speaks when, as the player draws it
// (ui/score.js). It is made from a transcript (on the server, filed beside it as
// <id>.shape.json) or, for a file on the device nobody transcribed, from listening through it
// (loudness only). Small enough to keep and send: a byte a second and a few numbers per turn,
// some kilobytes for an hour.
//
// Stored and sent as { v, total, levels, voices, hues, other, turns }:
//   levels  the loudness of each second, as lib/levels.js encodes it (base64, a byte each)
//   voices  the names of the voices, most heard first
//   hues    each voice's colour (--spk-N), the same one the transcript side gives that speaker
//           (its number modulo 6), so a voice is one colour on the strip and in its transcript
//   other   the index in `voices` of the voices heard only in passing, folded into one, or -1
//   turns   [gap, length, voice, gap, length, voice, ...] in tenths of a second, each gap from
//           the end of the turn before
import { decodeLevels, encodeLevels } from './levels.js';
import { minorVoices, speakerName } from './speakers.js';

export const SHAPE_VERSION = 1;
const HUES = 6; // --spk-0 to --spk-5: voices past these are folded in with the passing ones
const JOIN = 1.5; // seconds: one voice either side of a shorter gap is one turn
const FLOOR = 0.03; // the quiet end of the scale: the episode's 3rd percentile (DESIGN.md)

// segments: [{ start, end, speaker }]; levels: base64 or bytes; names: speaker id -> name, as
// the transcript side has them (guessed, then set by hand).
export function makeShape({ segments = [], levels = '', total = 0 } = {}, names = {}) {
  const lv = typeof levels === 'string' ? levels : encodeLevels(levels);
  const segs = (segments || []).filter((s) => s.speaker != null && s.end > s.start && Number.isFinite(s.start)).sort((a, b) => a.start - b.start);
  const talk = new Map();
  for (const s of segs) talk.set(Number(s.speaker), (talk.get(Number(s.speaker)) || 0) + (s.end - s.start));
  // Passing voices (an ad's, a clip's) the way the transcript side finds them: one "Other voice".
  const minor = minorVoices(segs, names);
  const ranked = [...talk.keys()].filter((k) => !minor.has(k)).sort((a, b) => talk.get(b) - talk.get(a));
  const kept = ranked.slice(0, ranked.length > HUES || minor.size ? HUES - 1 : HUES);
  const voices = kept.map((k) => names[k] || speakerName(k));
  const hues = kept.map((k) => ((k % HUES) + HUES) % HUES);
  const other = kept.length < talk.size ? voices.push('Other voice') - 1 : -1;
  if (other >= 0) hues.push(-1);
  const index = new Map(kept.map((k, i) => [k, i]));
  const turns = [];
  let end = 0;
  let last = null; // [start, end, voice] of the turn being gathered
  const flush = () => {
    if (!last) return;
    const a = Math.max(end, Math.round(last[0] * 10));
    const b = Math.max(a + 1, Math.round(last[1] * 10));
    turns.push(a - end, b - a, last[2]);
    end = b;
  };
  for (const s of segs) {
    const v = index.get(Number(s.speaker)) ?? other;
    if (last && last[2] === v && s.start - last[1] <= JOIN) { last[1] = Math.max(last[1], s.end); continue; }
    flush();
    last = [s.start, s.end, v];
  }
  flush();
  const seconds = Math.max(Number(total) || 0, decodeLevels(lv).length, end / 10);
  return { v: SHAPE_VERSION, total: Math.round(seconds * 10) / 10, levels: lv, voices, hues, other, turns };
}

// Whether a value read back (from the server, from storage) is a shape this code can draw.
export function validShape(x) {
  return !!x && x.v === SHAPE_VERSION && Number.isFinite(x.total) && x.total >= 0 && typeof x.levels === 'string'
    && Array.isArray(x.voices) && x.voices.length <= HUES && x.voices.every((n) => typeof n === 'string')
    && Number.isInteger(x.other) && x.other < x.voices.length
    && (x.hues === undefined || (Array.isArray(x.hues) && x.hues.length === x.voices.length && x.hues.every((n) => Number.isInteger(n) && n >= -1 && n < HUES)))
    && Array.isArray(x.turns) && x.turns.length % 3 === 0 && x.turns.length <= 300000
    && x.turns.every((n, i) => Number.isInteger(n) && n >= 0 && (i % 3 !== 2 || n < x.voices.length));
}

// The stored form, made ready to read: turns as times, loudness as bytes, and a running sum of
// it so the mean over any stretch costs the same however long the stretch.
export function readShape(x) {
  if (!validShape(x)) return null;
  const levels = decodeLevels(x.levels);
  const n = x.turns.length / 3;
  const starts = new Float64Array(n);
  const ends = new Float64Array(n);
  const who = new Int8Array(n);
  let t = 0;
  for (let i = 0; i < n; i++) {
    starts[i] = (t += x.turns[i * 3]) / 10;
    ends[i] = (t += x.turns[i * 3 + 1]) / 10;
    who[i] = x.turns[i * 3 + 2];
  }
  const sum = new Float64Array(levels.length + 1);
  const known = new Float64Array(levels.length + 1);
  for (let i = 0; i < levels.length; i++) {
    sum[i + 1] = sum[i] + levels[i];
    known[i + 1] = known[i] + (levels[i] ? 1 : 0);
  }
  const loud = known[levels.length] > 0;
  // (A shape without hues, as one with loudness only has none to give: in order.)
  const hues = x.hues || x.voices.map((_, i) => (i === x.other ? -1 : i % HUES));
  return { total: x.total, voices: x.voices, hues, other: x.other, levels, starts, ends, who, sum, known, loud, scales: new Map() };
}

export const hasVoices = (shape) => !!shape && shape.voices.length > 0 && shape.starts.length > 0;
export const hasLoudness = (shape) => !!shape?.loud;

// The voice speaking at `t` (an index into shape.voices), or -1. In a pause, the one who spoke
// last, if they did within `hold` seconds.
export function voiceAt(shape, t, { hold = Infinity } = {}) {
  if (!hasVoices(shape)) return -1;
  let lo = 0;
  let hi = shape.starts.length - 1;
  let i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (shape.starts[mid] <= t) { i = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (i < 0) return -1;
  return t < shape.ends[i] || t - shape.ends[i] <= hold ? shape.who[i] : -1;
}

// The loudness summed, and the seconds known, up to `x` seconds in (fractions of a second count
// for their share).
function upTo(shape, arr, x) {
  const n = shape.levels.length;
  if (x <= 0) return 0;
  if (x >= n) return arr[n];
  const i = Math.floor(x);
  return arr[i] + (arr[i + 1] - arr[i]) * (x - i);
}

function mean(shape, a, b) {
  const k = upTo(shape, shape.known, b) - upTo(shape, shape.known, a);
  return k > 0.01 ? (upTo(shape, shape.sum, b) - upTo(shape, shape.sum, a)) / k : -1;
}

// The range a bar of `width` seconds moves in over the whole episode: from the 3rd percentile of
// such bars to the loudest. (Averaged over half a minute, speech is nearly flat: stretched like
// this, it reads.) Kept per width, so the magnifier keeps one scale wherever it is.
function scale(shape, width) {
  const key = Math.round(width * 1000);
  let s = shape.scales.get(key);
  if (s) return s;
  const n = Math.max(1, Math.ceil(shape.levels.length / width));
  const all = [];
  for (let i = 0; i < n; i++) {
    const m = mean(shape, i * width, (i + 1) * width);
    if (m >= 0) all.push(m);
  }
  all.sort((p, q) => p - q);
  s = all.length ? { lo: all[Math.floor((all.length - 1) * FLOOR)], hi: all[all.length - 1] } : { lo: 0, hi: 1 };
  if (shape.scales.size > 8) shape.scales.clear();
  shape.scales.set(key, s);
  return s;
}

// `count` bars from `from` to `to` seconds: each one's height (0 to 1 on the episode's scale, or
// -1 where its loudness is not known) and voice (whoever speaks most of it, or -1 for nobody).
// The same for the whole episode and for three minutes at a bar a second.
export function bars(shape, { from = 0, to = shape?.total || 0, count }) {
  const h = new Float32Array(count).fill(-1);
  const v = new Int8Array(count).fill(-1);
  if (!shape || !(count > 0) || !(to > from)) return { h, v };
  const width = (to - from) / count;
  if (shape.loud) {
    const { lo, hi } = scale(shape, width);
    for (let i = 0; i < count; i++) {
      const m = mean(shape, from + i * width, from + (i + 1) * width);
      if (m >= 0) h[i] = hi > lo ? Math.min(1, Math.max(0, (m - lo) / (hi - lo))) : 1;
    }
  }
  if (hasVoices(shape)) {
    const { starts, ends, who } = shape;
    const heard = new Float64Array(shape.voices.length);
    // The first turn that has not ended by `from`; turns are in order and do not overlap.
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ends[mid] <= from) lo = mid + 1; else hi = mid; }
    for (let i = 0, j = lo; i < count; i++) {
      const a = from + i * width;
      const b = a + width;
      heard.fill(0);
      while (j < starts.length && ends[j] <= a) j++;
      for (let k = j; k < starts.length && starts[k] < b; k++) heard[who[k]] += Math.min(b, ends[k]) - Math.max(a, starts[k]);
      let best = -1;
      for (let k = 0; k < heard.length; k++) if (heard[k] > 0 && (best < 0 || heard[k] > heard[best])) best = k;
      v[i] = best;
    }
  }
  return { h, v };
}

// Loudness per second while a file is decoded piece by piece (pieces need not be whole
// seconds): the same bytes lib/levels.js makes from the whole thing at once.
export class Loudness {
  constructor(rate) {
    this.rate = rate;
    this.out = [];
    this.sum = 0;
    this.n = 0;
  }

  push(samples) {
    for (let i = 0; i < samples.length; i++) {
      this.sum += samples[i] * samples[i];
      if (++this.n === this.rate) this.close();
    }
  }

  close() {
    this.out.push(Math.min(255, Math.max(1, Math.round(Math.sqrt(this.sum / Math.max(1, this.n)) * 1024))));
    this.sum = 0;
    this.n = 0;
  }

  finish() {
    if (this.n) this.close();
    return Uint8Array.from(this.out);
  }
}
