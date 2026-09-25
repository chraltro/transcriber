// Model shoot-out for Norwegian and Danish: same 2 minute clips through several Whisper
// variants (transformers.js in Node, 8-bit weights like the app's CPU path). Prints text and
// speed so quality can be compared by reading.
import { pipeline } from '@huggingface/transformers';
import { execSync } from 'node:child_process';

async function appleEpisodeUrl(term, country) {
  const s = await (await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=podcast&limit=1&country=${country}`)).json();
  const l = await (await fetch(`https://itunes.apple.com/lookup?id=${s.results[0].collectionId}&entity=podcastEpisode&limit=1&country=${country}`)).json();
  return l.results.find((r) => r.wrapperType === 'podcastEpisode').episodeUrl;
}

function clip(url, fromSec, seconds) {
  const raw = execSync(`ffmpeg -loglevel error -ss ${fromSec} -t ${seconds} -i "${url}" -ac 1 -ar 16000 -f f32le -`, { maxBuffer: 1 << 28 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

const CLIPS = [
  { lang: 'norwegian', url: await appleEpisodeUrl('Abels tårn', 'no'), from: 60, models: [
    'onnx-community/whisper-tiny', 'onnx-community/whisper-base', 'onnx-community/whisper-small', 'onnx-community/whisper-large-v3-turbo',
    'Xenova/nb-whisper-tiny-beta', 'onnx-community/nb-whisper-base-ONNX', 'onnx-community/nb-whisper-small-ONNX',
  ] },
  { lang: 'danish', url: await appleEpisodeUrl('Genstart', 'dk').catch(() => null) || await appleEpisodeUrl('Millionærklubben', 'dk'), from: 60, models: [
    'onnx-community/whisper-base', 'onnx-community/whisper-small', 'onnx-community/whisper-large-v3-turbo', 'varsan-g/hviske-v2-onnx',
  ] },
];

for (const c of CLIPS) {
  let audio;
  try { audio = clip(c.url, c.from, 120); } catch (e) { console.log(`\n### ${c.lang}: could not fetch clip (${e.message.split('\n')[0]})`); continue; }
  console.log(`\n### ${c.lang}: ${c.url.slice(0, 90)} (${(audio.length / 16000).toFixed(0)} s from ${c.from} s)`);
  for (const id of c.models) {
    try {
      const t0 = Date.now();
      const asr = await pipeline('automatic-speech-recognition', id, { dtype: 'q8' });
      const load = (Date.now() - t0) / 1000;
      const t1 = Date.now();
      const out = await asr(audio, { language: c.lang, task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
      const secs = (Date.now() - t1) / 1000;
      console.log(`\n--- ${id}: load ${load.toFixed(0)} s, ${(120 / secs).toFixed(1)}x realtime\n${out.text.trim()}`);
      await asr.dispose?.();
    } catch (e) {
      console.log(`\n--- ${id}: FAILED ${e.message.split('\n')[0]}`);
    }
  }
}
