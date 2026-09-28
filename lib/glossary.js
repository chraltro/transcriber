// Fixes near-misses of names Whisper can't know ("hugging phase" -> "Hugging Face", "Sayosh
// Kapoor" -> "Sayash Kapoor"), using the terms from the show notes plus the reader's own list.
// Conservative: same first letter, a few edits at most, and only for terms of 5+ letters.

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]/gu, '');

export function editDistance(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

const maxEdits = (len) => (len <= 6 ? 1 : len <= 12 ? 2 : 3);

// A rough sound-alike key, so "hugging phase" meets "Hugging Face".
export function soundKey(s) {
  return norm(s)
    .replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/c(?=[eiy])/g, 's').replace(/[cq]/g, 'k')
    .replace(/x/g, 'ks').replace(/z/g, 's').replace(/y/g, 'i').replace(/(?<=[^aeiou])h/g, '')
    .replace(/([a-z])\1+/g, '$1');
}

// Frequent everyday words. A match that spans a different number of words than the term
// ("open air" for "OpenAI") is only taken when it isn't made of words like these.
export const COMMON = new Set(`the be to of and a in that have it for not on with he as you do at this but his by
from they we say her she or an will my one all would there their what so up out if about who get which go
me when make can like time no just him know take people into year your good some could them see other
than then now look only come its over think also back after use two how our work first well way even new
want because any these give day most us is was are were been has had did said open air new face phase
cloud code in video wong way high hand low light right left big small long short old young great little
own same few more much many such part place case point world life hand week company number group
problem fact`.split(/\s+/));

// User lines: "Term" to watch for, or "wrong = Right" to always replace.
export function parseGlossary(text) {
  const terms = [];
  const replace = [];
  for (const line of (text || '').split(/\n|;/)) {
    const [a, b] = line.split(/\s*(?:=|->|→)\s*/);
    if (b && a.trim()) replace.push([a.trim(), b.trim()]);
    else if (a && a.trim()) terms.push(a.trim());
  }
  return { terms, replace };
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function correctText(text, { terms = [], replace = [] } = {}) {
  if (!text) return text;
  let out = text;
  for (const [wrong, right] of replace) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(wrong)}(?![\\p{L}\\p{N}])`, 'giu'), right);
  }
  const list = [...new Set(terms)].filter((t) => norm(t).length >= 5).sort((a, b) => norm(b).length - norm(a).length);
  if (!list.length) return out;
  const parts = out.split(/(\s+)/);
  const words = [];
  for (let i = 0; i < parts.length; i += 2) words.push(parts[i]);
  const spaces = [];
  for (let i = 1; i < parts.length; i += 2) spaces.push(parts[i]);
  const done = new Array(words.length).fill(false);
  for (const term of list) {
    const tn = norm(term);
    const k = term.split(/\s+/).length;
    for (const n of [k, k + 1, k - 1]) {
      if (n < 1) continue;
      for (let i = 0; i + n <= words.length; i++) {
        if (done.slice(i, i + n).some(Boolean) || !words[i]) continue;
        const span = words.slice(i, i + n);
        const cn = norm(span.join(''));
        if (!cn || cn[0] !== tn[0]) continue;
        const d = Math.min(editDistance(cn, tn), editDistance(soundKey(span.join('')), soundKey(term)));
        const exact = d === 0;
        if (!exact && (d > maxEdits(tn.length) || d / tn.length > 0.2)) continue;
        // Common words ("open air") are left alone, unless they are capitalised mid-sentence
        // ("the Open Air incident"), which is how Whisper writes a name it misheard.
        const midSentence = i > 0 && !/[.!?]["”']?$/.test(words[i - 1] || '.');
        const capitalised = span.every((w) => /^[^\p{L}]*\p{Lu}/u.test(w));
        if (n !== k && span.every((w) => COMMON.has(norm(w))) && !(capitalised && midSentence)) continue;
        const lead = span[0].match(/^[^\p{L}\p{N}]*/u)[0];
        const trail = span[n - 1].match(/[^\p{L}\p{N}]*$/u)[0];
        const inner = span.join(' ');
        if (exact && inner.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '') === term) {
          for (let j = i; j < i + n; j++) done[j] = true; // already right: never part of a longer match
          continue;
        }
        // Inner punctuation ("Arvind, Narayan") only goes when the whole name matched.
        words[i] = `${lead}${term}${trail}`;
        done[i] = true;
        for (let j = i + 1; j < i + n; j++) { words[j] = ''; done[j] = true; spaces[j - 1] = ''; }
      }
    }
  }
  let res = '';
  words.forEach((w, i) => {
    if (w) res += (res && i > 0 ? spaces[i - 1] || ' ' : '') + w;
  });
  return res;
}
