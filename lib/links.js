// Pure helpers for turning podcast links, feeds and pages into audio URLs.

export const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|mp4|m4b|webm)$/i;
export const AUDIO_URL_IN_TEXT = /https?:\\?\/\\?\/[^"'\s<>()]+?\.(?:mp3|m4a|aac|ogg|opus|wav|m4b)(?:\?[^"'\s<>()]*)?(?=["'\s<>()]|$)/gi;

const FILE_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|mp4|m4b|webm|html?|php|aspx?|json|xml|rss)$/i;

// Podcast audio URLs are often wrapped in tracking redirects, e.g.
// https://dts.podtrac.com/redirect.mp3/audioboom.com/posts/1.mp3. Some of those hops don't
// allow browser downloads even when the real host does, so also try each embedded URL.
export function audioCandidates(url) {
  const out = [url];
  let u;
  try { u = new URL(url); } catch { return out; }
  const encoded = u.pathname.match(/https?%3A%2F%2F.+$/i);
  if (encoded) out.push(decodeURIComponent(encoded[0]));
  const segs = u.pathname.split('/');
  const inner = [];
  for (let i = 1; i < segs.length - 1; i++) {
    const seg = segs[i];
    // A host looks like name.tld; file names such as redirect.mp3 or track.aac are not hosts.
    if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(seg) && !FILE_EXT.test(seg)) inner.push(`https://${segs.slice(i).join('/')}${u.search}`);
  }
  out.push(...inner.reverse());
  return [...new Set(out)];
}

function textOf(parent, tag) {
  return parent.getElementsByTagName(tag)[0]?.textContent?.trim() || '';
}

// Cover art of a channel or item: <itunes:image href> or <image><url>, as a direct child only
// (a channel's descendants include every item's art).
function imageOf(el) {
  const kids = [...(el.children || [])];
  const it = kids.find((c) => c.tagName === 'itunes:image' && c.getAttribute('href'));
  if (it) return it.getAttribute('href').trim();
  const img = kids.find((c) => c.tagName === 'image');
  return img ? textOf(img, 'url') : '';
}

export function parseFeed(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) return null;
  const channel = doc.getElementsByTagName('channel')[0] || doc.documentElement;
  const title = textOf(channel, 'title');
  const image = imageOf(channel);
  const episodes = [];
  for (const item of doc.getElementsByTagName('item')) {
    const enc = item.getElementsByTagName('enclosure')[0];
    const url = enc?.getAttribute('url') || textOf(item, 'media:content');
    if (!url) continue;
    episodes.push({
      title: textOf(item, 'title') || 'Untitled episode',
      url,
      date: textOf(item, 'pubDate'),
      duration: textOf(item, 'itunes:duration'),
      art: imageOf(item) || image,
      notes: (textOf(item, 'description') || textOf(item, 'itunes:summary') || textOf(item, 'content:encoded')).slice(0, 4000),
    });
  }
  return { title, image, episodes };
}

export const looksLikeFeed = (text) => /<(rss|feed)[\s>]/i.test(text.slice(0, 2000)) && /<(item|entry)[\s>]/i.test(text);

