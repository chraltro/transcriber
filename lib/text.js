// Text helpers shared by the page and the worker.

export function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return `${h ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export const normTitle = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const numbers = (s) => (s.match(/\d+/g) || []).join(' ');

// Best matching episode for a title. Episode numbers must agree ("Episode 123" never matches
// "Episode 124"), and a fuzzy match needs most words in common.
export function bestTitleMatch(episodes, title, minScore = 0.7) {
  const want = normTitle(title);
  if (!want) return null;
  const exact = episodes.find((e) => normTitle(e.title) === want);
  if (exact) return exact;
  const wantWords = new Set(want.split(' '));
  const wantNumbers = numbers(want);
  let best = null;
  let bestScore = 0;
  for (const e of episodes) {
    const norm = normTitle(e.title || '');
    if (numbers(norm) !== wantNumbers) continue;
    const words = new Set(norm.split(' '));
    let shared = 0;
    for (const w of words) if (wantWords.has(w)) shared++;
    const score = shared / Math.max(wantWords.size, words.size);
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return bestScore >= minScore ? best : null;
}

export const sameShow = (a, b) => {
  const x = normTitle(a || '');
  const y = normTitle(b || '');
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};


// Whisper's classic "I heard silence, so here's a subtitle credit" hallucinations.
// The phrase may be followed by a short credit ("by the Amara.org community") but not by more
// sentences, so real speech that happens to start the same way is kept.
export const HALLUCINATIONS = /^\s*[("[]?\s*(teksting av|tekstet av|undertekst(er)? av|danske tekster|tekster af|tekstning af|subtitles by|thanks? (you )?for watching|takk for at du så på|tak fordi du så med)(?:[^.!?\n]|\.(?=\S)){0,60}[.!?]?\s*[)\]"]?\s*$/i;

// Whisper occasionally gets stuck repeating a phrase. Drop runs of identical sentences.
export function dedupeRepeats(text) {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  const out = [];
  let run = 0;
  for (const s of sentences) {
    const norm = s.trim().toLowerCase();
    const prev = out.length ? out[out.length - 1].trim().toLowerCase() : null;
    run = norm && norm === prev ? run + 1 : 0;
    if (run < 2) out.push(s);
  }
  return collapseLoops(out.join('').trim());
}

// Small models also loop inside a sentence ("jeg har vært sånn jeg har vært sånn ..." or one
// word dozens of times). Any run of 1 to 8 words repeated back to back more than twice is
// cut to two copies.
const MAX_LOOP = 8;
export function collapseLoops(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const key = words.map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));
  const out = [];
  let i = 0;
  while (i < words.length) {
    let skipped = false;
    for (let n = 1; n <= MAX_LOOP && i + 3 * n <= words.length; n++) {
      const same = (a, b) => { for (let k = 0; k < n; k++) if (key[a + k] !== key[b + k] || !key[a + k]) return false; return true; };
      let reps = 1;
      while (i + (reps + 1) * n <= words.length && same(i, i + reps * n)) reps++;
      if (reps > 2) {
        out.push(...words.slice(i, i + 2 * n));
        i += reps * n;
        skipped = true;
        break;
      }
    }
    if (!skipped) out.push(words[i++]);
  }
  return out.join(' ');
}
