import { indexMp3 } from './lib/mp3.js';
import { MODELS, modelFor, recommendedModel } from './lib/models.js';
import { AUDIO_EXT, audioCandidates, parseFeed, looksLikeFeed, findAudioInHtml, normalizeLink } from './lib/links.js';
import { fmtTime, normTitle, bestTitleMatch, sameShow } from './lib/text.js';
import { indexWav, wavPiece } from './lib/wav.js';
import { toSrt, toVtt } from './lib/subtitles.js';
import { tidy, plainText, wordCount, startsParagraph } from './lib/paragraphs.js';
import { guessNames, speakerName, labelParts } from './lib/speakers.js';
import { nameGroups, glossaryFor } from './lib/names.js';
import { isAd } from './lib/ads.js';
import { id3Length, parseId3 } from './lib/id3.js';
import { encodeLevels, decodeLevels } from './lib/levels.js';
import { Waveform } from './ui/waveform.js';
import { extractTerms } from './lib/context.js';
import { correctText, parseGlossary } from './lib/glossary.js';
import { listEntries, getEntry, saveEntry, deleteEntry } from './ui/library.js';

const $ = (sel) => document.querySelector(sel);

const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_MOBILE = IS_IOS || /Android/i.test(navigator.userAgent);

const els = {
  form: $('#url-form'), url: $('#url'), go: $('#go'), paste: $('#paste'), models: $('#models'), file: $('#file'), proxy: $('#proxy'), glossary: $('#glossary'), speakers: $('#speakers'), namesBtn: $('#names-btn'), namesPanel: $('#names-panel'), namesList: $('#names-list'),
  deviceHint: $('#device-hint'), modelNote: $('#model-note'), refineBar: $('#refine-bar'), refineModel: $('#refine-model'), refineAll: $('#refine-all'), selPill: $('#sel-pill'), selModel: $('#sel-model'), stepTranscribe: $('#step-transcribe'),
  settings: $('#settings'), settingsToggle: $('#settings-toggle'), settingsSummary: $('#settings-summary'),
  episodesCard: $('#episodes-card'), feedTitle: $('#feed-title'), feedCount: $('#feed-count'), feedArt: $('#feed-art'),
  episodesNote: $('#episodes-note'), episodes: $('#episodes'), filter: $('#episode-filter'),
  progressCard: $('#progress-card'), art: $('#art'), show: $('#session-show'), title: $('#episode-title'), steps: $('#steps'),
  stage: $('#stage'), detail: $('#detail'), stats: $('#stats'), cancel: $('#cancel'), sessionClose: $('#session-close'),
  play: $('#play'), waveWrap: $('#wave-wrap'), wave: $('#wave'), waveTip: $('#wave-tip'),
  errorCard: $('#error-card'), errorTitle: $('#error-title'), error: $('#error'), errorRetry: $('#error-retry'), errorFile: $('#error-file'), errorClose: $('#error-close'),
  resumeCard: $('#resume-card'), resumeArt: $('#resume-art'), resumeText: $('#resume-text'), resumeWhy: $('#resume-why'), resumeMeter: $('#resume-meter'),
  resultCard: $('#result-card'), transcript: $('#transcript'), tail: $('#tail'), tailText: $('#tail-text'), readerFoot: $('#reader-foot'),
  search: $('#search'), findWrap: $('#search').closest('.find'), findCount: $('#find-count'), findPrev: $('#find-prev'), findNext: $('#find-next'),
  copy: $('#copy'), exportMenu: $('#export-menu'), exportBtn: $('#export'), download: $('#download'), downloadSrt: $('#download-srt'), downloadVtt: $('#download-vtt'), share: $('#share'),
  timestamps: $('#timestamps'),
  library: $('#library'), libraryList: $('#library-list'),
  jump: $('#jump-live'), dock: $('#dock'), dockPlay: $('#dock-play'), dockCopy: $('#dock-copy'), dockSave: $('#dock-save'),
  mini: $('#mini'), miniArt: $('#mini-art'), miniTitle: $('#mini-title'), miniStatus: $('#mini-status'), miniPlay: $('#mini-play'), miniBar: $('#mini-bar'),
  dropzone: $('#dropzone'), toast: $('#toast'), announce: $('#announce'), audio: $('#audio'),
};

const state = {
  gpu: { available: false, f16: false },
  worker: null,
  abort: null,
  segments: [],
  segEls: [],
  lastPara: null,
  busy: false,
  feed: null,
  wakeLock: null,
  rejectRun: null,
  job: null,
  jobSeq: 0,
  source: null,       // what is on screen: { title, show, art, url, fileId, key }
  sourceFile: null,   // a picked File, for playback
  audioKey: null,
  audioReadyFor: null,
  audioObjectUrl: null,
  playable: false,
  playingIdx: -1,
  userScrolledAt: 0,
  sessionOffscreen: false,
  lastAttempt: null,
  runStartedAt: 0,
  find: { ranges: [], index: -1 },
  canShareFiles: false,
  voices: [],         // voice prints heard so far, so labels stay the same across resumes and refines
  speakerNames: {},   // names the reader gave
  guessed: {},        // names from introductions ("I'm Derek Thompson")
};

const wave = new Waveform(els.waveWrap, els.wave, els.waveTip, { onSeek: (t) => playFrom(t) });

/* ---------- small helpers ---------- */

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const cancelled = () => new DOMException('Cancelled', 'AbortError');

function fmtBytes(n) {
  if (!n) return '0 MB';
  return n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;
}

