import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../../lib/podstate.js';
import { resumeAt, rewindFor, finished, nextSpeed, fmtSpeed, leftText, lengthText, timeIn } from '../../lib/playback.js';

const DAY = 864e5;

test('a show has the same id on every device', () => {
  assert.equal(S.subId('https://feeds.example/psa'), S.subId('http://feeds.example/psa/'));
  assert.equal(S.subId(' https://feeds.example/psa#x '), S.subId('https://feeds.example/psa'));
  assert.notEqual(S.subId('https://feeds.example/psa'), S.subId('https://feeds.example/psw'));
  assert.match(S.subId('https://feeds.example/psa'), /^[0-9a-f]{12}$/);
});

test('following, unfollowing and following again', () => {
  const doc = S.emptyDoc();
  const key = S.follow(doc, { feedUrl: 'https://f/a', title: 'B show' }, 100);
  S.follow(doc, { feedUrl: 'https://f/b', title: 'a show' }, 110);
  assert.deepEqual(S.shows(doc).map((s) => s.title), ['a show', 'B show']);
  const id = key.split('/')[1];
  S.unfollow(doc, id, 200);
  assert.deepEqual(S.shows(doc).map((s) => s.title), ['a show']);
  assert.equal(doc.subs[id].gone, true);
  S.follow(doc, { feedUrl: 'https://f/a', title: 'B show' }, 300);
  assert.equal(doc.subs[id].gone, undefined);
  assert.equal(doc.subs[id].addedAt, 300);
});

test('two copies come together record by record, the later edit winning', () => {
  const phone = S.emptyDoc();
  const laptop = S.emptyDoc();
  S.follow(phone, { feedUrl: 'https://f/a', title: 'A' }, 100);
  S.setProgress(phone, 'ep1', { p: 600, d: 3600 }, 1000);
  S.queueAdd(phone, 'ep2', 1000);
  S.setProgress(laptop, 'ep1', { p: 1200, d: 3600 }, 2000);
  S.setProgress(laptop, 'ep3', { p: 30, d: 100, done: true }, 500);
  S.queueAdd(laptop, 'ep9', 900);
  S.setSettings(laptop, { speed: 1.5 }, 50);

  const toLaptop = S.apply(laptop, phone);
  assert.deepEqual(toLaptop.sort(), [`subs/${S.subId('https://f/a')}`, 'queue'].sort());
  assert.equal(laptop.progress.ep1.p, 1200, 'the later position stays');
  assert.deepEqual(laptop.queue.ids, ['ep2']);
  const toPhone = S.apply(phone, laptop);
  assert.ok(toPhone.includes('progress/ep1') && toPhone.includes('progress/ep3') && toPhone.includes('settings'));
  assert.deepEqual(phone, laptop);
  assert.deepEqual(S.apply(phone, laptop), [], 'nothing left to bring over');
});

test('what arrives is checked before it is kept', () => {
  const doc = S.emptyDoc();
  const changed = S.apply(doc, {
    subs: { '../../etc': { at: 5 }, ok: { id: 'ok', at: 5 }, noclock: { id: 'x' } },
    progress: { a: 'nope', b: { p: 1, at: 2 } },
    queue: { ids: 'not a list', at: 9 },
    nonsense: { x: { at: 1 } },
  });
  assert.deepEqual(changed.sort(), ['progress/b', 'subs/ok']);
  assert.deepEqual(doc.queue.ids, []);
  assert.deepEqual(S.pick(doc, ['subs/ok', 'progress/zzz', 'settings']), { subs: { ok: { id: 'ok', at: 5 } }, settings: { at: 0 } });
});