export function findAudioInHtml(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const abs = (u) => { try { return new URL(u, baseUrl).href; } catch { return null; } };
  const title = doc.querySelector('meta[property="og:title"]')?.content || doc.title || '';

  const direct =
    doc.querySelector('meta[property="og:audio"], meta[property="og:audio:url"], meta[property="og:audio:secure_url"]')?.content ||
    doc.querySelector('meta[name="twitter:player:stream"]')?.content ||
    doc.querySelector('audio[src]')?.getAttribute('src') ||
    doc.querySelector('audio source[src]')?.getAttribute('src');
  if (direct) return { kind: 'audio', url: abs(direct), title };
  const ld = structuredEpisode(doc);
  if (ld?.url) return { kind: 'audio', url: abs(ld.url), title: ld.title || title, show: ld.show || undefined };

  // Only trust a bare audio URL in the page source if it's the only one; pages listing
  // several episodes would otherwise hand us the wrong one.
  const found = new Set((html.match(AUDIO_URL_IN_TEXT) || []).map((m) => m.replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&')));
  if (found.size === 1) return { kind: 'audio', url: [...found][0], title };

  const feed = doc.querySelector('link[type="application/rss+xml"], link[type="application/atom+xml"]')?.getAttribute('href');
  if (feed) return { kind: 'feed', url: abs(feed), title };
  return null;
}

// Links pasted without a scheme ("podcasts.apple.com/…", from some share sheets) get https://.
// Returns '' for text that isn't a link at all.
export function normalizeLink(raw) {
  const t = (raw || '').trim().replace(/^<|>$/g, '');
  const found = t.match(/https?:\/\/\S+/i)?.[0];
  if (found) return found.replace(/[)\].,;!?'"»”]+$/, '');
  if (/^[\w-]+(\.[\w-]+)+\.?(:\d+)?(\/\S*)?$/i.test(t) && /\.[a-z]{2,}(:\d+)?(\/|$)/i.test(t)) return `https://${t}`;
  return '';
}

/* ---------- links from video sites and podcast apps ---------- */

// The video id of any YouTube link: watch, youtu.be, shorts, live, embed, music.youtube.com.
export function youtubeId(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') return u.pathname.split('/')[1]?.match(/^[\w-]{11}$/)?.[0] || null;
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;
  const v = u.searchParams.get('v');
  if (v && /^[\w-]{11}$/.test(v)) return v;
  return u.pathname.match(/^\/(?:shorts|live|embed|v|e)\/([\w-]{11})/)?.[1] || null;
}

// Dropbox share links ("…?dl=0") point at a preview page; the same path on
// dl.dropboxusercontent.com is the file itself, and that host lets web pages download it.
export function dropboxDirect(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/(^|\.)dropbox\.com$/.test(u.hostname) || !/^\/(s|scl|sh)\//.test(u.pathname)) return null;
  u.hostname = 'dl.dropboxusercontent.com';
  u.searchParams.delete('dl');
  return u.href;
}

// "Just a moment..." pages (Cloudflare) stand in for the real page when a site doesn't trust
// the visitor; they say nothing about the episode.
export const isChallengePage = (html) => /<title>\s*(just a moment|attention required|access denied|verify you are human)/i.test(html || '') || /challenge-platform|cf-browser-verification/i.test(html || '');

// Episode details in a page's structured data (schema.org PodcastEpisode, AudioObject), which
// most podcast apps put in their episode pages for search engines.
export function structuredEpisode(doc) {
  const found = [];
  const walk = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const type = [].concat(x['@type'] || []).join(' ');
    if (/PodcastEpisode|AudioObject|RadioEpisode|Episode/.test(type)) found.push(x);
    for (const k of Object.keys(x)) if (typeof x[k] === 'object') walk(x[k]);
  };
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try { walk(JSON.parse(s.textContent)); } catch {}
  }
  const name = (v) => (typeof v === 'string' ? v : v?.name || '').trim();
  for (const x of found) {
    const media = [].concat(x.associatedMedia || x.audio || []).concat(/AudioObject/.test([].concat(x['@type']).join(' ')) ? [x] : []);
    const url = media.map((m) => (typeof m === 'string' ? m : m.contentUrl || m.url)).find((m) => m && /^https?:/.test(m) && !/\.html?($|\?)/.test(m));
    const title = name(x.name) || name(x.headline);
    const show = name(x.partOfSeries) || name(x.partOfSeason?.partOfSeries) || '';
    if (url || (title && show)) return { url: url || null, title, show };
  }
  return null;
}

// Podcast apps and sites, for titles that end in "| iHeart" or "- NRK Radio".
const PLATFORMS = /^(iheart(radio)?|podbean|castbox|player ?fm|podcast addict|goodpods|deezer|amazon music|audible|overcast|castro|substack|spotify|spotify for creators|apple podcasts|pocket casts|podchaser|acast|omny( studio)?|simplecast|transistor|libsyn|captivate|spreaker|audioboom|buzzsprout|soundcloud|youtube|nrk( radio)?|dr( lyd)?|sveriges radio|radio france|ard audiothek|rai ?play ?sound|rtve|podimo|bbc sounds)$/i;

// What a page says the episode and show are called, as [{ episode, show }] guesses in order
// of trust: structured data, then the page title split at " | " or " - ".
export function pageHints(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = [];
  const ld = structuredEpisode(doc);
  if (ld?.title) out.push({ episode: ld.title, show: ld.show || null });
  const meta = (p) => doc.querySelector(`meta[property="${p}"], meta[name="${p}"]`)?.getAttribute('content')?.trim() || '';
  const title = (meta('og:title') || meta('twitter:title') || doc.title || '').replace(/\s+/g, ' ').trim();
  const site = meta('og:site_name');
  const parts = title.split(/\s+[|–—•·-]\s+/).map((s) => s.trim()).filter(Boolean)
    .filter((p) => !PLATFORMS.test(p) && p.toLowerCase() !== site.toLowerCase());
  if (parts.length >= 2) out.push({ episode: parts[0], show: parts[1] }, { episode: parts[1], show: parts[0] });
  if (parts.length === 1) out.push({ episode: parts[0], show: site && !PLATFORMS.test(site) ? site : null });
  return out.filter((h) => h.episode);
}

