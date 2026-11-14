// Podcast feeds (RSS 2.0 with the iTunes and Podcasting 2.0 tags), read without an XML library
// so the same code runs on the server, in the page and in the tests. Feeds are large (thousands
// of items, megabytes of notes), so items are walked one at a time and everything is capped.

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', aelig: 'æ', oslash: 'ø', aring: 'å', AElig: 'Æ', Oslash: 'Ø', Aring: 'Å', eacute: 'é', egrave: 'è', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', copy: '©', reg: '®', trade: '™' };

// Character references, once ("&amp;lt;" stays "&lt;").
export function decodeEntities(s) {
  return (s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      try { return n > 0 ? String.fromCodePoint(n) : m; } catch { return m; }
    }
    return NAMED[e] ?? m;
  });
}

// A tag's content. Text (titles, guids, links) has its CDATA wrapper removed and its references
// decoded either way, since feeds escape inside CDATA as often as not. HTML (notes) inside CDATA
// is already HTML and is left alone; escaped HTML is decoded once to get there.
const content = (raw, html) => {
  const s = (raw || '').trim();
  const cdata = s.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) return (html ? cdata[1] : decodeEntities(cdata[1])).trim();
  return decodeEntities(s).trim();
};

const tagRe = new Map();
function tag(xml, name, html = false) {
  let re = tagRe.get(name);
  if (!re) tagRe.set(name, re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  const m = xml.match(re);
  return m ? content(m[1], html) : '';
}

const attrRe = new Map();
function attr(xml, name, a) {
  const key = `${name} ${a}`;
  let re = attrRe.get(key);
  if (!re) attrRe.set(key, re = new RegExp(`<${name}\\s[^>]*?\\b${a}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  const m = xml.match(re);
  return m ? decodeEntities(m[1] ?? m[2] ?? '').trim() : '';
}

// Seconds from "1:02:03", "62:03" or "3723".
export function durationSec(s) {
  if (!s) return 0;
  const p = String(s).trim().split(':').map(Number);
  if (!p.length || p.some((x) => Number.isNaN(x))) return 0;
  return Math.round(p.reduce((a, x) => a * 60 + x, 0));
}

// HTML as one line of plain text (for a list row), links left out.
export function summaryOf(html, max = 280) {
  const text = decodeEntities((html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?(?:a|b|i|u|em|strong|span|small|sup|sub|code|mark|font)(?:\s[^>]*)?>/gi, '')
    .replace(/<[^>]+>/g, ' '))
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 40)).replace(/[\s,;:.]+$/, '')}…`;
}

// The app's name for a feed's language tag ("en-us", "nb"), or '' for one it doesn't transcribe.
const LANGS = { en: 'english', nb: 'norwegian', no: 'norwegian', nn: 'norwegian', da: 'danish', fr: 'french', de: 'german', es: 'spanish', it: 'italian' };
export const appLanguage = (code) => LANGS[String(code || '').trim().toLowerCase().split(/[-_]/)[0]] || '';

const AUDIO_FILE = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|m4b)(\?|$)/i;

// -> { title, description, link, art, language, author, movedTo,
//      episodes: [{ guid, title, url, type, published, duration, summary, html, art, season, number, kind, chapters, link }] }
// newest first. `art` on an episode is set only when it has its own. `html` is the notes as the
// feed has them (to be sanitised before they are shown).
export function parseFeed(xml, { maxEpisodes = 1500, maxHtml = 12000 } = {}) {
  const text = String(xml || '');
  const firstItem = text.search(/<item[\s>]/i);
  let head = firstItem < 0 ? text : text.slice(0, firstItem);
  const art = attr(head, 'itunes:image', 'href') || tag(tag(head, 'image'), 'url');
  head = head.replace(/<image[\s>][\s\S]*?<\/image>/i, '');
  const feed = {
    title: tag(head, 'title'),
    description: summaryOf(tag(head, 'description', true) || tag(head, 'itunes:summary', true), 600),
    link: tag(head, 'link'),
    art,
    language: tag(head, 'language'),
    author: tag(head, 'itunes:author'),
    movedTo: tag(head, 'itunes:new-feed-url'),
    episodes: [],
  };
  if (firstItem < 0) return feed;

  const itemRe = /<item[\s>]/gi;
  itemRe.lastIndex = firstItem;
  for (let m = itemRe.exec(text); m && feed.episodes.length < maxEpisodes; m = itemRe.exec(text)) {
    const end = text.indexOf('</item>', m.index);
    const item = text.slice(m.index, end < 0 ? text.length : end);
    if (end >= 0) itemRe.lastIndex = end;
    let url = attr(item, 'enclosure', 'url');
    let type = attr(item, 'enclosure', 'type');
    if (!url) {
      url = attr(item, 'media:content', 'url');
      type = attr(item, 'media:content', 'type');
    }
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (type ? !/^(audio|video)\//i.test(type) : !AUDIO_FILE.test(url) && /\.(jpe?g|png|gif|pdf|html?)(\?|$)/i.test(url)) continue;
    const a = tag(item, 'content:encoded', true);
    const b = tag(item, 'description', true) || tag(item, 'itunes:summary', true);
    const html = (a.length >= b.length ? a : b).slice(0, maxHtml);
    const own = attr(item, 'itunes:image', 'href');
    feed.episodes.push({
      guid: tag(item, 'guid') || url,
      title: tag(item, 'title') || tag(item, 'itunes:title') || 'Untitled episode',
      url,
      type: type.toLowerCase(),
      published: Date.parse(tag(item, 'pubDate')) || 0,
      duration: durationSec(tag(item, 'itunes:duration')),
      summary: summaryOf(tag(item, 'itunes:subtitle') || html),
      html,
      art: own && own !== art ? own : '',
      season: Number(tag(item, 'itunes:season')) || 0,
      number: Number(tag(item, 'itunes:episode')) || 0,
      kind: tag(item, 'itunes:episodeType').toLowerCase(),
      chapters: attr(item, 'podcast:chapters', 'url'),
      link: tag(item, 'link'),
    });
  }
  // Newest first; items the feed dates the same keep the feed's order.
  feed.episodes = feed.episodes.map((e, i) => [e, i]).sort((x, y) => y[0].published - x[0].published || x[1] - y[1]).map(([e]) => e);
  return feed;
}

export const looksLikeFeed = (text) => /<rss[\s>]/i.test(String(text).slice(0, 4000)) && /<channel[\s>]/i.test(String(text).slice(0, 8000));

// The feeds in an OPML file (every podcast app exports one): [{ title, feedUrl }].
export function parseOpml(xml) {
  const out = [];
  const seen = new Set();
  for (const m of String(xml || '').matchAll(/<outline\b[^>]*>/gi)) {
    const el = m[0];
    const get = (a) => {
      const hit = el.match(new RegExp(`\\b${a}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
      return hit ? decodeEntities(hit[1] ?? hit[2] ?? '').trim() : '';
    };
    const feedUrl = get('xmlUrl');
    if (!/^https?:\/\//i.test(feedUrl) || seen.has(feedUrl)) continue;
    seen.add(feedUrl);
    out.push({ title: get('title') || get('text') || feedUrl, feedUrl });
  }
  return out;
}

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function toOpml(shows, title = 'Podcasts') {
  const rows = shows.map((s) => `      <outline type="rss" text="${esc(s.title)}" title="${esc(s.title)}" xmlUrl="${esc(s.feedUrl)}"/>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>${esc(title)}</title></head>\n  <body>\n    <outline text="feeds">\n${rows.join('\n')}\n    </outline>\n  </body>\n</opml>\n`;
}

// The first 16 hex digits of the SHA-1 of an episode's guid: the id the server files its
// transcript under (server/shows.mjs idOf), so the two can be matched up.
export async function episodeId(guid) {
  const bytes = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', new TextEncoder().encode(String(guid))));
  return [...bytes.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
