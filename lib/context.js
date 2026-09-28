// What Whisper is told before each window: names and terms from the episode's show notes and
// the previous window's words. Whisper spells what it has just "seen", so this keeps guest
// names, products and jargon right and consistent across the whole episode.

const STOP = new Set(`a an and are as at be but by for from has have he her his i if in into is it its
me my no not of on or our she so than that the their them then there these they this those to us was
we were what when where which who why will with you your about after all also any before both can
could did do does each episode every find follow get here how join just like listen listeners more
most new now one only out over part podcast see show some subscribe support thanks today up via watch
week well would yes host guest guests episodes season youtube spotify apple instagram twitter facebook tiktok patreon newsletter`.split(/\s+/));
// Credits: "Producer: Devon Baroldi Additional Production: ..."
const ROLES = new Set(`producer producers produced production additional executive editor edited editing engineer engineering
music mixed mixing visit email contact credits sponsor sponsors sponsored ad ads advertise advertising privacy policy choices
information info transcript rss feed`.split(/\s+/));
for (const w of ROLES) STOP.add(w);

export function plainText(html) {
  return (html || '')
    .replace(/<(br|p|li|div)[^>]*>/gi, '. ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/https?:\/\/\S+|www\.\S+|\S+@\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const isCap = (w) => /^[\p{Lu}][\p{L}'’.-]*$/u.test(w) || /^[\p{L}]*\p{Lu}[\p{L}]*\p{Lu}[\p{L}\d]*$/u.test(w);
const clean = (w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

// Proper nouns and terms: runs of capitalised words ("Arvind Narayanan", "Hugging Face"), and
// words with inner capitals or digits ("OpenAI", "GPT-5"). Most frequent first.
export function extractTerms(...texts) {
  return countTerms(...texts).slice(0, 40).map((x) => x.term);
}

// The same, with how often each term occurs: [{ term, n }].
export function countTerms(...texts) {
  const counts = new Map();
  const add = (t) => {
    const key = t.toLowerCase();
    const prev = counts.get(key);
    counts.set(key, { term: prev?.term || t, n: (prev?.n || 0) + 1 });
  };
  for (const text of texts) {
    const sentences = plainText(text).split(/(?<=[.!?:;])\s+|\s[|•–—-]\s/);
    for (const sentence of sentences) {
      const words = sentence.split(/\s+/);
      // In Title Case Text every word is capitalised, so only names that stand out on their own
      // (inner capitals, acronyms) count.
      const long = words.map(clean).filter((w) => w.length > 3);
      const titleCase = long.length >= 3 && long.every((w) => isCap(w) || /\d/.test(w)) && !long.some((w) => ROLES.has(w.toLowerCase()));
      let run = [];
      const flush = () => {
        while (run.length && STOP.has(run[0].word.toLowerCase())) run.shift();
        while (run.length && STOP.has(run[run.length - 1].word.toLowerCase())) run.pop();
        const first = run.length === 1 && run[0].index === 0; // a lone capital at a sentence start says little
        if (run.length && !first && run.length <= 4) {
          const t = run.map((r) => r.word).join(' ');
          if (t.replace(/[^\p{L}]/gu, '').length >= 3) add(t);
        }
        run = [];
      };
      words.forEach((raw, index) => {
        const word = clean(raw);
        if (!word) { flush(); return; }
        const special = /\p{Ll}\p{Lu}|\p{L}\d|\d\p{L}/u.test(word) || (/^\p{Lu}{2,6}$/u.test(word) && !STOP.has(word.toLowerCase()));
        // A title like "CEO" ends a name run ("Nvidia CEO Jensen Huang" -> Nvidia, Jensen Huang).
        if (/^\p{Lu}{2,5}$/u.test(word) && run.length) { flush(); run.push({ word, index }); flush(); return; }
        if (special || (isCap(word) && !titleCase)) run.push({ word, index });
        else flush();
        if (/[,()"“”]$/.test(raw)) flush();
      });
      flush();
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n);
}

// The prompt: terms first, then the most recent words, which matter most to Whisper.
export function buildPrompt(terms, previous = '', { maxChars = 700 } = {}) {
  const glossary = (terms || []).join(', ');
  const tail = (previous || '').split(/\s+/).slice(-60).join(' ');
  const text = [glossary && `${glossary}.`, tail].filter(Boolean).join(' ');
  return text.length > maxChars ? text.slice(text.length - maxChars).replace(/^\S*\s/, '') : text;
}
