// Runs the speaker models on one window: pyannote segmentation for who-speaks-when, WeSpeaker
// for a voice print of each local speaker. `tf` is the transformers.js module (the worker loads
// it from the CDN, tests from npm). Both models are small and run on the CPU.
import { framesToTurns, speechSeconds } from './speakers.js';

export const SEGMENTATION_MODEL = 'onnx-community/pyannote-segmentation-3.0';
export const VOICE_MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM';
const RATE = 16000;
const MIN_PRINT_SEC = 1.2; // shorter snippets give unreliable voice prints
const MAX_PRINT_SEC = 12;
const PIECE_SEC = 10;

function firstTensor(out) {
  return out.embeddings || out.last_hidden_state || out.pooler_output || Object.values(out)[0];
}

// `device` is 'wasm' in the browser; left out, transformers.js picks its default (the CPU in Node).
export async function createDiarizer(tf, { progress_callback, device } = {}) {
  const opts = { ...(device ? { device } : {}), dtype: 'fp32', progress_callback };
  const [segProc, segModel, voiceProc, voiceModel] = await Promise.all([
    tf.AutoProcessor.from_pretrained(SEGMENTATION_MODEL, { progress_callback }),
    tf.AutoModelForAudioFrameClassification.from_pretrained(SEGMENTATION_MODEL, opts),
    tf.AutoProcessor.from_pretrained(VOICE_MODEL, { progress_callback }),
    tf.AutoModel.from_pretrained(VOICE_MODEL, opts),
  ]);

  // Segmentation runs on 10 s pieces, the length the model was trained on. A whole 30 s window
  // at once needs about 150 MB for the first layer alone, and WebAssembly memory never shrinks.
  // Local speaker ids only mean something within one piece, so they are keyed by piece.
  async function segment(piece, offsetSec, key0) {
    const { logits } = await segModel(await segProc(piece));
    const [, frames, k] = logits.dims;
    const data = logits.data;
    const classes = new Array(frames);
    for (let f = 0; f < frames; f++) {
      let best = 0;
      for (let c = 1; c < k; c++) if (data[f * k + c] > data[f * k + best]) best = c;
      classes[f] = best;
    }
    logits.dispose?.();
    return framesToTurns(classes, piece.length / RATE / frames)
      .map((t) => ({ spk: key0 + t.spk, start: t.start + offsetSec, end: t.end + offsetSec }));
  }

  async function diarize(samples) {
    const turns = [];
    const n = Math.max(1, Math.round(samples.length / (PIECE_SEC * RATE)));
    const size = Math.ceil(samples.length / n);
    for (let i = 0; i < n; i++) {
      const piece = samples.subarray(i * size, Math.min(samples.length, (i + 1) * size));
      if (piece.length >= RATE / 2) turns.push(...await segment(piece, (i * size) / RATE, i * 3));
    }
    const seconds = speechSeconds(turns);
    const prints = {};
    for (const [spk, sec] of Object.entries(seconds)) {
      if (sec < MIN_PRINT_SEC) continue;
      // The speaker's own stretches, longest first, up to MAX_PRINT_SEC.
      const mine = turns.filter((t) => t.spk === Number(spk)).sort((a, b) => (b.end - b.start) - (a.end - a.start));
      const pieces = [];
      let total = 0;
      for (const t of mine) {
        if (total >= MAX_PRINT_SEC * RATE) break;
        const a = Math.floor(t.start * RATE);
        const b = Math.min(samples.length, Math.floor(t.end * RATE), a + MAX_PRINT_SEC * RATE - total);
        if (b > a) { pieces.push(samples.subarray(a, b)); total += b - a; }
      }
      const audio = new Float32Array(total);
      let o = 0;
      for (const p of pieces) { audio.set(p, o); o += p.length; }
      const out = await voiceModel(await voiceProc(audio));
      const t = firstTensor(out);
      prints[spk] = { print: Float32Array.from(t.data), seconds: Math.min(sec, MAX_PRINT_SEC) };
      for (const x of Object.values(out)) x.dispose?.();
    }
    return { turns, prints };
  }

  diarize.dispose = async () => {
    await segModel.dispose?.();
    await voiceModel.dispose?.();
  };
  return diarize;
}