// "8 min", "1 h 12 min", "under a minute"
function fmtSpan(sec) {
  if (!isFinite(sec) || sec < 0) return '';
  if (sec < 45) return sec < 1 ? 'a moment' : `${Math.round(sec)} s`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

const fmtNum = (n) => Number(n || 0).toLocaleString();

function language() {
  return document.querySelector('input[name=lang]:checked').value;
}

const LANG_NAMES = { english: 'English', norwegian: 'Norsk', danish: 'Dansk' };

class UserError extends Error {
  // retry: false for mistakes in what was pasted, where trying again can't help.
  constructor(message, { retry = true } = {}) {
    super(message);
    this.retry = retry;
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function icon(name, cls = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function setIcon(button, name) {
  button.querySelector('use')?.setAttribute('href', `#i-${name}`);
}

let toastTimer = 0;
function toast(text) {
  els.toast.textContent = text;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2400);
}

function announce(text) {
  els.announce.textContent = '';
  setTimeout(() => { els.announce.textContent = text; }, 50);
}

/* ---------- artwork ---------- */

function hash(str) {
  let h = 2166136261;
  for (const c of str || '') h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

// Cover art with a soft glow behind it, or a generated cover (colours from the title) when
// there is none or it fails to load.
function artInto(box, { art, title, show } = {}, { loading = false } = {}) {
  box.replaceChildren();
  box.classList.toggle('loading', loading);
  const size = box.getBoundingClientRect().width || parseFloat(getComputedStyle(box).width) || 64;
  box.style.setProperty('--size', `${size}px`);
  const fallback = () => {
    box.replaceChildren();
    const f = el('div', 'art-fallback');
    const h = hash(show || title || 'x');
    f.style.setProperty('--h1', String(h % 360));
    f.style.setProperty('--h2', String((h % 360 + 30 + ((h >> 9) % 70)) % 360));
    if (!loading) f.textContent = ((show || title || '').match(/[\p{L}\p{N}]/u)?.[0] || '♪').toUpperCase();
    box.append(f);
  };
  if (!art || loading) return fallback();
  const glow = el('img', 'art-glow');
  const img = el('img', 'art-img');
  for (const i of [glow, img]) {
    i.decoding = 'async';
    i.referrerPolicy = 'no-referrer';
    i.src = art;
  }
  glow.alt = '';
  glow.setAttribute('aria-hidden', 'true');
  img.alt = '';
  img.addEventListener('error', fallback, { once: true });
  box.append(glow, img);
}

/* ---------- session card: steps, status, stats ---------- */

const STEPS = ['find', 'download', 'model', 'draft', 'transcribe'];
const STEP_OF = [
  [/^(Looking up|Reading link|Finding)/, 'find'],
  [/^Downloading episode/, 'download'],
  [/speech model/i, 'model'],
  [/^Sketching/, 'draft'],
  [/^(Transcribing|Refining)/, 'transcribe'],
  [/^Done/, 'done'],
];

function showSteps(drafting) {
  els.steps.querySelector('[data-step=draft]').classList.toggle('hidden', !drafting);
  els.stepTranscribe.textContent = drafting ? 'Refine' : 'Transcribe';
}

function setStep(step) {
  const at = step === 'done' ? STEPS.length : STEPS.indexOf(step);
  if (at < 0) return;
  els.steps.classList.remove('failed', 'stopped');
  els.steps.querySelectorAll('li').forEach((li, i) => {
    li.classList.toggle('done', i < at);
    li.classList.toggle('active', i === at);
  });
}

function renderStats(items) {
  els.stats.replaceChildren(...(items || []).map(({ v, l }) => {
    const s = el('span', 'stat', v);
    if (l) s.append(el('small', '', l));
    return s;
  }));
}

function progress(stage, fraction, detail = '', stats = null) {
  els.stage.textContent = stage;
  els.detail.textContent = detail;
  const step = STEP_OF.find(([re]) => re.test(stage))?.[1];
  if (step) setStep(step);
  if (step === 'download') wave.setDownload(fraction);
  const waiting = fraction == null && step !== 'transcribe' && step !== 'draft' && step !== 'done';
  els.waveWrap.classList.toggle('loading', waiting && step !== undefined);
  if (stats || step !== 'transcribe') renderStats(stats);
  updateMediaSession();
  if (step === 'transcribe' || step === 'draft') {
    const word = stage === 'Refining' ? 'Refining' : stage === 'Sketching' ? 'Sketching' : 'Listening';
    els.tailText.textContent = stats?.[0]?.v ? `${word} · ${stats[0].v}` : word;
  }
  updateMini();
}

function showError(msg, title = "That didn't work", { retry = true } = {}) {
  els.errorTitle.textContent = title;
  els.error.textContent = msg;
  els.errorCard.classList.remove('hidden');
  els.errorRetry.classList.toggle('hidden', !retry || !state.lastAttempt);
}

function clearError() {
  els.errorCard.classList.add('hidden');
}

/* ---------- names and terms ----------
 * From the show notes and the reader's own glossary: they go into Whisper's prompt, and
 * near-misses in the text are corrected. */
function userGlossary() {
  return parseGlossary(store.get('glossary', ''));
}

function vocabulary(source) {
  const user = userGlossary();
  const auto = extractTerms(source?.notes || '', source?.title || '', source?.show || '');
  return { terms: [...new Set([...user.terms, ...auto])].slice(0, 50), replace: user.replace };
}

/* ---------- speakers ---------- */

const speakersOn = () => store.get('speakers', '1') === '1';
const names = () => ({ ...state.guessed, ...state.speakerNames });

function refreshNames() {
  state.guessed = guessNames(state.segments, state.vocab?.terms || []);
  const n = names();
  for (const chip of els.transcript.querySelectorAll('.who')) chip.textContent = speakerName(chip.dataset.speaker, n);
}

function whoChip(speaker) {
  const chip = el('button', 'who', speakerName(speaker, names()));
  chip.type = 'button';
  chip.dataset.speaker = speaker;
  chip.dataset.hue = Number(speaker) % 6;
  chip.title = 'Rename this speaker';
  return chip;
}

// Renaming a speaker renames every paragraph they speak, here and in the saved copy.
function renameSpeaker(chip) {
  const id = chip.dataset.speaker;
  const input = el('input', 'who-edit');
  input.value = speakerName(id, names());
  input.setAttribute('aria-label', 'Speaker name');
  chip.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    input.replaceWith(chip);
    if (!save) return;
    if (name && name !== `Speaker ${Number(id) + 1}`) state.speakerNames[id] = name; else delete state.speakerNames[id];
    refreshNames();
    if (state.job) saveJob({ ...state.job, speakerNames: state.speakerNames });
    if (state.entryId && !state.busy) {
      const entry = await getEntry(state.entryId);
      if (entry) await saveEntry({ ...entry, speakerNames: state.speakerNames });
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
}

// A new glossary also fixes the transcript on screen, not just the next one.
async function applyGlossary() {
  store.set('glossary', els.glossary.value.trim());
  state.vocab = vocabulary(state.source);
  if (state.busy || !state.segments.length) return;
  let changed = 0;
  for (const s of state.segments) {
    const fixed = correctText(s.text, state.vocab);
    if (fixed !== s.text) { s.text = fixed; changed++; }
  }
  if (!changed) return;
  rebuildTranscript();
  if (state.entryId) {
    const entry = await getEntry(state.entryId);
    if (entry) await saveEntry({ ...entry, segments: state.segments });
  }
  toast(changed === 1 ? '1 passage corrected' : `${changed} passages corrected`);
}

/* ---------- keep running in the background (phones) ----------
 * iOS suspends a page, and its workers, as soon as another app is in front, unless the page is
 * playing audio. While a transcript is being made, a silent track plays and the lock screen
 * shows the progress. It starts inside the tap that started the job, as iOS requires. */
let keepAlive = null;

function silentWav(seconds = 2, rate = 8000) {
  const n = seconds * rate;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  return new Blob([buf], { type: 'audio/wav' });
}

function startKeepAlive() {
  if (!IS_MOBILE) return;
  if (!keepAlive) {
    keepAlive = new Audio(URL.createObjectURL(silentWav()));
    keepAlive.loop = true;
    keepAlive.setAttribute('playsinline', '');
  }
  if (!audio.paused) return; // the episode itself is playing, which keeps the page alive anyway
  keepAlive.play().catch(() => {});
}

function stopKeepAlive() {
  keepAlive?.pause();
  if ('mediaSession' in navigator && audio.paused) navigator.mediaSession.metadata = null;
}

let sessionLine = '';
function updateMediaSession() {
  if (!IS_MOBILE || !('mediaSession' in navigator) || !window.MediaMetadata || !state.busy) return;
  const line = `${els.stage.textContent}${wave.total && (wave.done || wave.draftDone) ? ` · ${fmtTime(wave.done || wave.draftDone)} / ${fmtTime(wave.total)}` : ''}`;
  if (line === sessionLine) return;
  sessionLine = line;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: state.source?.title || 'Transcriber',
      artist: line,
      album: 'Transcriber',
      artwork: state.source?.art && !state.source.art.startsWith('data:') ? [{ src: state.source.art, sizes: '600x600' }] : [],
    });
  } catch {}
}

function setBusy(busy) {
  if (busy) startKeepAlive(); else stopKeepAlive();
  if (busy) els.refineBar.classList.add('hidden');
  state.busy = busy;
  window.__transcriberBusy = busy; // coi-sw.js never reloads the page while this is set
  document.body.classList.toggle('busy', busy);
  els.go.disabled = busy;
  els.file.disabled = busy;
  els.cancel.classList.toggle('hidden', !busy);
  els.sessionClose.classList.toggle('hidden', busy);
  els.tail.classList.toggle('hidden', !busy);
  els.readerFoot.classList.toggle('hidden', busy || !state.segments.length);
  if (!busy) els.jump.classList.add('hidden');
  if (busy) acquireWakeLock(); else releaseWakeLock();
  updateMini();
}

async function acquireWakeLock() {
  if (state.wakeLock) return;
  try {
    const lock = await navigator.wakeLock?.request('screen');
    // The job may have finished while the request was pending.
    if (state.busy && !state.wakeLock) state.wakeLock = lock;
    else lock?.release().catch(() => {});
  } catch {}
}

function releaseWakeLock() {
  state.wakeLock?.release?.().catch(() => {});
  state.wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // Time spent in the background (suspended by the OS) doesn't count as the model stalling.
  state.lastHeard = Date.now();
  state.wakeLock = null; // browsers release the lock when the page is hidden
  if (state.busy) acquireWakeLock();
});

/* ---------- network ---------- */

// Direct first, then the user's own CORS proxy if they set one. Free public proxies
// all died or started requiring keys, so none are built in.
function proxyChain() {
  const custom = els.proxy.value.trim();
  const chain = [(u) => u];
  if (custom) {
    chain.push((u) => custom.includes('{url}') ? custom.replace('{url}', encodeURIComponent(u)) : custom + encodeURIComponent(u));
  }
  return chain;
}

async function smartFetch(url, { accept } = {}) {
  let firstErr;
  for (const make of proxyChain()) {
    const signal = state.abort?.signal;
    try {
      const res = await fetch(make(url), { signal, redirect: 'follow', headers: accept ? { Accept: accept } : undefined });
      if (res.ok) return res;
      firstErr ??= new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (signal?.aborted) throw err;
      firstErr ??= err;
    }
  }
  throw new UserError(
    `Couldn't read ${url}\n(${firstErr?.message || 'network error'}).\n\n` +
    `That server doesn't allow web pages to read it. Try the episode's Apple Podcasts or Pocket Casts link instead.`
  );
}

async function fetchText(url) {
  const res = await smartFetch(url);
  return { text: await res.text(), type: res.headers.get('content-type') || '' };
}

function jsonp(url, timeout = 15000) {
  const signal = state.abort?.signal;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const cb = `__jsonp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    const cleanup = () => {
      window[cb] = () => {}; // a late response must not hit an undefined function
      script.remove();
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => { cleanup(); reject(cancelled()); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Request timed out')); }, timeout);
    signal?.addEventListener('abort', onAbort);
    window[cb] = (data) => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error('Request failed')); };
    script.src = `${url}${url.includes('?') ? '&' : '?'}callback=${cb}`;
    document.head.appendChild(script);
  });
}


// Episodes are kept in the browser's disk cache (Cache Storage) and read back a piece at a
// time, so a 100 MB file never sits in memory, and a reloaded page can resume without
// downloading it again. Only the current episode is kept.
const AUDIO_CACHE = 'transcriber-audio';
const audioKey = (id) => `https://transcriber.invalid/audio?id=${encodeURIComponent(id)}`;

async function openAudioCache() {
  try { return await caches.open(AUDIO_CACHE); } catch { return null; }
}

async function cachedAudio(key) {
  try {
    const hit = await (await openAudioCache())?.match(key);
    return hit ? await hit.blob() : null;
  } catch {
    return null;
  }
}

// Stores the response on disk and returns a Blob backed by it. `fallback` produces the audio
// another way (in memory) when Cache Storage is missing, full, or evicts the entry.
async function storeAudio(key, response, fallback) {
  const cache = await openAudioCache();
  if (cache) {
    try {
      for (const old of await cache.keys()) if (old.url !== key) await cache.delete(old);
      await cache.put(key, response);
      const hit = await cache.match(key);
      if (hit) return await hit.blob();
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      console.warn('Could not keep the episode in Cache Storage, using memory instead', err);
    }
  }
  return fallback();
}

async function forgetAudio(key) {
  try { await (await openAudioCache())?.delete(key); } catch {}
}

async function openAudio(url) {
  for (const candidate of audioCandidates(url)) {
    try {
      return await smartFetch(candidate);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
    }
  }
  throw new UserError(
    "The podcast's host doesn't allow web pages to download its audio, so this episode can't be fetched from the browser.\n\n" +
    'Download the episode yourself and pick the file under "More options", or add your own CORS proxy there.'
  );
}

function counting(res, label) {
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  return res.body.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      got += chunk.length;
      progress(label, total ? got / total : null, total ? `${fmtBytes(got)} of ${fmtBytes(total)}` : fmtBytes(got));
      ctl.enqueue(chunk);
    },
  }));
}

