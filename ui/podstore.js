// The podcast side's memory in the page: the document of shows, positions and queue
// (lib/podstate.js) kept in localStorage, sent to and merged with the server's copy when there
// is one (server/pod.mjs), and what has been read of each feed (IndexedDB, ui/library.js).
// Without the server (a static copy of the app, or a device that isn't linked) everything stays
// on the device and feeds are read straight from their hosts where those allow it.
import * as S from '../lib/podstate.js';
import { parseFeed, episodeId, appLanguage } from '../lib/feed.js';
import { getFeed, putFeed, dropFeed } from './library.js';

const DOC = 'pod';
const META = 'pod-meta';
const KEY = 'pod-key';
const INBOX_DAYS = 45;

const read = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } };
const write = (k, v) => { try { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); return true; } catch { return false; } };

// An id for something played that is in no feed (a pasted link): stable for the same address.
export const adhocId = (key) => `x${S.subId(key)}`;

export class PodStore extends EventTarget {
  // fetchText(url) -> text of a page that lets the app read it (or through the listener's own
  // proxy); lookupApple(id) -> { episodes } from Apple's directory.
  constructor({ fetchText, lookupApple, now = () => Date.now() }) {
    super();
    this.deps = { fetchText, lookupApple };
    this.now = now;
    this.doc = { ...S.emptyDoc(), ...read(DOC, {}) };
    this.meta = { epoch: '', since: 0, dirty: [], ...read(META, {}) };
    this.key = (() => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } })();
    this.server = { there: false, claimed: false, linked: false, error: '' };
    this.transcripts = new Map(); // episode id -> what the server's index says of its transcript
    this.syncedAt = 0;
    this.timer = 0;
    this.due = Infinity;
    // Settled once it is known whether there is a server and this device is linked to it:
    // reading feeds waits for that, so a linked device never reads them the slow way.
    this.ready = new Promise((resolve) => { this.settle = resolve; });
    window.addEventListener('online', () => { if (this.server.linked) this.syncSoon(500); else this.connect(); });
    // Another tab of the app changed the document.
    window.addEventListener('storage', (e) => {
      if (e.key !== DOC || !e.newValue) return;
      try { if (S.apply(this.doc, JSON.parse(e.newValue)).length) this.emit('change', { remote: true }); } catch {}
    });
  }

  emit(type, detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  get settings() { return S.settingsOf(this.doc); }
  get shows() { return S.shows(this.doc); }
  show(id) { const s = this.doc.subs[id]; return s && !s.gone ? s : null; }
  progress(id) { return this.doc.progress[id] || null; }
  get queue() { return (this.doc.queue?.ids || []).map((id) => this.doc.eps[id]).filter(Boolean); }
  queued(id) { return (this.doc.queue?.ids || []).includes(id); }
  get started() { return S.inProgress(this.doc); }

  persist() {
    write(DOC, this.doc);
    write(META, this.meta);
  }

  // A record changed here: keep it, tell the page, and send it along soon (`lazy`: positions
  // while playing, which can wait a little).
  touch(keys, { lazy = false } = {}) {
    const list = [].concat(keys).filter(Boolean);
    if (!list.length) return;
    for (const k of list) if (!this.meta.dirty.includes(k)) this.meta.dirty.push(k);
    this.persist();
    this.emit('change', { keys: list });
    this.syncSoon(lazy ? 20000 : 1500);
  }

  /* ---------- what the listener does ---------- */

  follow(show) {
    const key = S.follow(this.doc, { feedUrl: show.feedUrl, title: show.title || show.feedUrl, art: show.art || '', appleId: show.appleId || undefined, lang: show.lang || undefined, transcribe: false }, this.now());
    this.touch(key);
    return key.split('/')[1];
  }

  unfollow(id) {
    this.touch(S.unfollow(this.doc, id, this.now()));
    dropFeed(id);
    dropFeed(`notes:${id}`);
  }

  updateShow(id, patch) { this.touch(S.updateShow(this.doc, id, patch, this.now())); }

  setProgress(ep, values, { lazy = false } = {}) {
    const keys = [S.setProgress(this.doc, ep.id, values, this.now())];
    if (ep.url) keys.push(S.rememberEpisode(this.doc, ep, this.now()));
    this.touch(keys, { lazy });
  }

  markPlayed(ep, done = true) {
    const had = this.doc.progress[ep.id];
    this.setProgress(ep, { p: done ? had?.p || 0 : 0, d: had?.d || ep.duration || 0, done });
  }

  queueAdd(ep, { next = false, after = null } = {}) {
    this.touch([S.rememberEpisode(this.doc, ep, this.now()), S.queueAdd(this.doc, ep.id, this.now(), { next, after })]);
  }

  // Asks the server for a transcript of an episode (it needs the feed to find it in).
  want(ep, feedUrl = this.doc.subs[ep.sub]?.feedUrl) {
    if (!feedUrl || !this.server.linked) return false;
    this.touch(S.want(this.doc, ep, feedUrl, this.now()));
    return true;
  }

  unwant(id) { this.touch(S.unwant(this.doc, id, this.now())); }
  wanted(id) { return S.wanted(this.doc, id); }

  queueRemove(id) { this.touch(S.queueRemove(this.doc, id, this.now())); }
  queueMove(id, to) { this.touch(S.queueMove(this.doc, id, to, this.now())); }
  queueClear() { this.doc.queue = { ids: [], at: this.now() }; this.touch('queue'); }
  set(patch) { this.touch(S.setSettings(this.doc, patch, this.now())); }

  // An episode from a feed, with what the show knows filled in.
  decorate(ep, subId = ep.sub) {
    const sub = this.doc.subs[subId];
    return { ...ep, sub: subId || '', show: ep.show || sub?.title || '', art: ep.art || sub?.art || '' };
  }

  /* ---------- the server ---------- */

  async api(method, route, body) {
    const headers = {};
    if (this.key) headers.authorization = `Bearer ${this.key}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`api/pod/${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    if (res.status === 401 && route !== 'link') { this.server.linked = false; this.emit('link'); }
    let json = null;
    try { json = await res.json(); } catch {}
    if (!res.ok) throw Object.assign(new Error(json?.error || `HTTP ${res.status}`), { status: res.status });
    return json;
  }

  // Is there a server, and is this device one of the library's? The very first device makes
  // its own key the library's.
  async connect() {
    // A copy of the app on a static host says so in its (empty) library index, and is not
    // asked for a server it doesn't have.
    const index = await this.fetchIndex();
    this.loadTranscripts(index);
    const sent = this.key;
    let status = null;
    if (!index?.static && (index || this.key)) {
      try {
        const res = await fetch('api/pod/status', { headers: this.key ? { authorization: `Bearer ${this.key}` } : {}, cache: 'no-store' });
        if (res.ok && /json/.test(res.headers.get('content-type') || '')) status = await res.json();
      } catch {}
    }
    if (!status || typeof status.claimed !== 'boolean') {
      // No answer is not "no server": a device that was linked stays so while it is offline.
      this.server = { ...this.server, there: this.server.there || !!this.key, linked: false, offline: !!this.key };
      this.settle();
      this.emit('link');
      return this.server;
    }
    this.server = { there: true, claimed: status.claimed, linked: status.linked, error: '' };
    try {
      if (!status.claimed) {
        // Nobody's yet. It is started with a tap (claim()), not by a page merely being opened:
        // a crawler opens pages too.
      } else if (status.linked && !this.key) {
        this.setKey((await this.api('GET', 'key')).key);
      } else if (!status.linked && sent && sent === this.key) {
        this.setKey(''); // the key this device held is no longer the library's
      }
    } catch (err) {
      this.server.error = err.message;
      if (err.status === 409) this.server.claimed = true;
    }
    this.settle();
    this.emit('link');
    if (this.server.linked) this.sync();
    return this.server;
  }

  // Makes this device the first of the library: its key becomes the library's.
  async claim() {
    const key = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'[b & 63]).join('');
    await this.api('POST', 'claim', { key });
    this.setKey(key);
    this.server = { ...this.server, there: true, claimed: true, linked: true, error: '' };
    this.meta.epoch = '';
    this.emit('link');
    await this.sync();
  }

  setKey(key) {
    this.key = key || '';
    try { if (key) localStorage.setItem(KEY, key); else localStorage.removeItem(KEY); } catch {}
  }

  // The link another device opens (or pastes) to join the library.
  get linkUrl() { return this.key ? `${location.origin}${location.pathname}#link=${this.key}` : ''; }

  // `text`: that link, or the key on its own.
  async link(text) {
    const key = (String(text).match(/[#?&]link=([\w-]{20,100})/)?.[1] || String(text).trim());
    if (!/^[\w-]{20,100}$/.test(key)) throw new Error('That is not a link from a linked device.');
    await this.api('POST', 'link', { key });
    this.setKey(key);
    this.server = { ...this.server, there: true, claimed: true, linked: true, error: '' };
    this.meta.epoch = ''; // everything, both ways
    this.emit('link');
    await this.sync();
  }

  async unlink() {
    try { await this.api('POST', 'unlink'); } catch {}
    this.setKey('');
    this.server.linked = false;
    this.emit('link');
  }

  syncSoon(ms = 1500) {
    if (!this.server.linked) return;
    const due = Date.now() + ms;
    if (this.timer && due >= this.due) return;
    clearTimeout(this.timer);
    this.due = due;
    this.timer = setTimeout(() => { this.timer = 0; this.due = Infinity; this.sync(); }, ms);
  }

  async sync() {
    if (!this.server.linked) return false;
    if (this.syncing) { this.again = true; return this.syncing; }
    this.syncing = (async () => {
      const sending = [...this.meta.dirty];
      const sent = new Map(sending.map((k) => [k, S.getRecord(this.doc, k)?.at]));
      try {
        const res = await this.api('POST', 'sync', { epoch: this.meta.epoch, since: this.meta.since, changes: S.pick(this.doc, sending) });
        const changed = S.apply(this.doc, res.changes || {});
        if (res.epoch !== this.meta.epoch) {
          // A server this device hasn't talked to before: it sent everything, and gets everything.
          this.meta.epoch = res.epoch;
          this.meta.dirty = [...S.records(this.doc)].map(([k]) => k);
          this.again = this.meta.dirty.length > 0;
        } else {
          this.meta.dirty = this.meta.dirty.filter((k) => !sent.has(k) || (S.getRecord(this.doc, k)?.at !== sent.get(k) && !changed.includes(k)));
        }
        this.meta.since = res.rev;
        const gone = S.prune(this.doc, this.now());
        this.meta.dirty = this.meta.dirty.filter((k) => !gone.includes(k));
        this.persist();
        this.syncedAt = Date.now();
        this.server.error = '';
        if (changed.length) this.emit('change', { keys: changed, remote: true });
        this.emit('sync');
        return true;
      } catch (err) {
        this.server.error = err.message;
        this.emit('sync');
        if (err.status !== 401) this.syncSoon(45000);
        return false;
      } finally {
        this.syncing = null;
        if (this.again) { this.again = false; this.syncSoon(300); }
      }
    })();
    return this.syncing;
  }

  // Last words before the page goes away: the browser sends this even while closing.
  flush() {
    this.persist();
    if (!this.server.linked || !this.meta.dirty.length) return;
    try {
      fetch('api/pod/sync', {
        method: 'POST', keepalive: true, cache: 'no-store',
        headers: { 'content-type': 'application/json', ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) },
        body: JSON.stringify({ epoch: this.meta.epoch, since: this.meta.since, changes: S.pick(this.doc, this.meta.dirty.filter((k) => !k.startsWith('eps/')).slice(0, 40)) }),
      }).catch(() => {});
    } catch {}
  }

  /* ---------- transcripts the server has ---------- */

  async fetchIndex() {
    try {
      const res = await fetch('library/index.json', { cache: 'no-cache' });
      if (res.ok && /json/.test(res.headers.get('content-type') || '')) return await res.json();
    } catch {}
    return null;
  }

  // index: the library index when it was just fetched.
  async loadTranscripts(index = undefined) {
    if (index === undefined) index = await this.fetchIndex();
    if (index && !index.static) putFeed({ id: 'transcripts', entries: index.entries });
    else index = await getFeed('transcripts');
    this.transcripts = new Map((index?.entries || []).map((e) => [e.id, e]));
    // The ones that were asked for and have arrived.
    const arrived = Object.values(this.doc.wants || {}).filter((w) => !w.gone && this.transcripts.has(w.id));
    for (const w of arrived) this.unwant(w.id);
    this.emit('transcripts', { arrived: arrived.map((w) => w.title || this.transcripts.get(w.id).title) });
    return this.transcripts;
  }

  /* ---------- feeds ---------- */

  cachedFeed(id) { return getFeed(id); }

  // A feed read in the page: from its host where that is allowed, else from Apple's directory.
  async direct(feedUrl, { appleId = null, title = '' } = {}) {
    let parsed = null;
    try {
      parsed = parseFeed(await this.deps.fetchText(feedUrl), { maxEpisodes: 600 });
    } catch (err) {
      if (!appleId) throw err;
    }
    const id = S.subId(feedUrl);
    if (parsed?.episodes.length || parsed?.title) {
      const notes = {};
      const episodes = await Promise.all(parsed.episodes.map(async ({ html, guid, type, ...e }, i) => {
        const eid = await episodeId(guid);
        if (i < 200 && html) notes[eid] = html;
        return { id: eid, ...e };
      }));
      putFeed({ id: `notes:${id}`, notes });
      return { id, feedUrl, title: parsed.title || title, art: parsed.art, description: parsed.description, link: parsed.link, author: parsed.author, lang: appLanguage(parsed.language), fetchedAt: Date.now(), episodes, total: episodes.length };
    }
    const found = await this.deps.lookupApple(appleId);
    if (!found?.episodes?.length) throw new Error('This show\'s feed can\'t be read from the browser.');
    const episodes = await Promise.all(found.episodes.map(async (e) => ({
      id: await episodeId(e.guid || e.url), title: e.title, url: e.url, published: Date.parse(e.date) || 0, duration: e.seconds || 0, summary: (e.notes || '').slice(0, 280), art: '',
    })));
    return { id, feedUrl, title: found.title || title, art: found.art || '', description: '', fetchedAt: Date.now(), episodes, total: episodes.length };
  }

  // One followed show's episodes. `limit`: only the newest so many (a quick first answer).
  async feed(id, { fresh = false, limit = 0 } = {}) {
    await this.ready;
    const sub = this.doc.subs[id];
    if (!sub) throw new Error('Not a followed show');
    let feed = null;
    if (this.server.linked) {
      // Followed a moment ago: the server hears of it first.
      if (this.meta.dirty.includes(`subs/${id}`)) await this.sync();
      try {
        const q = new URLSearchParams();
        if (fresh) q.set('fresh', '1');
        if (limit) q.set('limit', String(limit));
        feed = await this.api('GET', `feed/${id}${q.size ? `?${q}` : ''}`);
      } catch (err) {
        if (err.status === 404) throw err;
      }
    }
    if (!feed && navigator.onLine !== false && !this.server.linked) {
      feed = await this.direct(sub.feedUrl, { appleId: sub.appleId, title: sub.title }).catch(() => null);
      if (feed && ((feed.art && feed.art !== sub.art) || (feed.title && sub.title === sub.feedUrl) || (feed.lang && !sub.lang))) {
        this.updateShow(id, { art: feed.art || sub.art, title: sub.title === sub.feedUrl ? feed.title : sub.title, lang: sub.lang || feed.lang || undefined });
      }
    }
    // A cover the show has changed is taken over (the address, not what follows its question mark).
    const bare = (u) => String(u || '').split('?')[0];
    if (feed?.art && this.server.linked && this.doc.subs[id] && !this.doc.subs[id].gone && bare(feed.art) !== bare(this.doc.subs[id].art)) this.updateShow(id, { art: feed.art });
    if (feed && (!limit || feed.total <= feed.episodes.length)) putFeed(feed);
    return feed || (await getFeed(id));
  }

  // The newest episodes of every followed show. -> { episodes, fetchedAt, cached }. Read afresh,
  // they are also sent round as an 'inbox' event (what keeps episodes on the device listens).
  async inbox({ fresh = false } = {}) {
    await this.ready;
    if (this.server.linked) {
      try {
        const got = await this.api('GET', fresh ? 'inbox?fresh=1' : 'inbox');
        const out = { id: 'inbox', episodes: got.episodes, fetchedAt: Date.now() };
        putFeed(out);
        this.emit('inbox', out);
        return out;
      } catch {}
    } else if (navigator.onLine !== false) {
      const since = Date.now() - INBOX_DAYS * 864e5;
      const all = [];
      let got = 0;
      await Promise.all(this.shows.map(async (sub) => {
        const cached = await getFeed(sub.id);
        const stale = !cached || fresh || Date.now() - (cached.fetchedAt || 0) > 30 * 60e3;
        const feed = stale ? await this.feed(sub.id).catch(() => cached) : cached;
        if (!feed) return;
        got++;
        feed.episodes.forEach((e, i) => { if (e.published >= since || i < 3) all.push({ ...e, sub: sub.id }); });
      }));
      if (got || !this.shows.length) {
        const out = { id: 'inbox', episodes: all.sort((a, b) => b.published - a.published).slice(0, 300), fetchedAt: Date.now() };
        putFeed(out);
        this.emit('inbox', out);
        return out;
      }
    }
    const cached = await getFeed('inbox');
    return cached ? { ...cached, cached: true } : { episodes: [], fetchedAt: 0, cached: true };
  }

  // A feed that isn't followed (yet), to look at: by its address.
  async preview(feedUrl, hints = {}) {
    await this.ready;
    if (this.server.linked) {
      try { return await this.api('GET', `resolve?url=${encodeURIComponent(feedUrl)}`); } catch (err) { if (!hints.appleId) throw err; }
    }
    return this.direct(feedUrl, hints);
  }

  async notes(subId, epId) {
    if (this.server.linked && /^[0-9a-f]{12}$/.test(subId || '') && /^[0-9a-f]{16}$/.test(epId)) {
      try { return (await this.api('GET', `notes/${subId}/${epId}`)).html || ''; } catch {}
    }
    return (await getFeed(`notes:${subId}`))?.notes?.[epId] || '';
  }
}
