// Sponsor reads, recognised by how they are worded. One strong cue ("promo code", "brought to
// you by") or two weaker ones ("visit x.com", "free trial") mark a paragraph as an ad.
const STRONG = /(?<![\p{L}])(promo code|use (?:the )?(?:promo |offer |discount )?code|coupon code|offer code|discount code|code [\p{L}\d]+ at checkout|brought to you by|this (?:episode|show|podcast|segment) is (?:sponsored|supported|brought to you|presented|made possible)|support for (?:this|the|today['’]s) (?:show|podcast|episode) comes from|(?:a )?word from our sponsors?|thanks to our sponsors?|today['’]s sponsors?|terms (?:and conditions )?apply|restrictions apply|see site for details|code promo|code de réduction|sponsorisé par|cet épisode est (?:sponsorisé|présenté|soutenu)|rabattcode|gutscheincode|gesponsert von|diese (?:folge|episode) wird (?:präsentiert|unterstützt|gesponsert)|unbezahlte werbung|código (?:de descuento|promocional)|patrocinado por|este (?:episodio|programa) (?:está patrocinado|es posible gracias)|codice sconto|sponsorizzato da|questo episodio è (?:sponsorizzato|offerto)|rabattkode|rabatkode|sponset av|sponsoreret af)(?![\p{L}])/iu;
// "Sponsored by" on its own is an ad, except where it is about a bill or a state.
const SPONSORED = /(?<![\p{L}-])sponsored by(?![\p{L}])/iu;
const NOT_A_SPONSOR = /\b(bills?|legislation|amendments?|resolutions?|senators?|senate|congress\w*|representatives?|lawmakers?|co-?sponsor\w*|state[- ]sponsored|government[- ]sponsored|terroris[mt])\b/i;
const WEAK = [
  /\b(?:visit|go to|head (?:over )?to|check out) [\w-]+(?:\.[\w-]+)*\.(?:com|co|org|net|io|ai)\b/i,
  /\b[\w-]+\.(?:com|co|net|io)\/[\w-]+|\bdot (?:com|co|net|io) slash \w+/i,
  /\bfree trial\b/i,
  /\b\d+ ?(?:%|percent) off\b/i,
  /\bfirst (?:month|order|box)\b/i,
  /\bsign up (?:today|now)\b/i,
  /\b(?:download|get) the [\w ]{2,20} app\b/i,
  /\blimited time\b/i,
  /\bfree shipping\b/i,
  /\bmoney[- ]back guarantee\b/i,
  /\b(?:special|exclusive) offer\b/i,
];
// The words an ad opens with: where one starts inside a paragraph.
const OPENER = /(?<![\p{L}])(brought to you by|sponsored by|support for (?:this|the|today['’]s) (?:show|podcast|episode) comes from|is (?:supported|presented|made possible) by|word from our sponsors?|today['’]s sponsors?)(?![\p{L}])/iu;

const sentences = (text) => text.match(/[^.!?]+[.!?]*\s*/g) || [text];

// How ad-like a text is: { strong, weak } cue counts, and whether it opens an ad.
export function adCues(text) {
  if (!text) return { strong: 0, weak: 0, opener: false };
  let strong = STRONG.test(text) ? 1 : 0;
  let opener = false;
  let weak = WEAK.filter((re) => re.test(text)).length;
  for (const s of sentences(text)) {
    const sponsor = SPONSORED.test(s) && !NOT_A_SPONSOR.test(s);
    if (sponsor) strong++;
    if (OPENER.test(s) && (sponsor || !SPONSORED.test(s))) opener = true;
  }
  return { strong, weak, opener };
}

export function isAd(text) {
  const { strong, weak } = adCues(text);
  return strong > 0 || weak >= 2;
}
