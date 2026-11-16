// Where the server is with an episode, from what the transcribing run writes as it goes
// (library/status.json: server/ci.mjs on GitHub's runners, or server/main.mjs when the server
// transcribes itself): { current: { id, step, position, total, elapsed }, queue: [{ id }],
// updatedAt }. A run writes to it every minute while it works; one not written to for ten
// minutes ended without saying so, and is not believed.

export const STALE_MS = 10 * 60e3;

// status as fetched -> the part still believed, or null.
export function freshStatus(status, now = Date.now()) {
  if (!status || !(now - (status.updatedAt || 0) < STALE_MS)) return null;
  return { current: status.current?.id ? status.current : null, queue: Array.isArray(status.queue) ? status.queue : [], at: status.updatedAt };
}

// -> { step, pct, minutesLeft } while the server is on it (step: 'downloading', 'transcribing',
// 'uploading'; pct and minutesLeft null until they can be told), { ahead } while it waits (how
// many go first), or null.
export function serverJob(status, id) {
  if (!status || !id) return null;
  const c = status.current;
  if (c?.id === id) {
    const position = Number(c.position) || 0;
    const total = Number(c.total) || 0;
    const elapsed = Number(c.elapsed) || 0;
    const step = c.step || (position > 0 ? 'transcribing' : 'downloading');
    const pct = total && step !== 'downloading' ? Math.min(99, Math.floor((100 * position) / total)) : null;
    // (The pace so far, once there is a minute of it to go by; and a minute for the upload.)
    const pace = elapsed >= 60 && position > 0 ? position / elapsed : 0;
    const minutesLeft = step === 'uploading' ? 1 : pace && total ? Math.max(1, Math.round((total - position) / pace / 60 + 1)) : null;
    return { step, pct, minutesLeft };
  }
  const k = (status.queue || []).findIndex((q) => q.id === id);
  return k >= 0 ? { ahead: k + (c ? 1 : 0) } : null;
}

// Short, for a tag on a row: "Transcribing 42%", "Transcript next".
export function jobTag(job) {
  if (!job) return '';
  if (job.step === 'downloading') return 'Transcribing soon';
  if (job.step === 'uploading') return 'Transcript almost ready';
  if (job.step) return job.pct != null ? `Transcribing ${job.pct}%` : 'Transcribing';
  return job.ahead ? `Transcript in line, ${job.ahead} ahead` : 'Transcript next';
}

// A sentence, for the episode's own sheet.
export function jobText(job) {
  if (!job) return '';
  const left = job.minutesLeft ? `, about ${job.minutesLeft} min left` : '';
  if (job.step === 'downloading') return 'The server is getting the audio, to transcribe it now.';
  if (job.step === 'uploading') return 'The server has transcribed it and is sending it over: ready in a minute.';
  if (job.step) return `The server is transcribing this: ${job.pct != null ? `${job.pct}% done` : 'just started'}${left}.`;
  return job.ahead ? `The server transcribes this after ${job.ahead === 1 ? 'the one it is on' : `${job.ahead} others`}.` : 'The server transcribes this next.';
}
