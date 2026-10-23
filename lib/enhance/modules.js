// The clean-up modules. Each is a streaming processor: process(block) returns a block of the
// same length, `latency` samples late, and keeps its state for the next block. The page's
// previews and the full export run the exact same code, so what you hear is what you get.
import { Stft, Biquad, RealFFT, Rand, dbToGain, gainToDb, clamp } from './dsp.js';

export const STFT_SIZE = 1024;
export const STFT_HOP = 256;

/* ---------- lookahead buffering ---------- */

// For modules that need to see ahead before they can decide (a click, a hole in the speech).
// The stream is the input with `ahead` zeros in front; work(from, to) may read and change
// this.buf around [from, to) (stream positions, see at()) as far as `behind` back and up to
// the end of what has arrived. Samples are released `ahead` after they arrive.
class Lookahead {
  constructor(ahead, behind) {
    this.ahead = Math.ceil(ahead);
    this.behind = Math.ceil(behind);
    this.latency = this.ahead;
    this.buf = new Float32Array(this.ahead + 4096);
    this.start = 0; // stream position of buf[0]
    this.len = this.ahead; // stream length so far (the leading zeros count)
    this.done = 0; // stream position up to which work() has run
    this.released = 0;
  }

  // Index into this.buf for stream position p.
  at(p) { return p - this.start; }

  process(x) {
    const need = this.len - this.start + x.length;
    if (need > this.buf.length) {
      // Drop what is no longer needed, then grow if that is not enough.
      const keep = Math.max(this.start, Math.min(this.released, this.done) - this.behind - 1024);
      if (keep > this.start) {
        this.buf.copyWithin(0, keep - this.start, this.len - this.start);
        this.start = keep;
      }
      const need2 = this.len - this.start + x.length;
      if (need2 > this.buf.length) {
        const grown = new Float32Array(Math.max(need2, this.buf.length * 2));
        grown.set(this.buf.subarray(0, this.len - this.start));
        this.buf = grown;
      }
    }
    this.buf.set(x, this.len - this.start);
    this.len += x.length;
    const to = this.len - this.ahead;
    if (to > this.done) {
      this.work(this.done, to);
      this.done = to;
    }
    const y = this.buf.slice(this.at(this.released), this.at(this.released + x.length));
    this.released += x.length;
    return y;
  }

  work() {}
}

/* ---------- time-domain repair ---------- */

export class HighPass {
  constructor({ freq = 80 }, { rate }) {
    this.latency = 0;
    this.f = [new Biquad('highpass', rate, freq, 0.5412), new Biquad('highpass', rate, freq, 1.3066)];
  }
  process(x) { const y = x.slice(); for (const f of this.f) f.run(y); return y; }
}

// Narrow cuts at the mains frequency and its harmonics.
export class DeHum {
  constructor({ base = 'auto', depth = 24, harmonics = 4 }, { rate, profile }) {
    this.latency = 0;
    const f0 = base === 'auto' ? (profile?.humHz || 50) : Number(base);
    this.f = [];
    for (let k = 1; k <= harmonics && k * f0 < rate * 0.45; k++) {
      // Narrow (about 2 Hz at the fundamental), a little wider up the series.
      this.f.push(new Biquad('peaking', rate, k * f0, 18 + 6 * k, -depth));
    }
  }
  process(x) { const y = x.slice(); for (const f of this.f) f.run(y); return y; }
}

// Burg's method: prediction coefficients for x[n] ≈ Σ c[j] x[n-j] (j = 1..order). Unlike the
// autocorrelation method it doesn't fade out when extrapolating from a short context.
function burg(x, order) {
  const n = x.length;
  const f = Float64Array.from(x);
  const b = Float64Array.from(x);
  let a = new Float64Array(order + 1);
  a[0] = 1;
  for (let m = 1; m <= order; m++) {
    let num = 0;
    let den = 0;
    for (let i = m; i < n; i++) { num += f[i] * b[i - 1]; den += f[i] * f[i] + b[i - 1] * b[i - 1]; }
    if (den <= 1e-20) break;
    const k = (-2 * num) / den;
    const prev = a;
    a = prev.slice();
    for (let j = 1; j <= m; j++) a[j] = prev[j] + k * prev[m - j];
    for (let i = n - 1; i >= m; i--) {
      const fi = f[i];
      f[i] = fi + k * b[i - 1];
      b[i] = b[i - 1] + k * fi;
    }
  }
  return a.map((v, j) => (j ? -v : 0));
}

// Continues ctx by n samples with linear prediction.
function predict(ctx, n, order) {
  const c = burg(ctx, order);
  const out = new Float64Array(n);
  const hist = new Float64Array(order + n);
  hist.set(ctx.subarray(ctx.length - order));
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let j = 1; j <= order; j++) v += c[j] * hist[order + i - j];
    hist[order + i] = v;
    out[i] = v;
  }
  return out;
}

