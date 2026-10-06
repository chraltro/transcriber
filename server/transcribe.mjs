// One episode, start to finish, with the app's own pipeline (lib/stream.js and friends):
// download, decode with ffmpeg as it streams, transcribe in windows cut at pauses, label who
// speaks, and return an entry in the shape the app keeps in its library, so the app opens it
// like one of its own.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline as pipe } from 'node:stream/promises';
import { StreamingTranscriber } from '../lib/stream.js';
import { transcribeWindow } from '../lib/prompted.js';
import { buildPrompt, extractTerms } from '../lib/context.js';
import { detectLanguage } from '../lib/langid.js';
import { correctText } from '../lib/glossary.js';
import { secondLevels, encodeLevels } from '../lib/levels.js';
import { wordCount } from '../lib/paragraphs.js';

const RATE = 16000;
const BLOCK = 30 * RATE; // decoded audio is handed over 30 s at a time (whole seconds, for the levels)
const AHEAD = 120 * RATE; // decoding waits while this much is waiting to be transcribed
const UA = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -> the audio's file extension, from its type (the copy is kept for playback).
async function download(url, file) {
  const res = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(30 * 60000) });
  if (!res.ok) throw new Error(`Audio: HTTP ${res.status}`);
  await pipe(Readable.fromWeb(res.body), createWriteStream(file));
  const type = res.headers.get('content-type') || '';
  return /mp4|m4a|aac/i.test(type) || /\.m4a(\?|$)/i.test(url) ? 'm4a' : 'mp3';
}

// models: { tf, asr, diarizer, checker, modelKey }
export async function transcribeEpisode(ep, models, { tmpFile, onProgress = () => {} } = {}) {
  const { tf, asr, diarizer, checker, modelKey } = models;
  const terms = extractTerms(ep.notes || '', ep.title || '', ep.show || '');
  const vocab = { terms, replace: [] };
  const promptState = {};
  const segments = [];
  const levels = [];
  let voices = [];
  let done = false;
  let failure = null;

  const ext = await download(ep.url, tmpFile);
  const t0 = Date.now();
  const stream = new StreamingTranscriber({
    now: () => Date.now(),
    post: (m) => {
      if (m.type === 'segment') {
        if (m.voices) voices = m.voices;
        const pieces = m.parts?.length ? m.parts : m.text ? [{ start: m.start, end: m.end, text: m.text }] : [];
        for (const x of pieces) {
          const seg = { start: x.start, end: x.end, text: correctText(x.text, vocab), w: m.start };
          if (x.speaker != null) seg.speaker = x.speaker;
          if (seg.text.trim()) segments.push(seg);
        }
        onProgress({ position: m.end, elapsed: (Date.now() - t0) / 1000 });
      } else if (m.type === 'done') done = true;
      else if (m.type === 'speakers-off') console.warn(`  speakers off: ${m.message}`);
    },
    diarize: diarizer ? (samples, opts) => diarizer(samples, opts) : null,
    detect: checker ? (samples) => detectLanguage(checker, samples, tf.Tensor) : null,
    transcribe: (samples, language, { previous } = {}) =>
      transcribeWindow(asr, samples, { language, prompt: buildPrompt(terms, previous), state: promptState }),
  });
  const id = 1;
  stream.start(id, { language: 'english', speakers: !!diarizer, detectLanguage: checker ? 'transcribe' : false });
  stream.ready(id).catch((err) => { failure = err; });

  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-i', tmpFile, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let ffErr = '';
  ff.stderr.on('data', (d) => { ffErr += d; });
  let carry = Buffer.alloc(0);
  let block = [];
  let blockLen = 0;
  const hand = async (samples, final) => {
    levels.push(...secondLevels(samples));
    await stream.push(id, samples, final);
    while (!failure && stream.job && stream.job.pending.length > AHEAD) await sleep(250);
  };
  for await (const chunk of ff.stdout) {
    if (failure) break;
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const usable = buf.length - (buf.length % 4);
    carry = buf.subarray(usable);
    const samples = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + usable));
    block.push(samples);
    blockLen += samples.length;
    if (blockLen >= BLOCK) {
      const all = new Float32Array(blockLen);
      let o = 0;
      for (const b of block) { all.set(b, o); o += b.length; }
      const whole = all.length - (all.length % RATE);
      await hand(all.subarray(0, whole), false);
      block = [all.slice(whole)];
      blockLen = block[0].length;
    }
  }
  const code = await new Promise((r) => (ff.exitCode != null ? r(ff.exitCode) : ff.on('close', r)));
  if (code !== 0 && !failure) failure = new Error(`ffmpeg: ${ffErr.trim().split('\n').pop() || `exit ${code}`}`);
  if (!failure) {
    const rest = new Float32Array(blockLen);
    let o = 0;
    for (const b of block) { rest.set(b, o); o += b.length; }
    await hand(rest, true);
    while (!done && !failure) await sleep(250);
  }
  stream.cancel(id);
  if (failure) {
    await rm(tmpFile, { force: true });
    throw failure;
  }

  const total = levels.length;
  return {
    id: ep.id,
    createdAt: ep.published || Date.now(),
    transcribedAt: Date.now(),
    title: ep.title,
    show: ep.show,
    art: ep.art || '',
    lang: 'english',
    model: modelKey,
    total,
    words: wordCount(segments),
    segments,
    levels: encodeLevels(Uint8Array.from(levels)),
    key: `server:${ep.id}`,
    source: { url: ep.url },
    notes: ep.notes || '',
    voices,
    speakerNames: {},
    took: (Date.now() - t0) / 1000,
    audioExt: ext,
  };
}
