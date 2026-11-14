// Notifications sent to the listener's devices through the browsers' own push services: Web Push
// (RFC 8030), its message encryption (aes128gcm, RFC 8291 on RFC 8188) and the server's proof of
// who it is (VAPID, RFC 8292). Node's crypto only: the server starts without installing packages.
//
// createPusher() keeps the devices that asked (at most 20), the server's key pair, and which
// episodes have been told about, in the data folder; server/pod.mjs hands it what is new after
// reading feeds, and serves the routes the page subscribes through.
import { createECDH, createHmac, createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (s) => Buffer.from(String(s || ''), 'base64url');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const RECORD = 4096;
const MAX_SUBS = 20;
const WEEK = 7 * 864e5;
const DAY = 864e5;

// The hosts of the browsers' push services: a subscription anywhere else is not taken, so the
// server can't be made to post to an address of someone's choosing.
const SERVICES = [/(^|\.)push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
export function pushService(endpoint, { allowPrivate = false } = {}) {
  let u;
  try { u = new URL(String(endpoint)); } catch { return false; }
  if (allowPrivate) return /^https?:$/.test(u.protocol);
  return u.protocol === 'https:' && !u.port && SERVICES.some((re) => re.test(u.hostname));
}

/* ---------- keys ---------- */

// A P-256 key pair as raw bytes, base64url: the public key uncompressed (65 bytes), the private
// key its 32-byte scalar.
export function makeKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64(ecdh.getPublicKey()), privateKey: b64(ecdh.getPrivateKey()) };
}

const jwkOf = ({ publicKey, privateKey }) => {
  const pub = unb64(publicKey);
  return { kty: 'EC', crv: 'P-256', x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33, 65)), ...(privateKey ? { d: b64(unb64(privateKey)) } : {}) };
};

