// Which episodes to keep on the device by themselves: for each show set to keep its newest N,
// the newest N it has that have not been played. Pure, so every rule can be tested; ui/autosave.js
// runs it against the store, the downloads and the player.

export const CHOICES = [0, 1, 2, 3, 5];

// Room to leave on the device: 500 MB or a tenth of what the browser allows, whichever is more.
export const RESERVE = 500e6;
export const reserveFor = (quota) => Math.max(RESERVE, (quota || 0) * 0.1);

// Is there room for one more episode of about `size` bytes? (Unknown is taken as room.)
export function roomFor({ usage = 0, quota = 0 } = {}, size = 0) {
  if (!quota) return true;
  return quota - usage - size >= reserveFor(quota);
}

// About how big an episode is before it is fetched: 128 kbit/s, or 80 MB when its length is not known.
export const sizeOf = (ep) => (ep?.duration > 0 ? ep.duration * 16000 : 80e6);

// The wait after `failures` failures in a row: one minute, doubling, at most two hours.
export const backoff = (failures) => (failures > 0 ? Math.min(2 * 3600e3, 60e3 * 2 ** (failures - 1)) : 0);

const done = (rec) => !!rec?.done;
const started = (rec) => !!rec && !rec.done && rec.p > 5;

// shows: [{ id, keep }]; episodesOf(id) -> that show's episodes (any order), or null when not known;
// progress(id) -> the position record; queue: ids; saved: the downloads index ({ id: { auto, ep } });
// declined: ids the listener removed by hand; playingId: what the player holds; keepPlayed: the
// "Keep saved episodes once played" setting.
// -> { fetch: episodes to save, newest first; drop: ids of episodes saved this way to remove }
export function plan({ shows = [], episodesOf = () => null, progress = () => null, queue = [], saved = {}, declined = [], playingId = null, keepPlayed = false }) {
  const skip = new Set(declined);
  const queued = new Set(queue);
  const keepOf = new Map(shows.map((s) => [s.id, s.keep || 0]));
  const wanted = new Map(); // show id -> ids of its newest N not played, or null when its episodes are not known
  const fetch = [];
  for (const [id, keep] of keepOf) {
    if (!keep) continue;
    const eps = episodesOf(id);
    if (!eps) { wanted.set(id, null); continue; }
    const newest = [...eps].filter((e) => e?.id && e.url && !done(progress(e.id)) && !skip.has(e.id))
      .sort((a, b) => (b.published || 0) - (a.published || 0)).slice(0, keep);
    wanted.set(id, new Set(newest.map((e) => e.id)));
    for (const e of newest) if (!saved[e.id]) fetch.push({ ...e, sub: e.sub || id });
  }
  fetch.sort((a, b) => (b.published || 0) - (a.published || 0));

  const drop = [];
  for (const [id, d] of Object.entries(saved)) {
    if (!d?.auto) continue; // saved by hand: never touched
    const rec = progress(id);
    if (id === playingId || queued.has(id) || started(rec)) continue;
    if (done(rec)) { if (!keepPlayed) drop.push(id); continue; }
    const sub = d.ep?.sub;
    if (!keepOf.get(sub)) { drop.push(id); continue; }
    const want = wanted.get(sub);
    if (want && !want.has(id)) drop.push(id);
  }
  return { fetch, drop };
}
