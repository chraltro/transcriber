// Memory lab: runs one episode with the Tiny model in Chromium and in WebKit (the engine
// every iOS browser uses, including Brave), logging tab memory as transcription goes.
// Optionally patches the worker to try memory-saving ONNX Runtime settings.
import { chromium, webkit, devices } from 'playwright';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const ORIGIN = 'https://transcriber.test';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const URL_ = process.env.LAB_URL || 'https://pca.st/episode/662e3967-b4b0-4d36-84d1-d0d8b49eb03b';
const SEGMENTS = Number(process.env.LAB_SEGMENTS || 20);

function memMB(pattern) {
  try {
    const out = execSync(`ps -eo rss,args | grep -E -- '${pattern}' | grep -v grep`, { encoding: 'utf8' });
    return Math.round(out.trim().split('\n').reduce((s, l) => s + (parseInt(l) || 0), 0) / 1024);
  } catch { return 0; }
}

const RUNS = [
  { engine: 'chromium', config: 'default' },
  { engine: 'chromium', config: 'no-arena' },
  { engine: 'webkit', config: 'default' },
  { engine: 'webkit', config: 'no-arena' },
];

for (const run of RUNS) {
  console.log(`\n=== ${run.engine} / ${run.config}`);
  const isWebkit = run.engine === 'webkit';
  const browser = await (isWebkit ? webkit : chromium).launch();
  const ctx = await browser.newContext(isWebkit ? { ...devices['iPhone 15'], serviceWorkers: 'block' } : { serviceWorkers: 'block' });
  await ctx.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/+/, '') || 'index.html';
    try {
      let body = await readFile(join(ROOT, path));
      if (path === 'worker.js' && run.config === 'no-arena') {
        body = body.toString().replaceAll('progress_callback,\n', 'progress_callback,\n      session_options: { enableCpuMemArena: false, enableMemPattern: false },\n');
      }
      route.fulfill({ body, contentType: TYPES[extname(path)] || 'application/octet-stream' });
    } catch { route.fulfill({ status: 404, body: '' }); }
  });
  const page = await ctx.newPage();
  let crashed = false;
  page.on('crash', () => { crashed = true; console.log('  PAGE CRASHED'); });
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/CORS|Failed to load resource|Access-Control/.test(m.text()) && console.log(`  [console.error] ${m.text().slice(0, 200)}`));
  const pattern = isWebkit ? 'WebKitWebProcess' : '--type=renderer';
  const base = memMB(pattern);
  await page.goto(`${ORIGIN}/index.html`);
  console.log(`  UA mobile: ${await page.evaluate(() => /iPhone/.test(navigator.userAgent))}, gpu: ${await page.evaluate(() => !!navigator.gpu)}, caches: ${await page.evaluate(() => typeof caches)}`);
  await page.click('input[name=model][value=tiny]');
  await page.fill('#url', URL_);
  await page.click('#go');
  const t0 = Date.now();
  let peak = 0, lastStage = '', lastSegs = -1;
  const marks = [];
  while (!crashed && Date.now() - t0 < 10 * 60 * 1000) {
    let s;
    try {
      s = await page.evaluate(() => ({
        stage: document.querySelector('#stage').textContent,
        detail: document.querySelector('#detail').textContent,
        err: document.querySelector('#error-card').classList.contains('hidden') ? '' : document.querySelector('#error').textContent,
        segs: document.querySelectorAll('#transcript p:not(.working)').length,
      }));
    } catch (e) { console.log(`  evaluate failed: ${e.message.slice(0, 120)}`); break; }
    const mem = memMB(pattern);
    peak = Math.max(peak, mem);
    if (s.stage !== lastStage) { console.log(`  ${Math.round((Date.now() - t0) / 1000)}s ${s.stage} | ${s.detail.slice(0, 60)} | ${mem} MB`); lastStage = s.stage; }
    if (s.segs !== lastSegs && [1, 3, 5, 10, 15, 20, 25, 30].includes(s.segs)) { marks.push(`${s.segs}:${mem}`); lastSegs = s.segs; }
    if (s.err) { console.log(`  ERROR: ${s.err.slice(0, 200)}`); break; }
    if (s.segs >= SEGMENTS) break;
    await page.waitForTimeout(1000);
  }
  console.log(`  RESULT ${run.engine}/${run.config}: idle ${base} MB, peak ${peak} MB, memory at segment n -> ${marks.join('  ')}${crashed ? '  (crashed)' : ''}`);
  await browser.close();
}
