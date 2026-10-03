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
  assert.equal(foreignLanguage({ en: 0.25, de: 0.72 }, 'english'), null); // English above 20%
  assert.equal(foreignLanguage({ en: 0.04, de: 0.3, fr: 0.3, ja: 0.36 }, 'english'), null); // no clear language
  assert.equal(foreignLanguage(null, 'english'), null);
});

test("both written forms of Norwegian are the episode's own language", () => {
  assert.equal(foreignLanguage({ nn: 0.9, no: 0.08, en: 0.02 }, 'norwegian'), null);
  assert.equal(foreignLanguage({ en: 0.95, no: 0.03 }, 'norwegian').code, 'en');
  assert.equal(languageName('da'), 'Danish');
});

test('close neighbours are never foreign: a Norwegian window heard as Danish stays Norwegian', () => {
  assert.equal(foreignLanguage({ da: 0.9, no: 0.04, en: 0.01 }, 'norwegian'), null);
  assert.equal(foreignLanguage({ no: 0.9, da: 0.04 }, 'danish'), null);
  // But English in a Norwegian show is.
  assert.equal(foreignLanguage({ en: 0.92, no: 0.04 }, 'norwegian').code, 'en');
});

test("Tiny's split between neighbours still counts: Norwegian heard as half Swedish is foreign to English", () => {
  const f = foreignLanguage({ no: 0.53, sv: 0.46, en: 0.01 }, 'english');
  assert.equal(f.code, 'no');
  assert.ok(f.prob > 0.95);
  assert.equal(foreignLanguage({ de: 0.49, da: 0.33, en: 0.13 }, 'english').code, 'de'); // Danish heard as half German, 13% English
  assert.equal(foreignLanguage({ en: 0.75, es: 0.05 }, 'english'), null); // the least English an English window got
  assert.equal(foreignLanguage({ da: 0.44, de: 0.38, en: 0.04, sv: 0.1 }, 'english').code, 'da');
});
