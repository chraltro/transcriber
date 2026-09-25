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

// Top-level worker scripts: which ones start under the routed fake origin?
const startTest = () => page.evaluate(async () => {
  const tryStart = (url, type) => new Promise((res) => {
    const w = new Worker(url, { type });
    w.onerror = (e) => res(`${url} (${type}): onerror ${e.constructor.name} ${e.message}`);
    w.onmessage = () => res(`${url} (${type}): started`);
    setTimeout(() => res(`${url} (${type}): no error within 3 s (started)`), 3000);
    if (type === 'module') w.postMessage({ type: 'cancel', id: 0 });
  });
  const blob = URL.createObjectURL(new Blob([`self.postMessage('hi')`], { type: 'text/javascript' }));
  return [await tryStart(blob, 'module'), await tryStart('lib/text.js', 'module'), await tryStart('worker.js', 'module'), await tryStart('coi-sw.js', 'classic')];
});
console.log('routed origin:', await startTest());

// Same checks with the site served by a real HTTP server.
const { createServer } = await import('node:http');
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(8765);
await page.goto('http://localhost:8765/index.html');
console.log('real server:', await startTest());

// The full app flow on a generated 70 s WAV (tone bursts with pauses), as a user would.
function wav(seconds) {
  const sr = 16000, n = sr * seconds, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) { const t = i / sr; const on = t % 10 < 8; buf.writeInt16LE(on ? Math.round(8000 * Math.sin(2 * Math.PI * 440 * t)) : 0, 44 + i * 2); }
  return buf;
}
page.on('worker', (w) => { console.log('  [worker started] ' + w.url()); w.on('close', () => console.log('  [worker closed] ' + w.url())); });
page.on('pageerror', (e) => console.log('  [pageerror] ' + e.message));
await page.click('input[name=model][value=tiny]');
await page.setInputFiles('#file', { name: 'tone.wav', mimeType: 'audio/wav', buffer: wav(70) });
let last = '';
for (let i = 0; i < 150; i++) {
  const s = await page.evaluate(() => ({
    stage: document.querySelector('#stage').textContent + ' | ' + document.querySelector('#detail').textContent,
    err: document.querySelector('#error-card').classList.contains('hidden') ? '' : document.querySelector('#error').textContent,
    segs: document.querySelectorAll('#transcript p:not(.working)').length,
  }));
  if (s.stage !== last) { console.log(`  ${i * 2}s ${s.stage}`); last = s.stage; }
  if (s.err) { console.log('ERROR: ' + s.err); break; }
  if (s.stage.startsWith('Done')) { console.log(`DONE with ${s.segs} segments`); break; }
  await page.waitForTimeout(2000);
}
await browser.close();
server.close();
