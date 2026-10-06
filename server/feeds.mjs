// Podcast feeds for the server: find a show's RSS feed through Apple's directory, and read its
// episodes (title, audio, date, notes, art) without an XML library.
import { plainText } from '../lib/context.js';

const UA = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' };

const decode = (s) => (s || '')
  .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&')
  .trim();

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
};
const attr = (xml, name, a) => xml.match(new RegExp(`<${name}\\s[^>]*?\\b${a}="([^"]*)"`, 'i'))?.[1] ?? '';

// Seconds from "1:02:03", "62:03" or "3723".
export function durationSec(s) {
  if (!s) return 0;
  const p = String(s).trim().split(':').map(Number);
  if (p.some((x) => Number.isNaN(x))) return 0;
  return p.reduce((a, x) => a * 60 + x, 0);
}

// -> { show, art, episodes: [{ guid, title, url, published, notes, art, duration }] }, newest first.
export function parseFeed(xml) {
  const channel = xml.split(/<item[\s>]/i)[0];
  const show = tag(channel, 'title');
  const art = attr(channel, 'itunes:image', 'href') || tag(tag(channel, 'image'), 'url');
  const episodes = [];
  for (const raw of xml.split(/<item[\s>]/i).slice(1)) {
    const item = raw.split(/<\/item>/i)[0];
    const url = decode(attr(item, 'enclosure', 'url'));
    const type = attr(item, 'enclosure', 'type');
    if (!url || (type && !/^audio\//i.test(type))) continue;
    const title = tag(item, 'title');
    const published = Date.parse(tag(item, 'pubDate')) || 0;
    episodes.push({
      guid: tag(item, 'guid') || url,
      title,
      url,
      published,
      notes: plainText(tag(item, 'content:encoded') || tag(item, 'description') || tag(item, 'itunes:summary')),
      art: decode(attr(item, 'itunes:image', 'href')) || art,
      duration: durationSec(tag(item, 'itunes:duration')),
    });
  }
  episodes.sort((a, b) => b.published - a.published);
  return { show, art, episodes };
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
