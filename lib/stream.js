// Streaming transcription: audio arrives in pieces while the episode is still being decoded,
// so the whole episode never sits in memory. Cuts it into Whisper-sized windows at pauses and
// reports each window's text. Every job has an id, and a job that has been replaced (a new
// episode started in the same worker) can never touch the new job's audio or offsets.
import { SAMPLE_RATE, SILENCE_RMS, rms, nextCut } from './segment.js';
import { HALLUCINATIONS, dedupeRepeats } from './text.js';
import { Voices, labelParts, sentenceParts, assignLocals } from './speakers.js';

function append(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export class StreamingTranscriber {
  // transcribe(samples, language, { previous }) -> Promise<{ text, parts } | string>;
  // post(message) sends to the page. `previous` is the last window's text, which Whisper uses
  // as context. diarize(samples) -> Promise<{ turns, prints }> is optional; with it, every
  // part gets a speaker.
  constructor({ transcribe, post, diarize = null, now = () => performance.now() }) {
    this.transcribe = transcribe;
    this.diarize = diarize;
    this.post = post;
    this.now = now;
    this.job = null;
  }

  // diarizeOnly: no transcription, only who speaks when in each window (the phone speaker pass,
  // run after Whisper has been unloaded). Windows are cut exactly as when transcribing.
  start(id, { language, offsetSec = 0, previous = '', speakers = false, voices = [], lastSpeaker = null, diarizeOnly = false }) {
    this.job = {
      id,
      diarizeOnly,
      language,
      previous,
      speakers,
      voices: new Voices(voices),
      lastSpeaker,
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
        const start = j.offset / SAMPLE_RATE;
        const duration = chunk.length / SAMPLE_RATE;
        let parts = [];
        let speakers = null;
        if (j.diarizeOnly) {
          if (rms(chunk, 0, chunk.length) > SILENCE_RMS) {
            const { turns, prints } = await this.diarize(chunk);
            const local = assignLocals(j.voices, prints);
            speakers = { turns: turns.map((t) => ({ ...t, start: t.start + start, end: t.end + start })), local };
          }
        } else if (rms(chunk, 0, chunk.length) > SILENCE_RMS) {
          let res = await this.transcribe(chunk, j.language, { previous: j.previous });
          if (typeof res === 'string' || !res) res = { parts: res ? [{ start: 0, end: duration, text: res }] : [] };
          parts = res.parts
            .map((p) => ({ start: p.start, end: p.end, text: dedupeRepeats((p.text || '').trim()) }))
            .filter((p) => p.text && !HALLUCINATIONS.test(p.text));
          parts = sentenceParts(parts);
          if (parts.length && j.speakers && this.diarize && this.job === j) {
            try {
              const { turns, prints } = await this.diarize(chunk);
              const local = assignLocals(j.voices, prints);
              parts = labelParts(parts, turns, local, j.lastSpeaker);
              const lastPart = parts[parts.length - 1];
              if (lastPart.speaker != null) j.lastSpeaker = lastPart.speaker;
            } catch (err) {
              console.warn('Speaker detection failed; carrying on without it', err);
              j.speakers = false;
              this.post({ type: 'speakers-off', id: j.id, message: err?.message || String(err) });
            }
          }
        }
        const text = parts.map((p) => p.text).join(' ');
        if (text) j.previous = text;
        if (this.job !== j) return; // replaced while the model was busy: drop the result
        j.offset += cut;
        j.pending = j.pending.slice(cut);
        this.post({
          type: 'segment',
          id: j.id,
          start,
          end: j.offset / SAMPLE_RATE,
          text,
          parts: parts.map((p) => ({ ...p, start: start + p.start, end: start + p.end })),
          ...(j.speakers || j.diarizeOnly ? { voices: j.voices.toJSON() } : {}),
          ...(speakers ? { speakers } : {}),
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