async function downloadAudio(url, key) {
  const cached = await cachedAudio(key);
  if (cached) return cached;

  // Mobile connections drop; start over (from the cache-busting fresh request) a couple of times.
  for (let attempt = 1; ; attempt++) {
    progress('Downloading episode', null, attempt > 1 ? `Connection dropped, retrying (${attempt} of 3)` : 'Connecting');
    try {
      const res = await openAudio(url);
      const type = res.headers.get('content-type') || 'audio/mpeg';
      return await storeAudio(key, new Response(counting(res, 'Downloading episode'), { headers: { 'content-type': type } }),
        async () => (await openAudio(url)).blob());
    } catch (err) {
      if (err instanceof UserError || err.name === 'AbortError' || attempt >= 3) {
        if (err instanceof UserError || err.name === 'AbortError') throw err;
        throw new UserError(`The download kept failing (${err.message || 'network error'}). Check the connection and try again.`);
      }
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

/* ---------- link resolution ---------- */





async function resolveFeed(url, preferTitle) {
  const { text } = await fetchText(url);
  const feed = parseFeed(text);
  if (!feed?.episodes.length) throw new UserError('Found the podcast feed, but it has no playable episodes.');
  if (preferTitle) {
    const hit = bestTitleMatch(feed.episodes, preferTitle);
    if (hit) return { kind: 'audio', url: hit.url, title: hit.title, show: feed.title, art: hit.art || feed.image, notes: hit.notes };
  }
  return { kind: 'list', ...feed };
}



const ITUNES_COUNTRIES = ['us', 'no', 'dk', 'se', 'gb'];

async function itunesLookupEpisodes(showId) {
  for (const country of ITUNES_COUNTRIES) {
    try {
      const data = await jsonp(`https://itunes.apple.com/lookup?id=${showId}&entity=podcastEpisode&limit=200&country=${country}`);
      const results = data?.results || [];
      const show = results.find((r) => r.kind === 'podcast' || r.wrapperType === 'track');
      const art = show?.artworkUrl600 || show?.artworkUrl100 || '';
      const episodes = results
        .filter((r) => r.wrapperType === 'podcastEpisode' && r.episodeUrl)
        .map((e) => ({
          id: String(e.trackId), title: e.trackName, url: e.episodeUrl, date: e.releaseDate,
          duration: e.trackTimeMillis ? fmtTime(e.trackTimeMillis / 1000) : '',
          art: e.artworkUrl600 || e.artworkUrl160 || art, show: e.collectionName || show?.collectionName || '',
          notes: e.description || e.shortDescription || '',
        }));
      if (show || episodes.length) return { show, episodes, art };
    } catch {}
  }
  return { show: null, episodes: [], art: '' };
}

// Searches Apple's podcast directory (JSONP, so no CORS needed) across a few storefronts.
async function itunesSearch(term, entity, keep = () => true) {
  for (const country of ITUNES_COUNTRIES) {
    try {
      const data = await jsonp(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=${entity}&limit=50&country=${country}`);
      const results = (data?.results || []).filter(keep);
      if (results.length) return results;
    } catch {}
  }
  return [];
}


async function resolveApple(u) {
  const showId = u.pathname.match(/id(\d+)/)?.[1];
  const episodeId = u.searchParams.get('i');
  if (!showId) throw new UserError("Couldn't find the podcast ID in that Apple Podcasts link.");

  progress('Looking up the episode', null, 'Apple Podcasts');
  const { show, episodes, art } = await itunesLookupEpisodes(showId);
  if (episodeId) {
    const ep = episodes.find((e) => e.id === episodeId);
    if (ep) return { kind: 'audio', url: ep.url, title: ep.title, show: ep.show, art: ep.art, notes: ep.notes };
  }
  if (show?.feedUrl) {
    try { return await resolveFeed(show.feedUrl); } catch (err) { if (err.name === 'AbortError') throw err; }
  }
  if (episodes.length) {
    return { kind: 'list', title: show?.collectionName || 'Episodes', image: art, episodes, note: episodeId ? "Couldn't find that exact episode, pick it from the list." : '' };
  }
  throw new UserError("Couldn't load that podcast from Apple. Try its RSS feed or Pocket Casts link instead.");
}

// Find an episode (or a show's episode list) by name through Apple's directory.
async function findByName(showName, episodeTitle) {
  if (episodeTitle) {
    const eps = await itunesSearch(`${episodeTitle} ${showName || ''}`.trim(), 'podcastEpisode',
      (e) => e.episodeUrl && (!showName || sameShow(e.collectionName, showName)));
    const hit = bestTitleMatch(eps.map((e) => ({ title: e.trackName, url: e.episodeUrl, show: e.collectionName, art: e.artworkUrl600 || e.artworkUrl160, notes: e.description || e.shortDescription })), episodeTitle);
    if (hit) return { kind: 'audio', ...hit };
  }
  if (!showName) return null;

  const shows = await itunesSearch(showName, 'podcast', (s) => sameShow(s.collectionName, showName));
  const show = shows.find((s) => normTitle(s.collectionName) === normTitle(showName)) || shows[0];
  if (!show) return null;
  const { episodes, art } = await itunesLookupEpisodes(show.collectionId);
  if (episodeTitle) {
    const hit = bestTitleMatch(episodes, episodeTitle);
    if (hit) return { kind: 'audio', url: hit.url, title: hit.title, show: hit.show, art: hit.art, notes: hit.notes };
  } else if (episodes.length) {
    return { kind: 'list', title: show.collectionName, image: art || show.artworkUrl600, episodes };
  }
  if (show.feedUrl) {
    try {
      const res = await resolveFeed(show.feedUrl, episodeTitle);
      if (!episodeTitle || res.kind === 'audio') return res;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
    }
  }
  return null;
}

async function oembed(endpoint, url) {
  try {
    const res = await fetch(`${endpoint}?url=${encodeURIComponent(url)}`, { signal: state.abort?.signal });
    return res.ok ? await res.json() : null;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return null;
  }
}

async function resolveSpotify(u) {
  const isEpisode = u.pathname.includes('/episode/');
  if (!isEpisode && !u.pathname.includes('/show/')) throw new UserError('That Spotify link is not a podcast show or episode.');

  progress('Looking up the episode', null, 'Spotify audio is locked down, so finding the same episode elsewhere');
  const info = await oembed('https://open.spotify.com/oembed', u.href);
  const title = info?.title?.trim();
  if (!title) throw new UserError("Spotify didn't recognise that link. Try the Apple Podcasts or Pocket Casts link for the same podcast.");

  if (isEpisode) {
    // Spotify doesn't say which show the episode is from, so only an exact title match is used
    // automatically; otherwise the user picks from the closest matches.
    const eps = await itunesSearch(title, 'podcastEpisode', (e) => e.episodeUrl);
    const exact = eps.filter((e) => normTitle(e.trackName) === normTitle(title));
    if (exact.length === 1) return { kind: 'audio', url: exact[0].episodeUrl, title: exact[0].trackName, show: exact[0].collectionName, art: exact[0].artworkUrl600 || exact[0].artworkUrl160, notes: exact[0].description };
    const words = new Set(normTitle(title).split(' '));
    const close = (exact.length ? exact : eps)
      .map((e) => ({ e, shared: normTitle(e.trackName).split(' ').filter((w) => words.has(w)).length }))
      .filter((x) => x.shared >= Math.min(2, words.size))
      .sort((a, b) => b.shared - a.shared)
      .slice(0, 10)
      .map(({ e }) => ({ title: e.trackName, show: e.collectionName, url: e.episodeUrl, date: e.releaseDate, duration: e.trackTimeMillis ? fmtTime(e.trackTimeMillis / 1000) : '', art: e.artworkUrl600 || e.artworkUrl160, notes: e.description }));
    if (close.length) return { kind: 'list', title: `Which episode is "${title}"?`, image: info.thumbnail_url || '', episodes: close };
    throw new UserError(
      `Couldn't find "${title}" in Apple's podcast directory. Spotify links don't say which show an episode belongs to, ` +
      `so it has to be found by title, and very new episodes (the last day or two) aren't searchable yet. ` +
      `It may also be a Spotify exclusive, which can't be transcribed. The episode's Apple Podcasts or Pocket Casts link works more reliably.`
    );
  }
  // For a show link, Spotify's oEmbed only gives the newest episode's title, not the show's name.
  const eps = await itunesSearch(title, 'podcastEpisode', (e) => e.episodeUrl);
  const hit = bestTitleMatch(eps.map((e) => ({ title: e.trackName, showId: e.collectionId })), title);
  if (hit) {
    const { show, episodes, art } = await itunesLookupEpisodes(hit.showId);
    if (episodes.length) return { kind: 'list', title: show?.collectionName || 'Episodes', image: art, episodes };
  }
  throw new UserError(
    "Spotify show links don't include the show's name, so this one can't be looked up. " +
    "Paste a Spotify episode link, or the show's Apple Podcasts or Pocket Casts link."
  );
}

// Pocket Casts pages don't allow browser access, but their oEmbed endpoint does. It gives
// "Episode - Show" plus the show name, which we then look up in Apple's directory.
async function resolvePocketCasts(u) {
  progress('Looking up the episode', null, 'Pocket Casts');
  const info = await oembed('https://pca.st/oembed.json', u.href);
  let show = info?.author_name?.trim() || '';
  let episode = null;
  if (info?.title) {
    const t = info.title.trim();
    if (show && t.endsWith(` - ${show}`)) episode = t.slice(0, -(show.length + 3)).trim();
    else if (!show) show = t;
    else if (normTitle(t) !== normTitle(show)) episode = t;
  } else {
    // Show pages on pocketcasts.com carry the show's name in the URL: /podcast/<slug>/<uuid>
    const slug = u.pathname.match(/\/podcast\/([^/]+)\/[0-9a-f-]{36}/i)?.[1];
    if (slug) show = decodeURIComponent(slug).replace(/-/g, ' ');
  }
  if (!show && !episode) {
    throw new UserError(
      "Pocket Casts didn't give any details for that link. Share an episode link from Pocket Casts " +
      '(it looks like pca.st/episode/…), or use the Apple Podcasts link.'
    );
  }

  const found = await findByName(show, episode);
  if (found) return found;
  throw new UserError(
    `Found "${episode || show}" on Pocket Casts, but couldn't find its audio in Apple's podcast directory. ` +
    `Try the podcast's RSS feed, or download the episode and pick the file under "More options".`
  );
}

async function resolveLink(raw) {
  let u;
  try { u = new URL(normalizeLink(raw)); } catch { throw new UserError("That doesn't look like a link. Copy the episode's link from your podcast app (Share, then Copy link) and paste it here.", { retry: false }); }
  const host = u.hostname.replace(/^www\./, '');

  if (host === 'podcasts.apple.com' || host === 'itunes.apple.com') return resolveApple(u);
  if (host === 'open.spotify.com') return resolveSpotify(u);
  if (host === 'pca.st' || host.endsWith('pocketcasts.com')) return resolvePocketCasts(u);
  if (AUDIO_EXT.test(u.pathname)) return { kind: 'audio', url: u.href, title: decodeURIComponent(u.pathname.split('/').pop()) };

  progress('Reading link', null, u.host);
  const res = await smartFetch(u.href);
  const type = res.headers.get('content-type') || '';
  const size = Number(res.headers.get('content-length')) || 0;
  if (/^(audio|video)\/|octet-stream/i.test(type) || size > 20e6) {
    res.body?.cancel().catch(() => {});
    return { kind: 'audio', url: u.href, title: decodeURIComponent(u.pathname.split('/').pop()) || u.host };
  }
  const text = await res.text();
  if (looksLikeFeed(text)) {
    const feed = parseFeed(text);
    if (feed?.episodes.length) return { kind: 'list', ...feed };
  }
  const found = findAudioInHtml(text, u.href);
  if (found?.kind === 'audio') return found;
  if (found?.kind === 'feed') return resolveFeed(found.url, found.title);
  throw new UserError("Couldn't find any podcast audio on that page. Try the Apple Podcasts link, the RSS feed, or a direct .mp3 link.");
}

/* ---------- episode picker ---------- */

function showEpisodes(feed) {
  state.feed = feed;
  els.feedTitle.textContent = feed.title || 'Pick an episode';
  els.feedCount.textContent = `${fmtNum(feed.episodes.length)} episode${feed.episodes.length === 1 ? '' : 's'}`;
  artInto(els.feedArt, { art: feed.image || feed.episodes[0]?.art, title: feed.title });
  els.episodesNote.textContent = feed.note || '';
  els.episodesNote.classList.toggle('hidden', !feed.note);
  els.filter.value = '';
  renderEpisodes();
  els.episodesCard.classList.remove('hidden');
  updateLayout();
  els.episodesCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!IS_MOBILE) els.filter.focus({ preventScroll: true });
}

function renderEpisodes() {
  const q = normTitle(els.filter.value);
  const feed = state.feed;
  const items = [];
  let n = 0;
  for (const ep of feed?.episodes || []) {
    if (q && !normTitle(`${ep.title} ${ep.show || ''}`).includes(q)) continue;
    const li = el('li');
    li.style.setProperty('--i', String(n++));
    const btn = el('button', 'episode');
    btn.type = 'button';
    const art = el('div', 'art');
    const text = el('span', 'ep-text');
    text.append(el('span', 'ep-title', ep.title));
    const date = ep.date ? new Date(ep.date) : null;
    const meta = [ep.show && ep.show !== feed.title ? ep.show : '', date && !isNaN(date) ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '', formatDuration(ep.duration)];
    text.append(el('span', 'ep-meta', meta.filter(Boolean).join(' · ')));
    btn.append(art, text, icon('arrow', 'icon ep-go'));
    btn.addEventListener('click', () => {
      if (state.busy) return;
      els.episodesCard.classList.add('hidden');
      run(() => Promise.resolve({ kind: 'audio', url: ep.url, title: ep.title, show: ep.show || feed.title, art: ep.art || feed.image, notes: ep.notes }));
    });
    li.append(btn);
    items.push(li);
    // Art for the first rows right away, the rest as they scroll into view.
    artObserver.observe(art);
    art._art = { art: ep.art || feed.image, title: ep.title, show: ep.show || feed.title };
  }
  if (!items.length) items.push(el('li', 'episode-empty', 'No episodes match that.'));
  els.episodes.replaceChildren(...items);
}

const artObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    artObserver.unobserve(e.target);
    artInto(e.target, e.target._art);
  }
}, { rootMargin: '200px' });

function formatDuration(d) {
  if (!d) return '';
  if (/^\d+$/.test(d)) return fmtTime(Number(d));
  return d;
}

/* ---------- audio + transcription ---------- */

/* ---------- decoding ----------
 * Decoding a whole episode at once needs gigabytes (the browser decodes at the file's own
 * sample rate first), and phones kill tabs that do that. MP3 files are cut into one-minute
 * pieces at frame boundaries and decoded one at a time, while the worker transcribes the
 * previous piece. */

const SAMPLE_RATE = 16000;
const PIECE_SECONDS = 60;
const MAX_AHEAD_SECONDS = 90; // decoded audio allowed to wait for the worker




async function decodeMono16k(arrayBuffer) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  let audio;
  try {
    audio = await new Ctx(1, 1, SAMPLE_RATE).decodeAudioData(arrayBuffer);
  } catch {
    throw new UserError("Your browser couldn't decode this audio file. Try another episode or a different browser.");
  }
  if (audio.numberOfChannels === 1) return audio.getChannelData(0).slice();
  const out = new Float32Array(audio.length);
  const n = audio.numberOfChannels;
  for (let c = 0; c < n; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += data[i] / n;
  }
  return out;
}

// Formats that can't be cut into pieces are decoded whole, which needs roughly 10x the file
// size in memory. Phones kill tabs long before that for a full episode.
const WHOLE_DECODE_LIMIT = IS_MOBILE ? 40e6 : 400e6;

// Yields 16 kHz mono audio a piece at a time, starting at fromSec. Calls onTotal(seconds) first.
async function* decodePieces(blob, onTotal, fromSec = 0) {
  const skip = Math.round(fromSec * SAMPLE_RATE);
  const mp3 = await indexMp3(blob);
  if (mp3) {
    yield* mp3Pieces(blob, mp3, onTotal, skip);
    return;
  }
  const wav = await indexWav(blob);
  if (wav && wav.format !== 0xfffe) {
    yield* wavPieces(blob, wav, onTotal, skip);
    return;
  }
  if (blob.size > WHOLE_DECODE_LIMIT) {
    throw new UserError(
      `This episode's audio format (${blob.type || 'not MP3'}) can't be decoded in pieces, and at ${fmtBytes(blob.size)} it needs more memory ` +
      `than ${IS_MOBILE ? 'a phone' : 'this browser'} allows. Try it on a computer, or find an MP3 version of the episode.`
    );
  }
  const whole = await decodeMono16k(await blob.arrayBuffer());
  onTotal(whole.length / SAMPLE_RATE);
  const step = PIECE_SECONDS * SAMPLE_RATE;
  for (let s = skip; s < whole.length; s += step) yield whole.slice(s, s + step);
}

