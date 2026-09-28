// Runs the speaker models on one window: pyannote segmentation for who-speaks-when, WeSpeaker
// for a voice print of each local speaker. `tf` is the transformers.js module (the worker loads
// it from the CDN, tests from npm). Both models are small and run on the CPU.
import { framesToTurns, speechSeconds } from './speakers.js';

export const SEGMENTATION_MODEL = 'onnx-community/pyannote-segmentation-3.0';
export const VOICE_MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM';
const RATE = 16000;
const MIN_PRINT_SEC = 1.2; // shorter snippets give unreliable voice prints
const MAX_PRINT_SEC = 12;

function firstTensor(out) {
  return out.embeddings || out.last_hidden_state || out.pooler_output || Object.values(out)[0];
}

export async function createDiarizer(tf, { progress_callback } = {}) {
  const opts = { device: 'wasm', dtype: 'fp32', progress_callback };
  const [segProc, segModel, voiceProc, voiceModel] = await Promise.all([
    tf.AutoProcessor.from_pretrained(SEGMENTATION_MODEL, { progress_callback }),
    tf.AutoModelForAudioFrameClassification.from_pretrained(SEGMENTATION_MODEL, opts),
    tf.AutoProcessor.from_pretrained(VOICE_MODEL, { progress_callback }),
    tf.AutoModel.from_pretrained(VOICE_MODEL, opts),
  ]);

  async function diarize(samples) {
    const { logits } = await segModel(await segProc(samples));
    const [, frames, k] = logits.dims;
    const data = logits.data;
    const classes = new Array(frames);
    for (let f = 0; f < frames; f++) {
      let best = 0;
      for (let c = 1; c < k; c++) if (data[f * k + c] > data[f * k + best]) best = c;
      classes[f] = best;
    }
    logits.dispose?.();
    const turns = framesToTurns(classes, samples.length / RATE / frames);
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
