// WebKit lab: every iOS browser (Brave included) runs on WebKit. This drives the app in
// Playwright's WebKit with an iPhone profile, traces each stage of the pipeline, and logs
// memory, to find where WebKit gets stuck. Runs once with a fake model (isolates decoding)
// and once with the real Tiny model.
import { chromium, webkit, devices } from 'playwright';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const ORIGIN = 'https://transcriber.test';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const URL_ = process.env.LAB_URL || 'https://pca.st/episode/662e3967-b4b0-4d36-84d1-d0d8b49eb03b';
const SEGMENTS = Number(process.env.LAB_SEGMENTS || 6);
const RUN_MS = 4 * 60 * 1000;

function memMB(pattern) {
  try {
    const out = execSync(`ps -eo rss,args | grep -E -- '${pattern}' | grep -v grep`, { encoding: 'utf8' });
    return Math.round(out.trim().split('\n').reduce((s, l) => s + (parseInt(l) || 0), 0) / 1024);
  } catch { return 0; }
}

// Trace points patched into app.js for this lab only.
function traceApp(src) {
  const t = (label, expr = '') => `console.log('[trace] ${label}'${expr ? ` + ' ' + (${expr})` : ''});`;
  return src
    .replace('async function indexMp3(blob) {', `async function indexMp3(blob) {\n  ${t('indexMp3 start size', 'blob.size')}`)
    .replace("  if (/Xing|Info|VBRI/.test(first)) offsets.shift();\n  return { offsets, spf, sr };", `  if (/Xing|Info|VBRI/.test(first)) offsets.shift();\n  ${t('indexMp3 done frames', 'offsets.length')}\n  return { offsets, spf, sr };`)
    .replace('  if (offsets.length < 50 || covered < size * 0.8) return null;', `  if (offsets.length < 50 || covered < size * 0.8) { ${t('indexMp3 not mp3', 'offsets.length + " " + covered')} return null; }`)
    .replace('async function decodeMono16k(arrayBuffer) {', `async function decodeMono16k(arrayBuffer) {\n  ${t('decode start bytes', 'arrayBuffer.byteLength')}`)
    .replace('  if (audio.numberOfChannels === 1) return audio.getChannelData(0).slice();', `  ${t('decode done samples', 'audio.length + " ch " + audio.numberOfChannels + " sr " + audio.sampleRate')}\n  if (audio.numberOfChannels === 1) return audio.getChannelData(0).slice();`)
    .replace("    worker.postMessage({ type: 'audio', samples: piece }, [piece.buffer]);", `    ${t('post piece seconds', 'piece.length / 16000')}\n    worker.postMessage({ type: 'audio', samples: piece }, [piece.buffer]);`)
    .replace("  worker.onmessage = ({ data: m }) => {", `  worker.onmessage = ({ data: m }) => {\n    if (m.type !== 'model-progress') ${t('worker msg', "m.type + ' ' + (m.end ?? m.seconds ?? m.message ?? '')")}`);
}

const FAKE_PIPELINE = "const env = {}; const pipeline = async () => async (audio) => { await new Promise((r) => setTimeout(r, 200)); return { text: 'seg ' + audio.length }; };";

// Worker variants: ONNX Runtime settings to try in WebKit.
const DIAG = "console.log('[diag] isolated=' + self.crossOriginIsolated + ' SAB=' + (typeof SharedArrayBuffer) + ' wasmPaths=' + JSON.stringify(env.backends?.onnx?.wasm?.wasmPaths) + ' threads=' + env.backends?.onnx?.wasm?.numThreads);";
const VARIANTS = {
  default: (w) => w,
  threads1: (w) => w.replace('env.allowLocalModels = false;', 'env.allowLocalModels = false;\nenv.backends.onnx.wasm.numThreads = 1;'),
  noarena: (w) => w.replaceAll('progress_callback,\n', 'progress_callback,\n      session_options: { enableCpuMemArena: false, enableMemPattern: false },\n'),
  noopt: (w) => w.replaceAll('progress_callback,\n', "progress_callback,\n      session_options: { graphOptimizationLevel: 'basic', enableCpuMemArena: false, enableMemPattern: false },\n"),
  fp32: (w) => w.replace("if (device !== 'webgpu') return 'q8';", "if (device !== 'webgpu') return 'fp32';"),
  // The plain ONNX Runtime WASM build (14 MB) instead of the asyncify one (27 MB).
  plainwasm: (w) => w.replace('env.allowLocalModels = false;', "env.allowLocalModels = false;\n{ const d = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${env.backends.onnx.versions.web}/dist/`; env.backends.onnx.wasm.wasmPaths = { mjs: d + 'ort-wasm-simd-threaded.mjs', wasm: d + 'ort-wasm-simd-threaded.wasm' }; }"),
};

