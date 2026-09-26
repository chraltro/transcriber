// Smoke test of the deployed site: every file serves, and real links transcribe.
import { chromium } from 'playwright';

const SITE = process.env.SITE || 'https://chraltro.github.io/transcriber/';
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures++; };

for (const f of ['', 'app.js', 'worker.js', 'coi-sw.js', 'style.css', 'lib/models.js', 'lib/stream.js', 'lib/mp3.js', 'lib/wav.js', 'lib/links.js', 'lib/text.js', 'lib/segment.js', 'lib/subtitles.js']) {
  const r = await fetch(SITE + f);
  check(r.ok, `${f || 'index.html'} ${r.status} ${r.headers.get('content-type')}`);
}

const CASES = [
  { url: 'https://pca.st/episode/662e3967-b4b0-4d36-84d1-d0d8b49eb03b', lang: 'english', model: 'tiny' },
  { url: 'https://podcasts.apple.com/no/podcast/x/id1198538093?i=1000780388828', lang: 'norwegian', model: 'tiny' },
];
const browser = await chromium.launch();
for (const c of CASES) {
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
  await page.goto(SITE);
  // The service worker reloads the page once to enable cross-origin isolation.
  await page.waitForTimeout(4000);
  const iso = await page.evaluate(() => ({ isolated: self.crossOriginIsolated, sw: !!navigator.serviceWorker.controller }));
  console.log(`  cross-origin isolated: ${iso.isolated}, service worker: ${iso.sw}`);
  await page.click(`input[value=${c.lang}] + span`);
  await page.click(`input[name=model][value=${c.model}]`);
  await page.fill('#url', c.url);
  await page.click('#go');
  let result = 'timeout';
  for (let i = 0; i < 150; i++) {
    const s = await page.evaluate(() => ({
      err: document.querySelector('#error-card').classList.contains('hidden') ? '' : document.querySelector('#error').textContent,
      segs: [...document.querySelectorAll('#transcript p:not(.working)')].map((p) => p.textContent),
      title: document.querySelector('#episode-title').textContent,
      detail: document.querySelector('#detail').textContent,
    }));
    if (s.err) { result = 'error: ' + s.err; break; }
    if (s.segs.length >= 2) { result = 'ok'; console.log(`  ${s.title}\n  > ${s.segs[0].slice(0, 90)}\n  > ${s.segs[1].slice(0, 90)}\n  ${s.detail}`); break; }
    await page.waitForTimeout(2000);
  }
  check(result === 'ok', `${c.lang} ${c.url} (${result})`);
  await page.context().close();
}
await browser.close();
process.exit(failures ? 1 : 0);
