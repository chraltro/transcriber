// What the player looks like: the bar along the bottom, and the sheet it opens into (cover,
// chapter, position, and under them one row of buttons for speed, sleep timer, pauses, ads and
// what is up next, each saying where it stands and opening its control). The playing itself is
// ui/player.js; the position control, drawn as the whole episode, is ui/score.js.
import { h, icon, setIcon, openSheet, closeSheet, sheetOpen } from './dom.js';
import { fmtTime } from '../lib/text.js';
import { leftText, fmtSpeed, nextSpeed, SPEEDS } from '../lib/playback.js';
import { adSeconds, breakAt } from '../lib/breaks.js';
import { voiceAt } from '../lib/shape.js';
import { Score } from './score.js';
import { cutSeconds } from '../lib/quiet.js';
import { swapIcon, swapText } from './motion.js';
import { jobTag, jobText } from '../lib/serverjob.js';

const $ = (id) => document.getElementById(id);
// The row of buttons in the sheet, each opening its control in a panel under the row. (An iPhone
// sets the volume with its own buttons only: no volume there.)
const TOOLS = [['speed', 'Speed'], ['sleep', 'Sleep'], ['trim', 'Pauses'], ['skips', 'Ads'], ['next', 'Up next'], ['volume', 'Volume']];
const IS_IOS = typeof navigator !== 'undefined' && (/iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

export class PlayerUI {
  // artInto(box, { art, title, show }): the app's cover art (app.js); toast(text, action);
  // openTranscript(item), openEpisode(item): what the sheet's buttons do.
  // saveOffline(item): keeps the episode on the device (its pauses can then be found).
  constructor({ player, store, artInto, toast, openTranscript, hasTranscript, openEpisode, saveOffline, isSaved, isSaving }) {
    Object.assign(this, { player, store, artInto, toast, openTranscript, hasTranscript, openEpisode, saveOffline, isSaved, isSaving });
    this.bar = $('playbar');
    this.scrub = new Score($('pb-scrub'), { player, compact: true, onPreview: (t) => { $('pb-cur').textContent = fmtTime(t); } });
    this.sheet = null;

    $('pb-play').addEventListener('click', () => player.toggle());
    $('pb-back').addEventListener('click', () => player.skip(-store.settings.back));
    $('pb-fwd').addEventListener('click', () => player.skip(store.settings.fwd));
    $('pb-open').addEventListener('click', () => this.open());
    $('pb-speed').addEventListener('click', () => player.setSpeed(nextSpeed(player.rateFor())));
    $('pb-jump').addEventListener('click', () => player.skipAd());

    player.addEventListener('item', () => { this.item(); this.marks(); this.time(); this.state(); });
    player.addEventListener('state', () => this.state());
    player.addEventListener('time', () => this.time());
    player.addEventListener('rate', () => this.rate());
    player.addEventListener('ads', () => { this.ads(); this.marks(); this.time(); });
    player.addEventListener('shape', () => { this.marks(); this.time(); });
    player.addEventListener('quiet', () => this.trims());
    player.addEventListener('chapters', () => { this.chapterDraw(); this.marks(); this.time(); });
    player.addEventListener('chapter', () => this.chapterDraw());
    player.addEventListener('sleep', (e) => { this.sleepDraw(); if (e.detail.fired) toast('Sleep timer: paused'); });
    player.addEventListener('skipped', (e) => toast(`Skipped ${fmtTime(e.detail.seconds)} of ads`, { label: 'Undo', run: () => player.undoSkip() }));
    player.addEventListener('blocked', () => toast('Tap play once more to start'));
    player.addEventListener('error', (e) => toast(e.detail.message));
    store.addEventListener('status', () => this.transcriptButton());
    store.addEventListener('transcripts', () => this.transcriptButton());
    store.addEventListener('change', (e) => {
      const keys = e.detail.keys || [];
      if (keys.includes('settings') || keys.some((k) => k.startsWith('subs/'))) { this.rate(); this.jumps(); this.trims(); this.ads(); }
      if (keys.includes('queue') && this.sheet) this.upNext();
    });
    setInterval(() => { if (player.sleep) this.sleepDraw(); }, 1000);
    this.jumps();
    this.item();
    this.rate();
  }

  jumps() {
    const { back, fwd } = this.store.settings;
    for (const root of [this.bar, this.sheet].filter(Boolean)) {
      for (const [sel, n, word] of [['.jump-back', back, 'Back'], ['.jump-fwd', fwd, 'Forward'], ['#pb-back', back, 'Back'], ['#pb-fwd', fwd, 'Forward']]) {
        const b = root.querySelector(sel);
        if (!b) continue;
        b.querySelector('b').textContent = String(n);
        b.setAttribute('aria-label', `${word} ${n} seconds`);
      }
    }
  }

  item() {
    const item = this.player.item;
    this.bar.classList.toggle('hidden', !item);
    document.body.classList.toggle('has-player', !!item);
    if (!item) { if (sheetOpen('player')) closeSheet(); return; }
    $('pb-title').textContent = item.title || 'Episode';
    $('pb-sub').textContent = item.show || '';
    this.artInto($('pb-art'), item);
    this.ads();
    if (this.sheet) this.fill();
  }

  state() {
    const { player } = this;
    const playing = player.playing;
    document.body.classList.toggle('pod-playing', playing);
    for (const b of [$('pb-play'), this.sheet?.querySelector('.np-play')].filter(Boolean)) {
      // (Play turns into pause and back: ui/motion.js.)
      swapIcon(b, playing ? 'pause' : 'play');
      b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      b.classList.toggle('playing', playing);
      b.classList.toggle('waiting', player.loading && !player.audio.paused);
    }
  }

  time() {
    const { player } = this;
    const d = player.duration;
    const t = player.time;
    $('pb-line').style.width = d > 0 ? `${Math.min(100, (t / d) * 100)}%` : '0';
    this.scrub.draw();
    if (!this.scrub.dragging) $('pb-cur').textContent = fmtTime(t);
    $('pb-left').textContent = d > 0 ? `-${fmtTime(Math.max(0, d - t))}` : '';
    if (!this.sheet) return;
    this.sheetScrub.draw();
    if (player.trimmed !== this.shownTrim) this.trims();
    if (!this.sheetScrub.dragging) { this.sheet.querySelector('.np-cur').textContent = fmtTime(t); this.nowDraw(t); }
    this.sheet.querySelector('.np-left').textContent = leftText(t, d, player.rate);
  }

  // What the strips show changed: the shape, the ad breaks, the chapters, the episode.
  marks() {
    this.scrub.refresh();
    if (this.sheet) { this.sheetScrub.refresh(); this.nowDraw(this.sheetScrub.time, true); }
  }

  // The line under the strip: who is speaking at `t` and in which chapter, or that it is a
  // sponsor read. (The chapter is said here once, with the buttons to the one before and after.)
  nowDraw(t, force = false) {
    const row = this.sheet?.querySelector('.np-now');
    if (!row) return;
    const { player } = this;
    const shape = player.shape;
    const inRead = player.breaks ? breakAt(player.breaks, t) >= 0 : false;
    const v = inRead ? -1 : voiceAt(shape, t);
    const ch = player.chapterCount ? player.chapterAt(t) : -2;
    const key = `${inRead}|${v}|${ch}|${shape?.voices.join() || ''}`;
    if (key === this.nowKey && !force) return;
    this.nowKey = key;
    const sw = row.querySelector('.np-now-sw');
    const who = inRead ? 'Sponsor read' : v >= 0 ? shape.voices[v] : '';
    sw.classList.toggle('hidden', !who);
    sw.classList.toggle('hatch', inRead);
    sw.dataset.hue = inRead ? '' : v === shape?.other ? 'other' : String(shape?.hues[v] ?? v);
    row.querySelector('.np-now-who').textContent = who;
    const title = ch >= 0 ? player.chapters[ch].title : ch === -1 && !who ? 'Before the first chapter' : '';
    row.querySelector('.np-chapter-title').textContent = title;
    row.querySelector('.np-now-sep').classList.toggle('hidden', !who || !title);
  }

  rate() {
    const r = this.player.rateFor();
    $('pb-speed').textContent = fmtSpeed(r);
    $('pb-speed').classList.toggle('on', Math.abs(r - 1) > 0.001);
    if (!this.sheet) return;
    this.toolValue('speed', fmtSpeed(r), Math.abs(r - 1) > 0.001);
    for (const b of this.sheet.querySelectorAll('.np-speeds button[data-rate]')) b.setAttribute('aria-pressed', String(Math.abs(Number(b.dataset.rate) - r) < 0.001));
    const own = this.sheet.querySelector('.np-own input');
    if (own) own.checked = !!this.store.show(this.player.item?.sub)?.speed;
    this.time();
  }

  ads() {
    const { player } = this;
    const inAd = player.inBreak >= 0;
    $('pb-jump').classList.toggle('hidden', !inAd);
    if (!this.sheet) return;
    this.sheet.querySelector('.np-jump').classList.toggle('hidden', !inAd);
    const note = this.sheet.querySelector('.np-skips-note');
    const sw = this.sheet.querySelector('.np-skips input');
    sw.checked = this.store.settings.skipAds;
    sw.disabled = !player.breaks;
    this.sheet.querySelector('.np-skips').classList.toggle('off', !player.breaks);
    this.toolValue('skips', !player.breaks ? 'None' : this.store.settings.skipAds ? 'Skipped' : 'Played', !!player.breaks && this.store.settings.skipAds);
    note.textContent = player.breaks
      ? `${player.breaks.length} ad break${player.breaks.length === 1 ? '' : 's'} marked, ${fmtTime(adSeconds(player.breaks))} in all`
      : player.source && !player.source.synced && this.hasTranscript(player.item)
        ? 'This copy of the audio may carry other ads than the one transcribed, so none are skipped'
        : 'Ads are found from an episode\'s transcript. This one has none yet';
  }

  // Pauses: what the limit is, what was found in this episode, what it has saved so far.
  trims() {
    if (!this.sheet) return;
    const { player, store } = this;
    const limit = store.settings.trim || 0;
    this.toolValue('trim', limit ? `${limit} s` : 'Off', !!limit);
    for (const b of this.sheet.querySelectorAll('.np-trims button')) b.setAttribute('aria-pressed', String(Number(b.dataset.trim) === limit));
    const state = this.sheet.querySelector('.np-trim-state');
    const note = this.sheet.querySelector('.np-trim-note');
    const save = this.sheet.querySelector('.np-trim-save');
    this.shownTrim = player.trimmed;
    state.dataset.saved = player.trimmed.toFixed(2);
    const over = `${limit} s`;
    state.textContent = !limit ? 'Off' : player.trimmed >= 1 ? `${fmtTime(player.trimmed)} saved` : 'Nothing cut yet';
    state.classList.toggle('hidden', !limit);
    let offer = false;
    if (!limit) note.textContent = 'Pick the longest pause to leave alone. Anything longer is cut down to that, so the dead air of a call\'s delay goes and the pauses people make on purpose stay.';
    else if (player.finding != null) note.textContent = `Listening through the episode for its pauses: ${Math.round(player.finding * 100)}%`;
    else if (player.quiet) {
      const n = player.cuts.length;
      note.textContent = n ? `${n} pause${n === 1 ? ' in this episode is' : 's in this episode are'} longer than ${over}. Shortening ${n === 1 ? 'it' : 'them'} takes ${fmtTime(cutSeconds(player.cuts))} off it.` : `No pause in this episode is longer than ${over}.`;
    } else {
      const saving = player.item && this.isSaving(player.item);
      offer = !!player.item?.url && !this.isSaved(player.item) && !saving;
      note.textContent = saving ? 'Saving the episode on this device. Its pauses are found when that is done.'
        : offer ? 'The pauses can be found when the episode is saved on this device, or once the server has transcribed it.'
          : 'The pauses in this episode could not be found.';
    }
    save.classList.toggle('hidden', !offer || !limit);
  }

  // The chapter being played is in the line under the strip (nowDraw); beside it, the buttons to
  // the one before and after, and for a screen reader which chapter of how many it is.
  chapterDraw() {
    const row = this.sheet?.querySelector('.np-chapter');
    if (!row) return;
    const { player } = this;
    const n = player.chapterCount;
    row.classList.toggle('hidden', !n);
    this.nowDraw(this.sheetScrub.time, true);
    if (!n) return;
    const i = player.chapter;
    row.querySelector('.np-chapter-count').textContent = i >= 0 ? `Chapter ${i + 1} of ${n}` : `${n} chapters`;
    row.querySelector('.np-chapter-next').disabled = i + 1 >= n;
  }

  sleepDraw() {
    if (!this.sheet) return;
    const { sleep } = this.player;
    const left = this.player.sleepLeft;
    const state = this.sheet.querySelector('.np-sleep-state');
    state.textContent = !sleep ? 'Off' : sleep.end ? 'When this episode ends' : `Pauses in ${fmtTime(left)}`;
    state.classList.toggle('hidden', !sleep);
    // (On the button, whole minutes: it changes once a minute, not every second.)
    this.toolValue('sleep', !sleep ? 'Off' : sleep.end ? 'At end' : left >= 60 ? `${Math.ceil(left / 60)} min` : `${Math.ceil(left)} s`, !!sleep);
    for (const b of this.sheet.querySelectorAll('.np-sleeps button')) {
      const v = b.dataset.sleep;
      b.setAttribute('aria-pressed', String(v === 'end' ? !!sleep?.end : v === '0' ? !sleep : sleep?.minutes === Number(v)));
    }
  }

  upNext() {
    const list = this.sheet?.querySelector('.np-next');
    if (!list) return;
    const all = this.store.queue.filter((e) => e.id !== this.player.item?.id);
    const next = all.slice(0, 3);
    this.toolValue('next', all.length ? String(all.length) : 'None', all.length > 0);
    list.replaceChildren(...(next.length ? next.map((e) => h('li', {}, h('span.np-next-title', { text: e.title }), h('span.np-next-show', { text: e.show || '' }))) : [h('li.empty', { text: 'Nothing queued. This episode is the last.' })]));
    this.sheet.querySelector('.np-next-all').classList.toggle('hidden', !next.length);
  }

  // A button in the row under the transport: where its control stands, and whether that is
  // other than the usual (marked as a switched-on chip is). A new value slides in over the old
  // (ui/motion.js swapText).
  toolValue(name, text, on) {
    const b = this.sheet?.querySelector(`.np-tool[data-tool="${name}"]`);
    if (!b) return;
    swapText(b.querySelector('.np-tool-value'), text);
    b.classList.toggle('on', on);
  }

  // One control open at a time, under the row, at once (a panel is not a sheet: it does not
  // slide), in the place of the three buttons under it while it is open, so the sheet stays
  // about one screen. '' puts the open one away.
  toolOpen(name) {
    const { sheet } = this;
    if (!sheet) return;
    this.openTool = name;
    for (const b of sheet.querySelectorAll('.np-tool')) b.setAttribute('aria-expanded', String(b.dataset.tool === name));
    for (const p of sheet.querySelectorAll('.np-panel')) p.classList.toggle('hidden', p.dataset.tool !== name);
    sheet.classList.toggle('panel-open', !!name);
    const panel = name && sheet.querySelector(`.np-panel[data-tool="${name}"]`);
    if (panel) panel.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- the sheet ---------- */

  open() {
    const { player, store } = this;
    if (!player.item) return;
    const jump = (cls, name, fn) => h(`button.icon-btn.jump-btn.${cls}`, { type: 'button', onclick: fn }, icon(name), h('b'));
    const seg = (cls, items) => h(`div.mini-seg.${cls}`, {}, items);
    const tools = TOOLS.filter(([name]) => name !== 'volume' || !IS_IOS);
    // A control's panel, under the row: the control, and a line on where it stands where the
    // button above has no room for all of it. (Its button, pressed again, puts it away.)
    const panel = (name, title, ...kids) => h(`div.np-panel.np-panel-${name}.hidden`, { id: `np-panel-${name}`, role: 'region', 'aria-label': title, dataset: { tool: name } }, ...kids);
    const sheet = h('div.np', {},
      h('div.sheet-top', {},
        h('p.kicker', { text: 'Now playing' }),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Close the player', onclick: () => closeSheet() }, icon('down'))),
      h('div.art.np-art'),
      h('p.eyebrow.np-show'),
      h('h2.np-title', { id: 'sheet-title' }),
      h('div.np-score', {},
        h('div.np-strip'),
        h('div.np-now', {},
          h('p.np-now-text', {},
            h('span.np-now-sw.hidden', { 'aria-hidden': 'true' }),
            h('span.np-now-words', {}, h('b.np-now-who'), h('span.np-now-sep.hidden', { text: ' / ' }), h('span.np-chapter-title'))),
          h('div.np-chapter.hidden', {},
            h('span.sr-only.np-chapter-count', { 'aria-live': 'polite' }),
            h('button.icon-btn.np-chapter-prev', { type: 'button', 'aria-label': 'Previous chapter', onclick: () => player.prevChapter() }, icon('prev')),
            h('button.icon-btn.np-chapter-next', { type: 'button', 'aria-label': 'Next chapter', onclick: () => player.nextChapter() }, icon('next')))),
        h('div.np-clock', {}, h('span.np-cur', { text: '0:00' }), h('span.np-left'))),
      h('div.np-transport', {},
        jump('jump-back', 'back', () => player.skip(-store.settings.back)),
        h('button.play.np-play', { type: 'button', 'aria-label': 'Play', onclick: () => player.toggle() }, icon('play')),
        jump('jump-fwd', 'fwd', () => player.skip(store.settings.fwd))),
      h('button.btn.primary.np-jump.hidden', { type: 'button', onclick: () => player.skipAd() }, icon('skip'), h('span', { text: 'Skip this ad' })),

      // The rest, one row: each button says where its control stands and opens it under the row.
      h('div.np-tools', {}, tools.map(([name, label]) => h(`button.np-tool.np-tool-${name}`, { type: 'button', dataset: { tool: name }, 'aria-expanded': 'false', 'aria-controls': `np-panel-${name}`, onclick: () => this.toolOpen(this.openTool === name ? '' : name) },
        h('span.np-tool-label', { text: label }), h('b.np-tool-value')))),

      panel('speed', 'Speed',
        h('div.np-speeds', {},
          h('button.icon-btn', { type: 'button', 'aria-label': 'Slower', onclick: () => player.setSpeed(player.rateFor() - 0.1) }, h('span.sign', { text: '−' })),
          seg('', SPEEDS.filter((s) => s <= 2.5).map((s) => h('button', { type: 'button', dataset: { rate: String(s) }, 'aria-pressed': 'false', text: fmtSpeed(s), onclick: () => player.setSpeed(s) }))),
          h('button.icon-btn', { type: 'button', 'aria-label': 'Faster', onclick: () => player.setSpeed(player.rateFor() + 0.1) }, h('span.sign', { text: '+' }))),
        store.show(player.item.sub) ? h('label.switch.setting.np-own', {},
          h('input', { type: 'checkbox', onchange: (e) => { store.updateShow(player.item.sub, { speed: e.target.checked ? player.rateFor() : undefined }); player.applyRate(); this.rate(); } }),
          h('span.track', {}, h('span.knob')), h('span.switch-label', { text: 'Its own speed for this show' })) : null),

      panel('sleep', 'Sleep timer',
        h('p.np-state.np-sleep-state'),
        seg('np-sleeps', [['Off', '0'], ['15 min', '15'], ['30 min', '30'], ['45 min', '45'], ['1 h', '60'], ['End of episode', 'end']].map(([label, v]) =>
          h('button', { type: 'button', dataset: { sleep: v }, 'aria-pressed': 'false', text: label, onclick: () => { player.setSleep(v === 'end' ? 'end' : Number(v)); this.sleepDraw(); } })))),

      panel('trim', 'Shorten pauses',
        h('p.np-state.np-trim-state'),
        seg('np-trims', [['Off', 0], ['0.5 s', 0.5], ['0.8 s', 0.8], ['1.2 s', 1.2], ['2 s', 2]].map(([label, v]) =>
          h('button', { type: 'button', dataset: { trim: String(v) }, 'aria-pressed': 'false', text: label, onclick: () => { store.set({ trim: v }); this.trims(); } }))),
        h('p.hint.np-trim-note'),
        h('button.btn.ghost.small.np-trim-save.hidden', { type: 'button', onclick: () => { this.saveOffline(player.item); this.trims(); } }, icon('download'), h('span', { text: 'Save the episode on this device' }))),

      panel('skips', 'Ads',
        h('label.switch.setting.np-skips', {},
          h('input', { type: 'checkbox', onchange: (e) => store.set({ skipAds: e.target.checked }) }),
          h('span.track', {}, h('span.knob')), h('span.switch-label', { text: 'Skip ads' })),
        h('p.hint.np-skips-note')),

      panel('next', 'Up next',
        h('ol.np-next'),
        h('a.np-next-all', { href: '#/queue', text: 'Open the queue', onclick: () => closeSheet() })),

      IS_IOS ? null : panel('volume', 'Volume',
        h('div.np-volume', {},
          icon('volume'),
          (() => {
            const v = h('input', { type: 'range', min: '0', max: '100', step: '1', value: String(Math.round(player.audio.volume * 100)), 'aria-label': 'Volume' });
            const paint = () => { v.style.setProperty('--pct', `${v.value}%`); this.toolValue('volume', `${v.value}%`, false); };
            v.addEventListener('input', () => { player.setVolume(Number(v.value) / 100); paint(); });
            paint();
            return v;
          })())),

      // What else there is to do with it: three buttons side by side.
      h('div.np-actions', {},
        h('button.btn.ghost.np-transcript', { type: 'button', onclick: () => {
          const it = player.item;
          // (The server on it already: what it says, not a second transcript made here.)
          const job = !this.hasTranscript(it) && this.store.job?.(it.id);
          if (job) { this.toast(jobText(job)); return; }
          closeSheet({ then: () => this.openTranscript(it) });
        } }, icon('lines'), h('span')),
        h('button.btn.ghost.np-details', { type: 'button', onclick: () => this.openEpisode(player.item) }, icon('alert'), h('span', { text: 'Episode notes' })),
        h('button.btn.ghost.np-out', { type: 'button', onclick: () => { closeSheet(); player.stop(); } }, icon('x'), h('span', { text: 'Take it out of the player' }))));
    this.sheet = sheet;
    this.openTool = '';
    this.nowKey = '';
    this.sheetScrub = new Score(sheet.querySelector('.np-strip'), { player, onPreview: (t) => { sheet.querySelector('.np-cur').textContent = fmtTime(t); this.nowDraw(t); } });
    // It grows out of the bar and shrinks back into it: the cover, the title and the play button
    // go between their places in the two (ui/dom.js).
    const grow = () => ({ bar: this.bar, list: [[$('pb-art'), sheet.querySelector('.np-art')], [$('pb-title'), sheet.querySelector('.np-title')], [$('pb-play'), sheet.querySelector('.np-play')]] });
    openSheet(sheet, { name: 'player', grow, closed: () => { this.sheetScrub?.destroy(); this.sheet = null; this.sheetScrub = null; removeEventListener('resize', this.refit); } });
    this.fill();
    player.wantShape();
    this.refit ||= () => this.fit();
    addEventListener('resize', this.refit);
  }

  // On a phone the whole sheet is one screen, its panels put away: the cover gives way to the
  // rest (down to 120 px) when the title, the screen or the line under the strip leave too
  // little room. Measured as it opens and when the episode changes, never while a panel is
  // open, so nothing moves under a finger.
  fit() {
    const { sheet } = this;
    const art = sheet?.querySelector('.np-art');
    if (!art || this.openTool) return;
    art.style.width = '';
    const pane = sheet.parentElement;
    if (!pane || !matchMedia('(max-width: 640px)').matches) return;
    const over = pane.scrollHeight - pane.clientHeight;
    if (over > 0) art.style.width = `${Math.max(120, Math.floor(art.offsetWidth - over))}px`;
  }

  // Read it, make it, or (the server on it) how far the server is.
  transcriptButton() {
    const item = this.player.item;
    const span = this.sheet?.querySelector('.np-transcript span');
    if (!span || !item) return;
    const job = !this.hasTranscript(item) && this.store.job?.(item.id);
    span.textContent = this.hasTranscript(item) ? 'Read the transcript' : job ? jobTag(job) : 'Make a transcript';
  }

  fill() {
    const { sheet, player } = this;
    const item = player.item;
    if (!sheet || !item) return;
    sheet.querySelector('.np-show').textContent = item.show || '';
    sheet.querySelector('.np-title').textContent = item.title || 'Episode';
    this.artInto(sheet.querySelector('.np-art'), item);
    this.transcriptButton();
    sheet.querySelector('.np-details').classList.toggle('hidden', !item.sub && !item.url);
    this.toolValue('volume', `${Math.round(player.audio.volume * 100)}%`, false);
    this.jumps();
    this.state();
    this.rate();
    this.ads();
    this.trims();
    this.sleepDraw();
    this.upNext();
    this.chapterDraw();
    this.marks();
    this.time();
    this.fit();
  }
}
