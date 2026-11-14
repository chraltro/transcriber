// A small stand-in for the podcast world, for tests/pod.mjs: a host with three shows' feeds,
// their cover art and audio (with byte ranges, one show's without permission for web pages to
// download it), and the app's own server (server/main.mjs) started on a fresh data folder that
// already holds the transcript of one episode, ads marked.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { QuietFinder, QUIET_VERSION } from '../lib/quiet.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const idOf = (guid) => createHash('sha1').update(guid).digest('hex').slice(0, 16);
const DAY = 864e5;

// Speech-like audio: bursts of a warbling tone with half a second between them, and every 45
// seconds a pause of two and a half (42.5 to 45, 87.5 to 90, ...). 8 kHz 16-bit mono WAV.
export function wav(seconds, pitch = 180) {
  const rate = 8000;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const v = t % 4.5 < 4 && t % 45 < 42.5 ? Math.sin(2 * Math.PI * (pitch + 40 * Math.sin(t * 3)) * t) * 0.25 : 0;
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

const cover = (title, a, b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600"><rect width="600" height="600" fill="${a}"/><rect x="40" y="40" width="520" height="520" fill="none" stroke="${b}" stroke-width="10"/>
<text x="64" y="330" font-family="Georgia, serif" font-size="74" font-weight="700" fill="${b}">${title.split(' ').map((w, i) => `<tspan x="64" dy="${i ? 82 : 0}">${w}</tspan>`).join('')}</text></svg>`;

export const SHOWS = [
  { slug: 'harbour', title: 'Harbour Hours', author: 'Quay Radio', lang: 'en', colors: ['#12343b', '#e1b866'], about: 'Two former dock workers on how ports, ships and the people around them shape what ends up in the shops.',
    episodes: [['Why every container is the same size', 0.2, 3480], ['The pilot who boards at night', 2, 2890], ['A strike that moved a city', 5, 4120], ['What the tide tables leave out', 9, 3300], ['Cranes, and the people under them', 16, 2760], ['The longest berth in Europe', 23, 3900], ['Rust never sleeps', 30, 3050], ['Fog', 37, 2400]] },
  { slug: 'ledger', title: 'The Long Ledger', author: 'Mara Lindqvist', lang: 'en', colors: ['#f3e9d8', '#7a2e2e'], about: 'One old account book an episode, and what it says about the people who kept it.',
    episodes: [['A bakery in 1911', 1, 2520], ['The ferry company that never made money', 8, 2700], ['Twelve years of a school kitchen', 15, 2610], ['What the lighthouse keeper bought', 22, 2480]] },
  { slug: 'fjord', title: 'Fjordfunn', author: 'NRK', lang: 'nb', colors: ['#1d2b53', '#9ad1d4'], about: 'Hver uke et funn fra norske fjorder, fortalt av dem som fant det.',
    episodes: [['Kanonen i Oslofjorden', 3, 1980], ['Kaldtvannskorallene', 10, 2210], ['Et vrak ingen savnet', 17, 2050]] },
];

// One episode's audio is handed out through a service that counts downloads (the page under
// test is told the service is blocked, and where the file behind it is: tests/pod.mjs).
export const COUNTED = 'https://dts.podtrac.com/redirect.mp3/audio.test.example';

export const guidOf = (show, i) => `${show.slug}-${show.episodes.length - i}`;
export const episodeIdOf = (show, i) => idOf(guidOf(show, i));

function feedXml(show, base, now, extra = []) {
  const items = [...extra, ...show.episodes].map(([title, daysAgo, seconds], i) => {
    const n = show.episodes.length + extra.length - i;
    const guid = i < extra.length ? `${show.slug}-new-${n}` : guidOf(show, i - extra.length);
    return `<item><title>${title}</title><guid isPermaLink="false">${guid}</guid><pubDate>${new Date(now - daysAgo * DAY).toUTCString()}</pubDate>
<enclosure url="${show.slug === 'fjord' && n === 1 ? COUNTED : base}/audio/${show.slug}/${n}.wav" type="audio/wav" length="0"/><itunes:duration>${seconds}</itunes:duration><link>${base}/${show.slug}/${n}</link>
<description><![CDATA[<p>${title}: ${show.about}</p><p>In this episode:</p><ul><li>(00:30) Where it starts</li><li>(02:10) The part with the numbers</li></ul><p>More at <a href="${base}/${show.slug}">the show's site</a>.</p><script>window.__pwned = 1</script><img src="${base}/pixel.gif" onerror="window.__pwned = 2">]]></description></item>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>${show.title}</title><link>${base}/${show.slug}</link><language>${show.lang}</language>
<itunes:author>${show.author}</itunes:author><description>${show.about}</description><itunes:image href="${base}/art/${show.slug}.svg"/>${items.join('\n')}</channel></rss>`;
}

// A transcript of the first show's newest episode as the server would have filed it: two
// voices, and a sponsor read from 0:40 to 1:20.
function transcript(show, seconds) {
  const lines = [
    [0, 12, 0, "Welcome to Harbour Hours, I'm Tom Aldous, and with me as ever is Ingrid Solheim."],
    [12, 26, 1, 'Hello. Today is about a steel box, eight feet wide, that changed what a harbour is for.'],
    [26, 39, 0, 'Before the box, a ship could sit at the quay for a week while men carried its cargo off by hand.'],
    [42, 50, 0, 'Harbour Hours is brought to you by Tidewater Insurance.'],
    [50, 64, 0, 'They have covered cargo since 1890, and they answer the phone themselves.'],
    [64, 76, 0, 'Go to tidewater.example/harbour for a month free. Terms apply.'],
    [80, 96, 1, 'So, the box. The first ones were lifted onto a converted tanker in 1956, fifty eight of them.'],
    [96, 118, 0, 'And the dockers knew at once what it meant. One crane driver could now do the work of a gang of twenty.'],
    [118, 140, 1, 'Which is why the size mattered so much. If every box is the same, every crane, lorry and ship can be too.'],
    [140, 170, 0, 'It took ten years of committees to agree on twenty feet and forty feet, and they are still the sizes today.'],
  ];
  const segments = lines.map(([start, end, speaker, text]) => ({ start, end, text, speaker, w: Math.floor(start / 30) * 30 }));
  for (let t = 180; t < seconds - 20; t += 20) segments.push({ start: t, end: t + 18, text: t % 40 ? 'The port grew outward, away from the old town, to where the water was deep enough.' : 'And the warehouses by the river emptied, one after the other, within a few years.', speaker: (t / 20) % 2, w: Math.floor(t / 30) * 30 });
  return segments;
}

export async function startWorld({ audioSeconds = 300 } = {}) {
  const now = Date.now();
  const audio = wav(audioSeconds);
  const state = { extra: {}, hits: {} };
  const world = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    state.hits[p] = (state.hits[p] || 0) + 1;
    const base = `http://localhost:${world.address().port}`;
    const feed = p.match(/^\/feed\/(\w+)\.xml$/);
    const show = SHOWS.find((s) => s.slug === (feed || p.match(/^\/(?:art|audio)\/(\w+)/))?.[1]);
    if (feed && show) {
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
      res.end(feedXml(show, base, now, state.extra[show.slug] || []));
    } else if (p.startsWith('/art/') && show) {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=3600', 'access-control-allow-origin': '*' });
      res.end(cover(show.title, ...show.colors));
    } else if (p.startsWith('/audio/') && show) {
      // The second show's host doesn't let web pages download its files (they still play).
      const headers = { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', ...(show.slug === 'ledger' ? {} : { 'access-control-allow-origin': '*' }) };
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
        res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${audio.length}`, 'content-length': end - start + 1 });
        res.end(audio.subarray(start, end + 1));
      } else {
        res.writeHead(200, { ...headers, 'content-length': audio.length });
        res.end(req.method === 'HEAD' ? undefined : audio);
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  }).listen(0);
  await new Promise((r) => world.once('listening', r));
  const worldBase = `http://localhost:${world.address().port}`;

  // The app's server, with one episode already transcribed.
  const data = await mkdtemp(path.join(tmpdir(), 'pod-world-'));
  const lib = path.join(data, 'library');
  await mkdir(lib, { recursive: true });
  const show = SHOWS[0];
  const id = episodeIdOf(show, 0);
  const segments = transcript(show, audioSeconds);
  const entry = {
    id, createdAt: now - 0.2 * DAY, transcribedAt: now - 0.1 * DAY, title: show.episodes[0][0], show: show.title, art: `${worldBase}/art/${show.slug}.svg`,
    lang: 'english', model: 'turbo', total: audioSeconds, words: segments.reduce((n, s) => n + s.text.split(' ').length, 0), segments,
    levels: '', key: `server:${id}`, source: { url: `${worldBase}/audio/${show.slug}/${show.episodes.length}.wav` }, notes: '', voices: [], speakerNames: {}, audio: `library/${id}.mp3`,
  };
  await writeFile(path.join(lib, `${id}.json`), JSON.stringify(entry));
  await writeFile(path.join(lib, `${id}.mp3`), audio); // (a WAV under the name the server keeps audio by)
  // ...and where that audio goes quiet, as the transcribing leaves it beside the transcript.
  const finder = new QuietFinder(8000);
  finder.push(Float32Array.from(new Int16Array(audio.buffer, audio.byteOffset + 44, (audio.length - 44) / 2), (v) => v / 32768));
  await writeFile(path.join(lib, `${id}.quiet.json`), JSON.stringify({ v: QUIET_VERSION, quiet: finder.finish() }));
  const { metaOf } = await import('../server/shows.mjs');
  await writeFile(path.join(lib, 'index.json'), JSON.stringify({ entries: [metaOf({ ...entry, quiet: QUIET_VERSION })] }));

  const port = await new Promise((resolve) => { const s = http.createServer().listen(0, () => { const { port: free } = s.address(); s.close(() => resolve(free)); }); });
  const logs = [];
  const app = spawn(process.execPath, [path.join(ROOT, 'server/main.mjs')], { env: { ...process.env, DATA_DIR: data, PORT: String(port), POLL_MINUTES: '60', POD_ALLOW_PRIVATE: '1', POD_FRESH_SECONDS: '0', POD_SEED: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.on('data', (d) => logs.push(String(d)));
  app.stderr.on('data', (d) => logs.push(String(d)));
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base, worldBase, data, logs, state, audio, transcribed: id,
    feedUrl: (slug) => `${worldBase}/feed/${slug}.xml`,
    // A new episode comes out.
    publish: (slug, title, seconds = 1800) => { (state.extra[slug] ||= []).unshift([title, 0, seconds]); },
    // The app's server goes away (the page is then on its own).
    stopApp: () => new Promise((resolve) => { app.once('exit', resolve); app.kill(); }),
    close: async () => { app.kill(); world.close(); await rm(data, { recursive: true, force: true }); },
  };
}
