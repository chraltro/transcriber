// An episode's chapters, from wherever the show wrote them: a Podcasting 2.0 chapters file
// (JSON, fetched by the server), Podlove Simple Chapters in the feed, or a list of times in the
// show notes. Every source comes out the same: [{ start (seconds), title }], in order.
import { decodeEntities } from './feed.js';

const MAX = 500;

// Seconds from a number, "754", "12:34", "1:02:03" or "00:12:34.000", or NaN.
export function seconds(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = s.match(/^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?(?:[.,](\d{1,3}))?$/);
  if (!m) return NaN;
  const parts = [m[1], m[2], m[3]].filter((x) => x != null).map(Number);
  if (parts.slice(1).some((x) => x > 59)) return NaN;
  const whole = parts.reduce((a, x) => a * 60 + x, 0);
  return m[4] ? whole + Number(`0.${m[4]}`) : whole;
}

// A title as a list shows it: one line, without the dashes, colons and brackets that stood
// between it and its time.
const clean = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().replace(/^\[([^\]]*)\]$|^\(([^)]*)\)$/, '$1$2')
  .replace(/^[\s\-–—:|.)\]•·*]+/, '').replace(/[\s\-–—:|([]+$/, '').trim().slice(0, 200);

// Any list of { start, title } as the page uses it: in order, one chapter per moment (the first
// written wins), titled, inside the episode when its length is known. A single chapter is no
// way of getting about, so fewer than two is none.
export function tidy(list, duration = 0) {
  const out = [];
  const sorted = (Array.isArray(list) ? list : []).map((c) => ({ start: seconds(c?.start), title: clean(c?.title) }))
    .filter((c) => Number.isFinite(c.start) && c.start >= 0 && c.title && !(duration > 0 && c.start >= duration))
    .sort((a, b) => a.start - b.start);
  for (const c of sorted) {
    if (out.length && c.start - out[out.length - 1].start < 1) continue;
    out.push({ start: Math.round(c.start * 1000) / 1000, title: c.title });
    if (out.length >= MAX) break;
  }
  return out.length >= 2 ? out : [];
}

// A Podcasting 2.0 chapters file ({ chapters: [{ startTime, title, toc? }] }). Chapters marked
// toc: false are there for their pictures or links, not to be listed.
export function fromJson(json) {
  const list = Array.isArray(json?.chapters) ? json.chapters : [];
  return tidy(list.filter((c) => c && typeof c === 'object' && c.toc !== false).map((c) => ({ start: c.startTime, title: typeof c.title === 'string' ? c.title : '' })));
}

// Podlove Simple Chapters as lib/feed.js reads them ([{ start: "00:12:34.000", title }]).
export const fromPsc = (list) => tidy(list);

// Show notes as lines of text: a line ends where a paragraph, list item or <br> does; links and
// emphasis are taken out around their text (a time is often a link).
const BREAKS = new Set(['br', 'p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'tr', 'td', 'th', 'dt', 'dd', 'hr', 'pre', 'section', 'table']);
function linesOf(html) {
  const s = String(html || '').slice(0, 200000);
  let out = '';
  for (let i = 0; i < s.length;) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { out += s.slice(i); break; }
    out += s.slice(i, lt);
    const gt = s.indexOf('>', lt);
    if (gt < 0) break;
    const name = s.slice(lt + 1, Math.min(gt, lt + 14)).toLowerCase().match(/^\/?([a-z0-9]+)/)?.[1] || '';
    if ((name === 'script' || name === 'style') && s[lt + 1] !== '/') {
      const close = s.toLowerCase().indexOf(`</${name}`, gt);
      if (close < 0) break;
      i = close;
      continue;
    }
    if (BREAKS.has(name)) out += '\n';
    i = gt + 1;
  }
  return decodeEntities(out).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// "12:34 Title", "(1:02:03) Title", "00:00:00 - Intro", "[05:10] Title", "• 05:10: Title".
const LINE = /^(?:[-*•·]\s*)?[[(]?(\d{1,2}:\d{2}(?::\d{2})?)[\])]?(?:\s*[-–—:|.]+\s*|\s+)(\S.*)$/;

// Chapters from times that begin lines of the notes. A time or two in passing ("we get to that
// at 12:30") is not a list of chapters: it takes three or more, in order, the first within the
// first five minutes.
export function fromNotes(html) {
  const found = [];
  for (const line of linesOf(html)) {
    const m = line.match(LINE);
    if (!m) continue;
    const start = seconds(m[1]);
    if (Number.isFinite(start) && clean(m[2])) found.push({ start, title: m[2] });
  }
  if (found.length < 3 || found[0].start > 300) return [];
  for (let i = 1; i < found.length; i++) if (found[i].start <= found[i - 1].start) return [];
  return tidy(found);
}

// The index of the chapter playing at `t`, or -1 before the first. (A position a hair before a
// chapter's start, where a jump to it can land, counts as in it.)
export function chapterAt(list, t) {
  let i = -1;
  for (let k = 0; k < (list?.length || 0); k++) {
    if (list[k].start <= t + 0.3) i = k; else break;
  }
  return i;
}