// Mouth clicks and crackle: very short spikes that stand far above the treble around them,
// replaced by linear prediction from both sides. A spike that repeats a pitch period away is
// the voice itself (each vocal-fold pulse is a small spike in the treble) and is left alone.
export class DeClick extends Lookahead {
  constructor({ sensitivity = 50 }, { rate }) {
    super(rate * 0.032, rate * 0.016);
    this.rate = rate;
    this.k = 10 - 0.06 * sensitivity; // spike over its surroundings' level: 10x down to 4x
    this.hp = [new Biquad('highpass', rate, 3000, 0.7), new Biquad('highpass', rate, 3000, 0.7)];
    this.h = new Float32Array(0); // the high-passed input, as it arrived (never the repaired audio)
    this.hStart = 0;
    this.hEnd = 0;
    this.scanned = 0;
    this.win = Math.round(rate * 0.01);
    this.hole = Math.round(rate * 0.0015);
    this.margin = Math.round(rate * 0.008);
    this.periodLo = Math.round(rate * 0.002);
    this.periodHi = Math.round(rate * 0.014);
    this.maxLen = Math.round(rate * 0.003);
    this.pad = Math.round(rate * 0.0002);
    this.ctx = Math.round(rate * 0.005);
    this.floor = 10 ** (-50 / 20);
    this.count = 0;
  }

  // h for stream position p (0 outside what is kept).
  hAt(p) { return this.h[p - this.hStart] ?? 0; }

  work(from, to) {
    // Filter everything new first: nothing past the last call's end has been repaired yet.
    const fresh = this.buf.slice(this.at(this.hEnd), this.at(this.len));
    for (const f of this.hp) f.run(fresh);
    const keepFrom = Math.max(this.hStart, from - this.win - this.periodHi - this.maxLen);
    const merged = new Float32Array(this.len - keepFrom);
    merged.set(this.h.subarray(keepFrom - this.hStart, this.hEnd - this.hStart));
    merged.set(fresh, this.hEnd - keepFrom);
    this.h = merged;
    this.hStart = keepFrom;
    this.hEnd = this.len;
    const h = this.h;
    const cs = new Float64Array(h.length + 1);
    for (let i = 0; i < h.length; i++) cs[i + 1] = cs[i] + h[i] * h[i];
    const { win, hole } = this;
    // Scan a little past `to`: a spike found there may reach back a few ms, and all of that is
    // still unreleased. Windows ahead of it fit in the look-ahead.
    let i = Math.max(this.scanned, this.hStart + win + this.periodHi);
    const scanTo = to + this.margin;
    while (i < scanTo) {
      const li = i - this.hStart;
      const v = Math.abs(h[li]);
      if (v < this.floor) { i++; continue; }
      const lo = li - win;
      const hi = li + win;
      const c1 = li - hole;
      const c2 = li + hole;
      const ref = Math.sqrt(Math.max(0, (cs[hi] - cs[lo] - (cs[c2] - cs[c1])) / (hi - lo - (c2 - c1)))) + 1e-9;
      if (v < this.k * ref || this.periodic(li, v)) { i++; continue; }
      let a = li;
      let b = li;
      while (a > lo && Math.abs(h[a - 1]) > ref * 3) a--;
      while (b < hi && Math.abs(h[b + 1]) > ref * 3) b++;
      const s = a + this.hStart - this.pad;
      const e = b + this.hStart + 1 + this.pad;
      if (e - s <= this.maxLen) this.repair(s, e);
      i = Math.max(i + 1, e);
    }
    this.scanned = i;
  }

  periodic(li, v) {
    const h = this.h;
    for (const dir of [-1, 1]) {
      let m = 0;
      for (let d = this.periodLo; d <= this.periodHi; d++) m = Math.max(m, Math.abs(h[li + dir * d] ?? 0));
      if (m > 0.5 * v) return true;
    }
    return false;
  }

  repair(s, e) {
    const n = e - s;
    const left = Float64Array.from(this.buf.subarray(this.at(s - this.ctx), this.at(s)));
    const right = Float64Array.from(this.buf.subarray(this.at(e), this.at(e + this.ctx))).reverse();
    const order = Math.min(32, Math.floor(this.ctx / 4));
    const fwd = predict(left, n, order);
    const bwd = predict(right, n, order).reverse();
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / n);
      this.buf[this.at(s + i)] = (1 - w) * fwd[i] + w * bwd[i];
    }
    this.count++;
  }
}

/* ---------- dropout repair ---------- */

