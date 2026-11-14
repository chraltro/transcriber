// The podcast side's server half: one listener's shows, positions and queue kept in step across
// their devices, and the feeds of the shows they follow read here (browsers may not read most
// feeds themselves) so the app opens on a list that is already up to date.
//
//   GET  /api/pod/status              -> { claimed, linked }
//   POST /api/pod/claim   { key }     the first device makes its key the library's (once)
//   POST /api/pod/link    { key }     another device shows the key it was given
//   POST /api/pod/unlink              this device forgets it
//   GET  /api/pod/key                 the key, for a device that holds only the cookie
//   POST /api/pod/sync    { epoch, since, changes } -> { epoch, rev, changes }
//   GET  /api/pod/inbox               the newest episodes of every followed show (?fresh=1 reads the feeds first)
//   GET  /api/pod/feed/<show>         one show's episodes (?limit=50, ?fresh=1)
//   GET  /api/pod/notes/<show>/<ep>   an episode's notes, as the feed has them
//   GET  /api/pod/resolve?url=        any feed, read for the page (before following it)
//   GET  /api/pod/audio?u=            an episode's audio passed through, for hosts that don't
//                                     let pages download it (offline copies, transcribing)
//   GET  /api/pod/transcribe          what to transcribe: shows as their episodes come out, how far
//                                     back to go for each, and single episodes that were asked for
//                                     (the workflow reads it)
//
// Everything but status, claim and link needs the key in an Authorization header (transcribe
// also answers the workflow, which proves itself with GitHub's token). The cookie that claim and
// link set only gets a device its key back. There are no accounts; the key is the library.
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { parseFeed, appLanguage } from '../lib/feed.js';
import { emptyDoc, apply, pick, records, getRecord, subId, follow, updateShow, prune } from '../lib/podstate.js';
import { idOf } from './shows.mjs';

const UA = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' };
const MAX_FEED_BYTES = 25e6;
const MAX_EPISODES = 2000;
const MAX_NOTES = 400; // episodes whose full notes are kept, newest first
const INBOX_DAYS = 45;
const INBOX_MAX = 300;
const MAX_BODY = 4e6;
const COOKIE = 'pod_key';
const sha = (s) => createHash('sha256').update(String(s)).digest();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hosts the pass-through never fetches: this machine and private networks.
export function isPrivateAddress(ip) {
  const a = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = a.match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (mapped) return isPrivateAddress(mapped[1] || [parseInt(mapped[2], 16) >> 8, parseInt(mapped[2], 16) & 255, parseInt(mapped[3], 16) >> 8, parseInt(mapped[3], 16) & 255].join('.'));
  if (a.includes(':')) return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
  return /^(127|10|0)\./.test(a) || /^192\.168\./.test(a) || /^169\.254\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a);
}

// A host by its name: podcasts are served from names, so an address written out is refused
// along with this machine's own names.
export function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return !h || h === 'localhost' || /\.(local|internal|localhost|lan|home\.arpa)$/.test(h) || !h.includes('.') || h.includes(':') || /^[\d.]+$/.test(h);
}

async function readCapped(res, max) {
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { reader.cancel().catch(() => {}); throw new Error('Feed too large'); }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks);
  const latin = /encoding=["'](iso-8859-1|windows-1252|latin1)["']/i.test(buf.subarray(0, 200).toString('latin1'));
  return buf.toString(latin ? 'latin1' : 'utf8');
}

