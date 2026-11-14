// Search across every transcript in the library (#/search): where was something said, asked
// of the server (server/search.mjs) as it is typed, and a tap plays the episode from that
// sentence. Only where there is a server and this device is linked to the library: a static
// copy of the app has no transcripts to search.
import { h, icon, sheetOpen } from './dom.js';
import { fmtTime } from '../lib/text.js';

const $ = (id) => document.getElementById(id);
const WAIT = 250; // after the last key, before asking
const BEFORE = 2; // seconds of lead-in before the sentence
const LONG = 260; // characters of a hit shown around its words
const KEY = 'pod-search';

// The part of a long hit around its first matched word, with the marks moved to fit.
export function excerpt(text, marks, max = LONG) {
  if (text.length <= max) return { text, marks };
  let from = Math.max(0, (marks[0]?.[0] || 0) - Math.round(max / 3));
  if (from) from = text.indexOf(' ', from) + 1 || from;
  let to = Math.min(text.length, from + max);
  if (to < text.length) to = text.lastIndexOf(' ', to) > from ? text.lastIndexOf(' ', to) : to;
  const kept = marks.filter(([a, b]) => a >= from && b <= to).map(([a, b]) => [a - from + (from ? 1 : 0), b - from + (from ? 1 : 0)]);
  return { text: `${from ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`, marks: kept };
}