const RUNS = (process.env.LAB_RUNS || 'webkit:plainwasm:tiny,webkit:plainwasm:base,webkit:default:tiny,chromium:plainwasm:tiny')
  .split(',').map((r) => { const [engine, variant, model = 'tiny'] = r.split(':'); return { engine, model, variant }; });

for (const run of RUNS) {
  console.log(`\n=== ${run.engine} / ${run.model} / ${run.variant}`);
  const isWebkit = run.engine === 'webkit';
  const browser = await (isWebkit ? webkit : chromium).launch();
  const ctx = await browser.newContext(isWebkit ? { ...devices['iPhone 15'], serviceWorkers: 'block' } : { serviceWorkers: 'block' });
  await ctx.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/+/, '') || 'index.html';
    try {
      let body = (await readFile(join(ROOT, path))).toString();
      if (path === 'app.js') body = traceApp(body);
      if (path === 'worker.js') {
        if (run.model === 'fake') body = body.replace(/^import \{ pipeline, env \} from .*$/m, FAKE_PIPELINE);
        else body = VARIANTS[run.variant](body).replace('env.allowLocalModels = false;', 'env.allowLocalModels = false;\n' + DIAG);
      }
      route.fulfill({ body, contentType: TYPES[extname(path)] || 'application/octet-stream' });
    } catch { route.fulfill({ status: 404, body: '' }); }
  });
  const page = await ctx.newPage();
  const t0 = Date.now();
  const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  let crashed = false;
  page.on('crash', () => { crashed = true; console.log(`  ${stamp()} PAGE CRASHED`); });
  page.on('pageerror', (e) => console.log(`  ${stamp()} [pageerror] ${e.message.slice(0, 200)}`));
  page.on('console', (m) => {
    const text = m.text();
    if (text.startsWith('[trace]') || (m.type() === 'error' && !/access control|CORS|Failed to load resource/i.test(text))) console.log(`  ${stamp()} ${text.slice(0, 200)}`);
  });
  page.on('worker', (w) => w.on('console', (m) => console.log(`  ${stamp()} [worker ${m.type()}] ${m.text().slice(0, 200)}`)));
  const pattern = isWebkit ? 'WPEWebProcess|WebKitWebProcess' : '--type=renderer';
  await page.goto(`${ORIGIN}/index.html`);
  await page.click(`input[name=model][value=${run.model === 'fake' ? 'tiny' : run.model}]`);
  await page.fill('#url', URL_);
  await page.click('#go');
  let peak = 0;
  let lastLine = '';
  let hung = 0;
  const marks = [];
  while (!crashed && Date.now() - t0 < RUN_MS) {
    const mem = memMB(pattern);
    peak = Math.max(peak, mem);
    // The page probe gets a timeout so a frozen main thread is reported instead of hanging the lab.
    const s = await Promise.race([
      page.evaluate(() => ({
        stage: document.querySelector('#stage').textContent,
        detail: document.querySelector('#detail').textContent,
        err: document.querySelector('#error-card').classList.contains('hidden') ? '' : document.querySelector('#error').textContent,
        segs: document.querySelectorAll('#transcript p:not(.working)').length,
      })).catch((e) => ({ probeError: e.message })),
      new Promise((r) => setTimeout(() => r(null), 5000)),
    ]);
    if (!s) {
      hung++;
      console.log(`  ${stamp()} main thread not responding (${hung}) | ${mem} MB`);
      if (hung >= 6) break;
      continue;
    }
    hung = 0;
    if (s.probeError) { console.log(`  ${stamp()} probe error ${s.probeError.slice(0, 120)}`); break; }
    const line = `${s.stage} | ${s.detail.slice(0, 50)} | segs ${s.segs}`;
    if (line !== lastLine) { console.log(`  ${stamp()} ${line} | ${mem} MB`); lastLine = line; }
    if (/Transcribing/.test(s.stage) && !marks.some((m) => m.startsWith('ready:'))) marks.push(`ready:${mem}`);
    if ([1, 2, 3, 4, 5, 10, 15, 20].includes(s.segs) && !marks.some((m) => m.startsWith(`${s.segs}:`))) marks.push(`${s.segs}:${mem}`);
    if (s.err) { console.log(`  ERROR: ${s.err.slice(0, 200)}`); break; }
    if (s.segs >= SEGMENTS) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`  RESULT ${run.engine}/${run.model}/${run.variant}: peak ${peak} MB, memory at segment n -> ${marks.join('  ') || 'none'}${crashed ? ' (crashed)' : ''}${hung ? ' (main thread hung)' : ''}`);
  await browser.close().catch(() => {});
}
