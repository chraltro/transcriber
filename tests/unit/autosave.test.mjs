import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, roomFor, reserveFor, sizeOf, backoff, CHOICES } from '../../lib/autosave.js';

const DAY = 864e5;
// A show's episodes, newest first: a1 (today), a2 (a day ago), ...
const eps = (sub, n) => Array.from({ length: n }, (_, i) => ({ id: `${sub}${i + 1}`, sub, url: `https://x/${sub}${i + 1}.mp3`, published: 100 * DAY - i * DAY, duration: 1800 }));
const world = (over = {}) => {
  const feeds = { a: eps('a', 6), b: eps('b', 4), ...(over.feeds || {}) };
  const prog = over.progress || {};
  return {
    shows: over.shows || [{ id: 'a', keep: 2 }],
    episodesOf: (id) => feeds[id] ?? null,
    progress: (id) => prog[id] || null,
    queue: over.queue || [],
    saved: over.saved || {},
    declined: over.declined || [],
    playingId: over.playingId ?? null,
    keepPlayed: !!over.keepPlayed,
  };
};
const auto = (id, sub = id[0]) => ({ auto: true, bytes: 1, ep: { id, sub } });
const hand = (id, sub = id[0]) => ({ bytes: 1, ep: { id, sub } });
const ids = (list) => list.map((e) => e.id);

test('the choices are none, 1, 2, 3 and 5', () => {
  assert.deepEqual(CHOICES, [0, 1, 2, 3, 5]);
});

test('the newest N not played are fetched, newest first', () => {
  assert.deepEqual(ids(plan(world()).fetch), ['a1', 'a2']);
  assert.deepEqual(ids(plan(world({ shows: [{ id: 'a', keep: 5 }] })).fetch), ['a1', 'a2', 'a3', 'a4', 'a5']);
});

test('the order of a feed does not matter: newest by date', () => {
  const shuffled = eps('a', 4).reverse();
  assert.deepEqual(ids(plan(world({ feeds: { a: shuffled } })).fetch), ['a1', 'a2']);
});

test('across shows, newest first', () => {
  const b = eps('b', 3).map((e) => ({ ...e, published: e.published - DAY / 2 }));
  const got = plan(world({ shows: [{ id: 'a', keep: 2 }, { id: 'b', keep: 2 }], feeds: { b } })).fetch;
  assert.deepEqual(ids(got), ['a1', 'b1', 'a2', 'b2']);
});

test('a show set to none, or not listed, fetches nothing', () => {
  assert.deepEqual(plan(world({ shows: [{ id: 'a', keep: 0 }] })).fetch, []);
  assert.deepEqual(plan(world({ shows: [] })).fetch, []);
});

test('what has been played is passed over, and the next one taken', () => {
  const got = plan(world({ progress: { a1: { p: 1800, d: 1800, done: true } } })).fetch;
  assert.deepEqual(ids(got), ['a2', 'a3']);
});

test('started and not finished is not played: it is one of the newest', () => {
  assert.deepEqual(ids(plan(world({ progress: { a1: { p: 300, d: 1800 } } })).fetch), ['a1', 'a2']);
});

test('what is saved already is not fetched again, and counts towards N', () => {
  assert.deepEqual(ids(plan(world({ saved: { a1: hand('a1') } })).fetch), ['a2']);
  assert.deepEqual(ids(plan(world({ saved: { a1: auto('a1'), a2: auto('a2') } })).fetch), []);
});

test('one the listener removed by hand is not fetched again; the next one is', () => {
  assert.deepEqual(ids(plan(world({ declined: ['a1'] })).fetch), ['a2', 'a3']);
});

test('an episode with no address is passed over', () => {
  const a = eps('a', 3);
  delete a[0].url;
  assert.deepEqual(ids(plan(world({ feeds: { a } })).fetch), ['a2', 'a3']);
});

test('a show whose episodes are not known yet fetches nothing and drops nothing', () => {
  const got = plan(world({ feeds: { a: null }, saved: { a5: auto('a5') } }));
  assert.deepEqual(got, { fetch: [], drop: [] });
});

test('what is fetched carries its show', () => {
  const a = eps('a', 2).map(({ sub, ...e }) => e);
  assert.equal(plan(world({ feeds: { a } })).fetch[0].sub, 'a');
});