// Most repeating period in ctx (samples) and how periodic it is (0..1).
function pitchPeriod(ctx, lo, hi) {
  const n = ctx.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += ctx[i];
  mean /= n;
  const span = Math.min(hi, n - hi);
  if (span < lo) return [lo, 0];
  let best = lo;
  let bestR = -1;
  let tailE = 0;
  for (let i = n - span; i < n; i++) tailE += (ctx[i] - mean) ** 2;
  for (let p = lo; p < hi && n - span - p >= 0; p++) {
    let dot = 0;
    let e = 0;
    for (let i = n - span; i < n; i++) {
      const a = ctx[i - p] - mean;
      dot += a * (ctx[i] - mean);
      e += a * a;
    }
    const r = dot / (Math.sqrt(e * tailE) + 1e-12);
    if (r > bestR) { bestR = r; best = p; }
  }
  return [best, Math.max(0, bestR)];
}

// Fills the holes a bad connection punches into speech: near digital silence, a few to a
// hundred-odd milliseconds long, with speech right before and after. Each hole is filled from
// both sides (the voice's last pitch period carried forward, the next one carried back,
// crossfaded), which a recording allows and a live call can't.
export class Dropouts extends Lookahead {
  constructor({ threshold = -65, maxGap = 150 }, { rate }) {
    const maxGapS = Math.round((rate * maxGap) / 1000);
    super(maxGapS + rate * 0.11, rate * 0.11);
    this.rate = rate;
    this.F = Math.round(rate * 0.005); // 5 ms frames
    this.silent = threshold;
    this.speech = -45;
    this.minFrames = 2; // 10 ms
    this.maxFrames = Math.floor(maxGap / 5);
    this.ctxN = Math.round(rate * 0.06);
    this.edge = Math.round(rate * 0.004);
    this.near = 6; // speech within 30 ms on both sides
    this.frames = []; // dB of complete frames from frameBase on
    this.frameBase = Math.ceil(this.ahead / this.F); // frames before this hold only the leading zeros
    this.nextFrame = this.frameBase;
    this.run = null; // [startFrame] of the current quiet run
    this.pending = []; // holes waiting for enough audio after them
    this.lo = Math.round(rate / 400);
    this.hi = Math.round(rate / 70);
    this.rfft = new RealFFT(1024);
    this.rand = new Rand(7);
    this.count = 0;
  }

  frameDb(f) { return this.frames[f - this.frameBase] ?? -200; }

  work(from, to) {
    const F = this.F;
    // Frame energies for every frame complete in the stream so far.
    while ((this.nextFrame + 1) * F <= this.len) {
      const s = this.at(this.nextFrame * F);
      let e = 0;
      for (let i = 0; i < F; i++) e += this.buf[s + i] * this.buf[s + i];
      this.frames.push(10 * Math.log10(e / F + 1e-14));
      const f = this.nextFrame++;
      const quiet = this.frameDb(f) < this.silent;
      if (quiet && this.run == null) this.run = f;
      if (!quiet && this.run != null) {
        const a = this.run;
        this.run = null;
        const n = f - a;
        if (n >= this.minFrames && n <= this.maxFrames) this.pending.push([a, f]);
      }
      if (quiet && this.run != null && f - this.run > this.maxFrames) this.run = -Infinity; // a pause, not a hole
      if (this.run === -Infinity && !quiet) this.run = null;
    }
    // Holes with enough audio after them to check and fill.
    const avail = this.nextFrame;
    this.pending = this.pending.filter(([a, b]) => {
      if (b + Math.max(this.near, Math.ceil((this.ctxN + this.edge) / F) + 1) > avail) return true;
      let before = -200;
      let after = -200;
      for (let k = 1; k <= this.near; k++) { before = Math.max(before, this.frameDb(a - k)); after = Math.max(after, this.frameDb(b + k - 1)); }
      if (before > this.speech && after > this.speech) this.fill(a * F, b * F);
      return false;
    });
    // Memory: frames far behind are not needed again.
    const drop = this.frames.length - 4000;
    if (drop > 0 && this.run == null && !this.pending.some(([a]) => a - this.frameBase < drop + 20)) {
      this.frames.splice(0, drop);
      this.frameBase += drop;
    }
  }

