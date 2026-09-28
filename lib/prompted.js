// Whisper with a prompt. Transformers.js doesn't expose Whisper's prompt option, but a prompt
// is only extra start tokens (<|startofprev|> text... <|startoftranscript|> ...), so the model
// is called directly and only the newly generated tokens are kept. Falls back to no prompt when
// the output repeats the prompt or loops (small models sometimes do), and to the plain
// pipeline if the direct call isn't supported.
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

export async function transcribeWindow(asr, samples, { language, prompt = '', state = {} } = {}) {
  const { model, tokenizer, processor } = asr;
  const gen = model.generation_config || {};
  const multilingual = !!gen.is_multilingual;
  const plain = async () => {
    const out = await asr(samples, multilingual ? { language, task: 'transcribe' } : {});
    return (out.text || '').trim();
  };
  if (state.broken || typeof model._retrieve_init_tokens !== 'function') return plain();
  try {
    const init = model._retrieve_init_tokens({ ...gen, language: multilingual ? language : null, task: multilingual ? 'transcribe' : null, return_timestamps: false });
    const run = async (withPrompt) => {
      let prefix = init;
      if (withPrompt && prompt) {
        const sop = gen.prev_sot_token_id ?? tokenizer.model?.tokens_to_ids?.get?.('<|startofprev|>');
        if (sop != null) {
          const ids = tokenizer.encode(` ${prompt.trim()}`, { add_special_tokens: false }).slice(-180);
          prefix = [sop, ...ids, ...init];
        }
      }
      const { input_features } = await processor(samples);
      const out = await model.generate({ inputs: input_features, decoder_input_ids: prefix, max_new_tokens: Math.max(64, 440 - prefix.length) });
      const seq = toList(out)[0].map(Number);
      const start = seq.length > prefix.length && seq.slice(0, prefix.length).every((t, i) => t === Number(prefix[i])) ? prefix.length : 0;
      return tokenizer.decode(seq.slice(start), { skip_special_tokens: true }).trim();
    };
    let text = await run(true);
    if (prompt && looksEchoed(text, prompt)) text = await run(false);
    return text;
  } catch (err) {
    console.warn('Prompted transcription failed, using the plain pipeline', err);
    state.broken = true;
    return plain();
  }
}
