// Firefox diagnostic: its worker.onerror hides the reason a module worker died, so load each
// piece with dynamic import() inside a worker and report the actual error.
import { firefox } from 'playwright';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const ORIGIN = 'https://transcriber.test';
const browser = await firefox.launch();
const ctx = await browser.newContext({ serviceWorkers: 'block' });
await ctx.route(`${ORIGIN}/**`, async (route) => {
  const path = new URL(route.request().url()).pathname.replace(/^\/+/, '') || 'index.html';
  try {
    route.fulfill({ body: await readFile(join(ROOT, path)), contentType: { '.html': 'text/html', '.js': 'text/javascript' }[extname(path)] || 'application/octet-stream' });
  } catch { route.fulfill({ status: 404, body: '' }); }
});
const page = await ctx.newPage();
page.on('console', (m) => console.log(`  [console.${m.type()}] ${m.text().slice(0, 400)}`));
await page.goto(`${ORIGIN}/index.html`);

const result = await page.evaluate(async () => {
  const src = `
    const out = [];
    const tryImport = async (name, url) => {
      try { const m = await import(url); out.push(name + ': ok (' + Object.keys(m).slice(0, 5).join(',') + ')'); return m; }
      catch (e) { out.push(name + ': FAIL ' + e.name + ': ' + e.message + ' @ ' + (e.fileName || '') + ':' + (e.lineNumber || '') + '\\n' + (e.stack || '').slice(0, 600)); }
    };
    self.onmessage = async () => {
      await tryImport('lib/models', '${location.origin}/lib/models.js');
      await tryImport('lib/stream', '${location.origin}/lib/stream.js');
      const t = await tryImport('transformers', 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js');
      if (t) {
        try {
          const dir = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + t.env.backends.onnx.versions.web + '/dist/';
          t.env.backends.onnx.wasm.wasmPaths = { mjs: dir + 'ort-wasm-simd-threaded.mjs', wasm: dir + 'ort-wasm-simd-threaded.wasm' };
          const asr = await t.pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny', { device: 'wasm', dtype: 'q8' });
          const r = await asr(new Float32Array(16000 * 3), { language: 'english', task: 'transcribe' });
          out.push('pipeline plain build: ok ' + JSON.stringify(r.text));
        } catch (e) { out.push('pipeline plain build: FAIL ' + e.name + ': ' + e.message + '\\n' + (e.stack || '').slice(0, 600)); }
      }
      self.postMessage(out);
    };`;
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' });
  const lines = await new Promise((res) => {
    w.onmessage = (e) => res(e.data);
    w.onerror = (e) => res(['probe worker onerror: ' + e.message + ' ' + e.filename + ':' + e.lineno]);
    w.postMessage(1);
    setTimeout(() => res(['timeout']), 240000);
  });
  // The real worker, with whatever onerror gives.
  const real = await new Promise((res) => {
    const rw = new Worker('worker.js', { type: 'module' });
    rw.onerror = (e) => { e.preventDefault?.(); res('real worker onerror: message=' + JSON.stringify(e.message) + ' file=' + e.filename + ':' + e.lineno); };
    rw.onmessage = (e) => { if (e.data.type === 'ready' || e.data.type === 'error') res('real worker message: ' + JSON.stringify(e.data)); };
    rw.postMessage({ type: 'start', id: 1, language: 'english', model: 'onnx-community/whisper-tiny', device: 'wasm', hasF16: false, offsetSec: 0 });
    setTimeout(() => res('real worker: no ready within 120 s'), 120000);
  });
  return [...lines, real, 'crossOriginIsolated=' + self.crossOriginIsolated, 'UA=' + navigator.userAgent];
});
for (const l of result) console.log(l);
await browser.close();
