// Every name the server and the shows workflow import from the repo's own modules exists. A
// missing export only shows up when the file is loaded, and server/main.mjs and server/ci.mjs
// are never loaded by the other tests: a lost export once stopped the workflow for days.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const files = [
  ...readdirSync(join(root, 'server')).filter((f) => f.endsWith('.mjs')).map((f) => join(root, 'server', f)),
  ...['app.js', 'worker.js'].map((f) => join(root, f)),
];

test('named imports from local modules exist', async () => {
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const [, names, from] of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.{1,2}\/[^']+)'/g)) {
      const target = resolve(dirname(file), from);
      const mod = await import(pathToFileURL(target).href);
      for (const name of names.split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
        assert.ok(name in mod, `${file.slice(root.length + 1)} imports ${name} from ${from}, which doesn't export it`);
      }
    }
  }
});
