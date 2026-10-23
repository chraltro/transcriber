// Run by .github/workflows/enhance.yml: takes the oldest waiting regeneration job from
// transcriber.demant.app (server/enhance.mjs), rebuilds its stretches of voice with Resemble
// Enhance (server/regen/regen.py), and uploads the result. Uploads prove they come from this
// workflow with GitHub's OIDC token, as server/ci.mjs does.
//   node server/regen.mjs --check   only says whether there is work (for the workflow's next steps)
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { appendFile, readFile, rm, writeFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as pipe } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const SITE = (process.env.SITE || 'https://transcriber.demant.app').replace(/\/$/, '');
const AUDIENCE = process.env.UPLOAD_AUDIENCE || 'transcriber.demant.app';
const MODEL_DIR = process.env.MODEL_DIR || path.join(os.homedir(), 'regen-model', 'enhancer_stage2');
const LIMIT_MIN = Number(process.env.LIMIT_MINUTES || 335); // the job is stopped at 350 (enhance.yml)
const SLOWDOWN = Number(process.env.SLOWDOWN || 3.5); // minutes of work per minute of voice, on 4 CPUs
const LOCAL = process.env.REGEN_LOCAL === '1'; // testing against a local server: no OIDC
const HERE = path.dirname(fileURLToPath(import.meta.url));
const t0 = Date.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function oidcToken() {
  if (LOCAL) return 'local';
  const res = await fetch(`${process.env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(AUDIENCE)}`, {
    headers: { authorization: `bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  });
  if (!res.ok) throw new Error(`OIDC token: HTTP ${res.status}`);
  return (await res.json()).value;
}

async function put(name, body, type) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(`${SITE}/api/enhance/${name}`, { method: 'PUT', headers: { authorization: `Bearer ${await oidcToken()}`, 'content-type': type }, body, duplex: 'half' });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return;
    } catch (err) {
      if (i >= 4) throw new Error(`Upload of ${name} failed: ${err.message}`);
      log(`  upload of ${name} failed (${err.message}); trying again`);
      await new Promise((r) => setTimeout(r, 5000 * i));
    }
  }
}
const status = (id, value) => put(`${id}.json`, JSON.stringify(value), 'application/json');

function run(cmd, args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); onLine?.(line); }
    });
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`))));
  });
}

/* ---------- what's waiting ---------- */

const res = await fetch(`${SITE}/api/enhance/queue`, { cache: 'no-store' });
if (!res.ok) { log(`${SITE} is not answering (HTTP ${res.status}); trying again next run`); process.exit(LOCAL ? 1 : 0); }
const { jobs } = await res.json();
const job = jobs.find((j) => j.status === 'queued');
if (process.argv.includes('--check')) {
  log(job ? `waiting: ${job.title || job.url} (${Math.round(job.seconds / 60)} min of voice)` : 'nothing waiting');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `work=${job ? 'yes' : 'no'}\n`);
  process.exit(0);
}
if (!job) { log('nothing waiting'); process.exit(0); }

/* ---------- the job ---------- */

const need = (job.seconds / 60) * SLOWDOWN + 8;
if (need > LIMIT_MIN - (Date.now() - t0) / 60000) {
  await status(job.id, { status: 'failed', message: `Needs about ${Math.round(need / 60)} hours, longer than a GitHub runner may run; regenerate fewer voices at a time` });
  process.exit(0);
}
const runId = process.env.GITHUB_RUN_ID || 'local';
await status(job.id, { status: 'working', progress: 0, runId, message: 'Downloading the episode' });
log(`regenerating ${Math.round(job.seconds / 60)} min of voice in ${job.title || job.url}`);
const dir = await mkdtemp(path.join(os.tmpdir(), 'regen-'));
try {
  const src = path.join(dir, 'episode.audio');
  const r = await fetch(job.url, { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' }, redirect: 'follow', signal: AbortSignal.timeout(30 * 60000) });
  if (!r.ok) throw new Error(`Couldn't download the episode (HTTP ${r.status})`);
  await pipe(Readable.fromWeb(r.body), createWriteStream(src));
  const wav = path.join(dir, 'in.wav');
  // Decoded the same way for every job; the page lines the result up with its own decoding.
  await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-ac', '1', '-ar', '44100', '-c:a', 'pcm_f32le', wav]);
  await writeFile(path.join(dir, 'ranges.json'), JSON.stringify(job.ranges));
  await status(job.id, { status: 'working', progress: 0, message: 'Loading the model' });
  let lastPut = 0;
  const out = path.join(dir, 'out.wav');
  await run('python3', [path.join(HERE, 'regen', 'regen.py'), wav, out, '--ranges', path.join(dir, 'ranges.json'), '--model', MODEL_DIR], {
    onLine: (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.total == null || Date.now() - lastPut < 90000) return;
      lastPut = Date.now();
      log(`  ${Math.round(m.done / 60)} of ${Math.round(m.total / 60)} min, about ${Math.round(m.eta / 60)} min left`);
      status(job.id, { status: 'working', progress: m.total ? m.done / m.total : 0, eta: Date.now() + m.eta * 1000, message: '' }).catch((e) => log(e.message));
    },
  });
  const mp3 = path.join(dir, 'out.mp3');
  await run('ffmpeg', ['-v', 'error', '-y', '-i', out, '-c:a', 'libmp3lame', '-b:a', '192k', mp3]);
  await put(`${job.id}.mp3`, await readFile(mp3), 'audio/mpeg');
  await status(job.id, { status: 'done', progress: 1, message: '' });
  log(`done in ${Math.round((Date.now() - t0) / 60000)} min`);
} catch (err) {
  log(`failed: ${err.stack || err.message}`);
  await status(job.id, { status: 'failed', message: String(err.message || err).slice(0, 300) }).catch(() => {});
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
