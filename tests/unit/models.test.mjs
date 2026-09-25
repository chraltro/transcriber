import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, dtypeFor, modelFiles } from '../../lib/models.js';

test('CPU uses 8-bit weights; GPU picks by fp16 support', () => {
  assert.equal(dtypeFor('onnx-community/whisper-base', 'wasm', false), 'q8');
  assert.deepEqual(dtypeFor('onnx-community/whisper-small', 'webgpu', true), { encoder_model: 'fp16', decoder_model_merged: 'q4' });
  assert.deepEqual(dtypeFor('onnx-community/whisper-small', 'webgpu', false), { encoder_model: 'fp32', decoder_model_merged: 'q4' });
  assert.deepEqual(dtypeFor(MODELS.turbo.id, 'webgpu', true), { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' });
  assert.deepEqual(modelFiles(MODELS.tiny.id, 'wasm', false), ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx']);
});

// Network check: every file any model/device combination would load exists on Hugging Face.
test('every model file the app can request exists on Hugging Face', { skip: !process.env.NETWORK_TESTS && 'set NETWORK_TESTS=1' }, async () => {
  for (const m of Object.values(MODELS)) {
    const info = await (await fetch(`https://huggingface.co/api/models/${m.id}`)).json();
    const files = new Set(info.siblings.map((s) => s.rfilename));
    for (const [device, f16] of [['wasm', false], ['webgpu', true], ['webgpu', false]])
      for (const f of modelFiles(m.id, device, f16)) assert.ok(files.has(f), `${m.id} ${device} f16=${f16}: ${f}`);
    for (const f of ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json']) assert.ok(files.has(f), `${m.id}: ${f}`);
  }
});
