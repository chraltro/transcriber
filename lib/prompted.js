// Whisper with a prompt, and with timestamps. Transformers.js doesn't expose Whisper's prompt
// option, but a prompt is only extra start tokens (<|startofprev|> text... <|startoftranscript|>
// ...), so the model is called directly and only the newly generated tokens are kept.
// Timestamp tokens split a window into sentence-sized parts, each with its own start and end,
// which is what speaker labels and subtitles need. Falls back to no prompt when the output
// repeats the prompt or loops (small models sometimes do), and to the plain pipeline if the
// direct call isn't supported.
import { collapseLoops } from './text.js';

const norm = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();

export function looksEchoed(text, prompt) {
  const t = norm(text);
  if (!t) return false;
  if (t.length > 12 && norm(prompt).includes(t)) return true;
  const collapsed = collapseLoops(text);
  return collapsed.length < text.length * 0.7;
}

const toList = (x) => (typeof x?.tolist === 'function' ? x.tolist() : x);

// Seconds of a window that sound like speech (100 ms frames above a quiet floor).
export function speechSeconds(samples, rate = 16000) {
  const frame = rate / 10;
  let n = 0;
  for (let i = 0; i + frame <= samples.length; i += frame) {
    let e = 0;
    for (let j = i; j < i + frame; j++) e += samples[j] * samples[j];
    if (Math.sqrt(e / frame) > 0.005) n++;
  }
  return n / 10;
}

// What looks broken about a window's text. Greedy decoding, especially with 8-bit weights, now
// and then falls off a cliff: a letter stuck on repeat ("Sææææææ"), a phrase or sentence
// looping, or whole stretches of speech dropped. Whisper's reference code re-decodes such
// windows; so do we (transcribeWindow).
export function windowTrouble(text, speech = 0) {
  const t = (text || '').trim();
  const issues = [];
  if (/(\p{L})\1{4,}/u.test(t)) issues.push('stuck');
  if (t && collapseLoops(t).length < t.length * 0.75) issues.push('loop');
  const sentences = t.split(/(?<=[.!?])\s+/).map((x) => norm(x)).filter((x) => x.length > 3);
  if (sentences.length >= 3 && new Set(sentences).size <= sentences.length * 0.6) issues.push('repeats');
  const words = t ? t.split(/\s+/).length : 0;
  if (speech >= 10 && words < speech * 0.6) issues.push('sparse'); // people say 2 to 3 words a second
  return issues;
}
const TICK = 0.02; // seconds per timestamp token

// Generated tokens -> [{ start, end, tokens }], times relative to the window. A part without a
// closing timestamp (the window ran out mid-sentence) ends at `duration`.
export function splitTimestamps(tokens, timestampBegin, duration) {
  const parts = [];
  let cur = null;
  let last = 0;
  for (const tok of tokens) {
    if (tok >= timestampBegin) {
      const t = Math.min(duration, (tok - timestampBegin) * TICK);
      if (cur && cur.tokens.length) {
        cur.end = Math.max(cur.start, t);
        parts.push(cur);
        cur = null;
      } else {
        cur = { start: t, end: t, tokens: [] };
      }
      last = t;
    } else {
      if (!cur) cur = { start: last, end: last, tokens: [] };
      cur.tokens.push(tok);
    }
  }
  if (cur && cur.tokens.length) {
    cur.end = duration;
    cur.open = true;
    parts.push(cur);
  }
  return parts;
}

// The end of what the parts cover: where the next pass has to pick up if Whisper stopped early.
export const coveredUntil = (parts) => (parts.length ? parts[parts.length - 1].end : 0);

