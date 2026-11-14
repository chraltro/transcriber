import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt, makeKeys, vapidHeader, readVapid, cleanSubscription, newEpisodes, pushService } from '../../server/push.mjs';
import { createPod } from '../../server/pod.mjs';
import { subId } from '../../lib/podstate.js';
import { idOf } from '../../server/shows.mjs';

// RFC 8291, section 5 and appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

// A browser's side of a subscription: its key pair and secret.
const device = (endpoint) => {
  const k = makeKeys();
  const auth = randomBytes(16).toString('base64url');
  return { sub: { endpoint, keys: { p256dh: k.publicKey, auth } }, secret: { ...k, auth } };
};

test("RFC 8291's worked example, byte for byte", () => {
  const body = encrypt(RFC.plaintext, { keys: { p256dh: RFC.uaPublic, auth: RFC.auth } }, { salt: Buffer.from(RFC.salt, 'base64url'), localKeys: { privateKey: RFC.asPrivate } });
  assert.equal(body.toString('base64url'), RFC.body);
  assert.equal(decrypt(Buffer.from(RFC.body, 'base64url'), { privateKey: RFC.uaPrivate, publicKey: RFC.uaPublic, auth: RFC.auth }), RFC.plaintext);
});

test('a message encrypted for a subscription decrypts with its keys, and only with them', () => {
  const { sub, secret } = device('https://web.push.apple.com/x');
  const text = JSON.stringify({ title: 'Ø and ü', body: 'x'.repeat(2000) });
  const a = encrypt(text, sub);
  const b = encrypt(text, sub);
  assert.notDeepEqual(a, b, 'a fresh salt and key each time');
  assert.equal(decrypt(a, secret), text);
  assert.equal(a.readUInt32BE(16), 4096);
  assert.throws(() => decrypt(a, { ...secret, auth: randomBytes(16).toString('base64url') }));
  assert.throws(() => encrypt('x'.repeat(4000), sub), /too long/);
});

