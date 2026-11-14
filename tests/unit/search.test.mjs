import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fold, clean, parseQuery, docOf, match, createSearch, MAX_EPISODES, MAX_HITS } from '../../server/search.mjs';

const seg = (start, text) => ({ start, end: start + 5, text, speaker: 0, w: 0 });
const find = (lines, q) => match(docOf(lines, lines.map((_, i) => i * 5)), parseQuery(q));
const marked = (text, marks) => marks.map(([a, b]) => text.slice(a, b));

test('folding: case and accents go, æ, ø and å stay, and every character keeps its place', () => {
  assert.equal(fold('Café CRÈME naïve Ångström'), 'cafe creme naive ångstrom');
  assert.equal(fold('Ærø, Øresund, BÅT'), 'ærø, øresund, båt');
  assert.equal(fold('don’t “quote” here\nnow'), 'don\'t "quote" here now');
  for (const s of ['İstanbul ﬁne', 'é straße', 'Ünïcödé 😀 x']) assert.equal(fold(s).length, s.length, s);
  assert.equal(clean('  two\n spaces\t here '), 'two spaces here');
  assert.equal(clean('é'), 'é');
});

test('queries: words find the start of words, quoted phrases only themselves', () => {
  assert.deepEqual(parseQuery('Box  "Steel box" tidewater.example ""').map((t) => t.text), ['box', 'steel box', 'tidewater example']);
  assert.deepEqual(parseQuery('box BOX').length, 1);
  assert.equal(parseQuery('   ').length, 0);
  assert.equal(parseQuery('a b c d e f g h i j').length, 8, 'at most eight terms');
  const lines = ['The boxes came off the ship.', 'An inbox is not a box.', 'For the café in Bodø.', 'Før det var det fint.'];
  assert.deepEqual(find(lines, 'box').hits.map((h) => h.from), [0, 1], 'boxes, and box, not inbox');
  assert.deepEqual(marked(fold(lines[1]), find(lines, 'box').hits[1].marks), ['box'], 'the whole word is marked, not inbox');
  assert.deepEqual(marked(lines[0], find(lines, 'box').hits[0].marks), ['boxes']);
  assert.deepEqual(find(lines, 'CAFE bodo'), null, 'ø is not o');
  assert.deepEqual(find(lines, 'café bodø').hits.map((h) => h.from), [2]);
  assert.deepEqual(find(lines, 'cafe').hits.map((h) => h.from), [2], 'accents don\'t count');
  assert.deepEqual(find(lines, 'for').hits.map((h) => h.from), [2], '"for" is not "før"');
  assert.deepEqual(find(lines, 'før').hits.map((h) => h.from), [3]);
  assert.equal(find(lines, '"box"').count, 1, 'a quoted word only itself');
  assert.equal(find(lines, 'an').count, 1, 'a short word only itself, not "and" or "ang"');
  assert.equal(find(lines, '"came off the"').count, 1);
  assert.equal(find(lines, '"came the"'), null, 'a phrase is its words in order, together');
  assert.equal(find(['Not a box, said she.'], '"box said"').count, 1, 'a phrase reads over a comma');
});

test('a hit is one segment, or two or three neighbours that together hold every term', () => {
  const lines = [
    'Tidewater has covered cargo since 1890.', // 0
    'Nothing here.', // 1
    'The crane driver', // 2
    'did the work', // 3
    'of a whole gang.', // 4
    'Cranes again, no gangs.', // 5 (gangs: "gang" is a word start)
    'Crane', '.', '.', 'gang', // 6-9: four apart, too far
  ];
  const got = find(lines, 'crane gang');
  assert.deepEqual(got.hits.map((h) => [h.from, h.to]), [[2, 4], [5, 5]]);
  assert.equal(got.count, 2);
  const text = lines.slice(2, 5).join(' ');
  assert.deepEqual(marked(text, got.hits[0].marks), ['crane', 'gang'], 'marks are places in the joined text');
  // A phrase that runs on from one segment into the next.
  assert.deepEqual(find(lines, '"driver did"').hits.map((h) => [h.from, h.to]), [[2, 3]]);
  // A segment that alone holds every term beats a run that starts earlier.
  assert.deepEqual(find(['cargo', 'cargo and tide', 'x'], 'cargo tide').hits.map((h) => [h.from, h.to]), [[1, 1]]);
});

test('at most five hits an episode: the tightest, in the order they are said', () => {
  const lines = [];
  for (let i = 0; i < 12; i++) lines.push(i % 3 === 0 ? 'ship and port' : 'ship', i % 3 === 0 ? 'x' : 'port');
  const got = find(lines, 'ship port');
  assert.ok(got.count > MAX_HITS);
  assert.equal(got.hits.length, MAX_HITS);
  const spans = got.hits.map((h) => h.to - h.from);
  assert.deepEqual(spans.sort(), [0, 0, 0, 0, 1], 'single sentences first');
  assert.deepEqual(got.hits.map((h) => h.from), [...got.hits.map((h) => h.from)].sort((a, b) => a - b));
});

