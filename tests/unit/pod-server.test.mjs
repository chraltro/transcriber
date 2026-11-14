import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createPod, isPrivateHost, isPrivateAddress } from '../../server/pod.mjs';
import { subId } from '../../lib/podstate.js';
import { idOf } from '../../server/shows.mjs';

const KEY = 'k'.repeat(24);
const item = (n, date, notes = '') => `<item><title>Episode ${n}</title><guid>g${n}</guid><pubDate>${new Date(date).toUTCString()}</pubDate>
<enclosure url="https://cdn.example/${n}.mp3" type="audio/mpeg"/><itunes:duration>${n}:00</itunes:duration><description><![CDATA[${notes || `<p>Notes for ${n}</p>`}]]></description></item>`;
const feedXml = (title, items) => `<rss><channel><title>${title}</title><language>en-us</language><itunes:image href="https://img.example/${title}.jpg"/>${items.join('')}</channel></rss>`;

// A server with two feeds on the web: one answers conditional requests, one can be broken.
async function serve(opts = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pod-'));
  const web = { hits: {}, broken: false, clock: Date.UTC(2026, 10, 10) };
  const feeds = {
    'https://feeds.example/a': () => feedXml('Alpha', [item(1, web.clock - 3 * 864e5), item(2, web.clock - 864e5), ...(web.extra ? [item(3, web.clock)] : [])]),
    'https://feeds.example/b': () => feedXml('Beta', [item(7, web.clock - 2 * 864e5, '<p>Long <a href="https://x.example">notes</a></p>'), item(8, web.clock - 100 * 864e5), item(9, web.clock - 101 * 864e5), item(10, web.clock - 102 * 864e5), item(11, web.clock - 103 * 864e5)]),
    // Chapters: in a file of their own (good, on a private host, too large, not JSON), and in the feed.
    'https://feeds.example/c': () => feedXml('Gamma', [
      ...[20, 21, 22].map((n) => item(n, web.clock - n * 3600e3).replace('</item>', `<podcast:chapters url="${chapterFiles[n]}" type="application/json+chapters"/></item>`)),
      item(23, web.clock - 23 * 3600e3).replace('</item>', `<podcast:chapters url="${chapterFiles[23]}" type="application/json+chapters"/><psc:chapters><psc:chapter start="00:00:00.000" title="Hello"/><psc:chapter start="00:05:30.000" title="From the feed"/></psc:chapters></item>`),
    ]),
  };
  const chapterFiles = { 20: 'https://chapters.example/20.json', 21: 'https://inside.example/21.json', 22: 'https://chapters.example/22.json', 23: 'https://chapters.example/23.json' };
  const fetchImpl = async (url, init = {}) => {
    web.hits[url] = (web.hits[url] || 0) + 1;
    if (url === 'https://cdn.example/hop') return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    if (url.startsWith('https://cdn.example/')) {
      const bytes = Buffer.from('0123456789');
      const range = init.headers?.range?.match(/bytes=(\d+)-(\d*)/);
      if (range) {
        const part = bytes.subarray(Number(range[1]), range[2] ? Number(range[2]) + 1 : undefined);
        return new Response(init.method === 'HEAD' ? null : part, { status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': `bytes ${range[1]}-${Number(range[1]) + part.length - 1}/10`, 'content-length': String(part.length) } });
      }
      return new Response(bytes, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': '10' } });
    }
    if (url === chapterFiles[20]) return new Response(JSON.stringify({ version: '1.2.0', chapters: [{ startTime: 0, title: 'Intro' }, { startTime: 95.5, title: 'The news' }, { startTime: 200, img: 'x.jpg', toc: false }, { startTime: 610, title: 'Mail' }] }), { headers: { 'content-type': 'application/json+chapters' } });
    if (url === chapterFiles[21]) return new Response('{"chapters":[]}');
    if (url === chapterFiles[22]) return new Response(JSON.stringify({ chapters: Array.from({ length: 6000 }, (_, i) => ({ startTime: i, title: `Chapter number ${i} of very many` })) }));
    if (url === chapterFiles[23]) return new Response('<html>Not found</html>', { headers: { 'content-type': 'text/html' } });
    if (web.broken || !feeds[url]) return new Response('nope', { status: 500 });
    const body = feeds[url]();
    const etag = `"${body.length}"`;
    if (init.headers?.['if-none-match'] === etag) return new Response(null, { status: 304 });
    return new Response(body, { status: 200, headers: { etag } });
  };
  const pod = createPod({
    dataDir: dir, log: () => {}, fetchImpl, now: () => web.clock, findFeed: async (s) => `https://feeds.example/${s.appleId}`,
    workflow: async (req) => req.headers.authorization === 'Bearer the-workflow',
    lookup: async (host) => (host === 'inside.example' ? ['10.0.0.7'] : ['93.184.216.34']),
    ...opts,
  });
  await pod.init();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try { if (!(await pod.handle(req, res, url.pathname, url))) { res.writeHead(404); res.end(); } } catch (err) { res.writeHead(500); res.end(err.message); }
  }).listen(0);
  const base = `http://localhost:${server.address().port}`;
  const call = async (method, p, body, headers = { authorization: `Bearer ${KEY}` }) => {
    const res = await fetch(base + p, { method, body: body == null ? undefined : JSON.stringify(body), headers });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };
  return { pod, call, web, dir, base, close: async () => { server.close(); await pod.flush(); await rm(dir, { recursive: true, force: true }); } };
}

const A = subId('https://feeds.example/a');
const B = subId('https://feeds.example/b');
const sub = (feedUrl, title, at) => ({ id: subId(feedUrl), feedUrl, title, addedAt: at, at });

test('the first device claims the library; others need its key', async () => {
  const s = await serve();
  try {
    const none = {};
    assert.deepEqual((await s.call('GET', '/api/pod/status', null, none)).json, { claimed: false, linked: false });
    assert.equal((await s.call('POST', '/api/pod/sync', {}, none)).status, 401);
    assert.equal((await s.call('POST', '/api/pod/claim', { key: 'short' }, none)).status, 400);
    const claim = await s.call('POST', '/api/pod/claim', { key: KEY }, none);
    assert.equal(claim.status, 200);
    const cookie = claim.headers.get('set-cookie');
    assert.match(cookie, /^pod_key=k+; Path=\/; Max-Age=315360000; HttpOnly; SameSite=Lax$/);
    assert.equal((await s.call('POST', '/api/pod/claim', { key: 'x'.repeat(24) }, none)).status, 409, 'only once');
    assert.equal((await s.call('POST', '/api/pod/link', { key: 'x'.repeat(24) }, none)).status, 401);
    assert.equal((await s.call('POST', '/api/pod/link', { key: KEY }, none)).status, 200);
    assert.deepEqual((await s.call('GET', '/api/pod/status')).json, { claimed: true, linked: true });
    assert.deepEqual((await s.call('GET', '/api/pod/status', null, { authorization: 'Bearer wrong-key-wrong-key-wrong' })).json, { claimed: true, linked: false });
    // A device that only has the cookie (a web app added to the home screen) can ask for the key.
    assert.deepEqual((await s.call('GET', '/api/pod/key', null, { cookie: 'pod_key=' + KEY })).json, { key: KEY });
    assert.equal((await s.call('GET', '/api/pod/inbox', null, { cookie: 'other=1; pod_key=nope' })).status, 401);
    // The cookie gets a device its key and nothing else: a request another site starts carries it too.
    assert.equal((await s.call('GET', '/api/pod/inbox', null, { cookie: 'pod_key=' + KEY })).status, 401);
    assert.equal((await s.call('GET', `/api/pod/audio?u=${encodeURIComponent('https://cdn.example/1.mp3')}`, null, { cookie: 'pod_key=' + KEY })).status, 401);
    assert.deepEqual((await s.call('GET', '/api/pod/status', null, { cookie: 'pod_key=' + KEY })).json, { claimed: true, linked: true });
    assert.match((await s.call('POST', '/api/pod/unlink', null, none)).headers.get('set-cookie'), /Max-Age=0/);
    for (let i = 0; i < 20; i++) await s.call('POST', '/api/pod/link', { key: `wrong-${i}-wrong-wrong-wrong` }, none);
    assert.equal((await s.call('POST', '/api/pod/link', { key: KEY }, none)).status, 429, 'guessing is slowed down');
  } finally { await s.close(); }
});

test('a key set on the server cannot be claimed away', async () => {
  const s = await serve({ key: KEY });
  try {
    assert.deepEqual((await s.call('GET', '/api/pod/status', null, {})).json, { claimed: true, linked: false });
    assert.equal((await s.call('POST', '/api/pod/claim', { key: 'x'.repeat(24) }, {})).status, 409);
    assert.equal((await s.call('GET', '/api/pod/inbox')).status, 200);
  } finally { await s.close(); }
});

test('two devices stay in step, each getting only what it has not seen', async () => {
  const s = await serve({ key: KEY });
  try {
    const first = await s.call('POST', '/api/pod/sync', { changes: { subs: { [A]: sub('https://feeds.example/a', 'Alpha', 100) }, progress: { ep1: { p: 60, d: 600, at: 100 } }, queue: { ids: ['ep1'], at: 100 } } });
    assert.equal(first.status, 200);
    const { epoch, rev } = first.json;
    assert.ok(epoch && rev === 3);
    // (The server reads the new show's feed and fills in its art: one more change, settled here
    // so the counts below don't depend on when it lands.)
    await s.pod.refreshAll();
    // The other device knows nothing yet: it gets everything.
    const other = await s.call('POST', '/api/pod/sync', { since: 0, changes: {} });
    assert.deepEqual(Object.keys(other.json.changes.subs), [A]);
    assert.equal(other.json.changes.progress.ep1.p, 60);
    // It plays on; an older edit from the first device loses, a newer one wins.
    const played = await s.call('POST', '/api/pod/sync', { epoch, since: other.json.rev, changes: { progress: { ep1: { p: 300, d: 600, at: 500 } } } });
    assert.equal(played.json.rev, other.json.rev + 1);
    const stale = await s.call('POST', '/api/pod/sync', { epoch, since: rev, changes: { progress: { ep1: { p: 90, d: 600, at: 200 } }, settings: { speed: 1.5, at: 300 } } });
    assert.equal(stale.json.changes.progress.ep1.p, 300, 'it is told the newer position');
    assert.equal(stale.json.changes.settings.speed, 1.5);
    assert.equal(stale.json.changes.subs[A].art, 'https://img.example/Alpha.jpg', 'and of the art the server found');
    const quiet = await s.call('POST', '/api/pod/sync', { epoch, since: stale.json.rev, changes: {} });
    assert.deepEqual(quiet.json.changes, {});
    // A device that last talked to another copy of the server gets everything again.
    const moved = await s.call('POST', '/api/pod/sync', { epoch: 'older', since: 999, changes: {} });
    assert.equal(moved.json.changes.progress.ep1.p, 300);
    assert.ok(moved.json.changes.subs[A]);
    assert.equal((await s.call('POST', '/api/pod/sync', '{not json')).status, 200, 'a string body is just no changes');
    // A record has to be filed under its own id, and a show under the id of its feed: the id
    // names files on the server.
    await s.call('POST', '/api/pod/sync', { changes: { subs: { abc: { id: '../../escaped', feedUrl: 'https://feeds.example/b', title: 'x', at: 9e12 }, abcdef012345: { id: 'abcdef012345', feedUrl: 'https://feeds.example/b', title: 'y', at: 9e12 } } } });
    await s.pod.refreshAll();
    assert.equal(s.pod.doc.subs.abc, undefined);
    assert.deepEqual((await readdir(s.dir)).sort(), ['pod'], 'nothing written outside its folder');
    assert.deepEqual((await readdir(path.join(s.dir, 'pod', 'feeds'))).filter((f) => !f.startsWith(A)), [], 'and nothing for a show whose id is not its feed\'s');
  } finally { await s.close(); }
});

test('followed shows are read on the server: inbox, one show, notes, and again only when changed', async () => {
  const s = await serve({ key: KEY });
  try {
    await s.call('POST', '/api/pod/sync', { changes: { subs: { [A]: sub('https://feeds.example/a', '', 100), [B]: sub('https://feeds.example/b', 'Beta', 100) } } });
    const feed = await s.call('GET', `/api/pod/feed/${A}`);
    assert.equal(feed.status, 200);
    assert.equal(feed.json.title, 'Alpha');
    assert.equal(feed.json.lang, 'english');
    assert.deepEqual(feed.json.episodes.map((e) => e.title), ['Episode 2', 'Episode 1']);
    assert.equal(feed.json.episodes[0].id, idOf('g2'));
    assert.equal(feed.json.episodes[0].duration, 120);
    assert.equal(feed.json.episodes[0].html, undefined, 'notes are fetched one at a time');
    assert.equal(feed.json.etag, undefined);
    assert.equal((await s.call('GET', `/api/pod/feed/${A}?limit=1`)).json.episodes.length, 1);
    assert.equal((await s.call('GET', `/api/pod/feed/${A}?limit=1`)).json.total, 2);
    await s.pod.refreshAll();
    assert.equal(s.pod.doc.subs[A].title, 'Alpha', 'a show followed by address gets its name from the feed');
    assert.equal(s.pod.doc.subs[A].art, 'https://img.example/Alpha.jpg');

    const inbox = await s.call('GET', '/api/pod/inbox');
    assert.deepEqual(inbox.json.episodes.map((e) => e.title), ['Episode 2', 'Episode 7', 'Episode 1', 'Episode 8', 'Episode 9'], 'the last 45 days, and at least three of each show');
    assert.equal(inbox.json.episodes[0].sub, A);
    const notes = await s.call('GET', `/api/pod/notes/${B}/${idOf('g7')}`);
    assert.equal(notes.json.html, '<p>Long <a href="https://x.example">notes</a></p>');
    assert.equal((await s.call('GET', `/api/pod/notes/${B}/${idOf('nope')}`)).json.html, '');

    // Nothing new: the feed answers "not modified" and the copy is kept. Then a new episode.
    await s.pod.refreshAll();
    assert.equal((await s.call('GET', `/api/pod/feed/${A}`)).json.episodes.length, 2);
    s.web.extra = true;
    assert.equal((await s.call('GET', '/api/pod/inbox?fresh=1')).json.episodes[0].title, 'Episode 2', 'read a moment ago: not read again');
    s.web.clock += 3600e3;
    assert.equal((await s.call('GET', '/api/pod/inbox?fresh=1')).json.episodes[0].title, 'Episode 3', 'asked for what is new, the server reads the feeds');
    assert.equal((await s.call('GET', `/api/pod/feed/${A}?fresh=1`)).json.episodes[0].title, 'Episode 3');
    // A feed that stops answering keeps what was read last.
    s.web.broken = true;
    await s.pod.refreshAll();
    const kept = await s.call('GET', `/api/pod/feed/${A}`);
    assert.equal(kept.json.episodes.length, 3);
    assert.match(kept.json.failed, /HTTP 500/);
    s.web.broken = false;

    // Unfollowing drops the show from the inbox and, at the next round, its files.
    await s.call('POST', '/api/pod/sync', { changes: { subs: { [B]: { id: B, feedUrl: 'https://feeds.example/b', title: 'Beta', gone: true, at: s.web.clock } } } });
    assert.ok((await s.call('GET', '/api/pod/inbox')).json.episodes.every((e) => e.sub === A));
    assert.equal((await s.call('GET', `/api/pod/feed/${B}`)).status, 404);
    await s.pod.refreshAll();
    assert.deepEqual((await readdir(path.join(s.dir, 'pod', 'feeds'))).filter((f) => f.startsWith(B)), []);
    assert.equal((await s.call('GET', '/api/pod/feed/../../auth')).status, 404);
  } finally { await s.close(); }
});

test("an episode's chapters come with its notes: its chapters file read once and kept, else the feed's own", async () => {
  const s = await serve({ key: KEY });
  try {
    const C = subId('https://feeds.example/c');
    await s.call('POST', '/api/pod/sync', { changes: { subs: { [C]: sub('https://feeds.example/c', 'Gamma', 100) } } });
    const feed = await s.call('GET', `/api/pod/feed/${C}`);
    assert.equal(feed.json.episodes.find((e) => e.id === idOf('g20')).chapters, 'https://chapters.example/20.json');
    assert.equal(feed.json.episodes[0].psc, undefined, 'chapters themselves are not in the list of episodes');
    const notes = (n) => s.call('GET', `/api/pod/notes/${C}/${idOf(`g${n}`)}`);
    const want = [{ start: 0, title: 'Intro' }, { start: 95.5, title: 'The news' }, { start: 610, title: 'Mail' }];
    const first = await notes(20);
    assert.equal(first.json.html, '<p>Notes for 20</p>');
    assert.deepEqual(first.json.chapters, want);
    assert.deepEqual((await notes(20)).json.chapters, want);
    assert.equal(s.web.hits['https://chapters.example/20.json'], 1, 'read once');
    assert.ok((await readdir(path.join(s.dir, 'pod', 'feeds'))).includes(`${C}.chapters.json`), 'and kept');
    // Asked for twice at once, it is still read once.
    s.web.clock += 7 * 3600e3;
    await Promise.all([notes(23), notes(23)]);
    assert.equal(s.web.hits['https://chapters.example/23.json'], 1);
    // A host inside this network is never asked; a file too large or not JSON gives nothing.
    assert.deepEqual((await notes(21)).json.chapters, []);
    assert.equal(s.web.hits['https://inside.example/21.json'], undefined, 'never fetched');
    assert.deepEqual((await notes(22)).json.chapters, []);
    const kept = JSON.parse(await readFile(path.join(s.dir, 'pod', 'feeds', `${C}.chapters.json`), 'utf8'));
    assert.deepEqual([21, 22, 23].map((n) => kept[idOf(`g${n}`)].failed), ['Not a public host', 'Chapters file too large', 'Chapters file is not JSON']);
    // ...and the chapters written into the feed stand in.
    assert.deepEqual((await notes(23)).json.chapters, [{ start: 0, title: 'Hello' }, { start: 330, title: 'From the feed' }]);
    assert.equal(s.web.hits['https://chapters.example/23.json'], 1, 'a file that could not be read is not asked for again at once');
    s.web.clock += 7 * 3600e3;
    await notes(23);
    assert.equal(s.web.hits['https://chapters.example/23.json'], 2, 'but some hours later');
    // Notes kept before chapters were (only the HTML), and an episode with none, still answer.
    assert.deepEqual((await s.call('GET', `/api/pod/notes/${C}/${idOf('nope')}`)).json, { html: '', chapters: [] });
  } finally { await s.close(); }
});

test('a feed from anywhere can be looked at before it is followed', async () => {
  const s = await serve({ key: KEY });
  try {
    const got = await s.call('GET', `/api/pod/resolve?url=${encodeURIComponent('https://feeds.example/b')}`);
    assert.equal(got.json.title, 'Beta');
    assert.equal(got.json.id, B);
    assert.equal(got.json.episodes.length, 5);
    assert.equal((await s.call('GET', '/api/pod/resolve?url=file:///etc/passwd')).status, 400);
    assert.equal((await s.call('GET', `/api/pod/resolve?url=${encodeURIComponent('http://127.0.0.1:3000/x')}`)).status, 400);
    assert.equal((await s.call('GET', `/api/pod/resolve?url=${encodeURIComponent('https://feeds.example/missing')}`)).status, 502);
    assert.equal((await s.call('GET', `/api/pod/resolve?url=${encodeURIComponent('https://feeds.example/b')}`, null, {})).status, 401);
    for (const h of ['192.168.1.5', '172.20.0.1', 'localhost', 'localhost.', '[::ffff:7f00:1]', '[::]', 'intranet', 'db.internal', '2130706433']) assert.equal(isPrivateHost(h), true, h);
    assert.equal(isPrivateHost('feeds.megaphone.fm'), false);
    for (const a of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fd00::1', 'fe80::1', '100.64.0.1']) assert.equal(isPrivateAddress(a), true, a);
    for (const a of ['93.184.216.34', '2606:2800:220:1::1', '172.32.0.1']) assert.equal(isPrivateAddress(a), false, a);
  } finally { await s.close(); }
});

test('audio is passed through with byte ranges, for the key holder only', async () => {
  const s = await serve({ key: KEY });
  try {
    const u = encodeURIComponent('https://cdn.example/1.mp3');
    const whole = await fetch(`${s.base}/api/pod/audio?u=${u}`, { headers: { authorization: `Bearer ${KEY}` } });
    assert.equal(whole.status, 200);
    assert.equal(await whole.text(), '0123456789');
    const part = await fetch(`${s.base}/api/pod/audio?u=${u}`, { headers: { authorization: `Bearer ${KEY}`, range: 'bytes=2-5' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await part.text(), '2345');
    assert.equal((await fetch(`${s.base}/api/pod/audio?u=${u}`)).status, 401);
    assert.equal((await s.call('GET', `/api/pod/audio?u=${encodeURIComponent('http://localhost/x.mp3')}`)).status, 400);
    // A public address that sends the request on into this network, or a name that stands for
    // an address in it, is refused.
    assert.equal((await s.call('GET', `/api/pod/audio?u=${encodeURIComponent('https://cdn.example/hop')}`)).status, 502);
    assert.equal((await s.call('GET', `/api/pod/audio?u=${encodeURIComponent('https://inside.example/x.mp3')}`)).status, 502);
    assert.equal(s.web.hits['https://inside.example/x.mp3'], undefined, 'never fetched');
  } finally { await s.close(); }
});

test('the built-in shows are followed from the start and listed for the transcribing', async () => {
  const s = await serve({ key: KEY, seeds: [{ name: 'Alpha Show', appleId: 'a' }, { name: 'Beta Show', appleId: 'b' }] });
  try {
    const ci = { authorization: 'Bearer the-workflow' };
    assert.equal((await s.call('GET', '/api/pod/transcribe', null, {})).status, 401, 'what is listened to is not for everyone');
    assert.equal((await s.call('GET', '/api/pod/transcribe', null, ci)).json.ready, false);
    await s.pod.refreshAll();
    const list = await s.call('GET', '/api/pod/transcribe', null, ci);
    assert.equal(list.json.ready, true);
    assert.deepEqual(list.json.shows.map((x) => x.feedUrl).sort(), ['https://feeds.example/a', 'https://feeds.example/b']);
    assert.equal(list.json.shows[0].lang, 'english');
    // Switched off in the app, a show is no longer transcribed, and it is not followed again.
    const cur = s.pod.doc.subs[A];
    await s.call('POST', '/api/pod/sync', { changes: { subs: { [A]: { ...cur, transcribe: false, backfill: 0, at: s.web.clock + 1000 } }, wants: { [idOf('g7')]: { id: idOf('g7'), feedUrl: 'https://feeds.example/b', title: 'Episode 7', at: s.web.clock }, [idOf('g8')]: { id: idOf('g8'), feedUrl: 'https://feeds.example/b', title: 'Episode 8', gone: true, at: s.web.clock } } } });
    await s.pod.refreshAll();
    const after = (await s.call('GET', '/api/pod/transcribe')).json;
    assert.deepEqual(after.shows.map((x) => x.feedUrl), ['https://feeds.example/b']);
    assert.deepEqual(after.shows[0], { name: 'Beta Show', feedUrl: 'https://feeds.example/b', lang: 'english', fresh: true, backfill: 0 });
    assert.deepEqual(after.episodes, [{ id: idOf('g7'), feedUrl: 'https://feeds.example/b', title: 'Episode 7' }], 'an episode asked for, not the one withdrawn');
    // Large answers are compressed for those who ask.
    const res = await fetch(`${s.base}/api/pod/feed/${B}`, { headers: { authorization: `Bearer ${KEY}`, 'accept-encoding': 'identity' } });
    assert.equal(res.headers.get('content-encoding'), null);
    const raw = await new Promise((resolve) => {
      http.get(`${s.base}/api/pod/feed/${B}`, { headers: { authorization: `Bearer ${KEY}`, 'accept-encoding': 'gzip' } }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ enc: r.headers['content-encoding'], body: Buffer.concat(chunks) }));
      });
    });
    assert.equal(raw.enc, 'gzip');
    assert.equal(JSON.parse(gunzipSync(raw.body)).title, 'Beta');
  } finally { await s.close(); }
});
