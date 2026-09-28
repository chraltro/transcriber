import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellSeconds, speakerMap, talkTime, selection } from '../../lib/speakermap.js';

test('cells are a round length that fits the episode', () => {
  assert.equal(cellSeconds(600, 48), 15);
  assert.equal(cellSeconds(3600, 48), 120);
  assert.equal(cellSeconds(3 * 3600, 24), 600);
  assert.equal(cellSeconds(20 * 3600, 24), 3000);
});

test('each voice gets a row of talk shares, loudest first', () => {
  const segs = [
    { start: 0, end: 30, text: 'a', speaker: 0 },
    { start: 30, end: 90, text: 'b', speaker: 1 },
    { start: 90, end: 100, text: 'c', speaker: 0 },
  ];
  const m = speakerMap(segs, 120, { maxCols: 2 });
  assert.equal(m.cell, 60);
  assert.equal(m.cols, 2);
  assert.deepEqual(m.rows.map((r) => r.speaker), [1, 0]);
  assert.deepEqual(m.rows[0].share, [0.5, 0.5]);
  assert.deepEqual(m.rows[1].share.map((x) => +x.toFixed(3)), [0.5, 0.167]);
});

test('without speaker labels there is one row for speech', () => {
  const m = speakerMap([{ start: 0, end: 15, text: 'x' }, { start: 15, end: 30, text: 'y' }], 60, { maxCols: 4 });
  assert.equal(m.rows.length, 1);
  assert.equal(m.rows[0].speaker, null);
  assert.deepEqual(m.rows[0].share, [1, 1, 0, 0]);
  assert.deepEqual(speakerMap([], 0).rows, []);
});

test('talk time and selections', () => {
  const segs = [{ start: 0, end: 30, text: 'a', speaker: 0 }, { start: 30, end: 40, text: 'b', speaker: 1 }, { start: 40, end: 50, text: 'c' }];
  assert.deepEqual(talkTime(segs).map((t) => [t.speaker, t.seconds, +t.fraction.toFixed(2)]), [[0, 30, 0.75], [1, 10, 0.25]]);
  const sel = selection(segs, 25, 35);
  assert.deepEqual([sel.from, sel.to, sel.segments.length], [0, 40, 2]);
  assert.equal(selection(segs, 100, 200).segments.length, 0);
});
