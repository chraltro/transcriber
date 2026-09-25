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
    route.fulfill({ body: await readFile(join(ROOT, path)), contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)] || 'application/octet-stream' });
  } catch { route.fulfill({ status: 404, body: '' }); }
});
const page = await ctx.newPage();
page.on('console', (m) => console.log(`  [console.${m.type()}] ${m.text().slice(0, 400)}`));
await page.goto(`${ORIGIN}/index.html`);

const result = await page.evaluate(async () => {
  // Wrap the real worker: report uncaught errors, rejections and failed postMessage calls.
  const src = `
    const report = (m) => { try { origPost.call(self, { type: 'probe', text: m }); } catch {} };
    const origPost = self.postMessage;
    let progress = 0;
    self.postMessage = function (msg, ...rest) {
      try {
        if (msg?.type === 'model-progress' && progress++ < 3) report('progress sample: ' + JSON.stringify(msg).slice(0, 300) + ' keys=' + Object.keys(msg).join(','));
        return origPost.call(self, msg, ...rest);
      } catch (e) {
        report('postMessage FAILED: ' + e.name + ': ' + e.message + ' for ' + Object.entries(msg || {}).map(([k, v]) => k + ':' + Object.prototype.toString.call(v)).join(' '));
        throw e;
      }
    };
    self.addEventListener('error', (e) => report('uncaught: ' + e.message + ' @ ' + e.filename + ':' + e.lineno + ' ' + (e.error?.stack || '').slice(0, 500)));
    self.addEventListener('unhandledrejection', (e) => report('unhandled rejection: ' + (e.reason?.name || '') + ': ' + (e.reason?.message || e.reason) + ' ' + (e.reason?.stack || '').slice(0, 500)));
    import('${location.origin}/worker.js').then(() => report('worker.js imported'), (e) => report('import worker.js FAILED: ' + e.name + ': ' + e.message + ' ' + (e.stack || '').slice(0, 500)));`;
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' });
  const lines = [];
  return await new Promise((res) => {
    w.onerror = (e) => { lines.push('worker onerror: ' + JSON.stringify(e.message) + ' ' + e.filename + ':' + e.lineno); };
    w.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'probe') {
        lines.push(d.text);
        if (d.text === 'worker.js imported') w.postMessage({ type: 'start', id: 1, language: 'english', model: 'onnx-community/whisper-tiny', device: 'wasm', hasF16: false, offsetSec: 0 });
      } else if (d.type === 'ready') {
        lines.push('READY ' + JSON.stringify(d));
        w.postMessage({ type: 'audio', id: 1, samples: new Float32Array(16000 * 5), final: true });
      } else if (d.type === 'segment' || d.type === 'done' || d.type === 'error') {
        lines.push(d.type + ' ' + JSON.stringify(d).slice(0, 300));
        if (d.type !== 'segment') res(lines);
      }
    };
    setTimeout(() => res([...lines, 'timeout']), 200000);
  });
});
for (const l of result) console.log(l);
await browser.close();