async function* mp3Pieces(blob, { offsets, spf, sr }, onTotal, skip) {
  const n = offsets.length;
  onTotal((n * spf) / sr);
  const per = Math.ceil((PIECE_SECONDS * sr) / spf);
  const toSamples = (frames) => Math.round((frames * spf * SAMPLE_RATE) / sr);
  // MP3 frames can borrow bits from the frames before them, so decode two extra and drop their audio.
  const WARMUP = 2;
  for (let k = 0; k < n; k += per) {
    const last = k + per >= n;
    const pieceStart = toSamples(k);
    if (toSamples(Math.min(k + per, n)) <= skip) continue;
    const from = Math.max(0, k - WARMUP);
    const pcm = await decodeMono16k(await blob.slice(offsets[from], last ? blob.size : offsets[k + per]).arrayBuffer());
    // Line pieces up from their end: decoders differ in how much they emit for the first
    // frames of a slice, but every one of them produces the piece's own frames at the end.
    const expected = toSamples(Math.min(k + per, n) - k);
    let drop = !last && pcm.length >= expected ? pcm.length - expected : toSamples(k - from);
    drop += Math.max(0, skip - pieceStart);
    yield drop ? pcm.slice(drop) : pcm;
  }
}

async function* wavPieces(blob, info, onTotal, skip) {
  const frames = info.dataSize / info.blockAlign;
  onTotal(frames / info.sampleRate);
  const per = PIECE_SECONDS * info.sampleRate;
  for (let f = 0; f < frames; f += per) {
    const pieceEnd = Math.round(((f + per) * SAMPLE_RATE) / info.sampleRate);
    if (pieceEnd <= skip) continue;
    const a = info.dataStart + f * info.blockAlign;
    const b = info.dataStart + Math.min(frames, f + per) * info.blockAlign;
    const pcm = await decodeMono16k(wavPiece(info, new Uint8Array(await blob.slice(a, b).arrayBuffer())).buffer);
    const drop = Math.max(0, skip - Math.round((f * SAMPLE_RATE) / info.sampleRate));
    yield drop ? pcm.slice(drop) : pcm;
  }
}

/* ---------- transcription ---------- */

function getWorker() {
  if (!state.worker) state.worker = new Worker(new URL('worker.js', import.meta.url), { type: 'module' });
  return state.worker;
}

function killWorker() {
  state.worker?.terminate();
  state.worker = null;
}

class GpuFailed extends Error {}

// If the model goes quiet this long (a worker that ran out of memory often dies silently),
// give up instead of spinning forever. Progress is saved, so Resume continues from there.
const WATCHDOG_MS = 10 * 60 * 1000;

// For measuring other weight formats and runtime settings:
// ?dtype=q4 or ?dtype={"encoder_model":"q8","decoder_model_merged":"q4"}, ?session={"enableCpuMemArena":false}.
function queryJson(name) {
  const v = new URLSearchParams(location.search).get(name);
  if (!v) return undefined;
  try { return v.startsWith('{') ? JSON.parse(v) : v; } catch { return undefined; }
}
const DTYPE_OVERRIDE = queryJson('dtype');
const SESSION_OVERRIDE = queryJson('session');

// pass: 'single' (one model), 'draft' (quick sketch with Tiny) or 'refine' (the chosen model
// rewrites the sketch window by window; the windows line up because they are cut from the same
// audio the same way).
const STAGE = { single: 'Transcribing', draft: 'Sketching', refine: 'Refining', speakers: 'Finding speakers' };
// Phones run the speaker models after Whisper has been unloaded, never both at once.
const speakersInline = () => speakersOn() && !IS_MOBILE;

async function transcribeAudio(blob, fromSec = 0, { modelKey = selectedModel(), pass = 'single', toSec = Infinity } = {}) {
  const worker = getWorker();
  const id = ++state.jobSeq;
  const model = modelFor(modelKey, language());
  const stage = STAGE[pass];
  const files = new Map();
  let total = 0;
  let buffered = 0;
  let ready = false;
  let wake = null;
  state.lastHeard = Date.now();
  let deviceLine = '';
  let finish;
  let fail;
  const finished = new Promise((res, rej) => { finish = res; fail = rej; });
  finished.catch(() => {});
  state.rejectRun = fail;
  const nudge = () => { const w = wake; wake = null; w?.(); };
  const watchdog = setInterval(() => {
    if (document.visibilityState !== 'visible' || Date.now() - state.lastHeard < WATCHDOG_MS) return;
    fail(new UserError('The speech model stopped responding, most likely because the browser ran out of memory. Try a smaller model, then Resume: your progress is saved.'));
    nudge();
  }, 15000);

  if (pass === 'speakers') progress('Finding speakers', null, 'Loading the speaker model');
  else if (pass === 'refine') progress('Refining', null, `Loading the ${model.name} model`);
  else progress('Loading speech model', null, 'First run downloads the model, then it is cached');

  worker.onmessage = ({ data: m }) => {
    if (m.id !== id) return; // from an earlier job in this worker
    state.lastHeard = Date.now();
    switch (m.type) {
      case 'status':
        if (!ready) progress(m.text, null, '');
        break;
      case 'model-progress': {
        let loaded, size;
        if (m.status === 'progress_total') {
          ({ loaded, total: size } = m);
        } else if (m.status === 'progress' && m.file) {
          files.set(m.file, { loaded: m.loaded || 0, total: m.total || 0 });
          loaded = size = 0;
          for (const f of files.values()) { loaded += f.loaded; size += f.total; }
        } else {
          break;
        }
        progress(pass === 'refine' ? 'Refining' : pass === 'speakers' ? 'Finding speakers' : 'Downloading speech model', size ? loaded / size : null,
          `Downloading the ${pass === 'speakers' ? 'speaker' : model.name} model: ${fmtBytes(loaded)} of ${fmtBytes(size)}, only needed once`,
          size ? [{ v: `${Math.round((loaded / size) * 100)}%`, l: 'model' }] : null);
        break;
      }
      case 'ready':
        ready = true;
        deviceLine = m.device === 'webgpu' ? 'On your GPU' : 'On your CPU, so this takes a while';
        progress(stage, total ? fromSec / total : 0, deviceLine,
          total ? [{ v: `${fmtTime(fromSec)} / ${fmtTime(total)}` }] : null);
        break;
      case 'buffered':
        buffered = m.seconds;
        nudge();
        break;
      case 'segment': {
        buffered = m.buffered;
        if (m.voices) state.voices = m.voices;
        if (pass === 'speakers') {
          labelWindow(m);
          wave.setDone(m.end);
          progress(stage, total ? m.end / total : null, 'Listening for who speaks when', [{ v: `${fmtTime(m.end)} / ${fmtTime(total)}` }]);
          nudge();
          break;
        }
        // A window arrives as timed parts (sentences), each with its speaker if labelled.
        const pieces = (m.parts?.length ? m.parts : m.text ? [{ start: m.start, end: m.end, text: m.text }] : [])
          .map((x) => ({ ...x, w: m.start, text: correctText(x.text, state.vocab) }));
        if (pass === 'refine') {
          refineSegment(m, pieces);
          wave.setDone(m.end);
        } else {
          for (const x of pieces) addSegment({ ...x, draft: pass === 'draft' });
          if (pass === 'draft') wave.setDraftDone(m.end); else wave.setDone(m.end);
        }
        if (pieces.some((x) => x.speaker != null)) refreshNames();
        saveProgress(m.end, total);
        const rate = (m.end - fromSec) / Math.max(m.elapsed, 0.001);
        const eta = (total - m.end) / Math.max(rate, 0.001);
        progress(
          stage,
          total ? m.end / total : null,
          deviceLine,
          [{ v: `${fmtTime(m.end)} / ${fmtTime(total)}` }, { v: `${rate.toFixed(1)}×`, l: 'speed' }, { v: fmtSpan(eta), l: 'left' }]
        );
        nudge();
        break;
      }
      case 'speakers-off':
        console.warn('Speaker labels are off for this run:', m.message);
        toast('Speaker labels are not available here');
        break;
      case 'done':
        finish();
        break;
      case 'error':
        fail(m.gpuFailed ? new GpuFailed(m.message) : new Error(m.message));
        nudge();
        break;
    }
  };
  worker.onerror = (e) => {
    console.error('Worker error', e.message, e.filename, e.lineno);
    fail(new Error(e.message || 'The transcription worker crashed. Try a smaller model.'));
    nudge();
  };
  worker.onmessageerror = (e) => console.error('Worker message could not be read', e);

  try {
    worker.postMessage({
      type: 'start',
      id,
      language: language(),
      model: model.id,
      device: state.gpu.available ? 'webgpu' : 'wasm',
      hasF16: state.gpu.f16,
      dtype: DTYPE_OVERRIDE,
      terms: (state.vocab?.terms || []).slice(0, 40),
      previous: state.segments.filter((x) => x.start < fromSec && x.text).slice(-4).map((x) => x.text).join(' '),
      speakers: pass === 'speakers' || speakersInline(),
      diarizeOnly: pass === 'speakers',
      voices: state.voices,
      lastSpeaker: [...state.segments].reverse().find((x) => x.start < fromSec && x.speaker != null)?.speaker ?? null,
      sessionOptions: SESSION_OVERRIDE,
      offsetSec: fromSec,
    });

    // Decode while the model loads and while earlier pieces are transcribed, but never run
    // more than MAX_AHEAD_SECONDS ahead of the worker, so memory stays flat.
    let pieces = 0;
    let cursor = fromSec;
    for await (let piece of decodePieces(blob, (t) => { total = t; wave.setTotal(t); }, fromSec)) {
      if (!pieces++ && !fromSec && piece.length < SAMPLE_RATE) throw new UserError('That audio is empty or too short to transcribe.');
      let last = false;
      if (cursor + piece.length / SAMPLE_RATE >= toSec) {
        piece = piece.slice(0, Math.max(0, Math.round((toSec - cursor) * SAMPLE_RATE)));
        last = true;
      }
      wave.addPiece(cursor, piece);
      cursor += piece.length / SAMPLE_RATE;
      buffered += piece.length / SAMPLE_RATE;
      worker.postMessage({ type: 'audio', id, samples: piece }, [piece.buffer]);
      while (buffered > MAX_AHEAD_SECONDS) await Promise.race([new Promise((r) => { wake = r; }), finished]);
      if (last) break;
    }
    worker.postMessage({ type: 'audio', id, samples: new Float32Array(0), final: true });
    await finished;
  } finally {
    clearInterval(watchdog);
    state.rejectRun = null;
  }
}

/* ---------- transcript: paragraphs, live follow ---------- */

function emptyState(text) {
  const box = el('div', 'empty');
  box.append(el('p', '', text));
  for (let i = 0; i < 4; i++) box.append(el('div', 'skeleton'));
  return box;
}

function resetTranscript() {
  state.segments = [];
  state.segEls = [];
  state.lastPara = null;
  state.playingIdx = -1;
  els.transcript.replaceChildren(emptyState('The transcript appears here as it is written.'));
  els.resultCard.classList.remove('hidden');
  clearSearch();
  updateLayout();
}

function restoreTranscript(segments) {
  resetTranscript();
  const frag = document.createDocumentFragment();
  for (const seg of segments || []) addSegment(seg, { fresh: false, into: frag });
  if (segments?.length) els.transcript.replaceChildren(frag);
  if (segments?.some((x) => x.speaker != null)) refreshNames();
  updateLayout();
}

const countWords = (t) => t.split(/\s+/).filter(Boolean).length;
const markAd = (para) => para.el.classList.toggle('ad', isAd(para.p.textContent));

function addSegment(seg, { fresh = true, into = null } = {}) {
  if (!seg.text || !seg.text.trim()) return;
  const host = into || els.transcript;
  if (!state.segments.length && !into) host.replaceChildren();
  const prev = state.segments[state.segments.length - 1];
  const follow = !into && !state.busy ? false : !into && nearLive();
  const stored = { start: seg.start, end: seg.end, text: seg.text };
  if (seg.w != null) stored.w = seg.w;
  if (seg.speaker != null) stored.speaker = seg.speaker;
  if (seg.draft) stored.draft = true;
  state.segments.push(stored);

  const span = el('span', 'seg', seg.text.trim());
  span.dataset.start = seg.start;
  span.dataset.end = seg.end;
  if (seg.w != null) span.dataset.w = seg.w;
  if (seg.speaker != null) span.dataset.speaker = seg.speaker;
  if (seg.draft) span.classList.add('draft');
  if (fresh) span.classList.add('fresh');

  if (prev && state.lastPara && !startsParagraph(prev, stored, state.lastPara.words)) {
    state.segEls[state.segEls.length - 1].textContent = tidy(prev.text, seg.text);
    state.lastPara.p.append(' ', span);
    state.lastPara.words += countWords(span.textContent);
    markAd(state.lastPara);
  } else {
    const para = el('div', 'para');
    if (fresh) para.classList.add('fresh');
    const ts = el('button', 'ts', fmtTime(seg.start));
    ts.type = 'button';
    ts.tabIndex = -1;
    ts.dataset.t = seg.start;
    ts.setAttribute('aria-label', `Play from ${fmtTime(seg.start)}`);
    const p = el('p');
    p.append(span);
    if (seg.speaker != null && seg.speaker !== state.lastPara?.speaker) {
      const body = el('div', 'para-body');
      body.append(whoChip(seg.speaker), p);
      para.append(ts, body);
    } else {
      para.append(ts, p);
    }
    host.append(para);
    state.lastPara = { el: para, p, words: countWords(span.textContent), speaker: seg.speaker };
    markAd(state.lastPara);
  }
  state.segEls.push(span);
  if (into) return;
  updateLayout();
  if (els.search.value.trim()) scheduleSearch();
  if (follow) requestAnimationFrame(() => scrollToLive());
  else if (state.busy) els.jump.classList.remove('hidden');
}