// The Authorization header that says who sends: a JWT for the push service's origin, signed with
// the server's key, valid for twelve hours (services refuse more than a day).
export function vapidHeader(endpoint, keys, subject, now = Date.now()) {
  const head = b64(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const key = createPrivateKey({ key: jwkOf(keys), format: 'jwk' });
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64(sig)}, k=${keys.publicKey}`;
}

// Checks a VAPID token against a public key. -> its claims, or null. (For tests.)
export function readVapid(header, publicKey) {
  const [, t, k] = String(header).match(/^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/) || [];
  if (!t || k !== publicKey) return null;
  const [head, body, sig] = t.split('.');
  const key = createPublicKey({ key: jwkOf({ publicKey }), format: 'jwk' });
  if (!verify('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }, unb64(sig))) return null;
  return JSON.parse(unb64(body).toString('utf8'));
}

/* ---------- the message ---------- */

// The keys both sides derive from the shared secret (RFC 8291 section 3.4).
function derive(authSecret, ecdhSecret, uaPublic, asPublic, salt) {
  const prkKey = hmac(authSecret, ecdhSecret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  return {
    cek: hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16),
    nonce: hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12),
  };
}

// The payload encrypted for one subscription ({ keys: { p256dh, auth } }), as one record.
// `salt` and `localKeys` ({ publicKey, privateKey }, base64url) are made fresh unless given (the
// RFC's worked example gives them).
export function encrypt(payload, subscription, { salt = randomBytes(16), localKeys = null } = {}) {
  const uaPublic = unb64(subscription.keys.p256dh);
  const authSecret = unb64(subscription.keys.auth);
  const ecdh = createECDH('prime256v1');
  if (localKeys) ecdh.setPrivateKey(unb64(localKeys.privateKey)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const { cek, nonce } = derive(authSecret, ecdh.computeSecret(uaPublic), uaPublic, asPublic, Buffer.from(salt));
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // 2: the last record
  if (plain.length + 16 > RECORD - 86) throw new Error('Message too long');
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  Buffer.from(salt).copy(head, 0);
  head.writeUInt32BE(RECORD, 16);
  head[20] = asPublic.length;
  return Buffer.concat([head, asPublic, sealed]);
}

// What a browser does with a message: `keys` is the subscription's private side
// ({ privateKey, publicKey, auth }, base64url). -> the payload as text. (For tests.)
export function decrypt(body, keys) {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const idlen = buf[20];
  const asPublic = buf.subarray(21, 21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(unb64(keys.privateKey));
  const { cek, nonce } = derive(unb64(keys.auth), ecdh.computeSecret(asPublic), unb64(keys.publicKey), asPublic, salt);
  const sealed = buf.subarray(21 + idlen);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(-16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  let end = plain.length - 1;
  while (end > 0 && plain[end] === 0) end--;
  return plain.subarray(0, end).toString('utf8');
}

// A subscription as the page's PushSubscription.toJSON() gives it, checked: its keys have to be
// a real P-256 point and a 16-byte secret. -> { endpoint, keys } or null.
export function cleanSubscription(sub, opts) {
  const endpoint = String(sub?.endpoint || '');
  const p256dh = String(sub?.keys?.p256dh || '');
  const auth = String(sub?.keys?.auth || '');
  if (endpoint.length > 1000 || !pushService(endpoint, opts)) return null;
  if (unb64(auth).length !== 16 || unb64(p256dh).length !== 65) return null;
  try {
    const probe = createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(unb64(p256dh));
  } catch { return null; }
  return { endpoint, keys: { p256dh, auth } };
}

/* ---------- what to tell ---------- */

// The episodes worth a notification after a show's feed was read again: there now and not the
// time before, out since the show was followed and in the last three days, the newest two. A
// first reading has no time before, and a feed that re-dates its archive gets at most two.
export function newEpisodes(before, after, { since = 0, now = Date.now() } = {}) {
  if (!before?.length) return [];
  const had = new Set(before.map((e) => e.id));
  return after.filter((e) => !had.has(e.id) && e.published > since && e.published >= now - 3 * DAY && e.published <= now + DAY)
    .sort((a, b) => b.published - a.published).slice(0, 2);
}

/* ---------- the devices, and sending ---------- */

// subject: who runs the server, as push services want it (the site's address, or a mailto:).
export function createPusher({ dir, fetchImpl = fetch, now = () => Date.now(), log = console.log, allowPrivate = false, subject = '' }) {
  const KEYS = path.join(dir, 'vapid.json');
  const FILE = path.join(dir, 'push.json');
  let keys = null;
  let data = { subs: [], told: {} };
  let queue = [];
  let running = Promise.resolve();
  let timer = null;

  const readJson = async (file, fallback) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; } };
  const writeJson = async (file, value) => {
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(value));
    await rename(tmp, file);
  };
  const save = () => writeJson(FILE, data).catch((err) => log(`push: not saved: ${err.message}`));

  async function init() {
    keys = await readJson(KEYS, null);
    if (!keys?.publicKey || !keys?.privateKey) { keys = makeKeys(); await writeJson(KEYS, keys); }
    const saved = await readJson(FILE, null);
    if (saved) data = { subs: Array.isArray(saved.subs) ? saved.subs : [], told: saved.told || {} };
  }

  const find = (endpoint) => data.subs.find((s) => s.endpoint === endpoint);

  async function add(raw) {
    const sub = cleanSubscription(raw, { allowPrivate });
    if (!sub) return null;
    const had = find(sub.endpoint);
    if (had) Object.assign(had, sub, { failingSince: 0, pending: [] });
    else {
      data.subs.push({ ...sub, addedAt: now(), failingSince: 0, pending: [] });
      // The oldest goes when there are too many: devices replaced long ago never say goodbye.
      data.subs = data.subs.sort((a, b) => a.addedAt - b.addedAt).slice(-MAX_SUBS);
    }
    await save();
    return sub;
  }

  async function remove(endpoint) {
    const n = data.subs.length;
    data.subs = data.subs.filter((s) => s.endpoint !== endpoint);
    if (data.subs.length !== n) await save();
    return data.subs.length !== n;
  }

  // One message to one device. -> 'ok', 'gone' (the service says the subscription is no more),
  // or 'failed'.
  async function post(sub, msg) {
    try {
      const body = encrypt(JSON.stringify(msg.payload), sub);
      const headers = {
        authorization: vapidHeader(sub.endpoint, keys, subject || 'mailto:push@invalid.example', now()),
        'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream',
        ttl: String(msg.ttl ?? 2 * 86400), urgency: msg.urgency || 'normal',
        ...(msg.topic ? { topic: msg.topic } : {}),
      };
      const res = await fetchImpl(sub.endpoint, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(20000) });
      res.body?.cancel?.().catch(() => {});
      if (res.status === 404 || res.status === 410) return 'gone';
      if (res.status >= 200 && res.status < 300) return 'ok';
      log(`push: ${new URL(sub.endpoint).host} answered ${res.status}`);
      return 'failed';
    } catch (err) {
      log(`push: ${err.message}`);
      return 'failed';
    }
  }

  // Sends to one device what it is owed: what failed before, then `msgs`. -> false when the
  // device is to be dropped: its service says it is gone, or nothing has reached it for a week.
  async function deliver(sub, msgs) {
    const todo = [...(sub.pending || []), ...msgs].filter((m) => now() - m.at < 3 * DAY);
    const left = [];
    let through = false;
    for (const msg of todo) {
      const got = await post(sub, msg);
      if (got === 'gone') return false;
      if (got === 'failed') left.push(msg); else through = true;
    }
    sub.pending = left.slice(-10);
    if (through) sub.failingSince = 0;
    if (left.length && !sub.failingSince) sub.failingSince = now();
    return !(sub.failingSince && now() - sub.failingSince > WEEK);
  }

  // A message for every device: { payload, topic, ttl, urgency }. `id`: what it tells of, told
  // once only.
  function tell(id, msg) {
    if (data.told[id]) return false;
    data.told[id] = now();
    queue.push({ ...msg, at: now() });
    return true;
  }

  // Sends what is queued (and what failed before) to every device. One round at a time.
  function flush() {
    clearTimeout(timer);
    timer = null;
    running = running.then(async () => {
      const msgs = queue;
      queue = [];
      for (const [id, at] of Object.entries(data.told)) if (now() - at > 30 * DAY) delete data.told[id];
      const kept = [];
      for (const sub of data.subs) {
        if (await deliver(sub, msgs)) kept.push(sub);
        else log(`push: a device at ${new URL(sub.endpoint).host} was dropped`);
      }
      data.subs = kept;
      await save();
    }).catch((err) => log(`push: round failed: ${err.message}`));
    return running;
  }

  // A flush a moment from now, for feeds read outside a round (the app asked for what is new).
  function flushSoon(ms = 1500) {
    if (timer) return;
    timer = setTimeout(() => flush(), ms);
    timer.unref?.();
  }

  // A notification to one device now, to see that it works. -> 'ok', 'gone', 'failed' or null.
  async function test(endpoint) {
    const sub = find(endpoint);
    if (!sub) return null;
    const got = await post(sub, { payload: { title: 'Transcriber', body: 'Notifications work on this device.', tag: 'test', url: '#/settings' }, ttl: 600, urgency: 'high', at: now() });
    if (got === 'gone') await remove(endpoint);
    return got;
  }

  return {
    init, add, remove, tell, flush, flushSoon, test,
    get publicKey() { return keys?.publicKey || ''; },
    knows: (endpoint) => !!find(endpoint),
    get count() { return data.subs.length; },
  };
}
