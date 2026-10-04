// Speaker benchmark: who-said-what against podcasts' own published transcripts. One recent
// episode per show (SOURCE), its first MINUTES through the app's real transcription and speaker
// code; the app's words are aligned with the transcript's, and each labelling method is scored on
// how many words get the right speaker, overall and at the edges of turns.
//   SOURCE: freshair, upfirst, planetmoney, freakonomics, lex, ferriss, cwt, 80k
import * as tf from '@huggingface/transformers';
import { execSync } from 'node:child_process';
import { StreamingTranscriber } from '../lib/stream.js';
import { transcribeWindow } from '../lib/prompted.js';
import { buildPrompt, extractTerms } from '../lib/context.js';
import { dtypeFor } from '../lib/models.js';
import { createDiarizer } from '../lib/diarize.js';
import { Voices, assignLocals, labelParts } from '../lib/speakers.js';
import { parseTranscript } from './transcripts.mjs';

// Where each show keeps its transcript, from the feed item's link and title.
const npr = ({ link }) => { const id = link.match(/nx-s1-\d+|\/(\d{9,})\//)?.[0]?.replace(/\//g, ''); return id ? `https://www.npr.org/transcripts/${id}` : link; };
const slug = (t) => t.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const SOURCES = {
  freshair: { term: 'Fresh Air NPR', kind: 'two people, NPR studio and remote', transcript: npr },
  upfirst: { term: 'Up First NPR', kind: 'news: hosts, reporters, many clips', transcript: npr },
  planetmoney: { term: 'Planet Money NPR', kind: 'two hosts, guests, tape', transcript: npr },
  freakonomics: { term: 'Freakonomics Radio', kind: 'narrated, many short voices', transcript: ({ title }) => `https://freakonomics.com/podcast/${slug(title.replace(/^\d+\.\s*/, ''))}/` },
  lex: { term: 'Lex Fridman Podcast', kind: 'long two-person interview' },
  ferriss: { term: 'The Tim Ferriss Show', kind: 'long two-person interview, ads read by the host' },
  cwt: { term: 'Conversations with Tyler', kind: 'fast two-person interview', transcript: ({ title }) => `https://conversationswithtyler.com/episodes/${slug(title.split(/ on /)[0])}/` },
  '80k': { term: '80,000 Hours Podcast', kind: 'two-person interview' },
};
const KEY = process.env.SOURCE || 'cwt';
const SRC = SOURCES[KEY];
const MINUTES = Number(process.env.MINUTES || 30);
const MODEL = process.env.MODEL || 'onnx-community/whisper-base.en';
const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' };

/* ---------- the published transcript ---------- */

async function getPage(url) {
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
    const html = await res.text();
    if (res.ok && !/<title>\s*(just a moment|access denied|attention required)/i.test(html)) return html;
  } catch {}
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, { headers: { 'X-Return-Format': 'html' }, signal: AbortSignal.timeout(60000) });
    if (res.ok) return await res.text();
  } catch {}
  return '';
}

async function findEpisode() {
  const s = await (await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(SRC.term)}&entity=podcast&limit=3`)).json();
  const show = s.results.find((r) => r.feedUrl);
  const xml = await (await fetch(show.feedUrl, { headers: UA })).text();
  const items = xml.split(/<item[\s>]/).slice(1, 9);
  for (const item of items) {
    const tag = (n) => (item.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`)) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim() || '';
    const title = tag('title');
    const link = tag('link');
    const audio = item.match(/<enclosure[^>]+url="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&');
    if (!link || !audio) continue;
    const page = SRC.transcript ? SRC.transcript({ link, title }) : link;
    let html = await getPage(page);
    // The transcript may be on a page of its own ("…-transcript", NPR's /transcripts/).
    const own = parseTranscript(html).length < 15 && html.match(/href="([^"]*(?:\/transcripts?\/[^"]+|-transcript\/?))"/i)?.[1];
    if (own) {
      const more = await getPage(new URL(own.replace(/&amp;/g, '&'), page).href);
      if (more) html = more;
    }
    const turns = parseTranscript(html);
    const words = turns.reduce((n, t) => n + t.text.split(/\s+/).length, 0);
    const speakers = new Set(turns.map((t) => t.speaker));
    console.log(`  ${title.slice(0, 70)}: ${turns.length} turns, ${speakers.size} speakers, ${words} words (${page})`);
    if (words >= 2000 && turns.length < 15) {
      // Lots of text but few speakers found: show what the lines look like.
      const lines = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<\/(p|div)>/gi, '\n').replace(/<[^>]+>/g, ' ').split('\n').map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x.length > 40);
      console.log(`    lines look like:\n${lines.slice(5, 17).map((x) => `      | ${x.slice(0, 140)}`).join('\n')}`);
    }
    if (turns.length >= 15 && speakers.size >= 2 && words >= 2500) {
      return { show: show.collectionName, title, link, audio, turns, notes: tag('description') };
    }
  }
  throw new Error('no recent episode with a transcript found');
}

