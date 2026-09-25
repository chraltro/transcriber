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

export function parseFeed(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) return null;
  const channel = doc.getElementsByTagName('channel')[0] || doc.documentElement;
  const title = textOf(channel, 'title');
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
    });
  }
  return { title, episodes };
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

  // Only trust a bare audio URL in the page source if it's the only one; pages listing
  // several episodes would otherwise hand us the wrong one.
  const found = new Set((html.match(AUDIO_URL_IN_TEXT) || []).map((m) => m.replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&')));
  if (found.size === 1) return { kind: 'audio', url: [...found][0], title };

  const feed = doc.querySelector('link[type="application/rss+xml"], link[type="application/atom+xml"]')?.getAttribute('href');
  if (feed) return { kind: 'feed', url: abs(feed), title };
  return null;
}
