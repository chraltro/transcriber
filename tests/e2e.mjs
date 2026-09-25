// End-to-end test: loads the app in headless Chromium with real network access,
// pastes real podcast links and waits for actual Whisper output.
// Run: node tests/e2e.mjs  (needs `npm i playwright` and `npx playwright install chromium`)
import { chromium, webkit, firefox, devices } from 'playwright';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';

// Peak resident memory of Chromium's renderer processes (the tab), sampled once a second.
// A tab that runs out of memory gets killed, and mobile browsers then silently reload it.
// Every iOS browser (Brave included) runs on WebKit, so one case runs in Playwright's WebKit
// with an iPhone profile. Its web process is WPEWebProcess on Linux.
let memPattern = '--type=renderer';
function rendererRssMB() {
  try {
    const out = execSync(`ps -eo rss,args | grep -E -- '${memPattern}' | grep -v grep`, { encoding: 'utf8' });
    return out.trim().split('\n').reduce((sum, line) => sum + (parseInt(line) || 0), 0) / 1024;
  } catch { return 0; }
}

const ROOT = new URL('..', import.meta.url).pathname;
const ORIGIN = 'https://transcriber.test';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

// Firefox can't start a module worker from a Playwright-routed origin (it fails before the
// script runs, while the same files work from a real server), so Firefox gets a real one.
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(8765);
const LOCAL = 'http://localhost:8765';

// Latest episode of a show as an Apple Podcasts link, looked up at test time so it never goes stale.
async function appleEpisodeLink(term, country) {
  const s = await (await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=podcast&limit=1&country=${country}`)).json();
  const id = s.results[0].collectionId;
  const l = await (await fetch(`https://itunes.apple.com/lookup?id=${id}&entity=podcastEpisode&limit=1&country=${country}`)).json();
  const ep = l.results.find((r) => r.wrapperType === 'podcastEpisode');
  return { url: `https://podcasts.apple.com/${country}/podcast/x/id${id}?i=${ep.trackId}`, title: ep.trackName };
}

// Output in the right language has plenty of that language's most common words. Catches a
// wrong model, a wrong language token, or Whisper translating to English.
const STOPWORDS = {
  english: ['the', 'and', 'to', 'of', 'a', 'is', 'that', 'in', 'it', 'you', 'i', 'we', 'this', 'so', 'but', 'for', 'was', 'on', 'with', 'what'],
  norwegian: ['og', 'det', 'er', 'som', 'jeg', 'på', 'å', 'en', 'til', 'vi', 'har', 'ikke', 'med', 'de', 'at', 'så', 'for', 'var', 'i', 'du'],
  danish: ['og', 'det', 'er', 'som', 'jeg', 'på', 'at', 'en', 'til', 'vi', 'har', 'ikke', 'med', 'de', 'så', 'for', 'var', 'i', 'du', 'der'],
};
function languageScore(text, lang) {
  const words = text.toLowerCase().replace(/\[\d:]+\]/g, ' ').match(/\p{L}+/gu) || [];
  const set = new Set(STOPWORDS[lang]);
  return words.length ? words.filter((w) => set.has(w)).length / words.length : 0;
}

const nrk = await appleEpisodeLink('Abels tårn', 'no');
const omny = await appleEpisodeLink('Millionærklubben', 'dk');

const CASES = [
  { name: 'Pocket Casts episode', url: 'https://pca.st/episode/662e3967-b4b0-4d36-84d1-d0d8b49eb03b', lang: 'english', segments: 8, title: 'Xi’s Just Not That Into You' },
  // Simulates the browser killing the tab: reload after 3 segments, then resume from the saved point.
  { name: 'Resume after reload', url: 'https://pca.st/episode/662e3967-b4b0-4d36-84d1-d0d8b49eb03b', lang: 'english', segments: 6, reloadAfter: 3, title: 'Xi’s Just Not That Into You' },
  // Memory must stay flat over a longer run, or a long episode eventually gets the tab killed.
  { name: 'Memory over a long run', url: 'https://pca.st/episode/662e3967-b4b0-4d36-84d1-d0d8b49eb03b', lang: 'english', segments: 30, leakCheck: true, title: 'Xi’s Just Not That Into You' },
  // WebKit needed 6 to 7 GB here before the app switched to the plain ONNX Runtime build.
  // The WebKit test browser itself idles at about 450 MB, hence the higher limit.
  // WebGPU in software. SwiftShader has no fp16, so this covers the fp32 encoder + 4-bit decoder path.
  { name: 'WebGPU (SwiftShader)', gpu: true, model: 'tiny', url: 'https://pca.st/episode/662e3967-b4b0-4d36-84d1-d0d8b49eb03b', lang: 'english', segments: 2, title: 'Xi’s Just Not That Into You' },
  { name: 'Firefox', engine: 'firefox', model: 'tiny', url: 'https://pca.st/episode/662e3967-b4b0-4d36-84d1-d0d8b49eb03b', lang: 'english', segments: 3, title: 'Xi’s Just Not That Into You' },
  { name: 'iPhone (WebKit)', engine: 'webkit', model: 'tiny', url: 'https://pca.st/episode/662e3967-b4b0-4d36-84d1-d0d8b49eb03b', lang: 'english', segments: 8, memoryLimitMB: 2000, title: 'Xi’s Just Not That Into You' },
  { name: 'Pocket Casts short link', url: 'https://pca.st/okm7xj7g', lang: 'english', resolveOnly: true, title: 'Xi’s Just Not That Into You' },
  // Norwegian runs NB-Whisper (base and tiny).
  { name: 'Apple, Norwegian (NRK)', url: nrk.url, lang: 'norwegian', segments: 3, title: nrk.title },
  { name: 'Norwegian, tiny on iPhone (WebKit)', engine: 'webkit', model: 'tiny', url: nrk.url, lang: 'norwegian', segments: 3, memoryLimitMB: 2000, title: nrk.title },
  { name: 'Apple, Danish (Omny)', url: omny.url, lang: 'danish', segments: 3, title: omny.title },
  { name: 'Spotify episode', url: 'https://open.spotify.com/episode/2ebY3WNejLNbK47emgjd1E', lang: 'english', resolveOnly: true, titleIncludes: 'Alcohol' },
  { name: 'RSS feed', url: 'https://feeds.megaphone.fm/hubermanlab', lang: 'english', expectList: true },
  ...(process.env.EXTRA_CASES ? JSON.parse(process.env.EXTRA_CASES) : []),
];
// Decoding is chunked so memory stays flat; a 90 minute episode used about 4 GB before.
const MEMORY_LIMIT_MB = Number(process.env.MEMORY_LIMIT_MB || 1200);
const TIMEOUT_MS = Number(process.env.CASE_TIMEOUT_MS || 12 * 60 * 1000);

