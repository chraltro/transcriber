import { indexMp3 } from './lib/mp3.js';
import { MODELS, modelFor } from './lib/models.js';
import { AUDIO_EXT, audioCandidates, parseFeed, looksLikeFeed, findAudioInHtml } from './lib/links.js';
import { fmtTime, normTitle, bestTitleMatch, sameShow } from './lib/text.js';
import { indexWav, wavPiece } from './lib/wav.js';
import { toSrt, toVtt } from './lib/subtitles.js';

const $ = (sel) => document.querySelector(sel);

const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_MOBILE = IS_IOS || /Android/i.test(navigator.userAgent);

const els = {
  form: $('#url-form'), url: $('#url'), go: $('#go'), models: $('#models'), file: $('#file'), proxy: $('#proxy'),
  deviceHint: $('#device-hint'),
  episodesCard: $('#episodes-card'), feedTitle: $('#feed-title'), episodesNote: $('#episodes-note'), episodes: $('#episodes'), filter: $('#episode-filter'),
  progressCard: $('#progress-card'), stage: $('#stage'), bar: $('#bar-fill'), detail: $('#detail'), cancel: $('#cancel'),
  errorCard: $('#error-card'), error: $('#error'),
  resumeCard: $('#resume-card'), resumeText: $('#resume-text'), resumeWhy: $('#resume-why'),
  resultCard: $('#result-card'), title: $('#episode-title'), transcript: $('#transcript'),
  copy: $('#copy'), download: $('#download'), downloadSrt: $('#download-srt'), downloadVtt: $('#download-vtt'), timestamps: $('#timestamps'),
  announce: $('#announce'),
};

const state = {
  gpu: { available: false, f16: false },
  worker: null,
  abort: null,
  segments: [],
  title: '',
  busy: false,
  episodeList: [],
  wakeLock: null,
  rejectRun: null,
  job: null,
  jobSeq: 0,
};

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

function language() {
  return document.querySelector('input[name=lang]:checked').value;
}

class UserError extends Error {}

/* ---------- UI state ---------- */

function showError(msg) {
  els.error.textContent = msg;
  els.errorCard.classList.remove('hidden');
}

function clearError() {
  els.errorCard.classList.add('hidden');
}

function setBusy(busy) {
  state.busy = busy;
  window.__transcriberBusy = busy; // coi-sw.js never reloads the page while this is set
  els.go.disabled = busy;
  els.file.disabled = busy;
  els.progressCard.classList.toggle('hidden', !busy);
  if (busy) acquireWakeLock(); else releaseWakeLock();
}

function progress(stage, fraction, detail = '') {
  els.stage.textContent = stage;
  if (fraction == null) {
    els.bar.classList.add('indeterminate');
    els.bar.style.width = '';
    els.bar.parentElement.removeAttribute('aria-valuenow');
  } else {
    const pct = Math.min(100, fraction * 100);
    els.bar.classList.remove('indeterminate');
    els.bar.style.width = `${pct.toFixed(1)}%`;
    els.bar.parentElement.setAttribute('aria-valuenow', Math.round(pct));
  }
  els.detail.textContent = detail;
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
    if (hit) return { kind: 'audio', url: hit.url, title: hit.title };
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
      const episodes = results
        .filter((r) => r.wrapperType === 'podcastEpisode' && r.episodeUrl)
        .map((e) => ({
          id: String(e.trackId), title: e.trackName, url: e.episodeUrl, date: e.releaseDate,
          duration: e.trackTimeMillis ? fmtTime(e.trackTimeMillis / 1000) : '',
        }));
      if (show || episodes.length) return { show, episodes };
    } catch {}
  }
  return { show: null, episodes: [] };
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
  const { show, episodes } = await itunesLookupEpisodes(showId);
  if (episodeId) {
    const ep = episodes.find((e) => e.id === episodeId);
    if (ep) return { kind: 'audio', url: ep.url, title: ep.title };
  }
  if (show?.feedUrl) {
    try { return await resolveFeed(show.feedUrl); } catch (err) { if (err.name === 'AbortError') throw err; }
  }
  if (episodes.length) {
    return { kind: 'list', title: show?.collectionName || 'Episodes', episodes, note: episodeId ? "Couldn't find that exact episode, pick it from the list." : '' };
  }
  throw new UserError("Couldn't load that podcast from Apple. Try its RSS feed or Pocket Casts link instead.");
}

