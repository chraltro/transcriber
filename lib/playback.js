// The player's decisions, kept apart from the audio element so they can be tested: where to
// pick an episode up again, when it counts as finished, which ad to jump over, what the clock says.
import { breakAt } from './adbreaks.js';

// Coming back to an episode after a while, the last few seconds are played again: nobody
// remembers the half sentence they stopped in.
export function rewindFor(pausedMs) {
  if (!(pausedMs > 0)) return 0;
  if (pausedMs < 60e3) return 0;
  if (pausedMs < 10 * 60e3) return 3;
  if (pausedMs < 60 * 60e3) return 8;
  if (pausedMs < 24 * 3600e3) return 15;
  return 25;
}

// Where to start an episode: from the top when it is new or was finished, otherwise where it
// was left, a little earlier the longer ago that was.
export function resumeAt(progress, now, { rewind = true } = {}) {
  if (!progress || progress.done || !(progress.p > 5)) return 0;
  const back = rewind ? rewindFor(now - progress.at) : 0;
  return Math.max(0, progress.p - back);
}

// Finished: played to within the last seconds (credits and silence at the end don't count).
export const finished = (position, duration) => duration > 60 && position >= duration - Math.min(20, duration * 0.02);

// The ad to jump over at `t`, if any: its index and where it ends. A break the listener went
// back into on purpose (`keep`) is left alone, and so is one that is nearly over.
export function skipAt(breaks, t, keep = -1) {
  const i = breakAt(breaks, t);
  if (i < 0 || i === keep) return null;
  const [, end] = breaks[i];
  return end - t > 2 ? { index: i, to: end } : null;
}

// The next speed up from `rate` on the round the button steps through.
export const SPEEDS = [0.8, 1, 1.2, 1.5, 1.8, 2, 2.5, 3];
export function nextSpeed(rate) {
  const i = SPEEDS.findIndex((s) => s > rate + 0.001);
  return SPEEDS[i < 0 ? 0 : i];
}
export const fmtSpeed = (rate) => `${Number(rate).toFixed(rate * 10 % 1 ? 2 : 1).replace(/\.0$/, '')}×`;

// "1 h 12 min left", "8 min left", "under a minute left": what is left at the speed being played.
export function leftText(position, duration, rate = 1) {
  if (!(duration > 0)) return '';
  const sec = Math.max(0, duration - position) / (rate || 1);
  if (sec < 50) return 'under a minute left';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min left`;
  return `${Math.floor(min / 60)} h ${min % 60} min left`;
}

// "58 min", "1 h 12 min": an episode's length in a list.
export function lengthText(sec) {
  if (!(sec > 0)) return '';
  const min = Math.max(1, Math.round(sec / 60));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60 ? `${min % 60} min` : ''}`.trim();
}

// Times written in show notes ("12:34", "1:02:03") as seconds, or null.
export function timeIn(text) {
  const m = String(text).match(/^\(?(\d{1,2}):(\d{2})(?::(\d{2}))?\)?$/);
  if (!m) return null;
  const [a, b, c] = [Number(m[1]), Number(m[2]), m[3] != null ? Number(m[3]) : null];
  if (b > 59 || (c != null && c > 59)) return null;
  return c != null ? a * 3600 + b * 60 + c : a * 60 + b;
}