/* ---------- the app ---------- */

const ep = await findEpisode();
const refSpeakers = [...new Set(ep.turns.map((t) => t.speaker))];
console.log(`\n${ep.show}: ${ep.title}\n${SRC.kind}; transcript: ${ep.turns.length} turns by ${refSpeakers.length} speakers (${refSpeakers.slice(0, 12).join(', ')})`);
console.log(`sample: ${ep.turns.slice(0, 3).map((t) => `${t.speaker}: ${t.text.slice(0, 90)}`).join(' | ')}`);
execSync(`curl -sSL --fail -A "${UA['user-agent']}" -H "Accept: audio/*,*/*" -o ep.mp3 "${ep.audio}"`);
const raw = execSync(`ffmpeg -loglevel error -t ${MINUTES * 60} -i ep.mp3 -ac 1 -ar 16000 -f f32le -`, { maxBuffer: 1 << 30 });
const audio = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const terms = extractTerms(ep.notes, ep.title, ep.show);

const asr = await tf.pipeline('automatic-speech-recognition', MODEL, { dtype: dtypeFor(MODEL, 'wasm') });
const VOICE = process.env.VOICE_MODEL || undefined;
const diarizer = await createDiarizer(tf, { voiceModel: VOICE });
let lastDiarized = null;
const diarize = async (samples, opts) => {
  const plain = await diarizer(samples);
  const spanPrints = [];
  for (const [a, b] of opts?.spans || []) {
    const from = Math.floor(a * 16000);
    const to = Math.min(samples.length, Math.floor(Math.min(b, a + 12) * 16000));
    spanPrints.push(to - from >= 8000 ? await diarizer.printOf(samples.subarray(from, to)) : null);
  }
  lastDiarized = { ...plain, spanPrints };
  return lastDiarized;
};
const windows = [];
const t0 = Date.now();
await new Promise((resolve, reject) => {
  const stream = new StreamingTranscriber({
    now: () => Date.now(),
    post: (m) => {
      if (m.type === 'segment') {
        windows.push({ start: m.start, parts: m.parts || [], ...(lastDiarized || { turns: [], prints: {}, spanPrints: [] }) });
        lastDiarized = null;
      }
      if (m.type === 'done') resolve();
    },
    diarize,
    transcribe: (samples, language, { previous } = {}) => transcribeWindow(asr, samples, { language, prompt: buildPrompt(terms, previous), timestamps: true }),
  });
  stream.start(1, { language: 'english', speakers: true });
  stream.push(1, audio, true).then(() => stream.ready(1)).catch(reject);
});
console.log(`${MODEL}: ${((audio.length / 16000) / ((Date.now() - t0) / 1000)).toFixed(1)}x realtime, ${windows.length} windows`);