const browsers = {};
const ENGINES = { chromium, webkit, firefox };
const GPU_ARGS = ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'];
const launch = async (engine, gpu) => (browsers[`${engine}${gpu ? '+gpu' : ''}`] ??= await ENGINES[engine].launch(gpu ? { args: GPU_ARGS } : {}));
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;
let failures = 0;

for (const c of CASES) {
  if (ONLY && !ONLY.test(c.name)) continue;
  console.log(`\n=== ${c.name}: ${c.url} (${c.lang})`);
  // The public CORS proxies treat localhost specially, so serve the app from a fake https origin instead.
  const engine = c.engine || 'chromium';
  memPattern = { webkit: 'WPEWebProcess|WebKitWebProcess', firefox: 'firefox.*-contentproc', chromium: '--type=renderer' }[engine];
  const browser = await launch(engine, c.gpu);
  const ctx = await browser.newContext(engine === 'webkit' ? { ...devices['iPhone 15'], serviceWorkers: 'block' } : { serviceWorkers: 'block' });
  const base = engine === 'firefox' ? LOCAL : ORIGIN;
  if (base === ORIGIN) await ctx.route(`${ORIGIN}/**`, async (route) => {
    let path = new URL(route.request().url()).pathname.replace(/^\/+/, '') || 'index.html';
    try {
      route.fulfill({ body: await readFile(join(ROOT, path)), contentType: TYPES[extname(path)] || 'application/octet-stream' });
    } catch {
      route.fulfill({ status: 404, body: 'not found' });
    }
  });
  const page = await ctx.newPage();
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && console.log(`  [console.${m.type()}] ${m.text().slice(0, 300)}`));
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
  page.on('requestfailed', (r) => console.log(`  [requestfailed] ${r.url().slice(0, 150)} ${r.failure()?.errorText}`));
  page.on('response', (r) => {
    const u = r.url();
    if (!u.startsWith(base) && !/huggingface|jsdelivr|hf\.co|xethub/.test(u)) console.log(`  [${r.status()}] ${u.slice(0, 150)}`);
  });

  await page.goto(`${base}/index.html`);
  // The page settles on GPU or CPU before the model list is final.
  await page.waitForSelector('input[name=model]');
  await page.waitForTimeout(500);
  const gpuUsed = await page.evaluate(() => document.querySelector('#device-hint').textContent.includes('can use the GPU'));
  if (c.gpu && !gpuUsed) console.log('  WARNING: the page did not detect the GPU');
  await page.click(`input[value=${c.lang}] + span`);
  await page.click(`input[name=model][value=${c.model || 'base'}]`);
  await page.fill('#url', c.url);
  await page.click('#go');

  const start = Date.now();
  let peakMB = 0;
  const sampler = setInterval(() => { peakMB = Math.max(peakMB, rendererRssMB()); }, 1000);
  let navigations = 0;
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });
  let reloaded = false;
  let audioFetchesAfterReload = 0;
  page.on('request', (r) => { if (reloaded && /\.mp3/.test(r.url())) audioFetchesAfterReload++; });
  let memAtStart = 0;
  let last = '';
  let result = 'timeout';
  while (Date.now() - start < TIMEOUT_MS) {
    const s = await page.evaluate(() => ({
      stage: document.querySelector('#stage').textContent,
      detail: document.querySelector('#detail').textContent,
      error: document.querySelector('#error-card').classList.contains('hidden') ? '' : document.querySelector('#error').textContent,
      episodes: document.querySelector('#episodes-card').classList.contains('hidden') ? 0 : document.querySelectorAll('#episodes li').length,
      segments: [...document.querySelectorAll('#transcript p:not(.working)')].map((p) => p.textContent),
      title: document.querySelector('#episode-title').textContent,
    }));
    const line = `${s.stage} | ${s.detail}`;
    if (line !== last) { console.log(`  ${Math.round((Date.now() - start) / 1000)}s ${line}`); last = line; }
    if (s.error) { result = `error: ${s.error}`; break; }
    if (s.episodes) { result = `episode list (${s.episodes})`; break; }
    if (c.resolveOnly && s.stage === 'Downloading episode') {
      const right = c.titleIncludes ? s.title.includes(c.titleIncludes) : s.title === c.title;
      result = right ? 'ok' : `wrong episode: "${s.title}"`;
      console.log(`  title: ${s.title}`);
      break;
    }
    if (c.leakCheck && !memAtStart && s.segments.length >= 5) memAtStart = rendererRssMB();
    if (c.reloadAfter && !reloaded && s.segments.length >= c.reloadAfter) {
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('job'))?.doneSec);
      console.log(`  reloading the page after ${s.segments.length} segments (saved progress: ${saved}s)`);
      reloaded = true;
      await page.reload();
      navigations--;
      const card = await page.evaluate(() => !document.querySelector('#resume-card').classList.contains('hidden'));
      if (!card) { result = 'no resume offer after reload'; break; }
      await page.click('#resume');
      // Right after a reload the old page's memory is still being released while the new one
      // loads, so both get counted. Measure the resumed page on its own once that has settled.
      await page.waitForTimeout(8000);
      console.log(`  peak before reload ${Math.round(peakMB)} MB; measuring the resumed page from here`);
      peakMB = rendererRssMB();
      continue;
    }
    if (s.segments.length >= (c.segments || 1)) {
      if (reloaded) {
        const starts = s.segments.map((t) => { const m = t.match(/\[(\d+):(\d+)\]/); return +m[1] * 60 + +m[2]; });
        const sorted = starts.every((v, i) => !i || v > starts[i - 1]);
        if (!sorted) { result = `segments out of order or repeated after resume: ${starts.join(',')}`; break; }
        if (audioFetchesAfterReload) { result = `episode downloaded again after reload (${audioFetchesAfterReload}x)`; break; }
        console.log(`  resumed without re-downloading; segment starts ${starts.join(',')}`);
      }
      if (c.leakCheck) {
        const grew = rendererRssMB() - memAtStart;
        console.log(`  memory after 5 segments ${Math.round(memAtStart)} MB, after ${s.segments.length}: ${Math.round(memAtStart + grew)} MB`);
        if (grew > 200) { result = `memory grew ${Math.round(grew)} MB during the run`; break; }
      }
      if (c.title && s.title !== c.title) { result = `wrong episode: "${s.title}"`; break; }
      const text = s.segments.join(' ');
      const score = languageScore(text, c.lang);
      console.log(`  ${c.lang} common-word share: ${(score * 100).toFixed(0)}% of ${text.split(/\s+/).length} words`);
      if (score < 0.12) { result = `transcript does not look ${c.lang} (${(score * 100).toFixed(0)}% common words)`; break; }
      if (c.gpu) {
        const device = await page.evaluate(() => document.querySelector('#detail').textContent + ' ' + document.querySelector('#device-hint').textContent);
        console.log(`  device: ${device.slice(0, 160)}`);
        // A WebGPU failure falls back to the CPU and the hint stops offering the GPU.
        if (!gpuUsed || !device.includes('can use the GPU')) { result = 'GPU case ran without WebGPU (or fell back to the CPU)'; break; }
      }
      result = 'ok';
      console.log(`  title: ${s.title}`);
      s.segments.slice(0, 2).forEach((t) => console.log(`  > ${t.slice(0, 80)}`));
      break;
    }
    await page.waitForTimeout(2000);
  }
  clearInterval(sampler);
  if (navigations > 0 && result === 'ok') result = `page reloaded ${navigations}x during the run`;
  const limit = c.memoryLimitMB || MEMORY_LIMIT_MB;
  if (peakMB > limit && result === 'ok') result = `peak tab memory ${Math.round(peakMB)} MB is over ${limit} MB`;
  const ok = c.expectList ? result.startsWith('episode list') : result === 'ok';
  console.log(`  RESULT: ${ok ? 'PASS' : 'FAIL'} (${result}) peak tab memory ${Math.round(peakMB)} MB`);
  if (!ok) failures++;
  await ctx.close();
  // WebKit's web processes can outlive their context and would be counted in the next case's
  // memory, so every WebKit case gets a fresh browser.
  if (engine === 'webkit') { await browsers.webkit.close(); delete browsers.webkit; }
}

for (const b of Object.values(browsers)) await b.close();
server.close();
process.exit(failures ? 1 : 0);