  extrapolate(ctx, n) {
    const [p, r] = pitchPeriod(ctx, this.lo, this.hi);
    let rms = 0;
    for (let i = ctx.length - 2 * p; i < ctx.length; i++) rms += ctx[i] * ctx[i];
    rms = Math.sqrt(rms / (2 * p)) + 1e-9;
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = ctx[ctx.length - p + (i % p)];
    if (r < 0.5) {
      // Unvoiced: noise with the context's spectrum, blended in as periodicity drops.
      const N = 1024;
      const seg = new Float64Array(N);
      const off = Math.max(0, ctx.length - N);
      for (let i = 0; i < Math.min(N, ctx.length); i++) seg[i] = ctx[off + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
      const re = new Float64Array(N / 2 + 1);
      const im = new Float64Array(N / 2 + 1);
      this.rfft.forward(seg, re, im);
      for (let k = 0; k <= N / 2; k++) {
        const mag = Math.hypot(re[k], im[k]);
        const ph = 2 * Math.PI * this.rand.next();
        re[k] = mag * Math.cos(ph);
        im[k] = mag * Math.sin(ph);
      }
      const noise = new Float64Array(N);
      this.rfft.inverse(re, im, noise);
      let nr = 0;
      for (let i = 0; i < N; i++) nr += noise[i] * noise[i];
      nr = Math.sqrt(nr / N) + 1e-12;
      const w = r / 0.5;
      for (let i = 0; i < n; i++) v[i] = w * v[i] + (1 - w) * (noise[i % N] * rms) / nr;
    }
    // Long extrapolations drift: let them fade, the other side takes over.
    const tau = 0.2 * this.rate;
    for (let i = 0; i < n; i++) v[i] *= Math.exp(-i / tau);
    return v;
  }

  fill(s, e) {
    const s2 = s - this.edge;
    const e2 = e + this.edge;
    const n = e2 - s2;
    if (s2 - this.ctxN < this.start || e2 + this.ctxN > this.len) return;
    const left = Float64Array.from(this.buf.subarray(this.at(s2 - this.ctxN), this.at(s2)));
    const right = Float64Array.from(this.buf.subarray(this.at(e2), this.at(e2 + this.ctxN))).reverse();
    const fwd = this.extrapolate(left, n);
    const bwd = this.extrapolate(right, n).reverse();
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / Math.max(1, n - 1));
      this.buf[this.at(s2 + i)] = (1 - w) * fwd[i] + w * bwd[i];
    }
    this.count++;
  }
}

/* ---------- the spectral stage ---------- */

// Noise reduction, room-echo reduction, de-essing and treble restoration share one STFT.
export class Spectral {
  constructor(opts, { rate, profile }) {
    const n = STFT_SIZE;
    this.rate = rate;
    this.n = n;
    this.bins = n / 2 + 1;
    this.binHz = rate / n;
    this.opts = opts;
    this.stft = new Stft(n, STFT_HOP, (re, im, m) => this.frame(re, im, m));
    this.latency = this.stft.latency;
    this.P = new Float64Array(this.bins);
    this.G = new Float64Array(this.bins);
    this.Gs = new Float64Array(this.bins);
    const bins = this.bins;

    const dn = opts.denoise;
    if (dn) {
      const over = 2 ** ((dn.sensitivity - 50) / 25);
      this.noise = new Float64Array(bins);
      const prof = profile?.noisePsd;
      for (let k = 0; k < bins; k++) this.noise[k] = (prof?.[k] ?? 1e-9) * over;
      this.adapt = !prof; // no profile: track the quietest level as it goes
      this.minTrack = this.adapt ? { sm: new Float64Array(bins), cur: new Float64Array(bins).fill(Infinity), prev: new Float64Array(bins).fill(Infinity), t: 0 } : null;
      this.dnFloor = dbToGain(-dn.amount);
      this.prevGain = new Float64Array(bins).fill(1);
      this.prevP = new Float64Array(bins);
    }

    const dr = opts.dereverb;
    if (dr) {
      const hopSec = STFT_HOP / rate;
      this.drDelay = Math.max(1, Math.round(0.05 / hopSec));
      const delta = (3 * Math.LN10) / dr.decay;
      this.drDecay = Math.exp(-2 * delta * this.drDelay * hopSec);
      this.drHist = Array.from({ length: this.drDelay + 1 }, () => new Float64Array(bins));
      this.drSm = new Float64Array(bins);
      this.drFloor = dbToGain(-dr.amount);
      this.drPrevG = new Float64Array(bins).fill(1);
    }

    const ds = opts.deess;
    if (ds) {
      this.dsLo = Math.round(4500 / this.binHz);
      this.dsHi = Math.min(bins - 1, Math.round(12000 / this.binHz));
      this.dsRatio = 0.55 - 0.004 * ds.threshold; // sibilance share of the frame's energy that triggers it
      this.dsMax = ds.amount;
      this.dsGain = 0; // dB, current reduction
    }

    const hs = opts.highs;
    if (hs) {
      const cutoff = hs.cutoff === 'auto' ? profile?.cutoffHz : Number(hs.cutoff);
      if (cutoff && cutoff < rate * 0.45) {
        this.kc = Math.round((cutoff * 0.98) / this.binHz);
        this.kEnd = Math.min(bins - 1, Math.round(Math.min(2 * cutoff, 20000, rate * 0.48) / this.binHz));
        this.W = Math.max(4, Math.round(this.kc / 2));
        this.hsLevel = hs.amount;
        this.hsPeak = -200; // recent loudest frame (dB), decaying slowly
      }
    }
  }

  process(x) { return this.stft.process(x); }

