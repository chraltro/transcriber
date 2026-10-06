// transcriber.demant.app: serves the app, and transcribes every new episode of a few shows as
// it comes out, with the same code the app runs in the browser (here on the server's CPUs).
// Transcripts land in DATA_DIR/library as the app's own library entries; the app lists them.
import http from 'node:http';
import os from 'node:os';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { findFeed, readFeed } from './feeds.mjs';
import { transcribeEpisode } from './transcribe.mjs';
import { MODELS, dtypeFor } from '../lib/models.js';
import { markdown } from '../lib/paragraphs.js';
import { guessNames, hostFromShow, minorVoices, OTHER } from '../lib/speakers.js';
import { extractTerms } from '../lib/context.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || '/data';
const LIB = path.join(DATA, 'library');
const PORT = Number(process.env.PORT || 3000);
const MODEL_KEY = process.env.MODEL || 'turbo';
const POLL_MIN = Number(process.env.POLL_MINUTES || 30);
const BACKFILL = Number(process.env.BACKFILL ?? 1); // episodes per show already out at first start
const THREADS = Number(process.env.THREADS || 0) || undefined;
const AUDIO_DAYS = Number(process.env.AUDIO_DAYS || 60); // the server's copy of each episode, for playback in sync

export const SHOWS = [
  { name: 'Pod Save America', appleId: 1192761536 },
  { name: 'Pod Save the World', appleId: 1200016351 },
  { name: 'The Ezra Klein Show', appleId: 1548604447 },
  { name: 'Making Sense with Sam Harris', appleId: 733163012 },
  { name: 'Plain English with Derek Thompson', appleId: 1594471023 },
];

const log = (...a) => console.log(new Date().toISOString(), ...a);
const idOf = (guid) => createHash('sha1').update(guid).digest('hex').slice(0, 16);

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
}

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

async function addToIndex(entry) {
  const index = await readIndex();
  const meta = (({ id, title, show, art, lang, model, total, words, createdAt, transcribedAt, audio }) => ({ id, title, show, art, lang, model, total, words, createdAt, transcribedAt, audio }))(entry);
  index.entries = [meta, ...index.entries.filter((e) => e.id !== entry.id)].sort((a, b) => b.createdAt - a.createdAt);
  await writeJson(path.join(LIB, 'index.json'), index);
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
  const m = MODELS[MODEL_KEY] || MODELS.turbo;
  const id = m.en || m.id;
  const opts = { device: 'cpu', ...(THREADS ? { session_options: { intraOpNumThreads: THREADS } } : {}) };
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
      current = { id: ep.id, title: ep.title, show: ep.show, position: 0, total: ep.duration || 0, elapsed: 0, startedAt: Date.now() };
      await writeStatus();
      log(`transcribing ${ep.show}: ${ep.title}`);
      try {
        const m = await loadModels();
        let lastWrite = 0;
        const entry = await transcribeEpisode(ep, m, {
          tmpFile: path.join(DATA, 'episode.audio'),
          onProgress: ({ position, elapsed }) => {
            Object.assign(current, { position, elapsed });
            if (Date.now() - lastWrite > 15000) { lastWrite = Date.now(); writeStatus(); }
          },
        });
        // The copy that was transcribed plays back in sync (a fresh download can carry other ads).
        const audioFile = `${entry.id}.${entry.audioExt}`;
        await rename(path.join(DATA, 'episode.audio'), path.join(LIB, audioFile));
        entry.audio = `library/${audioFile}`;
        delete entry.audioExt;
        await writeJson(path.join(LIB, `${entry.id}.json`), entry);
        await writeFile(path.join(LIB, `${entry.id}.md`), markdownOf(entry));
        await addToIndex(entry);
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

// Audio older than AUDIO_DAYS goes (the transcript stays; the app then plays the original link).
async function pruneAudio() {
  const index = await readIndex();
  let changed = false;
  for (const meta of index.entries) {
    if (!meta.audio || Date.now() - (meta.transcribedAt || 0) < AUDIO_DAYS * 864e5) continue;
    await rm(path.join(LIB, path.basename(meta.audio)), { force: true });
    const file = path.join(LIB, `${meta.id}.json`);
    const entry = await readJson(file, null);
    if (entry) { delete entry.audio; await writeJson(file, entry); }
    delete meta.audio;
    changed = true;
  }
  if (changed) await writeJson(path.join(LIB, 'index.json'), index);
}

function markdownOf(entry) {
  const terms = extractTerms(entry.notes || '', entry.title || '', entry.show || '');
  const guessed = guessNames(entry.segments, terms, { host: hostFromShow(entry.show) });
  const minor = minorVoices(entry.segments, guessed);
  const names = { ...Object.fromEntries([...minor].map((k) => [k, 'Other voice'])), [OTHER]: 'Other voices', ...guessed };
  return markdown(entry.segments, { title: entry.title, show: entry.show, url: entry.source?.url, names });
}

/* ---------- web ---------- */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
};
const PUBLIC = /^\/(index\.html|app\.js|worker\.js|coi-sw\.js|style\.css|(lib|ui|fonts)\/[\w./-]+|[\w-]+\.(png|svg|ico|webmanifest|txt))$/;

// With byte ranges: the audio element seeks with them.
async function serveFile(req, res, file, { cache = 'no-cache' } = {}) {
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
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
    res.writeHead(200, { 'content-type': type, 'content-length': s.size, 'accept-ranges': 'bytes', 'cache-control': cache });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  if (p === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  if (p.startsWith('/library/')) {
    const name = p.slice('/library/'.length);
    if (!/^[\w-]+\.(json|md|mp3|m4a)$/.test(name)) { res.writeHead(404); res.end(); return; }
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
});

/* ---------- start ---------- */

await mkdir(LIB, { recursive: true });
state = { ...state, ...(await readJson(STATE_FILE, {})) };
current = null;
server.listen(PORT, () => log(`serving on :${PORT}; data in ${DATA}; model ${MODEL_KEY}; checking feeds every ${POLL_MIN} min`));
const tick = async () => {
  await poll();
  work();
};
tick();
setInterval(tick, POLL_MIN * 60000);
