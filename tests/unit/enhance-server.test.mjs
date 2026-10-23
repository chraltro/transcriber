import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEnhance, validate } from '../../server/enhance.mjs';

async function serve(opts) {
  const dir = await mkdtemp(path.join(tmpdir(), 'enhance-'));
  const enhance = createEnhance({ dataDir: dir, authorized: async (req) => req.headers.authorization === 'Bearer ok', log: () => {}, ...opts });
  await enhance.init();
  const server = http.createServer(async (req, res) => {
    if (!(await enhance.handle(req, res, new URL(req.url, 'http://x').pathname))) { res.writeHead(404); res.end(); }
  }).listen(0);
  const base = `http://localhost:${server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, body, headers });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { call, dir: enhance.dir, close: async () => { server.close(); await rm(dir, { recursive: true, force: true }); } };
}

const job = (n) => JSON.stringify({ url: `https://example.com/${n}.mp3`, title: `Episode ${n}`, ranges: [[10, 20], [19.5, 30]] });

test('requests are checked and tidied', () => {
  assert.deepEqual(validate({ url: 'https://a.example/x.mp3', ranges: [[30, 40], [5, 10], [9.6, 12]] }).ranges, [[5, 12], [30, 40]]);
  assert.throws(() => validate({ url: 'file:///etc/passwd', ranges: [[0, 1]] }), /link/);
  assert.throws(() => validate({ url: 'https://a.example/x.mp3', ranges: [] }), /Nothing/);
  assert.throws(() => validate({ url: 'https://a.example/x.mp3', ranges: [[0, 10], [7 * 3600, 7 * 3600 + 5]] }), /six hours/);
  assert.throws(() => validate({ url: 'https://a.example/x.mp3', ranges: [[0, 81 * 60]] }), /minutes/);
  assert.equal(validate({ url: 'library/abcdef0123456789.mp3', ranges: [[0, 5]] }, { site: 'https://s.example' }).url, 'https://s.example/library/abcdef0123456789.mp3');
});

test('a job goes queued, working, done; uploads need the workflow; the newest upload is never evicted', async () => {
  const s = await serve({ maxDisk: 2500, maxUpload: 2000 });
  try {
    const a = await s.call('POST', '/api/enhance', job(1));
    assert.equal(a.status, 201);
    assert.equal(a.json.status, 'queued');
    assert.equal((await s.call('POST', '/api/enhance', job(1))).json.id, a.json.id, 'the same request is the same job');
    assert.equal((await s.call('PUT', `/api/enhance/${a.json.id}.json`, '{"status":"working"}')).status, 401, 'no token, no update');
    const ok = { authorization: 'Bearer ok' };
    assert.equal((await s.call('PUT', `/api/enhance/${a.json.id}.json`, '{"status":"done"}', ok)).status, 400, 'done needs the audio');
    assert.equal((await s.call('PUT', `/api/enhance/${a.json.id}.mp3`, Buffer.alloc(3000), ok)).status, 400, 'too big');
    assert.equal((await s.call('PUT', `/api/enhance/${a.json.id}.mp3`, Buffer.alloc(1500), ok)).status, 200);
    assert.equal((await s.call('PUT', `/api/enhance/${a.json.id}.json`, '{"status":"done"}', ok)).status, 200);
    // A second result pushes the disk over budget: the older finished one goes, not the new one.
    const b = await s.call('POST', '/api/enhance', job(2));
    assert.equal((await s.call('PUT', `/api/enhance/${b.json.id}.mp3`, Buffer.alloc(1500), ok)).status, 200);
    assert.equal((await s.call('PUT', `/api/enhance/${b.json.id}.json`, '{"status":"done"}', ok)).status, 200, 'the new upload survived');
    assert.equal((await s.call('GET', `/api/enhance/${a.json.id}`)).json.status, 'failed', 'the older one made room');
    const files = await readdir(s.dir);
    assert.ok(files.includes(`${b.json.id}.mp3`) && !files.includes(`${a.json.id}.mp3`));
    // The queue holds three.
    for (const n of [3, 4, 5]) await s.call('POST', '/api/enhance', job(n));
    assert.equal((await s.call('POST', '/api/enhance', job(6))).status, 429);
  } finally {
    await s.close();
  }
});

test('with a key, only callers that have it can queue', async () => {
  const s = await serve({ key: 'secret' });
  try {
    const no = await s.call('POST', '/api/enhance', job(1));
    assert.equal(no.status, 401);
    assert.equal(no.json.needsKey, true);
    assert.equal((await s.call('POST', '/api/enhance', job(1), { 'x-enhance-key': 'secret' })).status, 201);
    assert.equal((await s.call('GET', '/api/enhance/queue')).json.needsKey, true);
  } finally {
    await s.close();
  }
});
