// The player: the one audio element everything plays through, whether an episode from a
// followed show, a link that was pasted, or the audio under an open transcript. It remembers
// where each episode was left, moves on through the queue, answers the lock screen's and the
// headphones' buttons (Media Session), and jumps over the ads a transcript has marked.
// What it decides (where to resume, which ad to skip) is in lib/playback.js.
import { resumeAt, rewindFor, finished, skipAt } from '../lib/playback.js';
import { breakAt } from '../lib/adbreaks.js';

const IS_IOS = typeof navigator !== 'undefined' && (/iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
const NOW = 'pod-now';
const VOLUME = 'pod-volume';

// A moment of silence, to start the audio element inside a tap when the real audio has to be
// looked up first: iOS only lets a page play what a tap started.
function silence() {
  const n = 800;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

export class Player extends EventTarget {
  // store: ui/podstore.js; downloads: ui/downloads.js; cachedAudio(key) -> the copy an open
  // transcript was made from, if it is still kept; adsFor(item, source) -> [[start, end], ...]
  // for that copy of the audio, or null.
  constructor({ audio, store, downloads, cachedAudio, adsFor }) {
    super();
    Object.assign(this, { audio, store, downloads, cachedAudio, adsFor });
    this.item = null;
    this.source = null;
    this.breaks = null;
    this.inBreak = -1;
    this.keep = -1;
    this.lastSkip = null;
    this.wanted = null; // a position to go to once the audio can
    this.known = 0; // the length, before the audio says
    this.at = 0; // the position, when no audio is loaded
    this.sleep = null;
    this.ready = null; // the next episode's audio, looked up ahead of time
    this.seq = 0;
    this.unlocked = false;
    this.wantPlay = false; // the listener's last word: play, or pause
    this.preparing = null;
    this.pausedAt = 0;
    this.savedAt = 0;
    this.busy = false;
    try { const v = Number(localStorage.getItem(VOLUME)); if (v > 0 && v <= 1) audio.volume = v; } catch {}

    const on = (type, fn) => audio.addEventListener(type, fn);
    on('loadedmetadata', () => this.arrive());
    on('canplay', () => this.arrive(true));
    on('durationchange', () => this.emit('time'));
    on('timeupdate', () => this.tick());
    on('playing', () => { this.unlocked = true; this.busy = false; this.pausedAt = 0; this.state(); });
    on('play', () => this.state());
    on('pause', () => { if (this.source) { this.pausedAt = Date.now(); this.save(); } this.state(); });
    on('waiting', () => { this.busy = true; this.emit('state'); });
    on('seeked', () => { this.position(); this.emit('time'); });
    on('ratechange', () => { this.position(); this.emit('rate'); });
    on('ended', () => this.ended());
    on('error', () => this.failed());

    const leave = () => { this.save(); store.flush(); };
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') leave(); });
    store.addEventListener('change', (e) => {
      const keys = e.detail.keys || [];
      if (keys.some((k) => k === 'settings' || k.startsWith('subs/'))) { this.applyRate(); this.handlers(); }
      if (keys.includes('queue')) { this.prepare(); this.handlers(); }
      // Played on another device meanwhile: a paused episode here follows it.
      if (e.detail.remote && this.item && audio.paused && keys.includes(`progress/${this.item.id}`)) {
        const p = store.progress(this.item.id);
        if (p && Math.abs(p.p - this.time) > 3) { if (this.source) this.seek(p.p); else this.at = p.p; this.emit('time'); }
      }
    });
    this.handlers();
  }

  emit(type, detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  get playing() { return !!this.source && !this.audio.paused; }
  get loading() { return this.busy; }
  get time() { return this.source && this.wanted == null ? this.audio.currentTime || 0 : this.wanted ?? this.at; }
  get duration() { const d = this.audio.duration; return this.source && Number.isFinite(d) && d > 0 ? d : this.known; }
  get rate() { return this.audio.playbackRate || 1; }
  get skipping() { return !!this.breaks && this.store.settings.skipAds; }

  /* ---------- where the audio comes from ---------- */

  remote(item) {
    const server = !item.noServer && (item.audio || this.store.transcripts.get(item.id)?.audio);
    if (server) return { src: server, kind: 'server', synced: true };
    if (item.url) return { src: item.url, kind: 'origin', synced: false };
    return null;
  }

  // Without waiting, when that is possible (it has to be, to start inside a tap).
  quick(item) {
    if (item.file) return { src: URL.createObjectURL(item.file), kind: 'file', synced: true, own: true };
    if (item.blob) return { src: URL.createObjectURL(item.blob), kind: 'cache', synced: true, own: true };
    if (this.downloads.has(item.id) || item.key) return null;
    return this.remote(item);
  }

  async resolve(item) {
    if (item.file || item.blob) return this.quick(item);
    if (this.downloads.has(item.id)) {
      const blob = await this.downloads.blob(item.id);
      if (blob) return { src: URL.createObjectURL(blob), kind: 'download', synced: this.downloads.info(item.id)?.from === 'server', own: true };
    }
    if (item.key) {
      const blob = await this.cachedAudio(item.key).catch(() => null);
      if (blob) return { src: URL.createObjectURL(blob), kind: 'cache', synced: true, own: true };
    }
    return this.remote(item);
  }

  release(source = this.source) {
    if (source?.own) URL.revokeObjectURL(source.src);
  }

  /* ---------- starting and stopping ---------- */

  // Plays `item` ({ id, title, show, art, url, ... }), from `at` seconds or from where it was left.
  async play(item, { at = null } = {}) {
    this.wantPlay = true;
    if (this.item?.id === item.id && this.source && !this.audio.error) {
      if (at != null) this.seek(at, { user: true });
      return this.resume();
    }
    this.save();
    const seq = ++this.seq;
    let source = null;
    if (this.ready?.id === item.id) { source = this.ready.source; this.ready = null; } else source = this.quick(item);
    if (!source) {
      // Storage has to be asked: hold the tap's permission to play with a moment of silence.
      // (It loops, and ending is ignored while there is no episode: it is not an episode.)
      if (!this.unlocked) {
        this.audio.loop = true;
        this.audio.src = this.hush ||= silence();
        this.audio.play().catch(() => {});
      } else this.audio.pause();
      this.release();
      this.source = null;
      this.setItem(item, at);
      this.busy = true;
      this.emit('state');
      source = await this.resolve(item);
      if (seq !== this.seq) { this.release(source); return false; }
    }
    if (!source) {
      this.busy = false;
      this.emit('state');
      this.emit('error', { message: 'The audio for this is no longer stored here, and there is no link to fetch it from.' });
      return false;
    }
    this.release();
    this.source = source;
    this.setItem(item, at);
    this.audio.loop = false;
    this.audio.src = source.src;
    this.applyRate();
    this.metadata();
    this.loadAds();
    this.prepare();
    // Paused while it was being found: it is in the player, and stays quiet.
    if (!this.wantPlay) { this.busy = false; this.state(); return false; }
    return this.begin();
  }

  setItem(item, at = null) {
    const progress = this.store.progress(item.id);
    this.item = item;
    this.breaks = null;
    this.inBreak = -1;
    this.keep = -1;
    this.lastSkip = null;
    this.wanted = at ?? resumeAt(progress, Date.now(), { rewind: this.store.settings.rewind });
    this.at = this.wanted;
    this.known = progress?.d || item.duration || 0;
    this.pausedAt = 0;
    try {
      const { file, blob, ...plain } = item;
      if (plain.art?.startsWith('data:')) plain.art = '';
      if (plain.url || plain.audio) localStorage.setItem(NOW, JSON.stringify(plain)); else localStorage.removeItem(NOW);
    } catch {}
    this.emit('item');
    this.emit('time');
  }

  // The episode that was in the player when the page was last open, paused where it was.
  restore() {
    let item = null;
    try { item = JSON.parse(localStorage.getItem(NOW)); } catch {}
    if (!item?.id || this.item) return;
    const progress = this.store.progress(item.id);
    this.item = item;
    this.at = progress && !progress.done ? progress.p : 0;
    this.known = progress?.d || item.duration || 0;
    this.emit('item');
    this.emit('time');
  }

  begin() {
    this.wantPlay = true;
    this.busy = true;
    this.emit('state');
    const p = this.audio.play();
    return p ? p.then(() => true, (err) => {
      if (err.name === 'AbortError') return false;
      this.busy = false;
      this.emit('state');
      if (err.name === 'NotAllowedError') this.emit('blocked');
      return false;
    }) : Promise.resolve(true);
  }

  resume() {
    if (!this.item) return Promise.resolve(false);
    if (!this.source || this.audio.error) {
      const at = this.time;
      this.source = null;
      return this.play(this.item, { at: this.store.progress(this.item.id)?.done ? 0 : at });
    }
    if (this.audio.ended || (this.duration && this.time >= this.duration - 0.5)) this.audio.currentTime = 0;
    else if (this.pausedAt && this.store.settings.rewind && this.wanted == null) {
      const back = rewindFor(Date.now() - this.pausedAt);
      if (back) this.audio.currentTime = Math.max(0, this.audio.currentTime - back);
    }
    return this.begin();
  }

  pause() {
    this.wantPlay = false;
    this.audio.pause();
    if (this.busy && !this.source) { this.busy = false; this.emit('state'); }
  }

  toggle() { return this.playing || (this.busy && this.wantPlay) ? this.pause() : this.resume(); }

  // Takes the episode out of the player.
  stop() {
    this.save();
    this.seq++;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.release();
    this.source = null;
    this.item = null;
    this.breaks = null;
    this.busy = false;
    try { localStorage.removeItem(NOW); } catch {}
    if ('mediaSession' in navigator) { try { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; } catch {} }
    this.emit('item');
    this.emit('state');
  }

  // The audio knows its length (and, the second time, can be heard): go to where we meant to be.
  arrive(again = false) {
    if (this.wanted != null) {
      const d = this.audio.duration;
      const to = Number.isFinite(d) && d > 0 ? Math.min(this.wanted, Math.max(0, d - 3)) : this.wanted;
      if (Math.abs(this.audio.currentTime - to) > 1) { try { this.audio.currentTime = to; } catch {} }
      if (again || to < 1) this.wanted = null;
    }
    this.position();
    this.emit('time');
  }

  ended() {
    const item = this.item;
    if (!item || !this.source) return;
    this.store.setProgress(item, { p: this.duration, d: this.duration, done: true });
    this.store.queueRemove(item.id);
    if (this.downloads.has(item.id) && !this.store.settings.keepDownloads) this.downloads.remove(item.id);
    const stopHere = this.sleep?.end;
    if (stopHere) this.setSleep(0);
    const next = stopHere ? null : this.store.queue[0];
    if (next) this.play(this.store.decorate(next));
    else this.state();
    this.emit('ended', { item, next });
  }

  failed() {
    if (!this.source || !this.audio.getAttribute('src')) return;
    const item = this.item;
    const at = this.time;
    // The server's copy is gone (they are kept two months): the podcast's own.
    if (this.source.kind === 'server' && item.url) {
      this.source = null;
      this.play({ ...item, noServer: true }, { at });
      return;
    }
    this.busy = false;
    this.at = at;
    this.state();
    this.emit('error', { message: navigator.onLine === false ? 'No connection. Episodes saved for offline still play.' : "Couldn't play this episode's audio." });
  }

  /* ---------- moving about ---------- */

  seek(t, { user = false } = {}) {
    const to = Math.max(0, this.duration ? Math.min(t, this.duration - 0.25) : t);
    if (user && this.breaks) this.keep = breakAt(this.breaks, to); // went into an ad on purpose
    this.pausedAt = 0; // a spot chosen on purpose is played from exactly there, however long the pause was
    if (!this.source) { this.at = to; this.emit('time'); return; }
    if (this.audio.readyState < 1) { this.wanted = to; this.emit('time'); return; }
    this.wanted = null;
    this.audio.currentTime = to;
    this.emit('time');
  }

  // Back or forward by `delta` seconds of the show: with ads being skipped, an ad on the way
  // doesn't count (going back 15 seconds just after one lands 15 seconds before it).
  skip(delta) {
    const from = this.time;
    let to = from + delta;
    if (this.skipping) {
      for (const [a, b] of this.breaks) {
        if (delta < 0 && from >= b - 0.5 && to < b) to -= b - a;
        if (delta > 0 && to >= a && to < b) to = b;
      }
    }
    this.seek(to);
  }

  // The lock screen's forward button: out of an ad when in one, else the usual jump.
  forward(seconds) {
    if (this.inBreak >= 0) this.skipAd();
    else this.skip(seconds || this.store.settings.fwd);
  }

  next() {
    const next = this.store.queue.find((e) => e.id !== this.item?.id);
    if (!next) return false;
    if (this.item) this.store.queueRemove(this.item.id);
    this.play(this.store.decorate(next));
    return true;
  }

  /* ---------- speed, sleep, volume ---------- */

  rateFor(item = this.item) {
    return this.store.show(item?.sub)?.speed || this.store.settings.speed || 1;
  }

  applyRate() {
    const r = this.rateFor();
    if (Math.abs(this.audio.playbackRate - r) < 0.001 && Math.abs(this.audio.defaultPlaybackRate - r) < 0.001) return;
    this.audio.defaultPlaybackRate = r;
    this.audio.playbackRate = r;
  }

  // For this show only when it has a speed of its own, otherwise for everything.
  setSpeed(rate) {
    const r = Math.round(Math.min(3, Math.max(0.5, rate)) * 100) / 100;
    const sub = this.store.show(this.item?.sub);
    if (sub?.speed) this.store.updateShow(sub.id, { speed: r }); else this.store.set({ speed: r });
    this.applyRate();
    this.emit('rate');
  }

  // minutes, 'end' (of this episode), or 0 for off.
  setSleep(what) {
    clearTimeout(this.sleepTimer);
    this.sleep = what === 'end' ? { end: true } : what > 0 ? { at: Date.now() + what * 60e3, minutes: what } : null;
    if (this.sleep?.at) this.sleepTimer = setTimeout(() => this.tick(), what * 60e3 + 500);
    this.emit('sleep');
  }

  get sleepLeft() { return this.sleep?.at ? Math.max(0, this.sleep.at - Date.now()) / 1000 : this.sleep?.end ? Math.max(0, this.duration - this.time) / this.rate : 0; }

  setVolume(v) {
    this.audio.volume = Math.min(1, Math.max(0, v));
    try { localStorage.setItem(VOLUME, String(this.audio.volume)); } catch {}
  }

  /* ---------- ads ---------- */

  async loadAds() {
    const { item, source } = this;
    let breaks = null;
    try { breaks = source?.synced ? await this.adsFor(item, source) : null; } catch {}
    if (this.item !== item || this.source !== source) return;
    this.setBreaks(breaks);
  }

  setBreaks(breaks) {
    this.breaks = breaks?.length ? breaks : null;
    this.inBreak = this.breaks ? breakAt(this.breaks, this.time) : -1;
    this.emit('ads');
  }

  skipAd() {
    if (this.inBreak < 0 || !this.breaks) return;
    const [, end] = this.breaks[this.inBreak];
    this.keep = -1;
    this.seek(end);
  }

  // Back into the ad that was just jumped over, and leave it alone this time.
  undoSkip() {
    if (!this.lastSkip) return;
    this.keep = this.lastSkip.index;
    this.audio.currentTime = this.lastSkip.from;
    this.lastSkip = null;
    this.emit('time');
  }

  /* ---------- while it plays ---------- */

  tick() {
    if (!this.source || this.wanted != null) return;
    const t = this.audio.currentTime;
    if (this.breaks) {
      const now = breakAt(this.breaks, t);
      if (this.keep >= 0 && now !== this.keep) this.keep = -1;
      if (this.store.settings.skipAds && !this.audio.seeking && !this.audio.paused) {
        const hit = skipAt(this.breaks, t, this.keep);
        if (hit) {
          const to = this.duration ? Math.min(hit.to, this.duration - 0.3) : hit.to;
          this.lastSkip = { from: t, index: hit.index };
          this.audio.currentTime = to;
          this.emit('skipped', { seconds: to - t });
          return;
        }
      }
      if (now !== this.inBreak) { this.inBreak = now; this.emit('ads'); }
    }
    if (this.sleep?.at && Date.now() >= this.sleep.at) {
      this.sleep = null;
      this.audio.pause();
      this.emit('sleep', { fired: true });
    }
    if (Date.now() - this.savedAt > 5000 && !this.audio.paused) this.save({ lazy: true });
    this.emit('time');
  }

  // Remembers where the episode is (not for a file, which nothing could find again).
  save({ lazy = false } = {}) {
    const item = this.item;
    if (!item || !this.source || this.wanted != null || (!item.url && !item.audio)) return;
    const p = this.audio.currentTime || 0;
    const d = this.duration;
    const had = this.store.progress(item.id);
    if (p < 2 && !had) return;
    if (had && !had.done && Math.abs(had.p - p) < 0.5 && Date.now() - this.savedAt < 60e3) return;
    this.savedAt = Date.now();
    this.store.setProgress(item, { p, d, done: finished(p, d) }, { lazy });
  }

  state() {
    this.position();
    this.emit('state');
  }

  /* ---------- the lock screen, headphones, car ---------- */

  metadata() {
    if (!('mediaSession' in navigator) || !window.MediaMetadata || !this.item) return;
    const art = this.item.art && /^https?:/.test(this.item.art) ? this.item.art : new URL('icon-512.png', location.href).href;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: this.item.title || 'Episode',
        artist: this.item.show || 'Transcriber',
        album: this.item.show || '',
        artwork: [{ src: art, sizes: '512x512' }],
      });
    } catch {}
  }

  position() {
    if (!('mediaSession' in navigator) || !this.item) return;
    try {
      navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
      const d = this.duration;
      if (d > 0 && navigator.mediaSession.setPositionState) navigator.mediaSession.setPositionState({ duration: d, playbackRate: this.rate, position: Math.min(Math.max(0, this.time), d) });
    } catch {}
  }

  // iOS shows either the jump buttons or the track buttons on the lock screen, the track ones
  // when both are answered. So they are only answered where the listener asked for them
  // (Settings: lock screen buttons), or off iOS, where both fit.
  handlers() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch {} };
    const s = this.store.settings;
    set('play', () => this.resume());
    set('pause', () => this.pause());
    set('stop', () => this.pause());
    set('seekbackward', (d) => this.skip(-(d?.seekOffset || s.back)));
    set('seekforward', (d) => this.forward(d?.seekOffset));
    set('seekto', (d) => { if (d?.seekTime != null) this.seek(d.seekTime, { user: true }); });
    const tracks = s.lockButtons === 'episodes';
    const more = this.store.queue.some((e) => e.id !== this.item?.id);
    set('previoustrack', tracks ? () => this.seek(0) : null);
    set('nexttrack', tracks || (!IS_IOS && more) ? () => { if (!this.next()) this.forward(); } : null);
  }

  // The next episode's audio, found before it is needed: when this one ends there may be no
  // time to ask storage (a phone in a pocket gives a page a moment, not more).
  async prepare() {
    const next = this.store.queue.find((e) => e.id !== this.item?.id);
    if (!next || this.ready?.id === next.id || this.preparing === next.id) return;
    if (this.ready) { this.release(this.ready.source); this.ready = null; }
    this.preparing = next.id;
    const item = this.store.decorate(next);
    const source = await this.resolve(item).catch(() => null);
    if (this.preparing === next.id) this.preparing = null;
    const still = this.store.queue.find((e) => e.id !== this.item?.id)?.id === next.id;
    if (source && still && !this.ready) this.ready = { id: next.id, source };
    else this.release(source);
  }
}
