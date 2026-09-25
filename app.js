const $ = (sel) => document.querySelector(sel);

// Download sizes (MB) of the weights each device actually loads: CPU uses 8-bit weights,
// GPUs use fp16/4-bit when they support 16-bit floats, fp32/4-bit otherwise.
const MODELS = {
  tiny: { id: 'onnx-community/whisper-tiny', name: 'Tiny', note: 'Fastest, rough text', mb: { cpu: 41, gpu16: 104, gpu32: 120 } },
  base: { id: 'onnx-community/whisper-base', name: 'Base', note: 'Fast, weak on Norwegian and Danish', mb: { cpu: 77, gpu16: 165, gpu32: 206 } },
  small: { id: 'onnx-community/whisper-small', name: 'Small', note: 'Good balance', mb: { cpu: 249, gpu16: 410, gpu32: 586 } },
  turbo: { id: 'onnx-community/whisper-large-v3-turbo', name: 'Large v3 Turbo', note: 'Best, especially for Norwegian and Danish', mb: { cpu: 1085, gpu16: 564, gpu32: 759 } },
};

const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|mp4|m4b|webm)$/i;
const AUDIO_URL_IN_TEXT = /https?:\\?\/\\?\/[^"'\s<>()]+?\.(?:mp3|m4a|aac|ogg|opus|wav|m4b)(?:\?[^"'\s<>()]*)?(?=["'\s<>()]|$)/gi;

const els = {
  form: $('#url-form'), url: $('#url'), go: $('#go'), models: $('#models'), file: $('#file'), proxy: $('#proxy'),
  deviceHint: $('#device-hint'),
  episodesCard: $('#episodes-card'), feedTitle: $('#feed-title'), episodes: $('#episodes'), filter: $('#episode-filter'),
  progressCard: $('#progress-card'), stage: $('#stage'), bar: $('#bar-fill'), detail: $('#detail'), cancel: $('#cancel'),
  errorCard: $('#error-card'), error: $('#error'),
  resultCard: $('#result-card'), title: $('#episode-title'), transcript: $('#transcript'),
  copy: $('#copy'), download: $('#download'), timestamps: $('#timestamps'),
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
};

/* ---------- small helpers ---------- */

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return `${h ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
}

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
  } else {
    els.bar.classList.remove('indeterminate');
    els.bar.style.width = `${Math.min(100, fraction * 100).toFixed(1)}%`;
  }
  els.detail.textContent = detail;
}

async function acquireWakeLock() {
  try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}

function releaseWakeLock() {
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (state.busy && document.visibilityState === 'visible') acquireWakeLock();
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
  return new Promise((resolve, reject) => {
    const cb = `__jsonp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    const cleanup = () => { delete window[cb]; script.remove(); clearTimeout(timer); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Request timed out')); }, timeout);
    window[cb] = (data) => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error('Request failed')); };
    script.src = `${url}${url.includes('?') ? '&' : '?'}callback=${cb}`;
    document.head.appendChild(script);
  });
}

// Podcast audio URLs are often wrapped in tracking redirects, e.g.
// https://dts.podtrac.com/redirect.mp3/audioboom.com/posts/1.mp3. Some of those hops don't
// allow browser downloads even when the real host does, so also try each embedded URL.
function audioCandidates(url) {
  const out = [url];
  let u;
  try { u = new URL(url); } catch { return out; }
  const encoded = u.pathname.match(/https?%3A%2F%2F.+$/i);
  if (encoded) out.push(decodeURIComponent(encoded[0]));
  const segs = u.pathname.split('/');
  const inner = [];
  for (let i = 1; i < segs.length - 1; i++) {
    if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(segs[i])) inner.push(`https://${segs.slice(i).join('/')}${u.search}`);
  }
  out.push(...inner.reverse());
  return [...new Set(out)];
}

async function downloadAudio(url) {
  progress('Downloading episode', null, 'Connecting');
  let res = null;
  for (const candidate of audioCandidates(url)) {
    try {
      res = await smartFetch(candidate);
      break;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
    }
  }
  if (!res) {
    throw new UserError(
      "The podcast's host doesn't allow web pages to download its audio, so this episode can't be fetched from the browser.\n\n" +
      'Download the episode yourself and pick the file under "More options", or add your own CORS proxy there.'
    );
  }
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());

  // Write straight into one buffer instead of collecting chunks and copying them at the end.
  const reader = res.body.getReader();
  let bytes = new Uint8Array(total || 32e6);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > bytes.length) {
      const bigger = new Uint8Array(Math.max(bytes.length * 2, got + value.length));
      bigger.set(bytes.subarray(0, got));
      bytes = bigger;
    }
    bytes.set(value, got);
    got += value.length;
    progress('Downloading episode', total ? got / total : null, total ? `${fmtBytes(got)} of ${fmtBytes(total)}` : fmtBytes(got));
  }
  return bytes.subarray(0, got);
}

