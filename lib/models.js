// The Whisper models the app offers, and which weight files each device loads.

// Download sizes (MB) of the weights each device actually loads: CPU uses 8-bit weights,
// GPUs use fp16/4-bit when they support 16-bit floats, fp32/4-bit otherwise.
export const MODELS = {
  tiny: { id: 'onnx-community/whisper-tiny', name: 'Tiny', note: 'Fastest, rough text', mb: { cpu: 41, gpu16: 104, gpu32: 120 } },
  base: { id: 'onnx-community/whisper-base', name: 'Base', note: 'Fast, weak on Norwegian and Danish', mb: { cpu: 77, gpu16: 165, gpu32: 206 } },
  small: { id: 'onnx-community/whisper-small', name: 'Small', note: 'Good balance', mb: { cpu: 249, gpu16: 410, gpu32: 586 } },
  turbo: { id: 'onnx-community/whisper-large-v3-turbo', name: 'Large v3 Turbo', note: 'Best, especially for Norwegian and Danish', mb: { cpu: 1085, gpu16: 564, gpu32: 759 } },
};

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
