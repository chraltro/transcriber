import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { youtubeId, dropboxDirect, isChallengePage, pageHints, slugHints, episodeNumber, matchEpisode, findAudioInHtml } from '../../lib/links.js';

globalThis.DOMParser = DOMParser;

test('YouTube ids from every kind of link', () => {
  for (const u of ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'https://youtu.be/jNQXAC9IVRw?si=abc', 'https://m.youtube.com/watch?v=jNQXAC9IVRw&t=10',
    'https://music.youtube.com/watch?v=jNQXAC9IVRw&list=x', 'https://www.youtube.com/shorts/jNQXAC9IVRw', 'https://www.youtube.com/live/jNQXAC9IVRw?feature=share',
    'https://www.youtube.com/embed/jNQXAC9IVRw', 'https://www.youtube-nocookie.com/embed/jNQXAC9IVRw']) assert.equal(youtubeId(u), 'jNQXAC9IVRw', u);
  assert.equal(youtubeId('https://www.youtube.com/@lexfridman'), null);
  assert.equal(youtubeId('https://example.com/watch?v=jNQXAC9IVRw'), null);
});

test('Dropbox share links become direct downloads', () => {
  assert.equal(dropboxDirect('https://www.dropbox.com/scl/fi/abc123/ep.mp3?rlkey=xyz&dl=0'), 'https://dl.dropboxusercontent.com/scl/fi/abc123/ep.mp3?rlkey=xyz');
  assert.equal(dropboxDirect('https://www.dropbox.com/s/abc/ep.mp3?dl=0'), 'https://dl.dropboxusercontent.com/s/abc/ep.mp3');
  assert.equal(dropboxDirect('https://www.dropbox.com/home'), null);
});

test('challenge pages are recognised', () => {
  assert.ok(isChallengePage('<html><head><title>Just a moment...</title>'));
  assert.ok(!isChallengePage('<title>The Daily</title>'));
});

test('structured data gives the episode audio', () => {
  const html = `<html><head><title>x</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"PodcastEpisode","name":"Ep 4: Trees","partOfSeries":{"@type":"PodcastSeries","name":"Forest Talk"},"associatedMedia":{"@type":"MediaObject","contentUrl":"https://cdn.example/4.mp3"}}</script></head></html>`;
  assert.deepEqual(findAudioInHtml(html, 'https://castro.fm/episode/x'), { kind: 'audio', url: 'https://cdn.example/4.mp3', title: 'Ep 4: Trees', show: 'Forest Talk' });
  assert.deepEqual(pageHints(html)[0], { episode: 'Ep 4: Trees', show: 'Forest Talk' });
});

test('page titles split into episode and show, without the platform', () => {
  const h = pageHints('<html><head><meta property="og:title" content="Forskningsfronten - Abels tårn - NRK Radio"></head></html>');
  assert.deepEqual(h[0], { episode: 'Forskningsfronten', show: 'Abels tårn' });
  assert.deepEqual(h[1], { episode: 'Abels tårn', show: 'Forskningsfronten' });
});

test('slugs from podcast app links', () => {
  assert.deepEqual(slugHints('https://player.fm/series/the-daily-1408227/the-sunday-read-a-good-walk'), { show: 'the daily', episode: 'the sunday read a good walk' });
  assert.deepEqual(slugHints('https://castbox.fm/episode/Why-We-Sleep-id1033024-id654321'), { show: null, episode: 'Why We Sleep' });
  assert.deepEqual(slugHints('https://thedaily.podbean.com/e/the-big-story/'), { show: 'thedaily', episode: 'the big story' });
  assert.deepEqual(slugHints('https://creators.spotify.com/pod/show/myshow/episodes/Talking-trees-e2abc12'), { show: 'myshow', episode: 'Talking trees' });
  assert.deepEqual(slugHints('https://shows.acast.com/the-rest-is-politics/episodes/trump-and-the-fed'), { show: 'the rest is politics', episode: 'trump and the fed' });
  assert.equal(slugHints('https://example.com/a/b'), null);
});

test('episode numbers in many languages', () => {
  assert.equal(episodeNumber('Psychiatry & Jung | Lex Fridman Podcast #502'), '502');
  assert.equal(episodeNumber('Ep. 12 – Trees'), '12');
  assert.equal(episodeNumber('Folge 37: Wald'), '37');
  assert.equal(episodeNumber('Épisode 4 : Forêt'), '4');
  assert.equal(episodeNumber('The 3 Macronutrients of Happiness'), null);
  assert.equal(episodeNumber('Deep dive #hotelmatze #podcast'), null);
});

test('YouTube titles find the same episode in the feed', () => {
  const feed = [
    { title: '#503 – Someone Else: Other Topic' },
    { title: '#502 – Andrew Scull: Psychiatry, Asylums, Lobotomies, Freud and Jung' },
    { title: '#501 – DHH: Programming, AI and Linux' },
  ];
  assert.equal(matchEpisode(feed, 'Psychiatry, Insane Asylums, Mental Illness, ECT, Lobotomies, Freud & Jung | Lex Fridman Podcast #502', 'Lex Fridman Podcast').best, feed[1]);
  const nsn = [{ title: 'Nadie Sabe Nada | T13x19 | Llegan los industriales' }, { title: 'Nadie Sabe Nada | T13x18 | El rey del mambo' }];
  assert.equal(matchEpisode(nsn, '¿Los industriales? | @NadieSabeNada', 'Nadie Sabe Nada').best, nsn[0]);
  const hub = [{ title: 'Essentials: Optimal Protocols to Build Strength & Grow Muscles | Dr. Andy Galpin' }, { title: 'GUEST SERIES | Dr. Andy Galpin: Optimal Protocols to Build Strength & Grow Muscles' }];
  assert.equal(matchEpisode(hub, 'Essentials: Optimal Protocols to Build Strength & Grow Muscles | Dr. Andy Galpin', 'Huberman Lab').best, hub[0]);
  // A short clip that shares a word or two with several episodes is not guessed.
  const m = matchEpisode([{ title: 'Disney and Marvel' }, { title: 'Disney+ and Ichiro' }], 'The connection between Ichiro Suzuki and Disney+', 'Acquired');
  assert.equal(m.best, null);
  assert.ok(m.ranked.length >= 1);
});