// Find an episode (or a show's episode list) by name through Apple's directory.
async function findByName(showName, episodeTitle) {
  if (episodeTitle) {
    const eps = await itunesSearch(`${episodeTitle} ${showName || ''}`.trim(), 'podcastEpisode',
      (e) => e.episodeUrl && (!showName || sameShow(e.collectionName, showName)));
    const hit = bestTitleMatch(eps.map((e) => ({ title: e.trackName, url: e.episodeUrl })), episodeTitle);
    if (hit) return { kind: 'audio', ...hit };
  }
  if (!showName) return null;

  const shows = await itunesSearch(showName, 'podcast', (s) => sameShow(s.collectionName, showName));
  const show = shows.find((s) => normTitle(s.collectionName) === normTitle(showName)) || shows[0];
  if (!show) return null;
  const { episodes } = await itunesLookupEpisodes(show.collectionId);
  if (episodeTitle) {
    const hit = bestTitleMatch(episodes, episodeTitle);
    if (hit) return { kind: 'audio', url: hit.url, title: hit.title };
  } else if (episodes.length) {
    return { kind: 'list', title: show.collectionName, episodes };
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
    if (exact.length === 1) return { kind: 'audio', url: exact[0].episodeUrl, title: exact[0].trackName };
    const words = new Set(normTitle(title).split(' '));
    const close = (exact.length ? exact : eps)
      .map((e) => ({ e, shared: normTitle(e.trackName).split(' ').filter((w) => words.has(w)).length }))
      .filter((x) => x.shared >= Math.min(2, words.size))
      .sort((a, b) => b.shared - a.shared)
      .slice(0, 10)
      .map(({ e }) => ({ title: `${e.trackName} (${e.collectionName})`, url: e.episodeUrl, date: e.releaseDate, duration: e.trackTimeMillis ? fmtTime(e.trackTimeMillis / 1000) : '' }));
    if (close.length) return { kind: 'list', title: `Which episode is "${title}"?`, episodes: close };
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
    const { show, episodes } = await itunesLookupEpisodes(hit.showId);
    if (episodes.length) return { kind: 'list', title: show?.collectionName || 'Episodes', episodes };
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
  try { u = new URL(raw.trim()); } catch { throw new UserError("That doesn't look like a link. Paste a full URL starting with https://"); }
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
  state.episodeList = feed.episodes;
  els.feedTitle.textContent = feed.title || 'Pick an episode';
  els.episodesNote.textContent = feed.note || '';
  els.episodesNote.classList.toggle('hidden', !feed.note);
  els.filter.value = '';
  renderEpisodes();
  els.episodesCard.classList.remove('hidden');
  els.episodesCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  els.filter.focus({ preventScroll: true });
}

function renderEpisodes() {
  const q = normTitle(els.filter.value);
  els.episodes.replaceChildren();
  for (const ep of state.episodeList) {
    if (q && !normTitle(ep.title).includes(q)) continue;
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = ep.title;
    const meta = document.createElement('span');
    meta.className = 'meta';
    const date = ep.date ? new Date(ep.date) : null;
    meta.textContent = [date && !isNaN(date) ? date.toLocaleDateString() : '', formatDuration(ep.duration)].filter(Boolean).join(' · ');
    btn.append(meta);
    btn.addEventListener('click', () => {
      if (state.busy) return;
      els.episodesCard.classList.add('hidden');
      run(() => Promise.resolve({ kind: 'audio', url: ep.url, title: ep.title }));
    });
    li.append(btn);
    els.episodes.append(li);
  }
}

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

async function transcribeAudio(blob, fromSec = 0) {
  const worker = getWorker();
  const id = ++state.jobSeq;
  const model = modelFor(selectedModel(), language());
  const files = new Map();
  let total = 0;
  let buffered = 0;
  let ready = false;
  let wake = null;
  let lastHeard = Date.now();
  let finish;
  let fail;
  const finished = new Promise((res, rej) => { finish = res; fail = rej; });
  finished.catch(() => {});
  state.rejectRun = fail;
  const nudge = () => { const w = wake; wake = null; w?.(); };
  const watchdog = setInterval(() => {
    if (Date.now() - lastHeard < WATCHDOG_MS) return;
    fail(new UserError('The speech model stopped responding, most likely because the browser ran out of memory. Try a smaller model, then Resume: your progress is saved.'));
    nudge();
  }, 15000);

  progress('Loading speech model', null, 'First run downloads the model, then it is cached');

  worker.onmessage = ({ data: m }) => {
    if (m.id !== id) return; // from an earlier job in this worker
    lastHeard = Date.now();
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
        progress('Downloading speech model', size ? loaded / size : null, `${fmtBytes(loaded)} of ${fmtBytes(size)} (only needed once)`);
        break;
      }
      case 'ready':
        ready = true;
        progress('Transcribing', total ? fromSec / total : 0, m.device === 'webgpu' ? 'Using your GPU' : 'Using your CPU. This is slower than a GPU.');
        break;
      case 'buffered':
        buffered = m.seconds;
        nudge();
        break;
      case 'segment': {
        buffered = m.buffered;
        addSegment(m);
        saveProgress(m.end, total);
        const rate = (m.end - fromSec) / Math.max(m.elapsed, 0.001);
        const eta = (total - m.end) / Math.max(rate, 0.001);
        progress(
          'Transcribing',
          total ? m.end / total : null,
          `${fmtTime(m.end)} of ${fmtTime(total)} · ${rate.toFixed(1)}x realtime · about ${fmtTime(eta)} left`
        );
        nudge();
        break;
      }
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
      sessionOptions: SESSION_OVERRIDE,
      offsetSec: fromSec,
    });

    // Decode while the model loads and while earlier pieces are transcribed, but never run
    // more than MAX_AHEAD_SECONDS ahead of the worker, so memory stays flat.
    let pieces = 0;
    for await (const piece of decodePieces(blob, (t) => { total = t; }, fromSec)) {
      if (!pieces++ && !fromSec && piece.length < SAMPLE_RATE) throw new UserError('That audio is empty or too short to transcribe.');
      buffered += piece.length / SAMPLE_RATE;
      worker.postMessage({ type: 'audio', id, samples: piece }, [piece.buffer]);
      while (buffered > MAX_AHEAD_SECONDS) await Promise.race([new Promise((r) => { wake = r; }), finished]);
    }
    worker.postMessage({ type: 'audio', id, samples: new Float32Array(0), final: true });
    await finished;
  } finally {
    clearInterval(watchdog);
    state.rejectRun = null;
  }
}

