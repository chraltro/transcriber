// Podcast feeds for the server: find a show's RSS feed through Apple's directory, and read its
// episodes (title, audio, date, notes, art) without an XML library.
import { plainText } from '../lib/context.js';
import { parseFeed as readXml, durationSec } from '../lib/feed.js';

export { durationSec };

const UA = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' };

// The feed as the transcribing needs it: audio episodes only, notes as plain text (they go into
// the speech model's prompt). -> { show, art, language, episodes: [{ guid, title, url, published, notes, art, duration }] }
export function parseFeed(xml) {
  const feed = readXml(xml);
  return {
    show: feed.title,
    art: feed.art,
    language: feed.language,
    episodes: feed.episodes
      .filter((e) => !e.type || /^audio\//.test(e.type))
      .map((e) => ({ guid: e.guid, title: e.title, url: e.url, published: e.published, notes: plainText(e.html), art: e.art || feed.art, duration: e.duration })),
  };
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// The feed URL of a show, by Apple id when known, else by searching its name.
export async function findFeed({ name, appleId }) {
  if (appleId) {
    const res = await fetch(`https://itunes.apple.com/lookup?id=${appleId}&entity=podcast`, { headers: UA, signal: AbortSignal.timeout(20000) });
    const hit = (await res.json()).results?.find((r) => r.feedUrl);
    if (hit) return hit.feedUrl;
  }
  const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(name)}&entity=podcast&limit=10`, { headers: UA, signal: AbortSignal.timeout(20000) });
  const results = (await res.json()).results || [];
  const want = norm(name);
  const hit = results.find((r) => r.feedUrl && norm(r.collectionName) === want)
    || results.find((r) => r.feedUrl && norm(r.collectionName).includes(want))
    || results.find((r) => r.feedUrl);
  if (!hit) throw new Error(`No feed found for ${name}`);
  return hit.feedUrl;
}

export async function readFeed(feedUrl) {
  const res = await fetch(feedUrl, { headers: UA, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Feed ${feedUrl}: HTTP ${res.status}`);
  return parseFeed(await res.text());
}
