import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTerms, buildPrompt, plainText } from '../../lib/context.js';
import { correctText, parseGlossary, soundKey } from '../../lib/glossary.js';
import { looksEchoed } from '../../lib/prompted.js';

const NOTES = `<p>Is AI a normal technology? Arvind Narayanan, a professor at Princeton, and Sayash Kapoor argue against
the doomers. We discuss OpenAI, Nvidia CEO Jensen Huang and Hugging Face.</p><p>Host: Derek Thompson. Email us at
show@example.com or visit https://example.com/show</p>`;

test('show notes give names and terms, not links, stopwords or titles', () => {
  const terms = extractTerms(NOTES, 'Plain English');
  for (const t of ['Arvind Narayanan', 'Sayash Kapoor', 'OpenAI', 'Jensen Huang', 'Hugging Face', 'Derek Thompson', 'Nvidia'])
    assert.ok(terms.includes(t), t);
  assert.ok(!terms.some((t) => /http|@|^Host$|^Is$|^We$/.test(t)), terms.join('|'));
  assert.ok(!plainText(NOTES).includes('<p>'));
});

test('credits and Title Case titles do not become terms', () => {
  const terms = extractTerms(
    'Derek talks with Arvind Narayanan and Sayash Kapoor. Host: Derek Thompson Guests: Arvind Narayanan and Sayash Kapoor Producer: Devon Baroldi Additional Production: Ben Glicksman Visit our site',
    'The Single Smartest Case Against AI Doom', 'Plain English with Derek Thompson');
  for (const t of ['Arvind Narayanan', 'Sayash Kapoor', 'Devon Baroldi', 'Ben Glicksman', 'Derek Thompson']) assert.ok(terms.includes(t), `${t} in ${terms.join('|')}`);
  assert.ok(!terms.some((t) => /Producer|Production|Visit|Smartest|Single/.test(t)), terms.join('|'));
});

test('the prompt holds the glossary and the latest words, within a size limit', () => {
  const p = buildPrompt(['Arvind Narayanan', 'OpenAI'], 'one two three four');
  assert.equal(p, 'Arvind Narayanan, OpenAI. one two three four');
  assert.ok(buildPrompt(Array(200).fill('Longname Here'), 'end of it').length <= 700);
  assert.ok(buildPrompt(Array(200).fill('Longname Here'), 'end of it').endsWith('end of it'));
  assert.equal(buildPrompt([], ''), '');
});

test('near-misses of known names are fixed; everyday phrases are not', () => {
  const terms = ['Arvind Narayanan', 'Sayash Kapoor', 'OpenAI', 'Jensen Huang', 'Hugging Face', 'Derek Thompson'];
  const fix = (t) => correctText(t, { terms });
  assert.equal(fix('Arvind, Narayan, a professor and Slyash Kapoor.'), 'Arvind Narayanan, a professor and Sayash Kapoor.');
  assert.equal(fix('we used hugging phase models'), 'we used Hugging Face models');
  assert.equal(fix('CEO, Jensen Wong said'), 'CEO, Jensen Huang said');
  assert.equal(fix('Derrick Thomson here'), 'Derek Thompson here');
  assert.equal(fix('in the open air of the city'), 'in the open air of the city');
  assert.equal(fix('Arvind Narayanan is right'), 'Arvind Narayanan is right');
  assert.equal(fix('nothing to see'), 'nothing to see');
  assert.equal(fix('at least for the Open Air Hugging Phase incident'), 'at least for the OpenAI Hugging Face incident');
  assert.equal(fix('Open air is nice.'), 'Open air is nice.');
  assert.equal(soundKey('Hugging Phase'), soundKey('hugging face'));
});

test('the reader\'s own glossary: terms and explicit replacements', () => {
  const g = parseGlossary('Claude\nopen air = OpenAI\nFUM -> foom');
  assert.deepEqual(g.terms, ['Claude']);
  assert.deepEqual(g.replace, [['open air', 'OpenAI'], ['FUM', 'foom']]);
  assert.equal(correctText('they left open air for FUM reasons', g), 'they left OpenAI for foom reasons');
  assert.equal(correctText('Cloude is good', { terms: ['Claude'] }), 'Claude is good');
});

test('an output that repeats the prompt or loops is caught', () => {
  assert.equal(looksEchoed('Arvind Narayanan, OpenAI.', 'Arvind Narayanan, OpenAI. and then we'), true);
  assert.equal(looksEchoed('so so so so so so so so so so', ''), true);
  assert.equal(looksEchoed('A normal sentence about bridges.', 'Arvind Narayanan'), false);
});
