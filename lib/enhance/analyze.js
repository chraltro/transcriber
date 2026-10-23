// Listens to a whole episode once, a block at a time, and works out who the voices are and
// what is wrong with each: where the treble stops (a call or codec cuts it off), how often the
// sound drops out, how much of the time a noise gate leaves dead silence, how loud the
// background is, mains hum. That decides the suggested settings, which stretch to preview
// first, and the noise profile the noise reduction subtracts.
import { RealFFT } from './dsp.js';
import { STFT_SIZE, LoudnessMeter } from './modules.js';
import { RATE, suggest } from './chain.js';

const N = STFT_SIZE;
const HOP = 512;
const F = Math.round(RATE * 0.005); // 5 ms frames
const SILENT = 10 ** (-72 / 20); // a frame peaking under this is a closed gate (digital silence)

export class Analyzer {
  constructor(rate = RATE) {
    if (rate !== RATE) throw new Error(`analysis runs at ${RATE} Hz`);
    this.rate = rate;
    this.rfft = new RealFFT(N);
    this.win = new Float64Array(N);
    for (let i = 0; i < N; i++) this.win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    this.fr = new Float64Array(N);
    this.re = new Float64Array(N / 2 + 1);
    this.im = new Float64Array(N / 2 + 1);
    this.pending = new Float32Array(0);
    this.sec = []; // per second: features
    this.noiseSpec = []; // per second: summed power spectrum of its quiet frames (Float32Array) or null
    this.frameDb = []; // per 5 ms frame: energy dB
    this.frameSilent = [];
    this.fAcc = 0;
    this.fPeak = 0;
    this.fN = 0;
    this.binHz = this.rate / N;
    this.meter = new LoudnessMeter(rate);
  }

