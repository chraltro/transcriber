// Voice regeneration jobs (the clean-up studio's "Regenerate on the server"). The page asks for
// stretches of an episode to be rebuilt by a speech-enhancement model too heavy for a browser or
// this small shared server; GitHub's runners do it (.github/workflows/enhance.yml, server/regen.mjs)
// and upload the result here, proving where it comes from with GitHub's OIDC token.
//
//   POST /api/enhance            { url, title, show, ranges: [[from, to], ...] }  -> { id, status }
//   GET  /api/enhance/queue      jobs waiting or running (the workflow reads this)
//   GET  /api/enhance/<id>       a job's status
//   PUT  /api/enhance/<id>.json  status from the workflow        (OIDC: enhance.yml on main)
//   PUT  /api/enhance/<id>.mp3   the result from the workflow     (OIDC: enhance.yml on main)
//   GET  /enhance/<id>.mp3       the result, for the page
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, rm, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline as pipe } from 'node:stream/promises';

export const MAX_MINUTES = 80; // of voice to regenerate per job: about 4 hours on a runner, under GitHub's 6
const MAX_WAITING = 6;
const KEEP_DAYS = 14;

export function jobId(url, ranges) {
  return createHash('sha1').update(`${url}\n${JSON.stringify(ranges)}`).digest('hex').slice(0, 16);
}

// Checks and tidies a request: http(s) audio, sorted non-overlapping ranges, not too long.
export function validate(body, { site = '' } = {}) {
  let url = String(body?.url || '').trim();
  if (/^library\/[\w-]+\.(mp3|m4a)$/.test(url) && site) url = `${site}/${url}`; // the server's own copy
  if (!/^https?:\/\//i.test(url) || url.length > 2000) throw new Error('Needs the episode\'s audio link');
  const raw = Array.isArray(body?.ranges) ? body.ranges : [];
  const ranges = raw
    .map((r) => [Number(r?.[0]), Number(r?.[1])])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a && a >= 0)
    .sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const [a, b] of ranges) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  if (!merged.length) throw new Error('Nothing to regenerate');
  if (merged.length > 400) throw new Error('Too many stretches');
  const total = merged.reduce((s, [a, b]) => s + (b - a), 0);
  if (total > MAX_MINUTES * 60) throw new Error(`That is ${Math.round(total / 60)} minutes of voice; the server takes up to ${MAX_MINUTES} at a time`);
  const round = (v) => Math.round(v * 100) / 100;
  return {
    url,
    title: String(body?.title || '').slice(0, 300),
    show: String(body?.show || '').slice(0, 200),
    ranges: merged.map(([a, b]) => [round(a), round(b)]),
    seconds: Math.round(total),
  };
}

