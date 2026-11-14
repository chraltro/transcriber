import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seconds, tidy, fromJson, fromPsc, fromNotes, chapterAt } from '../../lib/chapters.js';
import { parseFeed } from '../../lib/feed.js';

const pairs = (list) => list.map((c) => [c.start, c.title]);

test('times as shows write them', () => {
  assert.equal(seconds('00:12:34.000'), 754);
  assert.equal(seconds('12:34'), 754);
  assert.equal(seconds('1:02:03'), 3723);
  assert.equal(seconds('754'), 754);
  assert.equal(seconds('01:02.5'), 62.5);
  assert.equal(seconds(90.25), 90.25);
  assert.ok(Number.isNaN(seconds('12:75')));
  assert.ok(Number.isNaN(seconds('soon')));
});

test('a Podcasting 2.0 chapters file, without the entries kept out of the list', () => {
  // As Podcast Index's own example and the hosting services write them.
  const json = {
    version: '1.2.0',
    chapters: [
      { startTime: 0, title: 'Intro', img: 'https://example.com/1.jpg' },
      { startTime: 168, title: 'Hearing aids, and the people who make them', url: 'https://example.com/aids' },
      { startTime: 175.5, img: 'https://example.com/only-a-picture.jpg', toc: false },
      { startTime: 260, title: 'A sponsor', toc: false },
      { startTime: 1206.3, title: '  — Listener mail ' },
      { startTime: 900, title: 'Out of order in the file' },
      { startTime: 900, title: 'Same moment again' },
      { startTime: '1500', title: 'A start written as text' },
      { startTime: 'later', title: 'No time at all' },
    ],
  };
  assert.deepEqual(pairs(fromJson(json)), [[0, 'Intro'], [168, 'Hearing aids, and the people who make them'], [900, 'Out of order in the file'], [1206.3, 'Listener mail'], [1500, 'A start written as text']]);
  assert.deepEqual(fromJson({ chapters: 'no' }), []);
  assert.deepEqual(fromJson(null), []);
  assert.deepEqual(fromJson({ chapters: [{ startTime: 0, title: 'Only one' }] }), [], 'one chapter is no way of getting about');
});

test('Podlove Simple Chapters in the feed itself', () => {
  const xml = `<rss xmlns:psc="http://podlove.org/simple-chapters"><channel><title>Show</title>
<item><title>Folge 12</title><guid>f12</guid><enclosure url="https://cdn/f12.mp3" type="audio/mpeg"/><itunes:duration>01:02:00</itunes:duration>
<psc:chapters version="1.2" xmlns:psc="http://podlove.org/simple-chapters">
  <psc:chapter start="00:00:00.000" title="Begrüßung" />
  <psc:chapter start="00:04:12.500" title="Was ist &amp; was war" href="https://example.de"/>
  <psc:chapter start='00:31:07' title='Hörerpost'/>
  <psc:chapter start="1:05:00" title="After the end"/>
</psc:chapters></item></channel></rss>`;
  const ep = parseFeed(xml).episodes[0];
  assert.deepEqual(ep.psc[1], { start: '00:04:12.500', title: 'Was ist & was war' });
  assert.deepEqual(pairs(fromPsc(ep.psc)), [[0, 'Begrüßung'], [252.5, 'Was ist & was war'], [1867, 'Hörerpost'], [3900, 'After the end']]);
  assert.deepEqual(pairs(tidy(ep.psc, ep.duration)), [[0, 'Begrüßung'], [252.5, 'Was ist & was war'], [1867, 'Hörerpost']], 'clamped to the episode');
  assert.deepEqual(parseFeed(xml.replace(/<psc:chapters[\s\S]*<\/psc:chapters>/, '')).episodes[0].psc, []);
});

