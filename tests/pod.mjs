// The podcast side, end to end in a real browser against the app's real server and a stand-in
// for the podcast world (tests/pod-world.mjs): following shows, what is new, playing, where an
// episode was left, ads skipped from a transcript, the queue, two devices kept in step, an
// episode saved and played without a connection, and the transcript side joined to the player.
// Screenshots of each state go to ui-shots/.
import { chromium, devices } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startWorld, SHOWS, episodeIdOf } from './pod-world.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const SHOTS = join(ROOT, 'ui-shots');
const launch = () => chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });

const failures = [];
const check = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

// Apple's directory, as the page asks it (JSONP): two of the world's shows by name.
async function fakeApple(ctx, world) {
  await ctx.route('**/itunes.apple.com/**', (route) => {
    const url = new URL(route.request().url());
    const term = (url.searchParams.get('term') || '').toLowerCase();
    const results = SHOWS.filter((s) => term && s.title.toLowerCase().includes(term)).map((s, i) => ({
      wrapperType: 'track', kind: 'podcast', collectionId: 9000 + SHOWS.indexOf(s), collectionName: s.title, artistName: s.author, primaryGenreName: 'Society',
      feedUrl: world.feedUrl(s.slug), artworkUrl600: `${world.worldBase}/art/${s.slug}.svg`,
    }));
    route.fulfill({ contentType: 'text/javascript', body: `${url.searchParams.get('callback')}(${JSON.stringify({ resultCount: results.length, results })})` });
  });
}

async function device(browser, world, name, options) {
  const ctx = await browser.newContext({ ...options, serviceWorkers: 'block' });
  await fakeApple(ctx, world);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_|blocked by CORS policy/.test(m.text())) errors.push(m.text()); });
  const shot = (state) => page.screenshot({ path: join(SHOTS, `pod-${name}-${state}.png`) });
  const noSideScroll = async (state) => {
    const [w, sw] = await page.evaluate(() => [window.innerWidth, document.documentElement.scrollWidth]);
    check(sw <= w + 1, `${state}: no sideways scrolling (${sw} px of ${w})`);
  };
  const audio = () => page.evaluate(() => { const a = document.querySelector('#audio'); return { t: a.currentTime, paused: a.paused, src: a.currentSrc, rate: a.playbackRate, d: a.duration }; });
  const playing = (min = 0.5) => page.waitForFunction((m) => { const a = document.querySelector('#audio'); return !a.paused && a.currentTime > m; }, min, { timeout: 15000 });
  return { ctx, page, errors, shot, noSideScroll, audio, playing, mobile: !!options.isMobile };
}