  frame(re, im, m) {
    const { bins, P, G } = this;
    for (let k = 0; k < bins; k++) { P[k] = re[k] * re[k] + im[k] * im[k]; G[k] = 1; }
    if (this.noise) this.denoise();
    if (this.drHist) this.dereverb();
    if (this.dsLo) this.deess();
    // Smooth the gain a little across frequency: fewer chirpy "musical noise" artefacts.
    const Gs = this.Gs;
    Gs[0] = G[0];
    Gs[bins - 1] = G[bins - 1];
    for (let k = 1; k < bins - 1; k++) Gs[k] = 0.25 * G[k - 1] + 0.5 * G[k] + 0.25 * G[k + 1];
    for (let k = 0; k < bins; k++) { re[k] *= Gs[k]; im[k] *= Gs[k]; }
    if (this.kc) this.restoreHighs(re, im, m);
  }

  denoise() {
    const { bins, P, G, noise, prevGain, prevP } = this;
    if (this.adapt) this.trackNoise();
    const a = 0.96;
    for (let k = 0; k < bins; k++) {
      const N = noise[k] + 1e-20;
      const gamma = P[k] / N;
      const xi = a * (prevGain[k] * prevGain[k] * prevP[k]) / N + (1 - a) * Math.max(gamma - 1, 0);
      const g = Math.max(xi / (1 + xi), this.dnFloor);
      prevGain[k] = g;
      prevP[k] = P[k];
      G[k] *= g;
    }
  }

  // Minimum statistics, roughly: the noise is the lowest smoothed level of the last second or so.
  trackNoise() {
    const t = this.minTrack;
    const L = 24;
    for (let k = 0; k < this.bins; k++) {
      t.sm[k] = 0.85 * t.sm[k] + 0.15 * this.P[k];
      if (t.sm[k] < t.cur[k]) t.cur[k] = t.sm[k];
      this.noise[k] = Math.min(t.cur[k], t.prev[k]) * 1.5;
      if (!Number.isFinite(this.noise[k])) this.noise[k] = t.sm[k];
    }
    if (++t.t % L === 0) { t.prev = t.cur; t.cur = new Float64Array(this.bins).fill(Infinity); }
  }

  dereverb() {
    const { bins, P, G, drHist, drSm, drPrevG } = this;
    // Late reverberation now ≈ what was there 50 ms ago, decayed at the room's rate.
    const old = drHist[0];
    for (let k = 0; k < bins; k++) {
      const late = this.drDecay * old[k];
      const p = P[k] + 1e-20;
      let g = Math.max(1 - late / p, this.drFloor);
      g = Math.max(g, drPrevG[k] * 0.6); // don't snap shut: tails sound unnatural cut off
      drPrevG[k] = g;
      G[k] *= g;
      drSm[k] = 0.4 * drSm[k] + 0.6 * P[k];
    }
    const recycled = drHist.shift();
    recycled.set(drSm);
    drHist.push(recycled);
  }

  deess() {
    const { P, G, dsLo, dsHi } = this;
    let sib = 0;
    let all = 0;
    const lo = Math.round(150 / this.binHz);
    for (let k = lo; k <= dsHi; k++) all += P[k];
    for (let k = dsLo; k <= dsHi; k++) sib += P[k];
    const level = 10 * Math.log10(all / this.n + 1e-20);
    const share = all > 0 ? sib / all : 0;
    let target = 0;
    if (level > -60 && share > this.dsRatio) target = Math.min(this.dsMax, 20 * Math.log10(share / this.dsRatio) * 1.5);
    // Fast to grab an "s", slower to let go.
    this.dsGain = target > this.dsGain ? target : this.dsGain * 0.7 + target * 0.3;
    if (this.dsGain < 0.05) return;
    const g = dbToGain(-this.dsGain);
    for (let k = dsLo - 4; k <= dsHi; k++) {
      const ramp = k < dsLo ? (k - (dsLo - 4)) / 4 : 1;
      G[k] *= 1 - ramp * (1 - g);
    }
  }

  // Spectral band replication: the octave under the cut-off copied up above it, following the
  // spectrum's own slope, only while there is voice to copy (no hiss in the pauses).
  restoreHighs(re, im, m) {
    const { kc, kEnd, W } = this;
    const k0 = Math.max(2, kc - W);
    // Slope of the band under the cut-off, in dB per octave.
    let sx = 0; let sy = 0; let sxx = 0; let sxy = 0; let cnt = 0;
    let srcE = 0;
    for (let k = k0; k < kc; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      srcE += p;
      const x = Math.log2(k);
      const y = 10 * Math.log10(p + 1e-20);
      sx += x; sy += y; sxx += x * x; sxy += x * y; cnt++;
    }
    const slope = clamp((cnt * sxy - sx * sy) / (cnt * sxx - sx * sx || 1), -18, -3);
    // Only while someone talks: the frame within 30 dB of the recent loudest frames.
    let e = 0;
    for (let k = 1; k < kc; k++) e += re[k] * re[k] + im[k] * im[k];
    const frameDb = 10 * Math.log10(e + 1e-20);
    this.hsPeak = Math.max(frameDb, this.hsPeak - 0.02);
    const gate = clamp((frameDb - (this.hsPeak - 30)) / 10, 0, 1);
    if (gate <= 0 || srcE <= 0) return;
    // Phase advance for a shift of W bins over m hops (hop = n/4: a quarter turn per bin).
    const turns = ((m * W) % 4 + 4) % 4;
    const rr = [1, 0, -1, 0][turns];
    const ri = [0, 1, 0, -1][turns];
    for (let k = kc; k <= kEnd; k++) {
      const s = k - W;
      let db = slope * Math.log2(k / s);
      if (s < kc) db += this.hsLevel;
      const fade = k - kc < 4 ? (k - kc + 1) / 5 : 1;
      const g = dbToGain(db) * gate * fade;
      const a = re[s] * g;
      const b = im[s] * g;
      re[k] += a * rr - b * ri;
      im[k] += a * ri + b * rr;
    }
  }
}