  push(x) {
    this.meter.push(x);
    // 5 ms frames run across seconds.
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      this.fAcc += v * v;
      const a = v < 0 ? -v : v;
      if (a > this.fPeak) this.fPeak = a;
      if (++this.fN === F) {
        this.frameDb.push(10 * Math.log10(this.fAcc / F + 1e-14));
        this.frameSilent.push(this.fPeak < SILENT ? 1 : 0);
        this.fAcc = 0;
        this.fPeak = 0;
        this.fN = 0;
      }
    }
    const all = new Float32Array(this.pending.length + x.length);
    all.set(this.pending);
    all.set(x, this.pending.length);
    let s = 0;
    for (; s + this.rate <= all.length; s += this.rate) this.second(all.subarray(s, s + this.rate));
    this.pending = all.slice(s);
  }

  second(x) {
    const { rfft, win, fr, re, im, binHz } = this;
    const bins = N / 2 + 1;
    const frames = [];
    const sum = new Float64Array(bins);
    let loudFrames = 0;
    let ms = 0;
    for (let i = 0; i < x.length; i++) ms += x[i] * x[i];
    const levelDb = 10 * Math.log10(ms / x.length + 1e-14);
    for (let s = 0; s + N <= x.length; s += HOP) {
      let e = 0;
      let peak = 0;
      for (let i = 0; i < N; i++) {
        const v = x[s + i];
        fr[i] = v * win[i];
        e += v * v;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
      rfft.forward(fr, re, im);
      const p = new Float32Array(bins);
      for (let k = 0; k < bins; k++) p[k] = re[k] * re[k] + im[k] * im[k];
      frames.push({ db: 10 * Math.log10(e / N + 1e-14), silent: peak < SILENT, p });
    }
    // Loud frames tell where the treble stops; quiet (but not dead) ones what the background is.
    const live = frames.filter((f) => !f.silent);
    const sorted = live.map((f) => f.db).sort((a, b) => a - b);
    const floorDb = sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : -140;
    const top = sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : -140;
    for (const f of live) if (f.db > top - 15) { loudFrames++; for (let k = 0; k < bins; k++) sum[k] += f.p[k]; }
    // Where the treble stops. For every frequency above 3 kHz: how far the level falls from the
    // 600 Hz under it to the 1.5 kHz over it (spectrum 5-bin median smoothed, so a lone tone
    // doesn't count, and floored 90 dB under its peak, so "nothing" can't fall further than
    // "very little"). The cut-off is the lowest frequency that falls nearly as far as the
    // biggest fall. A call or codec leaves a fall like that; a voice's natural roll-off doesn't.
    // MP3 encoders leave one too, high up (about 16 kHz at 128 kbps): that's a clean voice.
    let cutoffHz = 0;
    let fall = 0;
    if (loudFrames >= 4 && top > -50) {
      const L = new Float64Array(bins);
      const tmp = [0, 0, 0, 0, 0];
      let peak = -Infinity;
      for (let k = 0; k < bins; k++) {
        for (let j = -2; j <= 2; j++) tmp[j + 2] = sum[Math.min(bins - 1, Math.max(0, k + j))];
        tmp.sort((x, y) => x - y);
        L[k] = 10 * Math.log10(tmp[2] + 1e-30);
        if (L[k] > peak) peak = L[k];
      }
      for (let k = 0; k < bins; k++) L[k] = Math.max(L[k], peak - 90);
      const cs = new Float64Array(bins + 1);
      for (let k = 0; k < bins; k++) cs[k + 1] = cs[k] + L[k];
      const mean = (a, b) => (cs[b] - cs[a]) / (b - a);
      const wb = Math.round(600 / binHz);
      const wa = Math.round(1500 / binHz);
      const drops = [];
      let max = 0;
      for (let k = Math.round(3000 / binHz); k + wa < bins; k++) {
        const d = mean(k - wb, k + 1) - mean(k + 1, k + 1 + wa);
        drops.push([k, d]);
        if (d > max) max = d;
      }
      if (max >= 18) {
        const [k] = drops.find(([, d]) => d >= max * 0.8);
        // The edge itself: the last bin before the level is half-way down.
        let e = k;
        const hiLevel = mean(Math.max(0, k - wb), k + 1);
        const loLevel = mean(k + 1, k + 1 + wa);
        while (e + 1 < bins && L[e + 1] > (hiLevel + loLevel) / 2) e++;
        cutoffHz = (e + 0.5) * binHz;
        fall = max;
      } else {
        cutoffHz = -1; // no cut at all
      }
    }
    const hard = cutoffHz > 0;
    // Background: frames well under this second's speech (not dead silence, and not soft
    // speech, which is all a noise gate lets through).
    let noise = null;
    let nq = 0;
    for (const f of live) {
      if (f.db > Math.min(floorDb + 3, top - 30)) continue;
      noise ??= new Float32Array(bins);
      for (let k = 0; k < bins; k++) noise[k] += f.p[k];
      nq++;
    }
    // Hum: 50 and 60 Hz overtones against the gaps between them, on a decimated copy.
    const D = 32;
    const dec = new Float32Array(Math.floor(x.length / D));
    for (let i = 0; i < dec.length; i++) { let s = 0; for (let j = 0; j < D; j++) s += x[i * D + j]; dec[i] = s / D; }
    const dr = this.rate / D;
    const g = (f) => goertzel(dec, f, dr);
    const hum50 = [50, 100, 150, 200].reduce((s, f) => s + g(f), 0);
    const hum60 = [60, 120, 180, 240].reduce((s, f) => s + g(f), 0);
    const gaps = [35, 75, 85, 135, 165, 215, 225, 265].reduce((s, f) => s + g(f), 0) / 2;
    const lowE = band(sum, 0, 70 / binHz);
    const voiceE = band(sum, 100 / binHz, 300 / binHz);
    this.sec.push({
      levelDb, top, floorDb, cutoffHz, hard, fall,
      silentShare: frames.length ? frames.filter((f) => f.silent).length / frames.length : 0,
      hum50: 10 * Math.log10((hum50 + 1e-20) / (gaps + 1e-20)),
      hum60: 10 * Math.log10((hum60 + 1e-20) / (gaps + 1e-20)),
      rumble: loudFrames ? 10 * Math.log10((lowE + 1e-20) / (voiceE + 1e-20)) : -99,
      nq,
    });
    this.noiseSpec.push(noise);
  }

  // speakers: optional [{ start, end, speaker }] from the transcript, names: speaker -> name.
  finish({ speakers = null, names = {} } = {}) {
    if (this.pending.length > this.rate * 0.25) {
      const last = new Float32Array(this.rate);
      last.set(this.pending);
      this.second(last);
    }
    this.pending = new Float32Array(0);
    const secs = this.sec;
    const total = secs.length;
    const speechTop = percentile(secs.map((s) => s.top).filter((v) => v > -80), 0.5);
    const talking = secs.map((s) => s.top > Math.max(-55, speechTop - 20));
    const dropouts = countDropouts(this.frameDb, this.frameSilent, total);

    // Who is talking each second.
    let labels;
    let voices;
    let by = 'sound';
    if (speakers?.length) {
      ({ labels, voices } = bySpeaker(speakers, names, total, talking));
      by = 'speaker';
    }
    if (!labels || voices.length < 2) {
      const found = bySound(secs, talking);
      if (!labels || found.voices.length > 1) { ({ labels, voices } = found); by = 'sound'; }
    }
    const timeline = toTimeline(labels, this.frameDb);

    // Per voice: stats, a noise profile, suggested settings.
    const profiles = {};
    for (const [vi, v] of voices.entries()) {
      const mine = [];
      for (let t = 0; t < total; t++) if (labels[t] === vi) mine.push(t);
      const speech = mine.filter((t) => talking[t]);
      const cut = speech.map((t) => secs[t].cutoffHz).filter((c) => c > 0);
      const cutoffHz = cut.length ? percentile(cut, 0.5) : 0;
      const hardShare = speech.length ? speech.filter((t) => secs[t].hard).length / speech.length : 0;
      const mean = (f) => (speech.length ? speech.reduce((s, t) => s + f(secs[t]), 0) / speech.length : 0);
      const drops = speech.reduce((s, t) => s + dropouts[t], 0);
      const hum50 = mean((s) => s.hum50);
      const hum60 = mean((s) => s.hum60);
      const psd = new Float64Array(N / 2 + 1);
      let nq = 0;
      for (const t of mine) {
        const spec = this.noiseSpec[t];
        if (!spec) continue;
        for (let k = 0; k < psd.length; k++) psd[k] += spec[k];
        nq += secs[t].nq;
      }
      if (nq) for (let k = 0; k < psd.length; k++) psd[k] /= nq;
      const noisy = nq >= 200; // about two seconds of background, else no profile
      const floors = mine.map((t) => secs[t].floorDb).filter((d) => d > -130);
      Object.assign(v, {
        seconds: mine.length,
        speechSeconds: speech.length,
        cutoffHz: cutoffHz < this.rate * 0.45 && hardShare > 0.3 ? Math.round(cutoffHz / 100) * 100 : 0,
        bandHz: Math.round(cutoffHz / 100) * 100,
        gatedShare: mean((s) => s.silentShare),
        dropouts: drops,
        dropoutsPerMin: speech.length ? (drops * 60) / speech.length : 0,
        // The background: the floor of its quietest seconds (pauses), not of quiet speech.
        noiseDb: floors.length ? percentile(floors, 0.1) : -140,
        humHz: Math.max(hum50, hum60) > 8 ? (hum60 > hum50 ? 60 : 50) : 0,
        rumble: mean((s) => s.rumble) > -12,
        level: mean((s) => s.top),
      });
      v.suggested = suggest(v);
      profiles[v.id] = { noisePsd: noisy ? psd : null, cutoffHz: v.cutoffHz || null, humHz: v.humHz || null };
    }

    // Seconds that sound worst, per voice: where to listen first.
    const badness = secs.map((s, t) => {
      if (!talking[t]) return 0;
      const v = voices[labels[t]];
      return dropouts[t] * 3 + s.silentShare * 8 + (v?.cutoffHz ? 1 : 0) + Math.max(0, (s.floorDb + 60) / 10);
    });
    for (const [vi, v] of voices.entries()) v.worst = worstWindow(badness, labels, vi, talking);

    return {
      rate: this.rate,
      duration: total,
      lufs: this.meter.integrated(),
      by,
      voices,
      timeline,
      profiles,
      levels: secs.map((s) => Math.max(0, Math.min(255, Math.round((s.levelDb + 70) * 4)))),
      labels,
      dropouts,
    };
  }
}

