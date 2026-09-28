// English accuracy lab: one real episode (Plain English, "AI as a normal technology") through
// the app's own streaming, prompting, timestamp, speaker and correction code, scored two ways:
// on the names and terms a reader flagged in an early Base transcript, and by word error rate
// against Large v3 Turbo on the first REF_MINUTES (the REF config writes that reference).
//   A    Base (multilingual), no prompt: the app before the English models
//   B    Base.en, no prompt
//   C    Base.en with the prompt (show-note names + the previous window)
//   T    C with timestamps and speaker labels: the app now
//   S    Small.en, as T
//   F    Base.en with a typed glossary in the prompt, then corrected
// C also prints D (C corrected against show-note names) and E (C corrected with the glossary).
import * as tf from '@huggingface/transformers';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { StreamingTranscriber } from '../lib/stream.js';
import { transcribeWindow } from '../lib/prompted.js';
import { buildPrompt, extractTerms, plainText } from '../lib/context.js';
import { correctText, parseGlossary } from '../lib/glossary.js';
import { dtypeFor } from '../lib/models.js';
import { createDiarizer } from '../lib/diarize.js';
import { guessNames, speakerName } from '../lib/speakers.js';

const CONFIG = process.env.CONFIG || 'C';
const REF_MINUTES = Number(process.env.REF_MINUTES || 15);
const MINUTES = CONFIG === 'REF' ? REF_MINUTES : Number(process.env.MINUTES || 40);
const CONFIGS = {
  REF: { model: 'onnx-community/whisper-large-v3-turbo' },
  A: { model: 'onnx-community/whisper-base', pipelineOnly: true },
  B: { model: 'onnx-community/whisper-base.en' },
  C: { model: 'onnx-community/whisper-base.en', prompt: 'auto' },
  T: { model: 'onnx-community/whisper-base.en', prompt: 'auto', timestamps: true, speakers: true },
  S: { model: 'onnx-community/whisper-small.en', prompt: 'auto', timestamps: true },
  F: { model: 'onnx-community/whisper-base.en', prompt: 'user' },
};
const cfg = CONFIGS[CONFIG];

