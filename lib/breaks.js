// Where the ads are in an episode, as time ranges the player can jump over, worked out from the
// transcript. Sponsor reads are found by their wording (lib/pitch.js); a break then runs from the
// last words of the show before it to the first words after it, taking in what belongs to it:
// the paragraphs between two reads, a spot in a voice heard nowhere else, the music around it.
// It errs towards leaving an ad in: what isn't clearly one is never skipped.
import { paragraphs, paragraphText } from './paragraphs.js';
import { adCues } from './pitch.js';

export const ADS_VERSION = 1;

const SAME_VOICE_BRIDGE = 45; // seconds of the same voice between two reads that still count as one break
const OTHER_BRIDGE = 12;
const MIN_BREAK = 8;
const MAX_BREAK = 360; // longer than this and it is more likely a mistake than an ad
const MAX_LONG_BREAK = 600; // several reads in a row
const PAUSE = 1.5; // a silence this long inside a paragraph is where an ad starts or stops
const EDGE = 20; // music or silence taken in on either side

// segments: [{ start, end, text, speaker? }]; minor: Set of voice ids heard only in passing
// (lib/speakers.js minorVoices). -> [[start, end], ...] in seconds, in order.
export function adBreaks(segments, { minor = null } = {}) {
  const paras = paragraphs(segments || []).map((p) => {
    const cues = adCues(paragraphText(p));
    return {
      start: p.segs[0].start,
      end: p.segs[p.segs.length - 1].end,
      speaker: p.speaker,
      segs: p.segs,
      ad: cues.strong > 0 || cues.weak >= 2,
      adish: cues.weak > 0,
      strong: cues.strong,
      minor: !!minor && p.speaker != null && minor.has(Number(p.speaker)),
    };
  });
  const sameVoice = (a, b) => a.speaker == null || b.speaker == null || a.speaker === b.speaker;
  const out = [];
  for (let i = 0; i < paras.length; i++) {
    if (!paras[i].ad) continue;
    let first = i;
    let last = i;
    // Forward: more reads, and what sits between them.
    for (;;) {
      const here = paras[last];
      let next = -1;
      let oneVoice = true;
      for (let k = last + 1; k < paras.length; k++) {
        oneVoice = oneVoice && sameVoice(here, paras[k]);
        if (paras[k].start - here.end > SAME_VOICE_BRIDGE) break;
        if (paras[k].ad) {
          if (paras[k].start - here.end <= (oneVoice ? SAME_VOICE_BRIDGE : OTHER_BRIDGE)) next = k;
          break;
        }
      }
      if (next < 0) {
        const after = paras[last + 1];
        // A paragraph right after with one cue of its own, or a short spot in a passing voice.
        if (after && after.start - here.end <= 5 && (after.adish || (after.minor && after.end - after.start <= 90))) { last++; continue; }
        break;
      }
      last = next;
    }
    const before = paras[first - 1];
    if (before && paras[first].start - before.end <= 3 && !before.ad && (before.adish || (before.minor && before.end - before.start <= 90))) first--;

    // Inside the first paragraph the read may start after a stretch of the show, and inside the
    // last one the show may carry on after it. A pause marks the join; without one, a few
    // seconds after the last cue are the ad's own sign-off, and anything longer is the show.
    let start = paras[first].start;
    const head = paras[first];
    if (head.ad) {
      const at = head.segs.findIndex((s) => adCues(s.text).opener);
      if (at > 0 && (head.segs[at].start - head.start >= 8 || head.segs[at].start - head.segs[at - 1].end >= PAUSE)) start = head.segs[at].start;
    }
    const tail = paras[last].segs;
    let lastCue = -1;
    tail.forEach((s, k) => { const c = adCues(s.text); if (c.strong || c.weak) lastCue = k; });
    let endAt = tail.length - 1;
    if (lastCue >= 0) {
      endAt = lastCue;
      let k = lastCue + 1;
      while (k < tail.length && tail[k].start - tail[k - 1].end < PAUSE && tail[k].end - tail[lastCue].end < 15) endAt = k++;
      if (k < tail.length && tail[k].start - tail[k - 1].end < PAUSE) endAt = lastCue;
    }
    let end = tail[endAt].end;

    // Out to the words on either side, so music beds and pauses go with the ad.
    const prevEnd = Math.max(0, ...segments.filter((s) => s.end <= start + 0.01 && s.text?.trim()).map((s) => s.end));
    const nextSeg = segments.find((s) => s.start >= end - 0.01 && s.text?.trim());
    if (start - prevEnd <= EDGE) start = prevEnd ? prevEnd + 0.3 : 0;
    if (nextSeg && nextSeg.start - end <= EDGE) end = Math.max(end, nextSeg.start - 0.3);

    const reads = paras.slice(first, last + 1).filter((p) => p.ad).length;
    const length = end - start;
    if (length >= MIN_BREAK && length <= (reads > 1 ? MAX_LONG_BREAK : MAX_BREAK)) {
      const prev = out[out.length - 1];
      if (prev && start - prev[1] <= 1) prev[1] = Math.max(prev[1], end);
      else out.push([start, end]);
    }
    i = last;
  }
  return out.map(([a, b]) => [Math.round(a * 10) / 10, Math.round(b * 10) / 10]);
}

// The break `t` is in, as its index, or -1.
export function breakAt(breaks, t) {
  for (let i = 0; i < (breaks?.length || 0); i++) {
    if (t >= breaks[i][0] && t < breaks[i][1]) return i;
    if (breaks[i][0] > t) break;
  }
  return -1;
}

export const adSeconds = (breaks) => (breaks || []).reduce((n, [a, b]) => n + (b - a), 0);
