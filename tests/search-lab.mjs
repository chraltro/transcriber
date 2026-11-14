// How fast the search across transcripts is (server/search.mjs), on a library of generated
// hour-long transcripts the size of real ones: node tests/search-lab.mjs [transcripts] [half]
// It times a query with nothing filed yet (every transcript read and parsed), with the compact
// copies on disk (a restart), and with them in memory, and says what memory the process then
// holds. The timing runs in a fresh process; with `half` (Linux), that process shares one CPU
// with a busy loop, which is about the half a CPU the server has.
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSearch } from '../server/search.mjs';

const [, , arg = '100', mode = '', given = ''] = process.argv;
const N = Number(arg);
const WORDS = ('the a and of to in that it is was for on with as at by from they we you this but have not are one all would there their what so up out about who get which when make can like time just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us harbour ship crane cargo tide pilot quay dock container steel box lorry warehouse river port strike union berth fog rust ferry ledger bakery school kitchen lighthouse keeper coal policy election senate vote budget climate housing ' +
  'førde sjø båt brygge kai ærlig møte').split(' ');

let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = () => WORDS[Math.floor(rand() ** 1.6 * WORDS.length)];

function transcript(i) {
  const segments = [];
  for (let t = 0; t < 3600; t += 3.6) {
    const n = 8 + Math.floor(rand() * 10);
    const words = Array.from({ length: n }, pick);
    words[0] = words[0][0].toUpperCase() + words[0].slice(1);
    segments.push({ start: Math.round(t * 100) / 100, end: Math.round((t + 3.4) * 100) / 100, text: ` ${words.join(' ')}.`, speaker: Math.floor(rand() * 3), w: Math.floor(t / 30) * 30 });
  }
  // Real transcripts carry the waveform and more besides the text: about 400 KB of JSON in all.
  return { id: i.toString(16).padStart(16, '0'), title: `Episode ${i}`, show: 'Generated', art: '', createdAt: 1e12 + i * 1e6, total: 3600, segments, levels: 'x'.repeat(250e3) };
}

async function measure(dir, entries) {
  const queries = ['harbour', 'crane cargo', '"the ship"', 'brygge ærlig', 'submarine', 'the'];
  const make = () => createSearch({ dir, cacheDir: path.join(dir, 'search'), entries: async () => entries });
  const time = async (s, q) => { const t0 = performance.now(); const r = await s.query(q); return [performance.now() - t0, r]; };
  const mb = (n) => `${Math.round(n / 2 ** 20)} MB`;
  const before = process.memoryUsage().rss;
  let s = make();
  const [cold, r0] = await time(s, queries[0]);
  console.log(`nothing filed yet: ${cold.toFixed(0)} ms (${r0.episodes.length} episodes + ${r0.more} more)`);
  s = make();
  globalThis.gc?.();
  const [disk] = await time(s, queries[0]);
  console.log(`filed on disk, nothing in memory (a restart): ${disk.toFixed(0)} ms`);
  for (const q of queries) {
    const runs = [];
    let r;
    for (let k = 0; k < 5; k++) { let ms; [ms, r] = await time(s, q); runs.push(ms); }
    runs.sort((a, b) => a - b);
    console.log(`in memory, ${q.padEnd(14)} median ${runs[2].toFixed(1)} ms, worst ${runs[4].toFixed(1)} ms: ${r.episodes.length} episodes + ${r.more} more, ${r.episodes.reduce((n, e) => n + e.count, 0)} hits`);
  }
  globalThis.gc?.();
  const m = process.memoryUsage();
  console.log(`kept in memory: ${s.kept} transcripts, ${(s.held / 1e6).toFixed(1)} MB of searchable text; the process holds ${mb(m.rss)} (${mb(before)} at the start), ${mb(m.heapUsed)} of it in use`);
  const small = createSearch({ dir, cacheDir: path.join(dir, 'search'), entries: async () => entries, budget: 2e6 });
  await small.query('x');
  const [tight] = await time(small, 'crane cargo');
  console.log(`with 2 MB of memory for it (the rest read from disk each time): ${tight.toFixed(0)} ms`);
}

if (mode === 'measure') {
  await measure(given, JSON.parse(process.env.LAB_ENTRIES));
} else {
  const dir = await mkdtemp(path.join(tmpdir(), 'search-lab-'));
  let busy = null;
  try {
    const entries = [];
    let bytes = 0;
    for (let i = 0; i < N; i++) {
      const entry = transcript(i);
      const json = JSON.stringify(entry);
      bytes += json.length;
      await writeFile(path.join(dir, `${entry.id}.json`), json);
      entries.push({ id: entry.id, title: entry.title, show: entry.show, art: '', createdAt: entry.createdAt, total: 3600 });
    }
    await mkdir(path.join(dir, 'search'), { recursive: true });
    console.log(`${N} transcripts, ${(bytes / N / 1e3).toFixed(0)} KB of JSON each${mode === 'half' ? ', on half a CPU' : ''}`);
    const self = fileURLToPath(import.meta.url);
    const cmd = [process.execPath, '--expose-gc', self, String(N), 'measure', dir];
    if (mode === 'half') busy = spawn('taskset', ['-c', '0', process.execPath, '-e', 'for (;;) {}'], { stdio: 'ignore' });
    const child = mode === 'half' ? spawn('taskset', ['-c', '0', ...cmd], { stdio: 'inherit', env: { ...process.env, LAB_ENTRIES: JSON.stringify(entries) } })
      : spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env: { ...process.env, LAB_ENTRIES: JSON.stringify(entries) } });
    await new Promise((resolve) => child.on('exit', resolve));
  } finally {
    busy?.kill();
    await rm(dir, { recursive: true, force: true });
  }
}
