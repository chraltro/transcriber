// The podcast side, end to end in a real browser against the app's real server and a stand-in
// for the podcast world (tests/pod-world.mjs): following shows, what is new, playing, where an
// episode was left, ads skipped from a transcript, the queue, two devices kept in step, an
// episode saved and played without a connection, and the transcript side joined to the player.
// Screenshots of each state go to ui-shots/.
import { chromium, webkit, devices } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startWorld, SHOWS, episodeIdOf } from './pod-world.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const SHOTS = join(ROOT, 'ui-shots');
// ENGINE=webkit runs it in Safari's engine, which is what an iPhone has whatever the browser.
const WEBKIT = process.env.ENGINE === 'webkit';
// What content blockers' lists go for in an address (after EasyList's general rules).
const BLOCKED = [/[/._-]ads?[/._-]/i, /\/ad[a-z]+\.(js|css)$/i, /[/._-](adv|advert\w*|sponsor\w*|banner|promo|track(ing|er)?|analytics|pixel|beacon|popup)[/._-]/i];
const launch = () => (WEBKIT ? webkit.launch() : chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--autoplay-policy=no-user-gesture-required'] }));

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
  // A content blocker stops the service one episode's audio is counted by; the file behind it is there.
  await ctx.route('https://dts.podtrac.com/**', (route) => route.abort('blockedbyclient'));
  await ctx.route('https://audio.test.example/**', (route) => route.fulfill({ status: 200, contentType: 'audio/wav', body: world.audio }));
  const page = await ctx.newPage();
  const errors = [];
  // (A download the podcast's host refuses to web pages is expected, and tried through the
  // library's server next; WebKit reports the refusal as an error of the page's.)
  const refused = /Access-Control-Allow-Origin|due to access control checks/;
  page.on('pageerror', (e) => { if (refused.test(e.message)) return; errors.push(e.message); console.log(`  [page error] ${e.message} ${(e.stack || '').split('\n').slice(0, 4).join(' | ')}`); });
  page.on('requestfailed', (r) => { if (!/audio|\.wav|\.mp3|itunes/.test(r.url())) console.log(`  [request failed] ${r.url().slice(0, 120)} ${r.failure()?.errorText || ''}`); });
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_|blocked by CORS policy/.test(m.text()) && !refused.test(m.text())) errors.push(m.text()); });
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
    await page.waitForTimeout(1500);
    console.log(`  started: body class "${await page.evaluate(() => document.body.className)}", status "${await page.locator('#top-status').textContent()}"`);
    await page.waitForSelector('#show-grid .pod-empty');
    await page.waitForSelector('#home-link:not(.hidden) .btn.primary');
    check(await page.evaluate(() => !localStorage.getItem('pod-key')) && !(await (await fetch(`${world.base}/api/pod/status`)).json()).claimed, 'opening the page does not take the library');
    await page.click('#home-link .btn.primary');
    await page.waitForFunction(() => /In step|Linked/.test(document.querySelector('#top-status').textContent), null, { timeout: 10000 });
    check(await page.evaluate(() => (localStorage.getItem('pod-key') || '').length >= 20 && document.querySelector('#home-link').classList.contains('hidden')), 'a tap starts it, and this device holds its key');
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
    check((await fetch(`${world.base}/api/pod/transcribe`)).status === 401, 'what is to be transcribed is not for everyone to read');
    const todo = await (await fetch(`${world.base}/api/pod/transcribe`, { headers: { authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('pod-key'))}` } })).json();
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
    check((await page.locator('#playbar .scrub-marks i').count()) === (mobile ? 1 : 1), 'the ad is marked on the position slider');
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
    const note = await page.locator('.np-skips-note').textContent();
    check(/1 ad break marked/.test(note), `the sheet says what it knows about ads (${note})`);
    await page.waitForTimeout(350);
    await shot('6-player');
    await noSideScroll('player');
    await page.click('.np-sleeps button[data-sleep="0"]');
    await page.click('.np-speeds button[data-rate="1"]');

    /* ---------- pauses, shortened ---------- */
    // (The world's audio stops for half a second every few seconds, and for two and a half
    // every 45: at 42.5, inside the ad, at 87.5, and so on.)
    const trimNote = () => page.locator('.np-trim-note').textContent();
    check(/longest pause to leave alone/.test(await trimNote()), 'pauses are left as they are until a limit is picked');
    await page.click('.np-trims button[data-trim="0.8"]');
    await page.waitForFunction(() => /longer than 0\.8 s/.test(document.querySelector('.np-trim-note').textContent), null, { timeout: 10000 });
    check(/^6 pauses in this episode are longer than 0\.8 s/.test(await trimNote()), `the server's list of where its copy goes quiet is used (${await trimNote()})`);
    await page.evaluate(() => { document.querySelector('#audio').currentTime = 81; });
    await page.waitForFunction(() => document.querySelector('#audio').currentTime > 86.5, null, { timeout: 15000 });
    const before = Number(await page.locator('.np-trim-state').getAttribute('data-saved'));
    await page.waitForFunction(() => document.querySelector('#audio').currentTime > 90, null, { timeout: 15000 });
    const left = Number(await page.locator('.np-trim-state').getAttribute('data-saved'));
    check(before === 0, `a pause of half a second is not touched (${before} s left out by 86 s)`);
    check(left > 1.3 && left < 2.1, `one of two and a half seconds is cut down to the limit (${left} s left out)`);
    check(/saved$/.test(await page.locator('.np-trim-state').textContent()), `and the sheet says what that saved (${await page.locator('.np-trim-state').textContent()})`);
    await page.waitForTimeout(300);
    await shot('6b-pauses');
    await noSideScroll('pauses');
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

    /* ---------- chapters: from a chapters file the server reads, and from times in the notes ---------- */
    {
      const chapterRows = () => page.evaluate(() => [...document.querySelectorAll('.ep-sheet .chapter')].map((b) => `${b.querySelector('.chapter-time').textContent} ${b.querySelector('.chapter-title').textContent}${b.getAttribute('aria-current') === 'true' ? ' *' : ''}`));
      await row('What the tide tables leave out').locator('.ep-main').click();
      await page.waitForSelector('.ep-sheet .chapter-list');
      await page.waitForSelector('.ep-sheet .notes li');
      check((await chapterRows()).join(' | ') === '0:00 Low water | 1:15 Reading a tide table | 2:30 Storm surges | 3:45 What the harbour master knows', `an episode's chapters file is listed in its sheet, without what is kept out of the list (${(await chapterRows()).join(' | ')})`);
      check(await page.evaluate(() => { const c = document.querySelector('.ep-sheet .chapters-box'); return c.compareDocumentPosition(document.querySelector('.ep-sheet .notes-box')) === Node.DOCUMENT_POSITION_FOLLOWING; }), 'the chapters come above the notes');
      await page.waitForTimeout(400);
      await shot('8b-chapters');
      await noSideScroll('chapters');
      await page.click('.ep-sheet .chapter:has-text("Storm surges")');
      await playing(150);
      a = await audio();
      check(a.t >= 150 && a.t < 160 && (await page.locator('#pb-title').textContent()) === 'What the tide tables leave out', `tapping a chapter plays the episode from its start (${a.t.toFixed(1)} s)`);
      await page.waitForFunction(() => document.querySelector('.ep-sheet .chapter[aria-current="true"]')?.textContent.includes('Storm surges'), null, { timeout: 5000 }).catch(() => {});
      check((await chapterRows()).filter((r) => r.endsWith('*')).join() === '2:30 Storm surges *', `and the chapter being played is marked (${(await chapterRows()).join(' | ')})`);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.ep-sheet', { state: 'detached' });
      const bar = await page.evaluate(() => ({ ticks: [...document.querySelectorAll('#playbar .scrub-marks .scrub-chapter')].map((t) => Math.round(parseFloat(t.style.left))), bands: document.querySelectorAll('#playbar .scrub-marks i').length }));
      check(bar.ticks.join() === '25,50,75' && bar.bands === 0, `the chapters are ticks on the position slider, not bands (${bar.ticks.join()} %, ${bar.bands} bands)`);

      // The player opened up: the chapter under the title, and the one before and after.
      await page.click('#pb-open');
      await page.waitForSelector('.np .np-chapter:not(.hidden)');
      await page.click('.np-play');
      await page.waitForFunction(() => document.querySelector('#audio').paused);
      const np = () => page.evaluate(() => ({ title: document.querySelector('.np-chapter-title').textContent, count: document.querySelector('.np-chapter-count').textContent, t: document.querySelector('#audio').currentTime, ticks: document.querySelectorAll('.np-scrub .scrub-chapter').length }));
      let now = await np();
      check(now.title === 'Storm surges' && now.count === 'Chapter 3 of 4' && now.ticks === 3, `the player shows the chapter being played, and ticks for the chapters (${JSON.stringify(now)})`);
      await page.waitForTimeout(350);
      await page.evaluate(() => { document.querySelector('#sheet').scrollTop = 0; });
      await shot('8c-player-chapters');
      await noSideScroll('player with chapters');
      await page.click('.np-chapter-next');
      await page.waitForFunction(() => document.querySelector('.np-chapter-title').textContent === 'What the harbour master knows', null, { timeout: 5000 }).catch(() => {});
      now = await np();
      check(now.title === 'What the harbour master knows' && now.t >= 224.9 && now.t < 226 && await page.locator('.np-chapter-next').isDisabled(), `next chapter goes to its start, and there is none after the last (${JSON.stringify(now)})`);
      await page.click('.np-chapter-prev');
      await page.waitForFunction(() => document.querySelector('.np-chapter-title').textContent === 'Storm surges', null, { timeout: 5000 }).catch(() => {});
      now = await np();
      check(now.title === 'Storm surges' && now.t >= 149.9 && now.t < 151, `previous chapter, just after one began, goes to the one before (${JSON.stringify(now)})`);
      // Played on into the next chapter, the player follows.
      await page.evaluate(() => { document.querySelector('#audio').currentTime = 223; });
      await page.click('.np-play');
      await page.waitForFunction(() => document.querySelector('.np-chapter-title').textContent === 'What the harbour master knows', null, { timeout: 15000 }).catch(() => {});
      now = await np();
      check(now.title === 'What the harbour master knows' && now.t >= 224.5, `the chapter shown changes as the episode plays into the next (${now.title}, ${now.t.toFixed(1)} s)`);
      await page.click('.np-play');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.np', { state: 'detached' });

      // Times beginning lines of the notes, three or more, are chapters too.
      await row('The ferry company that never made money').locator('.ep-main').click();
      await page.waitForSelector('.ep-sheet .chapter-list');
      check((await chapterRows()).join(' | ') === '0:00 Opening the ledger | 1:20 The first season | 3:20 Why the fares stayed low', `times written in the notes make chapters (${(await chapterRows()).join(' | ')})`);
      await page.click('.ep-sheet .chapter:has-text("The first season")');
      await playing(80);
      a = await audio();
      check(a.t >= 80 && a.t < 90, `and play from there (${a.t.toFixed(1)} s)`);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.ep-sheet', { state: 'detached' });
      check((await page.locator('#playbar .scrub-marks .scrub-chapter').count()) === 2, 'with their ticks on the slider');
      await page.click('#pb-play');
      await page.waitForFunction(() => document.querySelector('#audio').paused);

      // An episode without chapters looks as it did.
      await row('The pilot who boards at night').locator('.ep-main').click();
      await page.waitForSelector('.ep-sheet .notes li');
      await page.waitForTimeout(300);
      check(!(await page.locator('.ep-sheet .chapters-box').isVisible()) && (await page.locator('.ep-sheet .chapter').count()) === 0, 'an episode with two times in its notes has no chapters');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.ep-sheet', { state: 'detached' });
    }

    /* ---------- kept on the device, and played without a connection ---------- */
    await row('A bakery in 1911').locator('.ep-more').click();
    await page.click('#row-menu button:has-text("Save for offline")');
    await page.waitForSelector('#latest-list .ep:has-text("A bakery in 1911") .tag:has-text("Saved")', { timeout: 30000 });
    check(true, "an episode whose host turns web pages away is saved through the library's server");
    // (Offline as the test browser fakes it also cuts WebKit off from its own stored files, so
    // there the saved copy is played with the connection up.)
    if (!WEBKIT) await A.ctx.setOffline(true);
    await row('A bakery in 1911').locator('.ep-play').click();
    await playing(0.3);
    a = await audio();
    check(a.src.startsWith('blob:'), `${WEBKIT ? 'the saved copy is the one played' : 'offline, the saved copy plays'}`);
    // Nobody listed where this copy goes quiet: the device listens through it itself.
    await page.click('#pb-open');
    await page.waitForSelector('.np');
    await page.waitForFunction(() => /longer than 0\.8 s/.test(document.querySelector('.np-trim-note').textContent), null, { timeout: 30000 }).catch(() => {});
    check(/^6 pauses/.test(await page.locator('.np-trim-note').textContent()), `the pauses of a saved episode are found on the device (${await page.locator('.np-trim-note').textContent()})`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.np', { state: 'detached' });
    await page.click('#pb-play');
    await A.ctx.setOffline(false);

    // A streamed episode has no file here to listen through: saving it gets one, and the
    // player moves over to the saved copy where it is.
    await row('The pilot who boards at night').locator('.ep-play').click();
    await playing(130);
    await page.click('#pb-open');
    await page.waitForSelector('.np');
    await page.waitForSelector('.np-trim-save:not(.hidden)');
    check(/saved on this device/.test(await page.locator('.np-trim-note').textContent()), `a streamed episode says what finding its pauses takes (${await page.locator('.np-trim-note').textContent()})`);
    await page.click('.np-trim-save');
    // (The saved copy is in the player before it has been moved to where the other one was.)
    await page.waitForFunction(() => { const x = document.querySelector('#audio'); return x.currentSrc.startsWith('blob:') && !x.paused && x.currentTime >= 130 && /longer than 0\.8 s/.test(document.querySelector('.np-trim-note').textContent); }, null, { timeout: 30000 }).catch(() => {});
    a = await audio();
    check(a.src.startsWith('blob:') && a.t >= 130 && a.t < 160 && !a.paused && /^6 pauses/.test(await page.locator('.np-trim-note').textContent()), `saved from the player, it plays on from the saved copy, its pauses found (${a.t.toFixed(0)} s, ${await page.locator('.np-trim-note').textContent()})`);
    await page.click('.np-trims button[data-trim="0"]');
    check((await page.locator('.np-trim-state').textContent()) === 'Off', 'and off is off');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.np', { state: 'detached' });
    await page.click('#pb-play');

    // An episode whose address goes through a service that counts downloads, which a content
    // blocker stops: the file behind the service is played.
    if (!WEBKIT) {
      await row('Et vrak ingen savnet').locator('.ep-play').click();
      await playing(0.3).catch(() => {});
      a = await audio();
      check(a.src === 'https://audio.test.example/audio/fjord/1.wav' && !a.paused, `an episode behind a blocked counting service plays from the file's own address (${a.src})`);
      await page.click('#pb-play');
    }

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
    check(await page.evaluate(() => document.body.classList.contains('view-transcribe') && document.querySelectorAll('#transcript .para.plug').length > 0), 'the transcript opens on the transcript side, its ad marked');
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

    /* ---------- the newest episodes, kept on the device by themselves ---------- */
    {
      const fjord = SHOWS.find((s) => s.slug === 'fjord');
      const [first, second, third] = [0, 1, 2].map((i) => episodeIdOf(fjord, i));
      const index = () => page.evaluate(() => JSON.parse(localStorage.getItem('pod-downloads') || '{}'));
      const until = (test, what) => page.waitForFunction(test, null, { timeout: 40000 }).then(() => true, () => { console.log(`  (waited in vain: ${what})`); return false; });
      const kept = (ids, hand = []) => until(`(() => { const d = JSON.parse(localStorage.getItem('pod-downloads') || '{}'); const auto = Object.keys(d).filter((id) => d[id].auto && id.length === 16).sort().join(); return auto === ${JSON.stringify([...ids].sort().join())} && ${JSON.stringify(hand)}.every((id) => d[id] && !d[id].auto); })()`, `${ids} by themselves`);
      await page.click(mobile ? '#tabbar [data-nav=listen]' : '#nav [data-nav=listen]');
      await page.click('#show-grid .show-tile:has-text("Fjordfunn")');
      await page.waitForSelector('#show-head .keep-newest');
      await page.waitForSelector('#show-list .ep:has-text("Kanonen i Oslofjorden")');
      await page.click('#show-head .keep-newest label:has-text("2")');
      check(await kept([first, second]), 'set to keep the newest two, the two newest not played are saved by themselves');
      await page.waitForSelector('#show-list .ep:has-text("Kaldtvannskorallene") .tag:has-text("Saved")');
      check(await page.evaluate(() => JSON.parse(localStorage.getItem('pod-keep-newest') || '{}')), 'the choice is kept on this device');
      // One played: it goes, and the next one comes.
      await page.locator('#show-list .ep', { hasText: 'Kanonen i Oslofjorden' }).locator('.ep-more').click();
      await page.click('#row-menu button:has-text("Mark as played")');
      check(await kept([second, third]), 'one is played: it goes, and the next one is saved');
      // One saved by hand stays when the show is turned to none.
      await page.locator('#show-list .ep', { hasText: 'Kanonen i Oslofjorden' }).locator('.ep-more').click();
      await page.click('#row-menu button:has-text("Save for offline")');
      check(await kept([second, third], [first]), 'an episode saved by hand is saved as such');
      await page.evaluate(() => document.querySelector('#show-head .switch')?.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(400);
      await shot('12-keep-newest');
      await noSideScroll('keep the newest');
      await page.click(mobile ? '#tabbar [data-nav=settings]' : '#nav [data-nav=settings]');
      await page.waitForSelector('#pod-settings .kept-note');
      const note = await page.locator('#pod-settings .kept-note').textContent();
      check(/the newest 2 of Fjordfunn\./.test(note) && /2 episodes saved that way/.test(note) && await page.locator('#pod-settings button:has-text("Stop keeping episodes by themselves")').isVisible(), `Settings says what is kept by itself (${note})`);
      await page.evaluate(() => document.querySelector('#pod-settings .kept-note').scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(400);
      await shot('13-keep-settings');
      await page.goBack();
      await page.waitForSelector('#show-head .keep-newest');
      await page.click('#show-head .keep-newest label:has-text("None")');
      check(await kept([], [first]), 'turned to none, what was saved by itself goes, and what was saved by hand stays');
      check(Object.keys(await index()).includes(first), 'the one saved by hand is still on the device');
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
  console.log('\n=== starting');
  const world = await startWorld({ audioSeconds: 30 });
  const browser = await launch();
  // A content blocker (Safari on an iPhone has them, and so has the app on its home screen)
  // drops files whose address looks like an ad's. One dropped file of the app's script and
  // nothing starts: the page is there, styled, and no button does anything.
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await ctx.route('**/*', (route) => (BLOCKED.some((re) => re.test(new URL(route.request().url()).pathname)) ? route.abort('blockedbyclient') : route.continue()));
    const page = await ctx.newPage();
    await page.goto(world.base);
    await page.waitForTimeout(3500);
    const state = await page.evaluate(() => ({ started: !!window.__appStarted, why: document.querySelector('#boot-fail').hidden ? '' : document.querySelector('#boot-why').textContent }));
    check(state.started && !state.why, `with a content blocker on, the app starts${state.why ? ` (${state.why})` : ''}`);
    await ctx.close();
    // ...and when a file is kept from loading all the same, the page says which.
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await ctx2.route('**/lib/playback.js', (route) => route.abort('blockedbyclient'));
    const page2 = await ctx2.newPage();
    await page2.goto(world.base);
    await page2.waitForSelector('#boot-fail:not([hidden])', { timeout: 10000 }).catch(() => {});
    await page2.waitForFunction(() => /playback\.js/.test(document.querySelector('#boot-why').textContent), null, { timeout: 10000 }).catch(() => {});
    const why = await page2.locator('#boot-why').textContent();
    check(/^lib\/playback\.js was kept from loading/.test(why), `a file that is kept from loading is named (${why})`);
    await ctx2.close();
  }
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  try {
    page.on('pageerror', (e) => console.log(`  [page error] ${e.message} ${(e.stack || '').split('\n').slice(0, 3).join(' | ')}`));
    page.on('console', (m) => { if (m.type() === 'error') console.log(`  [console] ${m.text().slice(0, 200)}`); });
    page.on('requestfailed', (r) => console.log(`  [request failed] ${r.url().slice(0, 100)} ${r.failure()?.errorText || ''}`));
    await page.goto(world.base);
    // A first visit, as a web app just put on the home screen makes it: the worker installs,
    // takes the page over and reloads it once. The app has to be alive after that.
    await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 20000 });
    await page.waitForTimeout(2500);
    const alive = await page.evaluate(() => ({ started: !!window.__appStarted, view: document.body.className, tab: !!document.querySelector('#tabbar a.on'), status: document.querySelector('#top-status').textContent, failed: !document.querySelector('#boot-fail').hidden && document.querySelector('#boot-why').textContent }));
    check(alive.started && alive.tab && !alive.failed, `after the worker takes over and reloads the page, the app is running (${JSON.stringify(alive)})`);
    await page.waitForSelector('#show-grid');
    // Every file of the app this load used has a kept copy, though the browser already had them
    // all from the first load and the server now answers "unchanged" (an ETag and a 304).
    const unkept = () => page.evaluate(async () => {
      const kept = new Set((await (await caches.open('transcriber-shell-3')).keys()).map((r) => new URL(r.url).pathname));
      return [location.pathname, ...performance.getEntriesByType('resource').map((r) => r.name)]
        .map((u) => new URL(u, location.href)).filter((u) => u.origin === location.origin && !/^\/(api|library|enhance)\//.test(u.pathname))
        .map((u) => u.pathname).filter((p) => !kept.has(p));
    });
    let missing = await unkept();
    check(!missing.length, `after the first load under the worker, every file of the app is kept${missing.length ? ` (not: ${missing.join(', ')})` : ''}`);
    await page.reload();
    await page.waitForSelector('#show-grid');
    const again = await page.evaluate(() => !!window.__appStarted && !!document.querySelector('#tabbar a.on'));
    check(again, 'and on the next start, with every file passing through the worker');
    await page.waitForTimeout(1500);
    const kept = await page.evaluate(async () => (await (await caches.open('transcriber-shell-3')).keys()).map((r) => new URL(r.url).pathname));
    check(kept.includes('/') && kept.includes('/app.js') && kept.includes('/ui/pod.js') && !kept.some((p) => p.startsWith('/api/') || p.startsWith('/library/')), `the app's own files are kept, the server's answers are not (${kept.length} files)`);
    // One more start, every file of it unchanged on the server: the kept set stays whole.
    await page.reload();
    await page.waitForSelector('#show-grid');
    await page.waitForTimeout(1500);
    missing = await unkept();
    check(!missing.length, `after one more start, every file of the app is still kept${missing.length ? ` (not: ${missing.join(', ')})` : ''}`);
    // (WebKit as the test browser builds it fails every load while "offline", its own worker's
    // answers included, so there the server is taken away instead.)
    if (WEBKIT) await world.stopApp(); else await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('#show-grid', { timeout: 15000 });
    // (With the server gone and the device never linked, the page knows of no server at all.)
    const status = await page.locator('#top-status').textContent();
    check(await page.evaluate(() => !!window.__appStarted) && (WEBKIT ? /Offline|not answering|Kept in this browser/ : /Offline|not answering/).test(status), `${WEBKIT ? 'with the server gone, the app still opens from the copies it kept' : 'offline, the app still opens and says so'} (${status})`);
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
