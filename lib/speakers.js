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

  // The closest voice, without learning from the print: for snippets too short to trust alone.
  nearest(print, { exclude = new Set(), min = 0.25 } = {}) {
    const v = unit(print);
    let best = null;
    let bestSim = min;
    this.list.forEach((voice, i) => {
      if (exclude.has(i)) return;
      const s = cosine(v, voice.c);
      if (s >= bestSim) { bestSim = s; best = i; }
    });
    return best;
  }

  toJSON() {
    return this.list.map((v) => ({ c: Array.from(v.c, (x) => Math.round(x * 1e4) / 1e4), n: Math.round(v.n * 10) / 10 }));
  }
}

// The voices of one window's local speakers (lib/diarize.js numbers them per 10 s piece: piece
// i has 3i, 3i+1, 3i+2). Long snippets are matched as usual. A short one only picks among the
// voices already heard, and never the voice of another speaker in its own piece: the
// segmentation model has already said they are different people.
export function assignLocals(voices, prints, { piece = (spk) => Math.floor(spk / 3) } = {}) {
  const local = {};
  const entries = Object.entries(prints).sort((a, b) => b[1].seconds - a[1].seconds);
  for (const [spk, { print, seconds }] of entries) {
    if (seconds >= MIN_NEW_VOICE_SEC) { local[spk] = voices.match(print, seconds); continue; }
    const taken = new Set(Object.entries(local).filter(([s, v]) => v != null && piece(Number(s)) === piece(Number(spk))).map(([, v]) => v));
    local[spk] = voices.nearest(print, { exclude: taken });
  }
  return local;
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
    const g = `${p.start}:${p.end}`;
    for (const x of sentences) {
      const end = Math.min(p.end, at + ((p.end - p.start) * x.length) / total);
      out.push({ ...p, start: at, end, text: x, g });
      at = end;
    }
    out[out.length - 1].end = p.end;
  }
  return out;
}

// Sentence times again, now that the window's turns are known: a part's time is shared out
// over the stretches where someone is talking, not over the pauses too. A pause at a change of
// speaker otherwise shifts every sentence after it, and the question before an answer ends up
// timed inside the answer.
// mode 'window' ignores Whisper's own times inside the window altogether (small models are often
// seconds off), and 'blend' averages the two.
export function retimeParts(parts, turns, mode = 'part') {
  if (mode === 'blend') {
    const a = retimeParts(parts, turns, 'part');
    const b = retimeParts(parts, turns, 'window');
    return a.map((p, i) => ({ ...p, start: (p.start + b[i].start) / 2, end: (p.end + b[i].end) / 2 }));
  }
  const out = parts.map((p) => ({ ...p, ...(mode === 'window' ? { g: 'w' } : {}) }));
  for (let i = 0; i < out.length;) {
    let j = i;
    while (j + 1 < out.length && out[j + 1].g != null && out[j + 1].g === out[i].g) j++;
    if (j > i) {
      const s = out[i].start;
      const e = out[j].end;
      const speech = mergeSpans(turns.map((t) => [Math.max(s, t.start), Math.min(e, t.end)]).filter(([a, b]) => b > a));
      const talk = speech.reduce((n, [a, b]) => n + b - a, 0);
      if (talk >= 0.3 * (e - s)) {
        // Wall time at `x` seconds of speech into the part.
        // A start that falls exactly at the end of a stretch belongs at the start of the next.
        const wall = (x, start = false) => {
          for (const [a, b] of speech) {
            if (start ? x < b - a : x <= b - a) return a + x;
            x -= b - a;
          }
          return e;
        };
        const chars = out.slice(i, j + 1).reduce((n, p) => n + p.text.length, 0);
        let done = 0;
        for (let k = i; k <= j; k++) {
          const share = (talk * out[k].text.length) / chars;
          out[k].start = k === i ? s : wall(done, true);
          done += share;
          out[k].end = k === j ? e : wall(done);
        }
      }
    }
    i = j + 1;
  }
  return out;
}

