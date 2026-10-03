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
// Tiny also hears some Danish as German (a Danish show had a window at 86% German), so for
// Danish shows German is a neighbour too.
const NEIGHBOURS = { norwegian: ['da', 'sv'], danish: ['no', 'nn', 'sv', 'de'], spanish: ['ca', 'gl', 'pt'], german: ['nl', 'lb'], french: ['oc', 'ca'], italian: ['la'] };

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

// Families Whisper Tiny can't tell apart reliably (Norwegian heard as half Swedish, Danish as
// half German in one show): their probabilities are pooled before deciding.
const FAMILIES = [['no', 'nn', 'sv', 'da'], ['es', 'ca', 'gl', 'pt'], ['de', 'nl', 'lb'], ['fr', 'oc'], ['it', 'la']];

// The language a window is clearly in, when it is not the episode's. What has to be clear is
// that it is *not* the episode's language: that gets at most `maxOwn` (with its neighbours),
// and one language family gets at least `minProb`. In 277 windows of seven English shows,
// English never got under 75% (tests/langid-lab.mjs); Norwegian and German windows gave it 0 to
// 2%, Danish up to 15%.
// -> { code, name, prob } or null.
export function foreignLanguage(probs, language, { minProb = 0.4, maxOwn = 0.2 } = {}) {
  if (!probs) return null;
  const own = [...(LANGUAGE_CODES[language] || []), ...(NEIGHBOURS[language] || [])];
  const ownProb = own.reduce((a, c) => a + (probs[c] || 0), 0);
  if (ownProb > maxOwn) return null;
  const pooled = {};
  for (const [c, p] of Object.entries(probs)) {
    if (own.includes(c)) continue;
    const fam = FAMILIES.find((f) => f.includes(c));
    const key = fam ? fam.join() : c;
    pooled[key] = (pooled[key] || 0) + p;
  }
  const [key, prob] = Object.entries(pooled).sort((a, b) => b[1] - a[1])[0] || [];
  if (!key || prob < minProb) return null;
  // Named after the family's most likely member.
  const members = key.split(',');
  const code = members.sort((a, b) => (probs[b] || 0) - (probs[a] || 0))[0];
  return { code, name: languageName(code), prob };
}
