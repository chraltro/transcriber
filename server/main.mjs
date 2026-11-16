// transcriber.demant.app: serves the app and the transcripts of followed shows (DATA_DIR/library,
// in the shape of the app's own library entries; the app lists them under Shows).
// The transcribing itself runs on GitHub's runners (server/ci.mjs, .github/workflows/shows.yml),
// which upload here with GitHub's OIDC token (server/oidc.mjs): this server is small and shared.
// TRANSCRIBE=1 makes it do the work itself (its own feed checks and queue); that needs ffmpeg and
// `npm install` in server/, which the Docker image leaves out, and a far bigger machine.
import http from 'node:http';
import os from 'node:os';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWriteStream } from 'node:fs';
import { pipeline as pipe } from 'node:stream/promises';
import { findFeed, readFeed } from './feeds.mjs';
import { transcribeEpisode } from './transcribe.mjs';
import { MODELS, dtypeFor } from '../lib/models.js';
import { promisify } from 'node:util';
import { lookup as dnsLookup } from 'node:dns/promises';
import zlib from 'node:zlib';
import { SHOWS, idOf, metaOf, markdownOf, adsOf } from './shows.mjs';
import { verifyGithubToken } from './oidc.mjs';
import { createEnhance } from './enhance.mjs';
import { createPod } from './pod.mjs';
import { pruneLibrary } from './prune.mjs';
import { createSearch } from './search.mjs';
import { ADS_VERSION } from '../lib/breaks.js';
import { QUIET_VERSION } from '../lib/quiet.js';
import { fileShape, makeShapes, shapeName } from './shapes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || '/data';
const LIB = path.join(DATA, 'library');
const PORT = Number(process.env.PORT || 3000);
// The server is small and shared (2 CPUs, 4 GB, other apps): Small (English) fits in about a
// gigabyte and keeps up with the shows; Large v3 Turbo took the whole machine down.
const MODEL_KEY = process.env.MODEL || 'small';
const POLL_MIN = Number(process.env.POLL_MINUTES || 30);
const BACKFILL = Number(process.env.BACKFILL ?? 1); // episodes per show already out at first start
const THREADS = Number(process.env.THREADS || 2);
const AUDIO_DAYS = Number(process.env.AUDIO_DAYS || 60); // the server's copy of each episode, for playback in sync


const log = (...a) => console.log(new Date().toISOString(), ...a);

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}
let writes = 0;
async function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.${++writes}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
}

// The library index is read, changed and written by several things (uploads, the ad marks,
// pruning): one at a time, so none writes over another's change.
let indexTurn = Promise.resolve();
const withIndex = (fn) => {
  const run = indexTurn.then(fn, fn);
  indexTurn = run.catch(() => {});
  return run;
};

/* ---------- state ---------- */

const STATE_FILE = path.join(DATA, 'state.json');
// seen: guid -> 'done' | 'skipped' | 'failed:<n>'; queue: episodes waiting.
let state = { feeds: {}, seen: {}, queue: [] };
let current = null; // { id, title, show, position, total, elapsed }
const saveState = () => writeJson(STATE_FILE, state);

async function readIndex() {
  const index = await readJson(path.join(LIB, 'index.json'), { entries: [] });
  return index;
}

// Where a transcript's audio goes quiet is filed beside it (<id>.quiet.json: { v, quiet }), for
// the player to shorten pauses with; the index says which transcripts have it.
const quietFile = (id) => path.join(LIB, `${id}.quiet.json`);
const quietVersion = async (id) => Number((await readJson(quietFile(id), null))?.v) || undefined;
const validQuiet = (value) => Number.isInteger(value?.v) && Array.isArray(value.quiet) && value.quiet.length <= 50000
  && value.quiet.every((r) => Array.isArray(r) && r.length === 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[0] >= 0 && r[1] > r[0]);

// Its shape (server/shapes.mjs: loudness and who speaks when, for the player to draw) is filed
// beside it the same way, and on the same terms: while the audio it was made from is kept.
const shapeVersion = async (id) => Number((await readJson(path.join(LIB, shapeName(id)), null))?.v) || undefined;