test('times that begin lines of the notes, as feeds really write them', () => {
  // <p> with <br>, the times linked (as Libsyn and Podbean do).
  const br = `<p>This week we talk about tides.</p><p><a href="https://example.com/#t=0">00:00</a> Intro<br/>
<a href="https://example.com/#t=312">05:12</a> - Why the moon matters<br>
<a href="https://example.com/#t=1590">26:30</a> &ndash; Spring tides &amp; neap tides<br />
<a href="https://example.com/#t=3725">1:02:05</a> Listener questions</p><p>Support the show at example.com</p>`;
  assert.deepEqual(pairs(fromNotes(br)), [[0, 'Intro'], [312, 'Why the moon matters'], [1590, 'Spring tides & neap tides'], [3725, 'Listener questions']]);
  // A list, with brackets of both kinds.
  const ul = `<p>Chapters:</p><ul><li>(00:00) Cold open</li><li>[03:41] <strong>The interview</strong></li><li>(1:02:03) Wrap-up: what's next</li></ul>`;
  assert.deepEqual(pairs(fromNotes(ul)), [[0, 'Cold open'], [221, 'The interview'], [3723, "Wrap-up: what's next"]]);
  // Hours always written, a dash between.
  const plain = 'Timestamps\n00:00:00 - Intro\n00:02:30 - Headlines\n00:41:10 - Outro\n\nThanks for listening.';
  assert.deepEqual(pairs(fromNotes(plain)), [[0, 'Intro'], [150, 'Headlines'], [2470, 'Outro']]);
  // A paragraph per chapter, in a <div> as Substack writes it.
  assert.deepEqual(pairs(fromNotes('<div><p>0:00 Hello</p><p>4:10 First story</p><p>12:00 Second story</p></div>')), [[0, 'Hello'], [250, 'First story'], [720, 'Second story']]);
});

test('times in passing are not chapters', () => {
  // Two times only (the world in tests/pod-world.mjs writes exactly this).
  assert.deepEqual(fromNotes('<p>In this episode:</p><ul><li>(00:30) Where it starts</li><li>(02:10) The part with the numbers</li></ul>'), []);
  // Inside sentences.
  assert.deepEqual(fromNotes('<p>We get to the tides at 12:30, the moon at 20:00 and the mail at 41:00.</p>'), []);
  // Out of order.
  assert.deepEqual(fromNotes('<ul><li>00:00 Intro</li><li>15:00 Two</li><li>10:00 Three</li></ul>'), []);
  // Starting late: a list of moments, not of chapters.
  assert.deepEqual(fromNotes('<ul><li>12:00 Best line</li><li>18:00 Funniest bit</li><li>25:00 Saddest bit</li></ul>'), []);
  // Times of day, and a time with nothing after it.
  assert.deepEqual(fromNotes('<p>9:30pm show<br>10:15pm encore<br>11:00pm close</p>'), []);
  assert.deepEqual(fromNotes('<p>00:00<br>05:00<br>10:00</p>'), []);
  assert.deepEqual(fromNotes(''), []);
  // A script's text is never read.
  assert.deepEqual(fromNotes('<script>00:00 a\n01:00 b\n02:00 c</script>'), []);
});

test('tidy: in order, one per moment, titles trimmed, inside the episode', () => {
  assert.deepEqual(pairs(tidy([{ start: 30, title: '[Part two]' }, { start: 0, title: '- Part one' }, { start: 30.4, title: 'Echo' }, { start: 0, title: 'Again' }, { start: -5, title: 'Before' }, { start: 9000, title: 'Past the end' }, { start: 60, title: '   ' }], 3600)),
    [[0, 'Part one'], [30, 'Part two']]);
  assert.deepEqual(tidy('nonsense'), []);
});

test('which chapter is playing', () => {
  const list = [{ start: 30, title: 'a' }, { start: 120, title: 'b' }, { start: 300, title: 'c' }];
  assert.equal(chapterAt(list, 0), -1);
  assert.equal(chapterAt(list, 29.8), 0, 'a jump to a chapter can land a hair before it');
  assert.equal(chapterAt(list, 119), 0);
  assert.equal(chapterAt(list, 120), 1);
  assert.equal(chapterAt(list, 5000), 2);
  assert.equal(chapterAt([], 10), -1);
});
