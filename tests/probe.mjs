// CI probe: model files on Hugging Face, Nordic Whisper models, WebGPU in software, Firefox.
import { chromium, firefox } from 'playwright';

const hf = async (path) => (await fetch(`https://huggingface.co/api/${path}`)).json();

console.log('=== files each model/device combination loads');
// Mirrors dtypeFor() in worker.js.
const COMBOS = {
  'cpu (q8)': { encoder: 'encoder_model_quantized.onnx', decoder: 'decoder_model_merged_quantized.onnx' },
  'gpu fp16 small': { encoder: 'encoder_model_fp16.onnx', decoder: 'decoder_model_merged_q4.onnx' },
  'gpu fp32 small': { encoder: 'encoder_model.onnx', decoder: 'decoder_model_merged_q4.onnx' },
  'gpu f16 large': { encoder: 'encoder_model_q4f16.onnx', decoder: 'decoder_model_merged_q4f16.onnx' },
  'gpu no-f16 large': { encoder: 'encoder_model_q4.onnx', decoder: 'decoder_model_merged_q4.onnx' },
};
for (const id of ['onnx-community/whisper-tiny', 'onnx-community/whisper-base', 'onnx-community/whisper-small', 'onnx-community/whisper-large-v3-turbo']) {
  const info = await hf(`models/${id}`);
  const files = new Set((info.siblings || []).map((s) => s.rfilename));
  const combos = Object.entries(COMBOS).filter(([k]) => id.includes('large') ? !k.includes('small') : !k.includes('large'));
  for (const [name, f] of combos) {
    const missing = [f.encoder, f.decoder].filter((x) => !files.has(`onnx/${x}`));
    console.log(`  ${id} ${name}: ${missing.length ? 'MISSING ' + missing.join(', ') : 'ok'}`);
  }
  for (const extra of ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json']) if (!files.has(extra)) console.log(`  ${id}: MISSING ${extra}`);
}

console.log('\n=== Nordic Whisper models usable by transformers.js (have onnx/ files)');
const seen = new Set();
for (const q of ['nb-whisper', 'whisper norwegian', 'whisper norsk', 'whisper danish', 'whisper dansk', 'roest', 'coral whisper', 'whisper nordic', 'whisper-nb', 'hviske']) {
  const list = await hf(`models?search=${encodeURIComponent(q)}&limit=60&sort=downloads&direction=-1`);
  for (const m of list) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const info = await hf(`models/${m.id}`);
    const onnx = (info.siblings || []).map((s) => s.rfilename).filter((f) => /^onnx\/(encoder|decoder)_model/.test(f));
    if (onnx.length) console.log(`  ${m.id} (downloads ${info.downloads ?? '?'}): ${onnx.join(' ')}`);
  }
}

console.log('\n=== WebGPU in software (SwiftShader) for Chromium');
for (const args of [
  ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'],
  ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader'],
]) {
  for (const channel of [undefined, 'chromium']) {
    try {
      const b = await chromium.launch({ args, channel });
      const p = await b.newPage();
      await p.goto('https://example.com');
      const r = await p.evaluate(async () => {
        if (!navigator.gpu) return 'no navigator.gpu';
        const a = await navigator.gpu.requestAdapter();
        if (!a) return 'no adapter';
        const info = a.info || {};
        return `adapter ${info.vendor} ${info.architecture} f16=${a.features.has('shader-f16')} maxBuffer=${a.limits.maxBufferSize}`;
      });
      console.log(`  channel=${channel || 'headless-shell'} ${args.join(' ')}\n    -> ${r}`);
      await b.close();
    } catch (e) { console.log(`  channel=${channel} failed: ${e.message.split('\n')[0]}`); }
  }
}

console.log('\n=== Firefox capabilities');
const fb = await firefox.launch();
const fp = await fb.newPage();
await fp.goto('https://example.com');
console.log('  ', await fp.evaluate(async () => JSON.stringify({
  gpu: !!navigator.gpu, caches: typeof caches, offline: typeof OfflineAudioContext, wakeLock: !!navigator.wakeLock,
  moduleWorker: (() => { try { new Worker('data:text/javascript,', { type: 'module' }); return true; } catch { return false; } })(),
})));
await fb.close();
