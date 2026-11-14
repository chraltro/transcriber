import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Content blockers (Safari on an iPhone, and the app on its home screen) drop files and hide
// elements whose names look like an ad's. The app's script is one graph of modules: one file
// dropped and nothing starts. It happened with lib/ads.js and lib/adbreaks.js, so nothing the
// page loads or shows is named like that.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BAIT = new Set(['ad', 'ads', 'adv', 'advert', 'adverts', 'advertising', 'advertisement', 'adbreak', 'adbreaks', 'adblock', 'adsense', 'sponsor', 'sponsors', 'sponsored',
  'banner', 'banners', 'promo', 'promos', 'tracking', 'tracker', 'analytics', 'pixel', 'beacon', 'popup', 'popunder', 'skipad']);
const baitIn = (name) => name.toLowerCase().split(/[^a-z]+/).find((token) => BAIT.has(token));

const served = [];
for (const dir of ['', 'lib', 'lib/enhance', 'lib/vendor', 'ui', 'fonts']) {
  for (const f of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (f.isFile() && /\.(js|mjs|css|html|json|webmanifest|png|woff2?)$/.test(f.name) && !/^package/.test(f.name)) served.push(path.posix.join(dir, f.name));
  }
}

test('no file the page loads is named like an ad', () => {
  assert.ok(served.includes('app.js') && served.includes('lib/breaks.js') && served.length > 30, `found ${served.length} files`);
  assert.deepEqual(served.filter(baitIn), []);
});

test('no class or id on the page is named like an ad', () => {
  const found = new Set();
  const note = (names) => { for (const n of names.split(/[\s.#]+/)) if (n && baitIn(n)) found.add(n); };
  for (const m of readFileSync(path.join(ROOT, 'index.html'), 'utf8').matchAll(/\b(?:class|id)="([^"]*)"/g)) note(m[1]);
  for (const m of readFileSync(path.join(ROOT, 'style.css'), 'utf8').matchAll(/[.#](-?[_a-zA-Z][\w-]*)/g)) note(m[1]);
  for (const f of ['app.js', ...readdirSync(path.join(ROOT, 'ui')).filter((n) => n.endsWith('.js')).map((n) => `ui/${n}`)]) {
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/\bh\('([a-z0-9]*(?:[.#][\w-]+)+)'/g)) note(m[1]);
    for (const m of src.matchAll(/classList\.(?:add|remove|toggle|contains)\('([\w-]+)'/g)) note(m[1]);
    for (const m of src.matchAll(/\bclass(?:Name)?\s*[:=]\s*['"`]([\w\s-]+)['"`]/g)) note(m[1]);
  }
  assert.deepEqual([...found], []);
});