function addToIndex(entry) {
  // Where the ads are goes into the index, so the player can skip them without the transcript.
  const meta = metaOf({ ...entry, ads: adsOf(entry), adsV: ADS_VERSION });
  return withIndex(async () => {
    meta.quiet = entry.audio ? await quietVersion(entry.id) : undefined;
    meta.shape = entry.audio ? await shapeVersion(entry.id) : undefined;
    const index = await readIndex();
    index.entries = [meta, ...index.entries.filter((e) => e.id !== entry.id)].sort((a, b) => b.createdAt - a.createdAt);
    await writeJson(path.join(LIB, 'index.json'), index);
  });
}

async function writeStatus() {
  await writeJson(path.join(LIB, 'status.json'), {
    updatedAt: Date.now(),
    model: MODEL_KEY,
    shows: SHOWS.map((s) => s.name),
    current,
    queue: state.queue.map(({ id, title, show, published }) => ({ id, title, show, published })),
  }).catch(() => {});
}

/* ---------- feeds ---------- */

async function poll() {
  for (const show of SHOWS) {
    try {
      const feedUrl = state.feeds[show.name]?.url || await findFeed(show);
      const feed = await readFeed(feedUrl);
      const first = !state.feeds[show.name];
      state.feeds[show.name] = { url: feedUrl, title: feed.show, checkedAt: Date.now() };
      let added = 0;
      feed.episodes.forEach((ep, i) => {
        if (state.seen[ep.guid] || state.queue.some((q) => q.guid === ep.guid)) return;
        // At first start, only the newest BACKFILL episodes; the back catalogue stays out.
        if (first && i >= BACKFILL) { state.seen[ep.guid] = 'skipped'; return; }
        state.queue.push({ ...ep, id: idOf(ep.guid), show: feed.show || show.name });
        added++;
      });
      if (added || first) log(`${show.name}: ${feed.episodes.length} episodes in the feed, ${added} new`);
    } catch (err) {
      log(`${show.name}: feed check failed: ${err.message}`);
    }
  }
  // Oldest first, so episodes come out in the order they were released.
  state.queue.sort((a, b) => a.published - b.published);
  await saveState();
  await writeStatus();
}

/* ---------- models ---------- */

let models = null;
async function loadModels() {
  if (models) return models;
  const tf = await import('@huggingface/transformers');
  tf.env.cacheDir = path.join(DATA, 'models');
  const m = MODELS[MODEL_KEY] || MODELS.small;
  const id = m.en || m.id;
  const opts = { device: 'cpu', session_options: { intraOpNumThreads: THREADS, interOpNumThreads: 1 } };
  log(`loading ${id} (${os.cpus().length} CPUs, ${Math.round(os.totalmem() / 2 ** 30)} GB memory)`);
  const asr = await tf.pipeline('automatic-speech-recognition', id, { ...opts, dtype: dtypeFor(id, 'wasm') });
  const { createDiarizer } = await import('../lib/diarize.js');
  const diarizer = await createDiarizer(tf).catch((err) => { log(`speaker models failed: ${err.message}`); return null; });
  // Turbo is multilingual: it can write another language's windows in that language itself.
  const checker = m.en ? null : await tf.pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny', { device: 'cpu', dtype: 'q8' }).catch(() => null);
  models = { tf, asr, diarizer, checker, modelKey: MODEL_KEY };
  return models;
}

/* ---------- the queue ---------- */

