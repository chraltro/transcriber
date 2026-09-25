// Subtitle files from transcript segments ({ start, end, text } in seconds).

function stamp(sec, sep) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

const cues = (segments) => segments.filter((s) => s.text && s.text.trim());

export function toSrt(segments) {
  return cues(segments)
    .map((s, i) => `${i + 1}\n${stamp(s.start, ',')} --> ${stamp(s.end ?? s.start + 5, ',')}\n${s.text.trim()}\n`)
    .join('\n');
}

export function toVtt(segments) {
  return 'WEBVTT\n\n' + cues(segments)
    .map((s) => `${stamp(s.start, '.')} --> ${stamp(s.end ?? s.start + 5, '.')}\n${s.text.trim().replace(/-->/g, '->')}\n`)
    .join('\n');
}
