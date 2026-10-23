// Building blocks for the clean-up chain: FFTs, a streaming STFT, biquad filters and delay
// lines. Everything works on Float32Array blocks of any length and keeps its state between
// blocks, so an episode can be processed a piece at a time with the same result as in one go.
// No DOM: the page, the clean-up worker and the unit tests all use this.

/* ---------- FFT ---------- */

// In-place radix-2 complex FFT of size n (a power of two).
export class FFT {
  constructor(n) {
    if (n & (n - 1)) throw new Error('FFT size must be a power of two');
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  // inverse: true computes the unscaled inverse transform (sign flipped, no 1/n).
  transform(re, im, inverse = false) {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = cos[t];
          const wi = sign * sin[t];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

// FFT of a real signal of size n through one complex FFT of size n/2. Spectra are n/2 + 1 bins.
export class RealFFT {
  constructor(n) {
    this.n = n;
    this.m = n / 2;
    this.fft = new FFT(this.m);
    this.zr = new Float64Array(this.m);
    this.zi = new Float64Array(this.m);
    this.tc = new Float64Array(this.m + 1);
    this.ts = new Float64Array(this.m + 1);
    for (let k = 0; k <= this.m; k++) {
      this.tc[k] = Math.cos((2 * Math.PI * k) / n);
      this.ts[k] = Math.sin((2 * Math.PI * k) / n);
    }
  }

  // x (length n) -> re, im (length n/2 + 1)
  forward(x, re, im) {
    const { m, zr, zi, tc, ts } = this;
    for (let k = 0; k < m; k++) { zr[k] = x[2 * k]; zi[k] = x[2 * k + 1]; }
    this.fft.transform(zr, zi);
    for (let k = 0; k <= m; k++) {
      const a = k % m;
      const b = (m - k) % m;
      // E = (Z[k] + conj Z[m-k]) / 2, O = (Z[k] - conj Z[m-k]) / 2i
      const er = (zr[a] + zr[b]) / 2;
      const ei = (zi[a] - zi[b]) / 2;
      const or = (zi[a] + zi[b]) / 2;
      const oi = -(zr[a] - zr[b]) / 2;
      // X[k] = E + e^{-2πik/n} O
      const c = tc[k];
      const s = -ts[k];
      re[k] = er + (or * c - oi * s);
      im[k] = ei + (or * s + oi * c);
    }
  }

  // re, im (length n/2 + 1) -> x (length n), scaled so inverse(forward(x)) = x.
  inverse(re, im, x) {
    const { m, zr, zi, tc, ts } = this;
    for (let k = 0; k < m; k++) {
      const b = m - k;
      // E = (X[k] + conj X[m-k]) / 2, O = (X[k] - conj X[m-k]) / 2 * e^{2πik/n}
      const er = (re[k] + re[b]) / 2;
      const ei = (im[k] - im[b]) / 2;
      const dr = (re[k] - re[b]) / 2;
      const di = (im[k] + im[b]) / 2;
      const c = tc[k];
      const s = ts[k];
      const or = dr * c - di * s;
      const oi = dr * s + di * c;
      // Z = E + iO
      zr[k] = er - oi;
      zi[k] = ei + or;
    }
    this.fft.transform(zr, zi, true);
    for (let k = 0; k < m; k++) { x[2 * k] = zr[k] / m; x[2 * k + 1] = zi[k] / m; }
  }
}

/* ---------- streaming STFT ---------- */

// Weighted overlap-add with square-root Hann windows on both sides, which reconstructs the
// input exactly when nothing is changed. onFrame(re, im, frame) may change the spectrum.
// Output lags input by `latency` samples.
export class Stft {
  constructor(n, hop, onFrame) {
    this.n = n;
    this.hop = hop;
    this.bins = n / 2 + 1;
    this.onFrame = onFrame;
    this.rfft = new RealFFT(n);
    this.win = new Float64Array(n);
    for (let i = 0; i < n; i++) this.win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
    this.scale = (2 * hop) / n; // a periodic Hann overlapped every hop sums to n / (2 hop)
    this.inBuf = new Float64Array(n);
    this.ola = new Float64Array(n);
    this.frame = new Float64Array(n);
    this.re = new Float64Array(this.bins);
    this.im = new Float64Array(this.bins);
    this.fill = 0; // samples gathered towards the next hop
    this.frames = 0;
    this.out = new Float32Array(hop);
    this.latency = n;
  }

  process(x) {
    const { n, hop } = this;
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      this.inBuf[n - hop + this.fill] = x[i];
      y[i] = this.out[this.fill];
      if (++this.fill === hop) {
        this.fill = 0;
        this.step();
      }
    }
    return y;
  }

  step() {
    const { n, hop, win, frame, re, im, ola, inBuf } = this;
    for (let i = 0; i < n; i++) frame[i] = inBuf[i] * win[i];
    this.rfft.forward(frame, re, im);
    this.onFrame?.(re, im, this.frames++);
    this.rfft.inverse(re, im, frame);
    for (let i = 0; i < n; i++) ola[i] += frame[i] * win[i] * this.scale;
    for (let i = 0; i < hop; i++) this.out[i] = ola[i];
    ola.copyWithin(0, hop);
    ola.fill(0, n - hop);
    inBuf.copyWithin(0, hop);
  }
}

/* ---------- biquads ---------- */

// Robert Bristow-Johnson's cookbook filters. gain in dB (peaking and shelves), q as usual
// (for shelves it is the slope S).
export function biquadCoefs(type, rate, freq, q = Math.SQRT1_2, gain = 0) {
  const A = 10 ** (gain / 40);
  const w0 = (2 * Math.PI * Math.min(freq, rate * 0.49)) / rate;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = type === 'lowshelf' || type === 'highshelf'
    ? (sw / 2) * Math.sqrt((A + 1 / A) * (1 / q - 1) + 2)
    : sw / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lowpass': b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'highpass': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'bandpass': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'notch': b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'peaking': b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s);
      a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s;
      break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s);
      a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s;
      break;
    }
    default: throw new Error(`unknown filter ${type}`);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export class Biquad {
  constructor(type, rate, freq, q, gain) {
    Object.assign(this, biquadCoefs(type, rate, freq, q, gain));
    this.z1 = 0;
    this.z2 = 0;
  }

  // Filters x in place (and returns it).
  run(x) {
    const { b0, b1, b2, a1, a2 } = this;
    let { z1, z2 } = this;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const y = b0 * v + z1;
      z1 = b1 * v - a1 * y + z2;
      z2 = b2 * v - a2 * y;
      x[i] = y;
    }
    this.z1 = Math.abs(z1) < 1e-25 ? 0 : z1;
    this.z2 = Math.abs(z2) < 1e-25 ? 0 : z2;
    return x;
  }

