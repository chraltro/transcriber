// A stand-in for worker.js in the fast UI test: no models, instant canned speech from two
// voices (a host, "Derek Thompson", and a guest, "Anna Berg") and a sponsor read's few seconds, delivered as timed parts through
// the app's real StreamingTranscriber, including the phone speaker pass.
import { StreamingTranscriber } from './lib/stream.js';
const LINES = [
  "Welcome back to the show, I'm Derek Thompson. Today we are talking about something that sounds simple but turns out to be surprisingly deep, which is how cities decide where to put their bridges, and why those decisions end up shaping everything around them for a hundred years.",
  "Our guest has spent most of her career studying exactly that. She has walked every crossing in Oslo, Copenhagen and Stockholm, and she has opinions about all of them. Anna Berg, welcome to the show.",
  "Thanks for having me. I should say up front that my opinions are strong but they are also well documented, so you can check my work. The first thing people get wrong is thinking a bridge is about the river. It is almost never about the river. It is about the",
  "neighbourhoods on either side, and which of them had the money and the patience to wait for it. Once you see that, every map starts to look like a record of old arguments.",
  "That is a wonderful way to put it. Give me an example, as Sayash Kapoor would, one that surprised you, something you did not expect when you started digging into the archives.",
  "The best one is a footbridge that took forty years to build, not because it was hard to engineer, but because two parishes could not agree on whose side the stairs should land. In the end they built stairs on both sides and nobody used either of them for a decade.",
  "And then what changed, as Sayosh Kapoor asks? Did the city grow into it, or did people just give up and start walking the long way round?",
  "A school opened on the far bank. Suddenly every parent in the district needed that bridge twice a day, and the stairs that nobody wanted became the busiest ten metres in the city. I love that story because it shows the design was never the problem.",
  "So the lesson from Sayash Kapoor is patience, or the lesson is that you cannot predict what a crossing will be for until the people on both sides give it a reason to exist.",
  "This episode is brought to you by Acme. Use code BRIDGE for 20% off. Both, really. The engineers do their part in a few years. The rest of it takes a generation, and nobody who approves the budget ever lives to see whether they were right.",
];
const post = (m) => self.postMessage(m);
let n = 0;
const DELAY = Number(new URL(self.location.href).searchParams.get('delay') || 80);
let rough = false;
const sketch = (t) => t.toLowerCase().replace(/[,.]/g, '').replace(/\b(the|and)\b/g, 'uh');
let cur = 0;
let d = 0;
const HOST = [0, 1, 4, 6, 8];
const stream = new StreamingTranscriber({ post,
  transcribe: async (samples) => {
    await new Promise((r) => setTimeout(r, DELAY));
    cur = n % LINES.length;
    const t = LINES[n++ % LINES.length];
    const dur = samples.length / 16000;
    const sentences = t.match(/[^.?!]+[.?!]?/g).map((x) => x.trim()).filter(Boolean);
    const total = sentences.reduce((a, x) => a + x.length, 0);
    let at = 0;
    const parts = sentences.map((x) => { const p = { start: at, end: at + dur * x.length / total, text: x }; at = p.end; return p; });
    return { text: t, parts };
  },
  diarize: async (samples) => {
    const dur = samples.length / 16000;
    const line = d++ % LINES.length;
    const host = HOST.includes(line);
    const v = host ? [1, 0, 0, 0] : [0, 0, 1, 0];
    // The sponsor read opens with a third voice for a few seconds: an "Other voice".
    if (line === 9) return { turns: [{ spk: 1, start: 0, end: 4 }, { spk: 0, start: 4, end: dur }], prints: { 0: { print: v, seconds: dur - 4 }, 1: { print: [0, 0, 0, 1], seconds: 4 } } };
    return { turns: [{ spk: 0, start: 0, end: dur }], prints: { 0: { print: v, seconds: dur } } };
  },
});
self.onmessage = async ({ data }) => {
  const { id } = data;
  if (data.type === 'start') {
    n = Math.round((data.offsetSec || 0) / 20);
    d = n;
    rough = /tiny/.test(data.model);
    stream.start(id, data);
    post({ type: 'status', id, text: 'Loading speech model' });
    for (let i = 1; i <= 5; i++) { await new Promise((r) => setTimeout(r, 120)); post({ type: 'model-progress', id, status: 'progress_total', loaded: i * 8e6, total: 41e6 }); }
    if (stream.job?.id !== id) return;
    post({ type: 'ready', id, device: data.device });
    await stream.ready(id);
  } else if (data.type === 'audio') await stream.push(id, data.samples, data.final);
  else if (data.type === 'cancel') stream.cancel(id);
};
