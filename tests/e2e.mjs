// End-to-end test: loads the app in headless Chromium with real network access,
// pastes real podcast links and waits for actual Whisper output.
// Run: node tests/e2e.mjs  (needs `npm i playwright` and `npx playwright install chromium`)
import { chromium, webkit, devices } from 'playwright';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { execSync } from 'node:child_process';

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

// Latest episode of a show as an Apple Podcasts link, looked up at test time so it never goes stale.
async function appleEpisodeLink(term, country) {
  const s = await (await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=podcast&limit=1&country=${country}`)).json();
  const id = s.results[0].collectionId;
  const l = await (await fetch(`https://itunes.apple.com/lookup?id=${id}&entity=podcastEpisode&limit=1&country=${country}`)).json();
  const ep = l.results.find((r) => r.wrapperType === 'podcastEpisode');
  return { url: `https://podcasts.apple.com/${country}/podcast/x/id${id}?i=${ep.trackId}`, title: ep.trackName };
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
  { name: 'iPhone (WebKit)', engine: 'webkit', model: 'tiny', url: 'https://pca.st/episode/662e3967-b4b0-4d36-84d1-d0d8b49eb03b', lang: 'english', segments: 8, memoryLimitMB: 2000, title: 'Xi’s Just Not That Into You' },
  { name: 'Pocket Casts short link', url: 'https://pca.st/okm7xj7g', lang: 'english', resolveOnly: true, title: 'Xi’s Just Not That Into You' },
  { name: 'Apple, Norwegian (NRK)', url: nrk.url, lang: 'norwegian', segments: 1, title: nrk.title },
  { name: 'Apple, Danish (Omny)', url: omny.url, lang: 'danish', segments: 1, title: omny.title },
  { name: 'Spotify episode', url: 'https://open.spotify.com/episode/2ebY3WNejLNbK47emgjd1E', lang: 'english', resolveOnly: true, titleIncludes: 'Alcohol' },
  { name: 'RSS feed', url: 'https://feeds.megaphone.fm/hubermanlab', lang: 'english', expectList: true },
  ...(process.env.EXTRA_CASES ? JSON.parse(process.env.EXTRA_CASES) : []),
];
// Decoding is chunked so memory stays flat; a 90 minute episode used about 4 GB before.
const MEMORY_LIMIT_MB = Number(process.env.MEMORY_LIMIT_MB || 1200);
const TIMEOUT_MS = Number(process.env.CASE_TIMEOUT_MS || 12 * 60 * 1000);

const browsers = {};
const launch = async (engine) => (browsers[engine] ??= await (engine === 'webkit' ? webkit : chromium).launch());
let failures = 0;

for (const c of CASES) {
  console.log(`\n=== ${c.name}: ${c.url} (${c.lang})`);
  // The public CORS proxies treat localhost specially, so serve the app from a fake https origin instead.
  const engine = c.engine || 'chromium';
  memPattern = engine === 'webkit' ? 'WPEWebProcess|WebKitWebProcess' : '--type=renderer';
  const browser = await launch(engine);
  const ctx = await browser.newContext(engine === 'webkit' ? { ...devices['iPhone 15'], serviceWorkers: 'block' } : { serviceWorkers: 'block' });
  await ctx.route(`${ORIGIN}/**`, async (route) => {
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
    if (!u.startsWith(ORIGIN) && !/huggingface|jsdelivr|hf\.co|xethub/.test(u)) console.log(`  [${r.status()}] ${u.slice(0, 150)}`);
  });

  await page.goto(`${ORIGIN}/index.html`);
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
}

for (const b of Object.values(browsers)) await b.close();
process.exit(failures ? 1 : 0);