function mergeSpans(spans) {
  const sorted = spans.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// Words a reply or a new turn often starts with.
const OPENER = /^["“]?(?:well|so|yeah|yes|no|right|okay|ok|sure|look|i mean|and so|but|now|absolutely|exactly|great|thanks|thank you)\b/i;

// Each text part gets a speaker, chosen for the whole window at once (Viterbi): a part costs its
// length times the share of it someone else talks in, and each change of speaker costs
// `switchCost` seconds, half that right after a question. One sentence then doesn't flip
// against the evidence around it, and the edge of a turn falls where the talk does.
// Parts nobody is heard in cost nothing either way, so they stay with their neighbours.
export function labelParts(parts, turns, localToVoice, previous = null, { switchCost = 0.8, retime = 'part' } = {}) {
  const timed = retime ? retimeParts(parts, turns, retime) : parts;
  const talk = timed.map((p) => {
    const m = {};
    for (const t of turns) {
      const o = Math.min(p.end, t.end) - Math.max(p.start, t.start);
      const v = localToVoice[t.spk];
      if (o > 0 && v != null) m[v] = (m[v] || 0) + o;
    }
    return m;
  });
  const voices = [...new Set([...talk.flatMap((m) => Object.keys(m).map(Number)), ...(previous != null ? [previous] : [])])];
  if (!voices.length || switchCost == null) return labelEach(parts, talk, previous);
  const cost = (i, v) => {
    const total = Object.values(talk[i]).reduce((a, b) => a + b, 0);
    return total ? (timed[i].end - timed[i].start) * (1 - (talk[i][v] || 0) / total) : 0;
  };
  const change = (i) => {
    let c = switchCost;
    if (/[?¿]["”’)]?$/.test(parts[i - 1]?.text?.trim() || '')) c /= 2;
    if (OPENER.test(parts[i]?.text?.trim() || '')) c /= 2;
    return c;
  };
  let prev = voices.map((v) => (previous == null || v === previous ? 0 : switchCost) + cost(0, v));
  const back = [];
  for (let i = 1; i < parts.length; i++) {
    const row = [];
    const cur = voices.map((v, a) => {
      let best = Infinity;
      voices.forEach((u, b) => {
        const c = prev[b] + (a === b ? 0 : change(i));
        if (c < best) { best = c; row[a] = b; }
      });
      return best + cost(i, v);
    });
    back.push(row);
    prev = cur;
  }
  let k = prev.indexOf(Math.min(...prev));
  const path = [k];
  for (let i = back.length - 1; i >= 0; i--) { k = back[i][k]; path.unshift(k); }
  return parts.map((p, i) => ({ ...p, speaker: voices[path[i]] }));
}

// The plain way: each part to whoever talks most in it.
function labelEach(parts, talk, previous) {
  let last = previous;
  return parts.map((p, i) => {
    const [who] = Object.entries(talk[i]).sort((a, b) => b[1] - a[1])[0] || [];
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
// The host's name, when the show is named after them: "The Ezra Klein Show", "Plain English with
// Derek Thompson", "The Joe Rogan Experience", "Lex Fridman Podcast".
const PERSON = "\\p{Lu}[\\p{L}'’-]+(?:\\s\\p{Lu}[\\p{L}'’.-]+){1,2}";
export function hostFromShow(show) {
  const s = (show || '').trim();
  const m = s.match(new RegExp(`(?:with|med|avec|mit|con)\\s+(${PERSON})\\s*$`, 'u'))
    || s.match(new RegExp(`^(?:The\\s+)?(${PERSON}?)\\s+(?:Show|Podcast|Experience|Hour|Program|Interview|Pod)\\b`, 'u'));
  const name = m?.[1]?.replace(/[’']s$/, '');
  return name && /\s/.test(name) && !/^(?:The|This|Daily|Weekly|Morning|Evening|Big|Real|Last)\s/.test(name) ? name : null;
}

// `host`: the host's name if known (hostFromShow). Hosts welcome guests and ask the questions.
export function guessNames(segments, people, { host = null } = {}) {
  const names = [...new Set([...(people || []), ...(host ? [host] : [])])].filter((n) => /^\p{Lu}[\p{L}'’-]+(\s\p{Lu}[\p{L}'’.-]+){1,2}$/u.test(n));
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
    // Whoever welcomes a guest, or says the show's name, is the host.
    if (host && (new RegExp(`(?<![\\p{L}])${WELCOME}(?: back)? to the (?:show|program|podcast)|(?<![\\p{L}])${WELCOME},?\\s+\\p{Lu}`, 'iu').test(s.text) || s.text.toLowerCase().includes(host.toLowerCase()))) vote(s.speaker, host, 2);
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
  // Still no host: the voice that asks by far the most questions (with a minute of talk) is it.
  if (host && !used.has(host)) {
    const asks = {};
    for (const x of segs) if (x.speaker != null && /\?["”]?$/.test(x.text.trim())) asks[x.speaker] = (asks[x.speaker] || 0) + 1;
    const [[top, n] = [], [, m = 0] = []] = Object.entries(asks).sort((a, b) => b[1] - a[1]);
    if (top != null && out[top] == null && n >= 3 && n >= 2 * m && (talk[top] || 0) >= 60) out[top] = host;
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

// Voices again, with hindsight. Matching voice prints as they arrive (Voices) has to decide on
// every window from what it has heard so far; an early mistake (a guest's first answer taken
// for the host, a laugh starting a new voice) then sticks for the whole episode. Once every
// window's prints are in, they are clustered together instead: the two most alike groups merge
// (average similarity, weighted by seconds of speech) until no two groups are alike enough, and
// then each print moves to the group it is nearest a few times over. Prints from short snippets
// don't form groups of their own; they join the nearest one if it is close enough.
// items: [{ print, seconds }] -> a group id per item (null for a snippet that fits nowhere),
// numbered by talk time, most first.
export function clusterVoices(items, { threshold = 0.45, minSeconds = MIN_NEW_VOICE_SEC, rounds = 3 } = {}) {
  const prints = items.map((x) => unit(x.print));
  const long = items.map((x, i) => i).filter((i) => items[i].seconds >= minSeconds);
  // Average-linkage agglomerative clustering on the long prints.
  let groups = long.map((i) => [i]);
  const sim = new Map();
  const key = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  const pairSim = (i, j) => {
    const k = key(i, j);
    if (!sim.has(k)) sim.set(k, cosine(prints[i], prints[j]));
    return sim.get(k);
  };
  const link = (g, h) => {
    let s = 0;
    let w = 0;
    for (const i of g) for (const j of h) {
      const wt = items[i].seconds * items[j].seconds;
      s += pairSim(i, j) * wt;
      w += wt;
    }
    return s / w;
  };
  for (;;) {
    let best = -Infinity;
    let bi = -1;
    let bj = -1;
    for (let a = 0; a < groups.length; a++) {
      for (let b = a + 1; b < groups.length; b++) {
        const s = link(groups[a], groups[b]);
        if (s > best) { best = s; bi = a; bj = b; }
      }
    }
    if (bi < 0 || best < threshold) break;
    groups[bi] = groups[bi].concat(groups[bj]);
    groups.splice(bj, 1);
  }
  const centroid = (members) => {
    const c = new Float32Array(prints[0]?.length || 0);
    for (const i of members) for (let d = 0; d < c.length; d++) c[d] += prints[i][d] * items[i].seconds;
    return unit(c);
  };
  // Refine: each print to its nearest group centre, short ones only when close enough.
  let assign = new Array(items.length).fill(null);
  groups.forEach((g, gi) => { for (const i of g) assign[i] = gi; });
  for (let r = 0; r < rounds && groups.length; r++) {
    const centres = groups.map((g, gi) => centroid(assign.map((a, i) => (a === gi ? i : -1)).filter((i) => i >= 0)));
    assign = prints.map((p, i) => {
      let best = null;
      let bestSim = -Infinity;
      centres.forEach((c, gi) => {
        const s = cosine(p, c);
        if (s > bestSim) { bestSim = s; best = gi; }
      });
      const need = items[i].seconds >= minSeconds ? -Infinity : threshold * 0.7;
      return bestSim >= need ? best : null;
    });
  }
  // Number groups by talk time.
  const talk = {};
  assign.forEach((a, i) => { if (a != null) talk[a] = (talk[a] || 0) + items[i].seconds; });
  const order = Object.keys(talk).map(Number).sort((a, b) => talk[b] - talk[a]);
  const rename = Object.fromEntries(order.map((g, n) => [g, n]));
  return assign.map((a) => (a == null ? null : rename[a]));
}
