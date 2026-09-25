// The Whisper models the app offers, and which weight files each device loads.

// Download sizes (MB) of the weights each device actually loads: CPU uses 8-bit weights,
// GPUs use fp16/4-bit when they support 16-bit floats, fp32/4-bit otherwise.
// For Norwegian, tiny/base/small switch to the National Library's NB-Whisper fine-tunes: same
// architecture and file sizes, far better Norwegian. Measured on an NRK episode, stock tiny
// got stuck repeating words while NB tiny beat stock small, and NB base came close to
// Large v3 Turbo at six times its speed (tests/model-lab.mjs).
export const MODELS = {
  tiny: {
    id: 'onnx-community/whisper-tiny', nb: 'Xenova/nb-whisper-tiny-beta', name: 'Tiny',
    note: { english: 'Fastest, rough text', danish: 'Fastest, rough text', norwegian: 'Fastest. Norwegian-tuned, readable' },
    mb: { cpu: 41, gpu16: 104, gpu32: 120 },
  },
  base: {
    id: 'onnx-community/whisper-base', nb: 'onnx-community/nb-whisper-base-ONNX', name: 'Base',
    note: { english: 'Fast, fine for clear speech', danish: 'Fast, weak on Danish', norwegian: 'Fast. Norwegian-tuned, very good' },
    mb: { cpu: 77, gpu16: 165, gpu32: 206 },
  },
  small: {
    id: 'onnx-community/whisper-small', nb: 'onnx-community/nb-whisper-small-ONNX', name: 'Small',
    note: { english: 'Good balance', danish: 'Good balance', norwegian: 'Norwegian-tuned, best for Norwegian' },
    mb: { cpu: 249, gpu16: 410, gpu32: 586 },
  },
  turbo: {
    id: 'onnx-community/whisper-large-v3-turbo', name: 'Large v3 Turbo',
    note: { english: 'Best, slow without a GPU', danish: 'Best for Danish', norwegian: 'Large; the Norwegian-tuned Small is as good' },
    mb: { cpu: 1085, gpu16: 564, gpu32: 759 },
  },
};

// The model to load for a size and language, with the note to show for it.
export function modelFor(key, language) {
  const m = MODELS[key];
  if (!m) return null;
  const nb = language === 'norwegian' && m.nb;
  return { key, name: m.name, id: nb ? m.nb : m.id, note: m.note[language] || m.note.english, mb: m.mb, tuned: !!nb };
}

// Every model id the app can load.
export const ALL_MODEL_IDS = Object.values(MODELS).flatMap((m) => (m.nb ? [m.id, m.nb] : [m.id]));

// Smallest weights that keep quality. fp16/q4f16 need the GPU's shader-f16 feature.
export function dtypeFor(model, device, hasF16) {
  if (device !== 'webgpu') return 'q8';
  if (model.includes('large')) {
    return hasF16
      ? { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' }
      : { encoder_model: 'q4', decoder_model_merged: 'q4' };
  }
  return { encoder_model: hasF16 ? 'fp16' : 'fp32', decoder_model_merged: 'q4' };
}

// The ONNX files a model/device combination downloads (used by tests to check they exist).
export function modelFiles(modelId, device, hasF16) {
  const dtype = dtypeFor(modelId, device, hasF16);
  const suffix = (d) => ({ fp32: '', fp16: '_fp16', q8: '_quantized', q4: '_q4', q4f16: '_q4f16' })[d];
  const enc = typeof dtype === 'string' ? dtype : dtype.encoder_model;
  const dec = typeof dtype === 'string' ? dtype : dtype.decoder_model_merged;
  return [`onnx/encoder_model${suffix(enc)}.onnx`, `onnx/decoder_model_merged${suffix(dec)}.onnx`];
}
