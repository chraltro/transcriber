// What the podcast side remembers, as one document that every device and the server hold a copy
// of: followed shows, how far each episode has been played, the queue, and settings. Copies are
// brought together record by record, the one changed last winning (`at`, a clock time), so two
// devices that were both used offline lose nothing but the older of two edits to the same thing.
// Plain data and arithmetic only: the page keeps it in localStorage (ui/podstore.js), the server
// in a file (server/pod.mjs).

export const emptyDoc = () => ({ v: 1, subs: {}, eps: {}, progress: {}, wants: {}, queue: { ids: [], at: 0 }, settings: { at: 0 } });

export const DEFAULTS = { speed: 1, back: 15, fwd: 30, skipAds: true, rewind: true, keepDownloads: false };
export const settingsOf = (doc) => ({ ...DEFAULTS, ...(doc?.settings || {}) });

// A show's id, from its feed address: the same on every device without asking anyone.
export function subId(feedUrl) {
  const s = String(feedUrl || '').trim().replace(/#.*$/, '').replace(/^http:/i, 'https:').replace(/\/+$/, '');
  let a = 0x811c9dc5;
  let b = 0x1b873593;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ c, 0x85ebca6b) ^ (b >>> 13);
  }
  return ((a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')).slice(0, 12);
}

const MAPS = ['subs', 'eps', 'progress', 'wants'];
const SINGLES = ['queue', 'settings'];

// Every record of a document as [key, record]: "subs/<id>", "progress/<id>", "queue", "settings".
export function* records(doc) {
  for (const m of MAPS) for (const [id, rec] of Object.entries(doc?.[m] || {})) yield [`${m}/${id}`, rec];
  for (const s of SINGLES) if (doc?.[s]) yield [s, doc[s]];
}

// "subs/<id>" -> ['subs', '<id>'], "queue" -> ['queue', null]
const parts = (key) => {
  const i = key.indexOf('/');
  return i < 0 ? [key, null] : [key.slice(0, i), key.slice(i + 1)];
};

export function getRecord(doc, key) {
  const [m, id] = parts(key);
  return id == null ? doc[m] : doc[m]?.[id];
}

function setRecord(doc, key, rec) {
  const [m, id] = parts(key);
  if (id == null) doc[m] = rec;
  else (doc[m] ||= {})[id] = rec;
}

const valid = (key, rec) => {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec) || !Number.isFinite(rec.at)) return false;
  const [m, id] = parts(key);
  if (id == null) return SINGLES.includes(m) && (m !== 'queue' || Array.isArray(rec.ids));
  return MAPS.includes(m) && /^[\w-]{1,40}$/.test(id);
};

// The records named by `keys`, as a partial document to send.
export function pick(doc, keys) {
  const out = {};
  for (const key of keys) {
    const rec = getRecord(doc, key);
    if (rec) setRecord(out, key, rec);
  }
  return out;
}

// Brings `changes` (a whole or partial document) into `doc`: a record replaces the one held
// when it was changed later. -> the keys that changed.
export function apply(doc, changes) {
  const changed = [];
  for (const [key, rec] of records(changes)) {
    if (!valid(key, rec)) continue;
    const have = getRecord(doc, key);
    if (have && have.at >= rec.at) continue;
    setRecord(doc, key, rec);
    changed.push(key);
  }
  return changed;
}

/* ---------- shows ---------- */

export const shows = (doc) => Object.values(doc.subs || {}).filter((s) => !s.gone).sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' }));

export function follow(doc, show, now) {
  const id = show.id || subId(show.feedUrl);
  const had = doc.subs[id];
  doc.subs[id] = { ...had, ...show, id, gone: undefined, addedAt: had && !had.gone ? had.addedAt : now, at: now };
  delete doc.subs[id].gone;
  return `subs/${id}`;
}

export function unfollow(doc, id, now) {
  const had = doc.subs[id];
  if (!had) return null;
  doc.subs[id] = { id, feedUrl: had.feedUrl, title: had.title, gone: true, at: now };
  return `subs/${id}`;
}

export function updateShow(doc, id, patch, now) {
  const had = doc.subs[id];
  if (!had || had.gone) return null;
  doc.subs[id] = { ...had, ...patch, id, at: now };
  return `subs/${id}`;
}

/* ---------- episodes and how far they have been played ---------- */

// What an episode row needs wherever it is listed: kept for episodes that are queued or started.
export function rememberEpisode(doc, ep, now) {
  const had = doc.eps[ep.id];
  // (Cover art read out of a file is megabytes of text: only an address is kept.)
  const rec = { id: ep.id, sub: ep.sub || '', title: ep.title || '', show: ep.show || '', art: /^https?:/i.test(ep.art || '') ? ep.art : '', url: ep.url || '', published: ep.published || 0, duration: Math.round(ep.duration || 0) };
  if (had && Object.keys(rec).every((k) => had[k] === rec[k])) return null;
  doc.eps[ep.id] = { ...rec, at: now };
  return `eps/${ep.id}`;
}

