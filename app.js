const $ = (sel) => document.querySelector(sel);

const MODELS = {
  base: { id: 'onnx-community/whisper-base', label: 'Fast: Whisper Base (small download, rougher for Norwegian/Danish)' },
  small: { id: 'onnx-community/whisper-small', label: 'Balanced: Whisper Small' },
  turbo: { id: 'onnx-community/whisper-large-v3-turbo', label: 'Best: Whisper Large v3 Turbo (large download, needs WebGPU)', webgpuOnly: true },
};

const PUBLIC_PROXIES = [
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
];

const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|mp4|m4b|webm)$/i;
const AUDIO_URL_IN_TEXT = /https?:\\?\/\\?\/[^"'\s<>()]+?\.(?:mp3|m4a|aac|ogg|opus|wav|m4b)(?:\?[^"'\s<>()]*)?(?=["'\s<>()]|$)/gi;

const els = {
  form: $('#url-form'), url: $('#url'), go: $('#go'), model: $('#model'), file: $('#file'), proxy: $('#proxy'),
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

function proxyChain() {
  const custom = els.proxy.value.trim();
  const chain = [(u) => u];
  if (custom) {
    chain.push((u) => custom.includes('{url}') ? custom.replace('{url}', encodeURIComponent(u)) : custom + encodeURIComponent(u));
  }
  return chain.concat(PUBLIC_PROXIES);
}

// Try the URL directly first, then through CORS proxies.
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
    `Couldn't download ${url}\n(${firstErr?.message || 'network error'}).\n\n` +
    `The server may block browser access. Try a different link for the same episode, ` +
    `set up your own proxy under "More options", or download the file and pick it there.`
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

async function downloadAudio(url) {
  progress('Downloading episode', null, 'Connecting');
  const res = await smartFetch(url);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    progress('Downloading episode', total ? got / total : null, total ? `${fmtBytes(got)} of ${fmtBytes(total)}` : fmtBytes(got));
  }
  const bytes = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.length; }
  return bytes;
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

  const matches = html.match(AUDIO_URL_IN_TEXT);
  if (matches?.length) {
    const url = matches[0].replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
    return { kind: 'audio', url, title };
  }

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

async function resolveApple(u) {
  const showId = u.pathname.match(/id(\d+)/)?.[1];
  const episodeId = u.searchParams.get('i');
  if (!showId) throw new UserError("Couldn't find the podcast ID in that Apple Podcasts link.");

  let lookup = null;
  try {
    lookup = await jsonp(`https://itunes.apple.com/lookup?id=${showId}&entity=podcastEpisode&limit=200`);
  } catch {}
  const results = lookup?.results || [];
  const show = results.find((r) => r.kind === 'podcast' || r.wrapperType === 'track');
  const eps = results.filter((r) => r.wrapperType === 'podcastEpisode' && r.episodeUrl);

  if (episodeId) {
    const ep = eps.find((e) => String(e.trackId) === episodeId);
    if (ep) return { kind: 'audio', url: ep.episodeUrl, title: ep.trackName };
    // Older episode than the lookup API returns: read the Apple page itself.
    try {
      const { text } = await fetchText(u.href);
      const found = findAudioInHtml(text, u.href);
      if (found?.kind === 'audio') return found;
      if (show?.feedUrl && found?.title) return await resolveFeed(show.feedUrl, found.title.replace(/\s*[-|].*Apple Podcasts.*$/i, ''));
    } catch (err) {
      if (err.name === 'AbortError') throw err;
    }
  }

  if (show?.feedUrl) {
    try { return await resolveFeed(show.feedUrl); } catch (err) { if (err.name === 'AbortError') throw err; }
  }
  if (eps.length) {
    return {
      kind: 'list',
      title: show?.collectionName || 'Episodes',
      episodes: eps.map((e) => ({
        title: e.trackName, url: e.episodeUrl, date: e.releaseDate,
        duration: e.trackTimeMillis ? fmtTime(e.trackTimeMillis / 1000) : '',
      })),
    };
  }
  throw new UserError("Couldn't load that podcast from Apple. Try the podcast's RSS feed or website instead.");
}

