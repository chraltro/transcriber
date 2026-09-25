import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSrt, toVtt } from '../../lib/subtitles.js';

const segs = [
  { start: 0, end: 23.456, text: ' Hei og velkommen. ' },
  { start: 23.456, end: 50, text: '' },
  { start: 50, end: 3725.5, text: 'Siste del --> slutt' },
];

test('SRT numbering, comma milliseconds, empty segments skipped', () => {
  assert.equal(toSrt(segs), '1\n00:00:00,000 --> 00:00:23,456\nHei og velkommen.\n\n2\n00:00:50,000 --> 01:02:05,500\nSiste del --> slutt\n');
});

test('WebVTT header, dot milliseconds, arrows escaped in text', () => {
  assert.equal(toVtt(segs), 'WEBVTT\n\n00:00:00.000 --> 00:00:23.456\nHei og velkommen.\n\n00:00:50.000 --> 01:02:05.500\nSiste del -> slutt\n');
});

test('segments restored from an older save without end times still export', () => {
  assert.match(toSrt([{ start: 10, text: 'x' }]), /00:00:10,000 --> 00:00:15,000/);
});
