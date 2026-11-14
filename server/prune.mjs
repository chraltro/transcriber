// The server keeps a copy of each transcribed episode's audio (library/<id>.mp3|m4a), so the
// player can play the copy the transcript was made from, in sync and with its ads where the
// transcript says. At 50 to 100 MB each they would fill the disk, so they go after a while; the
// transcript stays, and the app then plays the podcast's own address (ui/player.js).
// Node built-ins only: the server's image has no `npm install`.
import { readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';

const DAY = 864e5;
// A file this new may belong to an upload still under way (the audio goes up before the
// transcript that lists it), so it is never touched.
export const GRACE_DAYS = 2;

const AUDIO = /^([0-9a-f]{16})\.(mp3|m4a)$/;

// What goes, decided from plain data. entries: the library index's entries; files: [{ name,
// mtimeMs, size }] in the library folder; doc: the listener's library document (lib/podstate.js).
// A copy goes once its transcript is `days` old, or three times that for an episode that is
// queued or started and not finished (it is likely to be played soon, and the copy plays in
// sync). Audio and unfinished uploads (.part) nobody lists go once they are GRACE_DAYS old.
// -> { copies: [entry id], leftovers: [file name] }
export function planPrune({ entries, files, doc, now, days }) {
  const queued = new Set(doc?.queue?.ids || []);
  const started = (id) => {
    const p = doc?.progress?.[id];
    return !!p && !p.done && p.p > 5;
  };
  const byName = new Map(files.map((f) => [f.name, f]));
  const fresh = (name) => {
    const f = byName.get(name);
    return !!f && now - f.mtimeMs < GRACE_DAYS * DAY;
  };
  const copies = [];
  const listed = new Set();
  for (const e of entries) {
    if (!e.audio) continue;
    const name = path.basename(e.audio);
    listed.add(name);
    const keep = (queued.has(e.id) || started(e.id) ? 3 : 1) * days * DAY;
    const age = now - (e.transcribedAt || e.createdAt || 0);
    if (age > keep && !fresh(name)) copies.push(e.id);
  }
  const leftovers = files
    .filter((f) => (f.name.endsWith('.part') || (AUDIO.test(f.name) && !listed.has(f.name))) && !fresh(f.name))
    .map((f) => f.name);
  return { copies, leftovers };
}

// One pass over the library folder `lib`. Run inside withIndex (main.mjs), so no upload writes
// the index meanwhile. readJson / writeJson: main.mjs's (the index is written whole, by renaming).
// -> { copies, leftovers, bytes } freed.
export async function pruneLibrary({ lib, doc, now = Date.now(), days, readJson, writeJson }) {
  const indexFile = path.join(lib, 'index.json');
  // Without an index that reads, every copy would look like nobody's: nothing is touched. The
  // same goes for an index that lists nothing: a library with no transcripts has nothing to
  // prune, and one whose index has come out empty by some fault must not lose its audio to it.
  const index = await readJson(indexFile, null);
  if (!Array.isArray(index?.entries) || !index.entries.length) return { copies: 0, leftovers: 0, bytes: 0 };
  const files = [];
  for (const name of await readdir(lib)) {
    if (!name.endsWith('.part') && !AUDIO.test(name)) continue;
    const s = await stat(path.join(lib, name)).catch(() => null);
    if (s?.isFile()) files.push({ name, mtimeMs: s.mtimeMs, size: s.size });
  }
  const plan = planPrune({ entries: index.entries, files, doc, now, days });
  const sizes = new Map(files.map((f) => [f.name, f.size]));
  let bytes = 0;
  const drop = async (name) => {
    await rm(path.join(lib, name), { force: true });
    bytes += sizes.get(name) || 0;
  };
  const gone = new Set(plan.copies);
  for (const meta of index.entries) {
    if (!gone.has(meta.id)) continue;
    await drop(path.basename(meta.audio));
    // (Where it goes quiet, and its shape, were about that copy.)
    await rm(path.join(lib, `${meta.id}.quiet.json`), { force: true });
    await rm(path.join(lib, `${meta.id}.shape.json`), { force: true });
    const file = path.join(lib, `${meta.id}.json`);
    const entry = await readJson(file, null);
    if (entry?.audio) { delete entry.audio; await writeJson(file, entry); }
    delete meta.audio;
    delete meta.quiet;
    delete meta.shape;
  }
  const ids = new Set(index.entries.map((e) => e.id));
  for (const name of plan.leftovers) {
    await drop(name);
    // The quiet list of audio whose transcript never came goes with it.
    const id = name.match(AUDIO)?.[1];
    if (id && !ids.has(id)) await rm(path.join(lib, `${id}.quiet.json`), { force: true });
  }
  if (gone.size) await writeJson(indexFile, index);
  return { copies: plan.copies.length, leftovers: plan.leftovers.length, bytes };
}
