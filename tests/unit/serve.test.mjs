// The app's server (server/main.mjs) as it runs, on a fresh data folder: its files carry an
// ETag per packing, and a browser that asks "has it changed?" gets an empty 304 when it hasn't.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;

async function start() {
  const data = await mkdtemp(path.join(tmpdir(), 'serve-'));
  await mkdir(path.join(data, 'library'), { recursive: true });
  const port = await new Promise((resolve) => { const s = http.createServer().listen(0, () => { const { port: free } = s.address(); s.close(() => resolve(free)); }); });
  const app = spawn(process.execPath, [path.join(ROOT, 'server/main.mjs')], { env: { ...process.env, DATA_DIR: data, PORT: String(port), POD_FEEDS: '0', POD_SEED: '0', TRANSCRIBE: '' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://localhost:${port}/healthz`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  // (node:http rather than fetch: fetch would ask for packed files and unpack them itself.)
  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  return { data, get, close: async () => { app.kill(); await rm(data, { recursive: true, force: true }); } };
}

test("the app's files: an unchanged one is a 304 with no body, for each packing on its own", async () => {
  const s = await start();
  try {
    for (const enc of ['br', 'gzip', '']) {
      const first = await s.get('/style.css', enc ? { 'accept-encoding': enc } : {});
      assert.equal(first.status, 200);
      assert.equal(first.headers['content-encoding'], enc || undefined);
      assert.match(first.headers.etag, enc ? new RegExp(`^"[\\w-]+-${enc}"$`) : /^"[\w]+-[\w]+"$/);
      assert.equal(first.headers.vary, 'accept-encoding');
      const again = await s.get('/style.css', { 'accept-encoding': enc, 'if-none-match': first.headers.etag });
      assert.equal(again.status, 304);
      assert.equal(again.body.length, 0);
      assert.equal(again.headers.etag, first.headers.etag);
      assert.equal(again.headers.vary, 'accept-encoding');
      // A weak copy of the tag, as some proxies pass it on, and one tag among several.
      assert.equal((await s.get('/style.css', { 'accept-encoding': enc, 'if-none-match': `"x", W/${first.headers.etag}` })).status, 304);
    }
    // Another packing's tag is not this one's.
    const br = (await s.get('/style.css', { 'accept-encoding': 'br' })).headers.etag;
    const gz = await s.get('/style.css', { 'accept-encoding': 'gzip', 'if-none-match': br });
    assert.equal(gz.status, 200);
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.ok(gz.body.length > 0);
    const plain = await s.get('/style.css', { 'if-none-match': br });
    assert.equal(plain.status, 200);
    assert.equal(plain.headers['content-encoding'], undefined);
  } finally {
    await s.close();
  }
});

test('a file that changed is sent again, with a new tag', async () => {
  const s = await start();
  try {
    const file = path.join(s.data, 'library', 'index.json');
    const index = (n) => JSON.stringify({ entries: Array.from({ length: n }, (_, i) => ({ id: String(i).padStart(16, '0'), title: `Episode ${i}` })) });
    await writeFile(file, index(40));
    await utimes(file, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
    for (const enc of ['br', '']) {
      const first = await s.get('/library/index.json', { 'accept-encoding': enc });
      assert.equal(first.status, 200);
      assert.equal((await s.get('/library/index.json', { 'accept-encoding': enc, 'if-none-match': first.headers.etag })).status, 304);
    }
    const before = await s.get('/library/index.json', { 'accept-encoding': 'br' });
    const plainBefore = await s.get('/library/index.json');
    await writeFile(file, index(41));
    for (const [enc, was] of [['br', before], ['', plainBefore]]) {
      const after = await s.get('/library/index.json', { 'accept-encoding': enc, 'if-none-match': was.headers.etag });
      assert.equal(after.status, 200);
      assert.notEqual(after.headers.etag, was.headers.etag);
      assert.ok(after.body.length > 0);
      if (!enc) assert.equal(JSON.parse(after.body).entries.length, 41);
    }
  } finally {
    await s.close();
  }
});
