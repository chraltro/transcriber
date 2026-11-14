// Fast UI test: the real page in Chromium (desktop and an iPhone profile) with the speech
// models swapped for tests/ui/fake-worker.js, so a whole transcript takes seconds. Covers what
// a visual change can break: every screen renders without errors or sideways scrolling, and the
// flows around the transcript still work. The real-model runs are tests/e2e.mjs.
// Screenshots of each state go to ui-shots/ for a look.
import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname;
const SHOTS = join(ROOT, 'ui-shots');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, path.endsWith('/') ? `${path}index.html` : path));
    res.writeHead(200, { 'content-type': TYPES[extname(path) || '.html'] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const BASE = `http://localhost:${server.address().port}/`;

// Seven minutes of speech-like audio with pauses: bursts of a warbling tone.
async function makeAudio() {
  const rate = 16000;
  const n = rate * 60 * 7;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const on = t % 4.5 < 4;
    const v = on ? Math.sin(2 * Math.PI * (180 + 40 * Math.sin(t * 3)) * t) * 0.3 : 0;
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  const file = join(tmpdir(), 'ui-test-episode.wav');
  await writeFile(file, buf);
  return file;
}

// The phone's page with a transcript open, before the transcript side had tabs (the hero, the
// session, the speaker map, talk time and the reader one under another): 6287 px tall, its first
// sentence 1470 px down. Measured on this test's episode at 390 px, 14 November 2026.
const PHONE_BEFORE = { height: 6287, first: 1470 };

const failures = [];
const check = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

async function run(name, contextOptions, audio) {
  console.log(`\n=== ${name}`);
  const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const ctx = await browser.newContext({ ...contextOptions, serviceWorkers: 'block' });
  await ctx.route('**/worker.js', (r) => r.fulfill({ path: join(ROOT, 'tests/ui/fake-worker.js'), contentType: 'text/javascript' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const shot = (state) => page.screenshot({ path: join(SHOTS, `${name}-${state}.png`) });
  const noSideScroll = async (state) => {
    const [w, sw] = await page.evaluate(() => [window.innerWidth, document.documentElement.scrollWidth]);
    check(sw <= w + 1, `${state}: no sideways scrolling (${sw} px of ${w})`);
  };
  const mobile = !!contextOptions.isMobile;
  // The tabs of the transcript side: which are offered, which is on screen, and what shows.
  const tabsNow = () => page.evaluate(() => ({
    offered: [...document.querySelectorAll('#tx-tabs a:not(.hidden)')].map((a) => a.textContent),
    bar: !!document.querySelector('#tx-tabs').offsetParent,
    on: document.querySelector('#tx-tabs a.on')?.textContent || '',
    hash: location.hash,
    shown: ['#hero', '#library', '#progress-card', '#result-card', '#map-card', '#talk-card', '#studio'].filter((s) => document.querySelector(s)?.offsetParent).map((s) => s.slice(1)),
  }));
  const tab = async (name) => {
    await page.click(`#tx-tabs a[data-tab="${name}"]`);
    await page.waitForFunction((n) => document.querySelector(`#tx-tabs a[data-tab="${n}"]`).classList.contains('on'), name);
  };
  // On a phone, whatever is touched is at least 44 px both ways (as tests/pod.mjs tries it on
  // the podcast side): tried 21.5 px from its middle up, down, left and right.
  const reach = (root) => page.evaluate((root) => {
    const short = [];
    for (const box of document.querySelectorAll(root)) {
      for (const el of box.querySelectorAll('a[href], button, summary, select, input:not([type=hidden]), [role=button]')) {
        if (el.disabled || el.closest('.hint, .footer, .sr-only, .transcript, [inert]')) continue;
        const t = el.tagName === 'INPUT' && ['radio', 'checkbox', 'file'].includes(el.type) ? el.closest('label') : el;
        if (!t || !t.getClientRects().length || getComputedStyle(t).visibility === 'hidden') continue;
        t.scrollIntoView({ block: 'center', inline: 'nearest' });
        const r = t.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const missed = [[0, -21.5], [0, 21.5], [-21.5, 0], [21.5, 0]].filter(([dx, dy]) => {
          if (dx ? r.width >= 43.5 : r.height >= 43.5) return false;
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
          const hit = document.elementFromPoint(x, y);
          if (hit?.closest('#tabbar, #playbar, .topbar, #tx-tabs') && !t.closest('#tabbar, #playbar, .topbar, #tx-tabs')) return false;
          return !(hit && (hit === t || t.contains(hit)));
        });
        if (missed.length) short.push(`${t.tagName.toLowerCase()}.${[...t.classList].join('.')} "${(t.getAttribute('aria-label') || t.textContent).trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}, missed at ${missed.map(([dx, dy]) => { const hh = document.elementFromPoint(cx + dx, cy + dy); return `${dx},${dy} (${hh?.tagName.toLowerCase()}.${hh?.className?.baseVal ?? hh?.className})`; }).join(' ')}`);
      }
    }
    window.scrollTo(0, 0);
    return [...new Set(short)];
  }, root);
  const short = [];

  await page.goto(`${BASE}#/transcribe`); // the app opens on the podcast side; this is the transcript side's test
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('glossary', 'Derek Thompson\nAnna Berg'); indexedDB.deleteDatabase('transcriber'); });
  await page.reload();
  await page.waitForSelector('#go');
  await shot('1-landing');
  await noSideScroll('landing');
  let tabs = await tabsNow();
  check(!tabs.bar && tabs.shown.includes('hero'), `nothing made yet: the way to a new transcript, and no tabs to choose from (${tabs.offered.join(', ') || 'none'})`);
  if (mobile) {
    if (!(await page.locator('#settings-body').isVisible())) await page.click('#settings-toggle');
    await page.click('#hero .opener[aria-controls="glossary-field"]');
    check(await page.locator('#glossary').isVisible(), 'names to watch for: a button opens the field');
    short.push(...(await reach('#hero')).map((x) => `New: ${x}`));
    await page.click('#hero .opener[aria-controls="glossary-field"]');
  }

  await page.setInputFiles('#file', audio);
  await page.waitForFunction(() => document.querySelectorAll('#transcript .seg').length > 8, null, { timeout: 60000 });
  await shot('2-transcribing');
  await noSideScroll('transcribing');
  tabs = await tabsNow();
  check(tabs.shown.includes('result-card') && tabs.shown.includes('progress-card') && !tabs.shown.includes('hero') && tabs.hash === '#/transcribe', `while it is written, the transcript is on screen (${tabs.shown.join(', ')})`);

  // Done, and on phones also the speaker pass that follows.
  await page.waitForFunction(() => document.querySelector('#stage').textContent === 'Done' && document.querySelectorAll('#transcript .who').length > 0, null, { timeout: 120000 });
  await page.waitForTimeout(700);
  const done = await page.evaluate(() => ({
    chips: [...new Set([...document.querySelectorAll('#transcript .who')].map((c) => c.textContent))],
    rows: document.querySelectorAll('#map-grid .map-row').length,
    labels: [...document.querySelectorAll('#map-grid .map-label')].map((x) => x.textContent),
    talk: document.querySelectorAll('#talk-list li').length,
    ads: document.querySelectorAll('.para.plug').length,
    library: !!indexedDB,
  }));
  check(done.chips.includes('Derek Thompson') && done.chips.includes('Anna Berg'), `speakers named from introductions (${done.chips.join(', ')})`);
  check(done.chips.includes('Other voice'), `a voice heard only in passing is an "Other voice" (${done.chips.join(', ')})`);
  check(done.rows === 3 && done.labels.includes('Other voices'), `speaker map: host, guest and other voices (${done.labels.join(', ')})`);
  check(done.talk === 3, `talk time lists both voices and the others (${done.talk})`);
  check(done.ads > 0, 'sponsor read marked as an ad');
  await page.waitForFunction(() => document.querySelectorAll('#tx-tabs a:not(.hidden)').length === 3);
  tabs = await tabsNow();
  check(tabs.offered.join(',') === 'Transcript,Speakers,Clean up' && tabs.on === 'Transcript', `done: tabs for the transcript, the speakers and the clean-up (${tabs.offered.join(', ')}; on ${tabs.on})`);
  check(['progress-card', 'result-card'].every((x) => tabs.shown.includes(x)) && !['map-card', 'talk-card', 'hero', 'studio'].some((x) => tabs.shown.includes(x)), `the Transcript tab holds the playing controls and the reader, and nothing else (${tabs.shown.join(', ')})`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('3-done');
  await noSideScroll('done');
  if (mobile) {
    const now = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, first: Math.round(document.querySelector('#transcript .para').getBoundingClientRect().top + scrollY), screen: innerHeight }));
    console.log(`  note: the Transcript tab on a phone is ${now.height} px tall (it was ${PHONE_BEFORE.height}), its first sentence ${now.first} px down (it was ${PHONE_BEFORE.first})`);
    // (The transcript's own text is the same length: what goes is everything stacked above it.)
    check(now.height < PHONE_BEFORE.height - 600 && now.first < now.screen - 100 && now.first < PHONE_BEFORE.first * 0.4, `on a phone the Transcript tab is far shorter: ${now.height} px, was ${PHONE_BEFORE.height}; the first sentence ${now.first} px down, was ${PHONE_BEFORE.first}`);
    short.push(...(await reach('#tx-tabs, #progress-card, #result-card')).map((x) => `Transcript: ${x}`));
  }

  // The Speakers tab: who speaks when and talk time, alone, and in the address.
  await tab('speakers');
  tabs = await tabsNow();
  check(tabs.hash === '#/transcribe/speakers' && tabs.shown.includes('map-card') && tabs.shown.includes('talk-card') && !tabs.shown.includes('result-card') && !tabs.shown.includes('progress-card'), `the Speakers tab holds the speaker map and talk time, and the address says so (${tabs.hash}: ${tabs.shown.join(', ')})`);
  await page.waitForTimeout(150);
  check(await page.evaluate(() => document.querySelector('#jump-now').classList.contains('hidden') || !document.querySelector('#jump-now').offsetParent), 'nothing of the reader floats over the Speakers tab');

  // Lasso an interval on the map.
  const cells = page.locator('#map-grid .map-row').first().locator('i');
  const count = await cells.count();
  await page.locator('#map-grid').evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  const a = await cells.nth(Math.floor(count * 0.3)).boundingBox();
  const b = await cells.nth(Math.floor(count * 0.6)).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const scope = await page.locator('#map-scope').textContent();
  check(/Selected · \d+:\d\d–\d+:\d\d/.test(scope), `lasso selects an interval (${scope})`);
  await shot('4-lasso');
  if (await page.locator('#map-clear').isVisible()) await page.click('#map-clear');
  if (mobile) short.push(...(await reach('#tx-tabs, #map-card, #talk-card')).map((x) => `Speakers: ${x}`));

  // Rename a voice from talk time: the whole transcript follows.
  await page.locator('#talk-list .who', { hasText: 'Derek Thompson' }).click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Derek T.');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('#talk-list .who')].some((c) => c.textContent === 'Derek T.'));
  const derek = await page.evaluate(() => [...document.querySelectorAll('#transcript .who')].filter((c) => c.textContent === 'Derek T.').length);
  check(derek > 1, `renaming a voice under talk time renames it in every paragraph (${derek})`);

  // The back gesture goes back to the tab before, at once.
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('#tx-tabs a.on')?.dataset.tab === 'transcript');
  tabs = await tabsNow();
  check(tabs.hash === '#/transcribe' && tabs.shown.includes('result-card') && !tabs.shown.includes('map-card'), `back goes from Speakers to the Transcript tab (${tabs.hash}: ${tabs.shown.join(', ')})`);
  await page.goForward();
  await page.waitForFunction(() => document.querySelector('#tx-tabs a.on')?.dataset.tab === 'speakers');
  check((await tabsNow()).hash === '#/transcribe/speakers', 'and forward to Speakers again');
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('#tx-tabs a.on')?.dataset.tab === 'transcript');

  // Rename a speaker.
  await page.locator('#transcript .who').nth(1).click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Anna B.');
  await page.keyboard.press('Enter');
  const renamed = await page.evaluate(() => [...document.querySelectorAll('#transcript .who')].filter((c) => c.textContent === 'Anna B.').length);
  check(renamed > 1, `renaming a speaker renames every paragraph (${renamed})`);

  // Export as Markdown.
  if (!mobile) {
    await page.click('#export');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download-md')]);
    const md = await readFile(await dl.path(), 'utf8');
    check(dl.suggestedFilename().endsWith('.md') && /^# /.test(md) && /\*\*Anna B\.\*\* `\d+:\d\d`/.test(md), `Markdown export has a title and bold, timed speakers (${dl.suggestedFilename()})`);
  }

  // Names spelled two ways.
  await page.click('#names-btn');
  const names = await page.locator('#names-list li').first().textContent();
  check(/Sayash Kapoor.*Sayosh Kapoor|Sayosh Kapoor.*Sayash Kapoor/.test(names), `check names groups spellings (${names})`);
  await shot('5-names');

  // Back to the start: New and Library, the library lists it and reopens it with its names.
  await page.reload();
  await page.waitForSelector('#tx-tabs a[data-tab="library"]:not(.hidden)');
  tabs = await tabsNow();
  check(tabs.offered.join(',') === 'New,Library' && tabs.on === 'New' && tabs.shown.includes('hero') && !tabs.shown.includes('library'), `with nothing open: New and Library, New first (${tabs.offered.join(', ')}; ${tabs.shown.join(', ')})`);
  await tab('library');
  await page.waitForSelector('#library-list li');
  tabs = await tabsNow();
  check(tabs.hash === '#/transcribe/library' && tabs.shown.includes('library') && !tabs.shown.includes('hero'), `the Library tab holds the transcripts made here, and the address says so (${tabs.hash})`);
  await shot('6-library');
  await noSideScroll('library');
  if (mobile) short.push(...(await reach('#tx-tabs, #library, #shelf')).map((x) => `Library: ${x}`));
  await page.locator('#library-list .entry-open').first().click();
  await page.waitForSelector('#transcript .who');
  const reopened = await page.evaluate(() => document.querySelector('#transcript .who')?.textContent);
  check(!!reopened, `library reopens the transcript with speakers (${reopened})`);
  tabs = await tabsNow();
  check(tabs.on === 'Transcript' && tabs.hash === '#/transcribe', `it opens on the Transcript tab (${tabs.on}, ${tabs.hash})`);
  if (mobile) {
    const tools = await page.evaluate(() => ['#copy', '#export'].every((s) => document.querySelector(s).getBoundingClientRect().width > 30) && getComputedStyle(document.querySelector('#tabbar')).display !== 'none');
    check(tools, 'on a phone, copy and export are in the toolbar and the sections along the bottom');
  }

  // Clean up the same episode, on its own tab: the studio's voices are the transcript's speakers.
  await page.waitForSelector('#tx-tabs a[data-tab="clean"]:not(.hidden)', { timeout: 10000 });
  await tab('clean');
  await page.waitForSelector('#studio-body:not(.hidden)', { timeout: 120000 });
  tabs = await tabsNow();
  check(tabs.hash === '#/transcribe/clean-up' && tabs.shown.join(',') === 'studio', `the Clean up tab holds the studio alone, and the address says so (${tabs.hash}: ${tabs.shown.join(', ')})`);
  await page.waitForFunction(() => document.querySelector('#pv-loud').textContent && !document.querySelector('#pv-state').textContent, null, { timeout: 60000 });
  const studio = await page.evaluate(() => ({
    voices: [...document.querySelectorAll('.finding b')].map((b) => b.textContent),
    tabs: document.querySelectorAll('.tab').length,
    mods: document.querySelectorAll('.mod').length,
    loud: document.querySelector('#pv-loud').textContent,
  }));
  check(studio.voices.length >= 2 && studio.voices.some((v) => /Derek|Anna/.test(v)), `studio voices are the speakers (${studio.voices.join(', ')})`);
  check(studio.mods === 10 && studio.tabs === studio.voices.length + 1, `a card per module and a tab per voice (${studio.mods} cards, ${studio.tabs} tabs)`);
  check(/LUFS/.test(studio.loud), `preview rendered (${studio.loud})`);
  await page.locator('.mod:not(.on) .mod-switch').first().click();
  await page.waitForFunction(() => !document.querySelector('#pv-state').textContent, null, { timeout: 60000 });
  await page.locator('#studio').evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await shot('7-studio');
  await noSideScroll('studio');
  if (!mobile) {
    await page.locator('#export-format label', { hasText: 'WAV' }).click();
    const [wav] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#export-go')]);
    const bytes = (await readFile(await wav.path())).length;
    const secs = (bytes - 44) / 2 / 44100;
    check(wav.suggestedFilename().endsWith('(cleaned).wav') && Math.abs(secs - 420) < 1, `export is the whole episode (${wav.suggestedFilename()}, ${secs.toFixed(1)} s)`);
  }
  // Away and back, the studio is as it was.
  await tab('transcript');
  await tab('clean');
  check(await page.locator('#studio-body').isVisible(), 'the studio stays open when another tab is looked at');
  await page.click('#studio-close');
  await page.waitForFunction(() => document.querySelector('#tx-tabs a.on')?.dataset.tab === 'transcript');
  const back = await page.evaluate(() => document.querySelector('#studio').classList.contains('hidden') && !!document.querySelector('#result-card').offsetParent && location.hash === '#/transcribe');
  check(back, 'closing the studio leaves the transcript, on its tab');

  // Clean-up mode from the start page with a file.
  await page.goto(BASE + '?mode=clean');
  await page.waitForSelector('#go');
  check((await page.locator('#go').textContent()) === 'Clean up', 'clean-up mode changes the button');
  await page.setInputFiles('#file', audio);
  await page.waitForSelector('#studio-body:not(.hidden)', { timeout: 120000 });
  await page.waitForFunction(() => !document.querySelector('#pv-state').textContent, null, { timeout: 60000 });
  await shot('8-studio-file');
  await noSideScroll('studio from a file');
  tabs = await tabsNow();
  check(!tabs.bar && tabs.shown.join(',') === 'studio', `cleaning up a file on its own: the studio, and no tabs (${tabs.shown.join(', ')})`);
  if (mobile) check(!short.length, `on a phone every control of the transcript side's tabs is at least 44 px both ways${short.length ? `, not: ${short.join('; ')}` : ''}`);

  check(!errors.length, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await browser.close();
}

await mkdir(SHOTS, { recursive: true });
const audio = await makeAudio();
const { defaultBrowserType, ...iphone } = devices['iPhone 13'];
// (node tests/ui.mjs phone: one of them)
const only = process.argv[2];
try {
  if (!only || 'desktop-dark'.includes(only)) await run('desktop-dark', { viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' }, audio);
  if (!only || 'desktop-light'.includes(only)) await run('desktop-light', { viewport: { width: 1280, height: 900 }, colorScheme: 'light' }, audio);
  if (!only || 'phone-dark'.includes(only)) await run('phone-dark', { ...iphone, colorScheme: 'dark' }, audio);
} finally {
  server.close();
}
console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
process.exit(failures.length ? 1 : 0);
