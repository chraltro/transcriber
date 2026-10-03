// Turns Whisper's 30 second windows into readable paragraphs. Windows are cut at pauses, but
// a pause can fall mid-sentence: Whisper then closes the window with a period anyway and starts
// the next one in lowercase ("up to and including the literal end." / "of the human race.").
// Such windows are joined, and the stray period is dropped.
// With timestamps a window arrives as several timed parts (sentences), marked with the window
// they came from (`w`), and with speaker labels each part has a `speaker`.
import { fmtTime } from './text.js';
import { speakerName } from './speakers.js';

const SENTENCE_END = /[.!?…]["'”’»)\]]*$/;
const STARTS_LOWER = /^["'“‘«„¿¡(\[]*\p{Ll}/u;
const STRAY_PERIOD = /([^.])[.?!]$/; // one stop, not an ellipsis: Whisper ends every window with one
export const MAX_PARAGRAPH_WORDS = 150;

const words = (t) => t.split(/\s+/).filter(Boolean).length;

// Does `next` carry on the sentence that `prev` was in the middle of?
export function continues(prev, next) {
  const p = (prev || '').trim();
  const n = (next || '').trim();
  if (!p || !n) return false;
  return STARTS_LOWER.test(n) || !SENTENCE_END.test(p);
}

// A segment's text as shown, given the text of the segment after it.
export function tidy(text, next) {
  const t = (text || '').trim();
  return next && STARTS_LOWER.test(next.trim()) ? t.replace(STRAY_PERIOD, '$1') : t;
}

const sameWindow = (a, b) => a.w != null && a.w === b.w;
export const speakerChange = (prev, seg) => prev.speaker != null && seg.speaker != null && prev.speaker !== seg.speaker;

// Does `seg` start a new paragraph after `prev`, with `count` words in the current one?
// A new voice always does. Otherwise paragraphs end where a window ends a sentence (windows
// are cut at pauses), or at a sentence end once they get long.
export function startsParagraph(prev, seg, count) {
  if (!prev) return true;
  if (speakerChange(prev, seg)) return true;
  const carriesOn = continues(prev.text, seg.text);
  // Long: end at a sentence or a pause between windows, whichever comes first.
  if (count >= MAX_PARAGRAPH_WORDS) return !carriesOn || !sameWindow(prev, seg) || count >= MAX_PARAGRAPH_WORDS * 1.5;
  return !sameWindow(prev, seg) && !carriesOn;
}

// [{ start, speaker, segs: [{ start, end, text }] }], empty segments left out.
export function paragraphs(segments) {
  const segs = segments.filter((s) => s.text && s.text.trim());
  const out = [];
  let cur = null;
  let count = 0;
  segs.forEach((s, i) => {
    const text = tidy(s.text, segs[i + 1]?.text);
    if (!cur || startsParagraph(segs[i - 1], s, count)) {
      cur = { start: s.start, speaker: s.speaker, segs: [] };
      out.push(cur);
      count = 0;
    }
    cur.segs.push({ ...s, text });
    count += words(text);
  });
  return out;
}

export const paragraphText = (p) => p.segs.map((s) => s.text).join(' ');

export function plainText(segments, { timestamps = false, names = {} } = {}) {
  return paragraphs(segments)
    .map((p, i, all) => (timestamps ? `[${fmtTime(p.start)}] ` : '')
      + (p.speaker != null && p.speaker !== all[i - 1]?.speaker ? `${speakerName(p.speaker, names)}: ` : '')
      + paragraphText(p))
    .join('\n\n');
}

export const wordCount = (segments) => segments.reduce((n, s) => n + words(s.text || ''), 0);

// The transcript as Markdown: title, show and link on top, then a paragraph per paragraph,
// each new voice in bold with the time it starts.
const escapeMd = (t) => t.replace(/[\\`*_[\]]/g, '\\$&').replace(/^([#>+-]|\d+\.)(?=\s)/, '\\$1');
export function markdown(segments, { title = '', show = '', url = '', names = {} } = {}) {
  const head = [`# ${escapeMd(title || 'Transcript')}`, show ? `*${escapeMd(show)}*` : '', url ? `<${url}>` : ''].filter(Boolean).join('\n\n');
  const body = paragraphs(segments).map((p, i, all) => {
    const who = p.speaker != null && p.speaker !== all[i - 1]?.speaker ? `**${escapeMd(speakerName(p.speaker, names))}** ` : '';
    return `${who}\`${fmtTime(p.start)}\` ${escapeMd(paragraphText(p))}`;
  }).join('\n\n');
  return `${head}\n\n${body}\n`;
}
