import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshStatus, serverJob, jobTag, jobText, STALE_MS } from '../../lib/serverjob.js';

const NOW = 1_800_000_000_000;
const status = (current, queue = [], ago = 30e3) => ({ updatedAt: NOW - ago, current, queue });

test('the episode being transcribed: how far, and about how long is left at the pace so far', () => {
  const s = freshStatus(status({ id: 'a', step: 'transcribing', position: 1800, total: 3600, elapsed: 1200 }, [{ id: 'b' }, { id: 'c' }]), NOW);
  const job = serverJob(s, 'a');
  assert.deepEqual(job, { step: 'transcribing', pct: 50, minutesLeft: 21 }); // 1800 s to go at 1.5x, and a minute to upload
  assert.equal(jobTag(job), 'Transcribing 50%');
  assert.equal(jobText(job), 'The server is transcribing this: 50% done, about 21 min left.');
});

test('the ones waiting say how many go first', () => {
  const s = freshStatus(status({ id: 'a', position: 10, total: 3600, elapsed: 20 }, [{ id: 'b' }, { id: 'c' }]), NOW);
  assert.deepEqual(serverJob(s, 'b'), { ahead: 1 });
  assert.deepEqual(serverJob(s, 'c'), { ahead: 2 });
  assert.equal(jobTag(serverJob(s, 'c')), 'Transcript in line, 2 ahead');
  assert.equal(jobText(serverJob(s, 'b')), 'The server transcribes this after the one it is on.');
  assert.equal(serverJob(s, 'z'), null);
  const idle = freshStatus(status(null, [{ id: 'b' }]), NOW);
  assert.equal(jobTag(serverJob(idle, 'b')), 'Transcript next');
});

test('before a minute has gone by there is no time left to tell, and steps before and after say what they are', () => {
  const s = (c) => freshStatus(status(c), NOW);
  assert.deepEqual(serverJob(s({ id: 'a', position: 20, total: 3600, elapsed: 15 }), 'a'), { step: 'transcribing', pct: 0, minutesLeft: null });
  assert.equal(jobText(serverJob(s({ id: 'a', position: 0, total: 3600, elapsed: 0 }), 'a')), 'The server is getting the audio, to transcribe it now.');
  assert.equal(jobTag(serverJob(s({ id: 'a', step: 'uploading', position: 3600, total: 3600, elapsed: 2400 }), 'a')), 'Transcript almost ready');
  assert.equal(serverJob(s({ id: 'a', step: 'transcribing', position: 3600, total: 3600, elapsed: 2400 }), 'a').pct, 99, 'never 100 before it is there');
});

test('a run that has not written for ten minutes is not believed', () => {
  assert.equal(freshStatus(status({ id: 'a', position: 1, total: 2 }, [], STALE_MS + 1), NOW), null);
  assert.equal(freshStatus(null, NOW), null);
  assert.equal(serverJob(null, 'a'), null);
  assert.equal(jobTag(null), '');
});