// A library on disk, as server/main.mjs keeps it.
async function library(n, text = (i) => [`Episode ${i} is about harbours.`, i % 2 ? 'The pilot boards at night.' : 'Nothing at night.']) {
  const dir = await mkdtemp(path.join(tmpdir(), 'search-'));
  const entries = [];
  for (let i = 0; i < n; i++) {
    const id = i.toString(16).padStart(16, '0');
    const meta = { id, title: `Episode ${i}`, show: 'Harbour Hours', art: 'a.svg', createdAt: 1000 + i, total: 3600, audio: `library/${id}.mp3` };
    entries.push(meta);
    await writeFile(path.join(dir, `${id}.json`), JSON.stringify({ ...meta, source: { url: `https://x.example/${i}.mp3` }, segments: text(i).map((t, k) => seg(k * 10 + 0.5, t)) }));
  }
  const s = createSearch({ dir, cacheDir: path.join(dir, 'search'), entries: async () => entries });
  return { dir, entries, s, close: () => rm(dir, { recursive: true, force: true }) };
}

test('the answer: newest first, capped, and how many more there were', async () => {
  const lib = await library(MAX_EPISODES * 2 + 6);
  try {
    const got = await lib.s.query('"pilot boards" night');
    const all = lib.entries.filter((_, i) => i % 2).length;
    assert.equal(got.episodes.length, MAX_EPISODES);
    assert.equal(got.more, all - MAX_EPISODES);
    assert.deepEqual(got.episodes.map((e) => e.createdAt), [...got.episodes.map((e) => e.createdAt)].sort((a, b) => b - a));
    const first = got.episodes[0];
    assert.deepEqual(Object.keys(first).sort(), ['art', 'count', 'createdAt', 'duration', 'hits', 'id', 'show', 'title', 'url'].sort());
    assert.equal(first.title, 'Episode 65');
    assert.deepEqual(first.hits, [{ start: 10.5, text: 'The pilot boards at night.', marks: [[4, 16], [20, 25]] }]);
    assert.equal(first.url, 'https://x.example/65.mp3');
    assert.deepEqual((await lib.s.query('')).episodes, []);
    assert.deepEqual((await lib.s.query('submarine')).episodes, []);
  } finally { await lib.close(); }
});

test('the searchable form is filed once, kept up to date, and bounded in memory', async () => {
  const lib = await library(6);
  try {
    assert.equal((await lib.s.query('pilot')).episodes.length, 3);
    const files = (await readdir(path.join(lib.dir, 'search'))).sort();
    assert.equal(files.length, 6, 'a compact copy of each transcript');
    // Changed: an upload tells it.
    const id = lib.entries[0].id;
    const changed = { ...lib.entries[0], segments: [seg(0, 'Now the pilot is here too.')] };
    await writeFile(path.join(lib.dir, `${id}.json`), JSON.stringify(changed));
    await lib.s.put(changed);
    assert.equal((await lib.s.query('pilot')).episodes.length, 4);
    // Changed behind its back (another process, or while the server was down): noticed by the file's size and time.
    const fresh = createSearch({ dir: lib.dir, cacheDir: path.join(lib.dir, 'search'), entries: async () => lib.entries });
    await writeFile(path.join(lib.dir, `${id}.json`), JSON.stringify({ ...changed, segments: [seg(0, 'No one at all.')] }));
    await utimes(path.join(lib.dir, `${id}.json`), new Date(), new Date(Date.now() + 5000));
    assert.equal((await fresh.query('pilot')).episodes.length, 3);
    // In memory, and changed: the answer still comes from what is there now.
    await writeFile(path.join(lib.dir, `${id}.json`), JSON.stringify({ ...changed, segments: [seg(0, 'No pilot.')] }));
    await utimes(path.join(lib.dir, `${id}.json`), new Date(), new Date(Date.now() + 9000));
    const again = await fresh.query('pilot');
    assert.ok(again.episodes.every((e) => e.hits.every((h) => /pilot/i.test(h.text))));
    // Removed from the library: its copy goes.
    lib.entries.splice(5, 1);
    await lib.s.query('pilot');
    assert.equal((await readdir(path.join(lib.dir, 'search'))).length, 5);
    // A tiny budget keeps one in memory and still answers from the files.
    const small = createSearch({ dir: lib.dir, cacheDir: path.join(lib.dir, 'search'), entries: async () => lib.entries, budget: 1 });
    assert.equal((await small.query('harbours')).episodes.length, 4, 'the first one was rewritten without harbours');
    assert.equal(small.kept, 1);
    assert.ok(lib.s.held > 0 && lib.s.kept === 5);
  } finally { await lib.close(); }
});
