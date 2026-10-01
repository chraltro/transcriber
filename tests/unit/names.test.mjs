import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameGroups, glossaryFor } from '../../lib/names.js';
import { isAd } from '../../lib/ads.js';
import { correctText, parseGlossary } from '../../lib/glossary.js';

const TEXT = 'Today with Sayash Kapoor and Arvind Narayanan. Later Sayosh Kapoor said no, and Sayash Kapoor agreed. '
  + 'We talked about Hugging Face, then Hugging Phase again, and Oslo. Arvind Narayan said yes.';

test('variant spellings of a name are grouped, known spellings suggested', () => {
  const groups = nameGroups(TEXT, ['Arvind Narayanan']);
  const kap = groups.find((g) => g.variants.some((v) => v.text === 'Sayosh Kapoor'));
  assert.ok(kap && kap.best === 'Sayash Kapoor', JSON.stringify(groups));
  const nar = groups.find((g) => g.variants.some((v) => v.text === 'Arvind Narayan'));
  assert.equal(nar.best, 'Arvind Narayanan');
  assert.equal(nar.known, true);
  assert.ok(!groups.some((g) => g.variants.some((v) => v.text === 'Oslo')));
});

test('picking a spelling fixes the others through the glossary', () => {
  const kap = nameGroups(TEXT).find((g) => g.variants.some((v) => v.text === 'Sayosh Kapoor'));
  const g = parseGlossary(glossaryFor(kap, 'Sayash Kapoor').join('\n'));
  assert.equal(correctText('Later Sayosh Kapoor said no.', g), 'Later Sayash Kapoor said no.');
});

test('sponsor reads are recognised, ordinary talk is not', () => {
  assert.equal(isAd('This episode is brought to you by Acme. Use code PODCAST for 20% off.'), true);
  assert.equal(isAd('Visit acme.com today and start your free trial.'), true);
  assert.equal(isAd('We went to acme.com to read their paper on bridges.'), false);
  assert.equal(isAd('The trial was free of drama.'), false);
});

test('German nouns and inflections are not offered as names', () => {
  const de = 'Die Regierung hat entschieden. Die Regierungen in Europa streiten. Dann sprach Olaf Scholz mit Olaf Schulz über die Leute und die Laute.';
  const groups = nameGroups(de, [], { language: 'german' });
  assert.ok(!groups.some((g) => g.variants.some((v) => /Regierung|Leute|Laute/.test(v.text))), JSON.stringify(groups));
  assert.ok(groups.some((g) => g.variants.some((v) => v.text === 'Olaf Schulz')), JSON.stringify(groups));
});

test('sponsor reads in other languages', () => {
  assert.equal(isAd('Avec le code promo PODCAST, vous avez 20 % de réduction.'), true);
  assert.equal(isAd('Diese Folge wird präsentiert von Acme.'), true);
  assert.equal(isAd('Este episodio está patrocinado por Acme.'), true);
  assert.equal(isAd('Usa il codice sconto PODCAST.'), true);
  assert.equal(isAd('Il codice della strada è cambiato.'), false);
});