// p: position in seconds, d: the length the player measured, done: listened to the end.
export function setProgress(doc, id, { p, d, done }, now) {
  const had = doc.progress[id] || {};
  doc.progress[id] = { p: Math.max(0, Math.round((p ?? had.p ?? 0) * 10) / 10), d: Math.round(d ?? had.d ?? 0), done: done ?? had.done ?? false, at: now };
  if (!doc.progress[id].done) delete doc.progress[id].done;
  return `progress/${id}`;
}

export const statusOf = (rec) => (!rec ? 'new' : rec.done ? 'done' : rec.p > 5 ? 'started' : 'new');
export const fractionOf = (rec, duration) => {
  const d = rec?.d || duration || 0;
  return rec?.done ? 1 : d ? Math.min(1, Math.max(0, (rec?.p || 0) / d)) : 0;
};

// Started and not finished, most recently played first.
export function inProgress(doc, max = 12) {
  return Object.entries(doc.progress || {})
    .filter(([id, r]) => !r.done && r.p > 5 && doc.eps[id])
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, max)
    .map(([id]) => doc.eps[id]);
}

/* ---------- transcripts asked for ----------
 * An episode the listener wants transcribed on the server (the workflow that does it reads the
 * list, server/pod.mjs). It needs the feed's address to find the episode again. */

export function want(doc, ep, feedUrl, now) {
  doc.wants[ep.id] = { id: ep.id, feedUrl, title: ep.title || '', at: now };
  return `wants/${ep.id}`;
}

export function unwant(doc, id, now) {
  if (!doc.wants?.[id] || doc.wants[id].gone) return null;
  doc.wants[id] = { id, gone: true, at: now };
  return `wants/${id}`;
}

export const wanted = (doc, id) => !!doc.wants?.[id] && !doc.wants[id].gone;

/* ---------- queue ---------- */

export function queueAdd(doc, id, now, { next = false, after = null } = {}) {
  const ids = (doc.queue?.ids || []).filter((x) => x !== id);
  if (next) {
    const at = after != null ? ids.indexOf(after) + 1 : 0;
    ids.splice(Math.max(0, at), 0, id);
  } else ids.push(id);
  doc.queue = { ids, at: now };
  return 'queue';
}

export function queueRemove(doc, id, now) {
  if (!doc.queue?.ids.includes(id)) return null;
  doc.queue = { ids: doc.queue.ids.filter((x) => x !== id), at: now };
  return 'queue';
}

export function queueMove(doc, id, to, now) {
  const ids = (doc.queue?.ids || []).filter((x) => x !== id);
  if (ids.length === (doc.queue?.ids || []).length) return null;
  ids.splice(Math.max(0, Math.min(ids.length, to)), 0, id);
  doc.queue = { ids, at: now };
  return 'queue';
}

export function setSettings(doc, patch, now) {
  doc.settings = { ...(doc.settings || {}), ...patch, at: now };
  return 'settings';
}

/* ---------- tidying ---------- */

const DAY = 864e5;

// Drops what nothing points at any more: unfollowed shows after three months, episode details
// of finished or never-started episodes that aren't queued, the oldest of far too many
// positions. -> the keys removed.
export function prune(doc, now, { maxProgress = 6000 } = {}) {
  const removed = [];
  const queued = new Set(doc.queue?.ids || []);
  for (const [id, s] of Object.entries(doc.subs || {})) {
    if (s.gone && now - s.at > 90 * DAY) { delete doc.subs[id]; removed.push(`subs/${id}`); }
  }
  for (const [id, e] of Object.entries(doc.eps || {})) {
    const p = doc.progress?.[id];
    const idle = now - Math.max(e.at, p?.at || 0) > 30 * DAY;
    if (!queued.has(id) && idle && (!p || p.done || p.p <= 5)) { delete doc.eps[id]; removed.push(`eps/${id}`); }
  }
  // A request nobody could fulfil in three weeks (or that was withdrawn that long ago) is dropped.
  for (const [id, w] of Object.entries(doc.wants || {})) {
    if (now - w.at > 21 * DAY) { delete doc.wants[id]; removed.push(`wants/${id}`); }
  }
  const all = Object.entries(doc.progress || {});
  if (all.length > maxProgress) {
    all.sort((a, b) => a[1].at - b[1].at);
    for (const [id] of all.slice(0, all.length - maxProgress)) { delete doc.progress[id]; removed.push(`progress/${id}`); }
  }
  return removed;
}
