// End-to-end test: loads the app in headless Chromium with real network access,
// pastes real podcast links and waits for actual Whisper output.
// Run: node tests/e2e.mjs  (needs `npm i playwright` and `npx playwright install chromium`)
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const ORIGIN = 'https://transcriber.test';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const CASES = [
  { name: 'Pocket Casts episode', url: 'https://pca.st/episode/662e3967-b4b0-4d36-84d1-d0d8b49eb03b', lang: 'english' },
  ...(process.env.EXTRA_CASES ? JSON.parse(process.env.EXTRA_CASES) : []),
];
const SEGMENTS_NEEDED = Number(process.env.SEGMENTS_NEEDED || 2);
const TIMEOUT_MS = Number(process.env.CASE_TIMEOUT_MS || 12 * 60 * 1000);

const browser = await chromium.launch();
let failures = 0;

for (const c of CASES) {
  console.log(`\n=== ${c.name}: ${c.url} (${c.lang})`);
  // The public CORS proxies treat localhost specially, so serve the app from a fake https origin instead.
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
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
  await page.selectOption('#model', 'base');
  await page.fill('#url', c.url);
  await page.click('#go');

  const start = Date.now();
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
    if (s.segments.length >= SEGMENTS_NEEDED) {
      result = 'ok';
      console.log(`  title: ${s.title}`);
      s.segments.forEach((t) => console.log(`  > ${t}`));
      break;
    }
    await page.waitForTimeout(2000);
  }
  const ok = result === 'ok' || (c.expectList && result.startsWith('episode list'));
  console.log(`  RESULT: ${ok ? 'PASS' : 'FAIL'} (${result})`);
  if (!ok) failures++;
  await ctx.close();
}

await browser.close();
process.exit(failures ? 1 : 0);
