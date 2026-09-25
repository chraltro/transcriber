import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { audioCandidates, parseFeed, looksLikeFeed, findAudioInHtml } from '../../lib/links.js';

globalThis.DOMParser = DOMParser;

test('tracker chains unwrap to every embedded host, innermost first after the original', () => {
  const url = 'https://clrtpod.com/m/pscrb.fm/rss/p/arttrk.com/p/CRMDA/dts.podtrac.com/redirect.mp3/audioboom.com/posts/8955915.mp3?modified=1&sid=5';
  const c = audioCandidates(url);
  assert.equal(c[0], url);
  assert.equal(c[1], 'https://audioboom.com/posts/8955915.mp3?modified=1&sid=5');
  assert.ok(c.includes('https://dts.podtrac.com/redirect.mp3/audioboom.com/posts/8955915.mp3?modified=1&sid=5'));
  assert.ok(c.includes('https://pscrb.fm/rss/p/arttrk.com/p/CRMDA/dts.podtrac.com/redirect.mp3/audioboom.com/posts/8955915.mp3?modified=1&sid=5'));
});

test('file names are never mistaken for hosts', () => {
  const c = audioCandidates('https://cdn.example.com/shows/track.aac/audio.mp3');
  assert.deepEqual(c, ['https://cdn.example.com/shows/track.aac/audio.mp3']);
  assert.ok(!audioCandidates('https://dts.podtrac.com/redirect.mp3/x.com/a.mp3').some((u) => u.startsWith('https://redirect.mp3')));
});

test('URL-encoded inner links (Anchor) are decoded', () => {
  const c = audioCandidates('https://anchor.fm/s/1/podcast/play/2/https%3A%2F%2Fd3ctxlq1ktw2nl.cloudfront.net%2Fstaging%2Fa.mp3');
  assert.ok(c.includes('https://d3ctxlq1ktw2nl.cloudfront.net/staging/a.mp3'));
});

test('plain URLs and garbage are passed through', () => {
  assert.deepEqual(audioCandidates('https://traffic.megaphone.fm/SCIM1.mp3'), ['https://traffic.megaphone.fm/SCIM1.mp3']);
  assert.deepEqual(audioCandidates('not a url'), ['not a url']);
});

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel><title>Test Show</title>
<item><title><![CDATA[Episode 2: Ærlig talt & <mer>]]></title><pubDate>Tue, 02 Sep 2025 10:00:00 GMT</pubDate><itunes:duration>01:02:03</itunes:duration><enclosure url="https://a.example/2.mp3" type="audio/mpeg" length="1"/></item>
<item><title>No audio</title></item>
<item><title>Episode 1</title><itunes:duration>3600</itunes:duration><enclosure url="https://a.example/1.mp3" type="audio/mpeg"/></item>
</channel></rss>`;

test('feeds parse titles, audio, dates and durations; items without audio are skipped', () => {
  assert.ok(looksLikeFeed(RSS));
  const feed = parseFeed(RSS);
  assert.equal(feed.title, 'Test Show');
  assert.equal(feed.episodes.length, 2);
  assert.equal(feed.episodes[0].title, 'Episode 2: Ærlig talt & <mer>');
  assert.equal(feed.episodes[0].url, 'https://a.example/2.mp3');
  assert.equal(feed.episodes[0].duration, '01:02:03');
  assert.equal(feed.episodes[1].duration, '3600');
});

test('non-feeds are not feeds', () => {
  assert.ok(!looksLikeFeed('<!doctype html><html><body>hi</body></html>'));
});

test('pages: og:audio, audio elements and relative links resolve', () => {
  assert.deepEqual(findAudioInHtml('<meta property="og:title" content="T"><meta property="og:audio" content="https://x/a.mp3">', 'https://p/e'), { kind: 'audio', url: 'https://x/a.mp3', title: 'T' });
  assert.equal(findAudioInHtml('<audio src="/media/b.mp3"></audio>', 'https://site.example/ep/1').url, 'https://site.example/media/b.mp3');
  assert.equal(findAudioInHtml('<audio><source src="c.m4a"></audio>', 'https://site.example/ep/').url, 'https://site.example/ep/c.m4a');
});

test('pages: one embedded audio URL is used, several are not guessed between', () => {
  assert.equal(findAudioInHtml('<script>{"u":"https:\\/\\/cdn.x\\/one.mp3?a=1\\u0026b=2"}</script>', 'https://p').url, 'https://cdn.x/one.mp3?a=1&b=2');
  const many = findAudioInHtml('<script>["https://cdn.x/1.mp3","https://cdn.x/2.mp3"]</script><link type="application/rss+xml" href="/feed">', 'https://p.example/show');
  assert.deepEqual({ kind: many.kind, url: many.url }, { kind: 'feed', url: 'https://p.example/feed' });
  assert.equal(findAudioInHtml('<p>nothing here</p>', 'https://p'), null);
});
