// Keeps the newest episodes of the shows that ask for it saved on this device, by themselves,
// while the app is open: lib/autosave.js decides what, this fetches it through ui/downloads.js,
// one episode at a time, and tidies up after. Which shows keep how many is this device's own
// choice (localStorage, not synced): storage is each device's own matter.
import { plan, roomFor, sizeOf, backoff } from '../lib/autosave.js';

const CHOICE = 'pod-keep-newest'; // show id -> how many
const DECLINED = 'pod-keep-declined'; // ids of episodes saved this way that the listener removed
// How long a show's episodes, once read, are taken as they are. News of a new episode comes with
// the store's 'inbox' (which marks the show to be read again), so this is only a backstop: read
// every few minutes, each kept show's feed would be fetched over and over while the app plays.
const FRESH = 6 * 3600e3;

const read = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

export class Autosave extends EventTarget {
  constructor({ store, downloads, player }) {
    super();
    Object.assign(this, { store, downloads, player });
    this.choice = read(CHOICE, {});
    this.declined = read(DECLINED, []);
    this.feeds = new Map(); // show id -> { episodes, at }
    this.stale = new Set(); // shows the inbox has news of
    this.job = null; // the id being fetched
    this.cancelled = null;
    this.failures = 0;
    this.retryAt = 0;
    this.short = false; // stopped for lack of space
    this.dropping = new Set();
    this.autos = this.autoIds();
    this.played = new Map(); // episode id -> played to the end, as last seen
    this.due = Infinity;

    store.ready.then(() => this.soon(500));
    store.addEventListener('inbox', (e) => {
      for (const ep of e.detail.episodes || []) {
        if (this.keepOf(ep.sub) && !this.feeds.get(ep.sub)?.episodes?.some((x) => x.id === ep.id)) this.stale.add(ep.sub);
      }
      if (this.stale.size) this.soon();
    });
    store.addEventListener('change', (e) => {
      const keys = e.detail.keys || [];
      let go = keys.some((k) => k.startsWith('subs/') || k === 'queue' || k === 'settings');
      // A position is saved every few seconds while something plays: only an episode becoming
      // played (or unplayed) changes what is kept, so only that sets this going.
      for (const k of keys) {
        if (!k.startsWith('progress/')) continue;
        const id = k.slice('progress/'.length);
        const done = !!store.progress(id)?.done;
        if (this.played.get(id) !== done) { this.played.set(id, done); go = true; }
      }
      if (go) this.soon();
    });
    player.addEventListener('item', () => this.soon());
    downloads.addEventListener('change', () => { this.noticeRemoved(); this.soon(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.soon(1000); });
    window.addEventListener('online', () => this.soon(2000));
  }

  emit() { this.dispatchEvent(new Event('change')); }
  keepOf(id) { return this.choice[id] || 0; }
  get on() { return this.store.shows.some((s) => this.keepOf(s.id)); }

  set(id, n) {
    if (n) this.choice[id] = n; else delete this.choice[id];
    write(CHOICE, this.choice);
    this.emit();
    this.soon(0);
  }

  // Every show to none, and what was saved this way removed (but what is in the player, queued
  // or started).
  stop() {
    this.choice = {};
    write(CHOICE, this.choice);
    if (this.job) { this.cancelled = this.job; this.downloads.cancel(this.job); }
    this.emit();
    this.soon(0);
  }

  // What Settings says: which shows, how many episodes, how much space.
  summary() {
    const shows = this.store.shows.filter((s) => this.keepOf(s.id)).map((s) => ({ id: s.id, title: s.title, keep: this.keepOf(s.id) }));
    const saved = [...this.autoIds()];
    return {
      shows, count: saved.length, bytes: saved.reduce((n, id) => n + (this.downloads.info(id)?.bytes || 0), 0),
      short: this.short, saveData: !!navigator.connection?.saveData, fetching: this.job,
    };
  }

  autoIds() { return new Set(this.downloads.ids.filter((id) => this.downloads.info(id)?.auto)); }

  // One saved this way and gone, not by this: the listener removed it, and it is not fetched
  // again (played to the end is not that: it is passed over anyway). One whose stored file the
  // browser cleared is not that either: nobody chose it, and it is fetched again.
  noticeRemoved() {
    const now = this.autoIds();
    for (const id of this.autos) {
      if (now.has(id) || this.dropping.has(id)) continue;
      if (this.downloads.lost.delete(id)) continue;
      if (!this.store.progress(id)?.done) this.decline(id);
    }
    for (const id of this.dropping) if (!this.downloads.has(id)) this.dropping.delete(id);
    this.autos = now;
  }

  decline(id) {
    if (this.declined.includes(id)) return;
    this.declined = [...this.declined, id].slice(-500);
    write(DECLINED, this.declined);
  }

  soon(ms = 1500) {
    const due = Date.now() + ms;
    if (this.timer && due >= this.due) return;
    clearTimeout(this.timer);
    this.due = due;
    this.timer = setTimeout(() => { this.timer = 0; this.due = Infinity; this.run(); }, ms);
  }

  async run() {
    if (this.running) { this.again = true; return; }
    this.running = true;
    try { await this.step(); } catch {} finally {
      this.running = false;
      if (this.again) { this.again = false; this.soon(); }
    }
  }

  // A show's episodes: what the device has read of its feed lately, else the feed afresh.
  async episodes(id) {
    const had = this.feeds.get(id);
    if (had && !this.stale.has(id) && Date.now() - had.at < FRESH) return;
    let feed = this.stale.has(id) ? null : await this.store.cachedFeed(id).catch(() => null);
    if ((!feed || Date.now() - (feed.fetchedAt || 0) > FRESH) && navigator.onLine !== false) feed = (await this.store.feed(id, { limit: 30 }).catch(() => null)) || feed;
    this.stale.delete(id);
    // (Not read: what was known stands, and the feed is asked again in a minute, not at every turn.)
    if (feed?.episodes) this.feeds.set(id, { episodes: feed.episodes.map((e) => this.store.decorate(e, id)), at: Date.now() });
    else this.feeds.set(id, { episodes: had?.episodes || null, at: Date.now() - FRESH + 60e3 });
  }

  async step() {
    const { store, downloads } = this;
    const shows = store.shows.map((s) => ({ id: s.id, keep: this.keepOf(s.id) }));
    for (const s of shows) if (s.keep) await this.episodes(s.id);
    const { fetch, drop } = plan({
      shows,
      episodesOf: (id) => this.feeds.get(id)?.episodes || null,
      progress: (id) => store.progress(id),
      queue: store.doc.queue?.ids || [],
      saved: downloads.index,
      declined: this.declined,
      playingId: this.player.item?.id || null,
      keepPlayed: !!store.settings.keepDownloads,
    });
    for (const id of drop) { this.dropping.add(id); await downloads.remove(id); }
    // The one being fetched is no longer wanted (the show was turned down, or it was played elsewhere).
    if (this.job && !fetch.some((e) => e.id === this.job)) { this.cancelled = this.job; downloads.cancel(this.job); }
    if (this.job || !fetch.length) { this.room(true); return; }

    if (navigator.onLine === false || navigator.connection?.saveData) return;
    if (Date.now() < this.retryAt) { this.soon(this.retryAt - Date.now()); return; }
    // Never in the way of a download the listener started: after it.
    if (downloads.active.size) return;
    const ep = fetch[0];
    const estimate = await navigator.storage?.estimate?.().catch(() => null);
    if (!this.room(roomFor(estimate || {}, sizeOf(ep)))) return;

    this.job = ep.id;
    downloads.start(ep, { auto: true }).then(() => {
      if (downloads.has(ep.id)) { this.failures = 0; this.retryAt = 0; } else if (this.cancelled !== ep.id) this.decline(ep.id); // stopped by the listener
    }, () => {
      this.failures++;
      this.retryAt = Date.now() + backoff(this.failures);
    }).finally(() => {
      this.job = null;
      this.cancelled = null;
      this.soon(Math.max(500, this.retryAt - Date.now()));
    });
  }

  // Remembers whether there was room, and says so when that changes. -> whether there is.
  room(ok) {
    if (this.short === !ok) return ok;
    this.short = !ok;
    this.emit();
    return ok;
  }
}