test('positions, what is started, and the queue', () => {
  const doc = S.emptyDoc();
  S.rememberEpisode(doc, { id: 'a', title: 'A', show: 'S', url: 'u', duration: 100 }, 1);
  S.rememberEpisode(doc, { id: 'b', title: 'B', show: 'S', url: 'u2', duration: 100 }, 1);
  assert.equal(S.rememberEpisode(doc, { id: 'a', title: 'A', show: 'S', url: 'u', duration: 100 }, 2), null, 'unchanged details are not a change');
  S.setProgress(doc, 'a', { p: 40.26, d: 100 }, 10);
  S.setProgress(doc, 'b', { p: 3, d: 100 }, 20);
  assert.equal(doc.progress.a.p, 40.3);
  assert.equal(S.statusOf(doc.progress.a), 'started');
  assert.equal(S.statusOf(doc.progress.b), 'new');
  assert.equal(S.statusOf(undefined), 'new');
  assert.ok(Math.abs(S.fractionOf(doc.progress.a) - 0.403) < 1e-9);
  assert.deepEqual(S.inProgress(doc).map((e) => e.id), ['a']);
  S.setProgress(doc, 'a', { done: true }, 30);
  assert.equal(S.statusOf(doc.progress.a), 'done');
  assert.equal(S.fractionOf(doc.progress.a), 1);
  assert.deepEqual(S.inProgress(doc), []);
  S.setProgress(doc, 'a', { p: 0, done: false }, 40);
  assert.equal(doc.progress.a.done, undefined);

  S.queueAdd(doc, 'x', 1);
  S.queueAdd(doc, 'y', 2);
  S.queueAdd(doc, 'z', 3, { next: true });
  S.queueAdd(doc, 'x', 4);
  assert.deepEqual(doc.queue.ids, ['z', 'y', 'x']);
  S.queueAdd(doc, 'n', 5, { next: true, after: 'y' });
  assert.deepEqual(doc.queue.ids, ['z', 'y', 'n', 'x']);
  S.queueMove(doc, 'x', 0, 6);
  assert.deepEqual(doc.queue.ids, ['x', 'z', 'y', 'n']);
  assert.equal(S.queueMove(doc, 'nope', 0, 7), null);
  S.queueRemove(doc, 'z', 8);
  assert.deepEqual(doc.queue.ids, ['x', 'y', 'n']);
  assert.equal(S.queueRemove(doc, 'z', 9), null);
  assert.equal(S.settingsOf(doc).fwd, 30);
  S.setSettings(doc, { fwd: 45 }, 10);
  assert.equal(S.settingsOf(doc).fwd, 45);
  assert.equal(S.settingsOf(doc).back, 15);
});

test('tidying drops only what nothing points at', () => {
  const doc = S.emptyDoc();
  const now = 200 * DAY;
  S.follow(doc, { feedUrl: 'https://f/a', title: 'A' }, now - 150 * DAY);
  const gone = S.subId('https://f/a');
  S.unfollow(doc, gone, now - 100 * DAY);
  for (const id of ['queued', 'started', 'finished', 'fresh']) S.rememberEpisode(doc, { id, title: id }, now - 60 * DAY);
  S.queueAdd(doc, 'queued', now - 60 * DAY);
  S.setProgress(doc, 'started', { p: 500, d: 1000 }, now - 59 * DAY);
  S.setProgress(doc, 'finished', { p: 1000, d: 1000, done: true }, now - 59 * DAY);
  S.rememberEpisode(doc, { id: 'fresh', title: 'fresh again' }, now - DAY);
  const removed = S.prune(doc, now);
  assert.deepEqual(removed.sort(), ['eps/finished', `subs/${gone}`]);
  assert.ok(doc.progress.finished, 'that it was played is kept');
  for (let i = 0; i < 20; i++) S.setProgress(doc, `p${i}`, { p: 9, d: 10, done: true }, i);
  assert.equal(S.prune(doc, now, { maxProgress: 5 }).length, 17);
  assert.ok(doc.progress.started && doc.progress.finished);
});

test('picking an episode up again', () => {
  assert.equal(resumeAt(null, 0), 0);
  assert.equal(resumeAt({ p: 3, at: 0 }, 1e9), 0);
  assert.equal(resumeAt({ p: 500, done: true, at: 0 }, 1e9), 0);
  assert.equal(resumeAt({ p: 500, at: 1000 }, 1000 + 30e3), 500);
  assert.equal(resumeAt({ p: 500, at: 1000 }, 1000 + 5 * 60e3), 497);
  assert.equal(resumeAt({ p: 500, at: 1000 }, 1000 + 3 * 3600e3), 485);
  assert.equal(resumeAt({ p: 500, at: 1000 }, 1000 + 3 * 3600e3, { rewind: false }), 500);
  assert.equal(resumeAt({ p: 6, at: 0 }, 5 * 864e5), 0);
  assert.equal(rewindFor(-5), 0);
  assert.equal(finished(3590, 3600), true);
  assert.equal(finished(3500, 3600), false);
  assert.equal(finished(29, 30), false, 'too short to judge');
});

test('speeds and clocks', () => {
  assert.equal(nextSpeed(1), 1.2);
  assert.equal(nextSpeed(3), 0.8);
  assert.equal(nextSpeed(1.3), 1.5);
  assert.equal(fmtSpeed(1), '1×');
  assert.equal(fmtSpeed(1.5), '1.5×');
  assert.equal(fmtSpeed(1.25), '1.25×');
  assert.equal(leftText(0, 3600, 1), '1 h 0 min left');
  assert.equal(leftText(1800, 3600, 2), '15 min left');
  assert.equal(leftText(3590, 3600, 1), 'under a minute left');
  assert.equal(leftText(0, 0), '');
  assert.equal(lengthText(3492), '58 min');
  assert.equal(lengthText(4320), '1 h 12 min');
  assert.equal(lengthText(3600), '1 h');
  assert.equal(lengthText(0), '');
  assert.equal(timeIn('12:30'), 750);
  assert.equal(timeIn('(1:02:03)'), 3723);
  assert.equal(timeIn('12:75'), null);
  assert.equal(timeIn('at 12:30'), null);
});
