// Splits audio into Whisper-sized windows at the quietest moment, so words aren't chopped.

export const SAMPLE_RATE = 16000;
export const MAX_SEG = 29.5 * SAMPLE_RATE; // Whisper sees 30 s windows
export const MIN_SEG = 18 * SAMPLE_RATE;   // look for a pause between 18 s and 29.5 s
export const FRAME = SAMPLE_RATE / 10;     // 100 ms energy frames
export const SILENCE_RMS = 0.0025;

export function rms(audio, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += audio[i] * audio[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

// Where to end the next segment: at the quietest 100 ms frame between 18 s and 29.5 s,
// so words don't get chopped. Returns null if we need more audio first.
export function nextCut(audio, start, final) {
  const left = audio.length - start;
  if (left <= 0) return null;
  if (left <= MAX_SEG) return final ? audio.length : null;
  let cut = start + MAX_SEG;
  let best = Infinity;
  for (let p = start + MIN_SEG; p + FRAME <= start + MAX_SEG; p += FRAME / 2) {
    const e = rms(audio, p, p + FRAME);
    if (e < best) {
      best = e;
      cut = p + FRAME / 2;
    }
  }
  return cut;
}