function goertzel(x, f, rate) {
  const w = (2 * Math.PI * f) / rate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s = x[i] + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

function band(p, a, b) {
  let s = 0;
  for (let k = Math.max(1, Math.round(a)); k < Math.round(b); k++) s += p[k];
  return s;
}

function percentile(values, q) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

// Holes as the dropout repair finds them: 10-150 ms of near silence with speech on both sides.
function countDropouts(db, silent, seconds) {
  const per = new Uint16Array(seconds);
  const perSec = RATE / F;
  let i = 0;
  while (i < db.length) {
    if (db[i] >= -65) { i++; continue; }
    let j = i;
    while (j < db.length && db[j] < -65) j++;
    const n = j - i;
    if (n >= 2 && n <= 30 && i >= 6 && j + 6 <= db.length) {
      let before = -200;
      let after = -200;
      for (let k = 1; k <= 6; k++) { before = Math.max(before, db[i - k]); after = Math.max(after, db[j + k - 1]); }
      if (before > -45 && after > -45) {
        const t = Math.floor(i / perSec);
        if (t < seconds) per[t]++;
      }
    }
    i = j;
  }
  void silent;
  return per;
}

const LETTERS = 'ABCDEFGH';

// Voices from the transcript's speakers. Seconds nobody talks in go to whoever talked last.
function bySpeaker(segments, names, total, talking) {
  const time = new Map();
  const per = Array.from({ length: total }, () => new Map());
  for (const s of segments) {
    if (s.speaker == null || s.speaker === '') continue;
    const sp = String(s.speaker);
    for (let t = Math.floor(s.start); t < Math.min(total, Math.ceil(s.end)); t++) {
      const ov = Math.min(s.end, t + 1) - Math.max(s.start, t);
      if (ov <= 0) continue;
      per[t].set(sp, (per[t].get(sp) || 0) + ov);
      time.set(sp, (time.get(sp) || 0) + ov);
    }
  }
  // Voices with at least 20 s (or 3 % of the talk) of their own; the rest are folded in.
  const totalTalk = [...time.values()].reduce((a, b) => a + b, 0);
  const keep = [...time.entries()].filter(([, s]) => s >= 20 && s >= totalTalk * 0.03).sort((a, b) => b[1] - a[1]).map(([sp]) => sp);
  if (!keep.length) return { labels: null, voices: [] };
  const voices = keep.map((sp, i) => ({ id: `s${sp}`, name: names[sp] || `Voice ${LETTERS[i] || i + 1}`, speaker: sp }));
  const labels = new Int16Array(total).fill(-1);
  for (let t = 0; t < total; t++) {
    let best = -1;
    let bestS = 0;
    for (const [sp, s] of per[t]) {
      const vi = keep.indexOf(sp);
      if (vi >= 0 && s > bestS) { best = vi; bestS = s; }
    }
    labels[t] = best;
  }
  fillGaps(labels);
  void talking;
  return { labels: Array.from(labels), voices };
}

// Voices from the sound itself: seconds grouped by where their treble stops.
function bySound(secs, talking) {
  const total = secs.length;
  const cut = secs.map((s, t) => (talking[t] && s.cutoffHz ? (s.cutoffHz < 0 ? RATE / 2 : s.cutoffHz) : 0));
  const values = cut.filter(Boolean).sort((a, b) => a - b);
  // Clusters of cut-offs within 800 Hz of each other.
  const groups = [];
  for (const v of values) {
    const g = groups[groups.length - 1];
    if (g && v - g.hi <= 800) { g.hi = v; g.n++; g.sum += v; } else groups.push({ lo: v, hi: v, n: 1, sum: v });
  }
  const speech = values.length;
  const big = groups.filter((g) => g.n >= 30 && g.n >= speech * 0.05).sort((a, b) => b.n - a.n).slice(0, 4);
  if (big.length < 2) {
    return { labels: new Array(total).fill(0), voices: [{ id: 'all', name: 'Everyone', band: values.length ? percentile(values, 0.5) : 0 }] };
  }
  // Ordered by cut-off: the fullest sound first.
  big.sort((a, b) => b.sum / b.n - a.sum / a.n);
  const centre = big.map((g) => g.sum / g.n);
  const labels = new Int16Array(total).fill(-1);
  for (let t = 0; t < total; t++) {
    if (!cut[t]) continue;
    let best = 0;
    for (let i = 1; i < centre.length; i++) if (Math.abs(cut[t] - centre[i]) < Math.abs(cut[t] - centre[best])) best = i;
    labels[t] = best;
  }
  // Steady over a few seconds: a voice doesn't change every second.
  const smooth = Int16Array.from(labels);
  for (let t = 0; t < total; t++) {
    if (labels[t] < 0) continue;
    const count = new Map();
    for (let k = Math.max(0, t - 3); k <= Math.min(total - 1, t + 3); k++) if (labels[k] >= 0) count.set(labels[k], (count.get(labels[k]) || 0) + 1);
    smooth[t] = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  fillGaps(smooth);
  const voices = big.map((g, i) => ({ id: `b${i}`, name: `Voice ${LETTERS[i]}`, band: Math.round(g.sum / g.n / 100) * 100 }));
  return { labels: Array.from(smooth), voices };
}

// Seconds with no voice get the previous one's (or the next one's, at the start).
function fillGaps(labels) {
  let last = -1;
  for (let t = 0; t < labels.length; t++) {
    if (labels[t] < 0) labels[t] = last; else last = labels[t];
  }
  let next = -1;
  for (let t = labels.length - 1; t >= 0; t--) {
    if (labels[t] < 0) labels[t] = next; else next = labels[t];
  }
  for (let t = 0; t < labels.length; t++) if (labels[t] < 0) labels[t] = 0;
}

// Runs of one voice, with each change moved to the quietest moment within half a second, so a
// crossfade never lands in the middle of a word.
function toTimeline(labels, frameDb) {
  const out = [];
  const perSec = RATE / F;
  let start = 0;
  for (let t = 1; t <= labels.length; t++) {
    if (t < labels.length && labels[t] === labels[t - 1]) continue;
    let end = t;
    if (t < labels.length) {
      const a = Math.max(0, Math.floor((t - 0.5) * perSec));
      const b = Math.min(frameDb.length - 1, Math.floor((t + 0.5) * perSec));
      let best = Math.floor(t * perSec);
      for (let f = a; f <= b; f++) if (frameDb[f] < frameDb[best]) best = f;
      end = (best + 0.5) / perSec;
    }
    if (end > start) out.push({ start, end, voice: labels[t - 1] });
    start = end;
  }
  return out;
}

// The 20 s that need the most help, in this voice's own talking time.
function worstWindow(badness, labels, vi, talking, len = 20) {
  let best = null;
  let bestScore = -1;
  for (let t = 0; t + len <= badness.length; t += 2) {
    let score = 0;
    let mine = 0;
    for (let k = t; k < t + len; k++) {
      if (labels[k] !== vi) continue;
      mine++;
      if (talking[k]) score += badness[k];
    }
    if (mine < len * 0.7) continue;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  if (best == null) {
    const first = labels.indexOf(vi);
    best = Math.max(0, first);
  }
  return { start: best, end: Math.min(badness.length, best + len) };
}
