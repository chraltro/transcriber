import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js';

env.allowLocalModels = false;

const SAMPLE_RATE = 16000;
const MAX_SEG = 29.5 * SAMPLE_RATE; // Whisper sees 30 s windows
const MIN_SEG = 18 * SAMPLE_RATE;   // look for a pause between 18 s and 29.5 s
const FRAME = SAMPLE_RATE / 10;     // 100 ms energy frames
const SILENCE_RMS = 0.0025;

// Whisper's classic "I heard silence, so here's a subtitle credit" hallucinations.
const HALLUCINATIONS = /^\s*[("[]?\s*(teksting av|tekstet av|undertekst(er)? av|danske tekster|tekster af|tekstning af|subtitles by|thanks? (you )?for watching|takk for at du så på|tak fordi du så med)[^.!?]*[.!?]?\s*[)\]"]?\s*$/i;

let asr = null;
let loadedKey = null;

const post = (msg) => self.postMessage(msg);

function dtypeFor(model, device, hasF16) {
  if (device !== 'webgpu') return 'q8';
  if (model.includes('large')) {
    return { encoder_model: hasF16 ? 'fp16' : 'q4', decoder_model_merged: 'q4' };
  }
  return { encoder_model: 'fp32', decoder_model_merged: 'q4' };
}

async function load(model, device, hasF16) {
  const key = `${model}|${device}`;
  if (asr && loadedKey === key) return device;
  if (asr) {
    await asr.dispose?.();
    asr = null;
  }
  const progress_callback = (p) => post({ type: 'model-progress', ...p });
  try {
    asr = await pipeline('automatic-speech-recognition', model, {
      device,
      dtype: dtypeFor(model, device, hasF16),
      progress_callback,
    });
  } catch (err) {
    if (device !== 'webgpu') throw err;
    console.warn('WebGPU failed, falling back to WASM', err);
    post({ type: 'status', text: 'WebGPU unavailable, falling back to CPU' });
    device = 'wasm';
    asr = await pipeline('automatic-speech-recognition', model, {
      device,
      dtype: dtypeFor(model, device, hasF16),
      progress_callback,
    });
  }
  loadedKey = `${model}|${device}`;
  return device;
}

function rms(audio, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += audio[i] * audio[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

// Split into <= 29.5 s pieces, cutting at the quietest 100 ms frame so words don't get chopped.
function segment(audio) {
  const out = [];
  let start = 0;
  while (start < audio.length) {
    if (audio.length - start <= MAX_SEG) {
      out.push([start, audio.length]);
      break;
    }
    let cut = start + MAX_SEG;
    let best = Infinity;
    for (let p = start + MIN_SEG; p + FRAME <= start + MAX_SEG; p += FRAME / 2) {
      const e = rms(audio, p, p + FRAME);
      if (e < best) {
        best = e;
        cut = p + FRAME / 2;
      }
    }
    out.push([start, cut]);
    start = cut;
  }
  return out;
}

// Whisper occasionally gets stuck repeating a phrase. Drop runs of identical sentences.
function dedupeRepeats(text) {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  const out = [];
  let run = 0;
  for (const s of sentences) {
    const norm = s.trim().toLowerCase();
    const prev = out.length ? out[out.length - 1].trim().toLowerCase() : null;
    run = norm && norm === prev ? run + 1 : 0;
    if (run < 2) out.push(s);
  }
  return out.join('').trim();
}

async function transcribe({ audio, language, model, device, hasF16 }) {
  post({ type: 'status', text: 'Loading speech model' });
  const usedDevice = await load(model, device, hasF16);
  post({ type: 'ready', device: usedDevice });

  const segments = segment(audio);
  const total = audio.length / SAMPLE_RATE;
  const t0 = performance.now();

  for (let i = 0; i < segments.length; i++) {
    const [s, e] = segments[i];
    const chunk = audio.subarray(s, e);
    let text = '';
    if (rms(audio, s, e) > SILENCE_RMS) {
      const result = await asr(chunk, { language, task: 'transcribe', return_timestamps: false });
      text = dedupeRepeats(result.text || '');
      if (HALLUCINATIONS.test(text)) text = '';
    }
    post({
      type: 'segment',
      start: s / SAMPLE_RATE,
      end: e / SAMPLE_RATE,
      text,
      done: e / SAMPLE_RATE,
      total,
      elapsed: (performance.now() - t0) / 1000,
    });
  }
  post({ type: 'done' });
}

self.onmessage = async ({ data }) => {
  if (data.type !== 'transcribe') return;
  try {
    await transcribe(data);
  } catch (err) {
    console.error(err);
    post({ type: 'error', message: err?.message || String(err) });
  }
};