// Every labelling method, replayed on the same speaker-model output.
function replay({ minPrint, short, smooth, retime, own, replies, threshold = 0.5, cap = 30 }) {
  const voices = new Voices([], { threshold, cap });
  let last = null;
  const out = [];
  for (const w of windows) {
    const prints = Object.fromEntries(Object.entries(w.prints).filter(([, p]) => p.seconds >= minPrint));
    let local;
    if (short) local = assignLocals(voices, prints);
    else {
      local = {};
      for (const [spk, { print, seconds }] of Object.entries(prints)) local[spk] = voices.match(print, seconds);
    }
    const rel = w.parts.map((p) => ({ ...p, start: p.start - w.start, end: p.end - w.start }));
    const labelled = labelParts(rel, w.turns, local, last, { switchCost: smooth ? 0.8 : null, retime: !!retime, ...(own ? { voices, spanPrints: w.spanPrints } : {}), replies: !!replies });
    if (labelled.length && labelled[labelled.length - 1].speaker != null) last = labelled[labelled.length - 1].speaker;
    out.push(...labelled.map((p) => ({ text: p.text, speaker: p.speaker ?? null })));
  }
  return out;
}
const unit = (v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return Float32Array.from(v, (x) => x / n); };
const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
// Voices with hindsight (tried for the app, kept here while it is measured): Matching voice prints as they arrive (Voices) has to decide on
// every window from what it has heard so far; an early mistake (a guest's first answer taken
// for the host, a laugh starting a new voice) then sticks for the whole episode. Once every
// window's prints are in, they are clustered together instead: the two most alike groups merge
// (average similarity, weighted by seconds of speech) until no two groups are alike enough, and
// then each print moves to the group it is nearest a few times over. Prints from short snippets
// don't form groups of their own; they join the nearest one if it is close enough.
// items: [{ print, seconds }] -> a group id per item (null for a snippet that fits nowhere),
// numbered by talk time, most first.
function clusterVoices(items, { threshold = 0.45, minSeconds = 2.5, rounds = 3 } = {}) {
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

// The same labelling, but with every window's local speakers mapped to voices clustered over the
// whole episode at once.
function hindsight({ threshold }) {
  const items = [];
  const at = [];
  windows.forEach((w, wi) => {
    for (const [spk, p] of Object.entries(w.prints)) if (p.seconds >= 0.4) { at.push([wi, spk]); items.push(p); }
  });
  const ids = clusterVoices(items, { threshold });
  const voices = new Voices();
  const sums = {};
  ids.forEach((g, k) => {
    if (g == null) return;
    const u = unit(items[k].print);
    sums[g] ||= { c: new Float32Array(u.length), n: 0 };
    for (let d = 0; d < u.length; d++) sums[g].c[d] += u[d] * items[k].seconds;
    sums[g].n += items[k].seconds;
  });
  const n = Math.max(-1, ...Object.keys(sums).map(Number)) + 1;
  voices.list = Array.from({ length: n }, (_, g) => ({ c: unit(sums[g]?.c || new Float32Array(256)), n: sums[g]?.n || 0 }));
  const localOf = windows.map(() => ({}));
  ids.forEach((g, k) => { const [wi, spk] = at[k]; localOf[wi][spk] = g; });
  let last = null;
  const out = [];
  windows.forEach((w, wi) => {
    const rel = w.parts.map((p) => ({ ...p, start: p.start - w.start, end: p.end - w.start }));
    const labelled = labelParts(rel, w.turns, localOf[wi], last, { voices, spanPrints: w.spanPrints });
    if (labelled.length && labelled[labelled.length - 1].speaker != null) last = labelled[labelled.length - 1].speaker;
    out.push(...labelled.map((p) => ({ text: p.text, speaker: p.speaker ?? null })));
  });
  return out;
}

const METHODS = [
  ['before speaker work', { minPrint: 1.2 }],
  ['sentence prints', { minPrint: 0.4, short: true, smooth: true, retime: true, own: true }],
  ['the app now', { minPrint: 0.4, short: true, smooth: true, retime: true, own: true, replies: true }],
  ['hindsight 0.45', { hindsight: 0.45 }],
  ['hindsight 0.5', { hindsight: 0.5 }],
  ['hindsight 0.55', { hindsight: 0.55 }],
  ['hindsight 0.6', { hindsight: 0.6 }],
];

/* ---------- scoring ---------- */

const norm = (w) => w.toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]/gu, '');
const toWords = (text) => text.split(/[\s—–-]+/).map(norm).filter(Boolean);
const ref = [];
ep.turns.forEach((t, ti) => { for (const w of toWords(t.text)) ref.push({ w, speaker: t.speaker, turn: ti }); });
const hypWordsOf = (parts) => parts.flatMap((p) => toWords(p.text).map((w) => ({ w, speaker: p.speaker })));

// Word alignment (edit distance) of the app's words with the start of the transcript.
function align(hyp, refAll) {
  const r = refAll.slice(0, Math.round(hyp.length * 1.5) + 200);
  const n = hyp.length;
  const m = r.length;
  const dir = new Uint8Array((n + 1) * (m + 1)); // 0 diag, 1 up (skip hyp), 2 left (skip ref)
  let prev = new Int32Array(m + 1);
  // Free start in the transcript is not allowed, but a free end is (the audio is cut short).
  for (let j = 0; j <= m; j++) { prev[j] = j; dir[j] = 2; }
  for (let i = 1; i <= n; i++) {
    const cur = new Int32Array(m + 1);
    cur[0] = i;
    dir[i * (m + 1)] = 1;
    for (let j = 1; j <= m; j++) {
      const d = prev[j - 1] + (hyp[i - 1].w === r[j - 1].w ? 0 : 1);
      const u = prev[j] + 1;
      const l = cur[j - 1] + 1;
      if (d <= u && d <= l) { cur[j] = d; dir[i * (m + 1) + j] = 0; } else if (u <= l) { cur[j] = u; dir[i * (m + 1) + j] = 1; } else { cur[j] = l; dir[i * (m + 1) + j] = 2; }
    }
    prev = cur;
  }
  let j = 0;
  for (let k = 1; k <= m; k++) if (prev[k] < prev[j]) j = k; // best end in the transcript
  let i = n;
  const pairs = [];
  while (i > 0 && j > 0) {
    const d = dir[i * (m + 1) + j];
    if (d === 0) { if (hyp[i - 1].w === r[j - 1].w) pairs.push([i - 1, j - 1]); i--; j--; } else if (d === 1) i--; else j--;
  }
  return { pairs: pairs.reverse(), r };
}