export function createEnhance({ dataDir, authorized, log = console.log, site = '', dispatch = null }) {
  const DIR = path.join(dataDir, 'enhance');
  const file = (id, ext) => path.join(DIR, `${id}.${ext}`);
  const readJob = async (id) => { try { return JSON.parse(await readFile(file(id, 'json'), 'utf8')); } catch { return null; } };
  const writeJob = async (job) => {
    const tmp = `${file(job.id, 'json')}.tmp`;
    await writeFile(tmp, JSON.stringify(job));
    await rename(tmp, file(job.id, 'json'));
  };
  const send = (res, code, value) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const publicJob = (j) => ({
    id: j.id, status: j.status, title: j.title, seconds: j.seconds, ranges: j.ranges, createdAt: j.createdAt,
    startedAt: j.startedAt, finishedAt: j.finishedAt, progress: j.progress, eta: j.eta, message: j.message,
    audio: j.status === 'done' ? `enhance/${j.id}.mp3` : undefined,
  });

  async function all() {
    const names = await readdir(DIR).catch(() => []);
    const jobs = [];
    for (const n of names) if (/^[0-9a-f]{16}\.json$/.test(n)) { const j = await readJob(n.slice(0, 16)); if (j) jobs.push(j); }
    return jobs.sort((a, b) => a.createdAt - b.createdAt);
  }

  async function body(req, limit = 200e3) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new Error('Too big');
      chunks.push(c);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }

  async function prune() {
    for (const j of await all()) {
      const age = Date.now() - (j.finishedAt || j.createdAt || 0);
      if (age > KEEP_DAYS * 864e5) {
        await rm(file(j.id, 'mp3'), { force: true });
        await rm(file(j.id, 'json'), { force: true });
      } else if (j.status === 'working' && Date.now() - (j.updatedAt || j.startedAt || 0) > 7 * 3600e3) {
        // A runner that went quiet for longer than GitHub lets a job run has died.
        await writeJob({ ...j, status: 'failed', message: 'The runner stopped without finishing', finishedAt: Date.now() });
      }
    }
  }

  // -> true if it handled the request
  async function handle(req, res, p) {
    if (p === '/api/enhance' && req.method === 'POST') {
      try {
        const want = validate(await body(req), { site });
        const id = jobId(want.url, want.ranges);
        const have = await readJob(id);
        if (have && have.status !== 'failed') return send(res, 200, publicJob(have)), true;
        const waiting = (await all()).filter((j) => j.status === 'queued' || j.status === 'working');
        if (waiting.length >= MAX_WAITING) return send(res, 429, { error: 'The server already has a queue of regenerations; try again later' }), true;
        const job = { ...want, id, status: 'queued', createdAt: Date.now() };
        await writeJob(job);
        log(`regeneration queued: ${job.title || job.url} (${Math.round(job.seconds / 60)} min of voice)`);
        dispatch?.().catch((err) => log(`couldn't start the workflow right away: ${err.message}`));
        send(res, 201, publicJob(job));
      } catch (err) {
        send(res, 400, { error: err.message });
      }
      return true;
    }
    if (p === '/api/enhance/queue' && req.method === 'GET') {
      await prune().catch(() => {});
      const jobs = (await all()).filter((j) => j.status === 'queued' || j.status === 'working');
      send(res, 200, { jobs: jobs.map((j) => ({ ...publicJob(j), url: j.url })) });
      return true;
    }
    let m = p.match(/^\/api\/enhance\/([0-9a-f]{16})$/);
    if (m && req.method === 'GET') {
      const j = await readJob(m[1]);
      if (!j) send(res, 404, { error: 'No such job' }); else send(res, 200, publicJob(j));
      return true;
    }
    m = p.match(/^\/api\/enhance\/([0-9a-f]{16})\.(json|mp3)$/);
    if (m && req.method === 'PUT') {
      if (!(await authorized(req))) return send(res, 401, { error: 'Unauthorized' }), true;
      const [, id, ext] = m;
      const job = await readJob(id);
      if (!job) return send(res, 404, { error: 'No such job' }), true;
      try {
        if (ext === 'json') {
          const update = await body(req, 20e3);
          const allowed = ['status', 'progress', 'eta', 'message', 'runId'];
          const next = { ...job, updatedAt: Date.now() };
          for (const k of allowed) if (k in update) next[k] = update[k];
          if (!['queued', 'working', 'done', 'failed'].includes(next.status)) throw new Error('Bad status');
          if (next.status === 'working' && !job.startedAt) next.startedAt = Date.now();
          if ((next.status === 'done' || next.status === 'failed') && !job.finishedAt) next.finishedAt = Date.now();
          if (next.status === 'done' && !(await stat(file(id, 'mp3')).catch(() => null))) throw new Error('Upload the audio first');
          await writeJob(next);
          if (next.status !== job.status) log(`regeneration ${id}: ${next.status}${next.message ? ` (${next.message})` : ''}`);
        } else {
          const tmp = `${file(id, 'mp3')}.part`;
          await pipe(req, createWriteStream(tmp));
          await rename(tmp, file(id, 'mp3'));
        }
        send(res, 200, { ok: true });
      } catch (err) {
        send(res, 400, { error: err.message });
      }
      return true;
    }
    return false;
  }

  return { handle, dir: DIR, prune, init: () => mkdir(DIR, { recursive: true }) };
}
