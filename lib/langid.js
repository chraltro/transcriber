// Which language a window is spoken in. English episodes are transcribed with English-only
// models, which turn anything else into English-sounding nonsense: a Norwegian ad slotted into
// an American podcast came out as "Black Week Marmashay ... start with your friends". A
// multilingual Whisper says which language it hears with its first decoding step, so each
// window is checked, and one clearly in another language is either transcribed in that language
// (multilingual models) or marked as such (English-only models).

// The app's languages as Whisper's codes. Norwegian has two written forms, both "ours".
export const LANGUAGE_CODES = { english: ['en'], norwegian: ['no', 'nn'], danish: ['da'], french: ['fr'], german: ['de'], spanish: ['es'], italian: ['it'] };
// Languages close enough to be mistaken for the episode's own (a Norwegian sentence heard as
// Danish): never "foreign", or a window would be transcribed in the wrong one of the pair.
const NEIGHBOURS = { norwegian: ['da', 'sv'], danish: ['no', 'nn', 'sv'], spanish: ['ca', 'gl', 'pt'], german: ['nl', 'lb'], french: ['oc', 'ca'], italian: ['la'] };

const NAMES = typeof Intl !== 'undefined' && Intl.DisplayNames ? new Intl.DisplayNames(['en'], { type: 'language' }) : null;
export const languageName = (code) => { try { return NAMES?.of(code) || code; } catch { return code; } };

// { code: probability } over Whisper's language tokens, or null if the model can't tell.
// `Tensor` is transformers.js's Tensor class (the worker loads the library from a CDN).
export async function detectLanguage(asr, samples, Tensor) {
  const { model, tokenizer, processor } = asr;
  const gen = model.generation_config || {};
  const langToId = gen.lang_to_id;
  if (!gen.is_multilingual || !langToId) return null;
  const sot = gen.decoder_start_token_id ?? tokenizer.model?.tokens_to_ids?.get?.('<|startoftranscript|>');
  const { input_features } = await processor(samples);
  const out = await model({ input_features, decoder_input_ids: new Tensor('int64', BigInt64Array.from([BigInt(sot)]), [1, 1]) });
  const logits = out.logits;
  const vocab = logits.dims[logits.dims.length - 1];
  const row = logits.data.subarray(logits.data.length - vocab);
  const entries = Object.entries(langToId).map(([tok, id]) => [tok.replace(/^<\|(.+)\|>$/, '$1'), row[Number(id)]]);
  const max = Math.max(...entries.map(([, l]) => l));
  const exp = entries.map(([c, l]) => [c, Math.exp(l - max)]);
  const sum = exp.reduce((a, [, e]) => a + e, 0);
  for (const x of Object.values(out)) x?.dispose?.();
  return Object.fromEntries(exp.map(([c, e]) => [c, e / sum]));
}

// The language a window is clearly in, when it is not the episode's: the model must be sure
// (`minProb`) and give the episode's language next to nothing (`maxOwn`). Accents, names and
// a borrowed phrase must never cost a window its transcript, so the bar is high.
// -> { code, name, prob } or null.
export function foreignLanguage(probs, language, { minProb = 0.8, maxOwn = 0.05 } = {}) {
  if (!probs) return null;
  const own = LANGUAGE_CODES[language] || [];
  const ownProb = own.reduce((a, c) => a + (probs[c] || 0), 0);
  const [code, prob] = Object.entries(probs).sort((a, b) => b[1] - a[1])[0] || [];
  if (!code || own.includes(code) || (NEIGHBOURS[language] || []).includes(code) || prob < minProb || ownProb > maxOwn) return null;
  return { code, name: languageName(code), prob };
}
