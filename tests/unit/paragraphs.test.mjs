import { test } from 'node:test';
import assert from 'node:assert/strict';
import { continues, tidy, paragraphs, plainText, wordCount, MAX_PARAGRAPH_WORDS } from '../../lib/paragraphs.js';

const seg = (start, text) => ({ start, end: start + 20, text });

test('a window cut mid-sentence continues into the next one', () => {
  assert.equal(continues('It went all the way to the end.', 'of the story, as it turned out.'), true);
  assert.equal(continues('We talked about the', 'Weather in Bergen.'), true); // no sentence end
  assert.equal(continues('That was the first part.', 'The second part is shorter.'), false);
  assert.equal(continues('Hvorfor det?', 'Det er et godt spørsmål.'), false);
  assert.equal(continues('Det var en lang dag.', 'øvelsen tok tid.'), true); // Norwegian lowercase
  assert.equal(continues('', 'anything'), false);
});

test('the stray period at a mid-sentence cut is dropped, ellipses are kept', () => {
  assert.equal(tidy('up to the very end.', 'of the season.'), 'up to the very end');
  assert.equal(tidy('It was relatively...', 'and then more.'), 'It was relatively...');
  assert.equal(tidy('A full stop.', 'Next sentence.'), 'A full stop.');
  assert.equal(tidy('  last one.  ', undefined), 'last one.');
});

test('paragraphs join cut windows and keep each window as its own timed span', () => {
  const p = paragraphs([
    seg(0, 'Welcome back to the show. Today we go all the way to the end.'),
    seg(20, 'of the story. It is a long one.'),
    seg(40, 'Our guest joins us now.'),
    seg(60, ''),
    seg(80, 'Thanks for having me.'),
  ]);
  assert.equal(p.length, 3);
  assert.equal(p[0].start, 0);
  assert.deepEqual(p[0].segs.map((s) => s.start), [0, 20]);
  assert.equal(p[0].segs[0].text, 'Welcome back to the show. Today we go all the way to the end');
  assert.equal(p[2].segs[0].text, 'Thanks for having me.');
});

test('very long run-on paragraphs are still split', () => {
  const long = Array.from({ length: 10 }, (_, i) => seg(i * 20, `${'word '.repeat(40)}and`));
  const p = paragraphs(long);
  assert.ok(p.length > 1);
  for (const para of p) assert.ok(para.segs.length * 41 <= MAX_PARAGRAPH_WORDS + 41);
});

test('plain text uses the paragraphs, optionally with timestamps', () => {
  const segs = [seg(0, 'It went to the end.'), seg(20, 'of the line. Done.'), seg(65, 'New topic.')];
  assert.equal(plainText(segs), 'It went to the end of the line. Done.\n\nNew topic.');
  assert.equal(plainText(segs, { timestamps: true }), '[0:00] It went to the end of the line. Done.\n\n[1:05] New topic.');
  assert.equal(wordCount(segs), 11);
});
