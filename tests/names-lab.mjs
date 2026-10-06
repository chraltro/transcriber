// Names lab: every transcript on transcriber.demant.app through the name guessing, with what it
// had to go on (names from the show notes, introductions heard, talk per voice) and what it
// decided. Run by .github/workflows/names-lab.yml.
import { extractTerms } from '../lib/context.js';
import { guessNames, hostFromShow, minorVoices } from '../lib/speakers.js';
import { notesWithHosts } from '../server/shows.mjs';

const SITE = process.env.SITE || 'https://transcriber.demant.app';
const index = await (await fetch(`${SITE}/library/index.json`)).json();
for (const meta of index.entries) {
  const e = await (await fetch(`${SITE}/library/${meta.id}.json`)).json();
  e.notes = notesWithHosts(e.notes, e.show); // as the shows workflow now stores them
  const terms = extractTerms(e.notes || '', e.title || '', e.show || '');
  const host = hostFromShow(e.show);
  const talk = {};
  for (const s of e.segments) if (s.speaker != null) talk[s.speaker] = (talk[s.speaker] || 0) + (s.end - s.start);
  const names = guessNames(e.segments, terms, { host });
  console.log(`\n=== ${e.show}: ${e.title} (${Math.round(e.total / 60)} min, ${e.words} words)`);
  console.log(`notes: ${(e.notes || '').slice(0, 700)}`);
  console.log(`terms: ${JSON.stringify(terms)}`);
  console.log(`host from show name: ${host}`);
  console.log(`talk seconds per voice: ${JSON.stringify(Object.fromEntries(Object.entries(talk).map(([k, v]) => [k, Math.round(v)])))}`);
  console.log(`names: ${JSON.stringify(names)}; minor: ${JSON.stringify([...minorVoices(e.segments, names)])}`);
  for (const s of e.segments) {
    if (/(?<![\p{L}])(I'm|I am|my name is|welcome)\b/iu.test(s.text) || /(?:^|[.?!]\s+)\p{Lu}[\p{L}'’-]+,\s/u.test(s.text) && s.start < 900) {
      console.log(`  [${Math.round(s.start)}s v${s.speaker}] ${s.text.slice(0, 200)}`);
    }
  }
  console.log('  first minutes:');
  for (const s of e.segments.filter((x) => x.start < 240)) console.log(`    [${Math.round(s.start)}s v${s.speaker}] ${s.text.slice(0, 160)}`);
}