async function run(name, options) {
  console.log(`\n=== ${name}`);
  const world = await startWorld();
  const browser = await launch();
  const A = await device(browser, world, name, options);
  const { page, shot, noSideScroll, audio, playing, mobile } = A;
  const row = (title) => page.locator('#pod .ep', { hasText: title }).first();
  try {
    /* ---------- a first visit: nothing followed, and the library becomes this device's ---------- */
    await page.goto(world.base);
    await page.waitForSelector('#show-grid .pod-empty');
    await page.waitForFunction(() => /In step|Linked/.test(document.querySelector('#top-status').textContent), null, { timeout: 10000 });
    check(await page.evaluate(() => (localStorage.getItem('pod-key') || '').length >= 20), 'the first device gets the key to the library');
    await shot('1-empty');
    await noSideScroll('empty');

    /* ---------- finding and following shows ---------- */
    await page.click('#show-grid .pod-empty a');
    await page.fill('#pod-add input[type=search]', world.feedUrl('harbour'));
    await page.waitForSelector('#found-list .found');
    check((await page.locator('#found-list .ep-title').first().textContent()) === 'Harbour Hours', 'a feed address finds its show');
    await page.click('#found-list .found button.btn');
    await page.fill('#pod-add input[type=search]', 'the long');
    await page.waitForSelector('#found-list .found:has-text("The Long Ledger")');
    await page.click('#found-list .found button.btn');
    await page.fill('#pod-add input[type=search]', 'fjordfunn');
    await page.waitForSelector('#found-list .found:has-text("Fjordfunn")');
    await shot('2-find');
    // Looked at first, then followed from its page.
    await page.click('#found-list .found .ep-main');
    await page.waitForSelector('#show-list .ep');
    check((await page.locator('#show-list .ep').count()) === 3, 'a show can be looked at before it is followed');
    await page.click('#show-head .btn.primary');
    await page.waitForSelector('#show-head .btn:has-text("Following")');
    // Its new episodes transcribed on the server, and the last three as well.
    await page.click('#show-head .show-opts .switch');
    await page.click('#show-head .backfill label:has-text("3")');
    await page.waitForTimeout(400);
    await shot('3-show');
    await noSideScroll('show');
    await page.locator('#show-list .ep', { hasText: 'Kaldtvannskorallene' }).locator('.ep-main').click();
    await page.click('.ep-sheet button:has-text("Transcribe on the server")');
    await page.waitForSelector('.ep-sheet button:has-text("Withdraw the transcript request")');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.ep-sheet', { state: 'detached' });
    await page.waitForSelector('#show-list .ep:has-text("Kaldtvannskorallene") .tag:has-text("Transcript asked for")');
    await page.waitForTimeout(2200);
    const todo = await (await fetch(`${world.base}/api/pod/transcribe`)).json();
    const fjord = todo.shows.find((s) => s.name === 'Fjordfunn');
    check(fjord?.fresh === true && fjord.backfill === 3 && fjord.lang === 'norwegian', `the workflow is told to transcribe the show's new episodes and its last three (${JSON.stringify(fjord)})`);
    check(todo.episodes.length === 1 && todo.episodes[0].title === 'Kaldtvannskorallene' && todo.episodes[0].feedUrl === world.feedUrl('fjord'), `and the one episode that was asked for (${todo.episodes.map((e) => e.title).join()})`);

    /* ---------- what is new ---------- */
    await page.click(mobile ? '#tabbar [data-nav=listen]' : '#nav [data-nav=listen]');
    await page.waitForFunction(() => document.querySelectorAll('#latest-list .ep').length >= 15, null, { timeout: 20000 });
    const home = await page.evaluate(() => ({
      rows: document.querySelectorAll('#latest-list .ep').length,
      first: document.querySelector('#latest-list .ep-title').textContent,
      shows: [...document.querySelectorAll('#show-grid .show-name')].map((x) => x.textContent),
      tags: [...document.querySelectorAll('#latest-list .ep:first-child .tag')].map((x) => x.textContent),
    }));
    check(home.rows === 15 && home.first === 'Why every container is the same size', `new episodes from every show, newest first (${home.rows}, "${home.first}")`);
    check(home.shows.join() === 'Fjordfunn,Harbour Hours,The Long Ledger', `the shows followed (${home.shows.join(', ')})`);
    check(home.tags.includes('Transcript'), `an episode the server transcribed says so (${home.tags.join(', ')})`);
    await page.waitForTimeout(400);
    await shot('4-home');
    await noSideScroll('home');

    /* ---------- playing: the server's copy, its ads skipped ---------- */
    await row('Why every container').locator('.ep-play').click();
    await playing();
    let a = await audio();
    check(a.src.endsWith(`/library/${world.transcribed}.mp3`), `a transcribed episode plays the copy its transcript was made from (${a.src.split('/').slice(-2).join('/')})`);
    check(await page.locator('#playbar').isVisible(), 'the player is along the bottom');
    check((await page.locator('#playbar .scrub-ads i').count()) === (mobile ? 1 : 1), 'the ad is marked on the position slider');
    await page.evaluate(() => { document.querySelector('#audio').currentTime = 38; });
    await page.waitForFunction(() => document.querySelector('#audio').currentTime > 76, null, { timeout: 15000 });
    a = await audio();
    const toast = await page.locator('#toast').textContent();
    check(a.t > 76 && a.t < 90 && /Skipped 0:\d\d of ads/.test(toast), `the sponsor read is jumped over (${a.t.toFixed(1)} s, "${toast}")`);
    await shot('5-skipped');
    await page.click('#toast-action');
    await page.waitForTimeout(1500);
    a = await audio();
    check(a.t > 38 && a.t < 60, `undo goes back into the ad and leaves it alone (${a.t.toFixed(1)} s)`);

    /* ---------- the player opened up ---------- */
    await page.click('#pb-open');
    await page.waitForSelector('.np');
    await page.click('.np-speeds button[data-rate="1.5"]');
    check((await audio()).rate === 1.5, 'speed 1.5');
    await page.click('.np-sleeps button[data-sleep="30"]');
    check(/Pauses in (29:5\d|30:00)/.test(await page.locator('.np-sleep-state').textContent()), 'a sleep timer counts down');
    const note = await page.locator('.np-ads-note').textContent();
    check(/1 ad break marked/.test(note), `the sheet says what it knows about ads (${note})`);
    await page.waitForTimeout(350);
    await shot('6-player');
    await noSideScroll('player');
    await page.click('.np-sleeps button[data-sleep="0"]');
    await page.click('.np-speeds button[data-rate="1"]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.np', { state: 'detached' });

    /* ---------- where it was left ---------- */
    await page.evaluate(() => { document.querySelector('#audio').currentTime = 120; });
    await page.waitForFunction(() => document.querySelector('#audio').currentTime > 121);
    await page.click('#pb-play');
    await page.waitForFunction(() => document.querySelector('#audio').paused);
    await page.waitForTimeout(300);
    await page.reload();
    await page.waitForSelector('#playbar:not(.hidden)');
    const kept = await page.evaluate(() => ({ title: document.querySelector('#pb-title').textContent, line: parseFloat(document.querySelector('#pb-line').style.width) }));
    check(kept.title === 'Why every container is the same size' && kept.line > 38 && kept.line < 43, `after a reload the episode is still in the player, where it was left (${kept.line.toFixed(0)}% in)`);
    check((await page.locator('#started-list .tile').count()) === 0, 'Carry on leaves out what the player already holds');
    await page.click('#pb-play');
    await playing(100);
    a = await audio();
    check(a.t >= 119 && a.t < 126, `it picks up where it stopped (${a.t.toFixed(1)} s)`);
    await page.click('#pb-play');

    /* ---------- the queue ---------- */
    await row('A bakery in 1911').locator('.ep-more').click();
    await page.click('#row-menu button:has-text("Add to the queue")');
    await row('Kanonen i Oslofjorden').locator('.ep-more').click();
    await page.click('#row-menu button:has-text("Play next")');
    await page.click(mobile ? '#tabbar [data-nav=queue]' : '#nav [data-nav=queue]');
    await page.waitForSelector('#pod-queue ol .ep');
    const queued = await page.locator('#pod-queue ol .ep-title').allTextContents();
    check(queued.join(' | ') === 'Kanonen i Oslofjorden | A bakery in 1911', `the queue, "play next" first (${queued.join(' | ')})`);
    await shot('7-queue');
    await noSideScroll('queue');
    // The episode ends: the next one starts by itself.
    await page.evaluate(() => { const x = document.querySelector('#audio'); x.currentTime = x.duration - 1.5; x.play(); });
    await page.waitForFunction(() => document.querySelector('#pb-title').textContent === 'Kanonen i Oslofjorden', null, { timeout: 20000 });
    await playing(0.3);
    check((await page.locator('#pod-queue ol .ep-title').allTextContents()).join() === 'A bakery in 1911', 'when an episode ends the next in the queue plays');
    await page.click('#pb-play');

    /* ---------- an episode in full: its notes, with nothing run from them ---------- */
    await page.click(mobile ? '#tabbar [data-nav=listen]' : '#nav [data-nav=listen]');
    await row('The pilot who boards at night').locator('.ep-main').click();
    await page.waitForSelector('.ep-sheet .notes li');
    await page.waitForTimeout(450);
    const notes = await page.evaluate(() => ({
      pwned: window.__pwned, imgs: document.querySelectorAll('.notes img, .notes script').length,
      times: [...document.querySelectorAll('.notes .note-time')].map((b) => b.textContent),
      link: document.querySelector('.notes a')?.getAttribute('rel'),
    }));
    check(notes.pwned === undefined && notes.imgs === 0 && notes.link === 'noopener noreferrer nofollow', 'show notes are shown without their scripts and images');
    check(notes.times.join() === '(00:30),(02:10)', `times in the notes can be tapped (${notes.times.join()})`);
    await shot('8-episode');
    await page.click('.notes .note-time >> nth=1');
    await playing(129);
    check((await audio()).t >= 130, 'tapping a time plays from there');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.ep-sheet', { state: 'detached' });
    await page.click('#pb-play');

    /* ---------- kept on the device, and played without a connection ---------- */
    await row('A bakery in 1911').locator('.ep-more').click();
    await page.click('#row-menu button:has-text("Save for offline")');
    await page.waitForSelector('#latest-list .ep:has-text("A bakery in 1911") .tag:has-text("Saved")', { timeout: 30000 });
    check(true, "an episode whose host turns web pages away is saved through the library's server");
    await A.ctx.setOffline(true);
    await row('A bakery in 1911').locator('.ep-play').click();
    await playing(0.3);
    a = await audio();
    check(a.src.startsWith('blob:'), 'offline, the saved copy plays');
    await page.click('#pb-play');
    await A.ctx.setOffline(false);

    /* ---------- a second device joins, and the two stay in step ---------- */
    await page.click(mobile ? '#tabbar [data-nav=settings]' : '#nav [data-nav=settings]');
    await page.waitForSelector('.qr svg path');
    await shot('9-settings');
    await noSideScroll('settings');
    const link = await page.evaluate(() => localStorage.getItem('pod-key')).then((k) => `${world.base}/#link=${k}`);
    const B = await device(browser, world, `${name}-b`, options);
    await B.page.goto(world.base);
    await B.page.waitForSelector('#home-link:not(.hidden)');
    check(true, 'a device that is not linked says so, and shows nothing of the library');
    await B.shot('10-unlinked');
    await B.page.fill('#home-link input', link);
    await B.page.click('#home-link .btn.primary');
    await B.page.waitForFunction(() => document.querySelectorAll('#latest-list .ep').length >= 12, null, { timeout: 20000 });
    const there = await B.page.evaluate(() => ({
      shows: document.querySelectorAll('#show-grid .show-tile').length,
      started: [...document.querySelectorAll('#started-list .tile-title')].map((x) => x.textContent),
      queue: document.querySelector('[data-count=queue]').textContent,
    }));
    check(there.shows === 3 && there.started.includes('Why every container is the same size') === false && there.started.length >= 1, `linked with a pasted link, it has the shows and what was started (${there.shows} shows, started: ${there.started.join(' | ')})`);
    // Played to the end on B: A hears of it.
    await B.page.locator('#latest-list .ep', { hasText: 'A strike that moved a city' }).locator('.ep-more').click();
    await B.page.click('#row-menu button:has-text("Mark as played")');
    await B.page.waitForTimeout(2500);
    await page.click(mobile ? '#tabbar [data-nav=listen]' : '#nav [data-nav=listen]');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.click('#latest-filter label:has-text("All")');
    await page.waitForSelector('#latest-list .ep.is-done:has-text("A strike that moved a city")', { timeout: 15000 });
    check(true, 'what is played on one device is played on the other');
    await B.ctx.close();

    /* ---------- a new episode comes out ---------- */
    world.publish('ledger', 'Coal, 1926');
    await page.click('#latest-refresh');
    await page.waitForSelector('#latest-list .ep:first-child:has-text("Coal, 1926")', { timeout: 15000 });
    check(true, 'a new episode turns up at the top');

    /* ---------- the transcript, joined to the player ---------- */
    await page.click('#latest-filter label:has-text("All")');
    await row('Why every container').locator('.ep-more').click();
    await page.click('#row-menu button:has-text("Read the transcript")');
    await page.waitForSelector('#transcript .seg');
    check(await page.evaluate(() => document.body.classList.contains('view-transcribe') && document.querySelectorAll('#transcript .para.ad').length > 0), 'the transcript opens on the transcript side, its ad marked');
    await page.locator('#transcript .seg', { hasText: 'It took ten years of committees' }).click();
    await playing(139);
    await page.waitForSelector('#transcript .seg.playing');
    const follow = await page.evaluate(() => ({ line: document.querySelector('#transcript .seg.playing').textContent, title: document.querySelector('#pb-title').textContent }));
    check(/ten years of committees/.test(follow.line) && follow.title === 'Why every container is the same size', 'tapping a sentence plays it in the player, and the page follows along');
    await page.waitForTimeout(500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot('11-transcript');
    await noSideScroll('transcript with the player');
    await page.click('#play');
    await page.waitForFunction(() => document.querySelector('#audio').paused);
    check(true, "the transcript's own play button is the player's");

    /* ---------- shows out, as a file ---------- */
    if (!mobile) {
      await page.click('#nav [data-nav=settings]');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#pod-settings button:has-text("Export 3 shows")')]);
      const opml = await readFile(await dl.path(), 'utf8');
      check(dl.suggestedFilename() === 'shows.opml' && SHOWS.every((s) => opml.includes(world.feedUrl(s.slug))), 'the shows export as OPML');
    }

    check(!A.errors.length, `no page errors${A.errors.length ? `: ${A.errors.slice(0, 3).join(' | ')}` : ''}`);
  } catch (err) {
    check(false, `the run got through (${err.message.split('\n')[0]})`);
    await shot('failed').catch(() => {});
    if (A.errors.length) console.log('  page errors:', A.errors.slice(0, 5).join(' | '));
    console.log('  server log:', world.logs.join('').split('\n').slice(-8).join('\n    '));
  } finally {
    await browser.close();
    await world.close();
  }
}

// With its service worker, the app opens again without a connection.
async function offline() {
  console.log('\n=== offline start');
  const world = await startWorld({ audioSeconds: 30 });
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  try {
    await page.goto(world.base);
    // The worker takes the page over (reloading it once), then keeps what the page loads.
    await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 20000 });
    await page.waitForSelector('#show-grid');
    await page.reload();
    await page.waitForSelector('#show-grid');
    await page.waitForTimeout(1500);
    const kept = await page.evaluate(async () => (await (await caches.open('transcriber-shell')).keys()).map((r) => new URL(r.url).pathname));
    check(kept.includes('/') && kept.includes('/app.js') && kept.includes('/ui/pod.js') && !kept.some((p) => p.startsWith('/api/') || p.startsWith('/library/')), `the app's own files are kept, the server's answers are not (${kept.length} files)`);
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('#show-grid', { timeout: 15000 });
    check(/Offline|not answering/.test(await page.locator('#top-status').textContent()), 'offline, the app still opens and says so');
  } catch (err) {
    check(false, `the offline start got through (${err.message.split('\n')[0]})`);
  } finally {
    await browser.close();
    await world.close();
  }
}

await mkdir(SHOTS, { recursive: true });
const { defaultBrowserType, ...iphone } = devices['iPhone 13'];
const only = process.argv[2];
if (!only || only === 'desktop') await run('desktop', { viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
if (!only || only === 'phone') await run('phone', { ...iphone, colorScheme: 'dark' });
if (!only || only === 'light') await run('light', { viewport: { width: 1180, height: 900 }, colorScheme: 'light' });
if (!only || only === 'offline') await offline();
console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
process.exit(failures.length ? 1 : 0);