/* ---------- tone ---------- */

export class Eq {
  constructor({ warmth = 0, mud = 0, presence = 0, air = 0 }, { rate }) {
    this.latency = 0;
    this.f = [];
    if (warmth) this.f.push(new Biquad('lowshelf', rate, 140, 0.8, warmth));
    if (mud) this.f.push(new Biquad('peaking', rate, 350, 1.0, mud));
    if (presence) this.f.push(new Biquad('peaking', rate, 3200, 0.9, presence));
    if (air) this.f.push(new Biquad('highshelf', rate, 10000, 0.8, air));
  }
  process(x) { const y = x.slice(); for (const f of this.f) f.run(y); return y; }
}

const SPEEDS = {
  fast: { attack: 0.003, release: 0.06 },
  medium: { attack: 0.01, release: 0.15 },
  slow: { attack: 0.03, release: 0.4 },
};

// Downward compressor with a soft knee and automatic make-up gain.
export class Compressor {
  constructor({ amount = 40, speed = 'medium' }, { rate }) {
    this.latency = 0;
    this.T = -12 - 0.2 * amount;
    this.R = 1.5 + amount / 40;
    this.knee = 6;
    const sp = SPEEDS[speed] || SPEEDS.medium;
    this.att = Math.exp(-1 / (sp.attack * rate));
    this.rel = Math.exp(-1 / (sp.release * rate));
    this.det = Math.exp(-1 / (0.005 * rate));
    this.env = 0;
    this.gr = 0;
    // Make-up: give back what a typical speech level (-20 dBFS) loses.
    this.makeup = -this.curve(-20) * 0.8;
  }

  curve(l) {
    const { T, R, knee } = this;
    if (l < T - knee / 2) return 0;
    if (l > T + knee / 2) return (T + (l - T) / R) - l;
    const x = l - T + knee / 2;
    return ((1 / R - 1) * x * x) / (2 * knee);
  }

  process(x) {
    const y = new Float32Array(x.length);
    let { env, gr } = this;
    const mk = this.makeup;
    for (let i = 0; i < x.length; i++) {
      env = this.det * env + (1 - this.det) * x[i] * x[i];
      const level = 10 * Math.log10(env + 1e-12);
      const want = this.curve(level);
      gr = want < gr ? this.att * gr + (1 - this.att) * want : this.rel * gr + (1 - this.rel) * want;
      y[i] = x[i] * dbToGain(gr + mk);
    }
    this.env = env;
    this.gr = gr;
    return y;
  }
}

/* ---------- master ---------- */

// BS.1770 K-weighting (pre-filter shelf and RLB high-pass) as two biquads.
export function kWeighting(rate) {
  return [new Biquad('highshelf', rate, 1681.97, 0.7072, 3.9998), new Biquad('highpass', rate, 38.135, 0.5003)];
}

// Integrated loudness (LUFS, gated as in BS.1770-4) and loudness range, fed a block at a time.
export class LoudnessMeter {
  constructor(rate) {
    this.rate = rate;
    this.k = kWeighting(rate);
    this.step = Math.round(rate * 0.1);
    this.acc = 0;
    this.n = 0;
    this.sub = []; // mean square of each 100 ms
    this.peak = 0;
  }

  push(x) {
    const y = x.slice();
    for (const f of this.k) f.run(y);
    for (let i = 0; i < y.length; i++) {
      const a = Math.abs(x[i]);
      if (a > this.peak) this.peak = a;
      this.acc += y[i] * y[i];
      if (++this.n === this.step) { this.sub.push(this.acc / this.step); this.acc = 0; this.n = 0; }
    }
  }

  // Momentary (400 ms) block powers, 75 % overlap.
  blocks() {
    const out = [];
    for (let i = 3; i < this.sub.length; i++) out.push((this.sub[i] + this.sub[i - 1] + this.sub[i - 2] + this.sub[i - 3]) / 4);
    return out;
  }

  integrated() {
    const lufs = (p) => -0.691 + 10 * Math.log10(p + 1e-20);
    const b = this.blocks().filter((p) => lufs(p) > -70);
    if (!b.length) return -Infinity;
    const rel = lufs(b.reduce((s, p) => s + p, 0) / b.length) - 10;
    const g = b.filter((p) => lufs(p) > rel);
    return g.length ? lufs(g.reduce((s, p) => s + p, 0) / g.length) : -Infinity;
  }

