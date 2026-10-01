// Names Whisper spelled several ways in one transcript ("Sayash", "Sayosh", "Sayyash"), grouped
// so the reader can pick the right one once and have every other spelling fixed.
import { countTerms } from './context.js';
import { editDistance, soundKey, COMMON } from './glossary.js';

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const maxEdits = (len) => (len <= 5 ? 1 : len <= 9 ? 2 : 3);

function alike(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (x === y || x.length < 4 || y.length < 4 || x[0] !== y[0]) return false;
  // The same word inflected ("Regierung", "Regierungen"; "Kapoor", "Kapoors") is not a misspelling.
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (long.startsWith(short) && /^(?:s|es|e|en|n|er|ern|ens|nen)$/.test(long.slice(short.length))) return false;
  const d = Math.min(editDistance(x, y), editDistance(soundKey(a), soundKey(b)));
  return d <= maxEdits(Math.max(x.length, y.length)) && d / Math.max(x.length, y.length) <= 0.34;
}

// [{ variants: [{ text, n }], best }], biggest groups first. `known` spellings (the glossary,
// the show notes) are suggested over merely frequent ones.
// Sentence-initial words ride along with names ("Later Sayosh Kapoor"); they are dropped.
const STARTERS = new Set('later today then so and but well yes no now also here when after before first next sure right okay oh yeah and or because if while since again still just thanks'.split(' '));
function trimStart(term) {
  const words = term.split(/\s+/);
  while (words.length > 1 && (STARTERS.has(words[0].toLowerCase()) || COMMON.has(words[0].toLowerCase()))) words.shift();
  return words.join(' ');
}

// German capitalises every noun, so there single words only count when they are known names.
export function nameGroups(text, known = [], { language } = {}) {
  const merged = new Map();
  for (const { term, n } of countTerms(text)) {
    const t = trimStart(term);
    const k = t.toLowerCase();
    merged.set(k, { term: merged.get(k)?.term || t, n: (merged.get(k)?.n || 0) + n });
  }
  const terms = [...merged.values()].filter((t) => norm(t.term).length >= 4).sort((a, b) => b.n - a.n);
  const knownSet = new Set(known.map(norm));
  const groups = [];
  for (const t of terms) {
    const g = groups.find((grp) => grp.variants.some((v) => alike(v.text, t.term)));
    if (g) g.variants.push({ text: t.term, n: t.n });
    else groups.push({ variants: [{ text: t.term, n: t.n }] });
  }
  return groups
    .filter((g) => g.variants.length > 1)
    .filter((g) => language !== 'german' || g.variants.some((v) => /\s/.test(v.text) || knownSet.has(norm(v.text))))
    .map((g) => {
      const sure = g.variants.find((v) => knownSet.has(norm(v.text)));
      const best = sure ? sure.text : g.variants.slice().sort((a, b) => b.n - a.n)[0].text;
      return { variants: g.variants, best, known: !!sure };
    })
    .sort((a, b) => b.variants.reduce((n, v) => n + v.n, 0) - a.variants.reduce((n, v) => n + v.n, 0));
}

// Glossary lines that turn every other spelling into `right`.
export function glossaryFor(group, right) {
  return [right, ...group.variants.filter((v) => v.text !== right).map((v) => `${v.text} = ${right}`)];
}
