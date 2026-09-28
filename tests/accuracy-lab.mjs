// English accuracy lab: one real episode (Plain English, "AI as a normal technology") through
// the app's own streaming, prompting and correction code, in several configurations, scored
// on the names and terms a reader flagged in the Base transcript.
//   A  Base (multilingual), no prompt: the app before this change
//   B  Base.en, no prompt
//   C  Base.en with the prompt (show-note names + the previous window)
//   D  C, then near-miss correction against the show-note names
//   E  D, plus a short glossary a reader might type
// CONFIG picks which transcription to run (A, B or C); D and E are computed from C.
import { pipeline } from '@huggingface/transformers';
import { execSync } from 'node:child_process';
import { StreamingTranscriber } from '../lib/stream.js';
import { transcribeWindow } from '../lib/prompted.js';
import { buildPrompt, extractTerms, plainText } from '../lib/context.js';
import { correctText, parseGlossary } from '../lib/glossary.js';
import { dtypeFor } from '../lib/models.js';

const CONFIG = process.env.CONFIG || 'C';
const MINUTES = Number(process.env.MINUTES || 40);

async function findEpisode() {
  const s = await (await fetch('https://itunes.apple.com/search?term=Plain+English+Derek+Thompson&entity=podcast&limit=5')).json();
  for (const show of s.results) {
    const l = await (await fetch(`https://itunes.apple.com/lookup?id=${show.collectionId}&entity=podcastEpisode&limit=300`)).json();
    const ep = l.results.find((r) => r.wrapperType === 'podcastEpisode' && /normal technology/i.test(r.trackName));
    if (ep) return { show: show.collectionName, title: ep.trackName, url: ep.episodeUrl, notes: plainText(ep.description || ep.shortDescription || '') };
  }
  throw new Error('Episode not found');
}

function decode(url, seconds) {
  const raw = execSync(`ffmpeg -loglevel error -t ${seconds} -i "${url}" -ac 1 -ar 16000 -f f32le -`, { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

// good: the right spelling; bad: the mistakes from the review (and close cousins).
const TARGETS = [
  ['Arvind Narayanan', /Narayanan/g, /Narayan(?!an)|Naryan|Arvind,/gi],
  ['Sayash Kapoor', /Kapoor/g, /Slyash|Sayosh|\bKapur\b|Capoor|Kapor\b|Kupor/gi],
  ['Derek Thompson', /Derek Thompson/g, /Derrick|Thomson/g],
  ['OpenAI', /Open ?AI/g, /open air|opening AI/gi],
  ['Hugging Face', /Hugging Face/g, /hugging phase|hocking face/gi],
  ['Claude', /Claude/g, /Cloud Code|\bclot\b/gi],
  ['Nvidia', /Nvidia|NVIDIA/g, /\bin video\b/gi],
  ['Jensen Huang', /Jensen Huang/g, /Jensen (Wong|Hwang|Wang)/gi],
  ['doomers', /\bdoomers?\b/gi, /dumors|tumors|\bdume\b|\bdoomer's\b/gi],
  ['foom', /\bfoom\b/gi, /\bfum\b|\bfoam\b/gi],
  ['effective altruism', /effective altruis/gi, /effective athlet/gi],
  ['recursive self-improvement', /recursive self.improvement/gi, /christmas self/gi],
  ['AGI-pilled', /AGI.pilled/gi, /GI PILD|\bpild\b/gi],
  ['agent swarms', /agent swarm/gi, /asian swarm/gi],
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
console.log(`terms (${terms.length}): ${terms.join(', ')}`);

const audio = decode(ep.url, MINUTES * 60);
const seconds = audio.length / 16000;
console.log(`audio: ${(seconds / 60).toFixed(1)} min`);

const modelId = CONFIG === 'A' ? 'onnx-community/whisper-base' : 'onnx-community/whisper-base.en';
const asr = await pipeline('automatic-speech-recognition', modelId, { dtype: dtypeFor(modelId, 'wasm') });
const promptState = {};
let fallbacks = 0;
const warn = console.warn;
console.warn = (...a) => { fallbacks++; warn(...a); };

const segments = [];
const t0 = Date.now();
await new Promise((resolve, reject) => {
  const stream = new StreamingTranscriber({
    now: () => Date.now(),
    post: (m) => {
      if (m.type === 'segment') {
        segments.push({ start: m.start, text: m.text });
        if (segments.length % 20 === 0) console.log(`  ${Math.round(m.end)} s of ${Math.round(seconds)}`);
      }
      if (m.type === 'done') resolve();
    },
    transcribe: CONFIG === 'A'
      ? async (samples, language) => (await asr(samples, { language, task: 'transcribe' })).text.trim()
      : (samples, language, { previous } = {}) =>
        transcribeWindow(asr, samples, { language, prompt: CONFIG === 'C' ? buildPrompt(terms, previous) : '', state: promptState }),
  });
  stream.start(1, { language: 'english' });
  stream.push(1, audio, true).then(() => stream.ready(1)).catch(reject);
});
const secs = (Date.now() - t0) / 1000;
console.log(`${modelId}: ${(seconds / secs).toFixed(1)}x realtime, ${segments.length} windows, prompt path broken: ${!!promptState.broken}, fallbacks logged: ${fallbacks}`);

report(CONFIG, segments);
lines(CONFIG, segments);
if (CONFIG === 'C') {
  const auto = { terms, replace: [] };
  const d = segments.map((s) => ({ ...s, text: correctText(s.text, auto) }));
  report('D', d);
  lines('D', d);
  const user = parseGlossary('Sayash Kapoor\nArvind Narayanan\nHugging Face\nJensen Huang\ndoomers\nfoom\nAGI-pilled\neffective altruists');
  const vocab = { terms: [...new Set([...user.terms, ...terms])], replace: user.replace };
  const e = segments.map((s) => ({ ...s, text: correctText(s.text, vocab) }));
  report('E', e, ' (with typed glossary)');
  lines('E', e);
}
