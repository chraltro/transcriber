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

// The notes with the show's hosts named up front (once), as a sentence: a line of names alone
// reads as a title, which the term extraction skips (lib/context.js).
const HOSTED = 'This show is hosted by ';
export function notesWithHosts(notes, show) {
  const hosts = SHOWS.find((s) => s.name === show || show?.startsWith(s.name))?.hosts || [];
  if (!hosts.length || (notes || '').startsWith(HOSTED)) return notes || '';
  const list = hosts.length > 1 ? `${hosts.slice(0, -1).join(', ')} and ${hosts[hosts.length - 1]}` : hosts[0];
  return `${HOSTED}${list}. ${notes || ''}`.trim();
}
