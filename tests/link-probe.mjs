// Which services let a web page read them (CORS), checked from real Chromium on a foreign
// origin. A CORS-blocked fetch throws; an allowed one returns a status, even a 404.
import { chromium } from 'playwright';
import { createServer } from 'node:http';

const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>probe</title>'); }).listen(8766);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:8766/');

async function inPage(url, opts = {}) {
  return page.evaluate(async ({ url, opts }) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(url, { ...opts, signal: ctl.signal });
      const type = res.headers.get('content-type') || '';
      let body = '';
      if (/json|text|xml|html/.test(type)) body = (await res.text()).slice(0, 400);
      else { const r = res.body?.getReader(); const c = r && await r.read(); body = `[${type} ${c?.value?.length || 0} bytes]`; r?.cancel(); }
      return { ok: res.ok, status: res.status, type, final: res.url, body };
    } catch (e) { return { error: e.name === 'AbortError' ? 'timeout' : 'blocked' }; }
    finally { clearTimeout(t); }
  }, { url, opts });
}
const show = (label, r) => console.log(`${(r.error || r.status).toString().padEnd(8)} ${label}${r.final && r.final !== label ? `\n         -> ${r.final}` : ''}${r.body ? `\n         ${r.body.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
async function probe(url, opts) { show(url, await inPage(url, opts)); }
async function node(url, opts = {}) {
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
    return { status: res.status, text: await res.text(), final: res.url };
  } catch (e) { return { status: 'ERR ' + e.message, text: '' }; }
}

const YT = 'jNQXAC9IVRw';
console.log('\n=== YouTube metadata');
await probe(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${YT}&format=json`);
await probe(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${YT}`);
await probe('https://www.youtube.com/youtubei/v1/player', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ videoId: YT, context: { client: { clientName: 'ANDROID_VR', clientVersion: '1.62.27' } } }) });

console.log('\n=== YouTube innertube from Node, then the stream from the page');
for (const [clientName, clientVersion, extra] of [['ANDROID_VR', '1.62.27', { deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L' }], ['IOS', '20.10.4', { deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' }], ['TVHTML5_SIMPLY_EMBEDDED_PLAYER', '2.0', {}], ['WEB_EMBEDDED_PLAYER', '1.20250101.01.00', {}], ['MWEB', '2.20250101.01.00', {}]]) {
  const r = await node('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' }, body: JSON.stringify({ videoId: YT, context: { client: { clientName, clientVersion, hl: 'en', ...extra } } }) });
  let j = {};
  try { j = JSON.parse(r.text); } catch {}
  const fmts = [...(j.streamingData?.adaptiveFormats || []), ...(j.streamingData?.formats || [])];
  const audio = fmts.filter((f) => /^audio/.test(f.mimeType));
  console.log(`${clientName}: ${r.status} ${j.playabilityStatus?.status} ${j.playabilityStatus?.reason || ''} formats=${fmts.length} audio=${audio.length} plainUrl=${audio.filter((f) => f.url).length}`);
  const a = audio.find((f) => f.url);
  if (a) {
    show(`googlevideo audio via ${clientName} (page)`, await inPage(a.url + '&range=0-50000'));
    const n = await node(a.url + '&range=0-50000');
    console.log(`         node: ${n.status} ${n.text.length}`);
  }
}

