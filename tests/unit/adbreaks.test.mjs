import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adBreaks, breakAt, adSeconds } from '../../lib/adbreaks.js';
import { adCues, isAd } from '../../lib/ads.js';
import { skipAt } from '../../lib/playback.js';

// Sentences as the transcriber delivers them: timed, with the 30 second window they came from.
let t = 0;
const reset = () => { t = 0; };
const say = (text, speaker = 0, { gap = 0.4, pause = false } = {}) => {
  const start = t + (pause ? 3 : gap);
  const end = start + text.split(/\s+/).length / 2.7;
  t = end;
  return { start, end, text, speaker, w: Math.floor(start / 30) * 30 };
};
const within = (range, a, b, tol = 1.5) => Math.abs(range[0] - a) <= tol && Math.abs(range[1] - b) <= tol;

test('a host read between two stretches of the show is one break, from the last word before it to the first after', () => {
  reset();
  const show1 = [say("Welcome to the show, I'm Jon."), say('The bill sponsored by Senator Warren passed the committee yesterday, which nobody expected a month ago.'), say('We will get into what that means for the map in a minute.')];
  const ad = [
    say('Pod Save America is brought to you by ZipRecruiter.', 0, { pause: true }),
    say('Hiring is hard, and it takes forever to find the right person for your team when you are doing it between everything else.'),
    say('ZipRecruiter finds qualified candidates fast, so you can get back to work.'),
    say('Try it for free at ziprecruiter.com/crooked.'),
  ];
  const show2 = [say('Okay, back to the committee vote. Dan, what did you make of it?', 0, { pause: true }), say('I thought it was a strong result, and the margin says more than the vote itself.', 1)];
  const breaks = adBreaks([...show1, ...ad, ...show2]);
  assert.equal(breaks.length, 1, JSON.stringify(breaks));
  assert.ok(within(breaks[0], show1[2].end, show2[0].start), `${JSON.stringify(breaks)} vs ${show1[2].end}..${show2[0].start}`);
  assert.equal(breakAt(breaks, ad[1].start), 0);
  assert.equal(breakAt(breaks, show1[1].start), -1, 'a bill has a sponsor too');
  assert.equal(breakAt(breaks, show2[1].start), -1);
});

test('two reads back to back, and a spot in a voice heard nowhere else, are one break', () => {
  reset();
  const lines = [
    say('So that is where the negotiations stand tonight, and we will see what the morning brings.'),
    say('This episode is sponsored by Helix. Helix makes mattresses matched to how you sleep.', 0, { pause: true }),
    say('Go to helixsleep.com/crooked for 20% off.'),
    say('Support for this show comes from Mint Mobile. Plans start at 15 dollars a month.', 0, { pause: true }),
    say('Switch at mintmobile.com/crooked. Terms apply.'),
    say('Big savings are waiting at your local dealer this weekend only.', 7),
    say('And we are back. Tommy, tell us about the summit.', 0, { pause: true }),
    say('It went better than the coverage suggests, because the coverage was written before it ended.', 1),
  ];
  const breaks = adBreaks(lines, { minor: new Set([7]) });
  assert.equal(breaks.length, 1, JSON.stringify(breaks));
  assert.ok(within(breaks[0], lines[0].end, lines[6].start), JSON.stringify(breaks));
  assert.ok(adSeconds(breaks) > 20);
});

test('a read that starts or ends inside a paragraph is cut there', () => {
  reset();
  // One paragraph (same window, no pause): show, then the read.
  const lines = [
    { start: 0, end: 14, text: 'That is the whole argument, and I think it holds up better than its critics allow.', speaker: 0, w: 0 },
    { start: 14.2, end: 18, text: 'The Ezra Klein Show is brought to you by Wise.', speaker: 0, w: 0 },
    { start: 18.2, end: 26, text: 'Send money abroad at the real rate. Download the Wise app today.', speaker: 0, w: 0 },
    { start: 26.2, end: 29, text: 'Visit wise.com/klein.', speaker: 0, w: 0 },
    { start: 29.4, end: 50, text: 'So, to pick the thread back up, the second objection is about scale and it is the serious one.', speaker: 0, w: 0 },
    { start: 50.2, end: 70, text: 'Nobody has shown this working for a country of three hundred million people.', speaker: 0, w: 0 },
  ];
  const breaks = adBreaks(lines);
  assert.equal(breaks.length, 1, JSON.stringify(breaks));
  assert.ok(within(breaks[0], 14, 29.4), JSON.stringify(breaks));
});

test('talk that merely sounds commercial is left alone', () => {
  reset();
  const lines = [
    say('We went to acme.com to read their paper on bridges, and it is better than the press release.'),
    say('The trial was free of drama, which is its own kind of news.'),
    say('State-sponsored groups were behind it, according to a report sponsored by nobody in particular in Congress.'),
    say('A resolution co-sponsored by nine senators is not nothing.'),
  ];
  assert.deepEqual(adBreaks(lines), []);
  assert.equal(isAd('The amendment was sponsored by Senator Murphy.'), false);
  assert.equal(isAd('Sponsored by BetterHelp.'), true);
  assert.equal(adCues('This is brought to you by Wise.').opener, true);
  assert.deepEqual(adBreaks([]), []);
});

test('something flagged that runs far too long is not skipped', () => {
  reset();
  const lines = [say('This episode is brought to you by nobody, as usual.')];
  for (let i = 0; i < 80; i++) lines.push({ start: t, end: (t += 6), text: 'and the hearing went on and on with no end in sight', speaker: 0, w: 0 });
  lines.push({ start: t, end: (t += 5), text: 'Use code HEARING at checkout.', speaker: 0, w: 0 });
  for (const b of adBreaks(lines)) assert.ok(b[1] - b[0] <= 360, JSON.stringify(b));
});

test('the player jumps over a break unless the listener went back into it', () => {
  const breaks = [[60, 150], [900, 1000]];
  assert.deepEqual(skipAt(breaks, 61), { index: 0, to: 150 });
  assert.equal(skipAt(breaks, 59), null);
  assert.equal(skipAt(breaks, 149), null, 'nearly over');
  assert.equal(skipAt(breaks, 100, 0), null, 'kept on purpose');
  assert.deepEqual(skipAt(breaks, 950, 0), { index: 1, to: 1000 });
  assert.equal(skipAt(null, 10), null);
});
