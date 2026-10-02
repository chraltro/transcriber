// Speaker lab: one real interview (The Ezra Klein Show with Bill Gates, by default) through the
// app's own transcription and speaker code. Every window's raw speaker output (turns and voice
// prints) is kept, so ways of turning voice prints into speakers can be compared on exactly the
// same data, each scored on edge sentences whose speaker is known and printed as a reader sees it.
// (Clustering all prints with hindsight was tried too: on these episodes it found exactly the
// voices the on-the-fly matching did. The errors were at the edges of turns.)
//   EPISODE_KEY (gates, klosterman), MINUTES, MODEL
import * as tf from '@huggingface/transformers';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { StreamingTranscriber } from '../lib/stream.js';
import { transcribeWindow } from '../lib/prompted.js';
import { buildPrompt, extractTerms } from '../lib/context.js';
import { dtypeFor } from '../lib/models.js';
import { createDiarizer } from '../lib/diarize.js';
import { guessNames, speakerName, hostFromShow, Voices, assignLocals, labelParts, retimeParts } from '../lib/speakers.js';

// Episodes with an answer key: sentences at the edges of turns whose speaker is certain from the
// conversation, read and checked by hand. In both, the guest talks most and the host next, which
// is how voices are matched to the key (apart from the app's own naming).
const EPISODES = {
  gates: {
    show: 'The Ezra Klein Show', episode: /Gates/i, guest: 'Bill Gates', host: 'Ezra Klein',
    checks: [
      [/How do you see that question/i, 'host'], [/I'm curious where yours is/i, 'host'],
      [/doesn't feel to me that we're so disengaged/i, 'host'], [/you just wrote this essay on AI risk/i, 'host'],
      [/Jensen Huang's view/i, 'host'], [/this is not my view, but it is President Trump/i, 'host'],
      [/welcome to the show/i, 'host'], [/So that was 30 years ago/i, 'host'],
      [/Do you think that's far from being a capability/i, 'host'], [/What specifically was the threshold/i, 'host'],
      [/is the governing view of the United States/i, 'host'], [/So the two counter ?arguments/i, 'host'],
      [/^Yeah, so\.?$/i, 'guest'], [/^Great to see you/i, 'guest'], [/^Does super powerful AI create/i, 'guest'],
      [/almost can't believe you're asking that/i, 'guest'], [/So they don't mind bioterrorism/i, 'guest'],
      [/There's no doubt,? to date/i, 'guest'], [/the notion that computation could provide thinking/i, 'guest'],
      [/key thing is we always said when we cross/i, 'guest'], [/^Not really, I don't think/i, 'guest'],
      [/^It's a scary thought/i, 'guest'],
    ],
  },
  klosterman: {
    show: 'Plain English with Derek Thompson', episode: /Klosterman/i, guest: 'Chuck Klosterman', host: 'Derek Thompson',
    checks: [
      [/I don't think there is any singular inception point/i, 'guest'], [/It was just the kind of thing for 25 years/i, 'guest'],
      [/now it's just one big/i, 'host'], [/^Why did this happen\?/i, 'host'],
      [/probably had to do sort of with the decline/i, 'guest'], [/^Well, yes\.?$/i, 'guest'],
      [/So to go back to you, how do you feel about that/i, 'guest'], [/^I'm excited about it/i, 'host'],
      [/^I try to remember it/i, 'guest'], [/^Super old-fashioned/i, 'host'], [/I had to learn somehow/i, 'guest'],
      [/So like with this book, for example/i, 'host'], [/what is your feedback loop/i, 'host'], [/^Hmm\.?$/i, 'guest'],
      [/when you're first starting out, all you care about/i, 'guest'],
    ],
  },
};
const KEY = process.env.EPISODE_KEY || 'gates';
const CONF = EPISODES[KEY];
const SHOW = CONF.show;
const EPISODE = CONF.episode;
const MINUTES = Number(process.env.MINUTES || 35);
const MODEL = process.env.MODEL || 'onnx-community/whisper-base.en';

async function findEpisode() {
  const s = await (await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(SHOW)}&entity=podcast&limit=3`)).json();
  const show = s.results.find((r) => r.feedUrl);
  const xml = await (await fetch(show.feedUrl)).text();
  for (const item of xml.split(/<item[\s>]/).slice(1)) {
    const tag = (n) => (item.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`)) || [])[1] || '';
    const title = tag('title').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    if (!EPISODE.test(title)) continue;
    const url = item.match(/<enclosure[^>]+url="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&');
    return { show: show.collectionName, title, url, notes: tag('description').replace(/<!\[CDATA\[|\]\]>/g, '') };
  }
  throw new Error('episode not found');
}

const ep = await findEpisode();
console.log(`${ep.show}: ${ep.title}\nnotes: ${ep.notes.replace(/<[^>]+>/g, ' ').slice(0, 500)}`);
execSync(`curl -sSL --fail -A "Mozilla/5.0" -o ep.mp3 "${ep.url}"`);
const raw = execSync(`ffmpeg -loglevel error -t ${MINUTES * 60} -i ep.mp3 -ac 1 -ar 16000 -f f32le -`, { maxBuffer: 1 << 30 });
const audio = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const terms = extractTerms(ep.notes, ep.title, ep.show);
console.log(`terms: ${terms.join(', ')}`);

const asr = await tf.pipeline('automatic-speech-recognition', MODEL, { dtype: dtypeFor(MODEL, 'wasm') });
const diarizer = await createDiarizer(tf);
let lastDiarized = null;
let diarizeSec = 0;
let spanSec = 0;
const diarize = async (samples, opts) => {
  const t = Date.now();
  const plain = await diarizer(samples);
  diarizeSec += (Date.now() - t) / 1000;
  const t2 = Date.now();
  const spans = opts?.spans || [];
  const prints = [];
  for (const [a, b] of spans) {
    const from = Math.floor(a * 16000);
    const to = Math.min(samples.length, Math.floor(Math.min(b, a + 12) * 16000));
    prints.push(to - from >= 8000 ? await diarizer.printOf(samples.subarray(from, to)) : null);
  }
  spanSec += (Date.now() - t2) / 1000;
  lastDiarized = { ...plain, spanPrints: prints };
  return lastDiarized;
};

const windows = []; // { start, end, parts: [{ start, end, text, speaker }], turns, prints }
const t0 = Date.now();
await new Promise((resolve, reject) => {
  const stream = new StreamingTranscriber({
    now: () => Date.now(),
    post: (m) => {
      if (m.type === 'segment') {
        windows.push({ start: m.start, end: m.end, parts: m.parts || [], ...(lastDiarized || { turns: [], prints: {} }) });
        lastDiarized = null;
        if (windows.length % 10 === 0) console.log(`  ${Math.round(m.end)} s`);
      }
      if (m.type === 'done') resolve();
    },
    diarize,
    transcribe: (samples, language, { previous } = {}) => transcribeWindow(asr, samples, { language, prompt: buildPrompt(terms, previous), timestamps: true }),
  });
  stream.start(1, { language: 'english', speakers: true });
  stream.push(1, audio, true).then(() => stream.ready(1)).catch(reject);
});
console.log(`${MODEL}: ${((audio.length / 16000) / ((Date.now() - t0) / 1000)).toFixed(1)}x realtime, ${windows.length} windows; speaker models ${(diarizeSec / (audio.length / 16000 / 60)).toFixed(1)} s per audio minute, sentence prints ${(spanSec / (audio.length / 16000 / 60)).toFixed(1)} s more`);

// Every local speaker of every window, with the parts it speaks in.
const items = [];
const keyOf = {};
windows.forEach((w, wi) => {
  for (const [spk, { print, seconds }] of Object.entries(w.prints)) {
    keyOf[`${wi}:${spk}`] = items.length;
    items.push({ print, seconds, wi, spk: Number(spk) });
  }
});
const partLocal = []; // per part (all windows, in order): item index or null
const allParts = [];
windows.forEach((w, wi) => {
  for (const p of w.parts) {
    const talk = {};
    for (const t of w.turns) {
      const o = Math.min(p.end - w.start, t.end) - Math.max(p.start - w.start, t.start);
      if (o > 0 && keyOf[`${wi}:${t.spk}`] != null) talk[keyOf[`${wi}:${t.spk}`]] = (talk[keyOf[`${wi}:${t.spk}`]] || 0) + o;
    }
    const best = Object.entries(talk).sort((a, b) => b[1] - a[1])[0];
    partLocal.push(best ? Number(best[0]) : null);
    allParts.push(p);
  }
});
writeFileSync('speaker-lab.json', JSON.stringify({ ep: { show: ep.show, title: ep.title }, terms, windows: windows.map((w) => ({ ...w, prints: Object.fromEntries(Object.entries(w.prints).map(([k, v]) => [k, { seconds: v.seconds, print: Array.from(v.print, (x) => Math.round(x * 1e4) / 1e4) }])) })) }));

function show(label, speakerOfPart, full) {
  let last = null;
  const parts = allParts.map((p, i) => {
    const s = speakerOfPart(i);
    if (s != null) last = s;
    return { ...p, speaker: s ?? last };
  });
  const names = guessNames(parts, terms, { host: hostFromShow(ep.show) });
  const talk = {};
  for (const p of parts) if (p.speaker != null) talk[p.speaker] = (talk[p.speaker] || 0) + (p.end - p.start);
  let turns = 0;
  for (let i = 1; i < parts.length; i++) if (parts[i].speaker !== parts[i - 1].speaker) turns++;
  console.log(`\n=== ${label}: ${Object.keys(talk).length} voices, ${turns} speaker changes, names ${JSON.stringify(names)}`);
  console.log(`talk: ${Object.entries(talk).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${speakerName(k, names)} ${(v / 60).toFixed(1)}m`).join(', ')}`);
  if (!full) return;
  let cur = null;
  for (const p of parts) {
    if (!cur || cur.speaker !== p.speaker) {
      if (cur) console.log(`[${Math.round(cur.start)}] ${cur.speaker == null ? '?' : speakerName(cur.speaker, names)}: ${cur.text.join(' ')}`);
      cur = { speaker: p.speaker, start: p.start, text: [] };
    }
    cur.text.push(p.text);
  }
  if (cur) console.log(`[${Math.round(cur.start)}] ${cur.speaker == null ? '?' : speakerName(cur.speaker, names)}: ${cur.text.join(' ')}`);
}

// Replays every window's speaker output through a labelling method, as the app would.
const debugWindows = [];
function replay({ minPrint, short, smooth, retime, debug, own, minSim = 0.3, margin = 0.08, replies = false }) {
  const voices = new Voices();
  let last = null;
  const out = [];
  for (const w of windows) {
    const prints = Object.fromEntries(Object.entries(w.prints).filter(([, p]) => p.seconds >= minPrint));
    let local;
    if (short) local = assignLocals(voices, prints);
    else {
      local = {};
      for (const [spk, { print, seconds }] of Object.entries(prints)) local[spk] = voices.match(print, seconds);
    }
    const rel = w.parts.map((p) => ({ ...p, start: p.start - w.start, end: p.end - w.start }));
    const labelled = labelParts(rel, w.turns, local, last, { switchCost: smooth ? 0.8 : null, retime: retime || false, ...(own ? { voices, spanPrints: w.spanPrints, minSim, margin } : {}), replies });
    if (debug) debugWindows.push({ w, rel: retime ? retimeParts(rel, w.turns) : rel, local, labelled, before: last });
    if (labelled.length && labelled[labelled.length - 1].speaker != null) last = labelled[labelled.length - 1].speaker;
    out.push(...labelled.map((p) => p.speaker ?? null));
  }
  return out;
}
const METHODS = [
  ['before (the app until now)', { minPrint: 1.2, short: false, smooth: false }],
  ['short prints', { minPrint: 0.4, short: true, smooth: false }],
  ['short prints + smoothing', { minPrint: 0.4, short: true, smooth: true }],
  ['+ sentences timed over speech', { minPrint: 0.4, short: true, smooth: true, retime: true }],
  ['+ sentence prints (the app until today)', { minPrint: 0.4, short: true, smooth: true, retime: true, own: true }],
  ['+ replies, blended prints left out (the app now)', { minPrint: 0.4, short: true, smooth: true, retime: true, own: true, replies: true, debug: true }],
];
const results = METHODS.map(([label, opts]) => [label, replay(opts)]);
const CHECKS = CONF.checks.map(([re, who]) => [re, CONF[who]]);
function checkScore(sp) {
  // Voices are judged apart from naming: the guest talks most, the host next.
  const talk = {};
  allParts.forEach((p, i) => { if (sp[i] != null) talk[sp[i]] = (talk[sp[i]] || 0) + (p.end - p.start); });
  const [guest, host] = Object.keys(talk).sort((a, b) => talk[b] - talk[a]);
  const names = { [guest]: CONF.guest, [host]: CONF.host };
  let right = 0;
  let seen = 0;
  const wrong = [];
  for (const [re, who] of CHECKS) {
    const i = allParts.findIndex((p) => re.test(p.text.trim()));
    if (i < 0) continue;
    seen++;
    if (speakerName(sp[i], names) === who) right++;
    else wrong.push(`${allParts[i].text.slice(0, 50)} -> ${speakerName(sp[i], names)}`);
  }
  return { right, seen, wrong };
}
for (const [label, sp] of results) {
  const { right, seen, wrong } = checkScore(sp);
  console.log(`CHECK ${label}: ${right} of ${seen} edge sentences right${wrong.length ? `; wrong: ${wrong.join(' | ')}` : ''}`);
}
for (const [label, sp] of results) show(label, (i) => sp[i], false);
// Every change of speaker, as each method has it, so the edges can be compared by reading.
for (const [label, sp] of [results[0], results[results.length - 1]]) {
  console.log(`\n--- edges: ${label}`);
  for (let i = 1; i < allParts.length; i++) {
    if (sp[i] === sp[i - 1] || sp[i] == null) continue;
    console.log(`[${Math.round(allParts[i].start)}] ${sp[i - 1]}: …${allParts[i - 1].text.slice(-70)} || ${sp[i]}: ${allParts[i].text.slice(0, 90)}`);
  }
}
// The raw evidence at every change of speaker in the last method: sentence times, and the turns.
console.log('\n--- timing at each edge (window-relative seconds)');
for (const { w, rel, local, labelled, before } of debugWindows) {
  for (let i = 0; i < labelled.length; i++) {
    if (labelled[i].speaker === (i ? labelled[i - 1].speaker : before)) continue;
    const near = (a, b) => a < rel[i].start + 4 && b > (i ? rel[i - 1].start : 0) - 4;
    console.log(`[${Math.round(w.start + rel[i].start)}] ${i ? labelled[i - 1].speaker : `(${before})`}->${labelled[i].speaker}`);
    for (let k = Math.max(0, i - 2); k < Math.min(rel.length, i + 2); k++) console.log(`   ${k === i ? '>' : ' '} ${rel[k].start.toFixed(1)}-${rel[k].end.toFixed(1)} v${labelled[k].speaker} ${rel[k].text.slice(0, 60)}`);
    console.log(`     turns: ${w.turns.filter((t) => near(t.start, t.end)).map((t) => `${t.start.toFixed(1)}-${t.end.toFixed(1)} v${local[t.spk] ?? '?'}`).join('  ')}`);
  }
}
// For every edge sentence a method gets wrong: everything the speaker models said about its window.
{
  const [, sp] = results[results.length - 1];
  console.log('\n--- evidence for wrong edge sentences');
  for (const [re, who] of CHECKS) {
    const i = allParts.findIndex((p) => re.test(p.text.trim()));
    if (i < 0) continue;
    const wi = windows.findIndex((w) => w.parts.includes(allParts[i]));
    const w = windows[wi];
    const d = debugWindows.find((x) => x.w === w);
    console.log(`\n"${allParts[i].text.slice(0, 60)}" should be ${who}; window ${wi} at ${w.start.toFixed(1)} s (labelled v${sp[i]})`);
    d.rel.forEach((p, k) => console.log(`   ${w.parts[k] === allParts[i] ? '>' : ' '} ${p.start.toFixed(1)}-${p.end.toFixed(1)} (whisper ${(w.parts[k].start - w.start).toFixed(1)}-${(w.parts[k].end - w.start).toFixed(1)}) v${d.labelled[k].speaker} ${p.text.slice(0, 70)}`));
    console.log(`     turns: ${w.turns.map((t) => `${t.start.toFixed(1)}-${t.end.toFixed(1)} L${t.spk}=v${d.local[t.spk] ?? '?'}`).join('  ')}`);
    console.log(`     prints: ${Object.entries(w.prints).map(([k, v]) => `L${k} ${v.seconds.toFixed(1)}s`).join('  ')}; before: v${d.before}`);
  }
}
const [, now] = results.find(([label]) => label.includes('the app now'));
show('the app now, in full', (i) => now[i], true);
