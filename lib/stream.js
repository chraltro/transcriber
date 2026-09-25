// Streaming transcription: audio arrives in pieces while the episode is still being decoded,
// so the whole episode never sits in memory. Cuts it into Whisper-sized windows at pauses and
// reports each window's text. Every job has an id, and a job that has been replaced (a new
// episode started in the same worker) can never touch the new job's audio or offsets.
import { SAMPLE_RATE, SILENCE_RMS, rms, nextCut } from './segment.js';
import { HALLUCINATIONS, dedupeRepeats } from './text.js';

function append(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export class StreamingTranscriber {
  // transcribe(samples, language) -> Promise<string>; post(message) sends to the page.
  constructor({ transcribe, post, now = () => performance.now() }) {
    this.transcribe = transcribe;
    this.post = post;
    this.now = now;
    this.job = null;
  }

  start(id, { language, offsetSec = 0 }) {
    this.job = {
      id,
      language,
      pending: new Float32Array(0),
      offset: Math.round(offsetSec * SAMPLE_RATE),
      final: false,
      running: false,
      ready: false,
      t0: 0,
    };
  }

  // The model is loaded for job `id`; start transcribing whatever has arrived.
  ready(id) {
    const j = this.job;
    if (!j || j.id !== id) return Promise.resolve();
    j.ready = true;
    j.t0 = this.now();
    return this.drain();
  }

  push(id, samples, final = false) {
    const j = this.job;
    if (!j || j.id !== id) return Promise.resolve();
    if (samples.length) j.pending = append(j.pending, samples);
    if (final) j.final = true;
    this.post({ type: 'buffered', id, seconds: j.pending.length / SAMPLE_RATE });
    return this.drain();
  }

  cancel(id) {
    if (this.job && (id == null || this.job.id === id)) this.job = null;
  }

  async drain() {
    const j = this.job;
    if (!j || j.running || !j.ready) return;
    j.running = true;
    try {
      for (;;) {
        if (this.job !== j) return;
        const cut = nextCut(j.pending, 0, j.final);
        if (cut == null) break;
        const chunk = j.pending.subarray(0, cut);
        let text = '';
        if (rms(chunk, 0, chunk.length) > SILENCE_RMS) {
          text = dedupeRepeats((await this.transcribe(chunk, j.language)) || '');
          if (HALLUCINATIONS.test(text)) text = '';
        }
        if (this.job !== j) return; // replaced while the model was busy: drop the result
        const start = j.offset / SAMPLE_RATE;
        j.offset += cut;
        j.pending = j.pending.slice(cut);
        this.post({
          type: 'segment',
          id: j.id,
          start,
          end: j.offset / SAMPLE_RATE,
          text,
          buffered: j.pending.length / SAMPLE_RATE,
          elapsed: (this.now() - j.t0) / 1000,
        });
      }
      if (j.final && j.pending.length === 0 && this.job === j) {
        this.job = null;
        this.post({ type: 'done', id: j.id });
      }
    } finally {
      j.running = false;
    }
  }
}
