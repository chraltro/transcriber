import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, parseOpml, toOpml, summaryOf, appLanguage, episodeId, decodeEntities, looksLikeFeed } from '../../lib/feed.js';
import { idOf } from '../../server/shows.mjs';

const XML = `<?xml version="1.0"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
<image><url>https://img/old.jpg</url><title>Image title</title><link>https://img</link></image>
<title>Abels t&#229;rn</title><link>https://radio.nrk.no/podkast/abels_taarn</link><language>nb-NO</language>
<description><![CDATA[Sp&oslash;rsm&aring;l om <b>vitenskap</b>, hver fredag.]]></description>
<itunes:author>NRK</itunes:author><itunes:image href="https://img/show.jpg"/>
<item><title>Hvorfor er himmelen bl&#229;?</title><guid isPermaLink="false">nrk-1</guid>
<pubDate>Fri, 06 Nov 2026 05:00:00 GMT</pubDate><enclosure url="https://cdn/1.mp3?a=1&amp;b=2" type="audio/mpeg" length="1"/>
<description>&lt;p&gt;Tre forskere svarer. Les mer p&#229; https://nrk.no/abel&lt;/p&gt;</description>
<content:encoded><![CDATA[<p>Tre forskere svarer p&aring; lytternes sp&oslash;rsm&aring;l. <a href="https://nrk.no/abel">Les mer</a></p><p>(12:30) Regnbuer</p>]]></content:encoded>
<itunes:duration>58:12</itunes:duration><itunes:season>4</itunes:season><itunes:episode>12</itunes:episode><itunes:episodeType>full</itunes:episodeType>
<podcast:chapters url="https://cdn/1.chapters.json" type="application/json+chapters"/></item>
<item><title>Trailer</title><guid>nrk-0</guid><pubDate>Fri, 06 Nov 2026 05:00:00 GMT</pubDate><enclosure url='https://cdn/0.mp3' type='audio/mpeg'/><itunes:image href="https://img/show.jpg"/></item>
<item><title>No audio</title><guid>nrk-x</guid><pubDate>Sat, 07 Nov 2026 05:00:00 GMT</pubDate><enclosure url="https://cdn/x.pdf" type="application/pdf"/></item>
<item><title>Nyeste</title><guid>nrk-2</guid><pubDate>Sat, 07 Nov 2026 05:00:00 GMT</pubDate><enclosure url="https://cdn/2.m4a"/><itunes:image href="https://img/2.jpg"/></item>
</channel></rss>`;

test('a feed gives the show and its episodes, newest first', () => {
  const f = parseFeed(XML);
  assert.equal(f.title, 'Abels tårn');
  assert.equal(f.art, 'https://img/show.jpg');
  assert.equal(f.link, 'https://radio.nrk.no/podkast/abels_taarn');
  assert.equal(f.author, 'NRK');
  assert.equal(f.description, 'Spørsmål om vitenskap, hver fredag.');
  assert.equal(appLanguage(f.language), 'norwegian');
  assert.deepEqual(f.episodes.map((e) => e.guid), ['nrk-2', 'nrk-1', 'nrk-0']);
  const e = f.episodes[1];
  assert.equal(e.title, 'Hvorfor er himmelen blå?');
  assert.equal(e.url, 'https://cdn/1.mp3?a=1&b=2');
  assert.equal(e.duration, 3492);
  assert.equal(e.season, 4);
  assert.equal(e.number, 12);
  assert.equal(e.chapters, 'https://cdn/1.chapters.json');
  assert.match(e.html, /<a href="https:\/\/nrk\.no\/abel">Les mer<\/a>/);
  assert.equal(e.summary, 'Tre forskere svarer på lytternes spørsmål. Les mer (12:30) Regnbuer');
  assert.equal(e.art, '', 'an episode with the show\'s own art carries none');
  assert.equal(f.episodes[0].art, 'https://img/2.jpg');
  assert.equal(f.episodes[2].art, '');
});

test('a feed can be cut short, and one without items is still a show', () => {
  assert.equal(parseFeed(XML, { maxEpisodes: 1 }).episodes.length, 1);
  const empty = parseFeed('<rss><channel><title>Empty</title></channel></rss>');
  assert.equal(empty.title, 'Empty');
  assert.deepEqual(empty.episodes, []);
  assert.equal(looksLikeFeed(XML), true);
  assert.equal(looksLikeFeed('<html><body>rss</body></html>'), false);
});

test('summaries are one line, cut at a word', () => {
  assert.equal(summaryOf('<p>One</p><p>two &amp; three</p>'), 'One two & three');
  const long = summaryOf(`<p>${'word '.repeat(200)}</p>`, 100);
  assert.ok(long.length <= 101 && long.endsWith('…') && !long.includes('  '));
  assert.equal(decodeEntities('&amp;lt; &#x41; &unknown;'), '&lt; A &unknown;');
});

test('an episode id is the one the server files its transcript under', async () => {
  for (const guid of ['nrk-1', 'https://cdn/1.mp3?a=1&b=2', 'blå-æøå']) assert.equal(await episodeId(guid), idOf(guid));
});

test('OPML in and out', () => {
  const opml = toOpml([{ title: 'Pod Save America', feedUrl: 'https://feeds/psa?x=1&y=2' }, { title: 'Abels "tårn"', feedUrl: 'https://feeds/abel' }]);
  assert.deepEqual(parseOpml(opml), [{ title: 'Pod Save America', feedUrl: 'https://feeds/psa?x=1&y=2' }, { title: 'Abels "tårn"', feedUrl: 'https://feeds/abel' }]);
  assert.deepEqual(parseOpml(`<opml><body><outline text="A" xmlUrl='https://a/feed'/><outline text="folder"><outline title="B" text="b" type="rss" xmlUrl="https://b/feed" htmlUrl="https://b"/></outline><outline text="A again" xmlUrl="https://a/feed"/></body></opml>`),
    [{ title: 'A', feedUrl: 'https://a/feed' }, { title: 'B', feedUrl: 'https://b/feed' }]);
});
