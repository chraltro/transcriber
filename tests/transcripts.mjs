// Speaker turns from podcasts' published transcripts (tests/speaker-bench.mjs).
const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;|&#x27;|&#39;/g, "'").replace(/&#8220;|&#8221;|&ldquo;|&rdquo;|&quot;/g, '"')
  .replace(/&#8212;|&mdash;/g, ' - ').replace(/&#8211;|&ndash;/g, '-').replace(/&#8230;|&hellip;/g, '...').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

function blocks(html) {
  return decode(html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|section|article|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    // NPR runs a whole transcript together: "ANNOUNCER: ... GREG ROSALSKY: ..."; each capitalised
    // label starts a line of its own.
    .replace(/(?<=[.?!\]"”)…])\s+(?=[A-Z][A-Z.'’ -]{2,40}(?:, [A-Z][A-Z ,.'’-]{1,40})?:\s)/g, '\n')
    .split(/\n/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// Speaker turns from transcript text in any of the usual forms: "COWEN: text", "TERRY GROSS, HOST:
// text", "Rob Wiblin: text", "Lex Fridman (00:01:02) text", or a name on its own line (with or
// without a timestamp) before the paragraphs it says. Only labels that recur count, so a sentence
// that happens to start "Note:" is not a speaker.
const NAME = String.raw`[A-Z][\p{L}.'’-]*(?: [A-Z][\p{L}.'’-]*){0,3}`;
const COLON = new RegExp(`^(${NAME}|[A-Z][A-Z.'’ -]{1,30})(?:, [^:]{1,40})?:\\s+(.+)$`, 'u');
const STAMP = new RegExp(`^(${NAME})\\s*[([]?(\\d{1,2}:\\d{2}(?::\\d{2})?)[)\\]]?\\s*(.*)$`, 'u');
const ALONE = new RegExp(`^(${NAME})$`, 'u');
export function parseTranscript(html) {
  const lines = blocks(html);
  const label = (line) => {
    let m = line.match(STAMP);
    if (m) return { who: m[1], text: m[3] };
    m = line.match(COLON);
    if (m) return { who: m[1], text: m[2] };
    m = line.match(ALONE);
    if (m) return { who: m[1], text: '' };
    return null;
  };
  // Counted by surname, so "TYLER COWEN" once and "COWEN" after are one recurring label.
  const last = (k) => k.split(' ').pop();
  const counts = {};
  for (const l of lines) { const x = label(l); if (x) counts[last(key(x.who))] = (counts[last(key(x.who))] || 0) + 1; }
  const seen = new Set();
  for (const l of lines) { const x = label(l); if (x) seen.add(key(x.who)); }
  const real = new Set([...seen].filter((k) => counts[last(k)] >= 4 && !/^(NOTE|TRANSCRIPT|EPISODE|SHOW NOTES|PREVIOUS|NEXT|SHARE|COPYRIGHT|SPONSOR|ADVERTISEMENT|SOURCES?|RESOURCES|PHOTO|IMAGE|TAGS|LISTEN|SUBSCRIBE|SEE ALSO|READ MORE|RELATED)$/.test(k)));
  const turns = [];
  let cur = null;
  for (const l of lines) {
    const x = label(l);
    if (x && real.has(key(x.who))) {
      cur = { speaker: key(x.who), text: x.text };
      turns.push(cur);
    } else if (cur && l.split(' ').length >= 3) {
      cur.text = `${cur.text} ${l}`.trim();
    }
  }
  // "TYLER COWEN" and later "COWEN" are one person.
  const names = [...new Set(turns.map((t) => t.speaker))];
  for (const t of turns) {
    const full = names.find((n) => n !== t.speaker && n.includes(' ') && last(n) === last(t.speaker));
    if (full && !t.speaker.includes(' ')) t.speaker = full;
  }
  // Page furniture before the conversation ("About Lex Fridman", a bio) is not part of it: start
  // at the first turn of some length.
  const start = turns.findIndex((t) => t.text.split(/\s+/).length >= 25);
  return turns.slice(Math.max(0, start)).filter((t) => t.text.trim() && !/^ABOUT /.test(t.speaker));
}
const key = (who) => who.toUpperCase().replace(/[.'’]/g, '').replace(/\s+/g, ' ').trim();

