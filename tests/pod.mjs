// The podcast side, end to end in a real browser against the app's real server and a stand-in
// for the podcast world (tests/pod-world.mjs): following shows, what is new, playing, where an
// episode was left, ads skipped from a transcript, the queue, two devices kept in step, an
// episode saved and played without a connection, and the transcript side joined to the player.
// Screenshots of each state go to ui-shots/.
import { chromium, webkit, devices } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startWorld, SHOWS, episodeIdOf } from './pod-world.mjs';
import { makeKeys, decrypt } from '../server/push.mjs';
import { subId } from '../lib/podstate.js';

const ROOT = new URL('..', import.meta.url).pathname;
const SHOTS = join(ROOT, 'ui-shots');
// ENGINE=webkit runs it in Safari's engine, which is what an iPhone has whatever the browser.
const WEBKIT = process.env.ENGINE === 'webkit';
// What content blockers' lists go for in an address (after EasyList's general rules).
const BLOCKED = [/[/._-]ads?[/._-]/i, /\/ad[a-z]+\.(js|css)$/i, /[/._-](adv|advert\w*|sponsor\w*|banner|promo|track(ing|er)?|analytics|pixel|beacon|popup)[/._-]/i];
// WebKit as built for Linux, which CI runs, plays a file out of the page's own storage (a blob)
// only now and then: there a saved copy is checked to be the one in the player, not that it plays.
// Chromium runs every check of playing it. (An iPhone's WebKit is another build.)
const blobPlays = !WEBKIT;
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
  // What the page tells the lock screen and the headphones is kept where the test can press it.
  await ctx.addInitScript(() => {
    // Every audio element that is asked to play, the ones not on the page included.
    window.__media = new Set();
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { window.__media.add(this); return play.call(this); };
    const ms = navigator.mediaSession;
    if (!ms) return;
    window.__ms = {};
    const set = ms.setActionHandler.bind(ms);
    ms.setActionHandler = (action, fn) => { window.__ms[action] = fn; try { set(action, fn); } catch {} };
  });
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
  page.on('console', (m) => { if (/^player: /.test(m.text())) console.log(`  [page] ${m.text()}`); if (m.type() === 'error' && !/Failed to load resource|net::ERR_|blocked by CORS policy/.test(m.text()) && !refused.test(m.text())) errors.push(m.text()); });
  const shot = (state) => page.screenshot({ path: join(SHOTS, `pod-${name}-${state}.png`) });
  const noSideScroll = async (state) => {
    const [w, sw] = await page.evaluate(() => [window.innerWidth, document.documentElement.scrollWidth]);
    check(sw <= w + 1, `${state}: no sideways scrolling (${sw} px of ${w})`);
  };
  const audio = () => page.evaluate(() => { const a = document.querySelector('#audio'); return { t: a.currentTime, paused: a.paused, src: a.currentSrc, rate: a.playbackRate, d: a.duration }; });
  const playing = (min = 0.5, timeout = 15000) => page.waitForFunction((m) => { const a = document.querySelector('#audio'); return !a.paused && a.currentTime > m; }, min, { timeout });
  return { ctx, page, errors, shot, noSideScroll, audio, playing, mobile: !!options.isMobile };
}

