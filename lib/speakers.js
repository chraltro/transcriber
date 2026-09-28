// Who is speaking. Each window is split into turns by a segmentation model (pyannote), each
// local speaker gets a voice print (WeSpeaker), and voice prints are matched against the voices
// heard so far in the episode, so "Speaker 2" stays the same person from start to end.
// Everything here is plain arithmetic; lib/diarize.js runs the models.

// pyannote segmentation-3.0 predicts one of 7 classes per ~17 ms frame: nobody, one of three
// speakers, or two of them at once.
export const POWERSET = [[], [0], [1], [2], [0, 1], [0, 2], [1, 2]];

// Frame classes -> single-speaker turns [{ spk, start, end }] in seconds. Overlapping speech and
// blips shorter than `minSec` are left out; turns of one speaker across a short gap are joined.
export function framesToTurns(classes, frameSec, { minSec = 0.25, joinGapSec = 0.3 } = {}) {
  const raw = [];
  let cur = null;
  classes.forEach((c, i) => {
    const who = POWERSET[c] || [];
    const spk = who.length === 1 ? who[0] : -1;
    if (cur && cur.spk === spk) { cur.end = (i + 1) * frameSec; return; }
    if (cur && cur.spk >= 0) raw.push(cur);
    cur = { spk, start: i * frameSec, end: (i + 1) * frameSec };
  });
  if (cur && cur.spk >= 0) raw.push(cur);
  const turns = [];
  for (const t of raw.filter((r) => r.end - r.start >= minSec)) {
    const last = turns[turns.length - 1];
    if (last && last.spk === t.spk && t.start - last.end <= joinGapSec) last.end = t.end;
    else turns.push({ ...t });
  }
  return turns;
}

export function speechSeconds(turns) {
  const out = {};
  for (const t of turns) out[t.spk] = (out[t.spk] || 0) + (t.end - t.start);
  return out;
}

function unit(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
}

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// The voices heard so far, as running averages of unit-length voice prints.
export const MIN_NEW_VOICE_SEC = 2.5;

export class Voices {
  constructor(saved = [], { threshold = 0.5 } = {}) {
    this.threshold = threshold;
    this.list = (saved || []).map((v) => ({ c: Float32Array.from(v.c), n: v.n || 1 }));
  }

  // The id of the voice this print belongs to, adding a new voice if none is close enough.
  // `weight` is how much speech the print came from; short snippets move the average less.
  match(print, weight = 1) {
    const v = unit(print);
    let best = -1;
    let bestSim = -Infinity;
    this.list.forEach((voice, i) => {
      const s = cosine(v, voice.c);
      if (s > bestSim) { bestSim = s; best = i; }
    });
    if (best >= 0 && bestSim >= this.threshold) {
      const voice = this.list[best];
      const n = Math.min(voice.n, 30); // keep adapting as the recording drifts
      voice.c = unit(voice.c.map((x, i) => x * n + v[i] * weight));
      voice.n += weight;
      return best;
    }
    // A short snippet makes a shaky print: it may join a voice it is fairly close to, but it
    // never starts a new one (that is how one person turned into three).
    if (weight < MIN_NEW_VOICE_SEC) return best >= 0 && bestSim >= this.threshold * 0.7 ? best : null;
    this.list.push({ c: v, n: weight });
    return this.list.length - 1;
  }

  toJSON() {
    return this.list.map((v) => ({ c: Array.from(v.c, (x) => Math.round(x * 1e4) / 1e4), n: Math.round(v.n * 10) / 10 }));
  }
}

