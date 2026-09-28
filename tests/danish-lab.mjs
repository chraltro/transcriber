// Danish lab: which model to use for Danish. One real Danish clip (a DR podcast), transcribed
// through the app's own streaming and prompting code by each candidate, compared with Large v3
// Turbo by word error rate, and printed so the text can be read.
//   MODE=search  list Hugging Face models that might do Danish in the browser (ONNX weights)
//   MODE=ref     cut the clip (clip.wav) and write the reference (ref.json) with Large v3 Turbo
//   MODE=model   MODEL=<id>: transcribe the clip and compare
import * as tf from '@huggingface/transformers';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { StreamingTranscriber } from '../lib/stream.js';
import { transcribeWindow } from '../lib/prompted.js';

const MODE = process.env.MODE || 'model';
const SECONDS = Number(process.env.SECONDS || 300);

async function search() {
  const terms = ['danish', 'dansk', 'hviske', 'roest', 'coral', 'whisper-da', 'whisper danish', 'da-DK', 'nota', 'alvenir', 'syvai'];
  const seen = new Map();
  for (const q of terms) {
    try {
      const list = await (await fetch(`https://huggingface.co/api/models?search=${encodeURIComponent(q)}&limit=100&full=true`)).json();
      for (const m of list) {
        const files = (m.siblings || []).map((s) => s.rfilename);
        const onnx = files.filter((f) => f.endsWith('.onnx'));
        if (!onnx.length || seen.has(m.id)) continue;
        seen.set(m.id, { id: m.id, downloads: m.downloads, tags: (m.tags || []).filter((t) => /transformers\.js|whisper|wav2vec|asr|speech|^da$|danish/i.test(t)).join(','), onnx: onnx.slice(0, 8).join(' ') });
      }
    } catch (e) {
      console.log(`search ${q} failed: ${e.message}`);
    }
  }
  const rows = [...seen.values()].sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
  console.log(`${rows.length} models with ONNX files:`);
  for (const r of rows) console.log(`- ${r.id}  (${r.downloads} downloads)  [${r.tags}]\n    ${r.onnx}`);
}

async function danishEpisodeUrl() {
  for (const term of ['Genstart', 'Tiden', 'Millionærklubben']) {
    try {
      const s = await (await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=podcast&limit=1&country=dk`)).json();
      const l = await (await fetch(`https://itunes.apple.com/lookup?id=${s.results[0].collectionId}&entity=podcastEpisode&limit=3&country=dk`)).json();
      const ep = l.results.find((r) => r.wrapperType === 'podcastEpisode');
      if (ep?.episodeUrl) return { title: `${s.results[0].collectionName}: ${ep.trackName}`, url: ep.episodeUrl };
    } catch {}
  }
  throw new Error('No Danish episode found');
}

function loadClip() {
  const raw = execSync(`ffmpeg -loglevel error -i clip.wav -ac 1 -ar 16000 -f f32le -`, { maxBuffer: 1 << 28 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

async function transcribe(modelId, audio) {
  let asr;
  for (const dtype of ['q8', 'fp32']) {
    try {
      asr = await tf.pipeline('automatic-speech-recognition', modelId, { dtype });
      console.log(`loaded ${modelId} (${dtype})`);
      break;
    } catch (e) {
      console.log(`${modelId} ${dtype}: ${e.message.split('\n')[0]}`);
    }
  }
  if (!asr) throw new Error('could not load');
  const segments = [];
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    const stream = new StreamingTranscriber({
      now: () => Date.now(),
      post: (m) => {
        if (m.type === 'segment') segments.push({ start: m.start, end: m.end, text: m.text });
        if (m.type === 'done') resolve();
      },
      transcribe: (samples, language, { previous } = {}) => transcribeWindow(asr, samples, { language, prompt: previous || '', state: {} }),
    });
    stream.start(1, { language: 'danish' });
    stream.push(1, audio, true).then(() => stream.ready(1)).catch(reject);
  });
  return { segments, secs: (Date.now() - t0) / 1000 };
}

const words = (t) => t.toLowerCase().replace(/[-–—/]/g, ' ').replace(/[^\p{L}\p{N}' ]/gu, ' ').split(/\s+/).filter(Boolean);
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

if (MODE === 'search') {
  await search();
} else if (MODE === 'ref') {
  const ep = await danishEpisodeUrl();
  console.log(ep.title);
  execSync(`ffmpeg -loglevel error -ss 90 -t ${SECONDS} -i "${ep.url}" -ac 1 -ar 16000 clip.wav`);
  const audio = loadClip();
  const { segments, secs } = await transcribe('onnx-community/whisper-large-v3-turbo', audio);
  writeFileSync('ref.json', JSON.stringify({ title: ep.title, segments }));
  console.log(`reference: ${(audio.length / 16000 / secs).toFixed(1)}x realtime\n${segments.map((s) => s.text).join('\n')}`);
} else {
  const id = process.env.MODEL;
  const audio = loadClip();
  const ref = existsSync('ref.json') ? JSON.parse(readFileSync('ref.json', 'utf8')) : null;
  const { segments, secs } = await transcribe(id, audio);
  const text = segments.map((s) => s.text).join(' ');
  console.log(`\n=== ${id}: ${(audio.length / 16000 / secs).toFixed(1)}x realtime`);
  if (ref) {
    const { errors, words: n } = wer(text, ref.segments.map((s) => s.text).join(' '));
    console.log(`WER ${id} ${(100 * errors / n).toFixed(1)}% (${errors} of ${n} words against Large v3 Turbo, ${ref.title})`);
  }
  console.log(segments.map((s) => `[${Math.round(s.start)}] ${s.text}`).join('\n'));
}
