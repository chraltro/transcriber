import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, durationSec } from '../../server/feeds.mjs';

const XML = `<?xml version="1.0"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
<title>Pod Save America</title><itunes:image href="https://img/show.jpg"/>
<item><title><![CDATA[Older &amp; wiser]]></title><guid isPermaLink="false">a1</guid>
<pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate><enclosure url="https://cdn/a.mp3?x=1&amp;y=2" type="audio/mpeg" length="1"/>
<description><![CDATA[<p>Jon Favreau talks to <b>Ezra Klein</b>.</p>]]></description><itunes:duration>1:02:03</itunes:duration></item>
<item><title>Newest</title><guid>b2</guid><pubDate>Tue, 06 Oct 2026 10:00:00 GMT</pubDate>
<enclosure url="https://cdn/b.mp3" type="audio/mpeg"/><itunes:image href="https://img/b.jpg"/></item>
<item><title>A video</title><guid>c3</guid><pubDate>Wed, 07 Oct 2026 10:00:00 GMT</pubDate><enclosure url="https://cdn/c.mp4" type="video/mp4"/></item>
</channel></rss>`;

test('a feed gives its audio episodes, newest first, with notes as plain text', () => {
  const f = parseFeed(XML);
  assert.equal(f.show, 'Pod Save America');
  assert.deepEqual(f.episodes.map((e) => e.guid), ['b2', 'a1']);
  const a = f.episodes[1];
  assert.equal(a.title, 'Older & wiser');
  assert.equal(a.url, 'https://cdn/a.mp3?x=1&y=2');
  assert.match(a.notes, /Jon Favreau talks to Ezra Klein/);
  assert.equal(a.duration, 3723);
  assert.equal(a.art, 'https://img/show.jpg');
  assert.equal(f.episodes[0].art, 'https://img/b.jpg');
});

test('durations in any form', () => {
  assert.equal(durationSec('62:03'), 3723);
  assert.equal(durationSec('3723'), 3723);
  assert.equal(durationSec(''), 0);
});

test("a show's hosts go into its notes once, where the term extraction finds them", async () => {
  const { notesWithHosts } = await import('../../server/shows.mjs');
  const { extractTerms } = await import('../../lib/context.js');
  const notes = notesWithHosts('Tommy and Ben close the loop on the summit.', 'Pod Save the World');
  assert.equal(notesWithHosts(notes, 'Pod Save the World'), notes);
  const terms = extractTerms(notes);
  assert.ok(terms.includes('Tommy Vietor') && terms.includes('Ben Rhodes'), JSON.stringify(terms));
  const psa = extractTerms(notesWithHosts('', 'Pod Save America'));
  for (const h of ['Jon Favreau', 'Jon Lovett', 'Tommy Vietor', 'Dan Pfeiffer']) assert.ok(psa.includes(h), JSON.stringify(psa));
  assert.equal(notesWithHosts('x', 'Some other show'), 'x');
});