  peakDb() { return gainToDb(this.peak); }
}

const LEVELER_SPEEDS = { gentle: { win: 4, slew: 3 }, normal: { win: 2.5, slew: 6 }, fast: { win: 1.5, slew: 12 } };

// Rides the gain like an engineer would: slowly towards the target loudness, never raising the
// pauses (it holds still when nobody is talking), looking half a second ahead so it isn't late.
// Loudness is measured the way BS.1770 does (400 ms blocks, gated), so the target is in LUFS.
export class Leveler {
  // lufs: the whole episode's loudness, when known (the analysis measures it). The leveler then
  // always lands on the target: strength only says how much it rides the gain on top of that.
  constructor({ target = -16, strength = 70, speed = 'normal' }, { rate, lufs = null }) {
    const sp = LEVELER_SPEEDS[speed] || LEVELER_SPEEDS.normal;
    this.rate = rate;
    this.target = target;
    this.base = Number.isFinite(lufs) ? clamp(target - lufs, -24, 24) : null;
    this.strength = strength / 100;
    this.maxBoost = 4 + 14 * this.strength;
    this.maxCut = 4 + 16 * this.strength;
    this.latency = Math.round(rate * 0.5);
    this.delay = new Float32Array(this.latency);
    this.dpos = 0;
    this.k = kWeighting(rate);
    this.blk = Math.round(rate * 0.1);
    this.sub = [0, 0, 0]; // the last three 100 ms mean squares
    this.blocks = new Float64Array(Math.round(sp.win / 0.1)); // 400 ms block powers, every 100 ms
    this.bpos = 0;
    this.filled = 0;
    this.acc = 0;
    this.n = 0;
    this.seen = 0;
    this.gain = this.base; // dB; without a known loudness, set from the first stretch heard
    this.want = this.base ?? 0;
    this.slewPerSample = sp.slew / rate;
  }

  process(x) {
    const side = x.slice();
    for (const f of this.k) f.run(side);
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      this.acc += side[i] * side[i];
      if (++this.n === this.blk) {
        const ms = this.acc / this.blk;
        this.acc = 0;
        this.n = 0;
        if (++this.seen >= 4) {
          this.blocks[this.bpos] = (ms + this.sub[0] + this.sub[1] + this.sub[2]) / 4;
          this.bpos = (this.bpos + 1) % this.blocks.length;
          this.filled = Math.min(this.filled + 1, this.blocks.length);
          this.decide();
        }
        this.sub = [ms, this.sub[0], this.sub[1]];
      }
      if (this.gain != null) this.gain += clamp(this.want - this.gain, -this.slewPerSample, this.slewPerSample);
      const v = this.delay[this.dpos];
      this.delay[this.dpos] = x[i];
      if (++this.dpos === this.latency) this.dpos = 0;
      y[i] = v * dbToGain(this.gain ?? 0);
    }
    return y;
  }

  decide() {
    const lufs = (p) => -0.691 + 10 * Math.log10(p + 1e-20);
    // Gated like BS.1770: blocks above -55 LUFS, then above (their mean - 10 dB).
    let sum = 0;
    let cnt = 0;
    for (let j = 0; j < this.filled; j++) if (lufs(this.blocks[j]) > -55) { sum += this.blocks[j]; cnt++; }
    if (!cnt) return;
    const rel = lufs(sum / cnt) - 10;
    let s2 = 0;
    let c2 = 0;
    for (let j = 0; j < this.filled; j++) if (lufs(this.blocks[j]) > rel && lufs(this.blocks[j]) > -55) { s2 += this.blocks[j]; c2++; }
    if (c2 < Math.max(2, this.filled * 0.3)) return; // mostly quiet: hold
    const full = this.target - lufs(s2 / c2);
    const want = this.base == null
      ? clamp(full * this.strength, -this.maxCut, this.maxBoost)
      : this.base + clamp((full - this.base) * this.strength, -this.maxCut, this.maxBoost);
    if (this.gain == null) this.gain = want;
    this.want = want;
  }
}

