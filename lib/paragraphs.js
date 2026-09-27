// Turns Whisper's 30 second windows into readable paragraphs. Windows are cut at pauses, but
// a pause can fall mid-sentence: Whisper then closes the window with a period anyway and starts
// the next one in lowercase ("up to and including the literal end." / "of the human race.").
// Such windows are joined, and the stray period is dropped.
import { fmtTime } from './text.js';

const SENTENCE_END = /[.!?…]["'”’»)\]]*$/;
const STARTS_LOWER = /^["'“‘«(\[]*\p{Ll}/u;
const STRAY_PERIOD = /([^.])\.$/; // one period, not an ellipsis
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

// [{ start, segs: [{ start, end, text }] }], empty segments left out.
export function paragraphs(segments) {
  const segs = segments.filter((s) => s.text && s.text.trim());
  const out = [];
  let cur = null;
  let count = 0;
  segs.forEach((s, i) => {
    const text = tidy(s.text, segs[i + 1]?.text);
    if (!cur || !continues(segs[i - 1].text, s.text) || count >= MAX_PARAGRAPH_WORDS) {
      cur = { start: s.start, segs: [] };
      out.push(cur);
      count = 0;
    }
    cur.segs.push({ ...s, text });
    count += words(text);
  });
  return out;
}

export const paragraphText = (p) => p.segs.map((s) => s.text).join(' ');

export function plainText(segments, { timestamps = false } = {}) {
  return paragraphs(segments)
    .map((p) => (timestamps ? `[${fmtTime(p.start)}] ` : '') + paragraphText(p))
    .join('\n\n');
}

export const wordCount = (segments) => segments.reduce((n, s) => n + words(s.text || ''), 0);
