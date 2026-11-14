// Search across every transcript in the library: "where did they talk about X". Answers
// GET /api/pod/search?q= (server/pod.mjs).
//
// A query is words and "quoted phrases". Case and accents don't count, but æ, ø and å are
// letters of their own (Norwegian and Danish), so "for" does not find "før". A bare word finds
// words that start with it ("box" finds "boxes"); one of one or two letters, a quoted word and a
// phrase find only themselves. A hit is a sentence (segment) that holds every term, or a run of
// two or three neighbouring ones that together do.
//
// The server is small (half a CPU, 256 MB) and the library runs to hundreds of transcripts of
// up to 600 KB each, so parsed transcripts are never kept. Each transcript's text is filed once
// in a compact form beside the library (<cacheDir>/<id>.txt: a header line with the segments'
// start times, then one segment's text per line), made when it is first searched or when the
// transcript is uploaded. In memory there is only the folded text of the newest episodes (one
// string each, with where each segment starts in it), up to `budget` characters; older ones are
// read back from those files when a query gets to them.
import { readFile, writeFile, rename, rm, stat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

const VERSION = 1;
export const MAX_EPISODES = 30;
export const MAX_HITS = 5;
const SPAN = 3; // neighbouring segments a hit may run over
const MAX_TERMS = 8;
const MAX_QUERY = 200;
const MAX_MATCHES = 5000; // of one term in one transcript: past that it says nothing anyway

/* ---------- folding ---------- */

const FOLDS = new Map();
function foldChar(c) {
  let f = FOLDS.get(c);
  if (f === undefined) {
    if (c === 'æ' || c === 'ø' || c === 'å') f = c;
    else if (/\s/.test(c)) f = ' ';
    else if ('‘’ʼ′`'.includes(c)) f = "'";
    else if ('“”„«»'.includes(c)) f = '"';
    else {
      const bare = c.normalize('NFD').replace(/\p{M}/gu, '');
      f = bare.length === 1 ? bare : c;
      // Punctuation from beyond Latin-1 (long dashes, ellipses, bullets) is a space to a search,
      // and with it gone a transcript's folded text takes one byte a character in memory, not
      // two: one such mark anywhere in a transcript would double what the whole of it takes.
      if (f.charCodeAt(0) > 0xff && !/[\p{L}\p{N}]/u.test(f)) f = ' ';
    }
    FOLDS.set(c, f);
  }
  return f;
}

// Lower case, accents off (æ, ø, å kept), any space a plain one, curly quotes straight. Every
// character stays one character, so a place in the folded text is the same place in the text.
export function fold(s) {
  const text = String(s);
  let out = text.toLowerCase();
  if (out.length !== text.length) out = [...text].map((c) => { const l = c.toLowerCase(); return l.length === c.length ? l : c; }).join('');
  return out.replace(/[^ -~]/g, foldChar);
}

// A segment's text as it is filed and shown: one line, single spaces.
export const clean = (s) => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim();

/* ---------- queries ---------- */

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';

// -> [{ text, re }]: what each term is, and how it is found in folded text.
export function parseQuery(q) {
  const terms = [];
  for (const m of fold(String(q || '').slice(0, MAX_QUERY)).matchAll(/"([^"]*)"?|([^\s"]+)/g)) {
    const words = (m[1] ?? m[2]).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (!words.length) continue;
    const text = words.join(' ');
    if (terms.some((t) => t.text === text)) continue;
    const exact = m[1] != null || words.length > 1 || text.length < 3;
    // Between the words of a phrase, whatever separates words: a space, a comma and a space.
    const body = words.map(esc).join('[^\\p{L}\\p{N}]{1,4}');
    terms.push({ text, re: new RegExp(exact ? `${B}${body}${E}` : `${B}${body}[\\p{L}\\p{N}]*`, 'gu') });
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

/* ---------- one transcript ---------- */

// The searchable form of a transcript's lines: their folded text joined by spaces (so a phrase
// may run on from one segment into the next), and where each line starts in it.
export function docOf(lines, starts) {
  const offs = new Int32Array(lines.length + 1);
  for (let i = 0, at = 0; i <= lines.length; i++) { offs[i] = at; at += (lines[i]?.length || 0) + 1; }
  return { fold: fold(lines.join(' ')), offs, starts: Float64Array.from(starts) };
}

const segAt = (offs, pos) => {
  let lo = 0;
  let hi = offs.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offs[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return lo;
};

// -> null, or { count, hits: [{ from, to, marks: [[a, b], ...] }] } with the segments each hit
// runs over (from..to) and where the terms are in the folded text: the hits that run over the
// fewest segments, up to MAX_HITS, in the order they are said. any: only whether there is a
// hit at all matters (an episode past the ones that are listed), and it can be said sooner.
export function match(doc, terms, { any = false } = {}) {
  // First whether every term is there at all: most transcripts lack one, and that is quick.
  for (const t of terms) { t.re.lastIndex = 0; if (!t.re.test(doc.fold)) return null; }
  if (any && terms.length === 1) return { count: 1, hits: [] };
  const found = [];
  for (const t of terms) {
    const at = [];
    t.re.lastIndex = 0;
    for (let m; (m = t.re.exec(doc.fold)) && at.length < MAX_MATCHES * 2;) at.push(m.index, m.index + m[0].length);
    if (!at.length) return null;
    const n = at.length / 2;
    const sa = new Int32Array(n);
    const sb = new Int32Array(n);
    for (let k = 0; k < n; k++) { sa[k] = segAt(doc.offs, at[2 * k]); sb[k] = segAt(doc.offs, at[2 * k + 1] - 1); }
    found.push({ at, sa, sb, next: 0 });
  }
  // Every segment where some term's match ends, in order: for each, the shortest run ending
  // there that holds every term. Runs don't overlap: one is counted only past the last.
  const ends = [...new Set(found.flatMap((f) => [...f.sb]))].sort((a, b) => a - b);
  const runs = [];
  let last = -1;
  for (const j of ends) {
    let from = j;
    for (const f of found) {
      while (f.next < f.sb.length && f.sb[f.next] <= j) f.next++;
      if (!f.next) { from = -1; break; }
      from = Math.min(from, f.sa[f.next - 1]);
    }
    if (from < 0 || j - from >= SPAN || from <= last) continue;
    runs.push([from, j]);
    last = j;
  }
  if (!runs.length) return null;
  const best = [...runs].sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]) || a[0] - b[0]).slice(0, MAX_HITS).sort((a, b) => a[0] - b[0]);
  const hits = best.map(([from, to]) => {
    const lo = doc.offs[from];
    const hi = doc.offs[to + 1] - 1;
    const marks = [];
    for (const f of found) for (let k = 0; k < f.at.length; k += 2) if (f.at[k] >= lo && f.at[k + 1] <= hi) marks.push([f.at[k] - lo, f.at[k + 1] - lo]);
    marks.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const m of marks) { const p = merged[merged.length - 1]; if (p && m[0] <= p[1]) p[1] = Math.max(p[1], m[1]); else merged.push(m); }
    return { from, to, marks: merged };
  });
  return { count: runs.length, hits };
}