// The better model's text for one window replaces the sketch in place. Paragraphs are
// rebuilt once at the end, since better text can move sentence boundaries.
function refineSegment(m, pieces) {
  const text = pieces.map((x) => x.text).join(' ').trim();
  const i = state.segments.findIndex((s) => Math.abs(s.start - m.start) < 0.05 && Math.abs(s.end - m.end) < 0.05);
  const span = state.segEls[i];
  if (pieces.length <= 1 && pieces[0]?.speaker == null && i >= 0 && span) {
    state.segments[i] = { ...state.segments[i], start: m.start, end: m.end, text };
    if (text !== span.textContent.trim()) {
      span.textContent = text;
      span.classList.remove('fresh');
      void span.offsetWidth;
      span.classList.add('fresh');
    }
    span.classList.remove('draft', 'refining');
    if (!text) state.needsRebuild = true;
    return;
  }
  // The window doesn't line up with an old one: replace whatever it overlaps.
  const keep = state.segments.filter((s) => s.end <= m.start + 0.05 || s.start >= m.end - 0.05);
  keep.push(...pieces.filter((x) => x.text));
  keep.sort((a, b) => a.start - b.start);
  state.segments = keep;
  rebuildTranscript();
}

function rebuildTranscript() {
  const y = window.scrollY;
  const range = state.refineRange;
  const segs = state.segments.filter((s) => s.text && s.text.trim());
  restoreTranscript(segs);
  if (range) markRefining(range.from, range.to, range.done);
  window.scrollTo(0, y);
}

function markRefining(from, to, done = from) {
  state.segments.forEach((s, i) => state.segEls[i]?.classList.toggle('refining', s.start >= done - 0.05 && s.start < to - 0.05 && s.start >= from - 0.05));
}

function liveAnchor() {
  return !els.tail.classList.contains('hidden') ? els.tail : state.lastPara?.el || els.transcript;
}

function nearLive() {
  const r = liveAnchor().getBoundingClientRect();
  return r.top < window.innerHeight + 80;
}

function scrollToLive() {
  liveAnchor().scrollIntoView({ block: 'end', behavior: 'smooth' });
  els.jump.classList.add('hidden');
}

function transcriptText() {
  return plainText(state.segments, { timestamps: els.timestamps.checked, names: names() });
}

/* ---------- search ---------- */

let searchTimer = 0;
function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(false), 150);
}

function clearSearch() {
  CSS.highlights?.delete('search');
  CSS.highlights?.delete('search-current');
  state.find = { ranges: [], index: -1 };
  els.findCount.textContent = '';
}

function runSearch(jump = true) {
  const q = els.search.value.trim().toLocaleLowerCase();
  const keep = state.find.index;
  clearSearch();
  els.findWrap.classList.toggle('searching', !!q);
  if (q.length < 2) return;
  const ranges = [];
  for (const span of state.segEls) {
    const node = span.firstChild;
    if (!node) continue;
    const text = node.textContent.toLocaleLowerCase();
    for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
      const r = new Range();
      r.setStart(node, i);
      r.setEnd(node, i + q.length);
      ranges.push(r);
    }
  }
  state.find.ranges = ranges;
  if (!ranges.length) { els.findCount.textContent = '0'; return; }
  if (window.Highlight && CSS.highlights) CSS.highlights.set('search', new Highlight(...ranges));
  goToMatch(jump ? 0 : Math.min(Math.max(keep, 0), ranges.length - 1), jump);
}

function goToMatch(i, scroll = true) {
  const { ranges } = state.find;
  if (!ranges.length) return;
  state.find.index = (i + ranges.length) % ranges.length;
  const r = ranges[state.find.index];
  els.findCount.textContent = `${state.find.index + 1}/${ranges.length}`;
  if (window.Highlight && CSS.highlights) CSS.highlights.set('search-current', new Highlight(r));
  if (!scroll) return;
  const box = r.getBoundingClientRect();
  window.scrollBy({ top: box.top - window.innerHeight * 0.4, behavior: 'smooth' });
}

/* ---------- copy, export, share ---------- */

async function copyTranscript() {
  const text = transcriptText();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`Copied ${fmtNum(wordCount(state.segments))} words`);
  const label = els.copy.querySelector('span');
  label.textContent = 'Copied';
  setIcon(els.copy, 'check');
  setTimeout(() => { label.textContent = 'Copy'; setIcon(els.copy, 'copy'); }, 1800);
}

