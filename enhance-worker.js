// The clean-up's heavy lifting, off the page's thread: listening to the whole episode once
// (lib/enhance/analyze.js), rendering previews, and rendering plus encoding the export.
// The page decodes the audio (only it can) and sends it here a piece at a time.
import { Analyzer } from './lib/enhance/analyze.js';
import { Renderer, renderBuffer, RATE } from './lib/enhance/chain.js';
import { LoudnessMeter } from './lib/enhance/modules.js';
import { WavWriter, Mp3Writer } from './lib/enhance/encode.js';

let analyzer = null;
let analysis = null; // { voices, timeline, profiles, ... }
let exporter = null;
let lamejs = null;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

// Profiles cross the boundary as plain arrays (they're cached in localStorage that way).
const toPlain = (profiles) => Object.fromEntries(Object.entries(profiles).map(([id, p]) => [id, { ...p, noisePsd: p.noisePsd ? Array.from(p.noisePsd, (v) => Number(v.toPrecision(5))) : null }]));
const fromPlain = (profiles) => Object.fromEntries(Object.entries(profiles || {}).map(([id, p]) => [id, { ...p, noisePsd: p.noisePsd ? Float64Array.from(p.noisePsd) : null }]));

// The timeline from `from` seconds on, as the renderer sees it (its time 0 is `from`).
function shifted(timeline, from) {
  return timeline.filter((s) => s.end > from).map((s) => ({ start: Math.max(0, s.start - from), end: s.end - from, voice: s.voice }));
}

function renderer(settings, from, hasAlt) {
  return new Renderer({ settings, voices: analysis.voices, timeline: shifted(analysis.timeline, from), profiles: analysis.profiles, rate: RATE, hasAlt, lufs: analysis.lufs });
}

function loudness(x) {
  const m = new LoudnessMeter(RATE);
  m.push(x);
  return { lufs: m.integrated(), peak: m.peakDb() };
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'analyze-start') {
      analyzer = new Analyzer(RATE);
    } else if (type === 'analyze-push') {
      analyzer.push(data.samples);
      post({ type: 'ack', id });
    } else if (type === 'analyze-finish') {
      const r = analyzer.finish({ speakers: data.speakers, names: data.names });
      analyzer = null;
      analysis = r;
      post({ type: 'analysis', id, result: { ...r, profiles: toPlain(r.profiles), dropouts: Array.from(r.dropouts) } });
    } else if (type === 'setup') {
      analysis = { ...data.analysis, profiles: fromPlain(data.analysis.profiles) };
      post({ type: 'ack', id });
    } else if (type === 'preview') {
      // samples start data.from seconds into the episode; the first data.skip are only there to
      // settle the chain (the leveler and noise gates need a few seconds of history).
      const r = renderer(data.settings, data.from, !!data.alt);
      const out = renderBuffer(r, data.samples, data.alt || null, { skip: data.skip });
      const input = data.samples.subarray(data.skip);
      post({ type: 'preview', id, samples: out, input: loudness(input), output: loudness(out) }, [out.buffer]);
    } else if (type === 'export-start') {
      if (data.format === 'mp3' && !lamejs) lamejs = (await import('./lib/vendor/lame.mjs')).default;
      exporter = {
        id,
        r: renderer(data.settings, 0, !!data.hasAlt),
        writer: data.format === 'mp3' ? new Mp3Writer(lamejs, RATE, data.kbps || 192) : new WavWriter(RATE),
        meter: new LoudnessMeter(RATE),
        skip: 0,
        taken: 0,
      };
      exporter.skip = exporter.r.latency;
      post({ type: 'ack', id });
    } else if (type === 'export-push') {
      if (!exporter || exporter.id !== id) return;
      exporter.taken += data.samples.length;
      const bytes = feed(exporter, data.samples, data.alt || null);
      post({ type: 'export-chunk', id, bytes }, [bytes.buffer]);
    } else if (type === 'export-end') {
      if (!exporter || exporter.id !== id) return;
      // Push silence through to get the chain's tail out.
      const L = exporter.r.latency;
      const tail = feed(exporter, new Float32Array(L), exporter.r.paths.some((p) => p.alt) ? new Float32Array(L) : null, exporter.taken);
      const last = exporter.writer.end();
      const header = exporter.writer.header();
      const bytes = new Uint8Array(tail.length + last.length);
      bytes.set(tail);
      bytes.set(last, tail.length);
      post({ type: 'export-done', id, bytes, header, lufs: exporter.meter.integrated(), peak: exporter.meter.peakDb() }, [bytes.buffer]);
      exporter = null;
    } else if (type === 'cancel') {
      if (exporter?.id === id) exporter = null;
    }
  } catch (err) {
    console.error(err);
    post({ type: 'error', id, message: err?.message || String(err) });
  }
};

// Renders a block and encodes what comes out, minus the chain's start-up latency. `limit`
// stops the output at the episode's own length (the flush's silence isn't wanted).
function feed(ex, x, alt, limit = Infinity) {
  let y = ex.r.process(x, alt);
  if (ex.skip > 0) {
    const s = Math.min(ex.skip, y.length);
    y = y.subarray(s);
    ex.skip -= s;
  }
  ex.out = (ex.out || 0);
  if (ex.out + y.length > limit) y = y.subarray(0, Math.max(0, limit - ex.out));
  ex.out += y.length;
  ex.meter.push(y);
  return ex.writer.push(y);
}