function score(parts) {
  const hyp = hypWordsOf(parts);
  const { pairs, r } = align(hyp, ref);
  // Each voice stands for the transcript speaker it overlaps most.
  const overlap = {};
  for (const [h, x] of pairs) {
    const v = hyp[h].speaker;
    if (v == null) continue;
    overlap[v] ||= {};
    overlap[v][r[x].speaker] = (overlap[v][r[x].speaker] || 0) + 1;
  }
  const map = Object.fromEntries(Object.entries(overlap).map(([v, o]) => [v, Object.entries(o).sort((a, b) => b[1] - a[1])[0][0]]));
  // Words within 4 of a change of speaker in the transcript are the edges of turns.
  const edge = r.map((x, k) => [-4, -3, -2, -1, 1, 2, 3, 4].some((d) => r[k + d] && r[k + d].speaker !== x.speaker));
  let right = 0; let n = 0; let eRight = 0; let eN = 0;
  for (const [h, x] of pairs) {
    const ok = map[hyp[h].speaker] === r[x].speaker;
    n++; if (ok) right++;
    if (edge[x]) { eN++; if (ok) eRight++; }
  }
  const split = {};
  for (const [v, s] of Object.entries(map)) split[s] = (split[s] || 0) + 1;
  return { right, n, eRight, eN, matched: pairs.length / Math.max(1, hyp.length), voices: Object.keys(map).length, split, overlap };
}

// How well the voice model tells people apart, whatever thresholds the app uses: every sentence
// with a print of its own gets the transcript speaker most of its words align to, and all pairs
// of sentence prints are compared. AUC: the chance a same-person pair is more alike than a
// different-person pair. EER: the error rate where false matches equal false splits.
{
  const sentences = [];
  const parts = [];
  for (const w of windows) w.parts.forEach((p, j) => {
    const print = w.spanPrints?.[j];
    parts.push({ text: p.text, speaker: print ? sentences.length : null });
    if (print) sentences.push({ print: unit(print), votes: {} });
  });
  const hyp = hypWordsOf(parts);
  const { pairs, r } = align(hyp, ref);
  for (const [h, x] of pairs) if (hyp[h].speaker != null) { const v = sentences[hyp[h].speaker].votes; v[r[x].speaker] = (v[r[x].speaker] || 0) + 1; }
  const known = sentences.map((s) => ({ ...s, who: Object.entries(s.votes).sort((a, b) => b[1] - a[1])[0]?.[0] })).filter((s) => s.who);
  const same = []; const diff = [];
  for (let i = 0; i < known.length; i++) for (let j = i + 1; j < known.length; j++) (known[i].who === known[j].who ? same : diff).push(cosine(known[i].print, known[j].print));
  same.sort((a, b) => a - b); diff.sort((a, b) => a - b);
  let k = 0; let auc = 0;
  for (const x of same) { while (k < diff.length && diff[k] < x) k++; auc += k; }
  auc /= Math.max(1, same.length * diff.length);
  let eer = 1; let at = 0;
  for (let t = -1; t <= 1; t += 0.005) {
    const miss = same.filter((x) => x < t).length / Math.max(1, same.length);
    const fa = diff.filter((x) => x >= t).length / Math.max(1, diff.length);
    if (Math.max(miss, fa) < eer) { eer = Math.max(miss, fa); at = t; }
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  console.log(`SEPARATION ${KEY} | ${VOICE || 'default'} | AUC ${(100 * auc).toFixed(1)}% | EER ${(100 * eer).toFixed(1)}% at ${at.toFixed(2)} | same-person mean ${mean(same).toFixed(2)}, different ${mean(diff).toFixed(2)} | ${known.length} sentences, ${new Set(known.map((s) => s.who)).size} people`);
}

console.log(`\ntranscript speakers in the first ${MINUTES} min: ${[...new Set(ref.slice(0, 6000).map((x) => x.speaker))].length}`);
for (const [label, opts] of METHODS) {
  const s = score(opts.hindsight ? hindsight({ threshold: opts.hindsight }) : replay(opts));
  if (label === 'the app now') {
    const refTalk = {};
    for (const x of ref.slice(0, Math.round(s.n * 1.3))) refTalk[x.speaker] = (refTalk[x.speaker] || 0) + 1;
    console.log(`transcript words by speaker (aligned stretch): ${JSON.stringify(refTalk)}`);
    for (const [v, o] of Object.entries(s.overlap)) console.log(`  voice ${v}: ${Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} ${c}`).join(', ')}`);
  }
  console.log(`SCORE ${KEY} | ${label.padEnd(20)} | words right ${(100 * s.right / s.n).toFixed(1)}% of ${s.n} | at turn edges ${(100 * s.eRight / Math.max(1, s.eN)).toFixed(1)}% of ${s.eN} | ${s.voices} voices | aligned ${(100 * s.matched).toFixed(0)}% | voices per person ${JSON.stringify(s.split)}`);
}