let working = false;
async function work() {
  if (working) return;
  working = true;
  try {
    while (state.queue.length) {
      const ep = state.queue[0];
      current = { id: ep.id, title: ep.title, show: ep.show, step: 'downloading', position: 0, total: ep.duration || 0, elapsed: 0, startedAt: Date.now() };
      await writeStatus();
      log(`transcribing ${ep.show}: ${ep.title}`);
      try {
        const m = await loadModels();
        let lastWrite = 0;
        let lastLog = Date.now();
        const entry = await transcribeEpisode(ep, m, {
          tmpFile: path.join(DATA, 'episode.audio'),
          onProgress: ({ position, elapsed }) => {
            Object.assign(current, { step: 'transcribing', position, elapsed });
            if (Date.now() - lastWrite > 15000) { lastWrite = Date.now(); writeStatus(); }
            if (Date.now() - lastLog > 300000) {
              lastLog = Date.now();
              log(`  at ${Math.round(position / 60)} of ${Math.round((ep.duration || 0) / 60)} min, ${(position / Math.max(1, elapsed)).toFixed(2)}x realtime, ${Math.round(process.memoryUsage().rss / 2 ** 20)} MB`);
            }
          },
        });
        // The copy that was transcribed plays back in sync (a fresh download can carry other ads).
        const audioFile = `${entry.id}.${entry.audioExt}`;
        await rename(path.join(DATA, 'episode.audio'), path.join(LIB, audioFile));
        entry.audio = `library/${audioFile}`;
        delete entry.audioExt;
        await writeJson(quietFile(entry.id), { v: QUIET_VERSION, quiet: entry.quiet || [] });
        delete entry.quiet;
        await writeJson(path.join(LIB, `${entry.id}.json`), entry);
        await fileShape({ lib: LIB, entry, writeJson }).catch((err) => log(`shape: ${err.message}`));
        await writeFile(path.join(LIB, `${entry.id}.md`), markdownOf(entry));
        await addToIndex(entry);
        await search.put(entry).catch(() => {});
        state.seen[ep.guid] = 'done';
        log(`done: ${entry.words} words, ${Math.round(entry.total / 60)} min of audio in ${Math.round(entry.took / 60)} min (${(entry.total / entry.took).toFixed(2)}x realtime)`);
      } catch (err) {
        const tries = Number(String(state.seen[ep.guid] || '').split(':')[1] || 0) + 1;
        state.seen[ep.guid] = `failed:${tries}`;
        log(`failed (${tries}): ${err.stack || err.message}`);
        // Tried again at the back of the queue, up to three times.
        if (tries < 3) state.queue.push(ep);
      }
      state.queue = state.queue.filter((q, i) => i > 0 || q.guid !== ep.guid);
      current = null;
      await saveState();
      await writeStatus();
      await pruneAudio();
    }
  } finally {
    working = false;
  }
}

// Audio older than AUDIO_DAYS goes (the transcript stays; the app then plays the original link),
// and so do uploads whose transcript never came (server/prune.mjs has the rules). It runs in
// every mode, from a timer, and one pass at a time; the whole pass holds the index, so an upload
// that comes in meanwhile waits a moment instead of being written over.
let pruning = null;
function pruneAudio() {
  pruning ??= withIndex(() => pruneLibrary({ lib: LIB, doc: pod.doc, days: AUDIO_DAYS, readJson, writeJson }))
    .then(({ copies, leftovers, bytes }) => {
      if (copies || leftovers) log(`audio: freed ${Math.round(bytes / 2 ** 20)} MB (${copies} cop${copies === 1 ? 'y' : 'ies'} older than ${AUDIO_DAYS} days, ${leftovers} leftover${leftovers === 1 ? '' : 's'})`);
    })
    .catch((err) => log(`audio: pruning failed: ${err.message}`))
    .finally(() => { pruning = null; });
  return pruning;
}


// Transcripts filed before the index held their ads (or under an older way of finding them)
// get them now, one at a time.
async function markAds() {
  const index = await readIndex();
  let changed = 0;
  for (const meta of index.entries) {
    if (meta.adsV === ADS_VERSION) continue;
    const entry = await readJson(path.join(LIB, `${meta.id}.json`), null);
    if (!entry?.segments) continue;
    meta.ads = adsOf(entry);
    meta.adsV = ADS_VERSION;
    changed++;
  }
  if (!changed) return;
  // Uploads may have come in meanwhile: only the ads are carried over.
  await withIndex(async () => {
    const fresh = await readIndex();
    const mine = new Map(index.entries.map((m) => [m.id, m]));
    for (const meta of fresh.entries) if (meta.adsV !== ADS_VERSION && mine.get(meta.id)?.adsV === ADS_VERSION) Object.assign(meta, { ads: mine.get(meta.id).ads, adsV: ADS_VERSION });
    await writeJson(path.join(LIB, 'index.json'), fresh);
  });
  log(`ads: marked in ${changed} transcript${changed === 1 ? '' : 's'}`);
}