const baseName = () => (state.source?.title || 'transcript').replace(/[\\/:*?"<>|]+/g, '').slice(0, 100).trim() || 'transcript';
const textFile = () => `${state.source?.title || 'Transcript'}\n${state.source?.show ? `${state.source.show}\n` : ''}\n${transcriptText()}\n`;

function saveFile(content, ext, type) {
  if (!state.segments.length) return;
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${baseName()}.${ext}`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const downloadTranscript = () => saveFile(textFile(), 'txt', 'text/plain');
const downloadSrt = () => saveFile(toSrt(state.segments, names()), 'srt', 'application/x-subrip');
const downloadVtt = () => saveFile(toVtt(state.segments, names()), 'vtt', 'text/vtt');

async function shareTranscript() {
  if (!state.segments.length) return;
  const file = new File([textFile()], `${baseName()}.txt`, { type: 'text/plain' });
  try {
    if (state.canShareFiles) {
      await navigator.share({ files: [file], title: state.source?.title || 'Transcript' });
      return;
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
  }
  downloadTranscript();
}

/* ---------- playback ---------- */

const audio = els.audio;

function releaseAudio() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (state.audioObjectUrl) URL.revokeObjectURL(state.audioObjectUrl);
  state.audioObjectUrl = null;
  state.audioReadyFor = null;
  highlightPlaying(-1);
  wave.setPosition(null);
  onPlayState();
}

// The copy that was transcribed (kept in Cache Storage) plays back in sync with the transcript;
// a fresh download could carry different ads and drift. The original link is the fallback.
async function ensureAudio() {
  if (audio.getAttribute('src') && state.audioReadyFor === state.audioKey) return true;
  releaseAudio();
  let src = null;
  if (state.sourceFile) src = URL.createObjectURL(state.sourceFile);
  else {
    const blob = state.audioKey ? await cachedAudio(state.audioKey) : null;
    if (blob) src = URL.createObjectURL(blob);
    else if (state.source?.url) src = state.source.url;
  }
  if (!src) return false;
  if (src.startsWith('blob:')) state.audioObjectUrl = src;
  audio.src = src;
  state.audioReadyFor = state.audioKey;
  return true;
}

async function hasAudio() {
  if (state.sourceFile || state.source?.url) return true;
  if (!state.audioKey) return false;
  try { return !!(await (await openAudioCache())?.match(state.audioKey)); } catch { return false; }
}

async function refreshPlayable() {
  setPlayable(await hasAudio());
}

function setPlayable(on) {
  state.playable = on;
  updateRefineBar();
  els.play.disabled = !on;
  els.dockPlay.classList.toggle('hidden', !on);
  els.miniPlay.classList.toggle('hidden', !on);
  els.transcript.classList.toggle('playable', on);
  wave.setSeekable(on && wave.total > 0 && !state.busy);
}

function startPlayback() {
  audio.play().catch((err) => {
    if (err.name === 'NotAllowedError') toast('Tap play again to start listening');
    else if (err.name !== 'AbortError') toast("Couldn't play this audio in this browser.");
  });
}

// Attach the audio before anyone taps play: iOS only starts playback when play() runs
// directly in the tap, not after waiting for storage (that took a second tap).
function attachAudio(blob) {
  releaseAudio();
  const src = URL.createObjectURL(blob);
  state.audioObjectUrl = src;
  audio.src = src;
  state.audioReadyFor = state.audioKey;
}

const audioReady = () => !!audio.getAttribute('src') && state.audioReadyFor === state.audioKey;

async function togglePlay() {
  if (!state.playable) return;
  if (!audio.paused) { audio.pause(); return; }
  if (audioReady()) { startPlayback(); return; }
  if (!(await ensureAudio())) {
    setPlayable(false);
    toast('The audio for this transcript is no longer stored in this browser.');
    return;
  }
  startPlayback();
}

async function playFrom(t) {
  if (!state.playable) {
    toast('Audio is not available for this transcript.');
    return;
  }
  if (!audioReady() && !(await ensureAudio())) { setPlayable(false); return; }
  if (audio.readyState >= 1) audio.currentTime = t;
  else audio.addEventListener('loadedmetadata', () => { audio.currentTime = t; }, { once: true });
  wave.setPosition(t);
  state.userScrolledAt = 0;
  startPlayback();
}

function segmentAt(t) {
  const segs = state.segments;
  let lo = 0;
  let hi = segs.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found >= 0 && t <= segs[found].end + 0.5 ? found : -1;
}

function highlightPlaying(i) {
  if (i === state.playingIdx) return;
  state.segEls[state.playingIdx]?.classList.remove('playing');
  state.playingIdx = i;
  const span = state.segEls[i];
  if (!span) return;
  span.classList.add('playing');
  // Follow along, unless the reader has scrolled away on purpose in the last few seconds.
  if (Date.now() - state.userScrolledAt < 4000) return;
  const r = span.getBoundingClientRect();
  if (r.top < 130 || r.bottom > window.innerHeight - 110) span.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function onPlayState() {
  const playing = !audio.paused;
  document.body.classList.toggle('playing', playing);
  for (const b of [els.play, els.miniPlay, els.dockPlay]) {
    setIcon(b, playing ? 'pause' : 'play');
    b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
  els.play.classList.toggle('playing', playing);
  els.dockPlay.querySelector('span').textContent = playing ? 'Pause' : 'Play';
  updateMini();
}

audio.addEventListener('play', () => { keepAlive?.pause(); });
audio.addEventListener('pause', () => { if (state.busy) startKeepAlive(); });
audio.addEventListener('play', onPlayState);
audio.addEventListener('pause', onPlayState);
audio.addEventListener('ended', onPlayState);
audio.addEventListener('timeupdate', () => {
  if (!audio.getAttribute('src') || (audio.paused && !audio.currentTime)) return;
  wave.setPosition(audio.currentTime);
  highlightPlaying(segmentAt(audio.currentTime));
  updateMini();
});
audio.addEventListener('error', () => {
  if (!audio.getAttribute('src')) return;
  toast("Couldn't play this audio in this browser.");
  onPlayState();
});

/* ---------- session, mini player, layout ---------- */

function beginSession(meta, { loading = false } = {}) {
  els.progressCard.classList.remove('hidden');
  showSessionMeta(meta, { loading });
  els.steps.classList.remove('failed', 'stopped');
  els.steps.querySelectorAll('li').forEach((li) => li.classList.remove('done', 'active'));
  renderStats(null);
  updateLayout();
}

function showSessionMeta(meta, { loading = false } = {}) {
  els.title.textContent = meta?.title || 'Transcript';
  els.show.textContent = meta?.show || '';
  artInto(els.art, meta, { loading });
  artInto(els.miniArt, meta, { loading });
  els.miniTitle.textContent = meta?.title || '';
}

function hideSession() {
  els.progressCard.classList.add('hidden');
  updateLayout();
}

function updateLayout() {
  const reading = !els.resultCard.classList.contains('hidden') && state.segments.length > 0;
  const session = !els.progressCard.classList.contains('hidden') || !els.resultCard.classList.contains('hidden') || !els.resumeCard.classList.contains('hidden');
  document.body.classList.toggle('has-session', session);
  document.body.classList.toggle('reading', reading);
  els.dock.classList.toggle('hidden', !reading);
  els.readerFoot.classList.toggle('hidden', state.busy || !reading || !els.resumeCard.classList.contains('hidden'));
  if (session) els.library.classList.add('hidden');
  else renderLibrary();
  updateSettingsSummary();
}

function updateMini() {
  const active = state.busy || (state.playable && !audio.paused);
  const show = state.sessionOffscreen && active && !els.progressCard.classList.contains('hidden');
  document.body.classList.toggle('show-mini', show);
  els.mini.setAttribute('aria-hidden', String(!show));
  if (!show) return;
  const total = wave.total;
  if (!audio.paused) {
    els.miniStatus.textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(total)}`;
    els.miniBar.style.width = total ? `${(audio.currentTime / total) * 100}%` : '0';
  } else {
    const done = wave.done;
    els.miniStatus.textContent = total && done ? `${els.stage.textContent} · ${fmtTime(done)} / ${fmtTime(total)}` : els.stage.textContent;
    els.miniBar.style.width = total ? `${(done / total) * 100}%` : '0';
  }
}

new IntersectionObserver(([e]) => {
  state.sessionOffscreen = !e.isIntersecting && e.boundingClientRect.top < 0;
  updateMini();
}, { rootMargin: '-60px 0px 0px 0px' }).observe(els.progressCard);

// Back to the start page (keeps the library). Not while a transcript is being made.
function closeSession() {
  if (state.busy) return;
  releaseAudio();
  setPlayable(false);
  state.source = null;
  state.sourceFile = null;
  state.audioKey = null;
  state.segments = [];
  state.segEls = [];
  clearSearch();
  els.search.value = '';
  els.progressCard.classList.add('hidden');
  els.resultCard.classList.add('hidden');
  els.resumeCard.classList.add('hidden');
  els.episodesCard.classList.add('hidden');
  clearError();
  updateLayout();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------- library ---------- */

function relativeDay(ts) {
  const d = new Date(ts);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 864e5);
  if (days === 0) return `Today ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: days > 300 ? 'numeric' : undefined });
}

let libraryVersion = 0;
async function renderLibrary() {
  const v = ++libraryVersion;
  const entries = await listEntries();
  if (v !== libraryVersion || document.body.classList.contains('has-session')) return;
  els.library.classList.toggle('hidden', !entries.length);
  if (entries.length) foldSettings(true);
  els.libraryList.replaceChildren(...entries.map((e, i) => {
    const li = el('li');
    li.style.setProperty('--i', String(i));
    const card = el('div', 'entry');
    const art = el('div', 'art');
    const text = el('div', 'entry-text');
    text.append(el('span', 'entry-title', e.title));
    text.append(el('span', 'entry-meta', [relativeDay(e.createdAt), fmtTime(e.total || 0), `${fmtNum(e.words)} words`].join(' · ')));
    const open = el('button', 'entry-open');
    open.type = 'button';
    open.setAttribute('aria-label', `Open the transcript of ${e.title}`);
    open.addEventListener('click', () => openEntry(e));
    const del = el('button', 'icon-btn entry-delete');
    del.type = 'button';
    del.setAttribute('aria-label', `Delete the transcript of ${e.title}`);
    del.append(icon('trash'));
    del.addEventListener('click', async () => {
      await deleteEntry(e.id);
      toast('Transcript deleted');
      renderLibrary();
    });
    card.append(art, text, open, del);
    li.append(card);
    requestAnimationFrame(() => artInto(art, e));
    return li;
  }));
}

async function openEntry(entry) {
  if (state.busy) return;
  clearError();
  releaseAudio();
  state.source = { title: entry.title, show: entry.show, art: entry.art, url: entry.source?.url, fileId: entry.source?.fileId, key: entry.key, notes: entry.notes || '' };
  state.vocab = vocabulary(state.source);
  state.entryId = entry.id;
  state.transcriptModel = entry.refinedWith || entry.model;
  state.voices = entry.voices || [];
  state.speakerNames = entry.speakerNames || {};
  state.guessed = {};
  state.sourceFile = null;
  state.audioKey = entry.key;
  beginSession(state.source);
  setStep('done');
  wave.reset(entry.total || 0, decodeLevels(entry.levels));
  wave.setFinished(true);
  restoreTranscript(entry.segments);
  progress('Done', 1, `${relativeDay(entry.createdAt)} · ${LANG_NAMES[entry.lang] || ''} · ${MODELS[entry.model]?.name || ''}`.replace(/ · $/, ''),
    [{ v: fmtTime(entry.total || 0), l: 'audio' }, { v: fmtNum(entry.words), l: 'words' }]);
  setBusy(false);
  await refreshPlayable();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------- main flow ---------- */

// Progress survives a reload: if the browser kills the tab (usually for using too much
// memory), the next visit offers to resume from the last finished segment.
const JOB_KEY = 'job';

function loadJob() {
  try { return JSON.parse(localStorage.getItem(JOB_KEY)) || null; } catch { return null; }
}

function saveJob(job) {
  state.job = job;
  try { localStorage.setItem(JOB_KEY, JSON.stringify(job)); } catch {}
}

function saveProgress(doneSec, total) {
  if (!state.job) return;
  saveJob({ ...state.job, segments: state.segments, doneSec, total: total || state.job.total, levels: encodeLevels(wave.levels), voices: state.voices, speakerNames: state.speakerNames });
}

// A finished transcript keeps its audio (for playback) until the next episode replaces it.
function clearJob({ keepAudio = false } = {}) {
  const key = state.job?.key || loadJob()?.key;
  state.job = null;
  try { localStorage.removeItem(JOB_KEY); } catch {}
  if (key && !keepAudio) forgetAudio(key);
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// Title, show and cover art from the file's ID3 tag, where the link didn't provide them.
async function readTags(blob) {
  try {
    const head = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
    const len = id3Length(head);
    if (!len) return null;
    return parseId3(new Uint8Array(await blob.slice(0, Math.min(len, 8e6)).arrayBuffer()));
  } catch {
    return null;
  }
}

async function pictureUrl(pic) {
  if (!pic?.data?.length) return '';
  const blob = new Blob([pic.data], { type: pic.mime });
  if (blob.size > 350e3) {
    // Big covers (podcasts use up to 3000 px) are scaled down, except on phones where decoding
    // one costs tens of megabytes right before the model loads.
    if (IS_MOBILE || !window.createImageBitmap) return '';
    try {
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = c.height = 320;
      const s = Math.min(bmp.width, bmp.height);
      c.getContext('2d').drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 320, 320);
      bmp.close?.();
      return c.toDataURL('image/jpeg', 0.85);
    } catch {
      return '';
    }
  }
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => resolve('');
    r.readAsDataURL(blob);
  });
}

async function applyTags(blob, source) {
  if (source.art && !source.file) return;
  const tags = await readTags(blob);
  if (!tags) return;
  if (source.file) {
    if (tags.title) source.title = tags.title;
    if (!source.show) source.show = tags.artist || tags.album || '';
  }
  if (!source.art) source.art = await pictureUrl(tags.picture);
}

// One run at a time. Every await is followed by a check that this run is still the current
// one, so a cancelled or replaced run can never touch the page, the worker or saved progress.
async function run(getSource, resume = null) {
  if (state.busy) return;
  clearError();
  els.resumeCard.classList.add('hidden');
  els.episodesCard.classList.add('hidden');
  releaseAudio();
  setPlayable(false);
  const ctl = new AbortController();
  state.abort = ctl;
  const current = () => state.abort === ctl && !ctl.signal.aborted;
  state.lastAttempt = resume ? () => { const j = loadJob(); if (j) run(null, j); } : () => run(getSource);
  state.source = null;
  state.runStartedAt = performance.now();
  setBusy(true);
  if (resume) {
    beginSession(resume.source);
  } else {
    beginSession({ title: 'Finding the episode…' }, { loading: true });
    progress('Looking up the episode', null, '');
  }
  wave.reset(resume?.total || 0, resume?.levels ? decodeLevels(resume.levels) : null);
  if (resume?.phase === 'draft') wave.setDraftDone(resume.doneSec || 0);
  else if (resume) wave.setDone(resume.doneSec || 0);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  try {
    const source = resume ? { ...resume.source } : await getSource();
    if (!current()) return;
    if (source.kind === 'list') {
      setBusy(false);
      hideSession();
      showEpisodes(source);
      return;
    }
    const key = audioKey(source.url || source.fileId);
    state.source = { ...source, key };
    state.vocab = vocabulary(state.source);
    state.audioKey = key;
    state.sourceFile = source.file || null;
    showSessionMeta(state.source);
    state.voices = resume?.voices || [];
    state.speakerNames = resume?.speakerNames || {};
    state.guessed = {};
    if (resume) restoreTranscript(resume.segments);
    else resetTranscript();

    let blob;
    if (source.url) {
      blob = await downloadAudio(source.url, key);
    } else if (source.file) {
      // Kept on disk so a reload can resume; if storage is full, the file itself works too.
      blob = await storeAudio(key, new Response(source.file), () => source.file);
    } else {
      blob = await cachedAudio(key);
      if (!blob) throw new UserError('That file is no longer stored in the browser. Pick it again to start over.');
    }
    if (!current()) return;
    await applyTags(blob, state.source);
    if (!current()) return;
    showSessionMeta(state.source);
    attachAudio(blob);
    setPlayable(true);
    wave.setSeekable(false);

    const fromSec = resume?.doneSec || 0;
    const modelKey = resume?.model || selectedModel();
    const drafting = !!resume && resume.plan === 'draft'; // older saved jobs only; refining is now on request
    let phase = resume?.phase || (drafting ? 'draft' : 'single');
    showSteps(drafting);
    saveJob({
      id: resume?.id || newId(),
      source: { kind: 'audio', title: state.source.title, show: state.source.show, art: state.source.art, url: source.url, fileId: source.fileId, notes: (source.notes || '').slice(0, 4000) },
      key,
      title: state.source.title,
      lang: language(),
      model: modelKey,
      segments: state.segments,
      doneSec: fromSec,
      total: resume?.total || 0,
      levels: resume?.levels || '',
      plan: drafting ? 'draft' : 'single',
      phase,
    });
    if (phase === 'refine') wave.setDraftDone(resume?.total || wave.total);
    let refineFrom = phase === 'refine' ? fromSec : 0;
    if (phase === 'draft') {
      await transcribeAudio(blob, fromSec, { modelKey: 'tiny', pass: 'draft' });
      if (!current()) return;
      phase = 'refine';
      saveJob({ ...state.job, phase, doneSec: 0, segments: state.segments });
      wave.setDraftDone(wave.total);
      wave.setDone(0);
      // Phones: one model in memory at a time.
      if (IS_MOBILE) killWorker();
      refineFrom = 0;
    }
    await transcribeAudio(blob, phase === 'single' ? fromSec : refineFrom, { modelKey, pass: phase === 'single' ? 'single' : 'refine' });
    if (state.needsRebuild || phase === 'refine') { state.needsRebuild = false; rebuildTranscript(); }
    blob = null;
    if (!current()) return;
    await finishRun();
    if (IS_MOBILE && state.segments.length && current()) await labelSpeakers();
  } catch (err) {
    if (!current()) return; // cancelled or replaced: whoever took over owns the page now
    killWorker(); // never reuse a worker after an error
    setBusy(false);
    if (err instanceof GpuFailed && state.gpu.available) {
      // The GPU path failed to start. Remember that and carry on with the CPU instead.
      console.warn('GPU transcription failed, switching to the CPU', err);
      state.gpu.available = false;
      store.set('gpu-broken', '1');
      refreshModels();
      updateDeviceChip();
      const job = loadJob();
      if (job) return run(null, job);
    }
    if (err instanceof UserError) console.warn(err.message); else console.error(err);
    els.steps.classList.add('failed');
    progress('Stopped', null, '');
    els.waveWrap.classList.remove('loading');
    if (!state.source) hideSession();
    showError(err instanceof UserError ? err.message : `Something went wrong: ${err.message || err}`,
      err instanceof UserError ? "That didn't work" : 'Something went wrong', { retry: err.retry !== false });
    els.errorCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    els.errorCard.focus?.({ preventScroll: true });
    const job = loadJob();
    if (job?.doneSec > 0) offerResume(job, false);
    else refreshPlayable();
  }
}

async function finishRun() {
  const job = state.job;
  const total = wave.total || job?.total || 0;
  const words = wordCount(state.segments);
  const took = (performance.now() - state.runStartedAt) / 1000;
  // Nothing to resume any more: clear the saved job before anything reports "done", so a
  // reload at this moment can't offer to resume a finished transcript.
  clearJob({ keepAudio: true });
  const entry = job && state.segments.length ? {
    id: job.id,
    createdAt: Date.now(),
    title: state.source?.title || job.title,
    show: state.source?.show || '',
    art: state.source?.art || '',
    lang: job.lang,
    model: job.model,
    total,
    words,
    segments: state.segments,
    levels: encodeLevels(wave.levels),
    key: job.key,
    source: { url: job.source?.url, fileId: job.source?.fileId },
    notes: job.source?.notes || '',
    voices: state.voices,
    speakerNames: state.speakerNames,
  } : null;
  if (entry) {
    await saveEntry(entry);
    state.entryId = entry.id;
    state.transcriptModel = entry.model;
  }
  wave.setDone(total);
  wave.setFinished(true);
  setStep('done');
  if (!state.segments.length) {
    els.transcript.replaceChildren(emptyState('No speech found. Check that the language setting matches the podcast.'));
    els.transcript.querySelectorAll('.skeleton').forEach((s) => s.remove());
  }
  // Phones: give the model's memory back; it loads again from the cache in seconds.
  if (IS_MOBILE) killWorker();
  setBusy(false);
  progress('Done', 1, `Transcribed in ${fmtSpan(took)}${state.gpu.available ? ' on your GPU' : ''}`,
    [{ v: fmtTime(total), l: 'audio' }, { v: fmtNum(words), l: 'words' }, { v: `${(total / Math.max(took, 1)).toFixed(1)}×`, l: 'speed' }]);
  setPlayable(state.playable);
  updateLayout();
  announce('Transcript finished.');
  toast(state.segments.length ? `Done: ${fmtNum(words)} words` : 'No speech found');
}

/* ---------- speakers after the fact (phones) ---------- */

// The speaker pass labels the parts already in a window.
function labelWindow(m) {
  if (!m.speakers) return;
  const inside = state.segments.filter((x) => x.start >= m.start - 0.05 && x.start < m.end - 0.05);
  const before = [...state.segments].reverse().find((x) => x.start < m.start - 0.05 && x.speaker != null);
  const labelled = labelParts(inside, m.speakers.turns, m.speakers.local, before?.speaker ?? null);
  inside.forEach((x, i) => { if (labelled[i].speaker != null) x.speaker = labelled[i].speaker; else delete x.speaker; });
}

async function labelSpeakers({ from = 0, to = Infinity } = {}) {
  if (state.busy || !state.segments.length || !speakersOn()) return;
  const ctl = new AbortController();
  state.abort = ctl;
  const current = () => state.abort === ctl && !ctl.signal.aborted;
  state.runStartedAt = performance.now();
  state.labelling = true;
  setBusy(true);
  wave.setFinished(false);
  wave.setDone(from);
  try {
    const blob = await refineAudio();
    if (!current() || !blob) { state.labelling = false; setBusy(false); return; }
    killWorker(); // a fresh worker: only the small speaker models in memory
    await transcribeAudio(blob, from, { pass: 'speakers', toSec: to });
    if (!current()) return;
    rebuildTranscript();
    refreshNames();
    if (state.entryId) {
      const entry = await getEntry(state.entryId);
      if (entry) await saveEntry({ ...entry, segments: state.segments, voices: state.voices, speakerNames: state.speakerNames });
    }
    killWorker();
    const voices = new Set(state.segments.map((x) => x.speaker).filter((x) => x != null)).size;
    setStep('done');
    progress('Done', 1, `${voices === 1 ? 'One voice' : `${voices} voices`} found in ${fmtSpan((performance.now() - state.runStartedAt) / 1000)}`,
      [{ v: fmtTime(wave.total), l: 'audio' }, { v: fmtNum(wordCount(state.segments)), l: 'words' }]);
  } catch (err) {
    if (!current()) return;
    killWorker();
    console.warn('Speaker pass failed', err);
    progress('Done', 1, 'Speaker labels could not be added');
  }
  state.labelling = false;
  wave.setDone(wave.total);
  wave.setFinished(true);
  setBusy(false);
  updateRefineBar();
}

/* ---------- refine: a bigger model redoes the whole transcript or a chosen passage ---------- */

const MODEL_ORDER = ['tiny', 'base', 'small', 'turbo'];

function fillRefineModels() {
  const lang = language();
  const used = MODEL_ORDER.indexOf(state.transcriptModel);
  const keep = els.refineModel.value;
  els.refineModel.replaceChildren(...MODEL_ORDER.map((k) => {
    const o = el('option', '', `${k === 'turbo' ? 'Large' : MODELS[k].name}${modelFor(k, lang).tuned ? ' (NB)' : ''}`);
    o.value = k;
    return o;
  }));
  const better = MODEL_ORDER.find((k, i) => i > used && (k !== 'turbo' || state.gpu.available || used >= 2)) || 'small';
  els.refineModel.value = keep && keep !== state.transcriptModel ? keep : better;
  els.selModel.textContent = `with ${els.refineModel.selectedOptions[0]?.textContent || ''}`;
}

function updateRefineBar() {
  const show = !state.busy && state.playable && state.segments.length > 0 && !els.progressCard.classList.contains('hidden');
  els.refineBar.classList.toggle('hidden', !show);
  if (show) fillRefineModels();
  const canCheck = !state.busy && state.segments.length > 0 && !els.progressCard.classList.contains('hidden');
  els.namesBtn.classList.toggle('hidden', !canCheck);
  if (!canCheck) toggleNames(false);
  else if (!els.namesPanel.classList.contains('hidden')) renderNames();
}

/* ---------- names spelled several ways ---------- */

function toggleNames(open = els.namesPanel.classList.contains('hidden')) {
  els.namesPanel.classList.toggle('hidden', !open);
  els.namesBtn.setAttribute('aria-expanded', String(open));
  if (open) renderNames();
}

function renderNames() {
  const text = state.segments.map((x) => x.text).join(' ');
  const known = [...userGlossary().terms, ...extractTerms(state.source?.notes || '')];
  const groups = nameGroups(text, known).slice(0, 12);
  if (!groups.length) {
    els.namesList.replaceChildren(el('li', 'names-empty', 'Every name is spelled the same way throughout.'));
    return;
  }
  els.namesList.replaceChildren(...groups.map((g) => {
    const li = el('li');
    for (const v of g.variants) {
      const b = el('button', v.text === g.best ? 'best' : '', v.text);
      b.type = 'button';
      b.title = `Use “${v.text}” everywhere`;
      b.append(el('small', '', `×${v.n}`));
      b.addEventListener('click', () => pickName(g, v.text));
      li.append(b);
    }
    return li;
  }));
}

async function pickName(group, right) {
  const lines = glossaryFor(group, right);
  const lefts = new Set(group.variants.map((v) => v.text.toLowerCase()));
  const keep = store.get('glossary', '').split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !lefts.has(l.split(/\s*(?:=|->|→)\s*/)[0].toLowerCase()));
  els.glossary.value = [...new Set([...keep, ...lines])].join('\n');
  await applyGlossary();
  renderNames();
  toast(`“${right}” everywhere`);
}

async function refineAudio() {
  if (state.sourceFile) return state.sourceFile;
  const cached = state.audioKey ? await cachedAudio(state.audioKey) : null;
  if (cached) return cached;
  if (state.source?.url) return downloadAudio(state.source.url, state.audioKey || audioKey(state.source.url));
  return null;
}

async function refine({ from = 0, to = Infinity } = {}) {
  if (state.busy || !state.segments.length) return;
  const modelKey = els.refineModel.value || 'small';
  const ctl = new AbortController();
  state.abort = ctl;
  const current = () => state.abort === ctl && !ctl.signal.aborted;
  clearError();
  hideSelPill();
  window.getSelection()?.removeAllRanges();
  state.lastAttempt = () => refine({ from, to });
  state.runStartedAt = performance.now();
  setBusy(true);
  const whole = from <= 0 && to === Infinity;
  state.refineRange = { from, to, done: from };
  markRefining(from, to);
  wave.setFinished(false);
  wave.setDraftDone(wave.total);
  wave.setDone(from);
  try {
    progress('Refining', null, whole ? 'The whole transcript' : `${fmtTime(from)} to ${fmtTime(Math.min(to, wave.total))}`);
    const blob = await refineAudio();
    if (!current()) return;
    if (!blob) throw new UserError('The audio for this transcript is no longer stored in this browser, and there is no link to fetch it again.', { retry: false });
    await transcribeAudio(blob, from, { modelKey, pass: 'refine', toSec: to });
    if (!current()) return;
    state.refineRange = null;
    rebuildTranscript();
    wave.setDone(wave.total);
    wave.setFinished(true);
    const words = wordCount(state.segments);
    if (state.entryId) {
      const entry = await getEntry(state.entryId);
      if (entry) await saveEntry({ ...entry, segments: state.segments, words, voices: state.voices, speakerNames: state.speakerNames, refinedWith: whole ? modelKey : entry.refinedWith });
    }
    if (whole) state.transcriptModel = modelKey;
    if (IS_MOBILE) killWorker();
    setBusy(false);
    setStep('done');
    progress('Done', 1, `Refined ${whole ? 'everything' : 'the passage'} with ${MODELS[modelKey].name === 'Large v3 Turbo' ? 'Large' : MODELS[modelKey].name} in ${fmtSpan((performance.now() - state.runStartedAt) / 1000)}`,
      [{ v: fmtTime(wave.total), l: 'audio' }, { v: fmtNum(words), l: 'words' }]);
    updateRefineBar();
    toast(whole ? 'Transcript refined' : 'Passage refined');
    // Phones label the refined stretch afterwards, with Whisper unloaded.
    if (IS_MOBILE && speakersOn()) await labelSpeakers({ from, to });
  } catch (err) {
    if (!current()) return;
    killWorker();
    state.refineRange = null;
    rebuildTranscript();
    wave.setFinished(true);
    setBusy(false);
    progress('Stopped', null, '');
    showError(err instanceof UserError ? err.message : `Refining failed: ${err.message || err}`, "Couldn't refine", { retry: err.retry !== false });
    updateRefineBar();
  }
}

// Select text in the transcript to refine just that passage.
function selectedWindows() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!els.transcript.contains(range.commonAncestorContainer)) return null;
  const hit = state.segEls.map((span, i) => (range.intersectsNode(span) ? i : -1)).filter((i) => i >= 0);
  if (!hit.length) return null;
  return { from: state.segments[hit[0]].start, to: state.segments[hit[hit.length - 1]].end };
}

let pillTimer = 0;
function hideSelPill() {
  clearTimeout(pillTimer);
  els.selPill.classList.add('hidden');
}

// On phones, tapping the pill collapses the selection before the tap lands, so the last
// selected passage is remembered and the pill stays up a moment longer.
document.addEventListener('selectionchange', () => {
  if (state.busy || !state.playable) return hideSelPill();
  const w = selectedWindows();
  if (!w) {
    clearTimeout(pillTimer);
    pillTimer = setTimeout(() => els.selPill.classList.add('hidden'), 1500);
    return;
  }
  clearTimeout(pillTimer);
  state.lastSel = w;
  fillRefineModels();
  els.selPill.classList.remove('hidden');
});

function cancel() {
  const refining = !!state.refineRange;
  const labelling = state.labelling;
  state.abort?.abort();
  state.rejectRun?.(cancelled());
  killWorker();
  if (labelling) {
    state.labelling = false;
    rebuildTranscript();
    refreshNames();
    wave.setDone(wave.total);
    wave.setFinished(true);
    setBusy(false);
    progress('Done', 1, 'Speaker labels stopped; the transcript is complete');
    updateRefineBar();
    return;
  }
  if (refining) {
    state.refineRange = null;
    rebuildTranscript();
    wave.setFinished(true);
    setBusy(false);
    els.steps.classList.add('stopped');
    progress('Cancelled', null, 'Refining stopped. What was refined so far is kept.');
    updateRefineBar();
    return;
  }
  clearJob();
  setBusy(false);
  els.steps.classList.add('stopped');
  progress('Cancelled', null, state.segments.length ? 'What was transcribed so far is below.' : '');
  els.waveWrap.classList.remove('loading');
  if (!state.segments.length) {
    hideSession();
    els.resultCard.classList.add('hidden');
    updateLayout();
  }
}

function offerResume(job, afterReload = true) {
  state.source = { ...job.source, key: job.key };
  state.vocab = vocabulary(state.source);
  state.voices = job.voices || [];
  state.speakerNames = job.speakerNames || {};
  state.audioKey = job.key;
  artInto(els.resumeArt, job.source);
  restoreTranscript(job.segments);
  els.resumeWhy.classList.toggle('hidden', !afterReload);
  const done = fmtTime(job.doneSec);
  els.resumeText.textContent = job.total
    ? `“${job.title}” stopped at ${done} of ${fmtTime(job.total)}.`
    : `“${job.title}” stopped at ${done}.`;
  els.resumeMeter.style.width = job.total ? `${Math.min(100, (job.doneSec / job.total) * 100)}%` : '0';
  els.resumeCard.classList.remove('hidden');
  if (job.lang) {
    const radio = document.querySelector(`input[name=lang][value="${CSS.escape(job.lang)}"]`);
    if (radio) radio.checked = true;
    if (els.models.querySelector('input')) refreshModels();
  }
  updateLayout();
}

function startFile(file) {
  if (!file || state.busy) return;
  const fileId = `file:${file.name}:${file.size}:${file.lastModified}`;
  run(async () => ({ kind: 'audio', title: file.name.replace(/\.[a-z0-9]{2,5}$/i, ''), file, fileId }));
}

/* ---------- setup ---------- */

async function detectGpu() {
  // Every iOS browser runs on WebKit, where the GPU path needs a WebAssembly build that
  // takes gigabytes to compile. The CPU path stays well within an iPhone's memory.
  if (IS_IOS || store.get('gpu-broken', '') === '1') return;
  try {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (adapter) {
      state.gpu.available = true;
      state.gpu.f16 = adapter.features.has('shader-f16');
    }
  } catch {}
}

function updateDeviceChip() {
  document.body.dataset.gpu = state.gpu.available ? '1' : '0';
}

// The front page's specimen: a made-up episode's waveform, a third of it played.
function drawSpecimen() {
  const canvas = $('#specimen-wave');
  if (!canvas) return;
  const w = new Waveform(canvas.parentElement, canvas, $('#specimen-tip'));
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const levels = new Uint8Array(900);
  let loud = 0.5;
  for (let i = 0; i < levels.length; i++) {
    if (rnd() < 0.08) loud = 0.25 + rnd() * 0.75; // a new speaker or sentence
    levels[i] = rnd() < 0.06 ? 3 : Math.round(20 + loud * 140 * (0.6 + rnd() * 0.4));
  }
  w.reset(levels.length, levels);
  w.setFinished(true);
  w.setPosition(levels.length * 0.36);
}

function selectedModel() {
  return els.models.querySelector('input[name=model]:checked')?.value || 'small';
}

function modelSizeMB(m) {
  if (!state.gpu.available) return m.mb.cpu;
  return state.gpu.f16 ? m.mb.gpu16 : m.mb.gpu32;
}

function refreshModels() {
  fillModels(selectedModel());
}

function fillModels(keep = null) {
  const saved = keep || store.get('model', null);
  const rec = recommendedModel({ mobile: IS_MOBILE, gpu: state.gpu.available });
  const chosen = MODELS[saved] ? saved : rec;
  const lang = language();
  els.models.querySelectorAll('.model').forEach((l) => l.remove());
  for (const key of Object.keys(MODELS)) {
    const m = modelFor(key, lang);
    const label = el('label', 'model');
    const input = el('input');
    input.type = 'radio';
    input.name = 'model';
    input.value = key;
    input.checked = key === chosen;
    const mb = modelSizeMB(m);
    const span = el('span', '', key === 'turbo' ? 'Large' : m.name);
    span.append(el('span', 'model-size', mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`));
    label.append(input, span);
    els.models.append(label);
  }
  updateModelHint();
  updateSettingsSummary();
}