  // Magnitude response in dB at freq (for tests and the EQ curve).
  responseDb(rate, freq) {
    const w = (2 * Math.PI * freq) / rate;
    const re = (c0, c1, c2) => c0 + c1 * Math.cos(-w) + c2 * Math.cos(-2 * w);
    const im = (c0, c1, c2) => c1 * Math.sin(-w) + c2 * Math.sin(-2 * w);
    const nr = re(this.b0, this.b1, this.b2);
    const ni = im(this.b0, this.b1, this.b2);
    const dr = re(1, this.a1, this.a2);
    const di = im(1, this.a1, this.a2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }
}

/* ---------- delay ---------- */

export class Delay {
  constructor(samples) {
    this.n = Math.max(0, Math.round(samples));
    this.buf = new Float32Array(this.n);
    this.pos = 0;
  }

  process(x) {
    if (!this.n) return x.slice();
    const y = new Float32Array(x.length);
    const { buf, n } = this;
    let p = this.pos;
    for (let i = 0; i < x.length; i++) {
      y[i] = buf[p];
      buf[p] = x[i];
      if (++p === n) p = 0;
    }
    this.pos = p;
    return y;
  }
}

/* ---------- helpers ---------- */

export const dbToGain = (db) => 10 ** (db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(g, 1e-12));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Small deterministic noise source (the same output every run, so previews and exports match).
export class Rand {
  constructor(seed = 1) { this.s = seed >>> 0 || 1; }
  next() {
    // xorshift32
    let s = this.s;
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    this.s = s;
    return s / 4294967296;
  }
  gauss() {
    const u = Math.max(this.next(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
}