/* ---------- web ---------- */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
};
const PUBLIC = /^\/(index\.html|app\.js|worker\.js|enhance-worker\.js|coi-sw\.js|style\.css|(lib|ui|fonts)\/[\w./-]+|[\w-]+\.(png|svg|ico|webmanifest|txt))$/;

// Text is sent compressed (the app's own files are compressed once and kept; transcripts as
// they go out).
const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);
const TEXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.md', '.svg', '.webmanifest', '.txt']);
const packed = new Map(); // file -> { tag, br, gzip }
async function compressed(file, tag, enc, keep) {
  let hit = packed.get(file);
  if (!hit || hit.tag !== tag) hit = { tag };
  if (!hit[enc]) {
    const raw = await readFile(file);
    hit[enc] = enc === 'br' ? await brotli(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }) : await gzip(raw, { level: 6 });
  }
  if (keep) packed.set(file, hit);
  return hit[enc];
}

// With byte ranges: the audio element seeks with them.
async function serveFile(req, res, file, { cache = 'no-cache' } = {}) {
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    const ext = path.extname(file);
    const type = TYPES[ext] || 'application/octet-stream';
    // Which copy of the file this is: for the compressed copies kept below, and as an ETag, so a
    // browser that has the file asks "has it changed?" and an unchanged one costs a few bytes.
    // (The service worker asks for the file itself and lets the browser's cache underneath it
    // ask that, so it always gets the whole file to keep: coi-sw.js.)
    const tag = `${s.size.toString(36)}-${Math.round(s.mtimeMs).toString(36)}`;
    const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, s.size - Number(range[2]));
      let end = range[1] && range[2] ? Math.min(Number(range[2]), s.size - 1) : s.size - 1;
      if (start > end || start >= s.size) {
        res.writeHead(416, { 'content-range': `bytes */${s.size}` });
        res.end();
        return;
      }
      res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${s.size}`, 'accept-ranges': 'bytes', 'cache-control': cache });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    const accepts = req.headers['accept-encoding'] || '';
    const packable = TEXT.has(ext) && s.size > 1024 && s.size < 8e6;
    const enc = packable ? (/\bbr\b/.test(accepts) ? 'br' : /\bgzip\b/.test(accepts) ? 'gzip' : '') : '';
    // Each packing of the file is a copy of its own with a tag of its own, so a cache holding one
    // is never told that another is the same; and an answer that depends on Accept-Encoding says so.
    const etag = `"${tag}${enc ? `-${enc}` : ''}"`;
    const shared = { etag, 'cache-control': cache, ...(packable ? { vary: 'accept-encoding' } : {}) };
    const asked = req.headers['if-none-match'];
    if (asked && asked.split(',').some((t) => { t = t.trim().replace(/^W\//, ''); return t === '*' || t === etag; })) {
      res.writeHead(304, shared);
      res.end();
      return;
    }
    if (enc) {
      const body = await compressed(file, tag, enc, file.startsWith(ROOT + path.sep));
      res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'content-encoding': enc, ...shared });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    res.writeHead(200, { 'content-type': type, 'content-length': s.size, 'accept-ranges': 'bytes', ...shared });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}

// Regeneration jobs (server/enhance.mjs). The workflow polls for them every few minutes; with a
// GitHub token in GH_DISPATCH_TOKEN (actions: write on this repository) a new job starts it at once.
const SITE_URL = (process.env.PUBLIC_URL || 'https://transcriber.demant.app').replace(/\/$/, '');
const dispatch = process.env.GH_DISPATCH_TOKEN ? async () => {
  const repo = ENHANCE_WORKFLOW.split('/.github/')[0];
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/enhance.yml/dispatches`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.GH_DISPATCH_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'main' }),
  });
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
} : null;
const enhance = createEnhance({ dataDir: DATA, authorized: (req) => authorized(req, ENHANCE_WORKFLOW), log, site: SITE_URL, dispatch, key: process.env.ENHANCE_KEY || '' });
// The podcast side: followed shows, positions and queue in step across devices, feeds read here
// (server/pod.mjs). SYNC_KEY fixes the library's key; without it the first device to ask sets it.
// (POD_SEED=0: the built-in shows are not followed from the start, for tests.)
// Search across the transcripts (server/search.mjs): their text is filed compactly in DATA/search,
// and the newest SEARCH_MEMORY_MB of it (16 by default, some 200 hours) is kept in memory: the
// server has 256 MB for everything.
const search = createSearch({ dir: LIB, cacheDir: path.join(DATA, 'search'), entries: async () => (await readIndex()).entries, log, budget: Number(process.env.SEARCH_MEMORY_MB || 16) * 1e6 });
const pod = createPod({ dataDir: DATA, log, findFeed, seeds: process.env.POD_SEED === '0' ? [] : SHOWS, key: process.env.SYNC_KEY || '', pollMinutes: POLL_MIN, allowPrivate: process.env.POD_ALLOW_PRIVATE === '1', freshSeconds: Number(process.env.POD_FRESH_SECONDS ?? 120),
  transcribed: async () => new Set((await readIndex()).entries.map((e) => e.id)),
  workflow: async (req) => (req.headers.authorization ? authorized(req, WORKFLOW) : false),
  search: (q) => search.query(q),
  lookup: async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address),
  // (Push services want to know who sends: the site, unless PUSH_SUBJECT names a mailto: address.)
  pushSubject: process.env.PUSH_SUBJECT || SITE_URL });

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    // Never let one odd request take the server down.
    log(`request failed: ${req.method} ${String(req.url).slice(0, 200)}: ${err.message}`);
    if (!res.headersSent) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('Bad request'); } else res.destroy();
  }
});

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); res.end('Bad request'); return; }
  if (p === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  if (p.startsWith('/api/enhance') && await enhance.handle(req, res, p)) return;
  if (p.startsWith('/api/pod/') && await pod.handle(req, res, p, url)) return;
  if (/^\/enhance\/[0-9a-f]{16}\.mp3$/.test(p)) {
    await serveFile(req, res, path.join(enhance.dir, path.basename(p)), { cache: 'max-age=31536000, immutable' });
    return;
  }
  if (p.startsWith('/api/library/')) { await upload(req, res, p.slice('/api/library/'.length)); return; }
  if (p.startsWith('/library/')) {
    const name = p.slice('/library/'.length);
    if (!/^[\w-]+\.(json|md|mp3|m4a)$|^[0-9a-f]{16}\.(quiet|shape)\.json$/.test(name)) { res.writeHead(404); res.end(); return; }
    if (name === 'index.json' && !(await stat(path.join(LIB, name)).catch(() => null))) {
      res.writeHead(200, { 'content-type': TYPES['.json'] });
      res.end('{"entries":[]}');
      return;
    }
    await serveFile(req, res, path.join(LIB, name), { cache: /\.(mp3|m4a)$/.test(name) ? 'max-age=31536000, immutable' : 'no-cache' });
    return;
  }
  if (p === '/' || PUBLIC.test(p)) {
    await serveFile(req, res, path.join(ROOT, p === '/' ? 'index.html' : p));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
}

/* ---------- uploads from the GitHub workflow ---------- */

// Only this repository's shows workflow, running on main (server/oidc.mjs).
const AUDIENCE = process.env.UPLOAD_AUDIENCE || 'transcriber.demant.app';
const WORKFLOW = process.env.UPLOAD_WORKFLOW || 'chraltro/transcriber/.github/workflows/shows.yml';
const ENHANCE_WORKFLOW = process.env.ENHANCE_WORKFLOW || 'chraltro/transcriber/.github/workflows/enhance.yml';
async function authorized(req, workflow = WORKFLOW) {
  // Local testing of the regeneration round trip only; never set on the real server.
  if (process.env.ENHANCE_TEST_NO_AUTH === '1' && workflow === ENHANCE_WORKFLOW) return true;
  try {
    await verifyGithubToken(req.headers.authorization?.replace(/^Bearer\s+/i, ''), { audience: AUDIENCE, workflow });
    return true;
  } catch (err) {
    log(`upload refused: ${err.message}`);
    return false;
  }
}

// PUT /api/library/<id>.mp3|m4a|md|quiet.json, then <id>.json (which lists it), or status.json.
// (<id>.quiet.json may also come later, for a transcript that is already listed.)
async function upload(req, res, name) {
  const done = (code, text) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(text); };
  if (req.method !== 'PUT') return done(405, 'PUT only');
  if (!(await authorized(req))) return done(401, 'Unauthorized');
  if (!/^[0-9a-f]{16}\.(quiet\.json|json|md|mp3|m4a)$|^status\.json$/.test(name)) return done(400, 'Bad name');
  const file = path.join(LIB, name);
  const tmp = `${file}.part`;
  try {
    await pipe(req, createWriteStream(tmp));
    if (name.endsWith('.json')) {
      const value = JSON.parse(await readFile(tmp, 'utf8'));
      if (name.endsWith('.quiet.json')) {
        if (!validQuiet(value)) throw new Error('Not a list of quiet stretches');
        await rename(tmp, file);
        const id = name.slice(0, 16);
        await withIndex(async () => {
          const index = await readIndex();
          const meta = index.entries.find((e) => e.id === id);
          if (!meta?.audio || meta.quiet === value.v) return;
          meta.quiet = value.v;
          await writeJson(path.join(LIB, 'index.json'), index);
        });
        return done(200, 'ok');
      }
      if (name !== 'status.json') {
        if (!Array.isArray(value.segments) || value.id !== name.slice(0, 16)) throw new Error('Not a transcript');
        await rename(tmp, file);
        await fileShape({ lib: LIB, entry: value, writeJson }).catch((err) => log(`shape: ${err.message}`));
        await addToIndex(value);
        await search.put(value).catch((err) => log(`search: ${err.message}`));
        log(`received ${value.show}: ${value.title} (${value.words} words)`);
        return done(200, 'ok');
      }
    }
    await rename(tmp, file);
    done(200, 'ok');
  } catch (err) {
    await rm(tmp, { force: true });
    done(400, err.message);
  }
}