/* ---------- the library ---------- */

// dir: the library folder (<id>.json); cacheDir: where the compact copies go; entries(): the
// library index's entries ({ id, title, show, art, createdAt, ... }); budget: characters of
// folded text kept in memory.
export function createSearch({ dir, cacheDir, entries, budget = 16e6, log = () => {} }) {
  const docs = new Map(); // id -> { tag, fold, offs, starts, at (the episode's createdAt) }
  const loading = new Map();
  let held = 0;
  let swept = false;

  const cacheFile = (id) => path.join(cacheDir, `${id}.txt`);
  const tagOf = async (id) => { const s = await stat(path.join(dir, `${id}.json`)); return `${s.size}-${Math.round(s.mtimeMs)}`; };
  const sizeOf = (doc) => doc.fold.length + doc.offs.byteLength + doc.starts.byteLength;

  // Over the budget, the oldest episodes' text goes first, the one coming in included: every
  // query reads the library newest first, so a least-recently-used rule would throw out just
  // what the next query reads next.
  function keep(id, doc, at = 0) {
    drop(id);
    doc.at = at;
    docs.set(id, doc);
    held += sizeOf(doc);
    while (held > budget && docs.size > 1) {
      let oldest = null;
      for (const [k, d] of docs) if (!oldest || d.at < docs.get(oldest).at) oldest = k;
      drop(oldest);
      if (oldest === id) break;
    }
  }
  function drop(id) {
    const had = docs.get(id);
    if (had) { docs.delete(id); held -= sizeOf(had); }
  }

  // The compact copy on disk: { tag, url, starts, lines }, or null when there is none or it is
  // of another version of the transcript.
  async function readCache(id, tag) {
    let raw;
    try { raw = await readFile(cacheFile(id), 'utf8'); } catch { return null; }
    const nl = raw.indexOf('\n');
    let head;
    try { head = JSON.parse(nl < 0 ? raw : raw.slice(0, nl)); } catch { return null; }
    if (head.v !== VERSION || (tag && head.tag !== tag) || !Array.isArray(head.starts)) return null;
    const lines = nl < 0 ? [] : raw.slice(nl + 1).split('\n');
    return lines.length === head.starts.length ? { ...head, lines } : null;
  }

  async function writeCache(id, tag, entry) {
    const segs = Array.isArray(entry.segments) ? entry.segments : [];
    const lines = segs.map((s) => clean(s.text));
    const starts = segs.map((s) => Math.round((Number(s.start) || 0) * 100) / 100);
    const out = { v: VERSION, tag, url: entry.source?.url || '', starts, lines };
    try {
      await mkdir(cacheDir, { recursive: true });
      const tmp = `${cacheFile(id)}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify({ v: VERSION, tag, url: out.url, starts })}\n${lines.join('\n')}`);
      await rename(tmp, cacheFile(id));
    } catch (err) {
      log(`search: couldn't file ${id}: ${err.message}`);
    }
    return out;
  }

  // The transcript's lines, from the compact copy, made from the transcript when need be.
  async function linesOf(id) {
    const tag = await tagOf(id);
    const cached = await readCache(id, tag);
    if (cached) return cached;
    const entry = JSON.parse(await readFile(path.join(dir, `${id}.json`), 'utf8'));
    return writeCache(id, tag, entry);
  }

  function load(id, at) {
    const have = docs.get(id);
    if (have) return have;
    if (loading.has(id)) return loading.get(id);
    const job = linesOf(id).then((c) => {
      const doc = { ...docOf(c.lines, c.starts), tag: c.tag };
      keep(id, doc, at);
      return doc;
    }).finally(() => loading.delete(id));
    loading.set(id, job);
    return job;
  }

  // A transcript was uploaded or changed: its compact copy is made again now, from the copy in
  // hand (the file is already in place).
  async function put(entry) {
    if (!/^[0-9a-f]{16}$/.test(entry?.id || '')) return;
    const tag = await tagOf(entry.id);
    const c = await writeCache(entry.id, tag, entry);
    keep(entry.id, { ...docOf(c.lines, c.starts), tag }, entry.createdAt || Date.now());
  }

  async function remove(id) {
    drop(id);
    await rm(cacheFile(id), { force: true });
  }

  // Copies of transcripts the library no longer lists go: those in memory as they are noticed,
  // the rest once after a start.
  async function sweep(ids) {
    if (swept) return;
    swept = true;
    for (const f of await readdir(cacheDir).catch(() => [])) {
      const id = f.split('.')[0];
      if (!ids.has(id)) await rm(path.join(cacheDir, f), { force: true }).catch(() => {});
    }
  }

  // -> { q, episodes: [{ id, title, show, art, createdAt, duration, url, count, hits: [{ start, text, marks }] }], more }
  // Newest episode first, at most MAX_EPISODES; `more` is how many more episodes have hits.
  async function query(q) {
    const terms = parseQuery(q);
    if (!terms.length) return { q: String(q || ''), episodes: [], more: 0 };
    const list = (await entries()).filter((e) => /^[0-9a-f]{16}$/.test(e?.id || '')).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const ids = new Set(list.map((e) => e.id));
    await Promise.all([...docs.keys()].filter((id) => !ids.has(id)).map((id) => remove(id).catch(() => {})));
    await sweep(ids);
    const found = [];
    let more = 0;
    for (const meta of list) {
      let doc;
      try { doc = await load(meta.id, meta.createdAt || 0); } catch { continue; } // (listed, but its file is not there)
      const got = match(doc, terms, { any: found.length >= MAX_EPISODES });
      if (!got) continue;
      if (found.length >= MAX_EPISODES) { more++; continue; }
      found.push({ meta, tag: doc.tag, ...got });
    }
    const episodes = [];
    for (const { meta, tag, ...got } of found) {
      let c;
      try { c = await linesOf(meta.id); } catch { continue; }
      // Changed behind its back since it was read: searched again in the copy that is there now.
      let { count, hits } = got;
      if (c.tag !== tag) {
        const doc = { ...docOf(c.lines, c.starts), tag: c.tag };
        keep(meta.id, doc, meta.createdAt || 0);
        ({ count, hits } = match(doc, terms) || { count: 0, hits: [] });
        if (!count) continue;
      }
      episodes.push({
        id: meta.id, title: meta.title || '', show: meta.show || '', art: meta.art || '', createdAt: meta.createdAt || 0, duration: meta.total || 0,
        ...(c.url ? { url: c.url } : {}), count,
        hits: hits.map(({ from, to, marks }) => ({ start: c.starts[from], text: c.lines.slice(from, to + 1).join(' '), marks })),
      });
    }
    return { q: String(q), episodes, more };
  }

  return { query, put, remove, get held() { return held; }, get kept() { return docs.size; } };
}
