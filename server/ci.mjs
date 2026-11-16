// Run by .github/workflows/shows.yml every half hour: finds episodes of the followed shows that
// transcriber.demant.app doesn't have yet, transcribes them on GitHub's runner with the app's own
// pipeline (Large v3 Turbo, speakers, language check), and uploads transcript and audio there.
// Which episodes are wanted follows from the site's own index, so nothing is kept here:
// a show with nothing yet gets its newest episode; after that, every episode since the first one
// the site has that it doesn't have yet (so one that had to wait is never passed over).
import os from 'node:os';
import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { findFeed, readFeed } from './feeds.mjs';
import { transcribeEpisode } from './transcribe.mjs';
import { SHOWS, markdownOf, notesWithHosts } from './shows.mjs';
import { planQueue } from './plan.mjs';
import { quietOfAudio } from './quiet.mjs';
import { QUIET_VERSION } from '../lib/quiet.js';
import { correctText } from '../lib/glossary.js';
import { extractTerms } from '../lib/context.js';
import { MODELS, dtypeFor } from '../lib/models.js';
import { createDiarizer } from '../lib/diarize.js';

const SITE = (process.env.SITE || 'https://transcriber.demant.app').replace(/\/$/, '');
const AUDIENCE = process.env.UPLOAD_AUDIENCE || 'transcriber.demant.app';
const MODEL_KEY = process.env.MODEL || 'turbo';
const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS || 14); // older episodes are never picked up
// The job is stopped at 350 minutes (shows.yml): an episode only starts if it can finish by then.
const LIMIT_MIN = Number(process.env.LIMIT_MINUTES || 335);
// Minutes of audio per minute of work. Large v3 Turbo on GitHub's 4-CPU runners managed 0.58x
// to 0.80x; this starts on the safe side and follows what each finished episode measured.
let speed = 0.55;
const DRY = process.env.DRY_RUN === '1';
const t0 = Date.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL && !DRY) throw new Error('No GitHub OIDC token: the workflow needs permissions id-token: write');