function updateModelHint() {
  const key = selectedModel();
  const m = modelFor(key, language());
  const mb = modelSizeMB(MODELS[key]);
  const parts = [`${m.note}.`];
  if (!state.gpu.available) parts.push('No GPU here, so this runs on the CPU and takes roughly as long as the episode.');
  if (IS_IOS) parts.push('Keep the screen on until it finishes.');
  if (IS_MOBILE && mb > 300) parts.push('This size may be too big for a phone.');
  els.modelNote.textContent = parts.join(' ');
  els.deviceHint.textContent = '';
}

// Returning visitors (a saved choice or transcripts in the library) see settings folded into
// their one-line summary, so the library sits right below the command bar.
function foldSettings(fold) {
  els.settings.classList.toggle('collapsible', fold);
  if (!fold) els.settings.classList.remove('open');
}

function updateSettingsSummary() {
  const m = MODELS[selectedModel()];
  els.settingsSummary.textContent = `${LANG_NAMES[language()]} · ${m?.name || ''} model`;
}


function closeMenus() {
  els.exportMenu.classList.remove('open');
  els.exportBtn.setAttribute('aria-expanded', 'false');
}

function wireEvents() {
  document.querySelectorAll('input[name=lang]').forEach((r) => r.addEventListener('change', () => { store.set('lang', language()); refreshModels(); }));
  els.models.addEventListener('change', () => { store.set('model', selectedModel()); updateModelHint(); updateSettingsSummary(); });
  els.proxy.addEventListener('change', () => store.set('proxy', els.proxy.value.trim()));
  els.glossary.addEventListener('change', applyGlossary);
  els.namesBtn.addEventListener('click', () => toggleNames());
  els.speakers.addEventListener('change', () => store.set('speakers', els.speakers.checked ? '1' : '0'));
  els.settingsToggle.addEventListener('click', () => {
    const open = els.settings.classList.toggle('open');
    els.settingsToggle.setAttribute('aria-expanded', String(open));
  });

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.busy) return;
    const value = els.url.value;
    if (!value.trim()) {
      els.url.focus();
      els.form.classList.remove('shake');
      void els.form.offsetWidth;
      els.form.classList.add('shake');
      toast('Paste a podcast link first');
      return;
    }
    els.url.blur();
    els.settings.classList.remove('open');
    run(() => resolveLink(value));
  });

  if (navigator.clipboard?.readText) {
    els.paste.addEventListener('click', async () => {
      try {
        const text = (await navigator.clipboard.readText()).trim();
        if (!text) { toast('The clipboard is empty'); return; }
        const link = normalizeLink(text);
        els.url.value = link || text;
        if (link) els.go.focus();
        else toast("That doesn't look like a link");
      } catch {
        els.url.focus();
        toast('Paste the link into the field');
      }
    });
  } else {
    els.paste.classList.add('hidden');
  }

  for (const input of [els.file, els.errorFile]) {
    input.addEventListener('change', () => {
      const file = input.files[0];
      input.value = '';
      startFile(file);
    });
  }

  els.cancel.addEventListener('click', cancel);
  els.refineAll.addEventListener('click', () => refine());
  $('#refine-sel').addEventListener('click', () => { const w = selectedWindows() || state.lastSel; if (w) refine(w); });
  els.refineModel.addEventListener('change', () => { els.selModel.textContent = `with ${els.refineModel.selectedOptions[0]?.textContent || ''}`; });
  els.sessionClose.addEventListener('click', closeSession);
  $('#new-transcript').addEventListener('click', () => { closeSession(); setTimeout(() => els.url.focus({ preventScroll: true }), 400); });
  document.querySelector('.brand').addEventListener('click', (e) => {
    e.preventDefault();
    closeSession();
  });
  els.filter.addEventListener('input', renderEpisodes);
  $('#episodes-close').addEventListener('click', () => { els.episodesCard.classList.add('hidden'); updateLayout(); });
  els.errorClose.addEventListener('click', clearError);
  els.errorRetry.addEventListener('click', () => { clearError(); state.lastAttempt?.(); });

  els.copy.addEventListener('click', copyTranscript);
  els.dockCopy.addEventListener('click', copyTranscript);
  els.dockSave.addEventListener('click', () => (IS_MOBILE ? shareTranscript() : downloadTranscript()));
  els.exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = els.exportMenu.classList.toggle('open');
    els.exportBtn.setAttribute('aria-expanded', String(open));
  });
  for (const [btn, fn] of [[els.download, downloadTranscript], [els.downloadSrt, downloadSrt], [els.downloadVtt, downloadVtt], [els.share, shareTranscript]]) {
    btn.addEventListener('click', () => { closeMenus(); fn(); });
  }
  document.addEventListener('click', (e) => { if (!els.exportMenu.contains(e.target)) closeMenus(); });
  els.timestamps.addEventListener('change', () => els.transcript.classList.toggle('show-ts', els.timestamps.checked));

  els.search.addEventListener('input', scheduleSearch);
  els.search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (state.find.ranges.length) goToMatch(state.find.index + (e.shiftKey ? -1 : 1)); else runSearch(true); }
    if (e.key === 'Escape') { els.search.value = ''; runSearch(false); els.search.blur(); }
  });
  els.findNext.addEventListener('click', () => goToMatch(state.find.index + 1));
  els.findPrev.addEventListener('click', () => goToMatch(state.find.index - 1));

  els.transcript.addEventListener('click', (e) => {
    const ts = e.target.closest('.ts');
    if (ts) { playFrom(Number(ts.dataset.t)); return; }
    const who = e.target.closest('.who');
    if (who) { renameSpeaker(who); return; }
    const seg = e.target.closest('.seg');
    if (!seg || !state.playable || !window.getSelection().isCollapsed) return;
    playFrom(Number(seg.dataset.start));
  });

  for (const b of [els.play, els.miniPlay, els.dockPlay]) b.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
  els.mini.addEventListener('click', () => els.progressCard.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  els.jump.addEventListener('click', scrollToLive);

  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      document.body.classList.toggle('scrolled', window.scrollY > 4);
      if (state.busy && nearLive()) els.jump.classList.add('hidden');
    });
  }, { passive: true });
  for (const ev of ['wheel', 'touchmove']) window.addEventListener(ev, () => { state.userScrolledAt = Date.now(); }, { passive: true });

  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if (e.key === 'Escape') {
      closeMenus();
      if (!els.episodesCard.classList.contains('hidden')) { els.episodesCard.classList.add('hidden'); updateLayout(); }
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/' && !els.resultCard.classList.contains('hidden')) { e.preventDefault(); els.search.focus(); }
    if (e.key === 'k' && state.playable) { e.preventDefault(); togglePlay(); }
  });

  // Drop an audio file anywhere on the page.
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e) || state.busy) return; depth++; els.dropzone.hidden = false; });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; els.dropzone.hidden = true; } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    els.dropzone.hidden = true;
    startFile(e.dataTransfer.files[0]);
  });
}

