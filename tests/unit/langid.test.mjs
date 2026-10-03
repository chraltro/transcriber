import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foreignLanguage, languageName } from '../../lib/langid.js';

test('a window clearly in another language is flagged', () => {
  const f = foreignLanguage({ en: 0.01, no: 0.93, da: 0.04, sv: 0.02 }, 'english');
  assert.equal(f.code, 'no');
  assert.equal(f.name, 'Norwegian');
});

test('accented or mixed speech is never flagged', () => {
  assert.equal(foreignLanguage({ en: 0.4, de: 0.55 }, 'english'), null); // too much English
  assert.equal(foreignLanguage({ en: 0.06, de: 0.9 }, 'english'), null); // English above 5%
  assert.equal(foreignLanguage({ en: 0.02, de: 0.6, nl: 0.38 }, 'english'), null); // not sure which
  assert.equal(foreignLanguage(null, 'english'), null);
});

test("both written forms of Norwegian are the episode's own language", () => {
  assert.equal(foreignLanguage({ nn: 0.9, no: 0.08, en: 0.02 }, 'norwegian'), null);
  assert.equal(foreignLanguage({ en: 0.95, no: 0.03 }, 'norwegian').code, 'en');
  assert.equal(languageName('da'), 'Danish');
});