test('the VAPID token verifies and names the service, the expiry and who sends', () => {
  const keys = makeKeys();
  const at = Date.UTC(2026, 10, 10);
  const header = vapidHeader('https://fcm.googleapis.com/fcm/send/abc', keys, 'https://site.example', at);
  assert.match(header, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${keys.publicKey}$`));
  assert.deepEqual(readVapid(header, keys.publicKey), { aud: 'https://fcm.googleapis.com', exp: at / 1000 + 12 * 3600, sub: 'https://site.example' });
  assert.equal(readVapid(header, makeKeys().publicKey), null, 'not with another key');
  const forged = header.replace(/\.([\w-]+)\.([\w-]+),/, (m, body, sig) => `.${Buffer.from(JSON.stringify({ aud: 'https://evil.example', exp: 1, sub: 'x' })).toString('base64url')}.${sig},`);
  assert.equal(readVapid(forged, keys.publicKey), null, 'nor with other claims');
});

test('only the browsers\' push services are posted to', () => {
  for (const ok of ['https://web.push.apple.com/QW', 'https://api.push.apple.com/x', 'https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-db5p.notify.windows.com/w/?token=x']) assert.equal(pushService(ok), true, ok);
  for (const no of ['http://web.push.apple.com/x', 'https://push.apple.com.evil.example/x', 'https://evil.example/web.push.apple.com', 'https://localhost/x', 'https://fcm.googleapis.com:8443/x', 'nonsense']) assert.equal(pushService(no), false, no);
  assert.equal(pushService('http://localhost:9/x', { allowPrivate: true }), true);
  const { sub } = device('https://web.push.apple.com/x');
  assert.ok(cleanSubscription(sub));
  assert.equal(cleanSubscription({ ...sub, keys: { ...sub.keys, auth: 'short' } }), null);
  assert.equal(cleanSubscription({ ...sub, keys: { ...sub.keys, p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url') } }), null, 'not a point on the curve');
});

test('which new episodes are worth telling', () => {
  const now = Date.UTC(2026, 10, 10);
  const ep = (id, hoursAgo) => ({ id, published: now - hoursAgo * 3600e3 });
  const before = [ep('a', 50), ep('b', 100)];
  assert.deepEqual(newEpisodes(null, [ep('n', 1), ...before], { now }), [], 'never on a first reading');
  assert.deepEqual(newEpisodes(before, [ep('n', 1), ...before], { now, since: now - 10 * 3600e3 }).map((e) => e.id), ['n']);
  assert.deepEqual(newEpisodes(before, [ep('n', 1), ...before], { now, since: now - 0.5 * 3600e3 }), [], 'not out before the show was followed');
  assert.deepEqual(newEpisodes(before, [ep('old', 80), ...before], { now }), [], 'nothing older than three days');
  const redated = Array.from({ length: 30 }, (_, i) => ep(`r${i}`, i + 1));
  assert.deepEqual(newEpisodes(before, redated, { now }).map((e) => e.id), ['r0', 'r1'], 'a feed that re-dates everything: the newest two');
});

/* ---------- on the server ---------- */

const KEY = 'k'.repeat(24);
const FEED = 'https://feeds.example/a';
const A = subId(FEED);
const item = (n, at) => `<item><title>Episode ${n}</title><guid>g${n}</guid><pubDate>${new Date(at).toUTCString()}</pubDate><enclosure url="https://cdn.example/${n}.mp3" type="audio/mpeg"/></item>`;

// The server with one feed on the web and a push service that records what it is sent.
async function serve(dir = null) {
  dir ||= await mkdtemp(path.join(tmpdir(), 'push-'));
  const web = { clock: Date.UTC(2026, 10, 10), items: [], posts: [], answer: 201 };
  const fetchImpl = async (url, init = {}) => {
    if (url === FEED) return new Response(`<rss><channel><title>Alpha</title>${web.items.map(([n, at]) => item(n, at)).join('')}</channel></rss>`, { status: 200 });
    if (url.startsWith('https://web.push.apple.com/')) {
      web.posts.push({ url, headers: init.headers, body: Buffer.from(init.body) });
      return new Response(null, { status: typeof web.answer === 'function' ? web.answer() : web.answer });
    }
    return new Response('nope', { status: 404 });
  };
  const pod = createPod({ dataDir: dir, log: () => {}, fetchImpl, now: () => web.clock, key: KEY, pushSubject: 'https://site.example' });
  await pod.init();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!(await pod.handle(req, res, url.pathname, url))) { res.writeHead(404); res.end(); }
  }).listen(0);
  const call = async (method, p, body) => {
    const res = await fetch(`http://localhost:${server.address().port}${p}`, { method, body: body == null ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${KEY}` } });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const stop = async () => { server.close(); await pod.flush(); };
  return { pod, call, web, dir, stop, close: async () => { await stop(); await rm(dir, { recursive: true, force: true }); } };
}

test('a new episode of a followed show is told to every device, once', async () => {
  let s = await serve();
  const { dir, web } = s;
  try {
    const phone = device('https://web.push.apple.com/phone');
    const old = device('https://web.push.apple.com/old');
    assert.equal((await s.call('GET', '/api/pod/push?endpoint=x')).json.known, false);
    const key = (await s.call('GET', '/api/pod/push')).json.key;
    assert.equal(Buffer.from(key, 'base64url').length, 65);
    assert.equal((await s.call('POST', '/api/pod/push', { subscription: { ...phone.sub, endpoint: 'https://evil.example/x' } })).status, 400, 'only a push service');
    assert.equal((await s.call('POST', '/api/pod/push', { subscription: phone.sub })).status, 200);
    assert.equal((await s.call('POST', '/api/pod/push', { subscription: old.sub })).status, 200);
    assert.equal((await s.call('GET', `/api/pod/push?endpoint=${encodeURIComponent(phone.sub.endpoint)}`)).json.known, true);

    // Followed, and read for the first time: nothing, however new its episodes are.
    web.items = [[1, web.clock - 3600e3], [0, web.clock - 9 * 864e5]];
    await s.call('POST', '/api/pod/sync', { changes: { subs: { [A]: { id: A, feedUrl: FEED, title: 'Alpha Show', addedAt: web.clock, at: web.clock } } } });
    await s.pod.refreshAll();
    assert.equal(web.posts.length, 0, 'nothing for a first reading');

    // A new episode: one message to each device. The old one's service says it is gone.
    web.clock += 2 * 3600e3;
    web.items.unshift([2, web.clock - 600e3]);
    web.answer = () => (web.posts.at(-1).url.endsWith('/old') ? 410 : 201);
    await s.pod.refreshAll();
    assert.equal(web.posts.length, 2);
    const msg = web.posts.find((p) => p.url.endsWith('/phone'));
    assert.equal(msg.headers['content-encoding'], 'aes128gcm');
    assert.equal(msg.headers.ttl, '172800');
    assert.equal(msg.headers.topic, idOf('g2'));
    assert.deepEqual(readVapid(msg.headers.authorization, key), { aud: 'https://web.push.apple.com', exp: web.clock / 1000 + 12 * 3600, sub: 'https://site.example' });
    assert.deepEqual(JSON.parse(decrypt(msg.body, phone.secret)), { title: 'Alpha Show', body: 'Episode 2', tag: idOf('g2'), url: `#/show/${A}`, episode: idOf('g2') });
    assert.equal((await s.call('GET', `/api/pod/push?endpoint=${encodeURIComponent(old.sub.endpoint)}`)).json.known, false, 'a device its service has forgotten is dropped');
    await s.pod.refreshAll();
    assert.equal(web.posts.length, 2, 'and told once');

    // Published before the show was followed, or days ago: nothing.
    web.answer = 201;
    web.items.unshift([3, web.clock - 4 * 864e5], [4, web.clock - 4 * 3600e3]);
    await s.pod.refreshAll();
    assert.equal(web.posts.length, 2, 'nothing old, nothing from before the follow');

    // A push service that fails is tried again the next round.
    web.clock += 3600e3;
    web.items.unshift([5, web.clock - 60e3]);
    web.answer = 503;
    await s.pod.refreshAll();
    assert.equal(web.posts.length, 3);
    web.answer = 201;
    await s.pod.refreshAll();
    assert.equal(web.posts.length, 4);
    assert.equal(JSON.parse(decrypt(web.posts[3].body, phone.secret)).body, 'Episode 5');

    // The server restarts; the feed drops an episode and puts it back. It was told already.
    await s.stop();
    s = await serve(dir);
    Object.assign(s.web, { clock: web.clock, items: web.items.filter(([n]) => n !== 5) });
    await s.pod.refreshAll();
    s.web.items = web.items;
    await s.pod.refreshAll();
    assert.equal(s.web.posts.length, 0, 'a restart tells nothing twice');
    assert.ok(JSON.parse(await readFile(path.join(dir, 'pod', 'vapid.json'), 'utf8')).publicKey === key, 'and keeps its key');

    // Switched off for the show: nothing.
    const cur = s.pod.doc.subs[A];
    await s.call('POST', '/api/pod/sync', { changes: { subs: { [A]: { ...cur, notify: false, at: cur.at + 1 } } } });
    s.web.clock += 3600e3;
    s.web.items = [[6, s.web.clock - 60e3], ...s.web.items];
    await s.pod.refreshAll();
    assert.equal(s.web.posts.length, 0, 'a show switched off tells nothing');

    // A test notification, and removing a device.
    assert.equal((await s.call('POST', '/api/pod/push/test', { endpoint: phone.sub.endpoint })).status, 200);
    assert.equal(JSON.parse(decrypt(s.web.posts[0].body, phone.secret)).tag, 'test');
    assert.equal((await s.call('POST', '/api/pod/push/test', { endpoint: 'https://web.push.apple.com/nobody' })).status, 404);
    assert.equal((await s.call('DELETE', `/api/pod/push?endpoint=${encodeURIComponent(phone.sub.endpoint)}`)).json.removed, true);
    assert.equal((await s.call('GET', `/api/pod/push?endpoint=${encodeURIComponent(phone.sub.endpoint)}`)).json.known, false);
  } finally { await s.close(); }
});

test('at most 20 devices; a device that has failed for a week is dropped', async () => {
  const s = await serve();
  try {
    const all = Array.from({ length: 22 }, (_, i) => device(`https://web.push.apple.com/d${i}`));
    for (const d of all) { await s.call('POST', '/api/pod/push', { subscription: d.sub }); s.web.clock += 1000; }
    const known = async (d) => (await s.call('GET', `/api/pod/push?endpoint=${encodeURIComponent(d.sub.endpoint)}`)).json.known;
    assert.equal(await known(all[0]), false, 'the oldest goes');
    assert.equal(await known(all[21]), true);
    s.web.items = [[1, s.web.clock - 864e5]];
    await s.call('POST', '/api/pod/sync', { changes: { subs: { [A]: { id: A, feedUrl: FEED, title: 'Alpha', addedAt: s.web.clock - 2 * 864e5, at: s.web.clock } } } });
    await s.pod.refreshAll();
    s.web.answer = 500;
    s.web.items.unshift([2, s.web.clock - 60e3]);
    await s.pod.refreshAll();
    assert.equal(await known(all[21]), true, 'failing for a while is not enough');
    s.web.clock += 8 * 864e5;
    await s.pod.refreshAll();
    assert.equal(await known(all[21]), false, 'a week is');
  } finally { await s.close(); }
});