// seeds: shows followed from the start ([{ name, appleId }], server/shows.mjs).
// freshSeconds: a feed read this recently is not read again when the app asks for what is new.
// transcribed(): the ids of the episodes the library already has a transcript of.
// workflow(req): is this request from the transcribing workflow (server/oidc.mjs)?
// lookup(host): the addresses a name stands for, so one that points into this network is refused.
export function createPod({ dataDir, log = console.log, fetchImpl = fetch, findFeed = null, seeds = [], key: fixedKey = '', pollMinutes = 30, now = () => Date.now(), allowPrivate = false, freshSeconds = 120, transcribed = async () => new Set(), workflow = async () => false, lookup = null }) {
  const DIR = path.join(dataDir, 'pod');
  const FEEDS = path.join(DIR, 'feeds');
  const STATE = path.join(DIR, 'state.json');
  const AUTH = path.join(DIR, 'auth.json');
  let state = { epoch: '', rev: 0, revs: {}, doc: emptyDoc(), seeded: [] };
  let auth = null; // { hash (hex), claimedAt }
  let inbox = null;
  let saveTimer = null;
  let failures = [];
  const refreshing = new Map();

  const readJson = async (file, fallback) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; } };
  const writeJson = async (file, value) => {
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(value));
    await rename(tmp, file);
  };
  const save = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; writeJson(STATE, state).catch((err) => log(`pod: state not saved: ${err.message}`)); }, 1500);
    saveTimer.unref?.();
  };
  const flush = async () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; await writeJson(STATE, state); } };

  /* ---------- who is asking ---------- */

  const keyHash = () => (fixedKey ? sha(fixedKey) : auth?.hash ? Buffer.from(auth.hash, 'hex') : null);
  const cookieOf = (req) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === COOKIE)?.[1] || '';
  const offered = (req) => req.headers.authorization?.replace(/^Bearer\s+/i, '') || decodeURIComponent(cookieOf(req));
  const right = (key) => {
    const want = keyHash();
    return !!want && !!key && timingSafeEqual(sha(key), want);
  };
  // The cookie only ever gets a device its key back (and says whether it is linked): a browser
  // sends cookies along with requests other sites start, and those must not reach anything else.
  const bearer = (req) => req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
  const linked = (req) => right(offered(req));
  const keyed = (req) => right(bearer(req));

  // Fetches something from the outside world for the listener: only public hosts, by name, and
  // every hop of a redirect is checked again.
  async function outside(target, init = {}) {
    let url = String(target);
    for (let hop = 0; hop < 6; hop++) {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) throw new Error('Not a web address');
      if (!allowPrivate) {
        if (isPrivateHost(u.hostname)) throw new Error('Not a public host');
        if (lookup && (await lookup(u.hostname)).some(isPrivateAddress)) throw new Error('Not a public host');
      }
      const res = await fetchImpl(url, { ...init, redirect: 'manual' });
      const next = res.status >= 300 && res.status < 400 && res.headers.get('location');
      if (!next) return res;
      res.body?.cancel?.().catch(() => {});
      url = new URL(next, url).href;
    }
    throw new Error('Too many redirects');
  }
  const setCookie = (req, res, key) => {
    const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted ? '; Secure' : '';
    res.setHeader('set-cookie', `${COOKIE}=${key ? encodeURIComponent(key) : ''}; Path=/; Max-Age=${key ? 315360000 : 0}; HttpOnly; SameSite=Lax${secure}`);
  };

  /* ---------- answers ---------- */

  const send = (req, res, code, value) => {
    let body = Buffer.from(JSON.stringify(value));
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    if (body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      body = gzipSync(body, { level: 5 });
      headers['content-encoding'] = 'gzip';
    }
    headers['content-length'] = body.length;
    res.writeHead(code, headers);
    res.end(body);
    return true;
  };
  const fail = (req, res, code, message) => send(req, res, code, { error: message });

  async function body(req) {
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > MAX_BODY) throw new Error('Too much');
      chunks.push(c);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  }

  /* ---------- feeds ---------- */

  const feedFile = (id) => path.join(FEEDS, `${id}.json`);
  const notesFile = (id) => path.join(FEEDS, `${id}.notes.json`);
  // (A show's id names its files here: it has to be the id its feed address gives.)
  const followed = () => Object.entries(state.doc.subs).filter(([k, s]) => !s.gone && /^https?:\/\//i.test(s.feedUrl || '') && k === subId(s.feedUrl) && s.id === k).map(([, s]) => s);

  // A feed from anywhere, as the app wants it. `before`: what was cached, for a conditional
  // request. -> { unchanged: true } or { feed, notes }.
  async function readFeed(feedUrl, before = null) {
    const headers = { ...UA, accept: 'application/rss+xml, application/xml, text/xml, */*' };
    if (before?.etag) headers['if-none-match'] = before.etag;
    else if (before?.lastModified) headers['if-modified-since'] = before.lastModified;
    const res = await outside(feedUrl, { headers, signal: AbortSignal.timeout(60000) });
    if (res.status === 304) return { unchanged: true };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = parseFeed(await readCapped(res, MAX_FEED_BYTES), { maxEpisodes: MAX_EPISODES });
    if (!parsed.title && !parsed.episodes.length) throw new Error('Not a podcast feed');
    const notes = {};
    const episodes = parsed.episodes.map((e, i) => {
      const id = idOf(e.guid);
      if (i < MAX_NOTES && e.html) notes[id] = e.html;
      const { html, guid, type, ...rest } = e;
      return { id, ...rest, ...(type && !type.startsWith('audio/') ? { type } : {}) };
    });
    return {
      feed: {
        id: subId(feedUrl), feedUrl, title: parsed.title, art: parsed.art, description: parsed.description, link: parsed.link,
        author: parsed.author, lang: appLanguage(parsed.language), fetchedAt: now(),
        etag: res.headers.get('etag') || '', lastModified: res.headers.get('last-modified') || '', episodes,
      },
      notes,
    };
  }

  // Reads a followed show's feed again and keeps the result. One at a time per show.
  function refresh(sub) {
    if (refreshing.has(sub.id)) return refreshing.get(sub.id);
    const job = (async () => {
      const before = await readJson(feedFile(sub.id), null);
      try {
        const got = await readFeed(sub.feedUrl, before);
        if (got.unchanged) {
          await writeJson(feedFile(sub.id), { ...before, fetchedAt: now(), failed: undefined });
          return before;
        }
        await writeJson(feedFile(sub.id), got.feed);
        await writeJson(notesFile(sub.id), got.notes);
        inbox = null;
        // What the feed says about the show fills in what the listener's copy lacks, and only
        // that. It is dated just after the record it adds to, so an edit made on a device that
        // was offline meanwhile still wins (and what was filled in is filled in again).
        const cur = state.doc.subs[sub.id];
        const patch = {};
        if (cur && !cur.gone) {
          if (got.feed.title && (!cur.title || cur.title === cur.feedUrl)) patch.title = got.feed.title;
          if (got.feed.art && !cur.art) patch.art = got.feed.art;
          if (got.feed.lang && !cur.lang) patch.lang = got.feed.lang;
          if (Object.keys(patch).length) { const k = updateShow(state.doc, sub.id, patch, cur.at + 1); if (k) { state.revs[k] = ++state.rev; save(); } }
        }
        return got.feed;
      } catch (err) {
        log(`pod: ${sub.title || sub.feedUrl}: ${err.message}`);
        if (before) await writeJson(feedFile(sub.id), { ...before, failed: err.message, triedAt: now() }).catch(() => {});
        if (!before) throw err;
        return before;
      } finally {
        refreshing.delete(sub.id);
      }
    })();
    refreshing.set(sub.id, job);
    return job;
  }

  // The listener asked for what is new: every feed not read in the last minutes is read now,
  // a few at a time.
  async function refreshStale() {
    const subs = followed();
    let next = 0;
    const worker = async () => {
      while (next < subs.length) {
        const sub = subs[next++];
        const feed = await readJson(feedFile(sub.id), null);
        if (!feed || now() - (feed.fetchedAt || 0) > freshSeconds * 1000) await refresh(sub).catch(() => {});
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, subs.length) }, worker));
  }

  async function refreshAll() {
    await seed();
    for (const sub of followed()) {
      await refresh(sub).catch(() => {});
      await sleep(250);
    }
    const gone = prune(state.doc, now());
    for (const k of gone) delete state.revs[k];
    if (gone.length) save();
    // Feeds of shows no longer followed.
    const keep = new Set(followed().map((s) => s.id));
    for (const f of await readdir(FEEDS).catch(() => [])) if (!keep.has(f.split('.')[0])) await rm(path.join(FEEDS, f), { force: true });
  }

  // The shows the server already transcribes are followed from the start.
  async function seed() {
    if (!findFeed) return;
    for (const show of seeds) {
      if (state.seeded.includes(show.name)) continue;
      try {
        const feedUrl = await findFeed(show);
        const id = subId(feedUrl);
        if (!state.doc.subs[id]) {
          const k = follow(state.doc, { feedUrl, title: show.name, appleId: show.appleId, transcribe: true, lang: 'english' }, now());
          state.revs[k] = ++state.rev;
        }
        state.seeded.push(show.name);
        save();
      } catch (err) {
        log(`pod: couldn't look up ${show.name}: ${err.message}`);
      }
    }
  }

  async function buildInbox() {
    const since = now() - INBOX_DAYS * 864e5;
    const all = [];
    for (const sub of followed()) {
      const feed = await readJson(feedFile(sub.id), null);
      if (!feed) continue;
      feed.episodes.forEach((e, i) => { if (e.published >= since || i < 3) all.push({ ...e, sub: sub.id }); });
    }
    all.sort((a, b) => b.published - a.published);
    return { builtAt: now(), episodes: all.slice(0, INBOX_MAX) };
  }

  /* ---------- requests ---------- */

  async function handle(req, res, p, url = new URL(req.url, 'http://x')) {
    if (!p.startsWith('/api/pod/')) return false;
    const route = p.slice('/api/pod/'.length);
    const method = req.method;

    if (route === 'status' && method === 'GET') return send(req, res, 200, { claimed: !!keyHash(), linked: linked(req) });
    if (route === 'transcribe' && method === 'GET') {
      // It says what is listened to: for the workflow (which proves itself) and the listener.
      if (!keyed(req) && !(await Promise.resolve().then(() => workflow(req)).catch(() => false))) return fail(req, res, 401, 'For the transcribing workflow');
      // Shows whose new episodes are transcribed (`fresh`) and how many of their latest to go
      // back for (`backfill`); and single episodes that were asked for and aren't there yet.
      const have = await transcribed().catch(() => new Set());
      return send(req, res, 200, {
        ready: seeds.every((s) => state.seeded.includes(s.name)),
        shows: followed().filter((s) => s.transcribe || s.backfill > 0).map((s) => ({ name: s.title, feedUrl: s.feedUrl, lang: s.lang || '', fresh: !!s.transcribe, backfill: Math.min(25, Math.max(0, Number(s.backfill) || 0)) })),
        episodes: Object.values(state.doc.wants || {}).filter((w) => !w.gone && /^https?:\/\//i.test(w.feedUrl || '') && !have.has(w.id) && now() - w.at < 21 * 864e5)
          .sort((a, b) => a.at - b.at).slice(0, 30).map((w) => ({ id: w.id, feedUrl: w.feedUrl, title: w.title || '' })),
      });
    }
    if ((route === 'claim' || route === 'link') && method === 'POST') {
      const recent = failures.filter((t) => now() - t < 600e3);
      if (recent.length >= 20) return fail(req, res, 429, 'Too many tries. Wait ten minutes.');
      let key = '';
      try { key = String((await body(req)).key || ''); } catch {}
      if (route === 'claim') {
        if (keyHash()) return fail(req, res, 409, 'This library already has a key');
        if (!/^[\w-]{20,100}$/.test(key)) return fail(req, res, 400, 'Needs a key of 20 characters or more');
        auth = { hash: sha(key).toString('hex'), claimedAt: now() };
        await writeJson(AUTH, auth);
        log('pod: the library was claimed by its first device');
      } else if (!right(key)) {
        failures = [...recent, now()];
        return fail(req, res, 401, 'That is not this library\'s key');
      }
      setCookie(req, res, key);
      return send(req, res, 200, { linked: true });
    }
    if (route === 'unlink' && method === 'POST') { setCookie(req, res, ''); return send(req, res, 200, { linked: false }); }

    if (route === 'key' && method === 'GET') {
      return linked(req) ? send(req, res, 200, { key: offered(req) }) : fail(req, res, 401, 'This device is not linked to the library');
    }
    if (!keyed(req)) return fail(req, res, 401, 'This device is not linked to the library');

    if (route === 'sync' && method === 'POST') {
      let msg;
      try { msg = await body(req); } catch { return fail(req, res, 400, 'Bad request'); }
      const whole = msg.epoch !== state.epoch;
      const before = new Set(followed().map((s) => s.id));
      const changed = apply(state.doc, msg.changes || {});
      for (const k of changed) state.revs[k] = ++state.rev;
      if (changed.length) save();
      if (changed.some((k) => k.startsWith('subs/'))) {
        inbox = null;
        for (const sub of followed()) if (!before.has(sub.id)) refresh(sub).catch(() => {});
      }
      const since = whole ? 0 : Number(msg.since) || 0;
      const keys = [...records(state.doc)].map(([k]) => k).filter((k) => (state.revs[k] || 0) > since);
      return send(req, res, 200, { epoch: state.epoch, rev: state.rev, changes: pick(state.doc, keys) });
    }

    if (route === 'inbox' && method === 'GET') {
      if (url.searchParams.get('fresh') === '1') await refreshStale();
      // A show followed a moment ago is being read right now: its episodes belong in the answer.
      if (refreshing.size) { await Promise.allSettled([...refreshing.values()]); inbox = null; }
      inbox ||= await buildInbox();
      return send(req, res, 200, inbox);
    }

    const feedMatch = route.match(/^feed\/([0-9a-f]{12})$/);
    if (feedMatch && method === 'GET') {
      const sub = followed().find((x) => x.id === feedMatch[1]);
      if (!sub) return fail(req, res, 404, 'Not a followed show');
      let feed = await readJson(feedFile(sub.id), null);
      const stale = !feed || (url.searchParams.get('fresh') === '1' && now() - (feed.fetchedAt || 0) > freshSeconds * 1000);
      if (stale) {
        try { feed = await refresh(sub); } catch (err) { return fail(req, res, 502, `Couldn't read the feed (${err.message})`); }
      }
      const limit = Number(url.searchParams.get('limit')) || 0;
      const { etag, lastModified, ...out } = feed;
      return send(req, res, 200, { ...out, total: feed.episodes.length, episodes: limit ? feed.episodes.slice(0, limit) : feed.episodes });
    }

    const notesMatch = route.match(/^notes\/([0-9a-f]{12})\/([0-9a-f]{16})$/);
    if (notesMatch && method === 'GET') {
      const notes = await readJson(notesFile(notesMatch[1]), {});
      return send(req, res, 200, { html: notes[notesMatch[2]] || '' });
    }

    if (route === 'resolve' && method === 'GET') {
      const feedUrl = String(url.searchParams.get('url') || '').trim();
      let host = '';
      try { host = new URL(feedUrl).hostname; } catch {}
      if (!/^https?:\/\//i.test(feedUrl) || !host || (!allowPrivate && isPrivateHost(host))) return fail(req, res, 400, 'Needs a feed address');
      try {
        const { feed } = await readFeed(feedUrl);
        const { etag, lastModified, ...out } = feed;
        return send(req, res, 200, { ...out, total: feed.episodes.length, episodes: feed.episodes.slice(0, 60) });
      } catch (err) {
        return fail(req, res, 502, `Couldn't read that feed (${err.message})`);
      }
    }

    if (route === 'audio' && (method === 'GET' || method === 'HEAD')) {
      const target = String(url.searchParams.get('u') || '');
      let host = '';
      try { host = new URL(target).hostname; } catch {}
      if (!/^https?:\/\//i.test(target) || (!allowPrivate && isPrivateHost(host))) return fail(req, res, 400, 'Needs an audio address');
      const headers = { ...UA };
      if (req.headers.range) headers.range = req.headers.range;
      const ctl = new AbortController();
      res.on('close', () => ctl.abort());
      let up;
      try { up = await outside(target, { method, headers, signal: ctl.signal }); } catch (err) { return fail(req, res, 502, `Couldn't reach the audio (${err.message})`); }
      const out = { 'cache-control': 'no-store' };
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (up.headers.get(h)) out[h] = up.headers.get(h);
      res.writeHead(up.status, out);
      if (method === 'HEAD' || !up.body) { res.end(); return true; }
      Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
      return true;
    }

    return fail(req, res, 404, 'Not found');
  }

  async function init() {
    await mkdir(FEEDS, { recursive: true });
    auth = await readJson(AUTH, null);
    const saved = await readJson(STATE, null);
    if (saved?.doc) state = { ...state, ...saved, doc: { ...emptyDoc(), ...saved.doc } };
    if (!state.epoch) { state.epoch = randomBytes(6).toString('hex'); await writeJson(STATE, state); }
  }

  // Feeds are read again every `pollMinutes`, the first time shortly after start.
  function start() {
    const tick = () => refreshAll().catch((err) => log(`pod: feed round failed: ${err.message}`));
    setTimeout(tick, 4000).unref?.();
    setInterval(tick, pollMinutes * 60000).unref?.();
  }

  return { init, start, handle, flush, refreshAll, get doc() { return state.doc; }, get record() { return (k) => getRecord(state.doc, k); } };
}