/* ---------- transcript output ---------- */

function resetTranscript(title) {
  state.segments = [];
  state.title = title || 'Transcript';
  els.title.textContent = state.title;
  els.transcript.replaceChildren();
  const p = document.createElement('p');
  p.className = 'working';
  p.textContent = 'The transcript will appear here as it is written.';
  els.transcript.append(p);
  els.resultCard.classList.remove('hidden');
}

function restoreTranscript(job) {
  resetTranscript(job.title);
  for (const seg of job.segments) addSegment(seg);
}

function addSegment({ start, end, text }) {
  if (!text) return;
  if (!state.segments.length) els.transcript.replaceChildren();
  state.segments.push({ start, end, text });
  const nearBottom = els.transcript.scrollHeight - els.transcript.scrollTop - els.transcript.clientHeight < 40;
  const p = document.createElement('p');
  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = `[${fmtTime(start)}]`;
  p.append(ts, document.createTextNode(text));
  els.transcript.append(p);
  if (nearBottom) els.transcript.scrollTop = els.transcript.scrollHeight;
}

function transcriptText() {
  const withTs = els.timestamps.checked;
  return state.segments.map((s) => (withTs ? `[${fmtTime(s.start)}] ` : '') + s.text).join('\n\n');
}

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
  els.copy.textContent = 'Copied!';
  setTimeout(() => { els.copy.textContent = 'Copy'; }, 1800);
}

