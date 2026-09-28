import * as tf from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js';

import { dtypeFor } from './lib/models.js';
import { StreamingTranscriber } from './lib/stream.js';
import { transcribeWindow } from './lib/prompted.js';
import { buildPrompt } from './lib/context.js';
import { createDiarizer } from './lib/diarize.js';

const { pipeline, env } = tf;

env.allowLocalModels = false;

let asr = null;
let loadedKey = null;
let wasmChosen = false;

// transformers.js loads ONNX Runtime's 27 MB "asyncify" WebAssembly build by default.
// WebKit, which every iOS browser runs on, needs several gigabytes to compile it and iOS
// kills the tab. The plain 14 MB build is all the CPU path needs (measured in WebKit:
// about 1 GB instead of 6 to 7 GB). It has to be chosen before the first model loads.
function usePlainWasmBuild() {
  if (wasmChosen) return;
  const dir = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${env.backends.onnx.versions.web}/dist/`;
  env.backends.onnx.wasm.wasmPaths = { mjs: `${dir}ort-wasm-simd-threaded.mjs`, wasm: `${dir}ort-wasm-simd-threaded.wasm` };
  wasmChosen = true;
}

const post = (msg) => self.postMessage(msg);

// Names and terms from the show notes, sent with each job; with the previous window's words
// they make up the prompt Whisper sees before every window.
let terms = [];
let promptState = {};

// The speaker models load once, on first use, and stay (they are small).
let diarizer = null;
let diarizerFailed = false;
async function loadDiarizer(id) {
  if (diarizer || diarizerFailed) return !!diarizer;
  try {
    post({ type: 'status', id, text: 'Loading speaker model' });
    diarizer = await createDiarizer(tf, { device: 'wasm', progress_callback: (p) => post({ type: 'model-progress', id, ...p }) });
  } catch (err) {
    console.warn('Speaker models failed to load', err);
    diarizerFailed = true;
    post({ type: 'speakers-off', id, message: err?.message || String(err) });
  }
  return !!diarizer;
}

const stream = new StreamingTranscriber({
  post,
  diarize: (samples) => diarizer(samples),
  transcribe: (samples, language, { previous } = {}) =>
    transcribeWindow(asr, samples, { language, prompt: buildPrompt(terms, previous), state: promptState }),
});

class GpuFailed extends Error {}

async function load(model, device, hasF16, dtypeOverride, sessionOptions) {
  const dtype = dtypeOverride || dtypeFor(model, device, hasF16);
  const key = `${model}|${device}|${JSON.stringify(dtype)}|${JSON.stringify(sessionOptions)}`;
  if (asr && loadedKey === key) return;
  if (asr) {
    await asr.dispose?.();
    asr = null;
    loadedKey = null;
  }
  if (device === 'webgpu') wasmChosen = true; // the GPU path needs the default build
  else usePlainWasmBuild();
  try {
    asr = await pipeline('automatic-speech-recognition', model, {
      device,
      dtype,
      ...(sessionOptions ? { session_options: sessionOptions } : {}),
      progress_callback: (p) => post({ type: 'model-progress', id: currentId, ...p }),
    });
  } catch (err) {
    // The page restarts with a fresh worker on the CPU path (and the small WASM build).
    if (device === 'webgpu') throw new GpuFailed(err?.message || String(err));
    throw err;
  }
  loadedKey = key;
  promptState = {};
}

// Anything that escapes (a library callback, a rejected promise nobody awaited) is reported
// with its reason; otherwise the page only learns that the worker "crashed".
let currentId = null;
const reportFatal = (err) => post({ type: 'error', id: currentId, message: err?.message || String(err || 'Unknown error in the worker') });
self.addEventListener('error', (e) => { e.preventDefault(); reportFatal(e.error || e.message); });
self.addEventListener('unhandledrejection', (e) => { e.preventDefault(); reportFatal(e.reason); });

self.onmessage = async ({ data }) => {
  const { id } = data;
  if (data.type === 'start') currentId = id;
  try {
    if (data.type === 'start') {
      terms = data.terms || [];
      stream.start(id, data);
      if (data.diarizeOnly) {
        usePlainWasmBuild();
        if (!(await loadDiarizer(id))) return;
        if (stream.job?.id !== id) return;
        post({ type: 'ready', id, device: 'wasm' });
        await stream.ready(id);
        return;
      }
      post({ type: 'status', id, text: 'Loading speech model' });
      await load(data.model, data.device, data.hasF16, data.dtype, data.sessionOptions);
      if (stream.job?.id !== id) return;
      if (data.speakers && !(await loadDiarizer(id))) stream.job && (stream.job.speakers = false);
      if (stream.job?.id !== id) return;
      post({ type: 'ready', id, device: data.device });
      await stream.ready(id);
    } else if (data.type === 'audio') {
      await stream.push(id, data.samples, data.final);
    } else if (data.type === 'cancel') {
      stream.cancel(id);
    }
  } catch (err) {
    console.error(err);
    post({ type: 'error', id, gpuFailed: err instanceof GpuFailed, message: err?.message || String(err) });
  }
};
