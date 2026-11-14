// Which episodes the shows workflow transcribes in a run, and in what order (server/ci.mjs).
// Nothing is kept between runs: what is wanted follows from what the site already has.
import { idOf, notesWithHosts } from './shows.mjs';
import { appLanguage } from '../lib/feed.js';

// shows: [{ name, feedUrl?, appleId?, lang?, fresh, backfill }]
//   fresh: its new episodes. A show with nothing on the site yet gets its newest episode; after
//     that, every episode since the oldest one the site has that it doesn't have yet (so one
//     that had to wait is never passed over). Never older than `maxAgeDays`.
//   backfill: also its latest so many episodes, however old.
// asked: [{ id, feedUrl, title }], single episodes asked for in the app.
// index: the site's library index. feedOf(show) -> { show, language, episodes } (server/feeds.mjs).
// -> episodes to do, in order: new ones first, oldest first so they come out in order; then the
// ones asked for; then going back through a show's latest, newest first.
export async function planQueue({ shows, asked = [], index, feedOf, now = Date.now(), maxAgeDays = 14, log = () => {} }) {
  const have = new Set(index.entries.map((e) => e.id));
  const queue = [];
  const add = (ep, name, lang, rank) => {
    const id = idOf(ep.guid);
    if (have.has(id) || queue.some((q) => q.id === id)) return false;
    queue.push({ ...ep, id, show: name, lang, rank, notes: notesWithHosts(ep.notes, name) });
    return true;
  };
  for (const show of shows) {
    try {
      const feed = await feedOf(show);
      const name = feed.show || show.name;
      const lang = show.lang || appLanguage(feed.language) || 'english';
      const mine = index.entries.filter((e) => e.show === name);
      const first = Math.min(...mine.map((e) => e.createdAt || 0));
      const fresh = feed.episodes.filter((ep) => ep.published > now - maxAgeDays * 864e5);
      const wanted = show.fresh === false ? [] : mine.length ? fresh.filter((ep) => ep.published >= first) : fresh.slice(0, 1);
      const n = wanted.filter((ep) => add(ep, name, lang, 0)).length;
      const back = feed.episodes.slice(0, show.backfill || 0).filter((ep) => add(ep, name, lang, 2)).length;
      log(`${name}: ${feed.episodes.length} episodes, ${mine.length} on the site, ${n} new to do${back ? `, ${back} to go back for` : ''}`);
    } catch (err) {
      log(`${show.name}: feed check failed: ${err.message}`);
    }
  }
  for (const one of asked) {
    try {
      const feed = await feedOf({ name: one.title, feedUrl: one.feedUrl });
      const ep = feed.episodes.find((e) => idOf(e.guid) === one.id);
      if (!ep) { log(`asked for, but not in its feed any more: ${one.title}`); continue; }
      if (add(ep, feed.show || one.title, appLanguage(feed.language) || 'english', 1)) log(`asked for: ${feed.show}: ${ep.title}`);
    } catch (err) {
      log(`asked for ${one.title}: feed check failed: ${err.message}`);
    }
  }
  return queue.sort((a, b) => a.rank - b.rank || (a.rank === 2 ? b.published - a.published : a.published - b.published));
}
