import test from 'node:test';
import assert from 'node:assert/strict';
import { planQueue } from '../../server/plan.mjs';
import { idOf } from '../../server/shows.mjs';

const DAY = 864e5;
const NOW = Date.UTC(2026, 10, 14);
const ep = (guid, daysAgo) => ({ guid, title: guid, url: `https://cdn.example/${guid}.mp3`, published: NOW - daysAgo * DAY, notes: '', duration: 3000 });
const FEEDS = {
  'https://f/a': { show: 'Alpha', language: 'en', episodes: [ep('a5', 1), ep('a4', 3), ep('a3', 8), ep('a2', 20), ep('a1', 40)] },
  'https://f/n': { show: 'Norsk', language: 'nb-NO', episodes: [ep('n3', 2), ep('n2', 9), ep('n1', 30)] },
  'https://f/old': { show: 'Old', language: 'en', episodes: [ep('o2', 100), ep('o1', 200)] },
};
const feedOf = async (show) => { if (!FEEDS[show.feedUrl]) throw new Error('HTTP 404'); return FEEDS[show.feedUrl]; };
const onSite = (show, ...eps) => eps.map(([guid, daysAgo]) => ({ id: idOf(guid), show, createdAt: NOW - daysAgo * DAY }));
const plan = (shows, index = [], asked = []) => planQueue({ shows, asked, index: { entries: index }, feedOf, now: NOW }).then((q) => q.map((x) => x.title));

test('a show new to the site gets its newest episode; after that, everything since', async () => {
  assert.deepEqual(await plan([{ name: 'Alpha', feedUrl: 'https://f/a', fresh: true }]), ['a5']);
  assert.deepEqual(await plan([{ name: 'Alpha', feedUrl: 'https://f/a', fresh: true }], onSite('Alpha', ['a3', 8])), ['a4', 'a5'], 'oldest first');
  assert.deepEqual(await plan([{ name: 'Alpha', feedUrl: 'https://f/a', fresh: true }], onSite('Alpha', ['a3', 8], ['a4', 3], ['a5', 1])), []);
  assert.deepEqual(await plan([{ name: 'Old', feedUrl: 'https://f/old', fresh: true }]), [], 'nothing from the last two weeks, nothing to do');
});

test('going back: the latest so many, however old, after the new ones and newest first', async () => {
  assert.deepEqual(await plan([{ name: 'Alpha', feedUrl: 'https://f/a', fresh: true, backfill: 4 }]), ['a5', 'a4', 'a3', 'a2']);
  assert.deepEqual(await plan([{ name: 'Alpha', feedUrl: 'https://f/a', fresh: true, backfill: 4 }], onSite('Alpha', ['a4', 3])), ['a5', 'a3', 'a2']);
  assert.deepEqual(await plan([{ name: 'Old', feedUrl: 'https://f/old', fresh: false, backfill: 1 }]), ['o2'], 'going back works without following what is new');
  assert.deepEqual(await plan([{ name: 'Alpha', feedUrl: 'https://f/a', fresh: false, backfill: 0 }]), []);
});

test('across shows: new episodes, then the ones asked for, then going back', async () => {
  const q = await planQueue({
    shows: [{ name: 'Alpha', feedUrl: 'https://f/a', fresh: true, backfill: 3 }, { name: 'Norsk', feedUrl: 'https://f/n', fresh: true, backfill: 2 }, { name: 'Gone', feedUrl: 'https://f/gone', fresh: true }],
    asked: [{ id: idOf('o1'), feedUrl: 'https://f/old', title: 'o1' }, { id: idOf('a5'), feedUrl: 'https://f/a', title: 'a5' }, { id: idOf('nope'), feedUrl: 'https://f/a', title: 'nope' }, { id: idOf('x'), feedUrl: 'https://f/gone', title: 'x' }],
    index: { entries: onSite('Alpha', ['a3', 8]) }, feedOf, now: NOW,
  });
  assert.deepEqual(q.map((x) => x.title), ['a4', 'n3', 'a5', 'o1', 'n2'], 'a4 and a5 are new for Alpha (a5 once), n3 is Norsk\'s newest, o1 was asked for, n2 is going back');
  assert.equal(q.find((x) => x.title === 'n3').lang, 'norwegian', 'the feed says which language');
  assert.equal(q.find((x) => x.title === 'a4').lang, 'english');
  assert.equal(q[0].id, idOf('a4'));
  assert.equal(q.find((x) => x.title === 'o1').show, 'Old');
});