async function itunesSearch(term, entity) {
  for (const country of ['us', 'no', 'dk', 'se', 'gb']) {
    try {
      const data = await jsonp(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=${entity}&limit=25&country=${country}`);
      if (data?.results?.length) return data.results;
    } catch {}
  }
  return [];
}

// Find a show's episode through Apple's public directory and the show's RSS feed.
async function findElsewhere(showName, episodeTitle) {
  if (showName) {
    const shows = await itunesSearch(showName, 'podcast');
    const show = shows.find((s) => normTitle(s.collectionName) === normTitle(showName)) || shows[0];
    if (show?.feedUrl) {
      try {
        const res = await resolveFeed(show.feedUrl, episodeTitle);
        if (!episodeTitle || res.kind === 'audio') return res;
      } catch (err) {
        if (err.name === 'AbortError') throw err;
      }
    }
  }
  if (episodeTitle) {
    const eps = (await itunesSearch(`${showName || ''} ${episodeTitle}`.trim(), 'podcastEpisode')).filter((e) => e.episodeUrl);
    const hit = bestTitleMatch(eps.map((e) => ({ title: e.trackName, url: e.episodeUrl })), episodeTitle);
    if (hit) return { kind: 'audio', ...hit };
  }
  return null;
}

async function resolveSpotify(u) {
  const isEpisode = u.pathname.includes('/episode/');
  if (!isEpisode && !u.pathname.includes('/show/')) throw new UserError('That Spotify link is not a podcast show or episode.');

  progress('Looking up the episode', null, 'Spotify audio is locked down, so finding the same episode elsewhere');
  const { text } = await fetchText(u.href);
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const ogTitle = doc.querySelector('meta[property="og:title"]')?.content || '';
  const ogDesc = doc.querySelector('meta[property="og:description"]')?.content || '';
  const showName = isEpisode
    ? (ogDesc.match(/episode from (.+?) on Spotify/i)?.[1] || doc.querySelector('meta[name="music:album"]')?.content || '')
    : ogTitle;

  if (!ogTitle) throw new UserError("Couldn't read that Spotify page. Try the Apple Podcasts or RSS link for the same podcast.");

  const found = await findElsewhere(showName, isEpisode ? ogTitle : null);
  if (found) return found;
  throw new UserError(
    `Couldn't find "${ogTitle}" outside Spotify. It may be a Spotify exclusive, which can't be transcribed. ` +
    `If it's also on Apple Podcasts or has an RSS feed, paste that link instead.`
  );
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

async function pocketCastsPodcast(podcastId) {
  for (const base of ['https://podcast-api.pocketcasts.com/podcast/full/', 'https://cache.pocketcasts.com/mobile/podcast/full/']) {
    try {
      const data = await (await smartFetch(base + podcastId)).json();
      const podcast = data?.podcast || data;
      if (podcast?.episodes?.length) return podcast;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
    }
  }
  return null;
}

// Handles pca.st/episode/<id>, pca.st/podcast/<id>, pca.st/<short>, pocketcasts.com and play.pocketcasts.com links.
async function resolvePocketCasts(u) {
  const ids = (u.pathname.match(UUID_RE) || []).map((id) => id.toLowerCase());
  let podcastId = null;
  let episodeId = null;
  if (u.pathname.includes('/episode/')) episodeId = ids.at(-1);
  else if (ids.length >= 2) [podcastId, episodeId] = [ids[0], ids.at(-1)];
  else if (ids.length === 1) podcastId = ids[0];

  progress('Looking up the episode', null, 'Pocket Casts');
  let html = '';
  try {
    html = (await fetchText(u.href)).text;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
  }

  // 1. The share page often embeds the audio URL directly.
  const found = html ? findAudioInHtml(html, u.href) : null;
  if (found?.kind === 'audio') return { ...found, title: cleanPocketCastsTitle(found.title) };

  // 2. Pocket Casts' public podcast API lists every episode with its audio URL.
  const candidates = podcastId
    ? [podcastId]
    : [...new Set((html.match(UUID_RE) || []).map((id) => id.toLowerCase()))].filter((id) => id !== episodeId).slice(0, 4);
  for (const id of candidates) {
    const podcast = await pocketCastsPodcast(id);
    if (!podcast) continue;
    const eps = podcast.episodes.filter((e) => e.url);
    if (episodeId) {
      const ep = eps.find((e) => e.uuid?.toLowerCase() === episodeId);
      if (ep) return { kind: 'audio', url: ep.url, title: ep.title };
      continue;
    }
    return {
      kind: 'list',
      title: podcast.title || 'Episodes',
      episodes: eps.map((e) => ({ title: e.title, url: e.url, date: e.published, duration: e.duration ? String(e.duration) : '' })),
    };
  }

  // 3. Match by title through Apple's directory and the show's RSS feed.
  if (found?.kind === 'feed') return resolveFeed(found.url, episodeId ? cleanPocketCastsTitle(found.title) : null);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = cleanPocketCastsTitle(
    doc.querySelector('meta[property="og:title"]')?.content || doc.querySelector('meta[name="twitter:title"]')?.content || doc.title || ''
  );
  if (title) {
    const parts = title.split(/\s+[-–|•]\s+/).filter(Boolean);
    const guesses = parts.length >= 2
      ? [[parts.at(-1), parts.slice(0, -1).join(' - ')], [parts[0], parts.slice(1).join(' - ')]]
      : [[episodeId ? '' : title, episodeId ? title : null]];
    for (const [show, episode] of guesses) {
      const hit = await findElsewhere(show, episodeId ? episode : null);
      if (hit) return hit;
    }
  }
  throw new UserError(
    "Couldn't get the audio for that Pocket Casts link. Try the episode's Apple Podcasts link or the podcast's RSS feed instead."
  );
}

function cleanPocketCastsTitle(t) {
  return (t || '').replace(/\s*[-–|•]\s*Pocket Casts\s*$/i, '').replace(/^Pocket Casts\s*[-–|•:]\s*/i, '').trim();
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

async function decodeAudio(bytes) {
  progress('Decoding audio', null, 'This can take a moment for long episodes');
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(1, 1, 16000);
  let buffer;
  try {
    buffer = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  } catch {
    throw new UserError("Your browser couldn't decode this audio file. Try another episode or a different browser.");
  }
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
  const out = new Float32Array(buffer.length);
  const n = buffer.numberOfChannels;
  for (let c = 0; c < n; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += data[i] / n;
  }
  return out;
}

function getWorker() {
  if (!state.worker) state.worker = new Worker(new URL('worker.js', import.meta.url), { type: 'module' });
  return state.worker;
}

function killWorker() {
  state.worker?.terminate();
  state.worker = null;
}

function transcribeAudio(audio) {
  return new Promise((resolve, reject) => {
    state.rejectRun = reject;
    const worker = getWorker();
    const files = new Map();
    const modelKey = els.model.value;
    const lang = language();

    progress('Loading speech model', null, 'First run downloads the model, then it is cached');

    worker.onmessage = ({ data: m }) => {
      switch (m.type) {
        case 'status':
          progress(m.text, null, '');
          break;
        case 'model-progress': {
          let loaded, total;
          if (m.status === 'progress_total') {
            ({ loaded, total } = m);
          } else if (m.status === 'progress' && m.file) {
            files.set(m.file, { loaded: m.loaded || 0, total: m.total || 0 });
            loaded = total = 0;
            for (const f of files.values()) { loaded += f.loaded; total += f.total; }
          } else {
            break;
          }
          progress('Downloading speech model', total ? loaded / total : null, `${fmtBytes(loaded)} of ${fmtBytes(total)} (only needed once)`);
          break;
        }
        case 'ready':
          progress('Transcribing', 0, m.device === 'webgpu' ? 'Using your GPU' : 'Using your CPU. This is slower, a GPU-capable browser like Chrome speeds it up a lot.');
          break;
        case 'segment': {
          addSegment(m);
          const rate = m.done / Math.max(m.elapsed, 0.001);
          const eta = (m.total - m.done) / rate;
          progress(
            'Transcribing',
            m.done / m.total,
            `${fmtTime(m.done)} of ${fmtTime(m.total)} · ${rate.toFixed(1)}x realtime · about ${fmtTime(eta)} left`
          );
          break;
        }
        case 'done':
          resolve();
          break;
        case 'error':
          reject(new Error(m.message));
          break;
      }
    };
    worker.onerror = (e) => reject(new Error(e.message || 'The transcription worker crashed. Try a smaller model.'));

    const model = MODELS[modelKey];
    const device = state.gpu.available ? 'webgpu' : 'wasm';
    worker.postMessage(
      { type: 'transcribe', audio, language: lang, model: model.id, device, hasF16: state.gpu.f16 },
      [audio.buffer]
    );
  });
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
    const bytes = source.bytes || await downloadAudio(source.url);
    const audio = await decodeAudio(bytes);
    if (audio.length < 16000) throw new UserError('That audio is empty or too short to transcribe.');
    await transcribeAudio(audio);
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

function fillModels() {
  els.model.replaceChildren();
  for (const [key, m] of Object.entries(MODELS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = m.label;
    if (m.webgpuOnly && !state.gpu.available) opt.disabled = true;
    els.model.append(opt);
  }
  const saved = store.get('model', null);
  const fallback = state.gpu.available ? 'turbo' : 'small';
  els.model.value = saved && !els.model.querySelector(`option[value="${saved}"]`)?.disabled ? saved : fallback;
  els.deviceHint.textContent = state.gpu.available
    ? 'GPU acceleration available. An hour-long episode usually takes a few minutes.'
    : 'No WebGPU in this browser, so transcription runs on the CPU and takes a while (often close to the episode length). Chrome or Edge on desktop is much faster.';
}

async function init() {
  const savedLang = store.get('lang', null);
  if (savedLang) {
    const radio = document.querySelector(`input[name=lang][value="${savedLang}"]`);
    if (radio) radio.checked = true;
  }
  els.proxy.value = store.get('proxy', '');

  document.querySelectorAll('input[name=lang]').forEach((r) => r.addEventListener('change', () => store.set('lang', language())));
  els.model.addEventListener('change', () => store.set('model', els.model.value));
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