console.log('\n=== Piped / Invidious');
const pipedList = await node('https://piped-instances.kavin.rocks/');
let piped = [];
try { piped = JSON.parse(pipedList.text).map((i) => i.api_url); } catch {}
console.log(`piped instances: ${piped.length} (${pipedList.status})`);
for (const api of [...new Set(['https://pipedapi.kavin.rocks', ...piped])].slice(0, 14)) {
  const r = await inPage(`${api}/streams/${YT}`);
  let line = `${(r.error || r.status).toString().padEnd(8)} ${api}`;
  if (r.ok) {
    const full = await node(`${api}/streams/${YT}`);
    try {
      const a = JSON.parse(full.text).audioStreams?.[0];
      if (a) { const s = await inPage(a.url); line += ` audio: ${s.error || s.status} ${s.type || ''}`; }
      else line += ` ${full.text.slice(0, 120)}`;
    } catch { line += ` ${full.text.slice(0, 120)}`; }
  }
  console.log(line);
}
const invList = await node('https://api.invidious.io/instances.json?sort_by=health');
let inv = [];
try { inv = JSON.parse(invList.text).filter(([, i]) => i.type === 'https').map(([, i]) => ({ uri: i.uri, cors: i.cors, api: i.api })); } catch {}
console.log(`invidious instances: ${inv.length} (${invList.status}) ${JSON.stringify(inv.slice(0, 20))}`);
for (const i of inv.slice(0, 14)) {
  const r = await inPage(`${i.uri}/api/v1/videos/${YT}?local=true`);
  let line = `${(r.error || r.status).toString().padEnd(8)} ${i.uri}`;
  if (r.ok) {
    const full = await node(`${i.uri}/api/v1/videos/${YT}?local=true`);
    try {
      const a = JSON.parse(full.text).adaptiveFormats?.find((f) => /^audio/.test(f.type));
      if (a) { const u = new URL(a.url, i.uri).href; const s = await inPage(u); line += ` audio: ${s.error || s.status} ${s.type || ''}`; }
      else line += ` ${full.text.slice(0, 120)}`;
    } catch { line += ` ${full.text.slice(0, 120)}`; }
  }
  console.log(line);
}
await probe('https://api.cobalt.tools/', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${YT}`, downloadMode: 'audio' }) });

console.log('\n=== Page readers');
await probe('https://r.jina.ai/https://overcast.fm/+AA0Y4P-tMLA', { headers: { 'X-Return-Format': 'html' } });
await probe('https://api.microlink.io/?url=https://overcast.fm/+AA0Y4P-tMLA&audio=true');

console.log('\n=== Other services');
for (const u of [
  'https://soundcloud.com/oembed?format=json&url=https://soundcloud.com/forss/flickermood',
  'https://api-v2.soundcloud.com/resolve?url=https://soundcloud.com/forss/flickermood',
  'https://archive.org/metadata/OTRR_Dragnet_Singles',
  'https://archive.org/download/OTRR_Dragnet_Singles/',
  'https://www.dropbox.com/s/abc/x.mp3?dl=1',
  'https://dl.dropboxusercontent.com/s/abc/x.mp3',
  'https://drive.usercontent.google.com/download?id=abc&export=download',
  'https://psapi.nrk.no/radio/catalog/podcast/abels_taarn/episodes?pageSize=1',
  'https://api.dr.dk/radio/v4/search/series?q=millionaer',
  'https://overcast.fm/itunes1200361736',
  'https://castbox.fm/episode/x-id1-id2',
  'https://everest.castbox.fm/data/episode/v4?eid=1',
  'https://www.podbean.com/',
  'https://www.buzzsprout.com/',
  'https://shows.acast.com/',
  'https://feeds.acast.com/public/shows/the-rest-is-politics',
  'https://feeds.simplecast.com/54nAGcIl',
  'https://api.simplecast.com/podcasts',
  'https://api.iheart.com/api/v3/podcast/podcasts/1',
  'https://player.fm/',
  'https://castro.fm/',
  'https://podcastaddict.com/',
  'https://goodpods.com/',
  'https://www.podchaser.com/',
  'https://music.amazon.com/podcasts',
  'https://anchor.fm/s/1/podcast/rss',
  'https://creators.spotify.com/',
  'https://audioboom.com/api/posts/1',
  'https://api.audioboom.com/posts/1',
  'https://www.omnycontent.com/',
  'https://omny.fm/shows',
  'https://api.deezer.com/episode/1',
  'https://vimeo.com/api/oembed.json?url=https://vimeo.com/76979871',
  'https://www.tiktok.com/oembed?url=https://www.tiktok.com/@scout2015/video/6718335390845095173',
  'https://publish.twitter.com/oembed?url=https://twitter.com/jack/status/20',
  'https://podcastindex.org/',
  'https://api.podcastindex.org/api/1.0/search/byterm?q=x',
]) await probe(u);

await browser.close();
server.close();
