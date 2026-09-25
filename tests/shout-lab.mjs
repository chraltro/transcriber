// Feasibility lab: does whisper.cpp (WASM, via @transcribe/shout) stay within iPhone-sized
// memory in WebKit, where ONNX Runtime used about 6 GB? Transcribes 10 x 30 s of a real
// episode with Whisper Tiny and logs tab memory, in WebKit (iPhone profile) and Chromium.
import { chromium, webkit, devices } from 'playwright';
import { execSync } from 'node:child_process';

const ORIGIN = 'https://transcriber.test';
const SHOUT = 'https://cdn.jsdelivr.net/npm/@transcribe/shout@1.0.7/src/shout/shout.wasm.js';
const MODEL = process.env.LAB_MODEL || 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny-q5_1.bin';
const AUDIO = 'https://audioboom.com/posts/8955915.mp3';
const CHUNKS = 10;
const ISOLATION = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

const PAGE = `<!doctype html><meta charset="utf-8"><body><script type="module">
const status = (s) => { window.__status = s; console.log('[lab] ' + s); };
status('isolated=' + crossOriginIsolated + ' SAB=' + typeof SharedArrayBuffer);
try {
  const { default: createModule } = await import('/shout.wasm.js');
  let done = null;
  const Module = await createModule({
    print: () => {}, printErr: () => {},
    onNewSegment: (s) => console.log('[seg] ' + JSON.stringify(s).slice(0, 100)),
    onTranscribed: () => done && done(),
    onProgress: () => {},
  });
  status('runtime ready');
  const model = new Uint8Array(await (await fetch('${MODEL}')).arrayBuffer());
  Module.FS_createDataFile('/', 'model.bin', model, true, true);
  Module.init('model.bin', '');
  status('model ready (' + (model.length / 1e6).toFixed(1) + ' MB)');
  // About six minutes of the episode, decoded to 16 kHz mono.
  const res = await fetch('${AUDIO}', { headers: { Range: 'bytes=0-5999999' } });
  const bytes = await res.arrayBuffer();
  const audio = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(bytes);
  const pcm = audio.getChannelData(0);
  status('audio ready ' + (pcm.length / 16000).toFixed(0) + ' s');
  for (let i = 0; i < ${CHUNKS}; i++) {
    const chunk = pcm.slice(i * 480000, (i + 1) * 480000);
    const t = performance.now();
    await new Promise((r) => { done = r; Module.transcribe(chunk, 'en', 2, false, 0, false, false, false); });
    status('chunk ' + (i + 1) + ' done in ' + ((performance.now() - t) / 1000).toFixed(1) + ' s');
  }
  status('finished');
} catch (e) { status('error ' + (e && e.message || e)); }
</script>`;

function memMB(pattern) {
  try {
    const out = execSync(`ps -eo rss,args | grep -E -- '${pattern}' | grep -v grep`, { encoding: 'utf8' });
    return Math.round(out.trim().split('\n').reduce((s, l) => s + (parseInt(l) || 0), 0) / 1024);
  } catch { return 0; }
}

const shoutSrc = await (await fetch(SHOUT)).text();

for (const engine of ['webkit', 'chromium']) {
  console.log(`\n=== ${engine}`);
  const isWebkit = engine === 'webkit';
  const browser = await (isWebkit ? webkit : chromium).launch();
  const ctx = await browser.newContext(isWebkit ? { ...devices['iPhone 15'] } : {});
  await ctx.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/shout.wasm.js') return route.fulfill({ body: shoutSrc, contentType: 'text/javascript', headers: ISOLATION });
    return route.fulfill({ body: PAGE, contentType: 'text/html', headers: ISOLATION });
  });
  const page = await ctx.newPage();
  const t0 = Date.now();
  let crashed = false;
  page.on('crash', () => { crashed = true; console.log('  PAGE CRASHED'); });
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message.slice(0, 200)}`));
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('[lab]') || t.startsWith('[seg]')) console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s ${t.slice(0, 140)} | ${memMB(pattern)} MB`); });
  const pattern = isWebkit ? 'WPEWebProcess|WebKitWebProcess' : '--type=renderer';
  await page.goto(`${ORIGIN}/lab.html`);
  let peak = 0;
  let last = '';
  while (!crashed && Date.now() - t0 < 8 * 60 * 1000) {
    peak = Math.max(peak, memMB(pattern));
    const s = await Promise.race([page.evaluate(() => window.__status).catch(() => 'probe failed'), new Promise((r) => setTimeout(() => r('probe timeout'), 5000))]);
    if (s !== last) last = s;
    if (/finished|error/.test(s || '')) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`  RESULT ${engine}: ${last} | peak ${peak} MB${crashed ? ' (crashed)' : ''}`);
  await browser.close().catch(() => {});
}