async function init() {
  // The page is rebuilt after every load, so a restored scroll position points at nothing
  // (after a crash-reload it would hide the resume card above the fold).
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  const savedLang = store.get('lang', null);
  if (savedLang) {
    const radio = document.querySelector(`input[name=lang][value="${CSS.escape(savedLang)}"]`);
    if (radio) radio.checked = true;
  }
  els.proxy.value = store.get('proxy', '');
  els.glossary.value = store.get('glossary', '');
  els.speakers.checked = speakersOn();
  try {
    state.canShareFiles = !!navigator.canShare?.({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] });
  } catch {}
  els.share.classList.toggle('hidden', !state.canShareFiles);
  if (!IS_MOBILE) els.dockSave.querySelector('span').textContent = 'Download';
  if (store.get('model', null)) foldSettings(true);
  wireEvents();
  drawSpecimen();
  fillModels();
  updateDeviceChip();

  await detectGpu();
  updateDeviceChip();
  refreshModels();

  $('#resume').addEventListener('click', () => {
    const job = loadJob();
    if (job && !state.busy) run(null, job);
  });
  $('#discard').addEventListener('click', () => {
    if (state.busy) return;
    clearJob();
    closeSession();
  });

  const job = loadJob();
  if (job?.source && job.doneSec >= 0) offerResume(job);
  updateLayout();

  const shared = new URLSearchParams(location.search).get('url');
  if (shared) els.url.value = shared;
}

init();

// For tests.
export { decodePieces, decodeMono16k, toSrt };
