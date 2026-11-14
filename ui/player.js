// The player: the one audio element everything plays through, whether an episode from a
// followed show, a link that was pasted, or the audio under an open transcript. It remembers
// where each episode was left, moves on through the queue, answers the lock screen's and the
// headphones' buttons (Media Session), jumps over the ads a transcript has marked, and knows the
// episode's chapters (lib/chapters.js), which are only ever jumped to by the listener, and the
// episode's shape (lib/shape.js: its loudness and who speaks when), which the player draws.
// What it decides (where to resume, which ad to skip) is in lib/playback.js.
import { resumeAt, rewindFor, finished, skipAt } from '../lib/playback.js';
import { breakAt } from '../lib/breaks.js';
import { cutsFor, cutIndex } from '../lib/quiet.js';
import { directUrl } from '../lib/direct.js';
import { chapterAt } from '../lib/chapters.js';
import { readShape, hasLoudness } from '../lib/shape.js';

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
  // for that copy of the audio, or null; quietFor(item, source, progress) -> where that copy
  // goes quiet (lib/quiet.js), or null when it can't be read; shapeFor(item, source, { listen })
  // -> that copy's shape (lib/shape.js, the stored form), or null (listen: a file here may be
  // listened through for it).
  constructor({ audio, store, downloads, cachedAudio, adsFor, quietFor = async () => null, shapeFor = async () => null }) {
    super();
    Object.assign(this, { audio, store, downloads, cachedAudio, adsFor, quietFor, shapeFor });
    this.shape = null; // the shape of the copy in the player, ready to draw (lib/shape.js readShape)
    this.shapeReady = false; // whether it has been looked for (null then means there is none)
    this.shapeSeq = 0;
    this.heard = false; // whether a file here was listened through for it
    this.quiet = null; // where the audio in the player goes quiet
    this.cuts = []; // what of that is jumped over, at the listener's limit
    this.finding = null; // how far the search for quiet has got (0 to 1), while it runs
    this.trimmed = 0; // seconds of pause left out of this episode so far
    this.seekCost = 0.1; // what a jump costs here, measured: shorter cuts are not worth making
    this.cutCost = 0.1; // ...and what it was, and the speed, when the cuts were last worked out
    this.cutRate = 1;
    this.sought = false;
    this.trimLimit = 0;
    this.item = null;
    this.source = null;
    this.breaks = null;
    this.inBreak = -1;
    this.keep = -1;
    this.lastSkip = null;
    this.chapters = []; // [{ start, title }] of the episode in the player
    this.chapter = -1; // the one being played, or -1 before the first
    this.chaptersOf = null; // the episode they are of
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
    // Media to be listened to, with the screen locked too (iOS 17 and later ask; left to guess,
    // they may treat a page's audio as sound effects, which go quiet in the background).
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}

    const on = (type, fn) => audio.addEventListener(type, fn);
    on('loadedmetadata', () => this.arrive());
    on('canplay', () => this.arrive(true));
    on('loadeddata', () => { if (this.wanted != null) this.arrive(true); });
    on('canplaythrough', () => { if (this.wanted != null) this.arrive(true); });
    on('durationchange', () => this.emit('time'));
    on('timeupdate', () => this.tick());
    on('playing', () => { this.unlocked = true; this.busy = false; this.pausedAt = 0; this.changedAt = performance.now(); this.state(); this.fine(); });
    on('play', () => { this.changedAt = performance.now(); this.state(); });
    on('pause', () => { if (this.source) { this.pausedAt = Date.now(); this.save(); } this.changedAt = performance.now(); this.state(); this.fine(); });
    on('waiting', () => { this.busy = true; this.emit('state'); });
    on('seeked', () => {
      // A jump over a pause: how long it took is what the next ones have to be worth.
      if (this.jumpedAt) {
        // (One stall is not what jumps cost: it counts for a second at most, or no pause would
        // be worth a jump again, and with no jumps made the figure would never come back down.)
        this.seekCost = this.seekCost * 0.7 + Math.min(1, (performance.now() - this.jumpedAt) / 1000) * 0.3;
        this.jumpedAt = 0;
        if (this.seekCost > this.cutCost * 1.6 || this.seekCost < this.cutCost * 0.5) this.recut();
      }
      this.position();
      this.chapterCheck();
      this.emit('time');
    });
    on('ratechange', () => { this.position(); this.emit('rate'); if (this.quiet && Math.abs(this.rate - this.cutRate) > 0.01) this.recut(); });
    on('ended', () => this.ended());
    on('error', () => this.failed());

    const leave = () => { this.save(); store.flush(); };
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') leave(); });
    store.addEventListener('change', (e) => {
      const keys = e.detail.keys || [];
      if (keys.some((k) => k === 'settings' || k.startsWith('subs/'))) { this.applyRate(); this.handlers(); this.retrim(); }
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
    if (item.url) return { src: item.direct || item.url, kind: 'origin', synced: false };
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
  // autoplay: false puts it in the player without starting it.
  async play(item, { at = null, autoplay = true } = {}) {
    this.wantPlay = autoplay;
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
    this.loadQuiet();
    this.loadShape();
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
    this.quiet = null;
    this.cuts = [];
    this.shape = null;
    this.shapeReady = false;
    this.shapeSeq++;
    this.heard = false;
    this.finding = null;
    this.sought = false;
    this.trimmed = 0;
    this.seekCost = 0.1; // another copy, another cost: measured again
    this.jumpedAt = 0;
    this.wanted = at ?? resumeAt(progress, Date.now(), { rewind: this.store.settings.rewind });
    this.at = this.wanted;
    this.known = progress?.d || item.duration || 0;
    this.pausedAt = 0;
    if (this.chaptersOf !== item.id) this.loadChapters();
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
    this.loadChapters();
    // Not loaded until it plays, but the copy it will play may already be known: its shape is.
    const next = this.downloads.has(item.id) || item.key ? null : this.remote(item);
    if (next?.synced) this.loadShape({ source: next }); else this.shapeReady = true;
    this.emit('item');
    this.emit('time');
  }

  begin() {
    this.wantPlay = true;
    this.busy = true;
    this.changedAt = performance.now();
    // play() first, while the press that asked for it (a tap, the lock screen, the AirPods) still
    // counts as one; the rest after.
    const p = this.audio.play();
    this.state(); // (iOS hears of it now, not when the audio has arrived)
    this.watch();
    return p ? p.then(() => true, (err) => {
      if (err.name === 'AbortError') return false;
      this.busy = false;
      this.wantPlay = false;
      this.state(); // (and iOS that it is not playing after all, so the next press is "play")
      if (err.name === 'NotAllowedError') this.emit('blocked');
      return false;
    }) : Promise.resolve(true);
  }

  // A file on the device has nothing to wait for and starts at once. Now and then a browser
  // leaves one loading and never starts it (seen in Safari's engine, with a file out of the
  // device's storage). What gets it going is what a listener would do: pause, and play again.
  // So one that has not moved after three seconds is paused and started again, once. Only while
  // the app is on screen: with the screen locked iOS can take longer than that to start, and it
  // does not let a page start playing by itself there, so stepping in would only silence it.
  watch() {
    clearTimeout(this.watching);
    const source = this.source;
    if (!source?.own || source.asked) return;
    const from = this.audio.currentTime;
    this.watching = setTimeout(() => {
      const a = this.audio;
      if (document.visibilityState !== 'visible' || this.source !== source || !this.wantPlay || a.error) return;
      if ((!a.paused && a.readyState >= 3) || a.currentTime !== from) return; // it is playing, or has moved
      source.asked = true;
      console.info(`player: a file on the device had not started after three seconds (ready ${a.readyState}, network ${a.networkState}): paused and started again`);
      a.pause();
      setTimeout(() => { if (this.source === source && this.wantPlay) this.begin(); }, 200);
    }, 3000);
  }

  resume() {
    if (!this.item) return Promise.resolve(false);
    if (!this.source || this.audio.error) {
      const at = this.time;
      this.source = null;
      return this.play(this.item, { at: this.store.progress(this.item.id)?.done ? 0 : at });
    }
    // Paused with the screen locked, and played again from the lock screen or the AirPods without
    // the app being opened, iOS lets the audio run on with its sound switched off (the time moves,
    // nothing is heard). Given the audio afresh, inside the press, it switches the sound on again:
    // the same file, from where it was. The same when iOS let go of the audio altogether.
    const a = this.audio;
    const away = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (this.pausedAt && (away || a.readyState === 0 || a.networkState === 3)) {
      this.wanted = Math.max(0, this.time - (this.store.settings.rewind ? rewindFor(Date.now() - this.pausedAt) : 0));
      this.asks = 0;
      a.src = this.source.src;
    } else if (a.ended || (this.duration && this.time >= this.duration - 0.5)) a.currentTime = 0;
    else if (this.pausedAt && this.store.settings.rewind && this.wanted == null) {
      const back = rewindFor(Date.now() - this.pausedAt);
      if (back) this.audio.currentTime = Math.max(0, this.audio.currentTime - back);
    }
    return this.begin();
  }

  pause() {
    this.wantPlay = false;
    this.changedAt = performance.now();
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
    this.quiet = null;
    this.cuts = [];
    this.shape = null;
    this.shapeSeq++;
    this.setChapters(null, []);
    this.fine();
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
      // Done once the audio is there (or it was the start that was wanted). A file out of the
      // device's storage is not always ready to be moved in when it first says it can play: it
      // is asked again as more of it arrives, a few seconds' worth of times, and then left.
      this.asks = (this.asks || 0) + 1;
      if (to < 1 || Math.abs(this.audio.currentTime - to) <= 1 || (again && this.asks > 8)) { this.wanted = null; this.asks = 0; }
    }
    this.position();
    this.chapterCheck();
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
    // The address from the feed often goes through services that count downloads, and content
    // blockers stop those: the file's own address, behind them, is tried once (lib/direct.js).
    if (this.source.kind === 'origin' && item.url && !item.direct && navigator.onLine !== false) {
      const direct = directUrl(item.url);
      if (direct !== item.url) {
        this.source = null;
        this.play({ ...item, direct }, { at });
        return;
      }
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
    if (!this.source) { this.at = to; this.chapterCheck(); this.emit('time'); return; }
    if (this.audio.readyState < 1) { this.wanted = to; this.chapterCheck(); this.emit('time'); return; }
    this.wanted = null;
    this.audio.currentTime = to;
    this.chapterCheck();
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

  /* ---------- chapters ---------- */

  async loadChapters() {
    const item = this.item;
    this.setChapters(item?.id ?? null, []);
    if (!item?.sub) return;
    let list = [];
    try { list = (await this.store.details(item.sub, item.id)).chapters; } catch {}
    if (this.item?.id === item.id && list.length) this.setChapters(item.id, list);
  }

  setChapters(of, list) {
    const had = this.chapters.length;
    this.chaptersOf = of;
    this.chapters = list;
    this.chapter = chapterAt(list, this.time);
    if (had || list.length) this.emit('chapters');
  }

  // The chapter playing at `t` (an index into this.chapters, or -1).
  chapterAt(t = this.time) { return chapterAt(this.chapters, t); }

  chapterCheck() {
    const i = this.chapterAt();
    if (i !== this.chapter) { this.chapter = i; this.emit('chapter'); }
  }

  // Chapters that start inside the audio as it is (a feed's chapters can run past the copy played).
  get chapterCount() {
    const d = this.duration;
    return d > 0 ? this.chapters.filter((c) => c.start < d).length : this.chapters.length;
  }

  goChapter(i) {
    const c = this.chapters[i];
    if (c && i < this.chapterCount) this.seek(c.start, { user: true });
  }

  // Back to the start of this chapter, or to the one before when it has only just begun.
  prevChapter() {
    const i = this.chapter;
    if (i >= 0 && this.time - this.chapters[i].start > 3) this.goChapter(i);
    else if (i > 0) this.goChapter(i - 1);
    else this.seek(0, { user: true });
  }

  nextChapter() { this.goChapter(this.chapter + 1); }

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

  /* ---------- the episode's shape ---------- */

  // The shape of the copy being played (or about to be): from the server, from a transcript made
  // here, or kept from listening through a file here. listen: such a file nobody has listened
  // through yet is listened through now (the same single pass that finds its pauses).
  async loadShape({ source = this.source, listen = false } = {}) {
    const { item } = this;
    if (!item || !source) { this.shapeReady = true; this.emit('shape'); return; }
    const seq = this.shapeSeq;
    let shape = null;
    try { shape = await this.shapeFor(item, source, { listen }); } catch {}
    if (seq !== this.shapeSeq || this.item !== item || (this.source && this.source !== source)) return;
    const read = readShape(shape);
    if (!read && this.shape && this.shapeReady) return;
    this.shape = read;
    this.shapeReady = true;
    this.emit('shape');
  }

  // The player was opened up on a file here that nobody transcribed: it is listened through
  // once, for its loudness (and its pauses, kept for when they are shortened).
  wantShape() {
    if (!this.source?.own || hasLoudness(this.shape) || this.heard) return;
    this.heard = true;
    this.loadShape({ listen: true });
  }

  /* ---------- pauses, shortened ---------- */

  // Finds where this copy of the audio goes quiet, when the listener wants pauses shortened.
  async loadQuiet() {
    const { item, source } = this;
    this.trimLimit = this.store.settings.trim || 0;
    if (!this.trimLimit || !source || this.quiet || this.sought) { this.recut(); return; }
    let quiet = null;
    this.sought = true; // once per copy of the audio: a search that found nothing is not run again
    this.finding = 0;
    this.emit('quiet');
    try {
      quiet = await this.quietFor(item, source, (f) => { if (this.item === item && this.source === source) { this.finding = f; this.emit('quiet'); } });
    } catch {}
    if (this.item !== item || this.source !== source) return;
    this.finding = null;
    this.quiet = quiet || null;
    this.recut();
    // (The same listening found how loud each second is: a file nobody transcribed has its shape.)
    if (source.own && !this.shape) this.loadShape();
  }

  // The limit changed (or was switched on or off).
  retrim() {
    const limit = this.store.settings.trim || 0;
    if (limit === this.trimLimit) return;
    if (limit && !this.quiet && this.source && this.finding == null) this.loadQuiet();
    else { this.trimLimit = limit; this.recut(); }
  }

  // (The limit is in the episode's own seconds; what a jump costs is in the listener's, so at
  // twice the speed it is twice as much of the episode.)
  recut() {
    this.cutCost = this.seekCost;
    this.cutRate = this.rate;
    this.cuts = this.quiet && this.trimLimit ? cutsFor(this.quiet, this.trimLimit, this.seekCost * this.rate) : [];
    this.fine();
    this.emit('quiet');
  }

  // The player's own clock ticks four times a second, too coarse for a half-second pause:
  // while there are pauses to shorten and it is playing, a finer one runs.
  fine() {
    const need = this.cuts.length > 0 && this.playing;
    if (need && !this.fineTimer) this.fineTimer = setInterval(() => this.trim(), 60);
    if (!need && this.fineTimer) { clearInterval(this.fineTimer); this.fineTimer = 0; }
  }

  trim() {
    if (!this.cuts.length || !this.source || this.wanted != null || this.audio.paused || this.audio.seeking) return;
    const t = this.audio.currentTime;
    const cut = this.cuts[cutIndex(this.cuts, t)];
    if (!cut || t < cut[0] || cut[1] - t < this.cutCost * this.cutRate + 0.12) return;
    if (this.breaks && breakAt(this.breaks, t) >= 0) return; // an ad is dealt with as an ad
    const to = this.duration ? Math.min(cut[1], this.duration - 0.3) : cut[1];
    if (to <= t) return;
    this.trimmed += to - t;
    this.jumpedAt = performance.now();
    this.audio.currentTime = to;
  }

  // The same episode from the copy now saved on the device (where its pauses can be found),
  // without losing its place.
  reattach() {
    if (!this.item || !this.source) return;
    const at = this.time;
    const playing = this.playing;
    const item = this.item;
    this.save();
    this.release();
    this.source = null;
    return this.play(item, { at, autoplay: playing });
  }

  /* ---------- while it plays ---------- */

  tick() {
    if (this.source && this.wanted != null) this.arrive(true); // (still on its way to where it was to be)
    if (!this.source || this.wanted != null) return;
    this.trim();
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
    this.chapterCheck();
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

  // (Starting counts as playing: told "paused" while an episode is on its way, iOS takes the
  // next press of the headphones for "play".)
  get going() { return this.playing || (this.busy && this.wantPlay); }

  position() {
    if (!('mediaSession' in navigator) || !this.item) return;
    try {
      navigator.mediaSession.playbackState = this.going ? 'playing' : 'paused';
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
    set('play', () => this.command('play'));
    set('pause', () => this.command('pause'));
    set('stop', () => this.pause());
    set('seekbackward', (d) => this.skip(-(d?.seekOffset || s.back)));
    set('seekforward', (d) => this.forward(d?.seekOffset));
    set('seekto', (d) => { if (d?.seekTime != null) this.seek(d.seekTime, { user: true }); });
    const tracks = s.lockButtons === 'episodes';
    const more = this.store.queue.some((e) => e.id !== this.item?.id);
    set('previoustrack', tracks ? () => this.seek(0) : null);
    set('nexttrack', tracks || (!IS_IOS && more) ? () => { if (!this.next()) this.forward(); } : null);
  }

  // What a play or pause from the headphones, the lock screen or the car means. iOS can have
  // the state the wrong way round, and then a press of the AirPods that should pause arrives as
  // "play" (and is lost), and once paused every press arrives as "pause" (and nothing plays
  // again). So a command for what is already the case is taken as the press it was: the other
  // one. Unless the state changed in the last second: then it is the system saying what it just
  // did itself (taking the AirPods out pauses, and says so), or the same press twice.
  command(want) {
    const going = this.going;
    const fresh = performance.now() - (this.changedAt || 0) < 1000;
    if (want === 'play') {
      if (!going) return this.resume();
      if (!fresh) return this.pause();
    } else {
      if (going) return this.pause();
      if (!fresh) return this.resume();
    }
    this.position(); // (and iOS is told how it really is)
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
