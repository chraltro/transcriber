// Which services let a web page read them (CORS), checked from real Chromium on a foreign
// origin. A CORS-blocked fetch throws; an allowed one returns a status, even a 404.
import { chromium } from 'playwright';
import { createServer } from 'node:http';

const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>probe</title>'); }).listen(8766);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:8766/');

async function inPage(url, opts = {}, max = 400) {
  return page.evaluate(async ({ url, opts, max }) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 25000);
    try {
      const res = await fetch(url, { ...opts, signal: ctl.signal });
      const type = res.headers.get('content-type') || '';
      let body = '';
      if (/json|text|xml|html/.test(type)) body = (await res.text()).slice(0, max);
      else { const r = res.body?.getReader(); const c = r && await r.read(); body = `[${type} ${c?.value?.length || 0} bytes]`; r?.cancel(); }
      return { ok: res.ok, status: res.status, type, final: res.url, body };
    } catch (e) { return { error: e.name === 'AbortError' ? 'timeout' : 'blocked' }; }
    finally { clearTimeout(t); }
  }, { url, opts, max });
}
const show = (label, r) => console.log(`${(r.error || r.status).toString().padEnd(8)} ${label}${r.final && r.final !== label ? `\n         -> ${r.final}` : ''}${r.body ? `\n         ${r.body.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
async function node(url, opts = {}) {
  try {
    const res = await fetch(url, { ...opts, headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', ...(opts.headers || {}) }, signal: AbortSignal.timeout(20000) });
    return { status: res.status, text: await res.text(), final: res.url };
  } catch (e) { return { status: 'ERR ' + e.message, text: '' }; }
}
const meta = (html) => {
  const pick = (re) => html.match(re)?.[1];
  return {
    title: pick(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i) || pick(/<title>([^<]*)/i),
    audio: pick(/<meta[^>]+property="og:audio(?::url|:secure_url)?"[^>]+content="([^"]*)"/i) || pick(/<audio[^>]+src="([^"]*)"/i) || pick(/<source[^>]+src="([^"]*\.(?:mp3|m4a)[^"]*)"/i),
    mp3s: [...new Set(html.match(/https?:\\?\/\\?\/[^"'\s<>()]+?\.(?:mp3|m4a)(?:\?[^"'\s<>()]*)?/gi) || [])].length,
    feed: pick(/<link[^>]+type="application\/rss\+xml"[^>]+href="([^"]*)"/i),
  };
};
const jina = (u) => `https://r.jina.ai/${u}`;
async function viaJina(label, u) {
  const r = await inPage(jina(u), { headers: { 'X-Return-Format': 'html' } }, 2_000_000);
  if (r.error || !r.ok) { console.log(`${(r.error || r.status).toString().padEnd(8)} jina ${label} ${u} ${r.body?.slice(0, 200) || ''}`); return ''; }
  console.log(`${r.status}      jina ${label} ${u}\n         ${JSON.stringify(meta(r.body))} (${r.body.length} chars)`);
  return r.body;
}

// Show pages: list their episode links, then read the first episode through the page reader.
const SHOWS = [
  ['Overcast', 'https://overcast.fm/itunes1200361736', /href="(\/\+[\w-]+)"/g, 'https://overcast.fm'],
  ['Podbean', 'https://www.podbean.com/podcast-detail/k2ws5-2ea7f/The-Daily-Podcast', /href="(https:\/\/www\.podbean\.com\/(?:ew|media\/share)\/[^"]+)"/g, ''],
  ['Castbox', 'https://castbox.fm/channel/The-Daily-id1033024', /href="(\/episode\/[^"]+)"/g, 'https://castbox.fm'],
  ['Player FM', 'https://player.fm/series/the-daily-1408227', /href="(\/series\/the-daily-1408227\/[^"]+)"/g, 'https://player.fm'],
  ['Podcast Addict', 'https://podcastaddict.com/podcast/the-daily/2347587', /href="(https:\/\/podcastaddict\.com\/the-daily\/episode\/\d+)"/g, ''],
  ['Castro', 'https://castro.fm/itunes/1200361736', /href="(\/episode\/[\w]+)"/g, 'https://castro.fm'],
  ['Acast', 'https://shows.acast.com/the-rest-is-politics', /href="(\/the-rest-is-politics\/episodes\/[^"]+)"/g, 'https://shows.acast.com'],
  ['Goodpods', 'https://goodpods.com/podcasts/the-daily-24758', /href="(\/podcasts\/the-daily-24758\/[^"]+)"/g, 'https://goodpods.com'],
  ['iHeart', 'https://www.iheart.com/podcast/1119-stuff-you-should-know-26940277/', /href="(\/podcast\/1119-stuff-you-should-know-26940277\/episode\/[^"]+)"/g, 'https://www.iheart.com'],
  ['Deezer', 'https://www.deezer.com/show/61789', /href="(\/[a-z]{2}\/episode\/\d+)"/g, 'https://www.deezer.com'],
  ['Amazon', 'https://music.amazon.com/podcasts/a1ff4a8c-5ec2-4a1c-8c5d-a93a3e3b4b5c', /href="(\/podcasts\/[^"]+\/episodes\/[^"]+)"/g, 'https://music.amazon.com'],
  ['Omny', 'https://omny.fm/shows/the-hamish-and-andy-podcast', /href="(\/shows\/[^"/]+\/[^"/]+)"/g, 'https://omny.fm'],
  ['Spotify for Creators', 'https://creators.spotify.com/pod/show/thejoeroganexperience', /href="(\/pod\/show\/[^"/]+\/episodes\/[^"]+)"/g, 'https://creators.spotify.com'],
  ['Audioboom', 'https://audioboom.com/channels/4322549', /href="(https:\/\/audioboom\.com\/posts\/[^"]+)"/g, ''],
  ['Buzzsprout', 'https://www.buzzsprout.com/1', /href="(\/\d+\/episodes\/[^"]+)"/g, 'https://www.buzzsprout.com'],
  ['NRK', 'https://radio.nrk.no/podkast/abels_taarn', /href="(\/podkast\/abels_taarn\/[^"]+)"/g, 'https://radio.nrk.no'],
  ['DR LYD', 'https://www.dr.dk/lyd/p1/genstart', /href="(\/lyd\/p1\/genstart\/[^"]+)"/g, 'https://www.dr.dk'],
  ['Substack', 'https://www.astralcodexten.com/podcast', /href="(https:\/\/www\.astralcodexten\.com\/p\/[^"]+)"/g, ''],
];
console.log('\n=== Episode pages through the page reader');
for (const [label, url, re, base] of SHOWS) {
  const direct = await node(url);
  let html = direct.text;
  console.log(`\n--- ${label}: node ${direct.status} ${direct.final !== url ? direct.final : ''} ${html.length} chars ${JSON.stringify(meta(html))}`);
  const d = await inPage(url);
  console.log(`    page: ${d.error || d.status}`);
  if (!html || direct.status !== 200) html = await viaJina('show', url);
  const links = [...new Set([...html.matchAll(re)].map((m) => base + m[1]))];
  console.log(`    episode links: ${links.length} ${links.slice(0, 3).join(' ')}`);
  if (links[0]) {
    const ep = await node(links[0]);
    console.log(`    episode node ${ep.status}: ${JSON.stringify(meta(ep.text))}`);
    await viaJina('episode', links[0]);
  }
}
const mlink = await inPage('https://api.microlink.io/?url=' + encodeURIComponent('https://overcast.fm/itunes1200361736') + '&audio=true', {}, 3000);
show('microlink overcast', mlink);

