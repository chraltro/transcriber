// The podcast screens: what is new from the shows you follow, a show's page, the queue, finding
// a show, settings. What they show comes from ui/podstore.js; playing is ui/player.js.
import { h, icon, setIcon, whenText, fmtBytes, openSheet, closeSheet, sheetOpen, openMenu, notesNode } from './dom.js';
import { fmtTime, normTitle } from '../lib/text.js';
import { statusOf, fractionOf } from '../lib/podstate.js';
import { leftText, lengthText, timeIn, fmtSpeed } from '../lib/playback.js';
import { parseOpml, toOpml } from '../lib/feed.js';
import { CHOICES } from '../lib/autosave.js';

const $ = (id) => document.getElementById(id);
const PAGE = 60;
const IS_IOS = typeof navigator !== 'undefined' && (/iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
const pref = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

export class Pod {
  // deps: store, player, playerUI, downloads, artInto, toast, setTop({ crumb, context, status }),
  // onView(view), searchShows(term), showFromLink(text), transcriptOf(ep) -> 'server'|'local'|null,
  // openTranscript(ep), transcribe(ep), autosave (ui/autosave.js)
  constructor(deps) {
    Object.assign(this, deps);
    this.eps = new Map(); // every episode on screen, by id
    this.previews = new Map(); // shows looked at but not followed, by id
    this.filter = pref.get('pod-filter', 'new');
    this.inbox = null;
    this.shown = PAGE;
    this.view = '';
    try { for (const p of JSON.parse(sessionStorage.getItem('pod-previews')) || []) this.previews.set(p.id, p); } catch {}

    const { store, player, downloads } = this;
    store.addEventListener('change', (e) => this.changed(e.detail.keys || [], !!e.detail.remote));
    store.addEventListener('transcripts', (e) => {
      this.paintRows();
      const got = e.detail.arrived || [];
      if (got.length) this.toast(got.length === 1 ? `Transcript ready: ${got[0]}` : `${got.length} transcripts are ready`);
    });
    store.addEventListener('link', () => { this.status(); if (this.view === 'settings') this.settings(); if (this.view === 'home') this.home(); });
    store.addEventListener('sync', () => this.status());
    player.addEventListener('item', () => { this.paintRows(); this.counts(); if (this.view === 'queue') this.queue(); if (this.view === 'home') this.drawStarted(); });
    player.addEventListener('state', () => this.paintRows());
    downloads.addEventListener('change', () => { this.paintRows(); if (this.view === 'queue') this.queue(); if (this.view === 'settings') this.settings(); });
    downloads.addEventListener('progress', (e) => this.paintRows(e.detail));
    this.autosave.addEventListener('change', () => { if (this.view === 'settings') this.settings(); });
    window.addEventListener('hashchange', () => this.route());
    window.addEventListener('online', () => this.status());
    window.addEventListener('offline', () => this.status());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      store.syncSoon(200);
      // Back in front after a while: what is new, and which transcripts have come in.
      if (Date.now() - (this.inboxAt || 0) > 3 * 60e3) {
        store.loadTranscripts();
        if (this.view === 'home') this.loadInbox(Date.now() - (this.freshAt || 0) > 15 * 60e3);
      }
    });
    this.counts();
  }

  /* ---------- getting around ---------- */

  route() {
    const hash = location.hash || '#/';
    const link = hash.match(/^#link=([\w-]{20,100})/);
    if (link) {
      history.replaceState(history.state, '', `${location.pathname}${location.search}#/settings`);
      // After the first look at the server has settled, so the two can't cross.
      this.store.ready.then(() => this.store.link(link[1])).then(() => { this.toast('This device is linked to your library'); this.inboxStale = true; if (this.view === 'home') this.loadInbox(); }, (err) => this.toast(err.status === 401 ? 'That link is not the key to this library' : err.message));
      return this.route();
    }
    const [, name = '', arg = ''] = hash.match(/^#\/([\w-]*)\/?([\w-]*)/) || [];
    const view = name === 'transcribe' ? 'transcribe' : name === 'show' && arg ? 'show' : ['queue', 'add', 'settings'].includes(name) ? name : 'home';
    const listen = view !== 'transcribe';
    document.body.classList.toggle('view-listen', listen);
    document.body.classList.toggle('view-transcribe', !listen);
    for (const v of ['home', 'show', 'queue', 'add', 'settings']) $(`pod-${v}`).classList.toggle('hidden', v !== view);
    const nav = view === 'show' || view === 'add' || view === 'home' ? 'listen' : view;
    for (const a of document.querySelectorAll('[data-nav]')) {
      const on = a.dataset.nav === nav;
      a.classList.toggle('on', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    const changed = view !== this.view || arg !== this.arg;
    this.view = view;
    this.arg = arg;
    if (sheetOpen() && changed) closeSheet();
    this.onView(view);
    if (view === 'home') this.home();
    if (view === 'show') this.show(arg);
    if (view === 'queue') this.queue();
    if (view === 'add') this.add();
    if (view === 'settings') this.settings();
    this.status();
    if (changed) window.scrollTo(0, 0);
  }

  go(hash) {
    if (location.hash === hash) this.route(); else location.hash = hash;
  }

  // The right-hand corner of the top bar: is this library in step with the server?
  status() {
    if (this.view === 'transcribe') return;
    const { server } = this.store;
    const text = navigator.onLine === false ? 'Offline'
      : !server.there ? 'Kept in this browser'
        : server.offline ? 'Server not answering'
          : !server.claimed ? 'No library yet'
            : !server.linked ? 'Not linked to your library'
            : server.error ? 'Not in step with the server'
              : this.store.syncedAt ? `In step ${new Date(this.store.syncedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : 'Linked';
    const titles = { home: ['Listen', 'New episodes'], queue: ['Listen', 'Up next'], add: ['Listen', 'Find a show'], settings: ['Listen', 'Settings'], show: ['Listen / Show', this.showTitle || 'Show'] };
    const [crumb, context] = titles[this.view] || titles.home;
    this.setTop({ crumb, context, status: text });
  }

  counts() {
    const queued = this.store.queue.filter((e) => e.id !== this.player.item?.id).length;
    for (const el of document.querySelectorAll('[data-count="queue"]')) el.textContent = queued ? String(queued) : '';
  }

  setBusy(text) {
    for (const el of document.querySelectorAll('[data-count="busy"]')) el.textContent = text || '';
  }

  changed(keys, remote) {
    if (keys.some((k) => k.startsWith('progress/') || k.startsWith('eps/') || k.startsWith('wants/') || k === 'queue')) {
      this.paintRows();
      this.counts();
      if (this.view === 'home') this.drawStarted();
      if (this.view === 'queue' && keys.some((k) => k === 'queue' || k.startsWith('eps/'))) this.queue();
    }
    if (keys.some((k) => k.startsWith('subs/'))) {
      // What is new depends on what is followed: the list is fetched again, now or when it is next shown.
      this.inboxStale = true;
      if (this.view === 'home') { this.drawShows(); this.loadInbox(); }
      if (this.view === 'show') this.showHead();
    }
    // (Not for a switch flipped here: redrawing would take it from under the finger.)
    if (remote && keys.includes('settings') && this.view === 'settings') this.settings();
  }

  /* ---------- an episode, as a row ---------- */

  know(ep) {
    this.eps.set(ep.id, ep);
    return ep;
  }

  playOrPause(ep) {
    const { player } = this;
    if (player.item?.id === ep.id) player.toggle();
    else player.play(ep);
  }

  row(ep, { showName = true } = {}) {
    this.know(ep);
    const li = h('li.ep', { dataset: { id: ep.id } },
      h('div.art'),
      h('button.ep-main', { type: 'button', onclick: () => this.episode(this.eps.get(ep.id)) },
        h('span.ep-title', { text: ep.title }),
        h('span.ep-meta')),
      h('button.play.ep-play', { type: 'button', onclick: () => this.playOrPause(this.eps.get(ep.id)) }, icon('play')),
      h('button.icon-btn.ep-more', { type: 'button', 'aria-label': `More for ${ep.title}`, 'aria-haspopup': 'true', 'aria-expanded': 'false', onclick: (e) => this.menu(e.currentTarget, this.eps.get(ep.id)) }, icon('more')),
      h('span.ep-bar', { 'aria-hidden': 'true' }, h('span')));
    li._showName = showName;
    this.artInto(li.querySelector('.art'), ep);
    this.paintRow(li, ep);
    return li;
  }

  paintRow(li, ep) {
    const { store, player, downloads } = this;
    const prog = store.progress(ep.id);
    const status = statusOf(prog);
    const now = player.item?.id === ep.id;
    const playing = now && player.playing;
    li.className = `ep is-${status}${now ? ' now' : ''}`;
    const d = prog?.d || ep.duration || 0;
    const saving = downloads.progress(ep.id);
    const bits = [
      li._showName ? ep.show : '',
      whenText(ep.published),
      status === 'done' ? 'Played' : status === 'started' ? leftText(now ? player.time : prog.p, d) : lengthText(ep.duration),
    ].filter(Boolean);
    const meta = li.querySelector('.ep-meta');
    meta.replaceChildren(bits.join(' · '));
    if (this.transcriptOf(ep)) meta.append(h('span.tag', { text: 'Transcript' }));
    else if (store.wanted(ep.id)) meta.append(h('span.tag', { text: 'Transcript asked for' }));
    if (saving != null) meta.append(h('span.tag.hot', { text: `Saving ${Math.round(saving * 100)}%` }));
    else if (downloads.has(ep.id)) meta.append(h('span.tag', { text: 'Saved' }));
    if (store.queued(ep.id) && !now) meta.append(h('span.tag', { text: 'Queued' }));
    const play = li.querySelector('.ep-play');
    setIcon(play, playing ? 'pause' : 'play');
    play.classList.toggle('playing', playing);
    play.setAttribute('aria-label', `${playing ? 'Pause' : status === 'started' ? 'Carry on with' : 'Play'} ${ep.title}`);
    li.querySelector('.ep-bar span').style.width = `${(now && d ? Math.min(1, player.time / d) : fractionOf(prog, ep.duration)) * 100}%`;
  }

  paintRows(only = null) {
    for (const li of document.querySelectorAll(only ? `#pod .ep[data-id="${CSS.escape(only)}"]` : '#pod .ep')) {
      const ep = this.eps.get(li.dataset.id);
      if (ep) this.paintRow(li, ep);
    }
    if (sheetOpen('episode')) this.episodeActions?.();
  }

  menu(anchor, ep) {
    const { store, player, downloads } = this;
    const prog = store.progress(ep.id);
    const done = statusOf(prog) === 'done';
    const queued = store.queued(ep.id);
    const saving = downloads.progress(ep.id) != null;
    const has = this.transcriptOf(ep);
    openMenu(anchor, [
      { label: 'Play next', action: () => { store.queueAdd(ep, { next: true }); this.toast('Plays next'); } },
      queued ? { label: 'Take out of the queue', action: () => store.queueRemove(ep.id) } : { label: 'Add to the queue', action: () => { store.queueAdd(ep); this.toast('Added to the queue'); } },
      saving ? { label: 'Stop saving', action: () => downloads.cancel(ep.id) }
        : downloads.has(ep.id) ? { label: 'Remove the saved copy', hint: fmtBytes(downloads.info(ep.id).bytes), action: () => downloads.remove(ep.id) }
          : { label: 'Save for offline', action: () => this.save(ep) },
      { label: done ? 'Mark as not played' : 'Mark as played', action: () => { store.markPlayed(ep, !done); if (!done && player.item?.id !== ep.id) store.queueRemove(ep.id); } },
      ...this.transcriptChoices(ep),
      ep.sub && this.view !== 'show' && store.show(ep.sub) ? { label: 'Go to the show', action: () => this.go(`#/show/${ep.sub}`) } : null,
    ]);
  }

  feedOf(ep) {
    return this.store.doc.subs[ep.sub]?.feedUrl || this.previews.get(ep.sub)?.feedUrl || '';
  }

  // What can be done about an episode's transcript: read it; or have it made, on the server
  // (by the best model, ads marked, ready in an hour or two) or in this browser right now.
  transcriptChoices(ep) {
    const { store } = this;
    const has = this.transcriptOf(ep);
    if (has) return [{ label: 'Read the transcript', icon: 'lines', hint: has === 'server' ? 'ads marked' : '', action: () => this.openTranscript(ep) }];
    const feedUrl = this.feedOf(ep);
    return [
      store.wanted(ep.id) ? { label: 'Withdraw the transcript request', icon: 'x', action: () => { store.unwant(ep.id); this.toast('No longer asked for'); } }
        : store.server.linked && feedUrl ? { label: 'Transcribe on the server', icon: 'lines', hint: 'an hour or two', action: () => { if (store.want(ep, feedUrl)) this.toast('Asked for. It is ready in an hour or two, ads marked.'); } } : null,
      ep.url ? { label: 'Transcribe in this browser', icon: 'cpu', hint: 'now', action: () => this.transcribe(ep) } : null,
    ].filter(Boolean);
  }

  async save(ep) {
    try {
      await this.downloads.start(ep);
      if (this.downloads.has(ep.id)) this.toast('Saved for offline');
    } catch (err) {
      this.toast(`Couldn't save it: ${err.message || 'the download failed'}`);
    }
  }

  list(eps, opts) {
    return h('ul.ep-list', {}, eps.map((e) => this.row(e, opts)));
  }

  /* ---------- home ---------- */

  home() {
    const root = $('pod-home');
    if (!root.firstChild) {
      root.append(
        h('section.card.pod-card.hidden', { id: 'home-link' }),
        h('section.card.pod-card.hidden', { id: 'home-install' }),
        h('section.card.pod-card.hidden', { id: 'home-started', 'aria-labelledby': 'started-h' },
          h('div.pod-head', {}, h('div', {}, h('p.kicker', { text: 'Started, not finished' }), h('h2', { id: 'started-h', text: 'Carry on' }))),
          h('div.tiles-row', { id: 'started-list' })),
        h('section.card.pod-card', { id: 'home-shows', 'aria-labelledby': 'shows-h' },
          h('div.pod-head', {},
            h('div', {}, h('p.kicker', { id: 'shows-kicker' }), h('h2', { id: 'shows-h', text: 'Shows' })),
            h('a.btn.ghost.small', { href: '#/add', id: 'shows-add' }, icon('plus'), h('span', { text: 'Find a show' }))),
          h('div.show-grid', { id: 'show-grid' })),
        h('section.card.pod-card', { id: 'home-latest', 'aria-labelledby': 'latest-h' },
          h('div.pod-head', {},
            h('div', {}, h('p.kicker', { id: 'latest-kicker', text: 'From the shows you follow' }), h('h2', { id: 'latest-h', text: 'New episodes' })),
            h('div.pod-tools', {},
              h('fieldset.segmented', { id: 'latest-filter' }, h('legend.sr-only', { text: 'Which episodes' }),
                ...[['new', 'Not played'], ['all', 'All']].map(([v, label]) => h('label', {}, h('input', { type: 'radio', name: 'latest', value: v, checked: this.filter === v, onchange: () => { this.filter = v; pref.set('pod-filter', v); this.shown = PAGE; this.drawLatest(); } }), h('span', { text: label })))),
              h('button.icon-btn', { type: 'button', id: 'latest-refresh', 'aria-label': 'Check for new episodes', onclick: () => this.loadInbox(true) }, icon('resume')))),
          h('div', { id: 'latest-list' })));
    }
    this.drawLink();
    this.drawInstall();
    this.drawStarted();
    this.drawShows();
    if (this.inbox) this.drawLatest();
    else this.store.cachedFeed('inbox').then((cached) => { if (cached && !this.inbox) { this.inbox = cached; this.drawLatest(); } });
    if (this.inboxStale || Date.now() - (this.inboxAt || 0) > 60e3) this.loadInbox();
  }

  // In Safari on an iPhone, once: it is a better player from the home screen.
  drawInstall() {
    const box = $('home-install');
    if (!box || box.firstChild) return;
    const show = IS_IOS && !navigator.standalone && !pref.get('pod-install-seen', '');
    box.classList.toggle('hidden', !show);
    if (!show) return;
    box.append(h('div.link-form', {},
      h('div', {}, h('p.kicker', { text: 'On an iPhone' }), h('h2', { text: 'Put it on the home screen' }),
        h('p.hint', { text: 'In Safari, tap Share, then Add to Home Screen. From there it opens like an app, keeps playing with the screen locked, and what it stores is not cleared after a week away.' })),
      h('div.actions', {}, h('button.btn.ghost', { type: 'button', onclick: () => { pref.set('pod-install-seen', '1'); box.classList.add('hidden'); } }, h('span', { text: 'Got it' })))));
  }

  // On a device that isn't part of the library yet: how to join it.
  drawLink() {
    const box = $('home-link');
    if (!box) return;
    const { server } = this.store;
    const mode = !server.there || server.linked || server.offline ? '' : server.claimed ? 'link' : 'start';
    box.classList.toggle('hidden', !mode);
    if (box.dataset.mode === mode) return;
    box.dataset.mode = mode;
    box.replaceChildren();
    if (mode === 'link') box.append(this.linkForm('Your shows and positions live on the server, and this device has not joined them yet. On a device that has, open Settings and copy the link, then paste it here.'));
    if (mode === 'start') box.append(this.startForm());
  }

  // Nobody has a library on this server yet: this device can be its first.
  startForm() {
    const go = async (e) => {
      e.currentTarget.disabled = true;
      try {
        await this.store.claim();
        this.toast('The library is started. Link your other devices from Settings.');
        this.inboxStale = true;
        this.loadInbox();
      } catch (err) {
        this.toast(err.status === 409 ? 'Another device started it a moment ago. Link this one to it.' : `Couldn't start it: ${err.message}`);
        this.store.connect();
      }
    };
    return h('div.link-form', {},
      h('div', {}, h('p.kicker', { text: 'One library on every device' }), h('h2', { text: 'Start your library here' }),
        h('p.hint', { text: 'The shows you follow, how far you have listened and your queue are kept on this server, so every device you link has them. Nobody has started a library here yet. Whoever does holds its key.' })),
      h('div.actions', {}, h('button.btn.primary', { type: 'button', onclick: go }, h('span', { text: 'Start the library on this device' }))));
  }

  linkForm(text) {
    const input = h('input', { type: 'text', placeholder: 'Paste the link from a linked device', 'aria-label': 'Link from a linked device', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
    const go = async () => {
      if (!input.value.trim()) { input.focus(); return; }
      try {
        await this.store.link(input.value);
        this.toast('This device is linked to your library');
        this.inbox = null;
        this.loadInbox();
      } catch (err) {
        this.toast(err.status === 401 ? 'That is not the key to this library' : err.message);
      }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    const paste = navigator.clipboard?.readText ? h('button.paste', { type: 'button', text: 'Paste', onclick: async () => {
      try { input.value = (await navigator.clipboard.readText()).trim(); if (input.value) go(); } catch { input.focus(); this.toast('Paste the link into the field'); }
    } }) : null;
    return h('div.link-form', {},
      h('div', {}, h('p.kicker', { text: 'One library on every device' }), h('h2', { text: 'Link this device' }), h('p.hint', { text })),
      h('div.command', {}, h('div.command-field', {}, input, paste), h('button.btn.primary', { type: 'button', onclick: go, text: 'Link' })));
  }

  drawStarted() {
    const box = $('started-list');
    if (!box) return;
    const { store, player } = this;
    const list = store.started.map((e) => store.decorate(e)).filter((e) => e.url && e.id !== player.item?.id).slice(0, 6);
    $('home-started').classList.toggle('hidden', !list.length);
    box.replaceChildren(...list.map((ep) => {
      this.know(ep);
      const prog = store.progress(ep.id);
      const now = player.item?.id === ep.id;
      const playing = now && player.playing;
      const tile = h(`div.tile${now ? '.now' : ''}`, { dataset: { id: ep.id } },
        h('div.art'),
        h('button.tile-main', { type: 'button', onclick: () => this.episode(ep) },
          h('span.tile-show', { text: ep.show || '' }),
          h('span.tile-title', { text: ep.title }),
          h('span.tile-left', { text: leftText(now ? player.time : prog.p, prog.d || ep.duration) })),
        h(`button.play${playing ? '.playing' : ''}`, { type: 'button', 'aria-label': `${playing ? 'Pause' : 'Carry on with'} ${ep.title}`, onclick: () => this.playOrPause(ep) }, icon(playing ? 'pause' : 'play')),
        h('div.meter', {}, h('span', { style: `width:${fractionOf(prog, ep.duration) * 100}%` })));
      this.artInto(tile.querySelector('.art'), ep);
      return tile;
    }));
  }

  drawShows() {
    const grid = $('show-grid');
    if (!grid) return;
    const shows = this.store.shows;
    const fresh = new Map();
    for (const e of this.inbox?.episodes || []) if (statusOf(this.store.progress(e.id)) !== 'done' && Date.now() - e.published < 14 * 864e5) fresh.set(e.sub, (fresh.get(e.sub) || 0) + 1);
    $('shows-kicker').textContent = shows.length ? `${shows.length} followed` : 'None yet';
    $('shows-add').classList.toggle('hidden', !shows.length);
    grid.replaceChildren(...shows.map((s) => {
      const n = fresh.get(s.id);
      const a = h('a.show-tile', { href: `#/show/${s.id}`, 'aria-label': n ? `${s.title}, ${n} not played` : s.title },
        h('div.art'), h('span.show-name', { text: s.title }), n ? h('span.show-count', { text: String(n) }) : null);
      requestAnimationFrame(() => this.artInto(a.querySelector('.art'), { art: s.art, title: s.title, show: s.title }));
      return a;
    }));
    if (!shows.length) {
      grid.append(h('div.pod-empty', {},
        h('p', { text: 'Follow a show and its new episodes turn up here, on every device you link.' }),
        h('a.btn.primary', { href: '#/add' }, icon('search'), h('span', { text: 'Find a show' }))));
    }
  }

  drawLatest() {
    const box = $('latest-list');
    if (!box) return;
    const { store } = this;
    const all = (this.inbox?.episodes || []).filter((e) => store.show(e.sub)).map((e) => store.decorate(e));
    const eps = this.filter === 'new' ? all.filter((e) => statusOf(store.progress(e.id)) !== 'done') : all;
    const when = this.inbox?.fetchedAt ? new Date(this.inbox.fetchedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
    $('latest-kicker').textContent = this.inbox?.cached && when ? `From the shows you follow · as of ${whenText(this.inbox.fetchedAt).toLowerCase()} ${when}` : when ? `From the shows you follow · checked ${when}` : 'From the shows you follow';
    $('home-latest').classList.toggle('hidden', !store.shows.length);
    if (!eps.length) {
      box.replaceChildren(h('p.pod-none', { text: !this.inbox ? 'Looking for new episodes…' : all.length ? 'You have played everything from the last weeks.' : 'No episodes yet. The server reads a newly followed show within a minute.' }));
      return;
    }
    const more = eps.length > this.shown ? h('button.btn.ghost.more', { type: 'button', onclick: () => { this.shown += PAGE; this.drawLatest(); } }, h('span', { text: `Show ${Math.min(PAGE, eps.length - this.shown)} more` })) : null;
    box.replaceChildren(this.list(eps.slice(0, this.shown)), more || '');
  }

  async loadInbox(force = false) {
    if (this.loading) { this.loadAgain = true; return; }
    this.loading = true;
    this.inboxStale = false;
    $('latest-refresh')?.classList.add('spinning');
    try {
      // The server has to know what is followed before it can say what is new.
      if (force || this.store.meta.dirty.some((k) => k.startsWith('subs/'))) await this.store.sync();
      const got = await this.store.inbox({ fresh: force });
      this.inbox = got;
      this.inboxAt = Date.now();
      if (force) this.freshAt = Date.now();
      if (force) this.store.loadTranscripts();
    } finally {
      this.loading = false;
      $('latest-refresh')?.classList.remove('spinning');
    }
    if (this.view === 'home') { this.drawLatest(); this.drawShows(); }
    if (this.loadAgain) { this.loadAgain = false; this.loadInbox(); }
  }

  /* ---------- one show ---------- */

  remember(preview) {
    this.previews.set(preview.id, preview);
    try { sessionStorage.setItem('pod-previews', JSON.stringify([...this.previews.values()].slice(-8))); } catch {}
  }

  async show(id) {
    const root = $('pod-show');
    const sub = this.store.show(id) || this.previews.get(id);
    this.showId = id;
    this.showFeed = null;
    this.showAll = false;
    this.showQuery = '';
    this.showTitle = sub?.title || 'Show';
    this.status();
    if (!sub) {
      root.replaceChildren(h('section.card.pod-card', {}, h('div.pod-empty', {},
        h('p', { text: 'This show is not in your library.' }),
        h('a.btn.primary', { href: '#/add' }, icon('search'), h('span', { text: 'Find a show' })))));
      return;
    }
    root.replaceChildren(
      h('section.card.pod-card.show-head', { id: 'show-head' }),
      h('section.card.pod-card', {},
        h('div.pod-head', {},
          h('div', {}, h('p.kicker', { id: 'show-count', text: 'Episodes' }), h('h2', { text: 'Episodes' })),
          h('div.search-field.show-search', {}, icon('search'), h('input', { type: 'search', placeholder: 'Search this show', 'aria-label': 'Search this show', oninput: (e) => { this.showQuery = e.target.value; this.showSearch(); } }))),
        h('div', { id: 'show-list' }, h('p.pod-none', { text: 'Reading the feed…' }))));
    this.showHead();
    const cached = await this.store.cachedFeed(id);
    if (this.showId !== id) return;
    if (cached) { this.showFeed = cached; this.showList(); }
    try {
      const followed = !!this.store.show(id);
      const stale = !cached || Date.now() - (cached.fetchedAt || 0) > 10 * 60e3;
      const feed = followed ? await this.store.feed(id, { limit: 80, fresh: stale }) : await this.store.preview(sub.feedUrl, sub);
      if (this.showId !== id || !feed) return;
      // A fuller copy already on the device beats a first page from the server.
      if (!this.showFeed || feed.episodes.length >= this.showFeed.episodes.length || feed.episodes[0]?.id !== this.showFeed.episodes[0]?.id) this.showFeed = feed;
      else this.showFeed = { ...this.showFeed, total: feed.total, failed: feed.failed };
      if (!followed) this.remember({ ...sub, title: sub.title || feed.title, art: sub.art || feed.art, description: feed.description, author: feed.author, lang: feed.lang });
      this.showHead();
      this.showList();
    } catch (err) {
      if (this.showId !== id || this.showFeed) return;
      $('show-list').replaceChildren(h('p.pod-none', { text: `Couldn't read this show's feed (${err.message}).` }));
    }
  }

  showHead() {
    const box = $('show-head');
    const id = this.showId;
    if (!box || this.view !== 'show') return;
    const { store } = this;
    const followed = store.show(id);
    const sub = followed || this.previews.get(id);
    if (!sub) return;
    const feed = this.showFeed;
    const about = sub.description || feed?.description || '';
    const desc = h('p.show-about', { text: about, onclick: (e) => e.currentTarget.classList.toggle('open') });
    const art = h('div.art.show-art');
    const follow = followed
      ? h('button.btn.ghost', { type: 'button', onclick: (e) => this.showMenu(e.currentTarget) }, icon('check'), h('span', { text: 'Following' }), icon('down', 'icon chev'))
      : h('button.btn.primary', { type: 'button', onclick: () => { store.follow({ ...sub, title: sub.title || feed?.title, art: sub.art || feed?.art, lang: sub.lang || feed?.lang }); this.toast(`Following ${sub.title || 'the show'}`); this.showHead(); } }, icon('plus'), h('span', { text: 'Follow' }));
    const latest = feed?.episodes?.[0];
    box.replaceChildren(...[
      h('a.back-link', { href: '#/' }, icon('prev'), h('span', { text: 'Listen' })),
      h('div.show-top', {}, art,
        h('div.show-info', {},
          h('p.kicker', { text: [sub.author || feed?.author, followed ? `Following since ${whenText(followed.addedAt).toLowerCase()}` : 'Not followed'].filter(Boolean).join(' · ') }),
          h('h1.show-title', { text: sub.title || feed?.title || 'Show' }),
          about ? desc : null,
          h('div.actions', {}, follow,
            latest ? h('button.btn.ghost', { type: 'button', onclick: () => this.playOrPause(store.decorate(latest, id)) }, icon('play'), h('span', { text: 'Play the latest' })) : null))),
      followed && store.server.linked ? h('div.show-opts', {},
        h('label.switch.setting', {},
          h('input', { type: 'checkbox', checked: !!followed.transcribe, onchange: (e) => { store.updateShow(id, { transcribe: e.target.checked }); this.toast(e.target.checked ? 'New episodes will be transcribed' : 'New episodes are no longer transcribed'); } }),
          h('span.track', {}, h('span.knob')), h('span.switch-label', { text: 'Transcribe new episodes' })),
        h('fieldset.segmented.backfill', {}, h('legend', { text: 'And the last' }),
          ...[0, 1, 3, 5, 10].map((n) => h('label', {}, h('input', { type: 'radio', name: 'backfill', value: String(n), checked: (followed.backfill || 0) === n, onchange: () => { store.updateShow(id, { backfill: n }); this.toast(n ? `The last ${n === 1 ? 'episode' : `${n} episodes`} will be transcribed too` : 'Only what you ask for'); } }), h('span', { text: n ? String(n) : 'None' })))),
        h('p.hint', { text: 'Done on the server: new episodes an hour or two after they come out, older ones as time allows. A transcribed episode can be read along with, and its ads are marked and skipped. Any single episode can be asked for from its own page.' }),
        this.keepNewest(id),
        this.keepHint()) : null,
      followed && !store.server.linked ? h('div.show-opts', {}, this.keepNewest(id), this.keepHint()) : null,
      feed?.failed ? h('p.hint.warn', { text: `The feed didn't answer last time (${feed.failed}); this is what was read before.` }) : null,
    ].filter(Boolean));
    this.artInto(art, { art: sub.art || feed?.art, title: sub.title, show: sub.title });
    this.showTitle = sub.title || feed?.title || 'Show';
    this.status();
  }

  // How many of the show's newest episodes this device keeps saved by itself (ui/autosave.js).
  keepNewest(id) {
    const { autosave } = this;
    return h('fieldset.segmented.keep-newest', {}, h('legend', { text: 'Keep the newest saved on this device' }),
      ...CHOICES.map((n) => h('label', {}, h('input', { type: 'radio', name: 'keep-newest', value: String(n), checked: autosave.keepOf(id) === n, onchange: () => { autosave.set(id, n); this.toast(n ? `The newest ${n === 1 ? 'episode is' : `${n} episodes are`} kept on this device` : 'Episodes of this show are no longer kept by themselves'); } }), h('span', { text: n ? String(n) : 'None' }))));
  }

  keepHint() {
    // (A web app can't tell Wi-Fi from mobile data, or fetch while it is closed.)
    return h('p.hint', { text: 'Fetched while the app is open, on whatever connection the phone has. Played ones go again, unless Settings keeps them.' });
  }

  showMenu(anchor) {
    const { store } = this;
    const id = this.showId;
    const sub = store.show(id);
    if (!sub) return;
    openMenu(anchor, [
      { label: 'Mark every episode as played', action: () => { for (const e of this.showFeed?.episodes || []) if (statusOf(store.progress(e.id)) !== 'done') store.markPlayed(store.decorate(e, id), true); this.toast('All marked as played'); } },
      { label: 'Copy the feed address', action: async () => { try { await navigator.clipboard.writeText(sub.feedUrl); this.toast('Feed address copied'); } catch { this.toast(sub.feedUrl); } } },
      sub.speed ? { label: 'Use the usual speed', hint: `now ${fmtSpeed(sub.speed)}`, action: () => store.updateShow(id, { speed: undefined }) } : null,
      { label: 'Stop following', danger: true, action: () => { this.remember({ id, feedUrl: sub.feedUrl, title: sub.title, art: sub.art, appleId: sub.appleId }); store.unfollow(id); this.toast(`No longer following ${sub.title}`); this.showHead(); } },
    ]);
  }

  async showSearch() {
    // Searching means all of it: fetch the rest of the feed first.
    if (this.showQuery && this.showFeed && this.showFeed.total > this.showFeed.episodes.length) await this.showMore();
    this.showList();
  }

  async showMore() {
    const id = this.showId;
    if (!this.store.show(id)) { this.showAll = true; return; }
    try {
      const full = await this.store.feed(id);
      if (this.showId === id && full) this.showFeed = full;
    } catch {}
    this.showAll = true;
  }

  showList() {
    const box = $('show-list');
    const feed = this.showFeed;
    if (!box || !feed) return;
    const id = this.showId;
    const q = normTitle(this.showQuery || '');
    let eps = feed.episodes.map((e) => this.store.decorate(e, id));
    if (q) eps = eps.filter((e) => normTitle(`${e.title} ${e.summary || ''}`).includes(q));
    const total = feed.total || feed.episodes.length;
    $('show-count').textContent = q ? `${eps.length} of ${total} match` : `${total} episode${total === 1 ? '' : 's'}`;
    if (!eps.length) { box.replaceChildren(h('p.pod-none', { text: q ? 'No episode matches that.' : 'This feed has no episodes.' })); return; }
    const cap = this.showAll || q ? Infinity : PAGE;
    const rest = total - Math.min(eps.length, cap);
    const more = !q && rest > 0 ? h('button.btn.ghost.more', { type: 'button', onclick: async (e) => { e.currentTarget.disabled = true; await this.showMore(); this.showList(); } }, h('span', { text: `Show all ${total} episodes` })) : null;
    box.replaceChildren(this.list(eps.slice(0, cap === Infinity ? 400 : cap), { showName: false }), more || '');
  }

  /* ---------- up next, and what is saved on the device ---------- */

  queue() {
    const root = $('pod-queue');
    const { store, player, downloads } = this;
    const now = player.item;
    const eps = store.queue.filter((e) => e.id !== now?.id).map((e) => store.decorate(e));
    const total = eps.reduce((n, e) => n + (e.duration || 0), 0);
    const move = (ep, i, by) => store.queueMove(ep.id, store.doc.queue.ids.indexOf(ep.id) + by);
    const rows = eps.map((ep, i) => {
      const li = this.row(ep);
      li.classList.add('queued');
      li.querySelector('.ep-more').before(h('span.ep-order', {},
        h('button.icon-btn.tiny', { type: 'button', 'aria-label': `Move ${ep.title} up`, disabled: i === 0, onclick: () => move(ep, i, -1) }, icon('up')),
        h('button.icon-btn.tiny', { type: 'button', 'aria-label': `Move ${ep.title} down`, disabled: i === eps.length - 1, onclick: () => move(ep, i, 1) }, icon('down')),
        h('button.icon-btn.tiny', { type: 'button', 'aria-label': `Take ${ep.title} out of the queue`, onclick: () => store.queueRemove(ep.id) }, icon('x'))));
      return li;
    });
    const saved = downloads.ids.map((id) => downloads.info(id).ep).filter(Boolean).map((e) => store.decorate(e));
    root.replaceChildren(
      h('section.card.pod-card', {},
        h('div.pod-head', {},
          h('div', {}, h('p.kicker', { text: eps.length ? `${eps.length} episode${eps.length === 1 ? '' : 's'}${total ? ` · ${lengthText(total)}` : ''}` : 'Plays one after the other' }), h('h2', { text: 'Up next' })),
          eps.length ? h('button.btn.ghost.small', { type: 'button', onclick: () => store.queueClear() }, h('span', { text: 'Clear' })) : null),
        now ? h('div.queue-now', {}, h('p.kicker', { text: player.playing ? 'Playing' : 'In the player' }), h('ul.ep-list', {}, this.row(store.decorate(now)))) : null,
        eps.length ? h('ol.ep-list', {}, rows) : h('p.pod-none', { text: 'Nothing queued. Use Play next or Add to the queue on any episode, and it plays when this one ends.' })),
      h('section.card.pod-card', {},
        h('div.pod-head', {},
          h('div', {}, h('p.kicker', { text: saved.length ? `On this device · ${fmtBytes(downloads.bytes)}` : 'On this device' }), h('h2', { text: 'Saved for offline' }))),
        saved.length ? this.list(saved) : h('p.pod-none', { text: 'Nothing saved. Save an episode before a flight or a tunnel and it plays without a connection.' })));
  }

  /* ---------- finding a show ---------- */

  add() {
    const root = $('pod-add');
    if (root.firstChild) { if (!matchMedia('(hover: none)').matches) root.querySelector('input[type=search]')?.focus({ preventScroll: true }); return; }
    const results = h('ul.found-list', { id: 'found-list' });
    const note = h('p.pod-none', { id: 'found-note', text: 'Type a show\'s name, or paste its Apple Podcasts link or feed address.' });
    let timer = 0;
    let seq = 0;
    const search = async (text) => {
      const q = text.trim();
      const mine = ++seq;
      if (q.length < 2) { results.replaceChildren(); note.textContent = 'Type a show\'s name, or paste its Apple Podcasts link or feed address.'; note.classList.remove('hidden'); return; }
      note.textContent = 'Searching…';
      note.classList.remove('hidden');
      let found = [];
      try {
        if (/^https?:\/\/|^[\w-]+(\.[\w-]+)+\//i.test(q)) {
          const one = await this.showFromLink(q);
          if (one) found = [one];
        } else found = await this.searchShows(q);
      } catch {}
      if (mine !== seq) return;
      note.classList.toggle('hidden', found.length > 0);
      note.textContent = /^https?:\/\//i.test(q) ? 'No podcast feed at that address. Try the show\'s name.' : `Nothing called "${q}" in Apple's directory.`;
      results.replaceChildren(...found.map((s) => this.found(s)));
    };
    const input = h('input', { type: 'search', placeholder: 'Show name, Apple Podcasts link or feed address', 'aria-label': 'Find a show', enterkeyhint: 'search', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
      oninput: (e) => { clearTimeout(timer); const v = e.target.value; timer = setTimeout(() => search(v), 350); },
      onkeydown: (e) => { if (e.key === 'Enter') { clearTimeout(timer); search(e.target.value); e.target.blur(); } } });
    const file = h('input', { type: 'file', accept: '.opml,.xml,text/xml,text/x-opml,application/xml', onchange: async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const feeds = parseOpml(await f.text());
      if (!feeds.length) { this.toast('No shows in that file'); return; }
      const had = new Set(this.store.shows.map((s) => s.feedUrl));
      for (const s of feeds) if (!had.has(s.feedUrl)) this.store.follow(s);
      this.toast(`Following ${feeds.length} show${feeds.length === 1 ? '' : 's'} from the file`);
      this.go('#/');
    } });
    root.append(h('section.card.pod-card', {},
      h('a.back-link', { href: '#/' }, icon('prev'), h('span', { text: 'Listen' })),
      h('div.pod-head', {}, h('div', {}, h('p.kicker', { text: 'From Apple\'s podcast directory, or any feed' }), h('h2', { text: 'Find a show' }))),
      h('div.search-field.big', {}, icon('search'), input),
      note, results,
      h('p.under', {}, 'Coming from another podcast app? ', h('label.file-pick', {}, 'Import its OPML file', file), '.')));
    if (!matchMedia('(hover: none)').matches) input.focus({ preventScroll: true });
  }

  found(s) {
    const id = s.id;
    const following = !!this.store.show(id);
    const open = () => { if (!this.store.show(id)) this.remember(s); this.go(`#/show/${id}`); };
    const btn = following
      ? h('span.tag', { text: 'Following' })
      : h('button.btn.ghost.small', { type: 'button', onclick: (e) => { this.store.follow(s); this.toast(`Following ${s.title}`); e.currentTarget.replaceWith(h('span.tag', { text: 'Following' })); } }, icon('plus'), h('span', { text: 'Follow' }));
    const li = h('li.found', {},
      h('div.art'),
      h('button.ep-main', { type: 'button', onclick: open }, h('span.ep-title', { text: s.title }), h('span.ep-meta', { text: [s.author, s.genre].filter(Boolean).join(' · ') })),
      btn);
    this.artInto(li.querySelector('.art'), { art: s.art, title: s.title, show: s.title });
    return li;
  }

  /* ---------- an episode, in full ---------- */

  async episode(ep) {
    if (!ep) return;
    const { store, player, downloads } = this;
    this.know(ep);
    const actions = h('div.actions.sheet-actions');
    const notes = h('div.notes-box', {}, h('p.pod-none', { text: ep.summary || '' }));
    const draw = () => {
      const prog = store.progress(ep.id);
      const status = statusOf(prog);
      const now = player.item?.id === ep.id;
      const playing = now && player.playing;
      const saving = downloads.progress(ep.id);
      const d = prog?.d || ep.duration || 0;
      sheet.querySelector('.sheet-meta').textContent = [whenText(ep.published), lengthText(ep.duration), status === 'done' ? 'Played' : status === 'started' ? leftText(now ? player.time : prog.p, d) : ''].filter(Boolean).join(' · ');
      actions.replaceChildren(...[
        h('button.btn.primary', { type: 'button', onclick: () => this.playOrPause(ep) }, icon(playing ? 'pause' : 'play'), h('span', { text: playing ? 'Pause' : status === 'started' ? 'Carry on' : status === 'done' ? 'Play again' : 'Play' })),
        store.queued(ep.id) && !now
          ? h('button.btn.ghost', { type: 'button', onclick: () => store.queueRemove(ep.id) }, icon('check'), h('span', { text: 'Queued' }))
          : now ? null : h('button.btn.ghost', { type: 'button', onclick: () => store.queueAdd(ep) }, icon('queue'), h('span', { text: 'Add to the queue' })),
        saving != null
          ? h('button.btn.ghost', { type: 'button', onclick: () => downloads.cancel(ep.id) }, icon('x'), h('span', { text: `Saving ${Math.round(saving * 100)}%` }))
          : downloads.has(ep.id)
            ? h('button.btn.ghost', { type: 'button', onclick: () => downloads.remove(ep.id) }, icon('saved'), h('span', { text: 'Saved' }))
            : h('button.btn.ghost', { type: 'button', onclick: () => this.save(ep) }, icon('download'), h('span', { text: 'Save for offline' })),
        now || (store.queue[0]?.id === ep.id) ? null : h('button.btn.ghost', { type: 'button', onclick: () => { store.queueAdd(ep, { next: true }); this.toast('Plays next'); } }, icon('skip'), h('span', { text: 'Play next' })),
        h('button.btn.ghost', { type: 'button', onclick: () => store.markPlayed(ep, status !== 'done') }, icon(status === 'done' ? 'resume' : 'check'), h('span', { text: status === 'done' ? 'Mark as not played' : 'Mark as played' })),
        ...this.transcriptChoices(ep).map((c) => h('button.btn.ghost.wide', { type: 'button', onclick: () => { if (/Read|browser/.test(c.label)) closeSheet(); c.action(); } }, icon(c.icon), h('span', { text: c.label }), c.hint ? h('small', { text: c.hint }) : null)),
      ].filter(Boolean));
    };
    const art = h('div.art.sheet-art');
    const sheet = h('div.ep-sheet', {},
      h('div.sheet-top', {},
        ep.sub && store.show(ep.sub) ? h('a.kicker.sheet-show', { href: `#/show/${ep.sub}`, text: ep.show || 'Show' }) : h('p.kicker', { text: ep.show || 'Episode' }),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: () => closeSheet() }, icon('x'))),
      h('div.sheet-head', {}, art, h('div', {}, h('h2', { id: 'sheet-title', text: ep.title }), h('p.sheet-meta'))),
      actions, notes,
      ep.link && /^https?:/.test(ep.link) ? h('a.ext', { href: ep.link, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), h('span', { text: 'The episode\'s own page' })) : null);
    this.artInto(art, ep);
    this.episodeActions = draw;
    openSheet(sheet, { name: 'episode', closed: () => { this.episodeActions = null; } });
    draw();
    const html = await store.notes(ep.sub, ep.id).catch(() => '');
    if (!sheet.isConnected) return;
    if (html) notes.replaceChildren(notesNode(html, { timeOf: timeIn, onTime: (t) => player.play(ep, { at: t }) }));
  }

  /* ---------- settings ---------- */

  // The storage card's line on what is kept by itself, and the way to stop it.
  keptNote() {
    const { autosave } = this;
    const k = autosave.summary();
    if (!k.shows.length && !k.count) return null;
    const parts = k.shows.map((s) => `${s.keep} of ${s.title}`);
    const which = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] || '';
    const text = [
      which ? `Kept by themselves: the newest ${which}.` : '',
      k.count ? `${k.count} episode${k.count === 1 ? '' : 's'} saved that way, ${fmtBytes(k.bytes)}.` : '',
      k.short ? 'Stopped for now: this device is short of space. It carries on once there is room again.' : k.saveData && which ? 'Waiting while the phone saves data.' : '',
    ].filter(Boolean).join(' ');
    return [
      h('p.hint.kept-note', { text }),
      which ? h('div.actions', {}, h('button.btn.ghost.small', { type: 'button', onclick: () => { autosave.stop(); this.toast('No show keeps episodes by themselves now'); } }, icon('x'), h('span', { text: 'Stop keeping episodes by themselves' }))) : null,
    ];
  }

  settings() {
    const root = $('pod-settings');
    const { store, downloads } = this;
    const s = store.settings;
    const pick = (legend, name, options, value, set) => h('fieldset.segmented', {}, h('legend', { text: legend }),
      ...options.map(([v, label]) => h('label', {}, h('input', { type: 'radio', name, value: String(v), checked: value === v, onchange: () => set(v) }), h('span', { text: label }))));
    const flip = (label, on, set, hint) => h('div.setting-row', {},
      h('label.switch.setting', {}, h('input', { type: 'checkbox', checked: !!on, onchange: (e) => set(e.target.checked) }), h('span.track', {}, h('span.knob')), h('span.switch-label', { text: label })),
      hint ? h('p.hint', { text: hint }) : null);

    const playback = h('section.card.pod-card', {},
      h('div.pod-head', {}, h('div', {}, h('p.kicker', { text: 'The same on every linked device' }), h('h2', { text: 'Playback' }))),
      h('div.settings-body', {},
        pick('Back', 'back', [[10, '10 s'], [15, '15 s'], [30, '30 s']], s.back, (v) => store.set({ back: v })),
        pick('Forward', 'fwd', [[15, '15 s'], [30, '30 s'], [45, '45 s'], [60, '60 s']], s.fwd, (v) => store.set({ fwd: v })),
        pick('Lock screen', 'lock', [['skip', 'Back and forward'], ['episodes', 'Previous and next']], s.lockButtons || 'skip', (v) => store.set({ lockButtons: v })),
        h('p.hint', { text: 'What the buttons beside play do on the lock screen, in the car and on headphones. An iPhone shows one pair or the other.' }),
        flip('Skip ads', s.skipAds, (v) => store.set({ skipAds: v }), 'Where an episode has a transcript, the sponsor reads in it are jumped over as they come up, with an undo each time.'),
        pick('Shorten pauses', 'trim', [[0, 'Off'], [0.5, 'Over 0.5 s'], [0.8, 'Over 0.8 s'], [1.2, 'Over 1.2 s'], [2, 'Over 2 s']], s.trim || 0, (v) => store.set({ trim: v })),
        h('p.hint', { text: 'Pauses longer than this are cut down to it: the dead air of a call\'s delay goes, the pauses people make on purpose stay. It works for episodes the server has transcribed and for episodes saved on this device.' }),
        flip('Go back a little after a pause', s.rewind, (v) => store.set({ rewind: v }), 'A few seconds after minutes away, up to 25 after a day.'),
        flip('Keep saved episodes once played', s.keepDownloads, (v) => store.set({ keepDownloads: v }))));

    const library = h('section.card.pod-card', { id: 'settings-library' },
      h('div.pod-head', {}, h('div', {}, h('p.kicker', { text: 'Shows, positions and the queue' }), h('h2', { text: 'Your library' }))));
    const { server } = store;
    if (!server.there) {
      library.append(h('p.hint', { text: 'This copy of the app has no server behind it, so what you follow and how far you have listened stay in this browser. Export your shows below to take them elsewhere.' }));
    } else if (server.offline) {
      library.append(h('p.hint', { text: 'The server is not answering right now. What you do here is kept and sent when it is back.' }));
    } else if (!server.claimed) {
      library.append(this.startForm());
    } else if (!server.linked) {
      library.append(this.linkForm('This device has not joined your library. On a device that has, open Settings, copy the link under "Link another device" and paste it here.'));
    } else {
      const qr = h('div.qr', { 'aria-hidden': 'true' });
      const url = store.linkUrl;
      import('../lib/vendor/qrcode.mjs').then(({ default: qrcode }) => {
        const q = qrcode(0, 'M');
        q.addData(url);
        q.make();
        const n = q.getModuleCount();
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', `-4 -4 ${n + 8} ${n + 8}`); // the four quiet modules readers expect
        svg.setAttribute('shape-rendering', 'crispEdges');
        let d = '';
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
        const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        for (const [k, v] of [['x', -4], ['y', -4], ['width', n + 8], ['height', n + 8], ['fill', '#fff']]) bg.setAttribute(k, v);
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        path.setAttribute('fill', '#000');
        svg.append(bg, path);
        qr.replaceChildren(svg);
      }).catch(() => {});
      library.append(
        h('p.hint', { id: 'sync-state', text: store.server.error ? `Linked, but the last exchange with the server failed (${store.server.error}).` : `Linked. ${store.shows.length} show${store.shows.length === 1 ? '' : 's'}, in step with the server${store.syncedAt ? ` since ${new Date(store.syncedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''}.` }),
        h('div.link-box', {}, qr,
          h('div', {},
            h('h3', { text: 'Link another device' }),
            h('p.hint', { text: 'Point the phone\'s camera at the code, or send yourself the link. Whoever opens it has your library, so keep it to yourself. In a web app on the home screen, paste the link under Settings there.' }),
            h('div.actions', {},
              h('button.btn.ghost.small', { type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(url); this.toast('Link copied'); } catch { this.toast('Copying is not allowed here'); } } }, icon('copy'), h('span', { text: 'Copy the link' })),
              navigator.share ? h('button.btn.ghost.small', { type: 'button', onclick: () => navigator.share({ title: 'Transcriber', url }).catch(() => {}) }, icon('share'), h('span', { text: 'Send it' })) : null,
              h('button.btn.ghost.small', { type: 'button', onclick: async () => { await store.unlink(); this.toast('This device is no longer linked'); } }, h('span', { text: 'Unlink this device' }))))));
    }

    const storage = h('section.card.pod-card', {},
      h('div.pod-head', {}, h('div', {}, h('p.kicker', { text: 'On this device' }), h('h2', { text: 'Saved for offline' }))),
      h('p.hint', { text: downloads.ids.length ? `${downloads.ids.length} episode${downloads.ids.length === 1 ? '' : 's'}, ${fmtBytes(downloads.bytes)}. They are listed under Up next.` : 'No episodes are saved on this device.' }),
      downloads.ids.length ? h('div.actions', {}, h('button.btn.ghost.small', { type: 'button', onclick: async () => { await downloads.clear(); this.toast('Saved episodes removed'); } }, icon('trash'), h('span', { text: 'Remove them all' }))) : null,
      this.keptNote());

    const file = h('input', { type: 'file', accept: '.opml,.xml,text/xml,text/x-opml,application/xml', onchange: async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const feeds = parseOpml(await f.text());
      const had = new Set(store.shows.map((x) => x.feedUrl));
      for (const x of feeds) if (!had.has(x.feedUrl)) store.follow(x);
      this.toast(feeds.length ? `Following ${feeds.length} show${feeds.length === 1 ? '' : 's'} from the file` : 'No shows in that file');
    } });
    const shows = h('section.card.pod-card', {},
      h('div.pod-head', {}, h('div', {}, h('p.kicker', { text: 'OPML, the file every podcast app reads' }), h('h2', { text: 'Move your shows' }))),
      h('div.actions', {},
        h('label.btn.ghost.small.file-pick', {}, icon('upload'), h('span', { text: 'Import a file' }), file),
        store.shows.length ? h('button.btn.ghost.small', { type: 'button', onclick: () => {
          const a = h('a', { href: URL.createObjectURL(new Blob([toOpml(store.shows, 'Transcriber shows')], { type: 'text/x-opml' })), download: 'shows.opml' });
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        } }, icon('download'), h('span', { text: `Export ${store.shows.length} show${store.shows.length === 1 ? '' : 's'}` })) : null));

    const install = IS_IOS && !navigator.standalone ? h('section.card.pod-card', {},
      h('div.pod-head', {}, h('div', {}, h('p.kicker', { text: 'iPhone and iPad' }), h('h2', { text: 'Put it on the home screen' }))),
      h('p.hint', { text: 'In Safari, tap Share, then Add to Home Screen. It then opens like an app, keeps playing with the screen locked, and what it stores is not cleared after a week away. Link it once more from inside the app if it starts out empty.' })) : null;

    root.replaceChildren(...[playback, library, storage, shows, install].filter(Boolean));
  }
}
