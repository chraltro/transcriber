// Loudness of an episode, one byte per second: enough to draw its waveform, small enough to
// keep with a saved transcript (an hour is 3.6 KB). 0 means "not decoded yet", so silence is 1.
export const LEVELS_PER_SECOND = 1;

const quantize = (rms) => Math.min(255, Math.max(1, Math.round(rms * 1024)));

export function secondLevels(samples, sampleRate = 16000) {
  const n = Math.ceil(samples.length / sampleRate);
  const out = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    const a = s * sampleRate;
    const b = Math.min(samples.length, a + sampleRate);
    let sum = 0;
    for (let i = a; i < b; i++) sum += samples[i] * samples[i];
    out[s] = quantize(Math.sqrt(sum / Math.max(1, b - a)));
  }
  return out;
}

export function encodeLevels(levels) {
  let s = '';
  for (let i = 0; i < levels.length; i += 0x8000) s += String.fromCharCode(...levels.subarray(i, i + 0x8000));
  return btoa(s);
}

export function decodeLevels(b64) {
  try {
    const s = atob(b64 || '');
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

// `count` bar heights from 0 to 1, or -1 where nothing has been decoded yet. Heights are
// relative to the loud end of the episode (95th percentile), so one spike can't flatten it.
export function barHeights(levels, count) {
  const out = new Float32Array(count).fill(-1);
  const n = levels.length;
  if (!n || !count) return out;
  const known = [];
  for (let i = 0; i < n; i++) if (levels[i]) known.push(levels[i]);
  if (!known.length) return out;
  known.sort((a, b) => a - b);
  const peak = Math.max(4, known[Math.floor((known.length - 1) * 0.95)]);
  for (let b = 0; b < count; b++) {
    const from = Math.floor((b * n) / count);
    const to = Math.max(from + 1, Math.floor(((b + 1) * n) / count));
    let v = 0;
    let seen = false;
    for (let i = from; i < to && i < n; i++) {
      if (!levels[i]) continue;
      seen = true;
      if (levels[i] > v) v = levels[i];
    }
    if (seen) out[b] = Math.min(1, Math.pow(v / peak, 0.75));
  }
  return out;
}