function saveFile(content, ext, type) {
  if (!state.segments.length) return;
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 100).trim() || 'transcript'}.${ext}`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const downloadTranscript = () => saveFile(`${state.title}\n\n${transcriptText()}\n`, 'txt', 'text/plain');
const downloadSrt = () => saveFile(toSrt(state.segments), 'srt', 'application/x-subrip');
const downloadVtt = () => saveFile(toVtt(state.segments), 'vtt', 'text/vtt');

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
  saveJob({ ...state.job, segments: state.segments, doneSec, total: total || state.job.total });
}

function clearJob() {
  const key = state.job?.key || loadJob()?.key;
  state.job = null;
  try { localStorage.removeItem(JOB_KEY); } catch {}
  if (key) forgetAudio(key);
}

function announce(text) {
  els.announce.textContent = '';
  setTimeout(() => { els.announce.textContent = text; }, 50);
}

// One run at a time. Every await is followed by a check that this run is still the current
// one, so a cancelled or replaced run can never touch the page, the worker or saved progress.
async function run(getSource, resume = null) {
  if (state.busy) return;
  clearError();
  els.resumeCard.classList.add('hidden');
  const ctl = new AbortController();
  state.abort = ctl;
  const current = () => state.abort === ctl && !ctl.signal.aborted;
  setBusy(true);
  try {
    const source = resume ? resume.source : await getSource();
    if (!current()) return;
    if (source.kind === 'list') {
      setBusy(false);
      showEpisodes(source);
      return;
    }
    els.episodesCard.classList.add('hidden');
    const key = audioKey(source.url || source.fileId);
    if (resume) restoreTranscript(resume);
    else resetTranscript(source.title);

    let blob;
    if (source.url) {
      blob = await downloadAudio(source.url, key);
    } else if (source.file) {
      // Kept on disk so a reload can resume; if storage is full, the file itself works too.
      blob = await storeAudio(key, new Response(source.file), () => source.file);
    } else {
      blob = await cachedAudio(key);
      if (!blob) throw new UserError('That file is no longer stored in the browser. Pick it again under "More options".');
    }
    if (!current()) return;

    const fromSec = resume?.doneSec || 0;
    saveJob({
      source: { kind: 'audio', title: source.title, url: source.url, fileId: source.fileId },
      key,
      title: source.title,
      lang: language(),
      segments: state.segments,
      doneSec: fromSec,
      total: resume?.total || 0,
    });
    await transcribeAudio(blob, fromSec);
    blob = null;
    if (!current()) return;
    clearJob();
    if (!state.segments.length) {
      els.transcript.replaceChildren();
      const p = document.createElement('p');
      p.className = 'working';
      p.textContent = 'No speech found. Check that the language setting matches the podcast.';
      els.transcript.append(p);
    }
    progress('Done', 1, '');
    setBusy(false);
    announce('Transcript finished.');
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
      const job = loadJob();
      if (job) return run(null, job);
    }
    if (err instanceof UserError) console.warn(err.message); else console.error(err);
    showError(err instanceof UserError ? err.message : `Something went wrong: ${err.message || err}`);
    els.errorCard.focus?.();
    const job = loadJob();
    if (job?.doneSec > 0) offerResume(job, false);
  }
}

function cancel() {
  state.abort?.abort();
  state.rejectRun?.(cancelled());
  killWorker();
  clearJob();
  setBusy(false);
  progress('Cancelled', null, '');
}

function offerResume(job, afterReload = true) {
  restoreTranscript(job);
  els.resumeWhy.classList.toggle('hidden', !afterReload);
  const done = fmtTime(job.doneSec);
  els.resumeText.textContent = job.total
    ? `"${job.title}" stopped at ${done} of ${fmtTime(job.total)}.`
    : `"${job.title}" stopped at ${done}.`;
  els.resumeCard.classList.remove('hidden');
  if (job.lang) {
    const radio = document.querySelector(`input[name=lang][value="${CSS.escape(job.lang)}"]`);
    if (radio) radio.checked = true;
    if (els.models.querySelector('input')) refreshModels();
  }
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

function selectedModel() {
  return els.models.querySelector('input[name=model]:checked')?.value || 'small';
}

function modelSizeMB(m) {
  if (!state.gpu.available) return m.mb.cpu;
  return state.gpu.f16 ? m.mb.gpu16 : m.mb.gpu32;
}

function refreshModels() {
  const chosen = selectedModel();
  els.models.querySelectorAll('.model-opt').forEach((l) => l.remove());
  fillModels(chosen);
}

function fillModels(keep = null) {
  const saved = keep || store.get('model', null);
  const fallback = IS_MOBILE ? 'base' : state.gpu.available ? 'turbo' : 'small';
  const chosen = MODELS[saved] ? saved : fallback;
  for (const key of Object.keys(MODELS)) {
    const m = modelFor(key, language());
    const label = document.createElement('label');
    label.className = 'model-opt';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'model';
    input.value = key;
    input.checked = key === chosen;
    const name = document.createElement('span');
    name.className = 'm-name';
    name.textContent = m.name;
    const size = document.createElement('span');
    size.className = 'm-size';
    const mb = modelSizeMB(m);
    size.textContent = mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
    const note = document.createElement('span');
    note.className = 'm-note';
    note.textContent = m.note;
    label.append(input, name, size, note);
    els.models.append(label);
  }
  updateModelHint();
}

function updateModelHint() {
  const key = selectedModel();
  const mb = modelSizeMB(MODELS[key]);
  const m = modelFor(key, language());
  const parts = [state.gpu.available
    ? 'Your browser can use the GPU, so an hour-long episode takes minutes.'
    : 'No GPU access in this browser, so transcription runs on the CPU and can take about as long as the episode.'];
  if (IS_IOS) parts.push('On iPhone and iPad, keep this page open with the screen on until it finishes: iOS pauses pages in the background.');
  if (IS_MOBILE && mb > 300) parts.push('This model may be too big for a phone, and the browser can reload the page if it runs out of memory. Pick Base or Tiny if that happens.');
  else if (!state.gpu.available && key === 'turbo') parts.push('Large v3 Turbo is very slow on a CPU.');
  if (m.tuned) parts.push('For Norwegian this uses NB-Whisper, trained by the National Library of Norway, which writes Bokmål.');
  els.deviceHint.textContent = parts.join(' ');
}

async function init() {
  const savedLang = store.get('lang', null);
  if (savedLang) {
    const radio = document.querySelector(`input[name=lang][value="${CSS.escape(savedLang)}"]`);
    if (radio) radio.checked = true;
  }
  els.proxy.value = store.get('proxy', '');

  document.querySelectorAll('input[name=lang]').forEach((r) => r.addEventListener('change', () => { store.set('lang', language()); refreshModels(); }));
  els.models.addEventListener('change', () => { store.set('model', selectedModel()); updateModelHint(); });
  els.proxy.addEventListener('change', () => store.set('proxy', els.proxy.value.trim()));

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.busy) return;
    els.episodesCard.classList.add('hidden');
    const value = els.url.value;
    run(() => resolveLink(value));
  });

  els.file.addEventListener('change', () => {
    const file = els.file.files[0];
    if (!file || state.busy) return;
    const fileId = `file:${file.name}:${file.size}:${file.lastModified}`;
    run(async () => ({ kind: 'audio', title: file.name, file, fileId }));
    els.file.value = '';
  });

  els.cancel.addEventListener('click', cancel);
  els.filter.addEventListener('input', renderEpisodes);
  els.copy.addEventListener('click', copyTranscript);
  els.download.addEventListener('click', downloadTranscript);
  els.downloadSrt.addEventListener('click', downloadSrt);
  els.downloadVtt.addEventListener('click', downloadVtt);
  els.timestamps.addEventListener('change', () => els.transcript.classList.toggle('show-ts', els.timestamps.checked));
  $('#episodes-close').addEventListener('click', () => els.episodesCard.classList.add('hidden'));

  await detectGpu();
  fillModels();

  $('#resume').addEventListener('click', () => {
    const job = loadJob();
    if (job && !state.busy) run(null, job);
  });
  $('#discard').addEventListener('click', () => {
    if (state.busy) return;
    clearJob();
    els.resumeCard.classList.add('hidden');
    els.resultCard.classList.add('hidden');
  });

  const job = loadJob();
  if (job?.source && job.doneSec >= 0) offerResume(job);

  const shared = new URLSearchParams(location.search).get('url');
  if (shared) els.url.value = shared;
}

init();

// For tests.
export { decodePieces, decodeMono16k, toSrt };
