// Where the ads are in an episode, as time ranges the player can jump over, worked out from the
// transcript. Sponsor reads are found by their wording (lib/pitch.js); a break then runs from the
// last words of the show before it to the first words after it, taking in what belongs to it:
// the paragraphs between two reads, a spot in a voice heard nowhere else, the music around it.
// It errs towards leaving an ad in: what isn't clearly one is never skipped.
import { paragraphs, paragraphText } from './paragraphs.js';
import { adCues } from './pitch.js';

export const ADS_VERSION = 3; // (3: an ad's brand is in its ad wording and not said elsewhere; the show coming back is never an ad)

const SAME_VOICE_BRIDGE = 45; // seconds of the same voice between two reads that still count as one break
const NAMED_BRIDGE = 150; // ...when it names what the read sells, all in its voice (a long read, cues at both ends)
const OTHER_BRIDGE = 12;
const MIN_BREAK = 8;
const MAX_BREAK = 360; // longer than this and it is more likely a mistake than an ad
const MAX_LONG_BREAK = 600; // several reads in a row
const PAUSE = 1.5; // a silence this long inside a paragraph is where an ad starts or stops
const EDGE = 20; // music or silence taken in on either side

// The names an ad sells under ("SimpliSafe", "Hulu"): said more than once in it, at least once
// in a sentence worded as an ad, and not heard in the rest of the episode, away from it. So not
// the show's own name or its guest's, which a host's plug for the show's newsletter says too.
const NAME = /(?<![\p{L}\d])\p{Lu}[\p{L}\d'’-]{2,}/gu;
const NOT_NAMES = new Set(['The', 'And', 'But', 'So', 'Now', 'This', 'That', 'With', 'When', 'What', 'Our', 'Your', 'You', 'We', 'It', 'If', 'Right', 'Okay', 'Alright', 'Here', 'There', 'They', 'She', 'He', 'Just', 'Today', 'Visit', 'Get', 'Try', 'For', 'Plus', 'Terms', 'Go', 'Head']);
const sentencesOf = (text) => text.split(/(?<=[.!?])\s+/);
function soldNames(adParas, allParas) {
  const from = adParas[0].start;
  const to = adParas[adParas.length - 1].end;
  const count = new Map();
  const cued = new Set();
  for (const p of adParas) {
    for (const sentence of sentencesOf(paragraphText(p))) {
      const c = adCues(sentence);
      for (const w of sentence.match(NAME) || []) {
        if (NOT_NAMES.has(w)) continue;
        count.set(w, (count.get(w) || 0) + 1);
        if (c.strong || c.weak) cued.add(w);
      }
    }
  }
  const elsewhere = new Set();
  for (const p of allParas) if (p.end < from - NAMED_BRIDGE || p.start > to + NAMED_BRIDGE) for (const w of paragraphText(p).match(NAME) || []) elsewhere.add(w);
  return new Set([...count].filter(([w, n]) => n >= 2 && cued.has(w) && !elsewhere.has(w)).map(([w]) => w));
}
const namesIn = (text) => text.match(NAME) || [];

// Words that bring the show back: never part of an ad, however close to one.
const RESUMES = /\b(?:welcome(?: back)? to|(?:my|our) (?:conversation|interview|chat|talk) with|joining (?:me|us)|back to the show|(?:and )?we(?:'re| are) back|let['’]?s get (?:back )?(?:into|to) it|on the show today|today on the show)\b/i;

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
  // Where each voice is first and last heard, by paragraph.
  const span = new Map();
  paras.forEach((p, k) => { if (p.speaker == null) return; const v = span.get(p.speaker); if (v) v.last = k; else span.set(p.speaker, { first: k, last: k }); });
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
      // (Show talk between two reads does not name the first one's brand; a long read's middle does.)
      const names = soldNames(paras.slice(first, last + 1), paras);
      let named = false;
      for (let k = last + 1; k < paras.length; k++) {
        oneVoice = oneVoice && sameVoice(here, paras[k]);
        const bridge = oneVoice ? (named ? NAMED_BRIDGE : SAME_VOICE_BRIDGE) : OTHER_BRIDGE;
        if (paras[k].start - here.end > Math.max(bridge, SAME_VOICE_BRIDGE)) break;
        if (paras[k].ad) {
          if (paras[k].start - here.end <= bridge) next = k;
          break;
        }
        named = oneVoice && (named || namesIn(paragraphText(paras[k])).some((w) => names.has(w)));
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

    // The read's own sign-off, a short line of its own in the same voice right after it, naming
    // what it sold: "SimpliSafe, ahead of crime, in real time."
    const signOff = paras[last + 1];
    if (signOff && signOff.speaker === paras[last].speaker && signOff.start - paras[last].end <= 3 && signOff.end - signOff.start <= 12 && !RESUMES.test(paragraphText(signOff))) {
      const names = soldNames(paras.slice(first, last + 1), paras);
      if (namesIn(paragraphText(signOff)).some((w) => names.has(w))) last++;
    }

    // A voice that reads an ad here and is heard nowhere else in the episode (an announcer's
    // spot, one half of it worded like an ad and the other not): all of what it says, beside it.
    const adVoices = new Set(paras.slice(first, last + 1).filter((p) => p.ad && p.speaker != null).map((p) => p.speaker));
    // (Only from a paragraph of that voice to the next of the same voice: never across a change.)
    const onlyHere = (k, edge, lo, hi) => {
      const v = paras[k].speaker;
      const at = span.get(v);
      return v != null && v === paras[edge].speaker && adVoices.has(v) && at.first >= lo && at.last <= hi;
    };
    for (let grew = true; grew;) {
      grew = false;
      if (first > 0 && paras[first].start - paras[first - 1].end <= 3 && onlyHere(first - 1, first, first - 1, last)) { first--; grew = true; }
      if (last + 1 < paras.length && paras[last + 1].start - paras[last].end <= 3 && onlyHere(last + 1, last, first, last + 1)) { last++; grew = true; }
    }

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
      // (Never the words that bring the show back.)
      const back = tail.findIndex((x, j) => j > lastCue && RESUMES.test(x.text));
      if (back >= 0 && endAt >= back) endAt = back - 1;
      // ...but a line just after, pause or not, that names what was sold is its sign-off.
      const sold = soldNames(paras.slice(first, last + 1), paras);
      while (endAt + 1 < tail.length && tail[endAt + 1].end - tail[lastCue].end <= 15 && !RESUMES.test(tail[endAt + 1].text) && namesIn(tail[endAt + 1].text).some((w) => sold.has(w))) endAt++;
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
