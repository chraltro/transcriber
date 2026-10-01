// Speaker lab: one real interview (The Ezra Klein Show with Bill Gates, by default) through the
// app's own transcription and speaker code. Every window's raw speaker output (turns and voice
// prints) is kept, so ways of turning voice prints into speakers can be compared on exactly the
// same data: the app's on-the-fly matching (Voices) and clustering with hindsight
// (clusterVoices) at a few thresholds. Each is printed as the reader would see it.
//   SHOW, EPISODE (regex), MINUTES, MODEL
import * as tf from '@huggingface/transformers';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { StreamingTranscriber } from '../lib/stream.js';
import { transcribeWindow } from '../lib/prompted.js';
import { buildPrompt, extractTerms } from '../lib/context.js';
import { dtypeFor } from '../lib/models.js';
import { createDiarizer } from '../lib/diarize.js';
import { guessNames, speakerName, clusterVoices, hostFromShow, Voices, assignLocals, labelParts, retimeParts } from '../lib/speakers.js';

const SHOW = process.env.SHOW || 'The Ezra Klein Show';
const EPISODE = new RegExp(process.env.EPISODE || 'Gates', 'i');
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
const diarize = async (samples) => (lastDiarized = await diarizer(samples));

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
console.log(`${MODEL}: ${((audio.length / 16000) / ((Date.now() - t0) / 1000)).toFixed(1)}x realtime, ${windows.length} windows`);

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
function replay({ minPrint, short, smooth, retime, debug }) {
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
    const labelled = labelParts(rel, w.turns, local, last, { switchCost: smooth ? 0.8 : null, retime: retime || false });
    if (debug) debugWindows.push({ w, rel: retime ? retimeParts(rel, w.turns, retime) : rel, local, labelled, before: last });
    if (labelled.length && labelled[labelled.length - 1].speaker != null) last = labelled[labelled.length - 1].speaker;
    out.push(...labelled.map((p) => p.speaker ?? null));
  }
  return out;
}
const METHODS = [
  ['before (the app until now)', { minPrint: 1.2, short: false, smooth: false }],
  ['short prints', { minPrint: 0.4, short: true, smooth: false }],
  ['short prints + smoothing', { minPrint: 0.4, short: true, smooth: true }],
  ['+ sentences timed over speech, per Whisper part', { minPrint: 0.4, short: true, smooth: true, retime: 'part' }],
  ['+ sentences timed over speech, whole window', { minPrint: 0.4, short: true, smooth: true, retime: 'window' }],
  ['+ sentences timed over speech, blend', { minPrint: 0.4, short: true, smooth: true, retime: 'blend', debug: true }],
];
const results = METHODS.map(([label, opts]) => [label, replay(opts)]);
// Sentences at turn edges whose speaker is certain from the conversation (read and checked by
// hand for the Gates episode): who said them.
const CHECKS = process.env.EPISODE ? [] : [
  [/How do you see that question/i, 'Ezra Klein'],
  [/I'm curious where yours is/i, 'Ezra Klein'],
  [/doesn't feel to me that we're so disengaged/i, 'Ezra Klein'],
  [/you just wrote this essay on AI risk/i, 'Ezra Klein'],
  [/Jensen Huang's view/i, 'Ezra Klein'],
  [/this is not my view, but it is President Trump/i, 'Ezra Klein'],
  [/welcome to the show/i, 'Ezra Klein'],
  [/So that was 30 years ago/i, 'Ezra Klein'],
  [/Do you think that's far from being a capability/i, 'Ezra Klein'],
  [/What specifically was the threshold/i, 'Ezra Klein'],
  [/is the governing view of the United States/i, 'Ezra Klein'],
  [/So the two counter ?arguments/i, 'Ezra Klein'],
  [/^Yeah, so\.?$/i, 'Bill Gates'],
  [/^Great to see you/i, 'Bill Gates'],
  [/^Does super powerful AI create/i, 'Bill Gates'],
  [/almost can't believe you're asking that/i, 'Bill Gates'],
  [/So they don't mind bioterrorism/i, 'Bill Gates'],
  [/There's no doubt,? to date/i, 'Bill Gates'],
  [/the notion that computation could provide thinking/i, 'Bill Gates'],
  [/key thing is we always said when we cross/i, 'Bill Gates'],
];
function checkScore(sp) {
  const parts = allParts.map((p, i) => ({ ...p, speaker: sp[i] }));
  const names = guessNames(parts, terms, { host: hostFromShow(ep.show) });
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
for (const [label, sp] of results.slice(3)) {
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
const [, now] = results[results.length - 1];
show('the app now, in full', (i) => now[i], true);
for (const th of [0.4, 0.5]) {
  const ids = clusterVoices(items, { threshold: th });
  show(`hindsight ${th}`, (i) => (partLocal[i] == null ? null : ids[partLocal[i]]), false);
}
// How alike the local prints of the biggest groups are, to see where a threshold should sit.
const ids = clusterVoices(items, { threshold: 0.45 });
const groups = {};
ids.forEach((g, i) => { if (g != null && items[i].seconds >= 2.5) (groups[g] ||= []).push(i); });
const unit = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const gs = Object.keys(groups).slice(0, 6);
console.log('\nmean similarity between groups (hindsight 0.45), diagonal = within:');
for (const a of gs) {
  console.log(`  ${a} (${groups[a].length} prints): ${gs.map((b) => {
    let s = 0; let n = 0;
    for (const i of groups[a]) for (const j of groups[b]) if (i !== j) { s += dot(unit(Array.from(items[i].print)), unit(Array.from(items[j].print))); n++; }
    return (n ? s / n : 0).toFixed(2);
  }).join(' ')}`);
}
