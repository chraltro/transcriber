// The speaker map: who talks when, as a grid of time cells per voice. Pure arithmetic over the
// transcript's timed parts; ui/speakermap.js draws it.

const CELL_STEPS = [15, 30, 60, 120, 180, 300, 600, 900, 1800];

// Cell length in seconds: the shortest round step that fits the episode in `maxCols` cells.
export function cellSeconds(total, maxCols = 48) {
  const fit = CELL_STEPS.find((s) => total / s <= maxCols);
  return fit ?? Math.ceil(total / maxCols / 60) * 60;
}

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

// { cell, cols, rows: [{ speaker, seconds, share: number[] }] }. Rows are voices, loudest first;
// a transcript without speaker labels gets one row (speaker null) for speech in general.
// `share` is the fraction of each cell that voice is talking, 0 to 1.
export function speakerMap(segments, total, { maxCols = 48 } = {}) {
  const segs = (segments || []).filter((s) => s.text && s.end > s.start);
  const end = Math.max(total || 0, ...segs.map((s) => s.end), 1);
  const cell = cellSeconds(end, maxCols);
  const cols = Math.max(1, Math.ceil(end / cell));
  const labelled = segs.some((s) => s.speaker != null);
  const rows = new Map();
  for (const s of segs) {
    const key = labelled ? (s.speaker ?? -1) : null;
    if (labelled && key === -1) continue;
    if (!rows.has(key)) rows.set(key, { speaker: key, seconds: 0, share: new Array(cols).fill(0) });
    const row = rows.get(key);
    row.seconds += s.end - s.start;
    const first = Math.floor(s.start / cell);
    const last = Math.min(cols - 1, Math.floor((s.end - 1e-6) / cell));
    for (let c = first; c <= last; c++) row.share[c] += overlap(s.start, s.end, c * cell, (c + 1) * cell) / cell;
  }
  const out = [...rows.values()].sort((a, b) => b.seconds - a.seconds);
  for (const r of out) r.share = r.share.map((x) => Math.min(1, x));
  return { cell, cols, total: end, rows: out };
}

// Talk time per voice, most first: [{ speaker, seconds, fraction }].
export function talkTime(segments) {
  const by = new Map();
  for (const s of segments || []) {
    if (s.speaker == null || !s.text || !(s.end > s.start)) continue;
    by.set(s.speaker, (by.get(s.speaker) || 0) + (s.end - s.start));
  }
  const all = [...by.values()].reduce((a, b) => a + b, 0) || 1;
  return [...by.entries()].map(([speaker, seconds]) => ({ speaker, seconds, fraction: seconds / all })).sort((a, b) => b.seconds - a.seconds);
}

// The transcript between two times, snapped outwards to whole parts: { from, to, segments }.
export function selection(segments, from, to) {
  const inside = (segments || []).filter((s) => s.text && s.end > from && s.start < to);
  if (!inside.length) return { from, to, segments: [] };
  return { from: Math.min(...inside.map((s) => s.start)), to: Math.max(...inside.map((s) => s.end)), segments: inside };
}
