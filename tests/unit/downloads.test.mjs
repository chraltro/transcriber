import { test } from 'node:test';
import assert from 'node:assert/strict';

// A Cache Storage that, like WebKit's, takes an entry out before it puts the new one in, and lets
// the page read while a file is being written (`gap` is called there).
function fakeCaches() {
  const store = new Map();
  const hooks = { gap: null };
  const cache = {
    async put(key, res) {
      store.delete(key);
      if (hooks.gap) { const gap = hooks.gap; hooks.gap = null; await gap(); }
      store.set(key, await res.arrayBuffer());
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

test('a saved copy read while it is swapped for the server\'s is the old one, and nothing is lost', async () => {
  const { d, fake, ep } = await setup();
  assert.equal(d.info(ep.id).from, 'origin');
  let read = 'not read';
  fake.hooks.gap = async () => {
    read = await (await d.blob(ep.id))?.text();
    await d.verify();
  };
  assert.equal(await d.upgrade(ep.id), true);
  assert.equal(read, 'the host copy');
  assert.equal(d.info(ep.id)?.from, 'server');
  assert.ok(!d.lost.has(ep.id));
  assert.equal(await (await d.blob(ep.id)).text(), 'the server copy');
  assert.equal(fake.store.size, 1); // (the old file gone)
  // ...and it stays found after a restart.
  await d.verify();
  assert.equal(d.info(ep.id)?.from, 'server');
});

test('a copy removed while it is being swapped stays removed', async () => {
  const { d, fake, ep } = await setup();
  fake.hooks.gap = null;
  const going = d.upgrade(ep.id);
  await d.remove(ep.id);
  await going;
  assert.equal(d.has(ep.id), false);
  assert.equal(fake.store.size, 0);
});
