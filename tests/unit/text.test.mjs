import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtTime, normTitle, bestTitleMatch, sameShow, HALLUCINATIONS, dedupeRepeats } from '../../lib/text.js';

test('fmtTime', () => {
  assert.equal(fmtTime(0), '0:00');
  assert.equal(fmtTime(59.6), '1:00');
  assert.equal(fmtTime(3600 + 62), '1:01:02');
  assert.equal(fmtTime(-5), '0:00');
});

test('titles normalize punctuation, curly quotes and case', () => {
  assert.equal(normTitle('Xi’s Just Not That Into You'), normTitle("xi's just not that into you"));
  assert.equal(normTitle('Ærlig talt – del 2!'), 'ærlig talt del 2');
});

const eps = [
  { title: 'Episode 124: The Budget' },
  { title: 'Xi’s Just Not That Into You' },
  { title: 'Trailer' },
  { title: 'The China Question with Ben' },
];

test('exact title matches win', () => {
  assert.equal(bestTitleMatch(eps, "Xi's just not that into you!").title, 'Xi’s Just Not That Into You');
});

test('episode numbers must agree (review finding #7)', () => {
  assert.equal(bestTitleMatch(eps, 'Episode 123: The Budget'), null);
});

test('fuzzy matches need most words in common', () => {
  assert.equal(bestTitleMatch(eps, 'The China Question with Ben Rhodes').title, 'The China Question with Ben');
  assert.equal(bestTitleMatch(eps, 'China'), null);
  assert.equal(bestTitleMatch(eps, ''), null);
});

test('repeated words do not inflate the score', () => {
  assert.equal(bestTitleMatch([{ title: 'the the the the show' }], 'the show about nothing at all'), null);
});

test('sameShow', () => {
  assert.ok(sameShow('Pod Save the World', 'pod save the world'));
  assert.ok(sameShow('The Daily', 'The Daily (NYT)'));
  assert.ok(!sameShow('', 'x'));
});

test('subtitle-credit hallucinations are caught, real speech is kept', () => {
  for (const t of ['Teksting av Nicolai Winther', 'Danske tekster af Nikolaj', 'Takk for at du så på!', 'Thanks for watching!', '(Subtitles by the Amara.org community)'])
    assert.ok(HALLUCINATIONS.test(t), t);
  for (const t of ['Takk for at du så på kampen i går, den var fin. Og så videre.', 'We have a great show for you.'])
    assert.ok(!HALLUCINATIONS.test(t), t);
});

test('runs of identical sentences are cut to two', () => {
  assert.equal(dedupeRepeats('Hei. Hei. Hei. Hei. Hvordan går det? Bra.'), 'Hei. Hei. Hvordan går det? Bra.');
  assert.equal(dedupeRepeats('No repeats here. None at all.'), 'No repeats here. None at all.');
  assert.equal(dedupeRepeats(''), '');
});