console.log('\n=== iHeart API');
for (const u of ['https://api.iheart.com/api/v3/podcast/podcasts/26940277', 'https://api.iheart.com/api/v3/podcast/podcasts/26940277/episodes?limit=1']) show(u, await inPage(u, {}, 1500));
console.log('\n=== Audioboom API');
show('audioboom channel', await inPage('https://api.audioboom.com/channels/4322549/audio_clips?limit=1', {}, 1500));
console.log('\n=== archive.org file');
const ia = JSON.parse((await node('https://archive.org/metadata/OTRR_Dragnet_Singles')).text);
const f = ia.files.find((x) => /\.mp3$/i.test(x.name));
show('archive download', await inPage(`https://archive.org/download/OTRR_Dragnet_Singles/${encodeURIComponent(f.name)}`));
show('archive direct', await inPage(`https://${ia.d1}${ia.dir}/${encodeURIComponent(f.name)}`));

console.log('\n=== YouTube podcasts: the same episode in Apple\'s directory?');
const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
for (const handle of ['@lexfridman', '@hubermanlab', '@TheDiaryOfACEO', '@theDailyNYT', '@TheRestIsPolitics', '@ModernWisdomPodcast', '@JREPodcast', '@Acquiredfm', '@dwarkeshpatel', '@lagedernation', '@hotelmatze', '@nadiesabenada', '@ilpostpodcast']) {
  const ch = await node(`https://www.youtube.com/${handle}/videos`);
  const id = ch.text.match(/"channelId":"(UC[\w-]{22})"/)?.[1] || ch.text.match(/channel\/(UC[\w-]{22})/)?.[1];
  if (!id) { console.log(`${handle}: no channel id (${ch.status})`); continue; }
  const feed = await node(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`);
  const author = feed.text.match(/<author>\s*<name>([^<]+)/)?.[1];
  const vids = [...feed.text.matchAll(/<yt:videoId>([^<]+)<\/yt:videoId>\s*<yt:channelId>[^<]+<\/yt:channelId>\s*<title>([^<]+)/g)].slice(0, 3).map((m) => ({ id: m[1], title: m[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'") }));
  console.log(`\n${handle} (${author}): ${vids.length} videos`);
  for (const v of vids) {
    const o = await inPage(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${v.id}&format=json`, {}, 2000);
    let ob = {};
    try { ob = JSON.parse(o.body); } catch {}
    const eps = JSON.parse((await node(`https://itunes.apple.com/search?term=${encodeURIComponent(ob.title || v.title)}&entity=podcastEpisode&limit=10`)).text || '{"results":[]}').results;
    const shows = JSON.parse((await node(`https://itunes.apple.com/search?term=${encodeURIComponent(ob.author_name || author)}&entity=podcast&limit=3`)).text || '{"results":[]}').results;
    console.log(`  yt: "${ob.title}" by ${ob.author_name} (oembed ${o.error || o.status})`);
    console.log(`     episode search: ${eps.slice(0, 3).map((e) => `"${e.trackName}" [${e.collectionName}]${norm(e.trackName) === norm(ob.title) ? ' EXACT' : ''}`).join(' | ') || 'none'}`);
    console.log(`     show search: ${shows.map((s) => s.collectionName).join(' | ') || 'none'}`);
  }
}

console.log('\n=== cobalt community instances');
const list = await node('https://instances.cobalt.best/api/instances.json');
let inst = [];
try { inst = JSON.parse(list.text); } catch {}
console.log(`instances: ${inst.length} (${list.status}) ${list.text.slice(0, 300)}`);
for (const i of inst.slice(0, 25)) {
  const api = `${i.protocol || 'https'}://${i.api || i.api_url || i.url}`;
  const r = await inPage(api, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', downloadMode: 'audio' }) }, 600);
  let line = `${(r.error || r.status).toString().padEnd(8)} ${api} ${r.body?.slice(0, 200) || ''}`;
  try {
    const j = JSON.parse(r.body);
    if (j.url) { const s = await inPage(j.url); line += `\n         audio: ${s.error || s.status} ${s.type || ''} ${s.body || ''}`; }
  } catch {}
  console.log(line);
}

await browser.close();
server.close();
