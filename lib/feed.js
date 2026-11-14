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
  const cdata = s.startsWith('<![CDATA[') && s.endsWith(']]>') ? s.slice(9, -3) : null;
  if (cdata != null) return (html ? cdata : decodeEntities(cdata)).trim();
  return decodeEntities(s).trim();
};

// Tags are found by walking the text, never with a pattern that can retry from every position:
// a feed is other people's text, and one made of a million unclosed tags must cost a moment,
// not an hour.

// The first <name ...> at or after `from`: { end: index of its '>', text: the tag itself }.
function open(xml, name, from = 0) {
  const start = `<${name}`;
  for (let i = xml.indexOf(start, from); i >= 0; i = xml.indexOf(start, i + 1)) {
    const c = xml[i + start.length];
    if (c !== '>' && c !== '/' && c !== ' ' && c !== '\n' && c !== '\t' && c !== '\r') continue;
    const end = xml.indexOf('>', i);
    return end < 0 ? null : { at: i, end, text: xml.slice(i, Math.min(end + 1, i + 4096)) };
  }
  return null;
}

function tag(xml, name, html = false) {
  const o = open(xml, name);
  if (!o || xml[o.end - 1] === '/') return '';
  const close = xml.indexOf(`</${name}>`, o.end);
  return close < 0 ? '' : content(xml.slice(o.end + 1, close), html);
}

const attrRe = new Map();
const attrIn = (text, a) => {
  let re = attrRe.get(a);
  if (!re) attrRe.set(a, re = new RegExp(`\\s${a}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  const m = text.match(re);
  return m ? decodeEntities(m[1] ?? m[2] ?? '').trim() : null;
};
function attr(xml, name, a) {
  for (let o = open(xml, name); o; o = open(xml, name, o.end)) {
    const v = attrIn(o.text, a);
    if (v != null) return v;
  }
  return '';
}

// Podlove Simple Chapters written into an episode: [{ start: "00:12:34.000", title }], the
// times as written (lib/chapters.js reads them).
function pscOf(item) {
  const out = [];
  for (let o = open(item, 'psc:chapter'); o && out.length < 500; o = open(item, 'psc:chapter', o.end)) out.push({ start: attrIn(o.text, 'start') || '', title: attrIn(o.text, 'title') || '' });
  return out;
}

// HTML with its tags taken out (a space where a block ended), scripts and styles with them.
function stripTags(html) {
  let out = '';
  for (let i = 0; i < html.length;) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    const gt = html.indexOf('>', lt);
    if (gt < 0) break;
    const name = html.slice(lt + 1, Math.min(gt, lt + 12)).toLowerCase().match(/^\/?([a-z0-9]+)/)?.[1] || '';
    if ((name === 'script' || name === 'style') && html[lt + 1] !== '/') {
      const close = html.toLowerCase().indexOf(`</${name}`, gt);
      if (close < 0) break;
      i = close;
      continue;
    }
    if (!INLINE.has(name)) out += ' ';
    i = gt + 1;
  }
  return out;
}
const INLINE = new Set(['a', 'b', 'i', 'u', 'em', 'strong', 'span', 'small', 'sup', 'sub', 'code', 'mark', 'font']);

// Seconds from "1:02:03", "62:03" or "3723".
export function durationSec(s) {
  if (!s) return 0;
  const p = String(s).trim().split(':').map(Number);
  if (!p.length || p.some((x) => Number.isNaN(x))) return 0;
  return Math.round(p.reduce((a, x) => a * 60 + x, 0));
}

// HTML as one line of plain text (for a list row), links left out.
export function summaryOf(html, max = 280) {
  const text = decodeEntities(stripTags(String(html || '').slice(0, Math.max(4000, max * 6))))
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
//      episodes: [{ guid, title, url, type, published, duration, summary, html, art, season, number, kind, chapters, psc, link }] }
// newest first. `art` on an episode is set only when it has its own. `html` is the notes as the
// feed has them (to be sanitised before they are shown). `chapters` is the address of a
// Podcasting 2.0 chapters file, `psc` the chapters written into the feed itself.
export function parseFeed(xml, { maxEpisodes = 1500, maxHtml = 12000 } = {}) {
  const text = String(xml || '');
  const firstItem = text.search(/<item[\s>]/);
  // What comes before the first episode is about the show (a few kilobytes; never megabytes).
  let head = (firstItem < 0 ? text : text.slice(0, firstItem)).slice(0, 400000);
  const art = attr(head, 'itunes:image', 'href') || tag(tag(head, 'image'), 'url');
  const img = open(head, 'image');
  const imgEnd = img ? head.indexOf('</image>', img.end) : -1;
  if (imgEnd >= 0) head = head.slice(0, img.at) + head.slice(imgEnd + 8);
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

  const itemRe = /<item[\s>]/g;
  itemRe.lastIndex = firstItem;
  for (let m = itemRe.exec(text); m && feed.episodes.length < maxEpisodes; m = itemRe.exec(text)) {
    const end = text.indexOf('</item>', m.index);
    // An episode is a few kilobytes of text; one that never closes is the last one read.
    const item = text.slice(m.index, Math.min(end < 0 ? text.length : end, m.index + 300000));
    itemRe.lastIndex = end < 0 ? text.length : end;
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
      psc: pscOf(item),
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