test('played to the end, an episode saved this way goes', () => {
  const got = plan(world({ saved: { a1: auto('a1'), a2: auto('a2') }, progress: { a1: { p: 1800, d: 1800, done: true } } }));
  assert.deepEqual(got.drop, ['a1']);
  assert.deepEqual(ids(got.fetch), ['a3'], 'and the next one comes');
});

test('...unless saved episodes are kept once played', () => {
  const got = plan(world({ keepPlayed: true, saved: { a1: auto('a1'), a2: auto('a2') }, progress: { a1: { p: 1800, d: 1800, done: true } } }));
  assert.deepEqual(got.drop, []);
  assert.deepEqual(ids(got.fetch), ['a3']);
});

test('no longer among the newest N, an episode saved this way goes', () => {
  const got = plan(world({ saved: { a2: auto('a2'), a3: auto('a3') } }));
  assert.deepEqual(got.drop, ['a3']);
  assert.deepEqual(ids(got.fetch), ['a1']);
});

test('a show turned to none, or no longer followed, loses what was saved this way', () => {
  const saved = { a1: auto('a1'), a2: auto('a2'), b1: auto('b1') };
  assert.deepEqual(plan(world({ shows: [{ id: 'a', keep: 0 }, { id: 'b', keep: 1 }], saved })).drop.sort(), ['a1', 'a2']);
  assert.deepEqual(plan(world({ shows: [{ id: 'a', keep: 2 }], saved })).drop, ['b1']);
});

test('fewer to keep: the older ones go', () => {
  const saved = { a1: auto('a1'), a2: auto('a2'), a3: auto('a3') };
  assert.deepEqual(plan(world({ shows: [{ id: 'a', keep: 1 }], saved })).drop.sort(), ['a2', 'a3']);
});

test('never while in the player, in the queue, or started and not finished', () => {
  const saved = { a4: auto('a4'), a5: auto('a5'), a6: auto('a6'), b1: auto('b1') };
  const got = plan(world({ saved, playingId: 'a4', queue: ['a5'], progress: { a6: { p: 600, d: 1800 }, b1: { p: 1800, d: 1800, done: true } } }));
  assert.deepEqual(got.drop, ['b1']);
  const off = plan(world({ shows: [], saved, playingId: 'a4', queue: ['a5'], progress: { a6: { p: 600, d: 1800 } } }));
  assert.deepEqual(off.drop, ['b1'], 'not even when the show is turned to none');
  const played = plan(world({ saved: { a1: auto('a1') }, playingId: 'a1', progress: { a1: { p: 1800, d: 1800, done: true } } }));
  assert.deepEqual(played.drop, [], 'nor when it has been played, while it is still in the player');
});

test('a few seconds in is not started: it can go', () => {
  assert.deepEqual(plan(world({ saved: { a5: auto('a5') }, progress: { a5: { p: 3, d: 1800 } } })).drop, ['a5']);
});

test('episodes saved by hand are never touched', () => {
  const saved = { a1: hand('a1'), a5: hand('a5'), b1: hand('b1'), c1: hand('c1') };
  const got = plan(world({ shows: [{ id: 'a', keep: 1 }, { id: 'b', keep: 0 }], saved, progress: { a5: { p: 1, d: 1, done: true } } }));
  assert.deepEqual(got.drop, []);
});

test('room: 500 MB or a tenth, whichever is more', () => {
  assert.equal(reserveFor(1e9), 500e6);
  assert.equal(reserveFor(20e9), 2e9);
  assert.equal(roomFor({ usage: 0, quota: 1e9 }, 400e6), true);
  assert.equal(roomFor({ usage: 200e6, quota: 1e9 }, 400e6), false);
  assert.equal(roomFor({ usage: 17e9, quota: 20e9 }, 100e6), true);
  assert.equal(roomFor({ usage: 17.95e9, quota: 20e9 }, 100e6), false);
  assert.equal(roomFor({}, 100e6), true, 'not known is taken as room');
  assert.equal(roomFor(undefined, 100e6), true);
});

test('an episode\'s size is guessed from its length', () => {
  assert.equal(sizeOf({ duration: 3600 }), 57.6e6);
  assert.equal(sizeOf({}), 80e6);
});

test('after failures, growing waits', () => {
  assert.equal(backoff(0), 0);
  assert.equal(backoff(1), 60e3);
  assert.equal(backoff(2), 120e3);
  assert.equal(backoff(3), 240e3);
  assert.equal(backoff(20), 2 * 3600e3);
});
