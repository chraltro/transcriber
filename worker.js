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

// transformers.js loads ONNX Runtime's 27 MB "asyncify" WebAssembly build by default.
// WebKit, which every iOS browser runs on, needs several gigabytes to compile it and iOS
// kills the tab. The plain 14 MB build is all the CPU path needs (measured in WebKit:
// about 1 GB instead of 6 to 7 GB).
function usePlainWasmBuild() {
  const dir = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${env.backends.onnx.versions.web}/dist/`;
  env.backends.onnx.wasm.wasmPaths = { mjs: `${dir}ort-wasm-simd-threaded.mjs`, wasm: `${dir}ort-wasm-simd-threaded.wasm` };
}

// Audio arrives in pieces while the episode is still being decoded, so the whole episode
// never has to sit in memory at once. `pending` holds audio not yet transcribed.
let job = null;

const post = (msg) => self.postMessage(msg);

// Smallest weights that keep quality. fp16/q4f16 need the GPU's shader-f16 feature.
function dtypeFor(model, device, hasF16) {
  if (device !== 'webgpu') return 'q8';
  if (model.includes('large')) {
    return hasF16
      ? { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' }
      : { encoder_model: 'q4', decoder_model_merged: 'q4' };
  }
  return { encoder_model: hasF16 ? 'fp16' : 'fp32', decoder_model_merged: 'q4' };
}

async function load(model, device, hasF16) {
  const key = `${model}|${device}|${hasF16}`;
  if (asr && loadedKey === key) return device;
  if (asr) {
    await asr.dispose?.();
    asr = null;
    loadedKey = null;
  }
  const progress_callback = (p) => post({ type: 'model-progress', ...p });
  if (device !== 'webgpu' && !loadedKey) usePlainWasmBuild();
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
  loadedKey = `${model}|${device}|${hasF16}`;
  return device;
}

function rms(audio, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += audio[i] * audio[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

// Where to end the next segment: at the quietest 100 ms frame between 18 s and 29.5 s,
// so words don't get chopped. Returns null if we need more audio first.
function nextCut(audio, start, final) {
  const left = audio.length - start;
  if (left <= 0) return null;
  if (left <= MAX_SEG) return final ? audio.length : null;
  let cut = start + MAX_SEG;
  let best = Infinity;
  for (let p = start + MIN_SEG; p + FRAME <= start + MAX_SEG; p += FRAME / 2) {
    const e = rms(audio, p, p + FRAME);
    if (e < best) {
      best = e;
      cut = p + FRAME / 2;
    }
  }
  return cut;
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

function append(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

async function start({ language, model, device, hasF16, offsetSec = 0 }) {
  job = { language, pending: new Float32Array(0), offset: Math.round(offsetSec * SAMPLE_RATE), final: false, running: false, t0: 0, loaded: false };
  post({ type: 'status', text: 'Loading speech model' });
  const used = await load(model, device, hasF16);
  post({ type: 'ready', device: used });
  job.t0 = performance.now();
  job.loaded = true;
  await drain();
}

async function drain() {
  if (!job || job.running || !job.loaded) return;
  job.running = true;
  try {
    for (;;) {
      const cut = nextCut(job.pending, 0, job.final);
      if (cut == null) break;
      const chunk = job.pending.subarray(0, cut);
      let text = '';
      if (rms(chunk, 0, chunk.length) > SILENCE_RMS) {
        const result = await asr(chunk, { language: job.language, task: 'transcribe', return_timestamps: false });
        text = dedupeRepeats(result.text || '');
        if (HALLUCINATIONS.test(text)) text = '';
      }
      const startSec = job.offset / SAMPLE_RATE;
      job.offset += cut;
      job.pending = job.pending.slice(cut);
      post({
        type: 'segment',
        start: startSec,
        end: job.offset / SAMPLE_RATE,
        text,
        buffered: job.pending.length / SAMPLE_RATE,
        elapsed: (performance.now() - job.t0) / 1000,
      });
    }
    if (job.final && job.pending.length === 0) {
      post({ type: 'done' });
      job = null;
    }
  } finally {
    if (job) job.running = false;
  }
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'start') {
      await start(data);
    } else if (data.type === 'audio') {
      if (!job) return;
      job.pending = append(job.pending, data.samples);
      if (data.final) job.final = true;
      post({ type: 'buffered', seconds: job.pending.length / SAMPLE_RATE });
      await drain();
    }
  } catch (err) {
    console.error(err);
    post({ type: 'error', message: err?.message || String(err) });
  }
};