// A quiet, steady background under the dead silence a call's noise gate leaves.
export class RoomTone {
  constructor({ level = -60, tone = 'neutral' }, { rate }) {
    this.rate = rate;
    this.F = Math.round(rate * 0.005);
    this.latency = Math.round(rate * 0.02);
    this.gate = 10 ** (-72 / 20);
    this.level = dbToGain(level);
    this.lp = tone === 'bright' ? null : new Biquad('lowpass', rate, tone === 'dark' ? 2500 : 7000, 0.7);
    this.hp = new Biquad('highpass', rate, 60, 0.7);
    this.mask = 0;
    this.delay = new Float32Array(this.latency);
    this.dpos = 0;
    this.frame = new Float32Array(this.F);
    this.fpos = 0;
    this.target = 0;
    this.ramp = 1 / (rate * 0.015);
    // The filtered noise's own level, measured on a second of it (from a separate generator,
    // so the noise that is used doesn't depend on this).
    const cal = new RoomTone.Noise(99);
    const probe = new Float32Array(rate);
    for (let i = 0; i < rate; i++) probe[i] = cal.pink();
    const lp2 = tone === 'bright' ? null : new Biquad('lowpass', rate, tone === 'dark' ? 2500 : 7000, 0.7);
    if (lp2) lp2.run(probe);
    new Biquad('highpass', rate, 60, 0.7).run(probe);
    let e = 0;
    for (let i = rate / 2; i < rate; i++) e += probe[i] * probe[i];
    this.norm = 1 / Math.sqrt(e / (rate / 2) + 1e-20);
    this.src = new RoomTone.Noise(11);
  }

  process(x) {
    const y = new Float32Array(x.length);
    const noise = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) noise[i] = this.src.pink();
    if (this.lp) this.lp.run(noise);
    this.hp.run(noise);
    for (let i = 0; i < x.length; i++) {
      // Decide per 5 ms frame of the incoming (not yet delayed) audio whether it is dead silent.
      this.frame[this.fpos] = x[i];
      if (++this.fpos === this.F) {
        this.fpos = 0;
        let peak = 0;
        for (let j = 0; j < this.F; j++) peak = Math.max(peak, Math.abs(this.frame[j]));
        this.target = peak < this.gate ? 1 : 0;
      }
      this.mask += clamp(this.target - this.mask, -this.ramp, this.ramp);
      const v = this.delay[this.dpos];
      this.delay[this.dpos] = x[i];
      if (++this.dpos === this.latency) this.dpos = 0;
      y[i] = v + noise[i] * this.norm * this.level * this.mask;
    }
    return y;
  }
}

// Pink noise (Paul Kellet's filter) from a seeded generator.
RoomTone.Noise = class {
  constructor(seed) { this.rand = new Rand(seed); this.b = new Float64Array(7); }
  pink() {
    const w = this.rand.gauss();
    const b = this.b;
    b[0] = 0.99886 * b[0] + w * 0.0555179;
    b[1] = 0.99332 * b[1] + w * 0.0750759;
    b[2] = 0.96900 * b[2] + w * 0.1538520;
    b[3] = 0.86650 * b[3] + w * 0.3104856;
    b[4] = 0.55000 * b[4] + w * 0.5329522;
    b[5] = -0.7616 * b[5] - w * 0.0168980;
    const out = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362;
    b[6] = w * 0.115926;
    return out;
  }
};

// Look-ahead peak limiter: never above the ceiling, gain changes spread over 5 ms.
// Gain = sliding minimum of the gain each sample needs (over the look-ahead), with a slow
// release, then a moving average over the look-ahead: smooth, and still low enough at every peak.
export class Limiter {
  constructor({ ceiling = -1 }, { rate }) {
    this.c = dbToGain(ceiling);
    this.L = Math.max(1, Math.round(rate * 0.005));
    this.latency = this.L;
    this.rel = 1 - Math.exp(-1 / (rate * 0.08));
    const L = this.L;
    this.audio = new Float32Array(L);
    this.p = 0;
    // Monotonic deque of (index, required gain) over the last L+1 samples.
    this.qi = new Float64Array(L + 2);
    this.qv = new Float32Array(L + 2);
    this.qh = 0;
    this.qn = 0;
    this.t = 0;
    this.box = new Float64Array(L).fill(1);
    this.boxSum = L;
    this.bp = 0;
    this.g = 1;
  }

  process(x) {
    const y = new Float32Array(x.length);
    const { L, c, qi, qv } = this;
    const cap = L + 2;
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i]);
      const r = a > c ? c / a : 1;
      // push (t, r): drop larger values from the back
      while (this.qn && qv[(this.qh + this.qn - 1) % cap] >= r) this.qn--;
      const tail = (this.qh + this.qn) % cap;
      qi[tail] = this.t;
      qv[tail] = r;
      this.qn++;
      // expire entries older than the window
      while (qi[this.qh] < this.t - L) { this.qh = (this.qh + 1) % cap; this.qn--; }
      const m = qv[this.qh];
      this.t++;
      this.g = m < this.g ? m : this.g + (m - this.g) * this.rel;
      this.boxSum += this.g - this.box[this.bp];
      this.box[this.bp] = this.g;
      this.bp = (this.bp + 1) % L;
      const v = this.audio[this.p];
      this.audio[this.p] = x[i];
      this.p = (this.p + 1) % L;
      let out = v * (this.boxSum / L);
      // Safe by construction; this only trims floating-point rounding.
      if (out > c) out = c; else if (out < -c) out = -c;
      y[i] = out;
    }
    return y;
  }
}