async function run(name, options) {
  console.log(`\n=== ${name}`);
  const world = await startWorld();
  const browser = await launch();
  const A = await device(browser, world, name, options);
  const { page, shot, noSideScroll, audio, playing, mobile } = A;
  const row = (title) => page.locator('#pod .ep', { hasText: title }).first();
  // The children of `sel`, a frame at a time for `ms`: each one's id, top, height, transform and
  // whether it is on its way out (ui/motion.js), to see a list change in place.
  const frames = (sel, ms = 900) => page.evaluate(([sel, ms]) => new Promise((done) => {
    const seen = [];
    const t0 = performance.now();
    const look = () => {
      seen.push([...document.querySelectorAll(sel)].map((el) => { const r = el.getBoundingClientRect(); return { id: el.dataset.id, top: Math.round(r.top), y: Math.round(r.top + scrollY), h: Math.round(r.height), moved: getComputedStyle(el).transform !== 'none', leaving: el.classList.contains('leaving') }; }));
      if (performance.now() - t0 < ms) requestAnimationFrame(look); else done(seen);
    };
    look();
  }), [sel, ms]);
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
    // Its new episodes transcribed on the server, and the last three as well: in the show's own
    // settings, behind a button, so the page is the show and its episodes.
    check(!(await page.locator('#show-head .switch, #show-head .segmented').count()) && await page.locator('#show-head .show-settings').isVisible(), "a show's page carries its settings behind a button, not on the page");
    await page.click('#show-head .show-settings');
    await page.waitForSelector('.show-sheet .switch');
    await page.click('.show-sheet .switch:has-text("Transcribe new episodes")');
    await page.click('.show-sheet .backfill label:has-text("3")');
    await page.waitForTimeout(400);
    await shot('3b-show-settings');
    await noSideScroll('show settings');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.show-sheet', { state: 'detached' });
    const showSays = await page.locator('#show-head .show-settings').textContent();
    check(/Show settings.*transcribed/.test(showSays), `and the button says what is on (${showSays})`);
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
    await page.waitForSelector('#playbar .score[data-breaks="1"]', { state: 'attached', timeout: 5000 }).catch(() => {});
    check((await page.locator('#playbar .score').getAttribute('data-breaks')) === '1', 'the ad is marked on the position control');
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
    // Under the transport, one row of buttons, each saying where its control stands; a tap opens
    // that control under the row, one at a time, and a second tap puts it away.
    const tools = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.np-tool')].map((b) => [b.dataset.tool, b.querySelector('.np-tool-value').textContent])));
    const panelOpen = () => page.evaluate(() => [...document.querySelectorAll('.np-panel')].filter((x) => !x.classList.contains('hidden')).map((x) => x.dataset.tool).join());
    const t0 = await tools();
    check(t0.speed === '1×' && t0.sleep === 'Off' && t0.trim === 'Off' && t0.skips === 'Skipped' && t0.next === 'None' && (await panelOpen()) === '', `under the transport, a row of buttons says where each control stands, none of them open (${JSON.stringify(t0)})`);
    await page.click('.np-tool-speed');
    check((await panelOpen()) === 'speed' && (await page.locator('.np-tool-speed').getAttribute('aria-expanded')) === 'true', 'the speed button opens the speed control');
    await page.click('.np-speeds button[data-rate="1.5"]');
    check((await audio()).rate === 1.5, 'speed 1.5');
    check((await tools()).speed === '1.5×', `and its button says so (${(await tools()).speed})`);
    await page.click('.np-tool-sleep');
    check((await panelOpen()) === 'sleep', 'the sleep button opens the sleep timer in its place: one control at a time');
    await page.click('.np-sleeps button[data-sleep="30"]');
    check(/Pauses in (29:5\d|30:00)/.test(await page.locator('.np-sleep-state').textContent()), 'a sleep timer counts down');
    check(/^(30|29) min$/.test((await tools()).sleep), `and its button says how long is left (${(await tools()).sleep})`);
    await page.click('.np-tool-skips');
    const note = await page.locator('.np-skips-note').textContent();
    check(/1 ad break marked/.test(note) && await page.locator('.np-skips-note').isVisible(), `the ads button opens what the sheet knows about ads (${note})`);
    await page.waitForTimeout(350);
    await shot('6-player');
    await noSideScroll('player');
    await page.click('.np-tool-skips');
    check((await panelOpen()) === '' && (await page.locator('.np-tool-skips').getAttribute('aria-expanded')) === 'false', 'pressed again, a button puts its control away');
    await page.click('.np-tool-sleep');
    await page.click('.np-sleeps button[data-sleep="0"]');
    await page.click('.np-tool-speed');
    await page.click('.np-speeds button[data-rate="1"]');
    check((await tools()).sleep === 'Off' && (await tools()).speed === '1×', 'and the buttons follow the controls back');

    /* ---------- pauses, shortened ---------- */
    // (The world's audio stops for half a second every few seconds, and for two and a half
    // every 45: at 42.5, inside the ad, at 87.5, and so on.)
    const trimNote = () => page.locator('.np-trim-note').textContent();
    await page.click('.np-tool-trim');
    check(/longest pause to leave alone/.test(await trimNote()) && await page.locator('.np-trim-note').isVisible(), 'pauses are left as they are until a limit is picked');
    await page.click('.np-trims button[data-trim="0.8"]');
    check((await tools()).trim === '0.8 s', `the pauses button says the limit picked (${(await tools()).trim})`);
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

    /* ---------- the score: the episode drawn as the position control ---------- */
    {
      const score = () => page.evaluate(() => {
        const s = document.querySelector('.np .score');
        const slider = s.querySelector('[role=slider]');
        return { shows: s.dataset.shows, boxes: s.dataset.breaks, ticks: s.dataset.ticks, text: slider.getAttribute('aria-valuetext'), now: slider.getAttribute('aria-valuenow'), max: slider.getAttribute('aria-valuemax'),
          who: document.querySelector('.np-now-who').textContent, hue: document.querySelector('.np-now-sw').dataset.hue, line: document.querySelector('.np-now-text').innerText.trim(),
          open: s.classList.contains('scrubbing') && getComputedStyle(s.querySelector('.score-loupe')).visibility === 'visible',
          name: s.querySelector('.score-loupe-name').textContent, time: s.querySelector('.score-loupe-time').textContent,
          edges: [...s.querySelectorAll('.score-loupe-foot span')].map((x) => x.textContent).join(' to '), clock: document.querySelector('.np-cur').textContent };
      });
      // A finger at `t` seconds into the strip (and moved to `to`, if given), held there.
      const press = async (t) => {
        const box = await page.locator('.np .score-cv').boundingBox();
        const d = (await audio()).d;
        const at = (s) => [box.x + (box.width * s) / d, box.y + box.height / 2];
        // (WebKit as built for testing, set up as a phone, does not always hand a mouse press on
        // to the page, and rounds where it is: there the finger is pointer events of the page's
        // own making, a touch's. What an iPhone's glass really sends is not something a test sees.)
        if (WEBKIT || process.env.MADE_UP_FINGER) {
          const fire = (type, [x, y]) => page.evaluate(([type, x, y]) => {
            document.querySelector('.np .score-strip').dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, bubbles: true, cancelable: true }));
          }, [type, x, y]);
          let last = at(t);
          await fire('pointerdown', last);
          return { to: async (s) => { last = at(s); await fire('pointermove', last); }, lift: () => fire('pointerup', last) };
        }
        await page.mouse.move(...at(t));
        await page.mouse.down();
        return { to: (s) => page.mouse.move(...at(s), { steps: 4 }), lift: () => page.mouse.up() };
      };
      await page.click('#pb-open');
      await page.waitForSelector('.np');
      await page.click('.np-play');
      await page.waitForFunction(() => document.querySelector('#audio').paused);
      await page.evaluate(() => { document.querySelector('#audio').currentTime = 100; });
      await page.waitForSelector('.np .score[data-shows="voices"]', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(700); // (drawn in)
      let s = await score();
      check(s.shows === 'voices' && s.boxes === '1' && s.ticks === '0', `the transcribed episode is drawn with its voices, its loudness and its sponsor read (${s.shows}, ${s.boxes} box)`);
      check(s.who && s.hue === '0' && s.line === s.who, `the line under it says who is speaking, in the colour of the voice heard most (${s.line}, hue ${s.hue})`);
      check(s.now === '100' && s.max === '300' && s.text === '1:40 of 5:00', `it is a slider to assistive technology (${s.now} of ${s.max}, "${s.text}")`);
      await shot('6c-score');
      // A finger on it: the magnifier opens at that time, and the audio stays until it lifts.
      const finger = await press(200);
      await page.waitForTimeout(250);
      s = await score();
      check(s.open && s.time === '3:20' && s.edges === '1:50 to 4:50' && s.name === s.who && s.clock === '3:20', `a finger on the strip opens the magnifier there (${s.time}, ${s.edges}, "${s.name}")`);
      check(Math.abs((await audio()).t - 100) < 0.5, 'and the audio stays where it was while the finger is down');
      await shot('6d-magnifier');
      await finger.to(230);
      s = await score();
      check(s.time === '3:50' && s.clock === '3:50', `the magnifier follows the finger (${s.time})`);
      await finger.lift();
      await page.waitForTimeout(300);
      s = await score();
      const t = (await audio()).t;
      check(!s.open && t > 229.5 && t < 230.5, `lifting the finger moves the audio there and closes the magnifier (${t.toFixed(1)} s)`);
      // The keys: back and forward by the player's amounts, Home to the start.
      await page.focus('.np .score-strip');
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(200);
      const back = (await audio()).t;
      await page.keyboard.press('Home');
      await page.waitForTimeout(200);
      check(back > 214.5 && back < 215.5 && (await audio()).t < 0.5, `the arrow keys move by the back and forward amounts, Home goes to the start (${back.toFixed(1)} s)`);
      await page.evaluate(() => { document.querySelector('#audio').currentTime = 100; });
      await page.keyboard.press('Escape');
      await page.waitForSelector('.np', { state: 'detached' });
      await noSideScroll('score');

      // Streamed, and transcribed by nobody: the plain strip, with its chapters, and the magnifier
      // says which chapter is under the finger.
      await row('What the tide tables leave out').locator('.ep-play').click();
      await playing(0.3);
      await page.click('#pb-play');
      await page.waitForFunction(() => document.querySelector('#audio').paused);
      await page.click('#pb-open');
      await page.waitForSelector('.np .score[data-ticks="3"]', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(700);
      s = await score();
      check(s.shows === 'none' && s.boxes === '0' && s.ticks === '3' && !s.who, `a streamed episode nobody transcribed shows the plain strip, with its chapters (${s.shows}, ${s.ticks} ticks)`);
      const chapterFinger = await press(160);
      await page.waitForTimeout(250);
      s = await score();
      check(s.open && s.name === 'Storm surges' && s.time === '2:40' && s.line === 'Storm surges', `the magnifier names the chapter under the finger (${s.name}, ${s.time})`);
      await shot('6e-score-chapters');
      // (Back to the start before lifting: this episode is not to look started.)
      await chapterFinger.to(0);
      await chapterFinger.lift();
      await page.keyboard.press('Escape');
      await page.waitForSelector('.np', { state: 'detached' });

      // Saved on the device and transcribed by nobody: its loudness, once listened through.
      await row('Cranes, and the people under them').locator('.ep-more').click();
      await page.click('#row-menu button:has-text("Save for offline")');
      await page.waitForSelector('#latest-list .ep:has-text("Cranes, and the people under them") .tag:has-text("Saved")', { timeout: 30000 });
      await row('Cranes, and the people under them').locator('.ep-play').click();
      // (WebKit as built for testing now and then leaves a stored file loading: the player asks
      // again by itself after three seconds, and the log says when it had to.)
      if (blobPlays) await playing(0.3, 40000); else await playing(0.3).catch(() => console.log('  note: this WebKit build did not play the saved copy'));
      await page.click('#pb-play');
      await page.click('#pb-open');
      await page.waitForSelector('.np .score[data-shows="loudness"]', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(700);
      s = await score();
      check(s.shows === 'loudness' && !s.who, `a saved file nobody transcribed shows its loudness once it has been listened through (${s.shows})`);
      await shot('6f-score-loudness');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.np', { state: 'detached' });

      // Back to the transcribed one, playing, for what follows.
      await row('Why every container').locator('.ep-play').click();
      await playing(1);
    }

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

    /* ---------- the headphones ---------- */
    // iOS can have the playing state the wrong way round, and then sends "play" for a press that
    // should pause, and "pause" for one that should play. A command for what is already so is
    // taken as the other one; a command for what changed a moment ago is left alone.
    {
      const press = (action) => page.evaluate((a) => window.__ms?.[a]?.({ action: a }), action);
      const state = () => page.evaluate(() => ({ paused: document.querySelector('#audio').paused, said: navigator.mediaSession?.playbackState }));
      await page.waitForTimeout(1100);
      await press('play'); // playing, and told to play: the press was to pause
      await page.waitForFunction(() => document.querySelector('#audio').paused, null, { timeout: 5000 }).catch(() => {});
      let st = await state();
      check(st.paused && st.said === 'paused', `"play" from the headphones while playing pauses (${st.paused ? 'paused' : 'still playing'}, iOS told ${st.said})`);
      await press('pause'); // just paused: the same press twice, left alone
      await page.waitForTimeout(400);
      st = await state();
      check(st.paused, 'the same command again straight away is left alone');
      await page.waitForTimeout(1100);
      await press('pause'); // paused, and told to pause: the press was to play
      await playing(1);
      st = await state();
      check(!st.paused && st.said === 'playing', `"pause" from the headphones while paused plays (${st.paused ? 'still paused' : 'playing'}, iOS told ${st.said})`);
      await page.waitForTimeout(1100);
      await press('pause');
      await page.waitForFunction(() => document.querySelector('#audio').paused, null, { timeout: 5000 });
      await page.waitForTimeout(1100);
      await press('play');
      await playing(1);
      check(true, 'and "pause" and "play" do as they say when the state is right');
      // With the app in the background (the screen locked), a pause from the lock screen keeps the
      // sound on with a silent element (iOS otherwise switches it off after half a minute, and Play
      // then runs the clock with nothing heard); Play lets it go and the episode carries on.
      await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }));
      await page.waitForTimeout(1100);
      await press('pause');
      await page.waitForFunction(() => document.querySelector('#audio').paused, null, { timeout: 5000 });
      const at = (await audio()).t;
      const silent = () => page.evaluate(() => [...window.__media].filter((e) => e.id !== 'audio' && !e.paused && e.loop).length);
      await page.waitForTimeout(300);
      const kept = await silent();
      if (mobile) check(kept === 1, `paused from the lock screen with the app in the background, the sound is kept on by a silent element (${kept} playing)`);
      await page.waitForTimeout(900);
      await press('play');
      await playing(Math.max(0.5, at - 1));
      const again = await audio();
      const after = await silent();
      check(!again.paused && again.t >= at - 1 && again.t < at + 6 && after === 0, `played again from there, the episode carries on where it was and the silent element lets go (${at.toFixed(1)} s to ${again.t.toFixed(1)} s, ${after} silent playing)`);
      await page.evaluate(() => { delete document.visibilityState; });
    }
    await page.click('#pb-play');

    /* ---------- a saved copy from the podcast's host, once the server has transcribed it ---------- */
    // Its ads are not the server's: online, the server's copy plays (ads skipped, the transcript in
    // step), and the saved copy is swapped for the server's in the background.
    {
      await row('Why every container').locator('.ep-more').click();
      await page.click('#row-menu button:has-text("Save for offline")');
      await page.waitForSelector('#latest-list .ep:has-text("Why every container") .tag:has-text("Saved")', { timeout: 30000 });
      await page.evaluate((id) => { const x = JSON.parse(localStorage.getItem('pod-downloads')); x[id].from = 'origin'; localStorage.setItem('pod-downloads', JSON.stringify(x)); }, world.transcribed);
      await page.reload();
      await page.waitForSelector('#playbar:not(.hidden)');
      await page.waitForFunction((id) => JSON.parse(localStorage.getItem('pod-downloads') || '{}')[id]?.from === 'server', world.transcribed, { timeout: 30000 }).catch(() => {});
      const swapped = await page.evaluate((id) => JSON.parse(localStorage.getItem('pod-downloads') || '{}')[id]?.from, world.transcribed);
      check(swapped === 'server', `a copy saved from the podcast's host is swapped for the server's once the server has it (${swapped})`);
      await page.evaluate((id) => { const x = JSON.parse(localStorage.getItem('pod-downloads')); if (x[id]) x[id].from = 'origin'; localStorage.setItem('pod-downloads', JSON.stringify(x)); }, world.transcribed);
      await page.reload();
      await page.waitForSelector('#playbar:not(.hidden)');
      await page.click('#pb-play');
      await playing(1);
      const src = (await audio()).src;
      const from = await page.evaluate((id) => JSON.parse(localStorage.getItem('pod-downloads') || '{}')[id]?.from, world.transcribed);
      // (Either the server's stream, or the saved copy once it has been swapped already: both are the server's.)
      check(src.endsWith(`/library/${world.transcribed}.mp3`) || (src.startsWith('blob:') && from === 'server'), `played meanwhile, it is the server's copy that plays (${src.startsWith('blob:') ? `the saved copy, from ${from}` : src.split('/').slice(-2).join('/')})`);
      await page.click('#pb-play');
      await page.waitForFunction(() => document.querySelector('#audio').paused);
      // (Not saved any more, for what follows.)
      await row('Why every container').locator('.ep-more').click();
      await page.click('#row-menu button:has-text("Remove the saved copy")');
      await page.waitForFunction(() => !document.querySelector('#latest-list .ep:first-child .tag:not(.hot)')?.textContent.includes('Saved'), null, { timeout: 5000 }).catch(() => {});
      // ...and the player on the server's stream again, where it was.
      const t0 = (await audio()).t;
      await page.click('#pb-play');
      await playing(Math.max(0.5, t0 - 1));
      await page.click('#pb-play');
      await page.waitForFunction(() => document.querySelector('#audio').paused);
    }

    /* ---------- searching every transcript ---------- */
    // (The world's one transcript says "It took ten years of committees to agree on twenty feet
    // and forty feet" at 2:20, "a steel box" at 0:12 and "the quay" in the sentence after.)
    // The way in at the top of Listen is there from the start on a device that holds the
    // library's key, so nothing below it moves when the server answers (made slow here).
    {
      await page.click(mobile ? '#tabbar [data-nav=listen]' : '#nav [data-nav=listen]');
      await page.route('**/api/pod/status', async (r) => { await new Promise((ok) => setTimeout(ok, 1500)); await r.continue().catch(() => {}); });
      await page.reload();
      await page.waitForSelector('#home-shows');
      const where = () => page.evaluate(() => ({ y: Math.round(document.querySelector('#home-shows').getBoundingClientRect().top + scrollY), field: !document.querySelector('#home-search').classList.contains('hidden'), status: document.querySelector('#top-status').textContent }));
      const first = await where();
      await page.waitForFunction(() => /In step|Linked/.test(document.querySelector('#top-status').textContent), null, { timeout: 15000 });
      await page.waitForTimeout(600);
      const then = await where();
      check(first.field && then.field && first.y === then.y && !/In step|Linked/.test(first.status), `the search field is in place before the server answers, and the shows below it do not move (${first.y} px, then ${then.y} px)`);
      await page.unroute('**/api/pod/status');
    }
    await page.click(mobile ? '#tabbar [data-nav=listen]' : '#nav [data-nav=listen]');
    await page.waitForSelector('#home-search:not(.hidden) .search-entry');
    if (mobile) await page.click('#home-search .search-entry');
    else { await page.locator('body').click({ position: { x: 5, y: 300 } }); await page.keyboard.press('/'); }
    await page.waitForSelector('#pod-search:not(.hidden) input[type=search]');
    check(await page.evaluate(() => document.activeElement === document.querySelector('#pod-search input') && location.hash === '#/search'), `${mobile ? 'tapping the field at the top of Listen' : 'pressing /'} opens the search, ready to type`);
    check(/Type a word or two/.test(await page.locator('#search-note').textContent()), 'before anything is typed it says what it does');
    await page.keyboard.type('Committees "twenty feet"');
    await page.waitForSelector('#search-results .hit');
    const found = await page.evaluate(() => ({
      eps: [...document.querySelectorAll('#search-results .hit-ep-title')].map((x) => x.textContent),
      time: document.querySelector('#search-results .hit-time').textContent,
      bold: [...document.querySelectorAll('#search-results .hit-text b')].map((x) => x.textContent),
    }));
    check(found.eps.join() === 'Why every container is the same size' && found.time === '2:20' && found.bold.join() === 'committees,twenty feet', `words and a phrase find the sentence, its words set off (${JSON.stringify(found)})`);
    {
      // Beside the time, a line the width of the time's column is the episode, and a tick on it is the hit.
      const mark = await page.evaluate(async () => {
        const got = await (await fetch('api/pod/search?q=committees', { headers: { authorization: `Bearer ${localStorage.getItem('pod-key')}` } })).json();
        const line = document.querySelector('#search-results .hit .hit-where');
        const tick = line?.querySelector('i');
        if (!tick) return null;
        const a = line.getBoundingClientRect();
        const t = tick.getBoundingClientRect();
        const col = line.closest('.hit-time').getBoundingClientRect();
        return { at: (t.left + t.width / 2 - a.left) / a.width, want: got.episodes[0].hits[0].start / got.episodes[0].duration, inCol: a.left >= col.left - 0.5 && a.right <= col.right + 0.5 };
      });
      check(!!mark && Math.abs(mark.at - mark.want) < 0.02 && mark.inCol, `each hit has a mark where in the episode it is, inside the time's column (${mark && `${(mark.at * 100).toFixed(1)}% along, the hit is ${(mark.want * 100).toFixed(1)}% in`})`);
    }
    await page.waitForTimeout(300);
    await shot('5b-search');
    await noSideScroll('search');
    await page.fill('#pod-search input', 'steel quay');
    await page.waitForFunction(() => document.querySelector('#search-results .hit-time')?.textContent === '0:12');
    check((await page.locator('#search-results .hit-text b').allTextContents()).join() === 'steel,quay', 'two neighbouring sentences that together hold the words are one hit');
    await page.fill('#pod-search input', 'submarine');
    await page.waitForFunction(() => /No transcript has "submarine"/.test(document.querySelector('#search-note').textContent) && !document.querySelector('#search-results .hit'));
    check(true, 'nothing found says so');
    await page.fill('#pod-search input', 'committees');
    await page.waitForFunction(() => document.querySelector('#search-results .hit-time')?.textContent === '2:20');
    await page.click('#search-results .hit-main');
    await playing(138.5);
    a = await audio();
    check(a.src.endsWith(`/library/${world.transcribed}.mp3`) && a.t >= 138 && a.t < 143 && (await page.locator('#pb-title').textContent()) === 'Why every container is the same size', `tapping a hit plays the server's copy from just before the sentence (${a.t.toFixed(1)} s)`);
    check(await page.locator('#search-results .hit.now').count() === 1, 'and the line played from is marked');
    await page.click('#pb-play');
    await page.waitForFunction(() => document.querySelector('#audio').paused);
    await page.click('#search-results .hit-read');
    await page.waitForSelector('#transcript .seg.sought');
    check(await page.evaluate(() => document.body.classList.contains('view-transcribe') && /ten years of committees/.test(document.querySelector('#transcript .seg.sought').textContent)), 'the other button opens the transcript at that sentence');
    await page.click(mobile ? '#tabbar [data-nav=listen]' : '#nav [data-nav=listen]');
    await page.waitForSelector('#pod-home:not(.hidden) #latest-list .ep');

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
    {
      // What is saved on the device is Up next's other tab.
      const qTabs = () => page.evaluate(() => [...document.querySelectorAll('#queue-tabs label')].map((l) => `${l.querySelector('span').firstChild.textContent} ${l.querySelector('.seg-count')?.textContent || ''}`.trim()).join(' | '));
      check((await qTabs()) === 'Up next 2 | Saved 1', `Up next has two tabs, each with how many it holds (${await qTabs()})`);
      await page.click('#queue-tabs label:has-text("Saved")');
      await page.waitForSelector('#pod-queue .ep:has-text("Cranes, and the people under them")');
      check((await page.evaluate(() => [location.hash, [...document.querySelectorAll('#pod-queue h2')].map((x) => x.textContent).join()].join(' '))) === '#/queue/saved Saved for offline', 'the Saved tab lists what is saved on this device, in its place, the tab in the address');
      await page.click('#queue-tabs label:has-text("Up next")');
      await page.waitForSelector('#pod-queue ol .ep');
      // The same queue, from the now-playing sheet.
      await page.click('#pb-open');
      await page.waitForSelector('.np');
      const upNext = (await tools()).next;
      await page.click('.np-tool-next');
      const listed = await page.locator('.np-next .np-next-title').allTextContents();
      check(upNext === '2' && listed.join(' | ') === 'Kanonen i Oslofjorden | A bakery in 1911', `the player's Up next button says how many are queued and opens them (${upNext}: ${listed.join(' | ')})`);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.np', { state: 'detached' });
    }
    // The episode ends: the next one starts by itself.
    await page.evaluate(() => { const x = document.querySelector('#audio'); x.currentTime = x.duration - 1.5; x.play().catch(() => {}); });
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
      await page.waitForSelector('.ep-sheet .notes li', { state: 'attached' });
      check((await chapterRows()).join(' | ') === '0:00 Low water | 1:15 Reading a tide table | 2:30 Storm surges | 3:45 What the harbour master knows', `an episode's chapters file is listed in its sheet, without what is kept out of the list (${(await chapterRows()).join(' | ')})`);
      check(await page.evaluate(() => { const c = document.querySelector('.ep-sheet .chapters-box'); return c.compareDocumentPosition(document.querySelector('.ep-sheet .notes-box')) === Node.DOCUMENT_POSITION_FOLLOWING; }), 'the chapters come before the notes');
      const epTabs = () => page.evaluate(() => ({ tabs: [...document.querySelectorAll('.ep-sheet .sheet-tabs:not(.hidden) label')].map((l) => l.textContent).join(' | '), chapters: !document.querySelector('.ep-sheet .chapters-box').classList.contains('hidden'), notes: !document.querySelector('.ep-sheet .notes-box').classList.contains('hidden'), under: document.querySelector('.ep-sheet .sheet-actions').compareDocumentPosition(document.querySelector('.ep-sheet .sheet-tabs')) === Node.DOCUMENT_POSITION_FOLLOWING }));
      let tabs = await epTabs();
      check(tabs.tabs === 'Chapters 4 | Notes' && tabs.chapters && !tabs.notes && tabs.under, `with chapters and notes, they are two tabs under the actions, the chapters open (${JSON.stringify(tabs)})`);
      await page.waitForTimeout(400);
      await shot('8b-chapters');
      await noSideScroll('chapters');
      await page.click('.ep-sheet .sheet-tabs label:has-text("Notes")');
      await page.waitForSelector('.ep-sheet .notes li');
      tabs = await epTabs();
      check(!tabs.chapters && tabs.notes, `the Notes tab puts the notes in the chapters' place (${JSON.stringify(tabs)})`);
      await shot('8d-notes-tab');
      await page.click('.ep-sheet .sheet-tabs label:has-text("Chapters")');
      await page.click('.ep-sheet .chapter:has-text("Storm surges")');
      await playing(150);
      a = await audio();
      check(a.t >= 150 && a.t < 160 && (await page.locator('#pb-title').textContent()) === 'What the tide tables leave out', `tapping a chapter plays the episode from its start (${a.t.toFixed(1)} s)`);
      await page.waitForFunction(() => document.querySelector('.ep-sheet .chapter[aria-current="true"]')?.textContent.includes('Storm surges'), null, { timeout: 5000 }).catch(() => {});
      check((await chapterRows()).filter((r) => r.endsWith('*')).join() === '2:30 Storm surges *', `and the chapter being played is marked (${(await chapterRows()).join(' | ')})`);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.ep-sheet', { state: 'detached' });
      const bar = await page.evaluate(() => ({ ticks: document.querySelector('#playbar .score').dataset.ticks, bands: document.querySelector('#playbar .score').dataset.breaks }));
      check(bar.ticks === '3' && bar.bands === '0', `the chapters are ticks on the position control, not sponsor boxes (${bar.ticks} ticks, ${bar.bands} boxes)`);

      // The player opened up: the chapter under the title, and the one before and after.
      await page.click('#pb-open');
      await page.waitForSelector('.np .np-chapter:not(.hidden)');
      await page.click('.np-play');
      await page.waitForFunction(() => document.querySelector('#audio').paused);
      const np = () => page.evaluate(() => ({ title: document.querySelector('.np-chapter-title').textContent, count: document.querySelector('.np-chapter-count').textContent, t: document.querySelector('#audio').currentTime, ticks: Number(document.querySelector('.np .score').dataset.ticks) }));
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
      check((await page.locator('#playbar .score').getAttribute('data-ticks')) === '2', 'with their ticks on the position control');
      await page.click('#pb-play');
      await page.waitForFunction(() => document.querySelector('#audio').paused);

      // An episode without chapters looks as it did.
      await row('The pilot who boards at night').locator('.ep-main').click();
      await page.waitForSelector('.ep-sheet .notes li');
      await page.waitForTimeout(300);
      check(!(await page.locator('.ep-sheet .chapters-box').isVisible()) && (await page.locator('.ep-sheet .chapter').count()) === 0 && !(await page.locator('.ep-sheet .sheet-tabs').isVisible()), 'an episode with two times in its notes has no chapters, and its notes no tabs');
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
    // (WebKit as built for testing now and then leaves a stored file loading and never starts
    // it: play is then asked for once more, as a listener would, and the log says so.)
    if (!(await playing(0.3).then(() => true, () => false))) {
      console.log('  note: the saved copy did not start by itself; paused and asked to play once more');
      await row('A bakery in 1911').locator('.ep-play').click();
      await page.waitForTimeout(500);
      await row('A bakery in 1911').locator('.ep-play').click();
      if (blobPlays) await playing(0.3); else await playing(0.3).catch(() => console.log('  note: this WebKit build did not play the saved copy'));
    }
    a = await audio();
    check(a.src.startsWith('blob:'), `${WEBKIT ? 'the saved copy is the one played' : 'offline, the saved copy plays'}`);
    // Nobody listed where this copy goes quiet: the device listens through it itself.
    await page.click('#pb-open');
    await page.waitForSelector('.np');
    await page.click('.np-tool-trim');
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
    await page.click('.np-tool-trim');
    await page.waitForSelector('.np-trim-save:not(.hidden)');
    check(/saved on this device/.test(await page.locator('.np-trim-note').textContent()), `a streamed episode says what finding its pauses takes (${await page.locator('.np-trim-note').textContent()})`);
    await page.click('.np-trim-save');
    // (The saved copy is in the player before it has been moved to where the other one was.)
    await page.waitForFunction(() => { const x = document.querySelector('#audio'); return x.currentSrc.startsWith('blob:') && !x.paused && x.currentTime >= 130 && /longer than 0\.8 s/.test(document.querySelector('.np-trim-note').textContent); }, null, { timeout: 30000 }).catch(() => {});
    a = await audio();
    check(a.src.startsWith('blob:') && (!blobPlays || (a.t >= 130 && a.t < 160 && !a.paused)) && /^6 pauses/.test(await page.locator('.np-trim-note').textContent()), `saved from the player, it plays on from the saved copy, its pauses found (${a.t.toFixed(0)} s, ${await page.locator('.np-trim-note').textContent()})`);
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
    await page.waitForSelector('#settings-tabs');
    {
      // Settings is a tab at a time, the tab in the address.
      const tabState = () => page.evaluate(() => ({ hash: location.hash, on: document.querySelector('#settings-tabs input:checked')?.value, cards: [...document.querySelectorAll('#pod-settings h2')].map((x) => x.textContent).join(', ') }));
      let st = await tabState();
      check(st.on === 'playback' && st.cards === 'Playback', `Settings opens on its first tab, Playback, alone (${JSON.stringify(st)})`);
      await page.click('#settings-tabs label:has-text("Storage")');
      await page.waitForFunction(() => location.hash === '#/settings/storage');
      st = await tabState();
      check(st.on === 'storage' && st.cards === 'Saved for offline', `a tab is in the address, and shows that tab alone (${JSON.stringify(st)})`);
      await page.evaluate(() => { location.hash = '#/settings/library'; });
      await page.waitForSelector('.qr svg path');
      st = await tabState();
      check(st.on === 'library' && /^Your library, Move your shows/.test(st.cards), `and the address opens the tab it names (${JSON.stringify(st)})`);
    }
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

    /* ---------- told about a new episode ---------- */
    // The browser's push manager is stood in for: subscribing gives keys made here and the
    // world's push service, which keeps what the server sends it.
    {
      const phone = { ...makeKeys(), auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url') };
      await A.ctx.addInitScript(({ endpoint, p256dh, auth }) => {
        const kept = () => { try { return JSON.parse(sessionStorage.getItem('fake-push') || 'null'); } catch { return null; } };
        const sub = () => kept() && { endpoint, expirationTime: null, options: { userVisibleOnly: true, applicationServerKey: new Uint8Array(kept()).buffer }, toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh, auth } }), unsubscribe: async () => { sessionStorage.removeItem('fake-push'); return true; } };
        const pushManager = { getSubscription: async () => sub(), subscribe: async (o) => { sessionStorage.setItem('fake-push', JSON.stringify([...new Uint8Array(o.applicationServerKey)])); return sub(); } };
        // (WebKit as built for testing has neither of these at all: stood in for too, so the
        // page's own part is gone through in that engine as well.)
        if (!('Notification' in window)) window.Notification = function Notification() {};
        if (!('PushManager' in window)) window.PushManager = function PushManager() {};
        Object.defineProperty(Notification, 'permission', { configurable: true, get: () => sessionStorage.getItem('fake-permission') || 'default' });
        Notification.requestPermission = async () => { sessionStorage.setItem('fake-permission', 'granted'); return 'granted'; };
        navigator.serviceWorker.getRegistration = async () => ({ scope: `${location.origin}/`, pushManager });
      }, { endpoint: world.pushUrl('phone'), p256dh: phone.publicKey, auth: phone.auth });
      await page.click(mobile ? '#tabbar [data-nav=settings]' : '#nav [data-nav=settings]');
      await page.reload();
      await page.click('#settings-tabs label:has-text("Notifications")');
      await page.waitForSelector('#settings-notify input:not([disabled])', { timeout: 15000 });
      check(!(await page.locator('#settings-notify input').isChecked()), 'notifications start off');
      await page.click('#settings-notify .switch');
      await page.waitForSelector('#settings-notify .actions:not(.hidden)', { timeout: 10000 });
      const key = await page.evaluate(() => localStorage.getItem('pod-key'));
      const known = await (await fetch(`${world.base}/api/pod/push?endpoint=${encodeURIComponent(world.pushUrl('phone'))}`, { headers: { authorization: `Bearer ${key}` } })).json();
      check(known.known === true, 'switched on, the device is signed up with the server');
      await page.waitForTimeout(2700); // (the toast gone)
      await page.locator('#settings-notify').scrollIntoViewIfNeeded();
      await shot('12-notify');
      await noSideScroll('notifications');
      const told = async (n) => {
        for (let i = 0; i < 100 && world.state.pushes.length < n; i++) await new Promise((r) => setTimeout(r, 150));
        return world.state.pushes.map((m) => ({ ...m, json: JSON.parse(decrypt(m.body, phone)) }));
      };
      await page.click('#settings-notify button:has-text("Send a test notification")');
      let got = await told(1);
      check(got.length === 1 && got[0].json.tag === 'test', `a test notification reaches the push service (${got.map((m) => m.json.body).join(' | ')})`);
      world.publish('harbour', 'Night shift at the grain terminal', 2400, Date.now());
      await page.click(mobile ? '#tabbar [data-nav=listen]' : '#nav [data-nav=listen]');
      await page.click('#latest-refresh');
      await page.waitForSelector('#latest-list .ep:first-child:has-text("Night shift at the grain terminal")', { timeout: 15000 });
      got = await told(2);
      const m = got[1];
      check(got.length === 2 && m.headers['content-encoding'] === 'aes128gcm' && /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/.test(m.headers.authorization) && Number(m.headers.ttl) > 0, `the new episode is sent to the device's push service, encrypted and signed (${got.length} messages)`);
      check(m?.json.title === 'Harbour Hours' && m.json.body === 'Night shift at the grain terminal' && m.json.url === `#/show/${subId(world.feedUrl('harbour'))}` && m.json.tag === m.json.episode, `and it says which show and episode, and where to open (${JSON.stringify(m?.json)})`);
      await page.waitForTimeout(1500);
      check(world.state.pushes.length === 2, 'one message for the episode, none for the one dated before the show was followed');
    }

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
    // Scrolled away by the reader, the page stops following; a button says which way the playing
    // sentence is, and takes them back to it.
    const away = async (to) => {
      await page.mouse.move(200, 400);
      await page.mouse.wheel(0, to === 'top' ? -20000 : 20000);
      await page.waitForTimeout(700);
    };
    for (const to of ['top', 'bottom']) {
      await away(to);
      const off = await page.evaluate(() => { const r = document.querySelector('#transcript .seg.playing').getBoundingClientRect(); return r.bottom < 70 || r.top > innerHeight - 150; });
      if (!off) continue; // (on a tall screen the sentence can still be in view from this end)
      await page.waitForSelector('#jump-now:not(.hidden)', { timeout: 3000 }).catch(() => {});
      const pill = await page.evaluate(() => ({ shown: !document.querySelector('#jump-now').classList.contains('hidden'), icon: document.querySelector('#jump-now use').getAttribute('href') }));
      check(pill.shown && pill.icon === (to === 'top' ? '#i-down' : '#i-up'), `scrolled to the ${to}, a button goes back to where it is playing, pointing ${to === 'top' ? 'down' : 'up'} (${pill.shown ? pill.icon : 'not shown'})`);
      await page.click('#jump-now');
      await page.waitForTimeout(900);
      const back = await page.evaluate(() => { const r = document.querySelector('#transcript .seg.playing').getBoundingClientRect(); return { inView: r.top > 0 && r.bottom < innerHeight, hidden: document.querySelector('#jump-now').classList.contains('hidden') }; });
      check(back.inView && back.hidden, 'tapping it brings the sentence being played back into view, and the button goes');
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot('11-transcript');
    await noSideScroll('transcript with the player');
    await page.click('#play');
    await page.waitForFunction(() => document.querySelector('#audio').paused);
    check(true, "the transcript's own play button is the player's");
    // From the player, the transcript opens where the episode is.
    await page.evaluate(() => { document.querySelector('#audio').currentTime = 230; });
    await page.waitForTimeout(400);
    await page.click(mobile ? '#tabbar [data-nav=listen]' : '#nav [data-nav=listen]');
    await page.click('#pb-open');
    await page.waitForSelector('.np');
    await page.click('.np-transcript');
    await page.waitForSelector('body.view-transcribe');
    await page.waitForTimeout(900);
    const opened = await page.evaluate(() => { const p = document.querySelector('#transcript .seg.playing'); const r = p?.getBoundingClientRect(); return { start: Number(p?.dataset.start), inView: !!r && r.top > 0 && r.bottom < innerHeight }; });
    check(opened.inView && opened.start <= 230 && opened.start > 200, `opened from the player, the transcript is at where the episode is (the sentence from ${opened.start} s, in view)`);

    /* ---------- how things move, and what a thumb can reach ---------- */
    {
      await page.click(mobile ? '#tabbar [data-nav=listen]' : '#nav [data-nav=listen]');
      await page.waitForSelector('#pod-home:not(.hidden) #latest-list .ep');
      // An episode's played part draws in along its length when its list first shows, once.
      const drawn = await page.evaluate(() => [...document.querySelectorAll('#pod-home .draw-in')].map((x) => getComputedStyle(x).animationName));
      await page.waitForTimeout(700);
      const after = await page.evaluate(() => document.querySelectorAll('#pod-home .draw-in').length);
      check(drawn.length > 0 && drawn.every((n) => n === 'draw-in') && after === 0, `the played part of each started episode draws in once as Listen shows (${drawn.length} drawn, ${after} still drawing after 0.7 s)`);

      // Screens move as an iPhone's do: deeper pushes in from the right (a view transition with
      // the push class on the root), back pops (the back link is the step back in history, and
      // the screen comes back scrolled where it was), another section cross-fades.
      const vts = () => page.evaluate(() => window.__vt.splice(0));
      await page.evaluate(() => {
        window.__vt = [];
        const start = document.startViewTransition?.bind(document);
        if (!start) return;
        document.startViewTransition = (cb) => {
          const seen = { kind: (document.documentElement.className.match(/\bvt-(\w+)/) || [])[1] || '', ran: false };
          window.__vt.push(seen);
          const t = start(cb);
          t.ready.then(() => { seen.ran = !!document.getAnimations().some((a) => /^::view-transition/.test(a.effect?.pseudoElement || '')); }, () => { seen.skipped = true; });
          return t;
        };
      });
      const hasVT = await page.evaluate(() => !!document.startViewTransition);
      await page.evaluate(() => window.scrollTo(0, 90));
      await page.waitForTimeout(100);
      await page.click('#show-grid .show-tile >> nth=0');
      await page.waitForSelector('#pod-show:not(.hidden) #show-list .ep');
      await page.waitForTimeout(600);
      let vt = await vts();
      check(!hasVT || (vt.length === 1 && vt[0].kind === 'push' && vt[0].ran && !vt[0].skipped), `a show's page is pushed in, in a view transition (${JSON.stringify(vt)})`);
      check(await page.evaluate(() => !document.documentElement.className.includes('vt-') && !document.querySelector('[style*="view-transition-name"]')), 'and nothing of it is left on the page after');
      await page.click('#pod-show .back-link');
      await page.waitForSelector('#pod-home:not(.hidden)');
      await page.waitForTimeout(600);
      vt = await vts();
      const popped = await page.evaluate(() => ({ hash: location.hash, y: Math.round(window.scrollY) }));
      check(!hasVT || (vt.length === 1 && vt[0].kind === 'pop' && vt[0].ran), `the back link pops it, in a view transition (${JSON.stringify(vt)})`);
      check(popped.hash === '#/' && popped.y === 90, `and Listen comes back where it was scrolled to, the step back in history taken (${JSON.stringify(popped)})`);
      await page.click(mobile ? '#tabbar [data-nav=queue]' : '#nav [data-nav=queue]');
      await page.waitForSelector('#pod-queue:not(.hidden)');
      await page.waitForTimeout(300);
      vt = await vts();
      check(!hasVT || (vt.length === 1 && vt[0].kind === 'tab'), `another section cross-fades (${JSON.stringify(vt)})`);
      await page.click(mobile ? '#tabbar [data-nav=listen]' : '#nav [data-nav=listen]');
      await page.waitForSelector('#pod-home:not(.hidden) #latest-list .ep');
      await page.waitForTimeout(300);
      await vts();

      // A sheet comes from its edge and goes back to it, one motion; then it is gone, and the
      // focus is back on what opened it.
      const opener = row('The pilot who boards at night').locator('.ep-main');
      const watch = () => page.evaluate(() => new Promise((done) => {
        const p = document.querySelector('#sheet');
        const seen = [];
        const t0 = performance.now();
        const look = () => {
          const m = new DOMMatrix(getComputedStyle(p).transform);
          seen.push({ x: m.m41, y: m.m42, hidden: p.classList.contains('hidden') });
          if (performance.now() - t0 < 600) requestAnimationFrame(look); else done(seen);
        };
        look();
      }));
      await opener.focus();
      await page.keyboard.press('Enter');
      await page.waitForSelector('.ep-sheet');
      await page.waitForTimeout(450);
      await page.evaluate(() => document.querySelector('.ep-sheet .sheet-top .icon-btn').focus());
      const [frames] = await Promise.all([watch(), page.keyboard.press('Enter')]);
      const moving = frames.filter((f) => !f.hidden && (mobile ? f.y : f.x) > 1);
      const gone = await page.evaluate(() => ({ hidden: document.querySelector('#sheet').classList.contains('hidden') && document.querySelector('#sheet-back').classList.contains('hidden'), empty: !document.querySelector('#sheet').firstChild, closing: !!document.querySelector('.closing'), focus: document.activeElement?.closest('.ep')?.querySelector('.ep-title')?.textContent }));
      check(moving.length >= (WEBKIT ? 1 : 2) && frames.at(-1).hidden && gone.hidden && gone.empty && !gone.closing, `a closed sheet goes back to the ${mobile ? 'bottom' : 'right'} edge and is then gone (${moving.length} frames on the way)`);
      check(gone.focus === 'The pilot who boards at night', `and the focus is back on what opened it (${gone.focus})`);
      // Closed with the browser's back (or a home-screen app's back gesture, which draws no way
      // back of its own), it is closed at once and goes down; where the browser has drawn the
      // way back itself (iOS Safari's edge swipe), it is gone at once.
      await opener.click();
      await page.waitForSelector('.ep-sheet');
      await page.waitForTimeout(450);
      await page.goBack();
      await page.waitForTimeout(30);
      const leaving = await page.evaluate(() => ({ closing: document.querySelector('#sheet').classList.contains('closing'), hidden: document.querySelector('#sheet').classList.contains('hidden'), hash: location.hash }));
      await page.waitForSelector('#sheet.hidden', { state: 'attached', timeout: 2000 }).catch(() => {});
      check(leaving.closing && !leaving.hidden && leaving.hash === '#/' && await page.evaluate(() => document.querySelector('#sheet').classList.contains('hidden')), `the browser's back closes it, and it goes back to its edge (${JSON.stringify(leaving)})`);
      await opener.click();
      await page.waitForSelector('.ep-sheet');
      await page.waitForTimeout(450);
      await page.evaluate(() => {
        history.replaceState({ ...history.state, sheet: false }, '');
        dispatchEvent(new PopStateEvent('popstate', { state: history.state, hasUAVisualTransition: true }));
      });
      check(await page.evaluate(() => document.querySelector('#sheet').classList.contains('hidden') && !document.body.classList.contains('receded')), 'where the browser drew the way back itself, it is gone at once');
      if (mobile) {
        // Pulled down from its top and let go, it carries on down from where the finger left it.
        await opener.click();
        await page.waitForSelector('.ep-sheet');
        await page.waitForTimeout(450);
        // The page behind gives way while the sheet is open (smaller), and comes back after.
        const behind = await page.evaluate(() => [...document.querySelectorAll('.shell, .topbar, .tabbar')].map((el) => +new DOMMatrix(getComputedStyle(el).transform).a.toFixed(3)));
        check(behind.every((k) => k === 0.94), `behind an open sheet the page is smaller, all of it the same (${behind.join(', ')})`);
        const pulled = await page.evaluate(() => new Promise((done) => {
          const p = document.querySelector('#sheet');
          // (A touch can't be made up in every browser: where it can't, this is not gone through.)
          try { new Touch({ identifier: 1, target: p, clientX: 0, clientY: 0 }); } catch { done(null); return; }
          const at = (y) => [new Touch({ identifier: 1, target: p, clientX: 200, clientY: y })];
          p.dispatchEvent(new TouchEvent('touchstart', { touches: at(40), targetTouches: at(40), changedTouches: at(40), bubbles: true, cancelable: true }));
          p.dispatchEvent(new TouchEvent('touchmove', { touches: at(240), targetTouches: at(240), changedTouches: at(240), bubbles: true, cancelable: true }));
          const held = new DOMMatrix(getComputedStyle(p).transform).m42;
          const scale = new DOMMatrix(getComputedStyle(document.querySelector('.shell')).transform).a;
          p.dispatchEvent(new TouchEvent('touchend', { touches: [], targetTouches: [], changedTouches: at(240), bubbles: true, cancelable: true }));
          const seen = [];
          const look = () => {
            seen.push(p.classList.contains('hidden') ? 'gone' : new DOMMatrix(getComputedStyle(p).transform).m42);
            if (seen.length < 60 && seen.at(-1) !== 'gone') requestAnimationFrame(look); else done({ held, seen, scale });
          };
          requestAnimationFrame(look);
        }));
        if (!pulled) {
          console.log('  note: this browser cannot make up a touch, so pulling the sheet down is not gone through here');
          await page.keyboard.press('Escape');
          await page.waitForSelector('.ep-sheet', { state: 'detached' });
        } else {
          const ys = pulled.seen.filter((y) => y !== 'gone');
          check(pulled.held === 200 && ys.length > 0 && ys.every((y) => y >= 199) && pulled.seen.at(-1) === 'gone', `pulled down and let go, the sheet goes on down from there (held at ${pulled.held} px, then ${ys.slice(0, 4).map(Math.round).join(', ')} ...)`);
          check(pulled.scale > 0.94 && pulled.scale < 1, `and the page behind comes forward with the finger (${pulled.scale.toFixed(3)} with the sheet a quarter down)`);
        }
        await page.waitForFunction(() => location.hash === '#/');
        await page.waitForTimeout(300);
        const after = await page.evaluate(() => ({ t: [...document.querySelectorAll('.shell, .topbar, .tabbar')].map((el) => getComputedStyle(el).transform), cls: document.body.className }));
        check(after.t.every((t) => t === 'none') && !/reced/.test(after.cls), `once it is closed, the page is back as it was (${after.t.join(', ')})`);

        // The player bar grows into the player: the sheet starts at the bar, its cover on the
        // bar's cover; and closed, it goes back into the bar, the cover onto the bar's.
        const grow = (act) => page.evaluate((act) => new Promise((done) => {
          const r = (el) => { const b = el?.getBoundingClientRect(); return b ? [Math.round(b.left), Math.round(b.top), Math.round(b.width)] : null; };
          const bar = r(document.querySelector('#pb-art'));
          const seen = [];
          const look = () => {
            const p = document.querySelector('#sheet');
            if (!p.classList.contains('hidden')) seen.push({ art: r(p.querySelector('.np-art')), top: Math.round(p.getBoundingClientRect().top) });
            if (seen.length < 40 && !(act === 'close' && p.classList.contains('hidden'))) requestAnimationFrame(look); else done({ bar, seen });
          };
          if (act === 'open') document.querySelector('#pb-open').click(); else document.querySelector('.np .sheet-top .icon-btn').click();
          requestAnimationFrame(look);
        }), act);
        const near = (a, b) => !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) <= 3);
        const barTop = await page.evaluate(() => Math.round(document.querySelector('#playbar').getBoundingClientRect().top));
        const up = await grow('open');
        check(near(up.seen[0]?.art, up.bar) && Math.abs(up.seen[0].top - barTop) <= 3 && up.seen.at(-1).art[2] > up.bar[2] * 2, `tapped, the player bar grows into the player: the sheet from the bar's top, its cover from the bar's (${JSON.stringify(up.seen[0])}, the bar's cover ${up.bar}) to ${up.seen.at(-1).art[2]} px`);
        await page.waitForTimeout(300);
        const down = await grow('close');
        const last = down.seen.filter((x) => x.art).at(-1);
        const bar = await page.evaluate(() => { const b = document.querySelector('#pb-art').getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width)]; });
        check(near(last?.art, bar), `closed, it shrinks back into the bar, the cover onto the bar's (${JSON.stringify(last)}, the bar's ${bar})`);
        await page.waitForFunction(() => location.hash === '#/');
      }
      // With motion turned down on the device, a sheet comes and goes without moving, the page
      // behind stays as it is, and screens change at once, with no transition.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await opener.click();
      await page.waitForSelector('.ep-sheet');
      const still = await page.evaluate(() => ({ sheet: getComputedStyle(document.querySelector('#sheet')).transform, page: getComputedStyle(document.querySelector('.shell')).transform }));
      check(still.sheet === 'none' && still.page === 'none', `with reduced motion a sheet is in place at once, the page behind it as it was (${JSON.stringify(still)})`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(40);
      check(await page.evaluate(() => document.querySelector('#sheet').classList.contains('hidden')), 'with reduced motion a sheet goes at once');
      await page.waitForFunction(() => location.hash === '#/');
      await page.click('#show-grid .show-tile >> nth=0');
      await page.waitForSelector('#pod-show:not(.hidden)', { timeout: 2000 });
      const instant = await page.evaluate(() => getComputedStyle(document.querySelector('#pod-show')).display !== 'none' && !document.documentElement.className.includes('vt-'));
      await page.waitForTimeout(200);
      vt = await vts();
      check(instant && vt.length === 0, `with reduced motion a show's page is there at once, with no transition (${vt.length} started)`);
      await page.goBack();
      await page.waitForSelector('#pod-home:not(.hidden)');
      check((await vts()).length === 0, 'and back again the same');
      await page.emulateMedia({ reducedMotion: 'no-preference' });

      // On a phone, whatever is touched is at least 44 px both ways: tried 21.5 px from its
      // middle up, down, left and right (the edge of the screen counts as reach).
      if (mobile) {
        // (measured once a screen has finished coming in: during a view transition the page is a
        // picture and takes no touches)
        const reach = async (root, scroll = true) => (await page.waitForFunction(() => !/\bvt-/.test(document.documentElement.className))) && page.evaluate(([root, scroll]) => {
          const short = [];
          for (const box of document.querySelectorAll(root)) {
            for (const el of box.querySelectorAll('a[href], button, summary, select, input:not([type=hidden]), [role=button]')) {
              if (el.disabled || el.closest('.notes, .hint, .footer, .sr-only, [inert]')) continue;
              const t = el.tagName === 'INPUT' && ['radio', 'checkbox', 'file'].includes(el.type) ? el.closest('label') : el;
              if (!t || !t.getClientRects().length || getComputedStyle(t).visibility === 'hidden') continue;
              if (scroll) t.scrollIntoView({ block: 'center', inline: 'nearest' });
              const r = t.getBoundingClientRect();
              const cx = r.left + r.width / 2;
              const cy = r.top + r.height / 2;
              // (A side drawn 44 or more is enough as it is; a smaller one has to reach further.)
              const missed = [[0, -21.5], [0, 21.5], [-21.5, 0], [21.5, 0]].filter(([dx, dy]) => {
                if (dx ? r.width >= 43.5 : r.height >= 43.5) return false;
                const x = cx + dx;
                const y = cy + dy;
                if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
                const hit = document.elementFromPoint(x, y);
                if (hit?.closest('#tabbar, #playbar, .topbar') && !t.closest('#tabbar, #playbar, .topbar')) return false;
                return !(hit && (hit === t || t.contains(hit)));
              });
              if (missed.length) short.push(`${t.tagName.toLowerCase()}.${[...t.classList].join('.')} "${(t.getAttribute('aria-label') || t.textContent).trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}, missed at ${missed.map(([dx, dy]) => { const hh = document.elementFromPoint(cx + dx, cy + dy); return `${dx},${dy} (${hh?.tagName.toLowerCase()}.${hh?.className?.baseVal ?? hh?.className})`; }).join(' ')}`);
            }
          }
          return [...new Set(short)];
        }, [root, scroll]);
        const short = [];
        const screen = async (name) => {
          short.push(...(await reach('#pod .pod-view:not(.hidden), #playbar, #tabbar, .topbar')).map((x) => `${name}: ${x}`));
          await page.evaluate(() => window.scrollTo(0, 0));
        };
        await screen('Listen');
        await row('A bakery in 1911').locator('.ep-more').click();
        await page.waitForSelector('#row-menu.open');
        await page.waitForTimeout(300); // (unrolled)
        short.push(...(await reach('#row-menu', false)).map((x) => `menu: ${x}`));
        await page.keyboard.press('Escape');
        await row('What the tide tables leave out').locator('.ep-main').click();
        await page.waitForSelector('.ep-sheet .chapter');
        await page.waitForTimeout(400); // (in)
        short.push(...(await reach('#sheet')).map((x) => `episode: ${x}`));
        await page.keyboard.press('Escape');
        await page.waitForSelector('.ep-sheet', { state: 'detached' });
        await page.click('#show-grid .show-tile:has-text("Fjordfunn")');
        await page.waitForSelector('#show-list .ep');
        await page.waitForTimeout(500); // (the cover has arrived)
        // A show's page opens with its episodes in view: the first row whole above the player.
        const fold = await page.evaluate(() => { const r = document.querySelector('#show-list .ep').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), bar: Math.round(document.querySelector('#playbar').getBoundingClientRect().top), y: scrollY }; });
        check(fold.y === 0 && fold.top > 0 && fold.bottom <= fold.bar, `a show's page opens with its first episode in view, above the player (the row from ${fold.top} to ${fold.bottom} px, the player from ${fold.bar} px)`);
        await screen('a show');
        await page.click('#show-head .show-settings');
        await page.waitForSelector('.show-sheet .keep-newest');
        await page.waitForTimeout(400); // (in)
        short.push(...(await reach('#sheet')).map((x) => `show settings: ${x}`));
        await page.keyboard.press('Escape');
        await page.waitForSelector('.show-sheet', { state: 'detached' });
        await page.click('#tabbar [data-nav=queue]');
        await page.waitForSelector('#pod-queue .ep');
        await screen('Up next');
        await page.click('#queue-tabs label:has-text("Saved")');
        await page.waitForFunction(() => location.hash === '#/queue/saved');
        await screen('Up next, saved');
        await page.click('#tabbar [data-nav=settings]');
        for (const [tab, sel] of [['Playback', '#pod-settings .switch'], ['Library', '#pod-settings .qr svg'], ['Storage', '#pod-settings .switch'], ['Notifications', '#settings-notify']]) {
          await page.click(`#settings-tabs label:has-text("${tab}")`);
          await page.waitForSelector(sel);
          await screen(`Settings, ${tab}`);
        }
        await page.evaluate(() => { location.hash = '#/add'; });
        await page.fill('#pod-add input[type=search]', 'the long');
        await page.waitForSelector('#found-list .found');
        await screen('Find a show');
        await page.evaluate(() => { location.hash = '#/search'; });
        await page.fill('#pod-search input', 'committees');
        await page.waitForSelector('#search-results .hit');
        await screen('Search');
        // ...and in the now-playing sheet, with each of its controls open in turn.
        await page.click('#pb-open');
        await page.waitForSelector('.np');
        await page.waitForTimeout(450); // (in)
        short.push(...(await reach('#sheet')).map((x) => `player: ${x}`));
        for (const tool of await page.evaluate(() => [...document.querySelectorAll('.np-tool')].map((b) => b.dataset.tool))) {
          await page.click(`.np-tool-${tool}`);
          short.push(...(await reach('#sheet')).map((x) => `player, ${tool}: ${x}`));
        }
        await page.keyboard.press('Escape');
        await page.waitForSelector('.np', { state: 'detached' });

        // On an iPhone from its home screen the now-playing sheet is one screen: 844 px, less the
        // status bar's 47 and the home indicator's 34 it keeps clear of (390 by 763 here, where
        // those are not there). With a control open it runs a little over.
        await page.setViewportSize({ width: 390, height: 763 });
        await page.click('#pb-open');
        await page.waitForSelector('.np');
        await page.waitForTimeout(450); // (in)
        const fit = () => page.evaluate(() => { const p = document.querySelector('#sheet'); return { h: p.scrollHeight, room: p.clientHeight, art: document.querySelector('.np-art').offsetWidth }; });
        const closed = await fit();
        const opened = [];
        for (const tool of await page.evaluate(() => [...document.querySelectorAll('.np-tool')].map((b) => b.dataset.tool))) {
          await page.click(`.np-tool-${tool}`);
          opened.push([tool, (await fit()).h + 81]);
        }
        await shot('6g-player-fits');
        await page.keyboard.press('Escape');
        await page.waitForSelector('.np', { state: 'detached' });
        await page.setViewportSize(options.viewport);
        check(closed.h <= closed.room, `the now-playing sheet fits an iPhone's 844 px with no control open (${closed.h + 81} px, the cover ${closed.art} px)`);
        check(opened.every(([, hh]) => hh <= 844 + 96), `and runs at most a row of buttons over with one open (${opened.map(([t, hh]) => `${t} ${hh}`).join(', ')} px)`);
        check(!short.length, `on a phone every control is at least 44 px both ways${short.length ? `, not: ${short.join('; ')}` : ''}`);
      }
    }

    /* ---------- Carry on: long press and swipe ---------- */
    {
      await page.click(mobile ? '#tabbar [data-nav=listen]' : '#nav [data-nav=listen]');
      await page.waitForSelector('#started-list .tile', { timeout: 10000 });
      const first = () => page.evaluate(() => document.querySelector('#started-list .tile .tile-title')?.textContent || '');
      const title = await first();
      // A long press opens the episode's menu, with a way out of Carry on in it. (Pressed once the
      // screen has come in and stopped scrolling: a scroll under the finger rightly cancels a hold.)
      await page.waitForFunction(() => !document.getAnimations().some((a) => a.playState === 'running') && document.querySelector('#started-list .tile')?.getBoundingClientRect().top >= 0, null, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(150);
      await page.evaluate(() => { const t = document.querySelector('#started-list .tile'); const r = t.getBoundingClientRect(); t.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 3, pointerType: 'touch', isPrimary: true, button: 0, clientX: r.left + 100, clientY: r.top + 20, bubbles: true })); });
      await page.waitForSelector('#row-menu.open', { timeout: 3000 }).catch(() => {});
      await page.evaluate(() => { const t = document.querySelector('#started-list .tile'); t.dispatchEvent(new PointerEvent('pointerup', { pointerId: 3, pointerType: 'touch', isPrimary: true, bubbles: true })); });
      const items = await page.locator('#row-menu.open button b').allTextContents();
      check(items.includes('Remove from Carry on') && items.includes('Mark as played'), `a long press on a Carry on episode opens its menu (${items.join(', ')})`);
      await page.keyboard.press('Escape');
      if (mobile) {
        const swipe = (by) => page.evaluate((by) => {
          const t = document.querySelector('#started-list .tile');
          const r = t.getBoundingClientRect();
          const at = (x) => ({ pointerId: 4, pointerType: 'touch', isPrimary: true, button: 0, clientX: x, clientY: r.top + 20, bubbles: true });
          const x = r.right - 20;
          t.dispatchEvent(new PointerEvent('pointerdown', at(x)));
          for (let i = 1; i <= 6; i++) t.dispatchEvent(new PointerEvent('pointermove', at(x - (by * i) / 6)));
          t.dispatchEvent(new PointerEvent('pointerup', at(x - by)));
        }, by);
        // Swiped a little way: the two actions stay open.
        await swipe(130);
        await page.waitForTimeout(350);
        const open = await page.evaluate(() => ({ open: !!document.querySelector('#started-list .swipe.open'), labels: [...document.querySelectorAll('#started-list .swipe.open .swipe-actions button')].map((b) => b.textContent) }));
        await shot('4b-swipe');
        check(open.open && open.labels.join() === 'Played,Remove', `swiped to the left, a Carry on episode shows what can be done (${open.labels.join(', ')})`);
        // "Remove": the tile goes off to the left, then its row closes up (its height going to
        // nothing) before it is gone, and the tile under it ends where it was.
        const before = await page.evaluate(() => [...document.querySelectorAll('#started-list > .swipe')].map((w) => ({ id: w.dataset.id, top: Math.round(w.getBoundingClientRect().top), h: Math.round(w.getBoundingClientRect().height) })));
        const [removing] = await Promise.all([frames('#started-list > .swipe', 1400), page.click('#started-list .swipe.open .swipe-actions button:has-text("Remove")')]);
        const out = before[0];
        const closing = removing.map((f) => f.find((x) => x.id === out.id)).filter((x) => x?.leaving).map((x) => x.h);
        const after = removing.at(-1);
        check(closing.some((x) => x > 2 && x < out.h - 2) && !after.some((x) => x.id === out.id), `"Remove": its row closes up before it is gone (${out.h} px, then ${[...new Set(closing)].slice(0, 6).join(', ')}, ... gone)`);
        check(!before[1] || after[0]?.id === before[1].id && Math.abs(after[0].top - out.top) <= 1, `and the tile under it ends where it was (${before[1] ? `${after[0]?.top} px, was ${out.top}` : 'none under it'})`);
        check((await first()) !== title && /Removed from Carry on/.test(await page.locator('#toast').textContent()), `"Remove" takes it out of Carry on (${title})`);
        // Undo: it comes back in, its row opening.
        const [back] = await Promise.all([frames('#started-list > .swipe', 700), page.click('#toast-action')]);
        const opening = back.map((f) => f.find((x) => x.id === out.id)?.h).filter((x) => x != null);
        check(opening.some((x) => x > 2 && x < out.h - 2) && opening.at(-1) === out.h, `Undo opens its row again (${[...new Set(opening)].slice(0, 5).join(', ')}, ... ${opening.at(-1)} px)`);
        check(await page.evaluate((t) => [...document.querySelectorAll('#started-list .tile-title')].some((x) => x.textContent === t), title), 'and Undo puts it back, where it was');
        // Swiped all the way: played.
        await swipe(360);
        await page.waitForFunction((t) => ![...document.querySelectorAll('#started-list .tile-title')].some((x) => x.textContent === t), title, { timeout: 3000 }).catch(() => {});
        const gone = await page.evaluate((t) => ![...document.querySelectorAll('#started-list .tile-title')].some((x) => x.textContent === t), title);
        check(gone && /Marked as played/.test(await page.locator('#toast').textContent()), 'swiped all the way, it is marked as played');
        await page.click('#toast-action');
        await page.waitForTimeout(600);
      }
    }

    /* ---------- the small things: a press, a choice, a list changing, a pull ---------- */
    {
      await page.click(mobile ? '#tabbar [data-nav=listen]' : '#nav [data-nav=listen]');
      await page.waitForSelector('#pod-home:not(.hidden) #latest-list .ep');
      await page.evaluate(() => window.scrollTo(0, 0));
      // A finger down on `sel`, held 250 ms (or moved on at once, as a scroll starts), and let go:
      // how far what it pressed gave way while held, and after.
      const press = (sel, scroll = false) => page.evaluate(async ([sel, scroll]) => {
        const el = document.querySelector(sel);
        el.scrollIntoView({ block: 'center' });
        const who = el.matches('.ep-main, .tile-main') ? el.closest('.ep, .tile') : el;
        const wait = (ms) => new Promise((f) => setTimeout(f, ms));
        await wait(120); // (the scroll that brought it into view is over: a scroll lets go of a press)
        const r = el.getBoundingClientRect();
        const at = (dy) => ({ pointerId: 21, pointerType: 'touch', isPrimary: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 + dy, bubbles: true });
        const scale = () => +(parseFloat(getComputedStyle(who).scale) || 1).toFixed(3);
        el.dispatchEvent(new PointerEvent('pointerdown', at(0)));
        if (scroll) { await wait(15); el.dispatchEvent(new PointerEvent('pointermove', at(-30))); el.dispatchEvent(new PointerEvent('pointercancel', at(-30))); }
        await wait(250);
        const held = { scale: scale(), marked: who.hasAttribute('data-pressed') };
        el.dispatchEvent(new PointerEvent('pointerup', at(scroll ? -30 : 0)));
        await wait(450);
        return { held, after: { scale: scale(), marked: who.hasAttribute('data-pressed') } };
      }, [sel, scroll]);
      const btn = await press('#shows-add');
      check(btn.held.scale < 0.99 && btn.held.marked && btn.after.scale === 1 && !btn.after.marked, `a button gives way while it is pressed (${btn.held.scale}) and springs back when let go (${btn.after.scale})`);
      const pressedRow = await press('#latest-list .ep .ep-main');
      check(pressedRow.held.scale < 0.995 && pressedRow.held.marked && pressedRow.after.scale === 1, `a row gives way a little while pressed (${pressedRow.held.scale}), and is back after (${pressedRow.after.scale})`);
      const scrolled = await press('#latest-list .ep .ep-main', true);
      check(scrolled.held.scale === 1 && !scrolled.held.marked, `a finger that starts a scroll on a row leaves it as it was (${scrolled.held.scale}${scrolled.held.marked ? ', marked pressed' : ''})`);

      // A segmented control's highlight slides from the option that was on to the new one.
      const slide = () => page.evaluate(() => new Promise((done) => {
        const fs = document.querySelector('#latest-filter');
        fs.scrollIntoView({ block: 'center' });
        const label = [...fs.querySelectorAll('label')].find((l) => !l.querySelector('input').checked);
        const r = label.getBoundingClientRect();
        const at = { pointerId: 22, pointerType: 'touch', isPrimary: true, button: 0, clientX: r.left + 5, clientY: r.top + 5, bubbles: true };
        label.dispatchEvent(new PointerEvent('pointerdown', at));
        label.dispatchEvent(new PointerEvent('pointerup', at));
        label.click();
        const seen = [];
        const look = () => {
          seen.push(Math.round(new DOMMatrix(getComputedStyle(fs.querySelector('input:checked + span'), '::before').transform).m41));
          if (seen.length < 40) requestAnimationFrame(look); else done(seen);
        };
        requestAnimationFrame(look);
      }));
      const hl = await slide();
      check(Math.abs(hl[0]) > 10 && hl.some((x) => x !== hl[0] && x !== 0) && hl.at(-1) === 0, `the highlight of "Not played" and "All" slides over to the one chosen (from ${hl[0]} px: ${[...new Set(hl)].slice(0, 6).join(', ')} ... ${hl.at(-1)})`);
      await slide(); // (back as it was)
      await page.waitForTimeout(500);

      // The queue changes in place: two that change places move past each other; one taken out
      // closes up, and the row under it ends where it was.
      const added = [];
      for (let i = 0; added.length < 2 && i < 8; i++) {
        const r = page.locator('#latest-list .ep').nth(i);
        await r.locator('.ep-more').click();
        const add = page.locator('#row-menu.open button:has-text("Add to the queue")');
        if (await add.count()) { added.push(await r.locator('.ep-title').textContent()); await add.click(); } else await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
      }
      await page.click(mobile ? '#tabbar [data-nav=queue]' : '#nav [data-nav=queue]');
      await page.waitForSelector('#pod-queue ol > .ep');
      await page.waitForTimeout(300);
      await page.evaluate(() => document.querySelector('#pod-queue ol > .ep:last-child').scrollIntoView({ block: 'center' }));
      const queueNow = () => page.evaluate(() => [...document.querySelectorAll('#pod-queue ol > .ep')].map((li) => ({ id: li.dataset.id, top: Math.round(li.getBoundingClientRect().top), y: Math.round(li.getBoundingClientRect().top + scrollY), h: Math.round(li.getBoundingClientRect().height) })));
      let q = await queueNow();
      const n = q.length;
      const [a, b] = [q[n - 2], q[n - 1]];
      const [moving] = await Promise.all([frames('#pod-queue ol > .ep', 900), page.locator('#pod-queue ol > .ep').nth(n - 2).locator('button[aria-label$=" down"]').click()]);
      const aTops = moving.map((f) => f.find((x) => x.id === a.id)).filter(Boolean);
      // (Where they end is read once the springs have settled, down the page rather than on the
      // screen: a slow machine may still be moving them at the end of the frames, or scroll.)
      await page.waitForFunction(() => [...document.querySelectorAll('#pod-queue ol > .ep')].every((li) => getComputedStyle(li).transform === 'none'), null, { timeout: 4000 }).catch(() => {});
      const last = await queueNow();
      const settled = await page.evaluate(() => [...document.querySelectorAll('#pod-queue ol > .ep')].every((li) => getComputedStyle(li).transform === 'none'));
      check(aTops.some((x) => x.moved && x.y > a.y + 2 && x.y < a.y + b.h - 2) && last.at(-1)?.id === a.id && last.at(-2)?.id === b.id && Math.abs(last.at(-2).y - a.y) <= 1 && settled,
        `moved down in the queue, an episode and the one under it go past each other (${[...new Set(aTops.map((x) => x.y))].slice(0, 6).join(', ')} ... to ${last.at(-1)?.y} px down the page; the one under it ends at ${last.at(-2)?.y}, was ${a.y}${settled ? '' : '; still moving'})`);
      q = await queueNow();
      const [taking] = await Promise.all([frames('#pod-queue ol > .ep', 900), page.locator('#pod-queue ol > .ep').nth(n - 2).locator('button[aria-label^="Take"]').click()]);
      const closing = taking.map((f) => f.find((x) => x.id === b.id)).filter((x) => x?.leaving).map((x) => x.h);
      const ended = taking.at(-1);
      // (In the page, that is: near the end of it, the page itself gets shorter and scrolls.)
      check(closing.some((x) => x > 2 && x < b.h - 2) && !ended.some((x) => x.id === b.id) && ended.at(-1)?.id === a.id && Math.abs(ended.at(-1).y - q[n - 2].y) <= 1,
        `taken out of the queue, its row closes up before it is gone (${b.h} px, then ${[...new Set(closing)].slice(0, 5).join(', ')} ...), and the one under it ends in its place (${ended.at(-1)?.y} px down the page, was ${q[n - 2].y})`);

      // With motion turned down on the device: nothing gives way or slides, and a row taken out
      // is gone at once.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const still = await press('#pod-queue ol > .ep:last-child .ep-more');
      await page.keyboard.press('Escape');
      const [instant] = await Promise.all([frames('#pod-queue ol > .ep', 300), page.locator('#pod-queue ol > .ep').last().locator('button[aria-label^="Take"]').click()]);
      await page.click(mobile ? '#tabbar [data-nav=listen]' : '#nav [data-nav=listen]');
      await page.waitForSelector('#pod-home:not(.hidden) #latest-list .ep');
      const stillSlide = await slide();
      await slide();
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      check(still.held.scale === 1 && instant.every((f) => !f.some((x) => x.leaving || x.moved)) && !instant.at(-1).some((x) => x.id === a.id) && stillSlide.every((x) => x === 0),
        `with reduced motion a press, a row taken out and a highlight changing are instant (${still.held.scale}; ${instant.filter((f) => f.some((x) => x.leaving)).length} frames closing; highlight ${[...new Set(stillSlide)].join(', ')})`);

      // Pull to refresh, on Listen, with a finger (where a touch can be made up): short of the
      // mark nothing is asked; past it, what is new is asked for, and the page settles back.
      if (mobile) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(200);
        const pull = (by) => page.evaluate(async (by) => {
          const el = document.querySelector('#home-shows');
          try { new Touch({ identifier: 1, target: el, clientX: 0, clientY: 0 }); } catch { return null; }
          const touch = (y) => [new Touch({ identifier: 6, target: el, clientX: 200, clientY: y })];
          const send = (type, y) => el.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : touch(y), targetTouches: type === 'touchend' ? [] : touch(y), changedTouches: touch(y), bubbles: true, cancelable: true }));
          send('touchstart', 200);
          let most = 0;
          for (let i = 1; i <= 12; i++) {
            await new Promise((f) => setTimeout(f, 16));
            send('touchmove', 200 + (by * i) / 12);
            most = Math.max(most, parseFloat(getComputedStyle(document.querySelector('#pod-home')).translate.split(' ')[1]) || 0);
          }
          send('touchend', 200 + by);
          return Math.round(most);
        }, by);
        let asked = 0;
        const count = (r) => { if (/\/api\/pod\/inbox\?fresh=1/.test(r.url())) asked++; };
        page.on('request', count);
        const short = await pull(60);
        await page.waitForTimeout(600);
        const shortAsked = asked;
        const long = await pull(240);
        if (long == null) console.log('  note: this browser cannot make up a touch, so pull to refresh is not gone through here');
        else {
          await page.waitForFunction(() => !document.querySelector('.pull.turning') && getComputedStyle(document.querySelector('#pod-home')).translate === 'none', null, { timeout: 8000 }).catch(() => {});
          const settled = await page.evaluate(() => getComputedStyle(document.querySelector('#pod-home')).translate);
          await shot('4c-pull');
          check(shortAsked === 0 && asked === 1 && long > 64 && short > 0 && settled === 'none', `pulled down from the top of Listen past the mark, it looks for new episodes, and settles back (pulled ${long} px: ${asked} ask; ${short} px, short of the mark: ${shortAsked})`);
        }
        page.off('request', count);
      }
      // (What was added and is still queued goes out again.)
      await page.click(mobile ? '#tabbar [data-nav=queue]' : '#nav [data-nav=queue]');
      await page.waitForSelector('#pod-queue');
      for (const t of added) {
        const r = page.locator('#pod-queue ol > .ep:not(.leaving)', { hasText: t });
        if (await r.count()) { await r.locator('button[aria-label^="Take"]').click(); await page.waitForTimeout(500); }
      }
    }

    /* ---------- shows out, as a file ---------- */
    if (!mobile) {
      await page.click('#nav [data-nav=settings]');
      await page.click('#settings-tabs label:has-text("Library")');
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
      await page.waitForSelector('#show-head .show-settings');
      await page.waitForSelector('#show-list .ep:has-text("Kanonen i Oslofjorden")');
      await page.click('#show-head .show-settings');
      await page.waitForSelector('.show-sheet .keep-newest');
      await page.click('.show-sheet .keep-newest label:has-text("2")');
      await page.waitForTimeout(400);
      await shot('12-keep-newest');
      await noSideScroll('keep the newest');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.show-sheet', { state: 'detached' });
      check(/2 kept/.test(await page.locator('#show-head .show-settings').textContent()), `the show's settings button says how many it keeps (${await page.locator('#show-head .show-settings').textContent()})`);
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
      await page.click(mobile ? '#tabbar [data-nav=settings]' : '#nav [data-nav=settings]');
      await page.click('#settings-tabs label:has-text("Storage")');
      await page.waitForSelector('#pod-settings .kept-note');
      const note = await page.locator('#pod-settings .kept-note').textContent();
      check(/the newest 2 of Fjordfunn\./.test(note) && /2 episodes saved that way/.test(note) && await page.locator('#pod-settings button:has-text("Stop keeping episodes by themselves")').isVisible(), `Settings says what is kept by itself (${note})`);
      await page.evaluate(() => document.querySelector('#pod-settings .kept-note').scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(400);
      await shot('13-keep-settings');
      await page.goBack();
      await page.waitForSelector('#show-head .show-settings');
      await page.click('#show-head .show-settings');
      await page.waitForSelector('.show-sheet .keep-newest');
      await page.click('.show-sheet .keep-newest label:has-text("None")');
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
    // A push message reaches the worker (Chromium hands one over through its debugging protocol)
    // and is shown as a notification, with the app's icon and where a tap goes.
    // (Only where the browser keeps notifications at all: the headless build CI runs shows none.)
    if (!WEBKIT) await ctx.grantPermissions(['notifications'], { origin: world.base });
    const shows = !WEBKIT && await page.evaluate(async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification('probe', { tag: 'probe' });
        const got = await reg.getNotifications({ tag: 'probe' });
        for (const n of got) n.close();
        return got.length > 0;
      } catch { return false; }
    });
    if (!WEBKIT && !shows) console.log('  note: this browser build keeps no notifications, so the worker showing a pushed message is not checked here');
    if (shows) {
      const cdp = await ctx.newCDPSession(page);
      const regs = [];
      cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => regs.push(...e.registrations));
      await cdp.send('ServiceWorker.enable');
      for (let i = 0; i < 20 && !regs.some((r) => !r.isDeleted); i++) await page.waitForTimeout(100);
      const msg = { title: 'Harbour Hours', body: 'Night shift at the grain terminal', tag: 'e1', url: '#/show/abc123abc123', episode: 'e1' };
      await cdp.send('ServiceWorker.deliverPushMessage', { origin: world.base, registrationId: regs.find((r) => !r.isDeleted)?.registrationId || '0', data: JSON.stringify(msg) });
      let shown = [];
      for (let i = 0; i < 25 && !shown.length; i++) {
        await page.waitForTimeout(200);
        shown = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, icon: n.icon, url: n.data?.url })));
      }
      check(shown.length === 1 && shown[0].title === msg.title && shown[0].body === msg.body && shown[0].tag === 'e1' && shown[0].icon.endsWith('/icon-192.png') && shown[0].url === msg.url, `the worker shows a pushed message as a notification (${JSON.stringify(shown)})`);
      await cdp.detach();
    }
    if (!WEBKIT) {
      // A tap with the app open: the worker tells the page where to go (what its click handler
      // sends; a real tap can't be made here).
      const sw = ctx.serviceWorkers()[0];
      await sw?.evaluate(async () => { for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'open', hash: '#/settings' }); });
      await page.waitForSelector('#pod-settings:not(.hidden)', { timeout: 5000 }).catch(() => {});
      check(!!sw && (await page.evaluate(() => location.hash)) === '#/settings', 'told by the worker, the open app goes to the address');
      await page.evaluate(() => { location.hash = '#/'; });
    }
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