/* ---------- start ---------- */

await mkdir(LIB, { recursive: true });
await enhance.init();
await pod.init();
if (process.env.POD_FEEDS !== '0') pod.start();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => pod.flush().catch(() => {}).finally(() => process.exit(0)));
state = { ...state, ...(await readJson(STATE_FILE, {})) };
current = null;
server.listen(PORT, () => log(`serving on :${PORT}; data in ${DATA}; model ${MODEL_KEY}; checking feeds every ${POLL_MIN} min`));
// (One after the other: each reads the transcripts one at a time, and the server has 256 MB.)
markAds().catch((err) => log(`ads: ${err.message}`))
  .then(() => makeShapes({ lib: LIB, readJson, writeJson, withIndex, log }))
  .then((n) => { if (n) log(`shapes: made for ${n} transcript${n === 1 ? '' : 's'}`); })
  .catch((err) => log(`shapes: ${err.message}`));
// A minute after start (out of the way of the start itself), then twice a day.
setTimeout(pruneAudio, 60000).unref();
setInterval(pruneAudio, 12 * 3600000).unref();
if (process.env.TRANSCRIBE === '1') {
  const tick = async () => {
    await poll();
    work();
  };
  tick();
  setInterval(tick, POLL_MIN * 60000);
} else log('transcripts come from the GitHub workflow (TRANSCRIBE=1 to transcribe here)');