export async function transcribeWindow(asr, samples, { language, prompt = '', state = {}, timestamps = true } = {}) {
  const { model, tokenizer, processor } = asr;
  const gen = model.generation_config || {};
  const multilingual = !!gen.is_multilingual;
  const duration = samples.length / 16000;
  const whole = (text) => ({ text, parts: text ? [{ start: 0, end: duration, text }] : [] });
  const plain = async () => {
    const out = await asr(samples, multilingual ? { language, task: 'transcribe' } : {});
    return whole((out.text || '').trim());
  };
  if (state.broken || typeof model._retrieve_init_tokens !== 'function') return plain();
  try {
    const stamps = timestamps && !state.noTimestamps && gen.no_timestamps_token_id != null;
    const init = model._retrieve_init_tokens({ ...gen, language: multilingual ? language : null, task: multilingual ? 'transcribe' : null, return_timestamps: stamps });
    const sop = gen.prev_sot_token_id ?? tokenizer.model?.tokens_to_ids?.get?.('<|startofprev|>');
    const decode = (ids) => tokenizer.decode(ids, { skip_special_tokens: true }).trim();

    const run = async (audio, context, withStamps = stamps) => {
      const initFor = withStamps === stamps ? init
        : model._retrieve_init_tokens({ ...gen, language: multilingual ? language : null, task: multilingual ? 'transcribe' : null, return_timestamps: withStamps });
      let prefix = initFor;
      if (context && sop != null) {
        const ids = tokenizer.encode(` ${context.trim()}`, { add_special_tokens: false }).slice(-180);
        prefix = [sop, ...ids, ...initFor];
      }
      const { input_features } = await processor(audio);
      const out = await model.generate({
        inputs: input_features,
        decoder_input_ids: prefix,
        max_new_tokens: Math.max(64, 440 - prefix.length),
        ...(withStamps ? { return_timestamps: true } : {}),
      });
      const seq = toList(out)[0].map(Number);
      const startAt = seq.length > prefix.length && seq.slice(0, prefix.length).every((t, i) => t === Number(prefix[i])) ? prefix.length : 0;
      const gen2 = seq.slice(startAt).filter((t) => t !== gen.eos_token_id);
      const len = audio.length / 16000;
      if (!withStamps) {
        const text = decode(gen2);
        return { text, parts: text ? [{ start: 0, end: len, text }] : [], stamped: false };
      }
      const parts = splitTimestamps(gen2, gen.no_timestamps_token_id + 1, len)
        .map((p) => ({ start: p.start, end: p.end, text: decode(p.tokens) }))
        .filter((p) => p.text);
      return { text: parts.map((p) => p.text).join(' ').trim(), parts, stamped: true };
    };

    // First try as configured; if the text looks broken, again without the prompt, then
    // without timestamps too, and keep the cleanest.
    const speech = speechSeconds(samples);
    const attempts = [];
    const attempt = async (context, withStamps) => {
      const r = await run(samples, context, withStamps);
      r.trouble = windowTrouble(r.text, speech);
      if (context && looksEchoed(r.text, context)) r.trouble.push('echo');
      attempts.push(r);
      return !r.trouble.length;
    };
    if (!(await attempt(prompt, stamps)) && !(prompt && await attempt('', stamps)) && stamps) await attempt('', false);
    const words = (r) => (r.text ? r.text.split(/\s+/).length : 0);
    let res = attempts.reduce((a, b) => (b.trouble.length < a.trouble.length || (b.trouble.length === a.trouble.length && words(b) > words(a)) ? b : a));
    if (attempts.length > 1) state.retries = (state.retries || 0) + 1;
    // Whisper sometimes stops before the window ends. Pick up the rest once, with what it
    // has just written as context, if there is enough of it to be speech.
    const until = coveredUntil(res.parts);
    if (res.stamped && res.parts.length && duration - until > 2) {
      const from = Math.round(until * 16000);
      const rest = samples.subarray(from);
      let energy = 0;
      for (let i = 0; i < rest.length; i++) energy += rest[i] * rest[i];
      if (Math.sqrt(energy / rest.length) > 0.0025) {
        const more = await run(rest, `${prompt} ${res.text}`.trim());
        if (more.text && !looksEchoed(more.text, res.text) && !windowTrouble(more.text).length) {
          res.parts.push(...more.parts.map((p) => ({ ...p, start: p.start + until, end: p.end + until })));
          res.text = res.parts.map((p) => p.text).join(' ').trim();
        }
      }
    }
    return res;
  } catch (err) {
    console.warn('Prompted transcription failed, using the plain pipeline', err);
    state.broken = true;
    return plain();
  }
}
