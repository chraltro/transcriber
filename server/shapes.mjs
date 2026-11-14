// The shape of each transcribed episode (lib/shape.js: its loudness and who speaks when), filed
// beside its transcript as <id>.shape.json for the player to draw. Like <id>.quiet.json it is
// about the server's copy of the audio, the one the transcript was made from: it is made only
// while that copy is kept, and goes with it (server/prune.mjs). The index says which have one.
// Node built-ins only: the server's image has no `npm install`.
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { SHAPE_VERSION } from '../lib/shape.js';
import { shapeOf } from './shows.mjs';

export const shapeName = (id) => `${id}.shape.json`;

// Files the shape of `entry` (a transcript), when the server keeps the audio it was made from.
// -> the version filed, or undefined.
export async function fileShape({ lib, entry, writeJson }) {
  if (!entry?.audio || !Array.isArray(entry.segments)) return undefined;
  await writeJson(path.join(lib, shapeName(entry.id)), shapeOf(entry));
  return SHAPE_VERSION;
}

// Transcripts filed before there were shapes (or under an older version) get theirs, one at a
// time: one transcript in memory, read and never rewritten. The index is written once at the end,
// under withIndex, so an upload that came in meanwhile is not written over.
// -> how many were made.
export async function makeShapes({ lib, readJson, writeJson, withIndex, log = () => {} }) {
  const indexFile = path.join(lib, 'index.json');
  const index = await readJson(indexFile, null);
  const made = new Set();
  for (const meta of index?.entries || []) {
    if (!meta.audio || meta.shape === SHAPE_VERSION) continue;
    try {
      const entry = await readJson(path.join(lib, `${meta.id}.json`), null);
      if (await fileShape({ lib, entry, writeJson })) made.add(meta.id);
    } catch (err) {
      log(`shapes: ${meta.id}: ${err.message}`);
    }
    await new Promise((r) => setImmediate(r)); // (the server answers between them)
  }
  if (!made.size) return 0;
  await withIndex(async () => {
    const fresh = await readJson(indexFile, null);
    if (!Array.isArray(fresh?.entries)) return;
    for (const meta of fresh.entries) {
      if (!made.has(meta.id)) continue;
      // Its audio went meanwhile: so does the shape of it.
      if (!meta.audio) await rm(path.join(lib, shapeName(meta.id)), { force: true });
      else meta.shape = SHAPE_VERSION;
    }
    await writeJson(indexFile, fresh);
  });
  return made.size;
}
