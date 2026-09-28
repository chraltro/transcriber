// Subtitle files from transcript segments ({ start, end, text } in seconds).

function stamp(sec, sep) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

import { speakerName } from './speakers.js';

// Cue texts, with the speaker's name in front whenever the voice changes.
function cues(segments, names) {
  const segs = segments.filter((s) => s.text && s.text.trim());
  return segs.map((s, i) => {
    const text = s.text.trim();
    const who = s.speaker != null && s.speaker !== segs[i - 1]?.speaker ? speakerName(s.speaker, names) : '';
    return { ...s, text, who };
  });
}

export function toSrt(segments, names = {}) {
  return cues(segments, names)
    .map((s, i) => `${i + 1}\n${stamp(s.start, ',')} --> ${stamp(s.end ?? s.start + 5, ',')}\n${s.who ? `${s.who}: ` : ''}${s.text}\n`)
    .join('\n');
}

export function toVtt(segments, names = {}) {
  return 'WEBVTT\n\n' + cues(segments, names)
    .map((s) => `${stamp(s.start, '.')} --> ${stamp(s.end ?? s.start + 5, '.')}\n${s.speaker != null ? `<v ${speakerName(s.speaker, names).replace(/[<>&]/g, '')}>` : ''}${s.text.replace(/-->/g, '->')}\n`)
    .join('\n');
}