// GitHub's signed proof that this upload comes from this workflow; fresh for each upload (they
// last minutes).
async function oidcToken() {
  const res = await fetch(`${process.env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(AUDIENCE)}`, {
    headers: { authorization: `bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  });
  if (!res.ok) throw new Error(`OIDC token: HTTP ${res.status}`);
  return (await res.json()).value;
}

async function put(name, body, type) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(`${SITE}/api/library/${name}`, { method: 'PUT', headers: { authorization: `Bearer ${await oidcToken()}`, 'content-type': type }, body });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return;
    } catch (err) {
      if (i >= 4) throw new Error(`Upload of ${name} failed: ${err.message}`);
      log(`  upload of ${name} failed (${err.message}); trying again`);
      await new Promise((r) => setTimeout(r, 5000 * i));
    }
  }
}
const status = (value) => (DRY ? null : put('status.json', JSON.stringify({ updatedAt: Date.now(), model: MODEL_KEY, ...value }), 'application/json').catch((e) => log(e.message)));

/* ---------- what's new ---------- */

const indexRes = await fetch(`${SITE}/library/index.json`, { cache: 'no-store' });
if (!indexRes.ok || !/json/.test(indexRes.headers.get('content-type') || '')) {
  log(`${SITE} is not answering (HTTP ${indexRes.status}); trying again next run`);
  process.exit(1);
}
const index = await indexRes.json();

// What to do comes from the app (a show's page: Transcribe new episodes, and how far back to go;
// an episode: Transcribe on the server), which the site lists once it has the built-in shows in
// its library. Until then, the built-in shows' new episodes.
let shows = SHOWS.map((s) => ({ ...s, fresh: true, backfill: 0 }));
let asked = [];
try {
  const proof = process.env.ACTIONS_ID_TOKEN_REQUEST_URL ? { authorization: `Bearer ${await oidcToken()}` } : {};
  const listed = await (await fetch(`${SITE}/api/pod/transcribe`, { cache: 'no-store', headers: proof })).json();
  if (listed.ready && Array.isArray(listed.shows)) {
    shows = listed.shows.slice(0, 20).map((s) => ({ name: s.name, feedUrl: s.feedUrl, lang: s.lang, fresh: s.fresh !== false, backfill: Number(s.backfill) || 0 }));
    asked = Array.isArray(listed.episodes) ? listed.episodes : [];
    log(`from the app: ${shows.map((s) => `${s.name}${s.backfill ? ` (and the last ${s.backfill})` : ''}`).join(', ') || 'no shows'}${asked.length ? `; ${asked.length} episode${asked.length === 1 ? '' : 's'} asked for` : ''}`);
  }
} catch (err) {
  log(`the site lists nothing to do (${err.message}); using the built-in shows`);
}

const feeds = new Map();
const queue = await planQueue({
  shows, asked, index, log, maxAgeDays: MAX_AGE_DAYS,
  feedOf: async (show) => {
    const url = show.feedUrl || await findFeed(show);
    if (!feeds.has(url)) feeds.set(url, await readFeed(url));
    return feeds.get(url);
  },
});

// Transcripts made before a fix to names (FIXES) get it without being transcribed again: the
// hosts in their notes, and known names' spelling corrected in their text.
const FIXES = 1;
for (const meta of index.entries) {
  if (DRY || (meta.fixes || 0) >= FIXES) continue;
  try {
    const entry = await (await fetch(`${SITE}/library/${meta.id}.json`, { cache: 'no-store' })).json();
    if ((entry.fixes || 0) >= FIXES) continue;
    entry.notes = notesWithHosts(entry.notes, entry.show);
    const terms = extractTerms(entry.notes, entry.title || '', entry.show || '');
    entry.segments = entry.segments.map((x) => ({ ...x, text: correctText(x.text, { terms, replace: [] }) }));
    entry.fixes = FIXES;
    await put(`${entry.id}.md`, markdownOf(entry), 'text/markdown');
    await put(`${entry.id}.json`, JSON.stringify(entry), 'application/json');
    log(`updated names in ${entry.show}: ${entry.title}`);
  } catch (err) {
    log(`couldn't update ${meta.id}: ${err.message}`);
  }
}

// Transcripts made before the player could shorten pauses get the list of where their audio
// goes quiet, from the copy of the audio the site keeps: a few minutes' worth each run.
const QUIET_MIN = Number(process.env.QUIET_MINUTES || 6);
const quietStart = Date.now();
let listened = 0;
for (const meta of index.entries) {
  if (DRY || !meta.audio || (meta.quiet || 0) >= QUIET_VERSION) continue;
  if (Date.now() - quietStart > QUIET_MIN * 60000) break;
  try {
    const quiet = await quietOfAudio(`${SITE}/${meta.audio}`);
    await put(`${meta.id}.quiet.json`, JSON.stringify({ v: QUIET_VERSION, quiet }), 'application/json');
    listened++;
  } catch (err) {
    log(`couldn't find the pauses in ${meta.id}: ${err.message}`);
  }
}
if (listened) log(`found the pauses in ${listened} earlier episode${listened === 1 ? '' : 's'}`);

if (!queue.length || DRY) {
  log(DRY ? `dry run: ${queue.map((q) => `${q.show}: ${q.title}`).join(' | ') || 'nothing'}` : 'nothing new');
  process.exit(0);
}

/* ---------- models ---------- */

const tf = await import('@huggingface/transformers');
if (process.env.MODEL_CACHE) tf.env.cacheDir = process.env.MODEL_CACHE;
const m = MODELS[MODEL_KEY] || MODELS.turbo;
const modelId = m.en || m.id;
log(`loading ${modelId} (${os.cpus().length} CPUs, ${Math.round(os.totalmem() / 2 ** 30)} GB)`);
const asr = await tf.pipeline('automatic-speech-recognition', modelId, { device: 'cpu', dtype: dtypeFor(modelId, 'wasm') });
const diarizer = await createDiarizer(tf);
const checker = m.en ? null : await tf.pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny', { device: 'cpu', dtype: 'q8' });
const models = { tf, asr, diarizer, checker, modelKey: MODEL_KEY };

/* ---------- the queue ---------- */

let failed = 0;
for (const [i, ep] of queue.entries()) {
  const left = LIMIT_MIN - (Date.now() - t0) / 60000;
  const need = (ep.duration || 90 * 60) / 60 / speed + 5;
  if (need > left) {
    log(`${ep.show}: ${ep.title} needs about ${Math.round(need)} min, ${Math.round(left)} left: next run`);
    continue;
  }
  const waiting = queue.slice(i + 1).map(({ id, title, show, published }) => ({ id, title, show, published }));
  // (What the app shows of it, lib/serverjob.js: the step, how far, at what pace; every minute.)
  const current = { id: ep.id, title: ep.title, show: ep.show, step: 'downloading', position: 0, total: ep.duration || 0, startedAt: Date.now() };
  await status({ current, queue: waiting });
  log(`transcribing ${ep.show}: ${ep.title} (${Math.round((ep.duration || 0) / 60)} min)`);
  const tmpFile = path.join(os.tmpdir(), `${ep.id}.audio`);
  try {
    let last = 0;
    let logged = Date.now();
    const entry = await transcribeEpisode(ep, models, {
      tmpFile,
      onProgress: ({ position, elapsed }) => {
        if (Date.now() - last < 60000) return;
        last = Date.now();
        if (last - logged >= 120000) { logged = last; log(`  ${Math.round(position / 60)} min in, ${(position / Math.max(1, elapsed)).toFixed(2)}x realtime`); }
        status({ current: { ...current, step: 'transcribing', total: current.total || position, position, elapsed }, queue: waiting });
      },
    });
    await status({ current: { ...current, step: 'uploading', total: entry.total || current.total, position: entry.total || current.total, elapsed: entry.took }, queue: waiting });
    const audioName = `${entry.id}.${entry.audioExt}`;
    delete entry.audioExt;
    entry.fixes = FIXES;
    entry.audio = `library/${audioName}`;
    const quiet = entry.quiet || [];
    delete entry.quiet;
    await put(audioName, await readFile(tmpFile), entry.audio.endsWith('m4a') ? 'audio/mp4' : 'audio/mpeg');
    await put(`${entry.id}.quiet.json`, JSON.stringify({ v: QUIET_VERSION, quiet }), 'application/json');
    await put(`${entry.id}.md`, markdownOf(entry), 'text/markdown');
    await put(`${entry.id}.json`, JSON.stringify(entry), 'application/json'); // last: this lists it
    speed = Math.min(1.5, (entry.total / entry.took) * 0.9);
    log(`  done: ${entry.words} words, ${Math.round(entry.total / 60)} min in ${Math.round(entry.took / 60)} min (${(entry.total / entry.took).toFixed(2)}x realtime)`);
  } catch (err) {
    failed++;
    log(`  failed: ${err.stack || err.message}`);
  } finally {
    await rm(tmpFile, { force: true });
  }
}
await status({ current: null, queue: [] });
process.exit(failed ? 1 : 0);
