// Language check lab: lib/langid.js on real podcasts, 30 s at a time, before the app relies on
// it. English shows must never be flagged (a false alarm hides a window's transcript); Norwegian,
// Danish and German shows must be flagged when the episode is set to English. Also: can the
// Norwegian-tuned models (NB-Whisper) tell English apart, for English ads in Norwegian shows.
import * as tf from '@huggingface/transformers';
import { execSync } from 'node:child_process';
import { detectLanguage, foreignLanguage } from '../lib/langid.js';

const MINUTES = Number(process.env.MINUTES || 20);
const CLIPS = [
  { term: 'Plain English Derek Thompson', country: 'us', lang: 'english' },
  { term: 'Lex Fridman Podcast', country: 'us', lang: 'english' },
  { term: 'Up First NPR', country: 'us', lang: 'english' },
  { term: 'Conversations with Tyler', country: 'us', lang: 'english' },
  { term: 'Fresh Air NPR', country: 'us', lang: 'english' },
  { term: 'Planet Money NPR', country: 'us', lang: 'english' },
  { term: 'Freakonomics Radio', country: 'us', lang: 'english' },
  { term: 'Abels tårn', country: 'no', lang: 'norwegian' },
  { term: 'Millionærklubben', country: 'dk', lang: 'danish' },
  { term: 'Zeit Verbrechen', country: 'de', lang: 'german' },
];

async function episode({ term, country }) {
  const s = await (await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=podcast&limit=1&country=${country}`)).json();
  const l = await (await fetch(`https://itunes.apple.com/lookup?id=${s.results[0].collectionId}&entity=podcastEpisode&limit=3&country=${country}`)).json();
  const ep = l.results.find((r) => r.wrapperType === 'podcastEpisode' && r.episodeUrl);
  return { title: `${s.results[0].collectionName}: ${ep.trackName}`, url: ep.episodeUrl };
}
function load(url, minutes) {
  execSync(`curl -sSL --fail -A "Mozilla/5.0" -o clip.bin "${url}"`);
  const raw = execSync(`ffmpeg -loglevel error -t ${minutes * 60} -i clip.bin -ac 1 -ar 16000 -f f32le -`, { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

// NB-Whisper was tried too: it hears plain English as Norwegian with full confidence, so the app
// checks with Tiny whatever the main model.
const MODELS = {
  tiny: await tf.pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny', { dtype: 'q8' }),
};

for (const clip of CLIPS) {
  let ep;
  let audio;
  try {
    ep = await episode(clip);
    audio = load(ep.url, MINUTES);
  } catch (e) {
    console.log(`\n${clip.term}: skipped (${e.message.split('\n')[0]})`);
    continue;
  }
  console.log(`\n=== ${clip.lang}: ${ep.title}`);
  for (const [name, asr] of Object.entries(MODELS)) {
    if (name === 'nb-base' && clip.lang !== 'norwegian' && clip.lang !== 'english') continue;
    const tops = {};
    let asEnglish = 0;
    let asOwn = 0;
    let windows = 0;
    let ms = 0;
    for (let at = 0; at + 16000 * 5 < audio.length; at += 16000 * 30) {
      const t = Date.now();
      const probs = await detectLanguage(asr, audio.subarray(at, Math.min(audio.length, at + 16000 * 30)), tf.Tensor);
      ms += Date.now() - t;
      windows++;
      const [code, p] = Object.entries(probs).sort((a, b) => b[1] - a[1])[0];
      tops[code] = (tops[code] || 0) + 1;
      // Flagged when the episode is set to English / set to its own language.
      const f1 = foreignLanguage(probs, 'english');
      const f2 = foreignLanguage(probs, clip.lang);
      if (f1) asEnglish++;
      if (f2) { asOwn++; console.log(`  ${name} flags ${Math.round(at / 16000)} s as ${f2.name} (${(f2.prob * 100).toFixed(0)}%; ${clip.lang} ${(100 * (probs[clip.lang === 'english' ? 'en' : clip.lang.slice(0, 2)] || 0)).toFixed(0)}%)`); }
      if (p < 0.8) console.log(`  ${name} unsure at ${Math.round(at / 16000)} s: ${Object.entries(probs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, x]) => `${c} ${(x * 100).toFixed(0)}%`).join(', ')}`);
    }
    console.log(`RESULT ${clip.lang} ${name}: ${windows} windows, top languages ${JSON.stringify(tops)}; flagged as foreign in an English episode: ${asEnglish}; flagged in its own language: ${asOwn}; ${(ms / windows).toFixed(0)} ms per window`);
  }
}