export class TranscriptSearch {
  // deps: pod (ui/pod.js), store (ui/podstore.js), player, artInto, toast,
  // openTranscript(ep, { at }): the episode's transcript, opened at that time.
  constructor(deps) {
    Object.assign(this, deps);
    this.q = '';
    try { this.q = sessionStorage.getItem(KEY) || ''; } catch {}
    this.timer = 0;
    this.ctl = null;
    this.got = null; // the last answer: { q, episodes, more }
    const { store, player, pod } = this;
    store.addEventListener('link', () => { this.entry(); if (pod.view === 'search') this.show(); });
    for (const ev of ['online', 'offline']) window.addEventListener(ev, () => { if (pod.view === 'search') this.run(this.q, { now: true }); });
    player.addEventListener('item', () => this.paintNow());
    // On a keyboard, / goes to the search (in a transcript it searches the transcript: app.js).
    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || !document.body.classList.contains('view-listen') || sheetOpen() || !this.available) return;
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
      e.preventDefault();
      this.open();
    });
  }

  // A server with the library's transcripts, and this device one of the library's (or one
  // that was, while the server is not answering).
  get available() {
    const { server, key } = this.store;
    return server.there && (server.linked || (server.offline && !!key));
  }

  // The way in, at the top of the Listen screen.
  entry() {
    const box = $('home-search');
    if (!box) return;
    box.classList.toggle('hidden', !this.available);
    if (box.firstChild) return;
    box.append(h('a.search-field.search-entry', { href: '#/search', onclick: (e) => { e.preventDefault(); this.open(); } },
      icon('search'), h('span', { text: 'Search every transcript' }), h('kbd.search-key', { text: '/', title: 'Press / to search' })));
  }

  // Opened from a tap or a key: the field gets the keyboard at once (on an iPhone only a
  // focus inside the tap brings it up, so the screen is switched to here, not on hashchange).
  open() {
    this.focusNext = true;
    if (location.hash !== '#/search') history.pushState(null, '', `${location.pathname}${location.search}#/search`);
    this.pod.route();
    this.focusNext = false;
  }

  /* ---------- the screen ---------- */

  build() {
    const root = $('pod-search');
    if (root.firstChild) return;
    this.input = h('input', { type: 'search', placeholder: 'Words, or "a phrase in quotes"', 'aria-label': 'Search what was said', enterkeyhint: 'search', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', value: this.q,
      oninput: (e) => this.run(e.target.value),
      onkeydown: (e) => { if (e.key === 'Enter') { this.run(e.target.value, { now: true }); e.target.blur(); } } });
    this.note = h('div.pod-none.search-note', { id: 'search-note', role: 'status' });
    this.list = h('ol.hit-eps', { id: 'search-results' });
    this.kicker = h('p.kicker', { text: 'Every transcript in your library' });
    root.append(h('section.card.pod-card.search-card', {},
      h('a.back-link', { href: '#/' }, icon('prev'), h('span', { text: 'Listen' })),
      h('div.pod-head', {}, h('div', {}, this.kicker, h('h2', { text: 'Search what was said' }))),
      h('div.search-field.big', {}, icon('search'), this.input),
      this.note, this.list));
  }

  show() {
    this.build();
    // A copy of the app with no server behind it has no transcripts to search.
    this.store.ready.then(() => {
      if (this.pod.view === 'search' && !this.store.server.there) { history.replaceState(null, '', `${location.pathname}${location.search}#/`); this.pod.route(); }
    });
    if (this.input.value !== this.q) this.input.value = this.q;
    // A device that is not one of the library's (opened from a link, or unlinked meanwhile).
    if (this.store.server.there && !this.available) { this.unlinked(); return; }
    if (!this.got || this.got.q !== this.q.trim()) this.run(this.q, { now: true });
    else this.draw();
    if (this.focusNext || !matchMedia('(hover: none)').matches) this.input.focus({ preventScroll: true });
  }

  // What the screen says above (or instead of) the results.
  say(text = '', retry = false, extra = null) {
    this.note.replaceChildren(...[text ? h('p', { text }) : null, retry ? h('button.btn.ghost.small', { type: 'button', onclick: () => this.run(this.q, { now: true }) }, icon('resume'), h('span', { text: 'Try again' })) : null, extra].filter(Boolean));
    this.note.classList.toggle('hidden', !text);
  }

  // Asks the server, a moment after the last key; an answer to an older query is dropped.
  run(value, { now = false } = {}) {
    this.q = String(value || '');
    try { sessionStorage.setItem(KEY, this.q); } catch {}
    clearTimeout(this.timer);
    const q = this.q.trim();
    if (q.length < 2) {
      this.ctl?.abort();
      this.got = null;
      this.list.replaceChildren();
      const n = this.store.transcripts.size;
      this.kicker.textContent = 'Every transcript in your library';
      this.say(`Type a word or two, or "a phrase in quotes", to find where it was said${n ? ` in ${n} transcribed episode${n === 1 ? '' : 's'}` : ''}. Tap a line to play from there.`);
      return;
    }
    if (now) this.ask(q); else this.timer = setTimeout(() => this.ask(q), WAIT);
  }

  async ask(q) {
    this.ctl?.abort();
    const ctl = new AbortController();
    this.ctl = ctl;
    const { server } = this.store;
    if (navigator.onLine === false) { this.fail('You are offline. Searching the transcripts needs a connection to your server.', true); return; }
    if (!server.linked && !(server.offline && this.store.key)) { this.unlinked(); return; }
    this.list.classList.add('stale');
    this.kicker.textContent = 'Searching…';
    try {
      const got = await this.store.api('GET', `search?q=${encodeURIComponent(q)}`, undefined, { signal: ctl.signal });
      if (ctl !== this.ctl) return;
      this.got = { ...got, q };
      this.draw();
    } catch (err) {
      if (ctl !== this.ctl || err.name === 'AbortError') return;
      if (err.status === 401) this.unlinked();
      else if (!err.status || err.status >= 502) this.fail('The server is not answering, so the transcripts can\'t be searched right now. Try again in a moment.', true);
      else this.fail(`The search went wrong on the server (${err.message}). Try again, or with other words.`, true);
    }
  }

  fail(text, retry, extra) {
    this.got = null;
    this.list.classList.remove('stale');
    this.list.replaceChildren();
    this.kicker.textContent = 'Every transcript in your library';
    this.say(text, retry, extra);
  }

  unlinked() {
    this.fail('This device is not linked to your library, so it can\'t search its transcripts. Link it under Settings with the link from a device that is.', false,
      h('a.btn.primary.small', { href: '#/settings' }, h('span', { text: 'Go to Settings' })));
  }

  /* ---------- the results ---------- */

  draw() {
    const { episodes = [], more = 0, q } = this.got;
    this.list.classList.remove('stale');
    const hits = episodes.reduce((n, e) => n + e.count, 0);
    this.kicker.textContent = !episodes.length ? 'Every transcript in your library'
      : `${hits} place${hits === 1 ? '' : 's'} in ${episodes.length + more} episode${episodes.length + more === 1 ? '' : 's'}${more ? `, the newest ${episodes.length} shown` : ''}`;
    if (!episodes.length) {
      this.list.replaceChildren();
      this.say(`No transcript has ${/\s/.test(q) ? 'all of ' : ''}"${q}". Try fewer words, or the start of a word.`);
      return;
    }
    this.say(more ? `${more} older episode${more === 1 ? '' : 's'} also match${more === 1 ? 'es' : ''}. Add a word to narrow it down.` : '');
    this.list.replaceChildren(...episodes.map((e) => this.episode(e)));
    this.paintNow();
  }

  // The episode as the player and the rest of the app know it: its feed's details where they
  // are known, the server's otherwise (whose copy of the audio is what the times are in).
  itemOf(e) {
    const known = this.pod.eps.get(e.id) || this.store.doc.eps?.[e.id] || null;
    const sub = known?.sub || this.store.shows.find((s) => s.title === e.show)?.id || '';
    return this.pod.know(this.store.decorate({
      ...(known || {}), id: e.id, title: known?.title || e.title, show: known?.show || e.show, art: known?.art || e.art,
      url: known?.url || e.url || '', duration: known?.duration || e.duration || 0, published: known?.published || e.createdAt,
    }, sub));
  }

  episode(e) {
    const art = h('div.art');
    const li = h('li.hit-ep', { dataset: { id: e.id } },
      h('div.hit-head', {}, art,
        h('button.hit-ep-main', { type: 'button', onclick: () => this.pod.episode(this.itemOf(e)) },
          h('span.tile-show', { text: e.show }),
          h('span.hit-ep-title', { text: e.title }))),
      h('ol.hit-list', {}, e.hits.map((hit) => this.hit(e, hit))),
      e.count > e.hits.length ? h('p.hit-more', { text: `And ${e.count - e.hits.length} more in this episode` }) : null);
    requestAnimationFrame(() => this.artInto(art, e));
    return li;
  }

  hit(e, hit) {
    const { text, marks } = excerpt(hit.text, hit.marks);
    const line = [];
    let at = 0;
    for (const [a, b] of marks) { line.push(text.slice(at, a), h('b', { text: text.slice(a, b) })); at = b; }
    line.push(text.slice(at));
    const time = fmtTime(hit.start);
    return h('li.hit', { dataset: { start: String(hit.start) } },
      h('button.hit-main', { type: 'button', 'aria-label': `Play from ${time}: ${hit.text}`, onclick: () => this.play(e, hit) },
        h('span.hit-time', { text: time }), h('span.hit-text', {}, line.filter((x) => x !== ''))),
      h('button.icon-btn.hit-read', { type: 'button', 'aria-label': `Read the transcript from ${time}`, title: 'Read the transcript from here', onclick: () => this.openTranscript(this.itemOf(e), { at: hit.start }) }, icon('lines')));
  }

  play(e, hit) {
    const item = this.itemOf(e);
    // (Started inside the tap: an iPhone plays nothing that had to wait.)
    Promise.resolve(this.player.play(item, { at: Math.max(0, hit.start - BEFORE) })).catch((err) => this.toast(`Couldn't play it: ${err.message || 'the audio did not load'}`));
    this.nowAt = `${e.id}:${hit.start}`;
    this.paintNow();
  }

  // The line last played from, while its episode is in the player.
  paintNow() {
    const id = this.player.item?.id;
    for (const li of this.list?.querySelectorAll('.hit') || []) {
      const ep = li.closest('.hit-ep').dataset.id;
      li.classList.toggle('now', ep === id && this.nowAt === `${ep}:${li.dataset.start}`);
    }
  }
}