// Word error rate: word-level edit distance over the reference length, after lowercasing and
// dropping punctuation, so only wording counts.
const words = (t) => t.toLowerCase().replace(/[‘’]/g, "'").replace(/[-–—/]/g, ' ').replace(/[^\p{L}\p{N}' ]/gu, ' ').split(/\s+/).filter(Boolean);
function wer(hyp, ref) {
  const h = words(hyp);
  const r = words(ref);
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    prev = cur;
  }
  return { errors: prev[h.length], words: r.length };
}

async function findEpisode() {
  const s = await (await fetch('https://itunes.apple.com/search?term=Plain+English+Derek+Thompson&entity=podcast&limit=5')).json();
  const hit = (t) => /normal technology/i.test(t) || (/Narayanan/i.test(t) && /Kapoor/i.test(t));
  for (const show of s.results) {
    // The iTunes lookup only lists recent episodes; the feed has them all.
    if (!show.feedUrl) continue;
    const xml = await (await fetch(show.feedUrl)).text();
    for (const item of xml.split(/<item[\s>]/).slice(1)) {
      const tag = (n) => (item.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`)) || [])[1] || '';
      const cdata = (x) => x.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '');
      const title = plainText(cdata(tag('title')));
      const notes = plainText(cdata(tag('description') || tag('itunes:summary') || tag('content:encoded')));
      const url = (item.match(/<enclosure[^>]*url="([^"]+)"/) || [])[1];
      if (url && (hit(title) || hit(notes))) return { show: show.collectionName, title, url: url.replace(/&amp;/g, '&'), notes };
    }
  }
  throw new Error('Episode not found');
}

function decode(url, seconds) {
  const raw = execSync(`ffmpeg -loglevel error -t ${seconds} -i "${url}" -ac 1 -ar 16000 -f f32le -`, { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

// good: the right spelling; bad: the mistakes from the review (and close cousins).
const TARGETS = [
  ['Arvind Narayanan', /Narayanan/g, /Arvind, Naray|Narayan(?!an)|Naryan/gi],
  ['Sayash Kapoor', /Kapoor/g, /Slyash|Sayosh|Sayyash|\bKapur\b|Capoor|Kapor\b|Kupor/gi],
  ['Derek Thompson', /Derek Thompson/g, /Derrick|Thomson/g],
  ['OpenAI', /Open ?AI/g, /open air|opening AI/gi],
  ['Hugging Face', /Hugging Face/g, /hugging phase|hocking face/gi],
  ['Claude', /Claude/g, /Cloud Code|\bclot\b/gi],
  ['Nvidia', /Nvidia|NVIDIA/g, /\bin video\b/gi],
  ['Jensen Huang', /Jensen Huang/g, /Jensen (Wong|Hwang|Wang)/gi],
  ['doomers', /\bdoomers?\b/gi, /dumors|tumors|\bdume\b|\bdoomer's\b/gi],
  ['foom', /\bfoom\b/gi, /\bfum\b|\bfoam\b|\bfume\b|\bFOM\b/gi],
  ['effective altruism', /effective altruis/gi, /effective athlet/gi],
  ['recursive self-improvement', /recursive self.improvement/gi, /christmas self/gi],
  ['AGI-pilled', /AGI.pilled/gi, /GI PILD|\bpild\b/gi],
  ['agent swarms', /agent swarm/gi, /asian swarm|agents?'? swamp/gi],
];

function score(text) {
  const rows = TARGETS.map(([name, good, bad]) => ({ name, good: (text.match(good) || []).length, bad: (text.match(bad) || []).length }));
  return {
    rows,
    good: rows.reduce((a, r) => a + r.good, 0),
    bad: rows.reduce((a, r) => a + r.bad, 0),
    clean: rows.filter((r) => r.good > 0 && r.bad === 0).length,
  };
}

function report(label, segments, extra = '') {
  const text = segments.map((s) => s.text).join(' ');
  const s = score(text);
  console.log(`\n=== ${label}${extra}: ${s.good} right, ${s.bad} wrong, ${s.clean}/${TARGETS.length} terms clean, ${text.split(/\s+/).length} words`);
  for (const r of s.rows) console.log(`  ${r.name.padEnd(28)} right ${String(r.good).padStart(3)}  wrong ${String(r.bad).padStart(3)}`);
  console.log(`SCORE ${label} right=${s.good} wrong=${s.bad} clean=${s.clean}/${TARGETS.length}`);
}

function lines(label, segments) {
  // The passages that mention any target, right or wrong, so the output can be read too.
  const hits = segments.filter((seg) => TARGETS.some(([, g, b]) => seg.text.match(g) || seg.text.match(b)));
  console.log(`\n--- ${label}: ${hits.length} passages with a target`);
  for (const seg of hits.slice(0, 40)) console.log(`[${Math.round(seg.start)}] ${seg.text}`);
}

const ep = await findEpisode();
console.log(`${ep.show}: ${ep.title}\n${ep.url.slice(0, 100)}\nnotes: ${ep.notes.slice(0, 600)}`);
const terms = extractTerms(ep.notes, ep.title, ep.show);
// What a reader might type after skimming a first transcript.
const USER = parseGlossary('Sayash Kapoor\nArvind Narayanan\nOpenAI\nHugging Face\nJensen Huang\ndoomers\nfoom\nAGI-pilled\neffective altruists');
const withUser = { terms: [...new Set([...USER.terms, ...terms])], replace: USER.replace };
console.log(`terms (${terms.length}): ${terms.join(', ')}`);

const audio = decode(ep.url, MINUTES * 60);
const seconds = audio.length / 16000;
console.log(`audio: ${(seconds / 60).toFixed(1)} min`);

const modelId = cfg.model;
const asr = await tf.pipeline('automatic-speech-recognition', modelId, { dtype: dtypeFor(modelId, 'wasm') });
const diarize = cfg.speakers ? await createDiarizer(tf) : null;
let diarizeSec = 0;
const timedDiarize = diarize && (async (samples) => { const t = Date.now(); try { return await diarize(samples); } finally { diarizeSec += (Date.now() - t) / 1000; } });
const promptState = {};
let fallbacks = 0;
const warn = console.warn;
console.warn = (...a) => { fallbacks++; warn(...a); };
const promptTerms = cfg.prompt === 'user' ? withUser.terms : cfg.prompt === 'auto' ? terms : null;

const segments = [];
const parts = [];
let voices = 0;
let voiceList = [];
const t0 = Date.now();
await new Promise((resolve, reject) => {
  const stream = new StreamingTranscriber({
    now: () => Date.now(),
    post: (m) => {
      if (m.type === 'segment') {
        segments.push({ start: m.start, end: m.end, text: m.text });
        parts.push(...(m.parts || []));
        if (m.voices) { voices = m.voices.length; voiceList = m.voices; }
        if (segments.length % 20 === 0) console.log(`  ${Math.round(m.end)} s of ${Math.round(seconds)}`);
      }
      if (m.type === 'speakers-off') console.log(`SPEAKERS OFF: ${m.message}`);
      if (m.type === 'done') resolve();
    },
    diarize: timedDiarize,
    transcribe: cfg.pipelineOnly
      ? async (samples, language) => (await asr(samples, { language, task: 'transcribe' })).text.trim()
      : (samples, language, { previous } = {}) =>
        transcribeWindow(asr, samples, { language, prompt: promptTerms ? buildPrompt(promptTerms, previous) : '', timestamps: !!cfg.timestamps, state: promptState }),
  });
  stream.start(1, { language: 'english', speakers: !!cfg.speakers });
  stream.push(1, audio, true).then(() => stream.ready(1)).catch(reject);
});
const secs = (Date.now() - t0) / 1000;
console.log(`${modelId}: ${(seconds / secs).toFixed(1)}x realtime, ${segments.length} windows, ${parts.length} parts, prompt path broken: ${!!promptState.broken}, fallbacks logged: ${fallbacks}`);

if (CONFIG === 'REF') {
  writeFileSync('ref.json', JSON.stringify(segments));
  console.log(segments.slice(0, 6).map((s) => `[${Math.round(s.start)}] ${s.text}`).join('\n'));
  process.exit(0);
}

function werReport(label, segs) {
  if (!existsSync('ref.json')) { console.log('no reference; skipping WER'); return; }
  const ref = JSON.parse(readFileSync('ref.json', 'utf8'));
  const until = ref[ref.length - 1].end;
  const hyp = segs.filter((s) => s.start < until - 0.5).map((s) => s.text).join(' ');
  const { errors, words: n } = wer(hyp, ref.map((s) => s.text).join(' '));
  console.log(`WER ${label} ${(100 * errors / n).toFixed(1)}% (${errors} of ${n} words, first ${(until / 60).toFixed(0)} min, against Large v3 Turbo)`);
  // Windows are cut at the same places in every run, so they can be compared one by one.
  const byWindow = ref.map((r) => {
    const h = segs.filter((x) => x.start >= r.start - 0.5 && x.start < r.end - 0.5).map((x) => x.text).join(' ');
    return { start: r.start, ...wer(h, r.text), hyp: h, ref: r.text };
  }).sort((a, b) => b.errors - a.errors);
  if (process.env.WORST !== '0') {
    for (const w of byWindow.slice(0, 5)) {
      console.log(`  worst [${Math.round(w.start)}] ${w.errors} of ${w.words}\n    REF ${w.ref}\n    HYP ${w.hyp}`);
    }
  }
}

const shown = CONFIG === 'F' ? segments.map((s) => ({ ...s, text: correctText(s.text, withUser) })) : segments;
report(CONFIG, shown);
werReport(CONFIG, shown);
lines(CONFIG, shown);
if (CONFIG === 'C') {
  const auto = { terms, replace: [] };
  const d = segments.map((s) => ({ ...s, text: correctText(s.text, auto) }));
  report('D', d);
  werReport('D', d);
  const e = segments.map((s) => ({ ...s, text: correctText(s.text, withUser) }));
  report('E', e, ' (with typed glossary)');
  werReport('E', e);
  lines('E', e);
}
if (CONFIG === 'T' || CONFIG === 'S') {
  const lens = parts.map((p) => p.end - p.start);
  console.log(`parts: ${parts.length}, median ${lens.sort((a, b) => a - b)[lens.length >> 1]?.toFixed(1)} s, longest ${lens[lens.length - 1]?.toFixed(1)} s`);
}
if (CONFIG === 'T') {
  const names = guessNames(parts, terms);
  const counts = {};
  for (const p of parts) if (p.speaker != null) counts[p.speaker] = (counts[p.speaker] || 0) + (p.end - p.start);
  console.log(`\nSPEAKERS: ${voices} voices, diarization ${diarizeSec.toFixed(0)} s total (${(diarizeSec / (seconds / 60)).toFixed(1)} s per audio minute), names ${JSON.stringify(names)}`);
  // How alike the voices are to each other: same-person pairs that were split show up high.
  const dot = (a, b) => a.reduce((x, v, i) => x + v * b[i], 0);
  console.log('voice similarity (weight in seconds):');
  voiceList.forEach((v, i) => console.log(`  ${i} (${Math.round(v.n)} s): ${voiceList.map((w) => dot(v.c, w.c).toFixed(2)).join(' ')}`));
  console.log(`talk time: ${Object.entries(counts).map(([k, v]) => `${speakerName(k, names)} ${(v / 60).toFixed(1)} min`).join(', ')}`);
  let cur = null;
  const paras = [];
  for (const p of parts) {
    if (p.start > 900) break;
    if (!cur || cur.speaker !== p.speaker) { cur = { speaker: p.speaker, start: p.start, text: [] }; paras.push(cur); }
    cur.text.push(p.text);
  }
  for (const p of paras) console.log(`[${Math.round(p.start)}] ${(p.speaker == null ? '?' : speakerName(p.speaker, names))}: ${p.text.join(' ').slice(0, 220)}`);
}
