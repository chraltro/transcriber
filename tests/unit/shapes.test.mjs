// The episodes' shapes on the server (server/shapes.mjs): filed when a transcript arrives, made at
// start for the transcripts already there, served, and flagged in the index. (That they go with
// the pruned audio copy is in prune.test.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileShape, makeShapes } from '../../server/shapes.mjs';
import { readShape, voiceAt, SHAPE_VERSION } from '../../lib/shape.js';
import { encodeLevels } from '../../lib/levels.js';

const ROOT = new URL('../..', import.meta.url).pathname;
const id = (n) => String(n).padStart(16, 'b');
const transcript = (n, { audio = true } = {}) => ({
  id: id(n), title: `Episode ${n}`, show: 'A show', createdAt: n, total: 120,
  levels: encodeLevels(Uint8Array.from({ length: 120 }, (_, i) => 20 + (i % 30))),
  segments: [{ start: 0, end: 50, speaker: 0, text: 'Hello.' }, { start: 51, end: 118, speaker: 1, text: 'Hello to you.' }],
  speakerNames: { 1: 'Ingrid' },
  ...(audio ? { audio: `library/${id(n)}.mp3` } : {}),
});
const readJson = async (f, fallback) => { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => writeFile(f, JSON.stringify(v));

test('a transcript that arrives with its audio gets its shape filed beside it', async () => {
  const lib = await mkdtemp(path.join(tmpdir(), 'shapes-'));
  try {
    assert.equal(await fileShape({ lib, entry: transcript(1), writeJson }), SHAPE_VERSION);
    const shape = readShape(await readJson(path.join(lib, `${id(1)}.shape.json`)));
    assert.deepEqual(shape.voices, ['Ingrid', 'Speaker 1']);
    assert.equal(voiceAt(shape, 10), 1);
    assert.equal(shape.levels.length, 120);
    // Without the audio it was made from kept here, there is nothing for the shape to be of.
    assert.equal(await fileShape({ lib, entry: transcript(2, { audio: false }), writeJson }), undefined);
    assert.equal(await readJson(path.join(lib, `${id(2)}.shape.json`), null), null);
  } finally {
    await rm(lib, { recursive: true, force: true });
  }
});

test('transcripts already there get theirs, without being rewritten, and an upload meanwhile is kept', async () => {
  const lib = await mkdtemp(path.join(tmpdir(), 'shapes-'));
  try {
    const entries = [transcript(1), transcript(2, { audio: false }), transcript(3)];
    for (const e of entries) await writeJson(path.join(lib, `${e.id}.json`), e);
    await writeJson(path.join(lib, 'index.json'), { entries: entries.map(({ segments, levels, ...meta }) => meta) });
    const before = await readFile(path.join(lib, `${id(1)}.json`), 'utf8');
    // An upload lands while they are made; and one copy is pruned meanwhile.
    const withIndex = async (fn) => {
      const index = await readJson(path.join(lib, 'index.json'));
      index.entries.unshift({ id: id(4), title: 'New' });
      delete index.entries.find((e) => e.id === id(3)).audio;
      await writeJson(path.join(lib, 'index.json'), index);
      return fn();
    };
    assert.equal(await makeShapes({ lib, readJson, writeJson, withIndex }), 2);
    const index = await readJson(path.join(lib, 'index.json'));
    assert.deepEqual(index.entries.map((e) => [e.id, e.shape ?? null]), [[id(4), null], [id(1), 1], [id(2), null], [id(3), null]]);
    assert.ok(await readJson(path.join(lib, `${id(1)}.shape.json`), null));
    assert.equal(await readJson(path.join(lib, `${id(3)}.shape.json`), null), null);
    assert.equal(await readFile(path.join(lib, `${id(1)}.json`), 'utf8'), before);
    // Nothing to do the second time.
    assert.equal(await makeShapes({ lib, readJson, writeJson, withIndex: (fn) => fn() }), 0);
  } finally {
    await rm(lib, { recursive: true, force: true });
  }
});

test('the server makes them at start, serves them and says so in its index', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'shapes-serve-'));
  const lib = path.join(data, 'library');
  await mkdir(lib, { recursive: true });
  const entries = [transcript(1), transcript(2, { audio: false })];
  for (const e of entries) await writeJson(path.join(lib, `${e.id}.json`), e);
  await writeJson(path.join(lib, 'index.json'), { entries: entries.map(({ segments, levels, ...meta }) => meta) });
  const port = await new Promise((resolve) => { const s = http.createServer().listen(0, () => { const { port: free } = s.address(); s.close(() => resolve(free)); }); });
  const app = spawn(process.execPath, [path.join(ROOT, 'server/main.mjs')], { env: { ...process.env, DATA_DIR: data, PORT: String(port), POD_FEEDS: '0', POD_SEED: '0', TRANSCRIBE: '' }, stdio: 'ignore' });
  try {
    const base = `http://localhost:${port}`;
    let res = null;
    for (let i = 0; i < 100; i++) {
      res = await fetch(`${base}/library/${id(1)}.shape.json`).catch(() => null);
      if (res?.ok) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(res?.status, 200);
    const shape = readShape(await res.json());
    assert.deepEqual(shape.voices, ['Ingrid', 'Speaker 1']);
    assert.equal((await fetch(`${base}/library/${id(2)}.shape.json`)).status, 404);
    let index = null;
    for (let i = 0; i < 50 && !index?.entries.find((e) => e.id === id(1))?.shape; i++) {
      index = await (await fetch(`${base}/library/index.json`)).json();
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual(index.entries.map((e) => [e.id, e.shape ?? null]), [[id(1), SHAPE_VERSION], [id(2), null]]);
  } finally {
    app.kill();
    await new Promise((r) => (app.exitCode != null ? r() : app.once('exit', r)));
    await rm(data, { recursive: true, force: true });
  }
});
