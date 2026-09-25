import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js';

import { dtypeFor } from './lib/models.js';
import { StreamingTranscriber } from './lib/stream.js';

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

const stream = new StreamingTranscriber({
  post,
  transcribe: async (samples, language) => {
    const result = await asr(samples, { language, task: 'transcribe', return_timestamps: false });
    return result.text;
  },
});

class GpuFailed extends Error {}

async function load(model, device, hasF16, dtypeOverride) {
  const dtype = dtypeOverride || dtypeFor(model, device, hasF16);
  const key = `${model}|${device}|${JSON.stringify(dtype)}`;
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
      progress_callback: (p) => post({ type: 'model-progress', ...p }),
    });
  } catch (err) {
    // The page restarts with a fresh worker on the CPU path (and the small WASM build).
    if (device === 'webgpu') throw new GpuFailed(err?.message || String(err));
    throw err;
  }
  loadedKey = key;
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
      stream.start(id, data);
      post({ type: 'status', id, text: 'Loading speech model' });
      await load(data.model, data.device, data.hasF16, data.dtype);
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
