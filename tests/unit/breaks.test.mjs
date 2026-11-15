import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adBreaks, breakAt, adSeconds } from '../../lib/breaks.js';
import { adCues, isAd } from '../../lib/pitch.js';
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

// The opening of a Pod Save America episode as it was transcribed (Nov 2026), where nothing was
// skipped: a 2-minute read with its cues at both ends and its own sign-off, then an announcer's
// spot of which only the second half is worded like an ad, then a spot in a passing voice.
const SIMPLISAFE = "Today's presenting sponsor is SimpliSafe Home Security. If you're hosting Thanksgiving this year, your home will soon be packed with family and way too much food. With SimpliSafe protecting what matters most, you can focus on enjoying your guests instead of stressing. Right now, lock in peace of mind before the holidays with 70% off their Black Friday sale at simplisafe.com slash crooked. Unlike traditional security systems that only alert you after a break-in is already underway, SimpliSafe is built to stop it before it starts. Smart, AI-powered cameras watch for potential threats and alert a live, U.S.-based agent ready to intervene. The agent intervenes in under 30 seconds, speaking through the camera to stop an intruder in their tracks and calling for urgent 911 dispatch when it's needed most. Our CEO recently got SimpliSafe. She Lovett it. She thought its setup was super easy, took a couple hours. Now she's got the app on her phone. She likes that it's very easy to arm and disarm. The system is reliable through power outages. It reconnects automatically without needing to call customer support. So she's very happy and so is everyone who's used SimpliSafe that we know. We've partnered with SimpliSafe to offer our listeners the biggest savings of the year, 70% off your new system. With professional monitoring, when you visit SimpliSafe.com slash crooked, that's SimpliSafe.com slash crooked. And when you order, type in Pod Save America at checkout. It lets them know we sent you and it really helps the show.";
const SIGN_OFF = 'SimpliSafe, ahead of crime, in real time.';
const BUNDLE = 'The Disney Plus Hulu HBO Max Bundle, the best in entertainment in one bundle. This is going to be a good time. With new seasons of your favorites, like Percy Jackson and the Olympians on Disney Plus. Do you ever get used to all this? Nope. The Scandalous Alls Fair on Hulu. Let\'s give these girls a show. And the high society drama of the HBO original, The Gilded Age on HBO Max. What have I gotten myself into? Streaming this month. Plans starting at $21.99 a month. Terms apply. Visit Disney Plus Hulu Max Bundle dot com for details.';
const VRBO = 'Looking for the best of Verbo? Discover vacation rentals of the year topped quality homes guests Lovett from across the country. Our curated list takes the guesswork out of planning so you can spend less time searching and more time packing. Book your next day now with Verbo video.';
const sentencesOf = (text) => text.match(/[^.!?]+[.!?]+/g).map((x) => x.trim());

test('a long read, its sign-off, an announcer\'s spot worded as an ad only halfway, and a passing spot are one break, up to the host', () => {
  reset();
  const lines = [];
  for (const x of sentencesOf(SIMPLISAFE)) lines.push(say(x, 0, { gap: 0.2 }));
  lines.push(say(SIGN_OFF, 0, { pause: true }));
  for (const x of sentencesOf(BUNDLE)) lines.push(say(x, 1, { gap: 0.2 }));
  for (const x of sentencesOf(VRBO)) lines.push(say(x, 2, { gap: 0.2 }));
  const host = say("Welcome to Pod Save America. I'm Dan Pfeiffer. Today you'll hear from the people running the shutdown fight.", 3, { gap: 0.8 });
  const show = [host];
  for (let i = 0; i < 300; i++) show.push(say(i % 2 ? 'And the thing about the Senate is that nobody wants to go first on this.' : 'So let us talk about what happened in Washington this week, because a lot did.', i % 5 < 3 ? 3 : 4));
  const breaks = adBreaks([...lines, ...show], { minor: new Set([2]) });
  assert.equal(breaks.length, 1, JSON.stringify(breaks));
  assert.ok(breaks[0][0] <= 0.5 && Math.abs(breaks[0][1] - host.start) <= 1, `${JSON.stringify(breaks)} vs the host at ${host.start.toFixed(1)}`);
});

test('show talk between two reads in the same voice stays in when it does not name what they sell', () => {
  reset();
  const lines = [say('So that is where the shutdown fight stands this morning.', 0)];
  const read1 = [say('This episode is brought to you by Helix. Helix makes mattresses matched to how you sleep.', 0, { pause: true }), say('Go to helixsleep.com/crooked for 20% off. Helix, sleep better.')];
  const talk = [];
  for (let i = 0; i < 14; i++) talk.push(say(i ? 'The vote count matters less than who blinks first, and nobody in that room wants to be the one who blinks.' : 'Okay, back to the Senate, because the vote is tonight.', 0, { pause: i === 0 }));
  const read2 = [say('Support for this show comes from Mint Mobile. Plans start at 15 dollars a month.', 0, { pause: true }), say('Switch at mintmobile.com/crooked. Terms apply.')];
  const after = [say('And we are back with Tommy.', 0, { pause: true }), say('Thanks, it was a long week.', 1)];
  const breaks = adBreaks([...lines, ...read1, ...talk, ...read2, ...after]);
  for (const s of talk) assert.equal(breakAt(breaks, (s.start + s.end) / 2), -1, `${JSON.stringify(breaks)}: "${s.text}" at ${s.start.toFixed(1)}`);
  assert.equal(breaks.length, 2, JSON.stringify(breaks));
});

test('a clip in a voice heard nowhere else, right before a read, is not taken into it', () => {
  reset();
  const lines = [say('Here is what the Speaker said on Sunday.', 0)];
  const clip = [say('We are not going to negotiate with anybody until the government is open again, period.', 5, { gap: 0.5 }), say('That is the position of the House, and it will be tomorrow too.', 5)];
  const read = [say('This episode is brought to you by Helix. Helix makes mattresses matched to how you sleep.', 0, { gap: 0.5 }), say('Go to helixsleep.com/crooked for 20% off.')];
  const after = [say('Okay, so what do we make of that clip?', 0, { pause: true }), say('It is a bluff, mostly.', 1)];
  const breaks = adBreaks([...lines, ...clip, ...read, ...after]);
  for (const s of clip) assert.equal(breakAt(breaks, (s.start + s.end) / 2), -1, `${JSON.stringify(breaks)}: the clip at ${s.start.toFixed(1)}`);
  assert.equal(breaks.length, 1, JSON.stringify(breaks));
});

test('news talk with an ad\'s words in it is not an ad', () => {
  for (const t of [
    'Consumers will see the tariff at checkout, and that is the point.',
    'The administration partnered with Intel to bring chip plants back to Ohio.',
    'He was the presenting sponsor of the bill, and the main sponsor of two more.',
    'We want to give our listeners a sense of how close this race really is.',
  ]) assert.equal(isAd(t), false, t);
  for (const t of [
    "Today's presenting sponsor is SimpliSafe Home Security.",
    "We've partnered with SimpliSafe to offer our listeners the biggest savings of the year.",
    'And when you order, type in Pod Save America at checkout.',
  ]) assert.equal(isAd(t), true, t);
});
