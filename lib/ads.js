// Sponsor reads, recognised by how they are worded. One strong cue ("promo code", "brought to
// you by") or two weaker ones ("visit x.com", "free trial") mark a paragraph as an ad.
const STRONG = /(?<![\p{L}])(promo code|use (?:the )?code|coupon code|sponsored by|brought to you by|this (?:episode|show|podcast|segment) is (?:sponsored|supported|brought to you|presented)|support for (?:this|the) (?:show|podcast|episode) comes from|terms (?:and conditions )?apply|restrictions apply|see site for details|code promo|code de réduction|sponsorisé par|cet épisode est (?:sponsorisé|présenté|soutenu)|rabattcode|gutscheincode|gesponsert von|diese (?:folge|episode) wird (?:präsentiert|unterstützt|gesponsert)|unbezahlte werbung|código (?:de descuento|promocional)|patrocinado por|este (?:episodio|programa) (?:está patrocinado|es posible gracias)|codice sconto|sponsorizzato da|questo episodio è (?:sponsorizzato|offerto)|rabattkode|rabatkode|sponset av|sponsoreret af)(?![\p{L}])/iu;
const WEAK = [
  /\b(?:visit|go to|head (?:over )?to|check out) [\w-]+(?:\.[\w-]+)*\.(?:com|co|org|net|io|ai)\b/i,
  /\b[\w-]+\.(?:com|co|net|io)\/[\w-]+/i,
  /\bfree trial\b/i,
  /\b\d+ ?(?:%|percent) off\b/i,
  /\bfirst (?:month|order|box)\b/i,
  /\bsign up (?:today|now)\b/i,
  /\b(?:download|get) the [\w ]{2,20} app\b/i,
  /\blimited time\b/i,
  /\bfree shipping\b/i,
];

export function isAd(text) {
  if (!text) return false;
  if (STRONG.test(text)) return true;
  return WEAK.filter((re) => re.test(text)).length >= 2;
}
