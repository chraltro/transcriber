import { test } from 'node:test';
import assert from 'node:assert/strict';

// A Cache Storage that, like WebKit's, takes an entry out before it puts the new one in, and lets
// the page read in between (`gap` is called there).
function fakeCaches() {
  const store = new Map();
  const hooks = { gap: null };
  const cache = {
    async put(key, res) {
      const body = await res.arrayBuffer();
      store.delete(key);
      if (hooks.gap && !key.endsWith('&next')) await hooks.gap();
      store.set(key, body);
    },
    async match(key) { return store.has(key) ? new Response(store.get(key)) : undefined; },
    async delete(key) { return store.delete(key); },
    async keys() { return [...store.keys()].map((url) => ({ url })); },
  };
  return { caches: { open: async () => cache, delete: async () => { store.clear(); return true; } }, store, hooks };
}

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

async function setup() {
  const fake = fakeCaches();
  globalThis.caches = fake.caches;
  globalThis.localStorage = fakeStorage();
  const { Downloads } = await import('../../ui/downloads.js');
  const ep = { id: 'show/1', title: 'One', url: 'https://host.example/1.mp3' };
  let from = 'origin';
  const d = new Downloads({ open: async () => ({ response: new Response(from === 'server' ? 'the server copy' : 'the host copy'), from }) });
  await d.start(ep);
  from = 'server';
  return { d, fake, ep };
}

test('a saved copy read while it is swapped for the server\'s is not taken for lost', async () => {
  const { d, fake, ep } = await setup();
  assert.equal(d.info(ep.id).from, 'origin');
  let read = 'not read';
  let verified = false;
  fake.hooks.gap = async () => {
    fake.hooks.gap = null;
    read = await (await d.blob(ep.id))?.text();
    await d.verify();
    verified = true;
  };
  assert.equal(await d.upgrade(ep.id), true);
  assert.ok(verified);
  assert.equal(read, 'the server copy'); // (the new copy, from its own key, while the old one is out)
  assert.equal(d.info(ep.id)?.from, 'server');
  assert.ok(!d.lost.has(ep.id));
  assert.equal(await (await d.blob(ep.id)).text(), 'the server copy');
  assert.deepEqual([...fake.store.keys()].filter((k) => k.endsWith('&next')), []);
});

test('a copy removed while it is being swapped stays removed', async () => {
  const { d, fake, ep } = await setup();
  fake.hooks.gap = null;
  const going = d.upgrade(ep.id);
  await d.remove(ep.id);
  await going;
  assert.equal(d.has(ep.id), false);
  assert.deepEqual([...fake.store.keys()].filter((k) => k.endsWith('&next')), []);
});