// Whisper's smaller models often time a whole 20 s stretch as one part. Splitting it into
// sentences, with times shared out by length (speech runs at a fairly even pace), lets a change
// of speaker fall between sentences instead of swallowing the reply into the question.
const SENTENCE = /(?<=[.!?…]["”’)]?)\s+(?=["“‘(]?[\p{Lu}\d])/u;
export function sentenceParts(parts) {
  const out = [];
  for (const p of parts) {
    const sentences = p.text.split(SENTENCE).map((x) => x.trim()).filter(Boolean);
    if (sentences.length < 2) { out.push(p); continue; }
    const total = sentences.reduce((n, x) => n + x.length, 0);
    let at = p.start;
    for (const x of sentences) {
      const end = Math.min(p.end, at + ((p.end - p.start) * x.length) / total);
      out.push({ ...p, start: at, end, text: x });
      at = end;
    }
    out[out.length - 1].end = p.end;
  }
  return out;
}

// Each text part gets the speaker who talks most during it. Parts nobody clearly talks in keep
// the speaker before them.
export function labelParts(parts, turns, localToVoice, previous = null) {
  let last = previous;
  return parts.map((p) => {
    const talk = {};
    for (const t of turns) {
      const o = Math.min(p.end, t.end) - Math.max(p.start, t.start);
      if (o > 0 && localToVoice[t.spk] != null) talk[localToVoice[t.spk]] = (talk[localToVoice[t.spk]] || 0) + o;
    }
    const [who] = Object.entries(talk).sort((a, b) => b[1] - a[1])[0] || [];
    const speaker = who != null ? Number(who) : last;
    last = speaker;
    return speaker == null ? { ...p } : { ...p, speaker };
  });
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Names for voices, from how podcasts talk: "I'm Derek Thompson" names the voice saying it;
// "Arvind Narayanan, welcome to the show" and "Arvind, what is the strongest evidence?" at the
// end of a turn name the next voice to speak. Hosts address guests by name all through an
// episode, so the votes add up even when one introduction is misheard or too short to place.
// Only names from `people` count, so "This is Plain English" names nobody.
export function guessNames(segments, people) {
  const names = [...new Set(people || [])].filter((n) => /^\p{Lu}[\p{L}'’-]+(\s\p{Lu}[\p{L}'’-]+){1,2}$/u.test(n));
  if (!names.length) return {};
  const votes = new Map(); // voice -> Map(name -> weight)
  const vote = (voice, name, w) => {
    if (voice == null) return;
    if (!votes.has(voice)) votes.set(voice, new Map());
    const m = votes.get(voice);
    m.set(name, (m.get(name) || 0) + w);
  };
  const segs = segments.filter((s) => s.text);
  // The next voice after segment i, if it starts soon enough to be a reply.
  const nextVoice = (i) => {
    const s = segs[i];
    const next = segs.slice(i + 1).find((x) => x.speaker != null && x.speaker !== s.speaker);
    return next && next.start - (s.end ?? s.start) < 20 ? next.speaker : null;
  };
  // Is segment i the last (or next to last) of its speaker's turn?
  const endsTurn = (i) => [1, 2].some((k) => segs[i + k] && segs[i + k].speaker != null && segs[i + k].speaker !== segs[i].speaker
    && segs.slice(i + 1, i + k).every((x) => x.speaker === segs[i].speaker || x.speaker == null));
  segs.forEach((s, i) => {
    for (const name of names) {
      const first = name.split(/\s/)[0];
      const n = `(?:${esc(name)}|${esc(first)})`;
      if (new RegExp(`\\b(?:I'm|I am|my name is|my name's)\\s+${esc(name)}\\b`, 'i').test(s.text)) vote(s.speaker, name, 3);
      if (new RegExp(`\\b${n},?\\s+welcome\\b|\\bwelcome(?: back)?(?: to the (?:show|program|podcast))?,?\\s+${n}\\b`, 'i').test(s.text)) vote(nextVoice(i), name, 2);
      // "Arvind, what is ..." or "... right, Sayash?" closing a turn.
      if (endsTurn(i) && new RegExp(`(?:^|[.?!]\\s+)${n},\\s|,\\s*${n}[?.!]?$`).test(s.text)) vote(nextVoice(i), name, 1);
    }
  });
  // Best-supported pairs first; each name and each voice used once.
  const pairs = [];
  for (const [voice, m] of votes) for (const [name, c] of m) pairs.push({ voice, name, c });
  pairs.sort((a, b) => b.c - a.c);
  const out = {};
  const used = new Set();
  for (const { voice, name, c } of pairs) {
    if (out[voice] != null || used.has(name) || c < 2) continue;
    out[voice] = name;
    used.add(name);
  }
  return out;
}

export const speakerName = (id, names = {}) => names[id] || `Speaker ${Number(id) + 1}`;
