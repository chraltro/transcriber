// What the player looks like: the bar along the bottom, and the sheet it opens into (cover,
// chapter, position, speed, sleep timer, ads, what is up next). The playing itself is ui/player.js.
import { h, icon, setIcon, openSheet, closeSheet, sheetOpen } from './dom.js';
import { fmtTime } from '../lib/text.js';
import { leftText, fmtSpeed, nextSpeed, SPEEDS } from '../lib/playback.js';
import { adSeconds } from '../lib/breaks.js';
import { cutSeconds } from '../lib/quiet.js';

const $ = (id) => document.getElementById(id);
const IS_IOS = typeof navigator !== 'undefined' && (/iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

// The position slider, with the ads drawn on its track as bands and the chapters as thin ticks
// across it. While it is dragged the clock follows the thumb and the audio stays where it is;
// letting go moves the audio.
function scrubber(root, player, onPreview) {
  const input = root.querySelector('input');
  const ads = root.querySelector('.scrub-marks');
  let dragging = false;
  let drawn = '';
  const paint = () => input.style.setProperty('--pct', `${(Number(input.value) / 1000) * 100}%`);
  input.addEventListener('input', () => {
    dragging = true;
    paint();
    onPreview?.((Number(input.value) / 1000) * player.duration);
  });
  const commit = () => {
    if (!dragging) return;
    dragging = false;
    player.seek((Number(input.value) / 1000) * player.duration, { user: true });
  };
  input.addEventListener('change', commit);
  input.addEventListener('pointerup', commit);
  input.addEventListener('keydown', (e) => {
    const s = player.store.settings;
    if (e.key === 'ArrowLeft') { e.preventDefault(); player.skip(-(e.shiftKey ? 60 : s.back)); }
    if (e.key === 'ArrowRight') { e.preventDefault(); player.skip(e.shiftKey ? 60 : s.fwd); }
  });
  return {
    get dragging() { return dragging; },
    draw() {
      const d = player.duration;
      input.disabled = !(d > 0);
      if (!dragging) { input.value = d > 0 ? String(Math.round((player.time / d) * 1000)) : '0'; paint(); }
      input.setAttribute('aria-valuetext', d > 0 ? `${fmtTime(player.time)} of ${fmtTime(d)}` : '');
      const starts = d > 0 ? player.chapters.map((c) => c.start).filter((t) => t > 0 && t < d) : [];
      const key = d > 0 && (player.breaks || starts.length) ? `${d}|${player.breaks?.join(';') || ''}|${starts.join(',')}` : '';
      if (key === drawn) return;
      drawn = key;
      ads.replaceChildren(...(key && player.breaks ? player.breaks.map(([a, b]) => {
        const band = document.createElement('i');
        band.style.left = `${(a / d) * 100}%`;
        band.style.width = `${Math.max(0.4, ((Math.min(b, d) - a) / d) * 100)}%`;
        return band;
      }) : []), ...(key ? starts.map((t) => h('span.scrub-chapter', { style: `left: ${(t / d) * 100}%` })) : []));
    },
  };
}

export class PlayerUI {
  // artInto(box, { art, title, show }): the app's cover art (app.js); toast(text, action);
  // openTranscript(item), openEpisode(item): what the sheet's buttons do.
  // saveOffline(item): keeps the episode on the device (its pauses can then be found).
  constructor({ player, store, artInto, toast, openTranscript, hasTranscript, openEpisode, saveOffline, isSaved, isSaving }) {
    Object.assign(this, { player, store, artInto, toast, openTranscript, hasTranscript, openEpisode, saveOffline, isSaved, isSaving });
    this.bar = $('playbar');
    this.scrub = scrubber($('pb-scrub'), player, (t) => { $('pb-cur').textContent = fmtTime(t); });
    this.sheet = null;

    $('pb-play').addEventListener('click', () => player.toggle());
    $('pb-back').addEventListener('click', () => player.skip(-store.settings.back));
    $('pb-fwd').addEventListener('click', () => player.skip(store.settings.fwd));
    $('pb-open').addEventListener('click', () => this.open());
    $('pb-speed').addEventListener('click', () => player.setSpeed(nextSpeed(player.rateFor())));
    $('pb-jump').addEventListener('click', () => player.skipAd());

    player.addEventListener('item', () => { this.item(); this.time(); this.state(); });
    player.addEventListener('state', () => this.state());
    player.addEventListener('time', () => this.time());
    player.addEventListener('rate', () => this.rate());
    player.addEventListener('ads', () => { this.ads(); this.time(); });
    player.addEventListener('quiet', () => this.trims());
    player.addEventListener('chapters', () => { this.chapterDraw(); this.time(); });
    player.addEventListener('chapter', () => this.chapterDraw());
    player.addEventListener('sleep', (e) => { this.sleepDraw(); if (e.detail.fired) toast('Sleep timer: paused'); });
    player.addEventListener('skipped', (e) => toast(`Skipped ${fmtTime(e.detail.seconds)} of ads`, { label: 'Undo', run: () => player.undoSkip() }));
    player.addEventListener('blocked', () => toast('Tap play once more to start'));
    player.addEventListener('error', (e) => toast(e.detail.message));
    store.addEventListener('change', (e) => {
      const keys = e.detail.keys || [];
      if (keys.includes('settings') || keys.some((k) => k.startsWith('subs/'))) { this.rate(); this.jumps(); this.trims(); }
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
      setIcon(b, playing ? 'pause' : 'play');
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
    if (!this.sheetScrub.dragging) this.sheet.querySelector('.np-cur').textContent = fmtTime(t);
    this.sheet.querySelector('.np-left').textContent = leftText(t, d, player.rate);
  }

  rate() {
    const r = this.player.rateFor();
    $('pb-speed').textContent = fmtSpeed(r);
    $('pb-speed').classList.toggle('on', Math.abs(r - 1) > 0.001);
    if (!this.sheet) return;
    this.sheet.querySelector('.np-rate').textContent = fmtSpeed(r);
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
    for (const b of this.sheet.querySelectorAll('.np-trims button')) b.setAttribute('aria-pressed', String(Number(b.dataset.trim) === limit));
    const state = this.sheet.querySelector('.np-trim-state');
    const note = this.sheet.querySelector('.np-trim-note');
    const save = this.sheet.querySelector('.np-trim-save');
    this.shownTrim = player.trimmed;
    state.dataset.saved = player.trimmed.toFixed(2);
    const over = `${limit} s`;
    state.textContent = !limit ? 'Off' : player.trimmed >= 1 ? `${fmtTime(player.trimmed)} saved` : `over ${over}`;
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

  // The chapter being played, under the episode's title, with buttons to the one before and after.
  chapterDraw() {
    const row = this.sheet?.querySelector('.np-chapter');
    if (!row) return;
    const { player } = this;
    const n = player.chapterCount;
    row.classList.toggle('hidden', !n);
    if (!n) return;
    const i = player.chapter;
    const title = row.querySelector('.np-chapter-title');
    title.textContent = i >= 0 ? player.chapters[i].title : 'Before the first chapter';
    title.dataset.index = String(i);
    row.querySelector('.np-chapter-count').textContent = i >= 0 ? `Chapter ${i + 1} of ${n}` : `${n} chapters`;
    row.querySelector('.np-chapter-next').disabled = i + 1 >= n;
  }

  sleepDraw() {
    if (!this.sheet) return;
    const { sleep } = this.player;
    const left = this.player.sleepLeft;
    this.sheet.querySelector('.np-sleep-state').textContent = !sleep ? 'Off' : sleep.end ? 'When this episode ends' : `Pauses in ${fmtTime(left)}`;
    for (const b of this.sheet.querySelectorAll('.np-sleeps button')) {
      const v = b.dataset.sleep;
      b.setAttribute('aria-pressed', String(v === 'end' ? !!sleep?.end : v === '0' ? !sleep : sleep?.minutes === Number(v)));
    }
  }

  upNext() {
    const list = this.sheet?.querySelector('.np-next');
    if (!list) return;
    const next = this.store.queue.filter((e) => e.id !== this.player.item?.id).slice(0, 3);
    list.replaceChildren(...(next.length ? next.map((e) => h('li', {}, h('span.np-next-title', { text: e.title }), h('span.np-next-show', { text: e.show || '' }))) : [h('li.empty', { text: 'Nothing queued. This episode is the last.' })]));
    this.sheet.querySelector('.np-next-all').classList.toggle('hidden', !next.length);
  }

  /* ---------- the sheet ---------- */

  open() {
    const { player, store } = this;
    if (!player.item) return;
    const jump = (cls, name, fn) => h(`button.icon-btn.jump-btn.${cls}`, { type: 'button', onclick: fn }, icon(name), h('b'));
    const seg = (cls, items) => h(`div.mini-seg.${cls}`, {}, items);
    const sheet = h('div.np', {},
      h('div.sheet-top', {},
        h('p.kicker', { text: 'Now playing' }),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Close the player', onclick: () => closeSheet() }, icon('down'))),
      h('div.art.np-art'),
      h('p.eyebrow.np-show'),
      h('h2.np-title', { id: 'sheet-title' }),
      h('div.np-chapter.hidden', {},
        h('button.icon-btn.np-chapter-prev', { type: 'button', 'aria-label': 'Previous chapter', onclick: () => player.prevChapter() }, icon('prev')),
        h('p', { 'aria-live': 'polite' }, h('span.np-chapter-count'), h('span.np-chapter-title')),
        h('button.icon-btn.np-chapter-next', { type: 'button', 'aria-label': 'Next chapter', onclick: () => player.nextChapter() }, icon('next'))),
      h('div.scrub.np-scrub', {}, h('div.scrub-marks', { 'aria-hidden': 'true' }), h('input', { type: 'range', min: '0', max: '1000', value: '0', step: '1', 'aria-label': 'Position in the episode' })),
      h('div.np-clock', {}, h('span.np-cur', { text: '0:00' }), h('span.np-left')),
      h('div.np-transport', {},
        jump('jump-back', 'back', () => player.skip(-store.settings.back)),
        h('button.play.np-play', { type: 'button', 'aria-label': 'Play', onclick: () => player.toggle() }, icon('play')),
        jump('jump-fwd', 'fwd', () => player.skip(store.settings.fwd))),
      h('button.btn.primary.np-jump.hidden', { type: 'button', onclick: () => player.skipAd() }, icon('skip'), h('span', { text: 'Skip this ad' })),

      h('div.np-block', {},
        h('div.np-head', {}, h('h3', { text: 'Speed' }), h('b.np-rate')),
        h('div.np-speeds', {},
          h('button.icon-btn', { type: 'button', 'aria-label': 'Slower', onclick: () => player.setSpeed(player.rateFor() - 0.1) }, h('span.sign', { text: '−' })),
          seg('', SPEEDS.filter((s) => s <= 2.5).map((s) => h('button', { type: 'button', dataset: { rate: String(s) }, 'aria-pressed': 'false', text: fmtSpeed(s), onclick: () => player.setSpeed(s) }))),
          h('button.icon-btn', { type: 'button', 'aria-label': 'Faster', onclick: () => player.setSpeed(player.rateFor() + 0.1) }, h('span.sign', { text: '+' }))),
        store.show(player.item.sub) ? h('label.switch.setting.np-own', {},
          h('input', { type: 'checkbox', onchange: (e) => { store.updateShow(player.item.sub, { speed: e.target.checked ? player.rateFor() : undefined }); player.applyRate(); this.rate(); } }),
          h('span.track', {}, h('span.knob')), h('span.switch-label', { text: 'Its own speed for this show' })) : null),

      h('div.np-block', {},
        h('div.np-head', {}, h('h3', { text: 'Sleep timer' }), h('b.np-sleep-state')),
        seg('np-sleeps', [['Off', '0'], ['15 min', '15'], ['30 min', '30'], ['45 min', '45'], ['1 h', '60'], ['End of episode', 'end']].map(([label, v]) =>
          h('button', { type: 'button', dataset: { sleep: v }, 'aria-pressed': 'false', text: label, onclick: () => { player.setSleep(v === 'end' ? 'end' : Number(v)); this.sleepDraw(); } })))),

      h('div.np-block', {},
        h('div.np-head', {}, h('h3', { text: 'Shorten pauses' }), h('b.np-trim-state')),
        seg('np-trims', [['Off', 0], ['0.5 s', 0.5], ['0.8 s', 0.8], ['1.2 s', 1.2], ['2 s', 2]].map(([label, v]) =>
          h('button', { type: 'button', dataset: { trim: String(v) }, 'aria-pressed': 'false', text: label, onclick: () => { store.set({ trim: v }); this.trims(); } }))),
        h('p.hint.np-trim-note'),
        h('button.btn.ghost.small.np-trim-save.hidden', { type: 'button', onclick: () => { this.saveOffline(player.item); this.trims(); } }, icon('download'), h('span', { text: 'Save the episode on this device' }))),

      h('div.np-block', {},
        h('label.switch.setting.np-skips', {},
          h('input', { type: 'checkbox', onchange: (e) => store.set({ skipAds: e.target.checked }) }),
          h('span.track', {}, h('span.knob')), h('span.switch-label', { text: 'Skip ads' })),
        h('p.hint.np-skips-note')),

      IS_IOS ? null : h('div.np-block.np-volume', {},
        icon('volume'),
        (() => {
          const v = h('input', { type: 'range', min: '0', max: '100', step: '1', value: String(Math.round(player.audio.volume * 100)), 'aria-label': 'Volume' });
          const paint = () => v.style.setProperty('--pct', `${v.value}%`);
          v.addEventListener('input', () => { player.setVolume(Number(v.value) / 100); paint(); });
          paint();
          return v;
        })()),

      h('div.np-block', {},
        h('div.np-head', {}, h('h3', { text: 'Up next' }), h('a.np-next-all', { href: '#/queue', text: 'Open the queue', onclick: () => closeSheet() })),
        h('ol.np-next')),

      h('div.np-actions', {},
        h('button.btn.ghost.np-transcript', { type: 'button', onclick: () => { const it = player.item; closeSheet(); this.openTranscript(it); } }, icon('lines'), h('span')),
        h('button.btn.ghost.np-details', { type: 'button', onclick: () => this.openEpisode(player.item) }, icon('alert'), h('span', { text: 'Episode notes' })),
        h('button.btn.ghost', { type: 'button', onclick: () => { closeSheet(); player.stop(); } }, icon('x'), h('span', { text: 'Take it out of the player' }))));
    this.sheet = sheet;
    this.sheetScrub = scrubber(sheet.querySelector('.np-scrub'), player, (t) => { sheet.querySelector('.np-cur').textContent = fmtTime(t); });
    openSheet(sheet, { name: 'player', closed: () => { this.sheet = null; this.sheetScrub = null; } });
    this.fill();
  }

  fill() {
    const { sheet, player } = this;
    const item = player.item;
    if (!sheet || !item) return;
    sheet.querySelector('.np-show').textContent = item.show || '';
    sheet.querySelector('.np-title').textContent = item.title || 'Episode';
    this.artInto(sheet.querySelector('.np-art'), item);
    sheet.querySelector('.np-transcript span').textContent = this.hasTranscript(item) ? 'Read the transcript' : 'Make a transcript';
    sheet.querySelector('.np-details').classList.toggle('hidden', !item.sub && !item.url);
    this.jumps();
    this.state();
    this.rate();
    this.ads();
    this.trims();
    this.sleepDraw();
    this.upNext();
    this.chapterDraw();
    this.time();
  }
}
