// The shows that are transcribed as they come out, and what both the server (main.mjs) and the
// GitHub workflow (ci.mjs) need to agree on.
import { createHash } from 'node:crypto';
import { markdown } from '../lib/paragraphs.js';
import { guessNames, hostFromShow, minorVoices, OTHER } from '../lib/speakers.js';
import { extractTerms } from '../lib/context.js';

// `hosts`: the regulars, whom the show notes often call by first name only ("Tommy and Ben").
// They go into each episode's notes, so their names are spelled right and their voices named.
export const SHOWS = [
  { name: 'Pod Save America', appleId: 1192761536, hosts: ['Jon Favreau', 'Jon Lovett', 'Tommy Vietor', 'Dan Pfeiffer'] },
  { name: 'Pod Save the World', appleId: 1200016351, hosts: ['Tommy Vietor', 'Ben Rhodes'] },
  { name: 'The Ezra Klein Show', appleId: 1548604447, hosts: ['Ezra Klein'] },
  { name: 'Making Sense with Sam Harris', appleId: 733163012, hosts: ['Sam Harris'] },
  { name: 'Plain English with Derek Thompson', appleId: 1594471023, hosts: ['Derek Thompson'] },
];

// The notes with the show's hosts named up front (once).
export function notesWithHosts(notes, show) {
  const hosts = (SHOWS.find((s) => s.name === show || show?.startsWith(s.name))?.hosts || []).filter((h) => !(notes || '').startsWith(`Hosts: ${h}`));
  const line = `Hosts: ${hosts.join(', ')}.`;
  return hosts.length && !(notes || '').startsWith('Hosts: ') ? `${line} ${notes || ''}`.trim() : notes || '';
}

// An episode's id, from its feed guid: stable, and safe in a file name.
export const idOf = (guid) => createHash('sha1').update(guid).digest('hex').slice(0, 16);

// The index lists each transcript without its text.
export const metaOf = ({ id, title, show, art, lang, model, total, words, createdAt, transcribedAt, audio, fixes }) =>
  ({ id, title, show, art, lang, model, total, words, createdAt, transcribedAt, audio, fixes });

// The transcript as Markdown, with speakers named the way the app names them.
export function markdownOf(entry) {
  const terms = extractTerms(entry.notes || '', entry.title || '', entry.show || '');
  const guessed = guessNames(entry.segments, terms, { host: hostFromShow(entry.show) });
  const minor = minorVoices(entry.segments, guessed);
  const names = { ...Object.fromEntries([...minor].map((k) => [k, 'Other voice'])), [OTHER]: 'Other voices', ...guessed };
  return markdown(entry.segments, { title: entry.title, show: entry.show, url: entry.source?.url, names });
}