const unslug = (s) => decodeURIComponent(s || '')
  .replace(/(?:-+id\d+)+$|--?\d{5,}$|-e[0-9a-z]{6,}$|-[0-9a-f]{8,}$|-\d{6,}$/i, '')
  .replace(/[-_+]+/g, ' ').trim();

// Show and episode names from the link itself, for apps whose pages web apps can't read.
export function slugHints(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');
  const p = u.pathname.split('/').filter(Boolean);
  const sub = host.split('.')[0];
  const hint = (show, episode) => (show || episode ? { show: show ? unslug(show) : null, episode: episode ? unslug(episode) : null } : null);
  if (host === 'player.fm' && p[0] === 'series') return hint(p[1], p[2]);
  if (host === 'podcastaddict.com' && p[1] === 'episode') return hint(p[0], null);
  if (host === 'podcastaddict.com' && p[0] === 'podcast') return hint(p[1], null);
  if (host === 'goodpods.com' && p[0] === 'podcasts') return hint(p[1], p[2]);
  if (host === 'castbox.fm' && p[0] === 'episode') return hint(null, p[1]);
  if (host === 'castbox.fm' && p[0] === 'channel') return hint(p[1], null);
  if (host === 'podchaser.com' && p[0] === 'podcasts') return hint(p[1], p[2] === 'episodes' ? p[3] : null);
  if (/^(creators|podcasters)\.spotify\.com$/.test(host) && p[0] === 'pod' && p[1] === 'show') return hint(p[2], p[3] === 'episodes' ? p[4] : null);
  if (host === 'anchor.fm') return hint(p[0], p[1] === 'episodes' ? p[2] : null);
  if (host === 'shows.acast.com') return hint(p[0], p[1] === 'episodes' ? p[2] : p[1]);
  if (host === 'play.acast.com' && p[0] === 's') return hint(p[1], p[2]);
  if (host === 'embed.acast.com') return hint(p[0], p[1]);
  if (host === 'omny.fm' && p[0] === 'shows') return hint(p[1], p[2]);
  if (/\.podbean\.com$/.test(host) && sub !== 'www') return hint(sub, p[0] === 'e' ? p[1] : null);
  if (/\.(simplecast\.com|transistor\.fm|captivate\.fm)$/.test(host)) return hint(sub, p[0] === 'episodes' || p[0] === 'episode' ? p[1] : null);
  if (/\.libsyn\.com$/.test(host)) return hint(sub, p[0]);
  if (host === 'spreaker.com' && (p[0] === 'episode' || p[0] === 'podcast')) return p[0] === 'episode' ? hint(null, p[1]) : hint(p[1], null);
  return null;
}

// Words that say which episode a title is, without the show's name, hashtags, handles and
// words every podcast title has.
const FILLER = new Set('podcast podcasts episode episodes ep full the a an and of with feat ft audio video official interview show part with mit avec con et und y e le la el il der die das'.split(' '));
function keyWords(title, show) {
  const showWords = new Set(normWords(show || ''));
  return normWords((title || '').replace(/#[\p{L}_]+|@[\w.]+/gu, ' ')).filter((w) => !FILLER.has(w) && !showWords.has(w));
}
const normWords = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}#]+/gu, ' ').split(' ').filter(Boolean);

// "#502", "Ep. 12", "Episode 7", "Folge 3", "Épisode 4", "Episodio 5", "Puntata 6".
export function episodeNumber(title) {
  return (title || '').match(/(?:#|(?:^|[^\p{L}])(?:ep|eps|episode|episodio|épisode|folge|puntata|afsnit|avsnitt|episod)\.?\s*)(\d{1,4})(?!\d)/iu)?.[1] || null;
}

// The feed's episodes ranked by how likely each is the same episode as `title` (from YouTube or
// another site with its own titles). Matching episode numbers settle it; otherwise it's the
// share of the title's distinctive words the episode's title has. `best` is set only when one
// episode clearly wins.
export function matchEpisode(episodes, title, show = '') {
  const want = keyWords(title, show);
  const num = episodeNumber(title);
  const ranked = episodes.map((e) => {
    const n = episodeNumber(e.title);
    if (num && n) return { e, score: num === n ? 1 : 0 };
    const have = new Set(keyWords(e.title, show));
    const shared = want.filter((w) => have.has(w)).length;
    const score = want.length && shared >= Math.min(2, want.length) ? (shared / want.length + (2 * shared) / (want.length + have.size)) / 2 : 0;
    return { e, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  const [top, next] = ranked;
  const best = top && (top.score === 1 && (!next || next.score < 1) || top.score >= 0.7 && (!next || next.score <= top.score - 0.15)) ? top.e : null;
  return { best, ranked: ranked.map((x) => x.e) };
}