/* ---------- link resolution ---------- */

function textOf(parent, tag) {
  return parent.getElementsByTagName(tag)[0]?.textContent?.trim() || '';
}

function parseFeed(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) return null;
  const channel = doc.getElementsByTagName('channel')[0] || doc.documentElement;
  const title = textOf(channel, 'title');
  const episodes = [];
  for (const item of doc.getElementsByTagName('item')) {
    const enc = item.getElementsByTagName('enclosure')[0];
    const url = enc?.getAttribute('url') || textOf(item, 'media:content');
    if (!url) continue;
    episodes.push({
      title: textOf(item, 'title') || 'Untitled episode',
      url,
      date: textOf(item, 'pubDate'),
      duration: textOf(item, 'itunes:duration'),
    });
  }
  return { title, episodes };
}

const looksLikeFeed = (text) => /<(rss|feed)[\s>]/i.test(text.slice(0, 2000)) && /<(item|entry)[\s>]/i.test(text);

function findAudioInHtml(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const abs = (u) => { try { return new URL(u, baseUrl).href; } catch { return null; } };
  const title = doc.querySelector('meta[property="og:title"]')?.content || doc.title || '';

  const direct =
    doc.querySelector('meta[property="og:audio"], meta[property="og:audio:url"], meta[property="og:audio:secure_url"]')?.content ||
    doc.querySelector('meta[name="twitter:player:stream"]')?.content ||
    doc.querySelector('audio[src]')?.getAttribute('src') ||
    doc.querySelector('audio source[src]')?.getAttribute('src');
  if (direct) return { kind: 'audio', url: abs(direct), title };

  // Only trust a bare audio URL in the page source if it's the only one; pages listing
  // several episodes would otherwise hand us the wrong one.
  const found = new Set((html.match(AUDIO_URL_IN_TEXT) || []).map((m) => m.replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&')));
  if (found.size === 1) return { kind: 'audio', url: [...found][0], title };

  const feed = doc.querySelector('link[type="application/rss+xml"], link[type="application/atom+xml"]')?.getAttribute('href');
  if (feed) return { kind: 'feed', url: abs(feed), title };
  return null;
}

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

const normTitle = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function bestTitleMatch(episodes, title) {
  const want = normTitle(title);
  if (!want) return null;
  const exact = episodes.find((e) => normTitle(e.title) === want);
  if (exact) return exact;
  const wantWords = new Set(want.split(' '));
  let best = null;
  let bestScore = 0;
  for (const e of episodes) {
    const words = normTitle(e.title).split(' ');
    const overlap = words.filter((w) => wantWords.has(w)).length / Math.max(wantWords.size, words.length);
    if (overlap > bestScore) { bestScore = overlap; best = e; }
  }
  return bestScore >= 0.6 ? best : null;
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

const sameShow = (a, b) => {
  const x = normTitle(a || '');
  const y = normTitle(b || '');
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};

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
    const found = await findByName('', title);
    if (found) return found;
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
  if (/^(audio|video)\//i.test(type)) {
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
  els.filter.value = '';
  renderEpisodes();
  els.episodesCard.classList.remove('hidden');
  els.episodesCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
 * sample rate first), and phones kill tabs that do that. MP3 files are cut into two-minute
 * pieces at frame boundaries and decoded one at a time, while the worker transcribes the
 * previous piece. */

const SAMPLE_RATE = 16000;
const PIECE_SECONDS = 120;
const MAX_AHEAD_SECONDS = 150; // decoded audio allowed to wait for the worker

const MP3_KBPS = {
  V1L1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  V1L2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  V1L3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  V2L1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  V2L23: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function mp3FrameAt(b, i) {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[i + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layer = (b[i + 1] >> 1) & 3;   // 3 = I, 2 = II, 1 = III
  const brIndex = b[i + 2] >> 4;
  const srIndex = (b[i + 2] >> 2) & 3;
  const pad = (b[i + 2] >> 1) & 1;
  if (version === 1 || layer === 0 || brIndex === 0 || brIndex === 15 || srIndex === 3) return null;
  const v1 = version === 3;
  const table = v1 ? ['', 'V1L3', 'V1L2', 'V1L1'][layer] : layer === 3 ? 'V2L1' : 'V2L23';
  const bitrate = MP3_KBPS[table][brIndex] * 1000;
  const sr = MP3_RATES[version][srIndex];
  if (layer === 3) return { len: (Math.floor((12 * bitrate) / sr) + pad) * 4, spf: 384, sr };
  if (layer === 2) return { len: Math.floor((144 * bitrate) / sr) + pad, spf: 1152, sr };
  return { len: Math.floor(((v1 ? 144 : 72) * bitrate) / sr) + pad, spf: v1 ? 1152 : 576, sr };
}

// Byte offset of every audio frame, or null if this isn't a (clean) MP3.
function indexMp3(b) {
  let i = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    i = 10 + (((b[6] & 127) << 21) | ((b[7] & 127) << 14) | ((b[8] & 127) << 7) | (b[9] & 127)) + (b[5] & 0x10 ? 10 : 0);
  }
  const offsets = [];
  let spf = 0;
  let sr = 0;
  let covered = 0;
  while (i < b.length - 4) {
    const f = mp3FrameAt(b, i);
    // The next frame has to line up as well, so stray 0xFF bytes aren't taken for frames.
    if (f && f.len > 4 && (i + f.len >= b.length - 4 || mp3FrameAt(b, i + f.len))) {
      if (!sr) ({ sr, spf } = f);
      if (f.sr === sr && f.spf === spf) {
        offsets.push(i);
        covered += f.len;
      }
      i += f.len;
    } else {
      i++;
      if (!offsets.length && i > 1 << 20) return null;
    }
  }
  if (offsets.length < 50 || covered < b.length * 0.8) return null;
  // Skip the Xing/Info/VBRI header frame: it holds metadata, and some decoders size their output from it.
  const first = String.fromCharCode(...b.subarray(offsets[0], offsets[0] + 64));
  if (/Xing|Info|VBRI/.test(first)) offsets.shift();
  return { offsets, spf, sr };
}

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

// Yields 16 kHz mono audio, about two minutes at a time. Calls onTotal(seconds) first.
async function* decodePieces(bytes, onTotal) {
  const mp3 = indexMp3(bytes);
  if (!mp3) {
    // Not an MP3 (for example AAC in an .m4a). Those containers can't be cut up, so decode it whole.
    const whole = await decodeMono16k(bytes.slice().buffer);
    onTotal(whole.length / SAMPLE_RATE);
    const step = PIECE_SECONDS * SAMPLE_RATE;
    for (let s = 0; s < whole.length; s += step) yield whole.slice(s, s + step);
    return;
  }
  const { offsets, spf, sr } = mp3;
  onTotal((offsets.length * spf) / sr);
  const per = Math.ceil((PIECE_SECONDS * sr) / spf);
  // MP3 frames can borrow bits from the frames before them, so decode two extra and drop their audio.
  const WARMUP = 2;
  for (let k = 0; k < offsets.length; k += per) {
    const from = Math.max(0, k - WARMUP);
    const end = k + per < offsets.length ? offsets[k + per] : bytes.length;
    const pcm = await decodeMono16k(bytes.slice(offsets[from], end).buffer);
    const drop = Math.round(((k - from) * spf * SAMPLE_RATE) / sr);
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

async function transcribeBytes(bytes) {
  const worker = getWorker();
  const model = MODELS[selectedModel()];
  const files = new Map();
  let total = 0;
  let buffered = 0;
  let ready = false;
  let wake = null;
  let finish;
  let fail;
  const finished = new Promise((res, rej) => { finish = res; fail = rej; });
  finished.catch(() => {});
  state.rejectRun = fail;
  const nudge = () => { const w = wake; wake = null; w?.(); };

  progress('Loading speech model', null, 'First run downloads the model, then it is cached');

  worker.onmessage = ({ data: m }) => {
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
        state.device = m.device;
        progress('Transcribing', 0, m.device === 'webgpu' ? 'Using your GPU' : 'Using your CPU. This is slower than a GPU.');
        break;
      case 'buffered':
        buffered = m.seconds;
        nudge();
        break;
      case 'segment': {
        buffered = m.buffered;
        addSegment(m);
        const rate = m.end / Math.max(m.elapsed, 0.001);
        const eta = (total - m.end) / rate;
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
        fail(new Error(m.message));
        nudge();
        break;
    }
  };
  worker.onerror = (e) => { fail(new Error(e.message || 'The transcription worker crashed. Try a smaller model.')); nudge(); };

  worker.postMessage({
    type: 'start',
    language: language(),
    model: model.id,
    device: state.gpu.available ? 'webgpu' : 'wasm',
    hasF16: state.gpu.f16,
  });

  // Decode while the model loads and while earlier pieces are transcribed, but never run
  // more than MAX_AHEAD_SECONDS ahead of the worker, so memory stays flat.
  let pieces = 0;
  for await (const piece of decodePieces(bytes, (t) => { total = t; })) {
    if (!pieces++ && piece.length < SAMPLE_RATE) throw new UserError('That audio is empty or too short to transcribe.');
    buffered += piece.length / SAMPLE_RATE;
    worker.postMessage({ type: 'audio', samples: piece }, [piece.buffer]);
    while (buffered > MAX_AHEAD_SECONDS) await Promise.race([new Promise((r) => { wake = r; }), finished]);
  }
  bytes = null;
  worker.postMessage({ type: 'audio', samples: new Float32Array(0), final: true });
  await finished;
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

function addSegment({ start, text }) {
  if (!text) return;
  if (!state.segments.length) els.transcript.replaceChildren();
  state.segments.push({ start, text });
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

function downloadTranscript() {
  const text = transcriptText();
  if (!text) return;
  const blob = new Blob([`${state.title}\n\n${text}\n`], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 100) || 'transcript'}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- main flow ---------- */

async function run(getSource) {
  clearError();
  state.abort = new AbortController();
  setBusy(true);
  try {
    const source = await getSource();
    if (source.kind === 'list') {
      setBusy(false);
      showEpisodes(source);
      return;
    }
    els.episodesCard.classList.add('hidden');
    resetTranscript(source.title);
    await transcribeBytes(source.bytes || await downloadAudio(source.url));
    if (!state.segments.length) {
      els.transcript.replaceChildren();
      const p = document.createElement('p');
      p.className = 'working';
      p.textContent = 'No speech found. Check that the language setting matches the podcast.';
      els.transcript.append(p);
    }
    progress('Done', 1, '');
    setBusy(false);
  } catch (err) {
    setBusy(false);
    if (err.name === 'AbortError' || state.abort?.signal.aborted) return;
    console.error(err);
    showError(err instanceof UserError ? err.message : `Something went wrong: ${err.message || err}`);
  }
}

function cancel() {
  state.abort?.abort();
  state.rejectRun?.(new DOMException('Cancelled', 'AbortError'));
  killWorker();
  setBusy(false);
}

/* ---------- setup ---------- */

async function detectGpu() {
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

function fillModels() {
  const saved = store.get('model', null);
  const fallback = IS_MOBILE ? 'base' : state.gpu.available ? 'turbo' : 'small';
  const chosen = MODELS[saved] ? saved : fallback;
  for (const [key, m] of Object.entries(MODELS)) {
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
  const parts = [state.gpu.available
    ? 'Your browser can use the GPU, so an hour-long episode takes minutes.'
    : 'No GPU access in this browser, so transcription runs on the CPU and can take about as long as the episode.'];
  if (IS_MOBILE && mb > 300) parts.push('This model may be too big for a phone, and the browser can reload the page if it runs out of memory. Pick Base or Tiny if that happens.');
  else if (!state.gpu.available && key === 'turbo') parts.push('Large v3 Turbo is very slow on a CPU.');
  els.deviceHint.textContent = parts.join(' ');
}

async function init() {
  const savedLang = store.get('lang', null);
  if (savedLang) {
    const radio = document.querySelector(`input[name=lang][value="${savedLang}"]`);
    if (radio) radio.checked = true;
  }
  els.proxy.value = store.get('proxy', '');

  document.querySelectorAll('input[name=lang]').forEach((r) => r.addEventListener('change', () => store.set('lang', language())));
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
    run(async () => ({ kind: 'audio', title: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }));
    els.file.value = '';
  });

  els.cancel.addEventListener('click', cancel);
  els.filter.addEventListener('input', renderEpisodes);
  els.copy.addEventListener('click', copyTranscript);
  els.download.addEventListener('click', downloadTranscript);
  els.timestamps.addEventListener('change', () => els.transcript.classList.toggle('show-ts', els.timestamps.checked));
  $('#episodes-close').addEventListener('click', () => els.episodesCard.classList.add('hidden'));

  await detectGpu();
  fillModels();

  const shared = new URLSearchParams(location.search).get('url');
  if (shared) els.url.value = shared;
}

init();

// For tests.
export { indexMp3, decodePieces, decodeMono16k };
