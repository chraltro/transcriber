// Where an episode goes quiet, so the player can shorten its pauses: the dead air of a call's
// delay, a guest hunting for a word. Found from the audio itself (how loud each fiftieth of a
// second is, against how loud this recording's speech and its background are), wherever the
// audio can be read: on the server when an episode is transcribed, in the page for an episode
// saved on the device.
//
// What is shortened is the listener's choice: pauses longer than a limit are cut down to the
// limit, shorter ones (the natural ones) are left alone.

export const QUIET_VERSION = 1;
const FRAME = 0.02; // seconds
const MIN_QUIET = 0.25; // shorter than this isn't a pause, it is a consonant

// Feed it mono samples as they are decoded; finish() gives [[start, end], ...] in seconds.
export class QuietFinder {
  constructor(rate) {
    this.rate = rate;
    this.size = Math.round(rate * FRAME);
    this.db = [];
    this.sum = 0;
    this.n = 0;
  }

  push(samples) {
    const { size } = this;
    for (let i = 0; i < samples.length; i++) {
      this.sum += samples[i] * samples[i];
      if (++this.n === size) {
        this.db.push(10 * Math.log10(this.sum / size + 1e-10));
        this.sum = 0;
        this.n = 0;
      }
    }
  }

  // Quiet is relative to the recording: far under its speech (a studio's room tone, a call's
  // gated silence), or, where the room is louder than that, only just above the room; never
  // within 18 dB of the speech, where a low voice or music under a break would be. It errs
  // toward leaving a pause in: a recording whose talk doesn't stand 20 dB clear of its
  // background has none found at all.
  finish() {
    const { db } = this;
    if (db.length < 50) return [];
    const sorted = Float32Array.from(db).sort();
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    const speech = at(0.95);
    const floor = at(0.05);
    if (speech - floor < 20) return [];
    const limit = Math.min(speech - 18, Math.max(floor + 6, speech - 35));
    const out = [];
    let start = -1;
    for (let i = 0; i <= db.length; i++) {
      const quiet = i < db.length && db[i] < limit;
      if (quiet && start < 0) start = i;
      if (!quiet && start >= 0) {
        if ((i - start) * FRAME >= MIN_QUIET) out.push([Math.round(start * FRAME * 100) / 100, Math.round(i * FRAME * 100) / 100]);
        start = -1;
      }
    }
    return out;
  }
}

// What to jump over when pauses longer than `limit` seconds are cut down to it: half the limit
// is left after the last word and half before the next, so nothing is clipped and the rhythm
// of the talk stays. `cost`: the moment of nothing a jump itself takes in this player (in
// seconds of the episode); it is taken out of what is left before the next word, and a pause
// that would gain less than a sixth of a second is left alone. -> [[from, to], ...]
export function cutsFor(quiet, limit, cost = 0) {
  if (!(limit > 0) || !quiet?.length) return [];
  const before = Math.max(0.1, limit / 2);
  const after = Math.max(0.12, limit / 2 - cost); // (a soft first consonant can sit inside the quiet)
  const least = Math.max(0.2, cost + 0.15);
  const out = [];
  for (const [a, b] of quiet) {
    if (b - a <= limit) continue;
    const from = a + before;
    const to = b - after;
    if (to - from >= least) out.push([Math.round(from * 100) / 100, Math.round(to * 100) / 100]);
  }
  return out;
}

// The cut `t` is in, or the next one after it: its index (cuts.length when there is none).
export function cutIndex(cuts, t) {
  let lo = 0;
  let hi = cuts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cuts[mid][1] <= t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export const cutSeconds = (cuts) => (cuts || []).reduce((n, [a, b]) => n + (b - a), 0);
