import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planPrune, pruneLibrary } from '../../server/prune.mjs';

const DAY = 864e5;
const NOW = Date.UTC(2026, 10, 14);
const id = (n) => String(n).padStart(16, 'a');
const entry = (n, daysOld, ext = 'mp3') => ({ id: id(n), title: `Episode ${n}`, transcribedAt: NOW - daysOld * DAY, ...(ext ? { audio: `library/${id(n)}.${ext}` } : {}) });
const file = (name, daysOld, size = 1000) => ({ name, mtimeMs: NOW - daysOld * DAY, size });

test('a copy goes when its transcript is older than the limit; queued or started ones get three times as long', () => {
  const entries = [entry(1, 10), entry(2, 61), entry(3, 100), entry(4, 100), entry(5, 100), entry(6, 181), entry(7, 100, '')];
  const files = entries.filter((e) => e.audio).map((e) => file(e.audio.slice(8), 90));
  const doc = {
    queue: { ids: [id(3)], at: 1 },
    progress: { [id(4)]: { p: 300, d: 1800, at: 1 }, [id(5)]: { p: 1800, d: 1800, done: true, at: 1 }, [id(6)]: { p: 300, d: 1800, at: 1 } },
  };
  const { copies, leftovers } = planPrune({ entries, files, doc, now: NOW, days: 60 });
  // 1: young. 2: old. 3: queued, under 180 days. 4: started. 5: finished, so old. 6: started, but past 180. 7: no copy.
  assert.deepEqual(copies.sort(), [id(2), id(5), id(6)].sort());
  assert.deepEqual(leftovers, []);
  // An episode barely started (a few seconds) is not "started".
  doc.progress[id(4)].p = 3;
  assert.ok(planPrune({ entries, files, doc, now: NOW, days: 60 }).copies.includes(id(4)));
  // Without a document, only the age counts.
  assert.equal(planPrune({ entries, files, doc: null, now: NOW, days: 60 }).copies.length, 5);
});

test('a copy written in the last two days is left alone, whatever its transcript says', () => {
  // (An episode transcribed again: its new audio goes up before the transcript that lists it.)
  const entries = [entry(1, 100)];
  assert.deepEqual(planPrune({ entries, files: [file(`${id(1)}.mp3`, 1)], doc: null, now: NOW, days: 60 }).copies, []);
  // A copy that is listed and already gone is still taken off its entry.
  assert.deepEqual(planPrune({ entries, files: [], doc: null, now: NOW, days: 60 }).copies, [id(1)]);
});

test('audio nobody lists and unfinished uploads go once they are two days old', () => {
  const entries = [entry(1, 10)];
  const files = [file(`${id(1)}.mp3`, 10), file(`${id(2)}.m4a`, 3), file(`${id(3)}.mp3`, 1), file(`${id(4)}.mp3.part`, 5), file(`${id(5)}.json.part`, 0.5)];
  assert.deepEqual(planPrune({ entries, files, doc: null, now: NOW, days: 60 }), { copies: [], leftovers: [`${id(2)}.m4a`, `${id(4)}.mp3.part`] });
});

test('a pass over a library folder', async () => {
  const lib = await mkdtemp(path.join(tmpdir(), 'prune-'));
  try {
    const put = async (name, body, daysOld) => {
      await writeFile(path.join(lib, name), body);
      if (daysOld != null) await utimes(path.join(lib, name), new Date(NOW - daysOld * DAY), new Date(NOW - daysOld * DAY));
    };
    const entries = [{ ...entry(1, 90), quiet: 2, shape: 1 }, { ...entry(2, 10), shape: 1 }, entry(3, 90)];
    await put('index.json', JSON.stringify({ entries }));
    for (const e of entries) await put(`${e.id}.json`, JSON.stringify({ ...e, segments: [] }));
    await put(`${id(1)}.mp3`, Buffer.alloc(3 * 2 ** 20), 90);
    await put(`${id(1)}.quiet.json`, '{}');
    await put(`${id(1)}.shape.json`, '{}'); // (its shape is about that copy too)
    await put(`${id(2)}.shape.json`, '{}');
    await put(`${id(1)}.md`, '# Episode 1');
    await put(`${id(2)}.mp3`, Buffer.alloc(10), 10);
    await put(`${id(3)}.mp3`, Buffer.alloc(10), 90);
    await put(`${id(9)}.mp3`, Buffer.alloc(2 ** 20), 5); // its transcript never came
    await put(`${id(9)}.quiet.json`, '{}');
    await put(`${id(8)}.m4a.part`, Buffer.alloc(10), 5);
    await put(`${id(7)}.mp3`, Buffer.alloc(10), 0); // on its way up right now
    const readJson = async (f, fallback) => { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return fallback; } };
    const writeJson = (f, v) => writeFile(f, JSON.stringify(v));
    const doc = { queue: { ids: [id(3)], at: 1 }, progress: {} };
    const freed = await pruneLibrary({ lib, doc, now: NOW, days: 60, readJson, writeJson });
    assert.equal(freed.copies, 1);
    assert.equal(freed.leftovers, 2);
    assert.equal(freed.bytes, 4 * 2 ** 20 + 10);
    const left = (await readdir(lib)).sort();
    assert.deepEqual(left, [`${id(1)}.json`, `${id(1)}.md`, `${id(2)}.json`, `${id(2)}.mp3`, `${id(2)}.shape.json`, `${id(3)}.json`, `${id(3)}.mp3`, `${id(7)}.mp3`, 'index.json'].sort());
    const index = await readJson(path.join(lib, 'index.json'));
    assert.deepEqual(index.entries.map((e) => [e.id, e.audio ?? null, e.quiet ?? null, e.shape ?? null]), [[id(1), null, null, null], [id(2), entry(2).audio, null, 1], [id(3), entry(3).audio, null, null]]);
    assert.equal((await readJson(path.join(lib, `${id(1)}.json`))).audio, undefined);
    assert.equal((await readJson(path.join(lib, `${id(1)}.json`))).title, 'Episode 1');
    // Nothing more to do the second time.
    assert.deepEqual(await pruneLibrary({ lib, doc, now: NOW, days: 60, readJson, writeJson }), { copies: 0, leftovers: 0, bytes: 0 });
    // An index that does not read touches nothing.
    await put('index.json', '{not json');
    assert.deepEqual(await pruneLibrary({ lib, doc, now: NOW + 365 * DAY, days: 60, readJson, writeJson }), { copies: 0, leftovers: 0, bytes: 0 });
    // Nor does one that reads and lists nothing: the audio beside it is not taken for nobody's.
    await put('index.json', JSON.stringify({ entries: [] }));
    assert.deepEqual(await pruneLibrary({ lib, doc, now: NOW + 365 * DAY, days: 60, readJson, writeJson }), { copies: 0, leftovers: 0, bytes: 0 });
    assert.ok((await readdir(lib)).includes(`${id(2)}.mp3`));
  } finally {
    await rm(lib, { recursive: true, force: true });
  }
});
