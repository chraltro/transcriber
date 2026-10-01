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

// "I'm" and "welcome" in the app's languages.
const INTRO = "(?<![\\p{L}])(?:I'm|I am|my name is|my name's|jeg er|jeg heter|jeg hedder|mitt navn er|mit navn er|je suis|je m'appelle|moi c'est|ich bin|ich heiße|mein name ist|soy|me llamo|mi nombre es|sono|mi chiamo|il mio nome è)";
const WELCOME = '(?:welcome|velkommen|bienvenue|bienvenu|bienvenus|willkommen|herzlich willkommen|bienvenido|bienvenida|bienvenidos|benvenuto|benvenuta|benvenuti)';

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
    if (voice == null || !name) return;
    if (!votes.has(voice)) votes.set(voice, new Map());
    const m = votes.get(voice);
    m.set(name, (m.get(name) || 0) + w);
  };
  const segs = segments.filter((s) => s.text);
  const end = (s) => s.end ?? s.start;
  // Where each segment's turn ends, and the voice that speaks next (if soon enough to be a reply).
  const turnEnd = new Array(segs.length);
  const next = new Array(segs.length);
  for (let i = segs.length - 1; i >= 0; i--) {
    const later = segs[i + 1];
    const same = later && (later.speaker === segs[i].speaker || later.speaker == null);
    turnEnd[i] = same ? turnEnd[i + 1] : end(segs[i]);
    next[i] = same ? next[i + 1] : later ? { speaker: later.speaker, start: later.start } : null;
  }
  const replyFrom = (i, within) => (next[i] && next[i].start - end(segs[i]) <= within ? next[i].speaker : null);
  // A first name as Whisper may spell it ("Sayyash" for "Sayash").
  const firsts = names.map((n) => ({ name: n, first: n.split(/\s/)[0].toLowerCase() }));
  const byFirst = (word) => {
    const w = word.toLowerCase();
    const hits = firsts.filter((f) => f.first === w || (f.first.length >= 4 && w[0] === f.first[0] && lev(w, f.first) <= (f.first.length >= 6 ? 2 : 1)));
    return hits.length === 1 ? hits[0].name : null;
  };
  segs.forEach((s, i) => {
    for (const name of names) {
      if (new RegExp(`${INTRO}\\s+${esc(name)}(?![\\p{L}])`, 'iu').test(s.text)) vote(s.speaker, name, 3);
      const n = `(?:${esc(name)}|${esc(name.split(/\s/)[0])})`;
      if (new RegExp(`(?<![\\p{L}])${n},?\\s+${WELCOME}(?![\\p{L}])|(?<![\\p{L}])${WELCOME}(?: back| tilbake| igen| de nouveau| zurück| de nuevo| di nuovo)?(?: to the (?:show|program|podcast)| (?:dans|à) (?:l'émission|le podcast)| (?:in der sendung|im podcast|bei uns)| (?:al (?:programa|podcast))| (?:nel podcast|in trasmissione))?,?\\s+${n}(?![\\p{L}])`, 'iu').test(s.text)) vote(replyFrom(i, 45), name, replyFrom(i, 5) != null ? 2 : 1); // an immediate reply is strong evidence
    }
    // "Arvind, what is ..." or "... right, Sayash?" near the end of a turn names who answers.
    if (turnEnd[i] - end(s) <= 20) {
      const words = [
        ...[...s.text.matchAll(/(?:^|[.?!]\s+)["“]?(?:So |And |Well |OK |Okay |Alors |Et |Also |Und |Bueno |Y |Allora |E |Så |Og )?(\p{Lu}[\p{L}'’-]+),\s/gu)].map((x) => x[1]),
        ...[...s.text.matchAll(/,\s*(\p{Lu}[\p{L}'’-]+)[?.!]?["”]?$/gu)].map((x) => x[1]),
      ];
      const who = words.map(byFirst).find(Boolean);
      if (who) vote(replyFrom(i, 30), who, 1);
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
  // Then single votes, where nothing competes: the voice talks for over a minute, the name is
  // still free, and it's the only name anyone was heard giving that voice.
  const talk = {};
  for (const x of segs) if (x.speaker != null) talk[x.speaker] = (talk[x.speaker] || 0) + Math.max(0, end(x) - x.start);
  for (const { voice, name } of pairs) {
    if (out[voice] != null || used.has(name) || (talk[voice] || 0) < 60) continue;
    if ([...votes.get(voice).keys()].filter((n) => !used.has(n)).length !== 1) continue;
    out[voice] = name;
    used.add(name);
  }
  return out;
}

function lev(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length];
}

export const speakerName = (id, names = {}) => names[id] || `Speaker ${Number(id) + 1}`;
